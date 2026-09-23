/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ControlServer } from '../controlServer';
import type { IDebuggingHandler } from '../debuggingHandler';
import type { PackDocsHandlers } from '../packDocsDispatch';
import { RoutingDebuggingHandler } from '../routingDebuggingHandler';
import { DEBUG_OPS, PACKDOCS_BUILD_OPS, PACKDOCS_DOC_OPS } from '../core/opTable';
import { closeHttpServer } from '../utils/closeHttpServer';
import { WindowRegistration, WorkspaceRegistry } from '../utils/workspaceRegistry';

const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
const FIRST_FAKE_PID = 500_001;
/** The router's per-call default, as the extension sets it for a 30 s timeout. */
const TOOL_MS = 30_000;
const JSON_TYPE: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };

type Role = 'debug' | 'docs' | 'build';

/** Every fake handler answers with who it is, its role, the op and the args it got. */
function echo(label: string, role: Role, op: string, args: unknown): string {
    return `${label}|${role}|${op}|${JSON.stringify(args)}`;
}

/** An object with one echoing method per op name. */
function echoing<T>(label: string, role: Role, ops: readonly string[]): T {
    const methods = Object.fromEntries(ops.map((op) => [op, async (args?: unknown) => echo(label, role, op, args)]));
    return methods as unknown as T;
}

function echoingPackDocs(label: string): PackDocsHandlers {
    return {
        docs: echoing(label, 'docs', PACKDOCS_DOC_OPS),
        build: echoing(label, 'build', PACKDOCS_BUILD_OPS),
    };
}

const pause = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Assert that the call was refused, with a message passing every check. */
async function refusedWith(call: Promise<unknown>, ...patterns: RegExp[]): Promise<string> {
    let message = '';
    await assert.rejects(call, (failure: Error) => {
        message = failure.message;
        return true;
    });
    for (const pattern of patterns) {
        assert.match(message, pattern);
    }
    return message;
}

interface RawReply {
    status: number;
    body: string;
}

/** A POST /op made by hand, with the token and no Content-Length, so its body goes chunked. */
function openControlRequest(port: number, token: string, onReply?: (reply: http.IncomingMessage) => void): http.ClientRequest {
    const options: http.RequestOptions = { method: 'POST', hostname: '127.0.0.1', port, path: '/op', agent: false };
    options.headers = { [TOKEN_HEADER]: token };
    return http.request(options, onReply);
}

async function writeInPieces(client: http.ClientRequest, pieces: Array<string | Buffer>, gapMs: number): Promise<void> {
    for (const [index, piece] of pieces.entries()) {
        if (index > 0 && gapMs > 0) {
            await pause(gapMs);
        }
        client.write(piece);
    }
    client.end();
}

/** Send `pieces` as one control request, optionally with a gap between them, and collect the answer. */
function rawPost(port: number, token: string, pieces: Array<string | Buffer>, gapMs = 0): Promise<RawReply> {
    return new Promise<RawReply>((resolve, reject) => {
        const client = openControlRequest(port, token, (reply) => {
            const got: Buffer[] = [];
            reply.on('data', (piece: Buffer) => got.push(piece));
            reply.on('error', reject);
            reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(got).toString('utf8') }));
        });
        client.on('error', reject);
        void writeInPieces(client, pieces, gapMs);
    });
}

interface FakeWindow {
    label: string;
    pid: number;
    port: number;
    token: string;
    entry: WindowRegistration;
}

suite('Multi-window routing', () => {
    let dir: string;
    let livePids: Set<number>;
    let nextPid: number;
    let running: Array<() => Promise<void>>;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-routing-'));
        livePids = new Set();
        nextPid = FIRST_FAKE_PID;
        running = [];
    });

    teardown(() => shutDown());

    async function shutDown(): Promise<void> {
        for (const stop of running) {
            await stop();
        }
        fs.rmSync(dir, { force: true, recursive: true });
    }

    const folder = (name: string): string => path.join(dir, name);

    function saveRegistration(label: string, entry: WindowRegistration): void {
        fs.writeFileSync(path.join(dir, `window-${label}.json`), JSON.stringify(entry));
    }

    /** Put a listening port into the registry under a new live fake pid. */
    function enrol(label: string, port: number, token: string, overrides: Partial<WindowRegistration>): FakeWindow {
        const stamp = Date.now();
        const entry: WindowRegistration = {
            pid: nextPid++,
            controlPort: port,
            controlToken: token,
            workspaceFolders: [],
            name: label,
            updatedAt: stamp,
            ...overrides,
        };
        livePids.add(entry.pid);
        saveRegistration(label, entry);
        return { label, pid: entry.pid, port, token, entry };
    }

    /** A window: a real control server over echoing handlers, registered by hand. */
    async function openWindow(
        label: string,
        overrides: Partial<WindowRegistration> = {},
        withPackDocs = true,
    ): Promise<FakeWindow> {
        const token = `token-${label}`;
        const control = new ControlServer(
            echoing<IDebuggingHandler>(label, 'debug', DEBUG_OPS),
            token,
            withPackDocs ? echoingPackDocs(label) : undefined);
        const port = await control.start();
        running.push(() => control.stop());
        return enrol(label, port, token, overrides);
    }

    /** A bare HTTP server posing as a window; `respond` writes the whole answer. */
    async function openStandIn(respond: (res: http.ServerResponse) => void): Promise<FakeWindow> {
        const fake = http.createServer((incoming, reply) => {
            incoming.resume();
            respond(reply);
        });
        await new Promise<void>((ready) => fake.listen(0, '127.0.0.1', ready));
        running.push(() => closeHttpServer(fake));
        return enrol('stand-in', (fake.address() as AddressInfo).port, 'token-stand-in', {});
    }

    /** A router for a new session, seeing only the fake windows as alive. */
    function newRouter(): RoutingDebuggingHandler {
        return new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir, (pid) => livePids.has(pid)), TOOL_MS);
    }

    function assertAnsweredBy(result: string, label: string): void {
        assert.ok(result.startsWith(`${label}|debug|`), `expected ${label} to answer, got: ${result}`);
    }

    suite('resolution', () => {

        test('a path hint picks the window owning the file', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            await openWindow('beta', { workspaceFolders: [folder('beta')] });
            const result = await newRouter().handleAddBreakpoint({ fileFullPath: path.join(folder('beta'), 'main.c'), line: 10 });
            assertAnsweredBy(result, 'beta');
        });

        test('path-less calls stay with the window the session already reached', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            await openWindow('beta', { workspaceFolders: [folder('beta')] });
            const router = newRouter();
            await router.handleAddBreakpoint({ fileFullPath: path.join(folder('beta'), 'main.c'), line: 10 });
            assertAnsweredBy(await router.handleReadMemory({ address: '0x20000000', length: 16 }), 'beta');
        });

        test('the only window with a debug session takes path-less calls', async () => {
            await openWindow('idle');
            await openWindow('board', { hasActiveSession: true });
            assertAnsweredBy(await newRouter().handleReadCoreRegisters({}), 'board');
        });

        test('the only window takes path-less calls', async () => {
            await openWindow('solo');
            assertAnsweredBy(await newRouter().handleGetSessionStatus(), 'solo');
        });

        test('two debug sessions are refused with a listing, not guessed', async () => {
            await openWindow('boardA', { workspaceFolders: [folder('a')], hasActiveSession: true });
            await openWindow('boardB', { workspaceFolders: [folder('b')], hasActiveSession: true });
            const message = await refusedWith(newRouter().handleReadMemory({ address: '0x0', length: 4 }),
                /2 VS Code windows have an active debug session/, /select_debug_window/);
            assert.ok(message.includes(folder('a')) && message.includes(folder('b')), message);
        });

        test('a path in no workspace is refused even when the session has a target', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const router = newRouter();
            assertAnsweredBy(await router.handleGetSessionStatus(), 'alpha');
            await refusedWith(router.handleAddBreakpoint({ fileFullPath: '/not/in/any/workspace.c', line: 1 }),
                /No open VS Code window has/);
        });

        test('an empty registry is reported as such', async () => {
            await refusedWith(newRouter().handleGetSessionStatus(), /No CMSIS Developer Assistant-enabled VS Code window/);
        });
    });

    suite('explicit selection', () => {

        test('a pinned window beats the one with the debug session', async () => {
            const idle = await openWindow('idle');
            await openWindow('board', { hasActiveSession: true });
            const router = newRouter();
            assert.match(router.selectDebugWindow({ pid: idle.pid }), /pinned to/);
            assertAnsweredBy(await router.handleReadMemory({ address: '0x0', length: 4 }), 'idle');
        });

        test('a selection that matches nothing lists what is registered', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const text = newRouter().selectDebugWindow({ workspaceFolder: '/nowhere' });
            assert.match(text, /No registered window matches/);
            assert.match(text, /alpha|Currently registered/);
        });

        test('a selection without pid or folder asks for one', () => {
            assert.match(newRouter().selectDebugWindow({}), /Pass either pid or workspaceFolder/);
        });

        test('the listing marks the window the session is using', async () => {
            await openWindow('solo');
            const router = newRouter();
            await router.handleGetSessionStatus();
            assert.match(router.listDebugWindows(), /current target/);
        });

        test('the listing of an empty registry says so', () => {
            assert.match(newRouter().listDebugWindows(), /No CMSIS Developer Assistant-enabled VS Code windows/);
        });
    });

    suite('control server', () => {

        test('a wrong token is turned away', async () => {
            const alpha = await openWindow('alpha');
            saveRegistration('alpha', { ...alpha.entry, controlToken: 'not-the-token' });
            await refusedWith(newRouter().handleGetSessionStatus(), /403|Could not reach/);
        });

        test('an op outside the table is refused, not dispatched', async () => {
            await openWindow('alpha');
            const message = await refusedWith(newRouter().serialOp('handleNotAnOp'));
            assert.ok(message.includes('Control op handleNotAnOp refused: not a known operation'), message);
        });

        test('documentation and build-artefact ops run in the owning window, on the right handler', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            await openWindow('beta', { workspaceFolders: [folder('beta')] });
            const router = newRouter();
            router.selectDebugWindow({ workspaceFolder: path.join(folder('beta'), 'src') });
            assert.strictEqual(await router.packDocsOp('handleListTargetDocs', { target: 'HE' }),
                echo('beta', 'docs', 'handleListTargetDocs', { target: 'HE' }));
            assert.strictEqual(await router.packDocsOp('handleGetMemoryUsage', { top: 5 }),
                echo('beta', 'build', 'handleGetMemoryUsage', { top: 5 }));
        });

        test('a window without documentation handlers refuses their ops', async () => {
            await openWindow('bare', {}, false);
            await refusedWith(newRouter().packDocsOp('handleListTargetDocs', {}), /not available in this window/);
        });

        test('arguments arrive as they were sent', async () => {
            await openWindow('solo');
            const result = await newRouter().handleReadMemory({ address: '0x20000000', length: 64, format: 'hex' });
            for (const part of ['"address":"0x20000000"', '"length":64', '"format":"hex"']) {
                assert.ok(result.includes(part), `${part} missing from ${result}`);
            }
        });

        test('a character split across two request chunks arrives whole', async () => {
            const solo = await openWindow('solo');
            const bytes = Buffer.from('{"op":"handleReadMemory","args":{"address":"a😀b"}}', 'utf8');
            const cut = bytes.indexOf(0xf0) + 2;
            const raw = await rawPost(solo.port, solo.token, [bytes.subarray(0, cut), bytes.subarray(cut)], 20);
            assert.strictEqual(raw.status, 200);
            const result = String(JSON.parse(raw.body).result);
            assert.ok(result.includes('"address":"a😀b"'), result);
            assert.ok(!result.includes('\uFFFD'), 'no replacement character');
        });

        test('an oversize request gets 413 and the window keeps serving', async () => {
            const solo = await openWindow('solo');
            const raw = await rawPost(solo.port, solo.token,
                ['{"op":"handleGetSessionStatus","args":{}', ' '.repeat(1_048_577), '}']);
            assert.strictEqual(raw.status, 413);
            assert.match(raw.body, /control request above \d+ bytes/);
            assert.strictEqual(await newRouter().handleGetSessionStatus(), echo('solo', 'debug', 'handleGetSessionStatus', {}));
        });

        test('a client that gives up mid-body does not take the window down', async () => {
            const solo = await openWindow('solo');
            const client = openControlRequest(solo.port, solo.token);
            client.on('error', () => { /* the abort is the point */ });
            client.write('{"op":"handleGetSess');
            await pause(20);
            client.destroy();
            await pause(50);
            assertAnsweredBy(await newRouter().handleGetSessionStatus(), 'solo');
        });

        test('stop() returns within its grace while a call is still running', async () => {
            const wedged = { handleGetSessionStatus: () => new Promise<string>(() => { /* never settles */ }) };
            const control = new ControlServer(wedged as unknown as IDebuggingHandler, 'tok');
            const port = await control.start();
            const inFlight = rawPost(port, 'tok', ['{"op":"handleGetSessionStatus","args":{}}']);
            const outcome = inFlight.then(() => 'answered', (failure: Error) => failure.message);
            await pause(100);
            const stopCalled = Date.now();
            await control.stop();
            const stopMs = Date.now() - stopCalled;
            assert.ok(stopMs < 3_000, `stop took ${stopMs} ms`);
            assert.match(await outcome, /socket hang up|ECONNRESET|aborted/);
        });

        test('a reply split inside a character arrives whole', async () => {
            const bytes = Buffer.from('{"result":"ok 😀 done"}', 'utf8');
            const cut = bytes.indexOf(0xf0) + 1;
            await openStandIn((reply) => {
                reply.writeHead(200, JSON_TYPE);
                reply.write(bytes.subarray(0, cut));
                setTimeout(() => reply.end(bytes.subarray(cut)), 20);
            });
            assert.strictEqual(await newRouter().handleGetSessionStatus(), 'ok 😀 done');
        });

        test('an oversize reply is refused', async () => {
            await openStandIn((reply) => {
                reply.writeHead(200, JSON_TYPE);
                reply.end('{"result":"' + 'A'.repeat(16_777_217));
            });
            await refusedWith(newRouter().handleGetSessionStatus(), /control response above \d+ bytes/);
        });

        test('a window that stopped listening is reported as unreachable', async () => {
            const gone = await openWindow('gone');
            saveRegistration('gone', { ...gone.entry, controlPort: 1 });
            await refusedWith(newRouter().handleGetSessionStatus(), /Could not reach the VS Code window/, /list_debug_windows/);
        });
    });
});
