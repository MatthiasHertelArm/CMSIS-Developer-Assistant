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
import { runInCallContext } from '../core/callContext';
import { CONTROL_ENVELOPE_HEADER, DEBUG_OPS, PACKDOCS_BUILD_OPS, PACKDOCS_DOC_OPS } from '../core/opTable';
import { newErrorsNote, newErrorsStatusLine } from '../core/problemFeed';
import { ProblemJournal } from '../core/problemJournal';
import { ErrorCode, JsonObject, ToolError, ToolText, errorDetail, textOf, toToolError } from '../core/toolResult';
import { closeHttpServer } from '../utils/closeHttpServer';
import { DefaultTarget, WindowRegistration, WorkspaceRegistry } from '../utils/workspaceRegistry';

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

/** Assert that the call was refused, with a message and hint that pass every check; the text an agent reads, without the code. */
async function refusedWith(call: Promise<unknown>, ...patterns: RegExp[]): Promise<string> {
    return (await refusal(call, ...patterns)).detail;
}

/** The refusal as a `ToolError`, and its message with the hint, checked against `patterns`. */
async function refusal(call: Promise<unknown>, ...patterns: RegExp[]): Promise<{ error: ToolError; detail: string }> {
    let error: ToolError | undefined;
    await assert.rejects(call, (failure: unknown) => {
        error = toToolError(failure);
        return failure instanceof ToolError;
    });
    const typed = error as ToolError;
    const detail = errorDetail(typed);
    for (const pattern of patterns) {
        assert.match(detail, pattern);
    }
    return { error: typed, detail };
}

/** Assert the refusal's code. */
async function refusedAs(code: ErrorCode, call: Promise<unknown>, ...patterns: RegExp[]): Promise<ToolError> {
    const { error, detail } = await refusal(call, ...patterns);
    assert.strictEqual(error.code, code, detail);
    return error;
}

interface RawReply {
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
}

/** A POST /op made by hand, with the token and no Content-Length, so its body goes chunked. */
function openControlRequest(
    port: number,
    token: string,
    onReply?: (reply: http.IncomingMessage) => void,
    extraHeaders: http.OutgoingHttpHeaders = {},
): http.ClientRequest {
    const options: http.RequestOptions = { method: 'POST', hostname: '127.0.0.1', port, path: '/op', agent: false };
    options.headers = { [TOKEN_HEADER]: token, ...extraHeaders };
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
function rawPost(port: number, token: string, pieces: Array<string | Buffer>, gapMs = 0, extraHeaders: http.OutgoingHttpHeaders = {}): Promise<RawReply> {
    return new Promise<RawReply>((resolve, reject) => {
        const client = openControlRequest(port, token, (reply) => {
            const got: Buffer[] = [];
            reply.on('data', (piece: Buffer) => got.push(piece));
            reply.on('error', reject);
            reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(got).toString('utf8'), headers: reply.headers }));
        }, extraHeaders);
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
    /** The window's own problem journal (#48); a stand-in has one nobody uses. */
    journal: ProblemJournal;
    /** Stops the window's control server; its registration stays. */
    close(): Promise<void>;
}

/** Ops a fake window answers differently from the echo. */
type OpOverrides = Record<string, (args?: unknown) => Promise<ToolText>>;

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
    function enrol(
        label: string,
        port: number,
        token: string,
        overrides: Partial<WindowRegistration>,
        close: () => Promise<void>,
        journal: ProblemJournal = new ProblemJournal(),
    ): FakeWindow {
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
        return { label, pid: entry.pid, port, token, entry, journal, close };
    }

    /** A window: a real control server over echoing handlers and a journal of its own, registered by hand. */
    async function openWindow(
        label: string,
        overrides: Partial<WindowRegistration> = {},
        withPackDocs = true,
        ops: OpOverrides = {},
    ): Promise<FakeWindow> {
        const token = `token-${label}`;
        const journal = new ProblemJournal();
        const control = new ControlServer(
            { ...echoing<IDebuggingHandler>(label, 'debug', DEBUG_OPS), ...ops } as IDebuggingHandler,
            token,
            withPackDocs ? echoingPackDocs(label) : undefined,
            journal);
        const port = await control.start();
        running.push(() => control.stop());
        return enrol(label, port, token, overrides, () => control.stop(), journal);
    }

    /** A bare HTTP server posing as a window; `respond` writes the whole answer, or none. */
    async function openStandIn(
        respond: (res: http.ServerResponse) => void,
        label = 'stand-in',
        overrides: Partial<WindowRegistration> = {},
    ): Promise<FakeWindow> {
        const fake = http.createServer((incoming, reply) => {
            incoming.resume();
            respond(reply);
        });
        await new Promise<void>((ready) => fake.listen(0, '127.0.0.1', ready));
        running.push(() => closeHttpServer(fake));
        return enrol(label, (fake.address() as AddressInfo).port, `token-${label}`, overrides, () => closeHttpServer(fake));
    }

    /** A router for a new session, seeing only the fake windows as alive. */
    function newRouter(answerWithinMs?: number): RoutingDebuggingHandler {
        const registry = new WorkspaceRegistry(process.pid, dir, (pid) => livePids.has(pid));
        return answerWithinMs === undefined
            ? new RoutingDebuggingHandler(registry, TOOL_MS)
            : new RoutingDebuggingHandler(registry, TOOL_MS, () => answerWithinMs);
    }

    function assertAnsweredBy(result: ToolText, label: string): void {
        assert.ok(textOf(result).startsWith(`${label}|debug|`), `expected ${label} to answer, got: ${textOf(result)}`);
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
            const a = await openWindow('boardA', { workspaceFolders: [folder('a')], hasActiveSession: true });
            const b = await openWindow('boardB', { workspaceFolders: [folder('b')], hasActiveSession: true });
            const tie = await refusedAs('AMBIGUOUS_WINDOW', newRouter().handleReadMemory({ address: '0x0', length: 4 }),
                /2 VS Code windows have an active debug session/, /select_debug_window/, /click "CDA" in the VS Code status bar → Select Target Window/);
            const detail = errorDetail(tie);
            assert.ok(detail.includes(folder('a')) && detail.includes(folder('b')), detail);
            // Windows of 2.5.0 publish no role, so their candidates carry none.
            assert.deepStrictEqual(tie.data, {
                candidates: [a, b].map((w) => ({
                    pid: w.pid, name: w.label, workspaceFolders: w.entry.workspaceFolders, hasActiveSession: true, isDefault: false,
                })),
            });
        });

        test('a path in no workspace is refused even when the session has a target', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const router = newRouter();
            assertAnsweredBy(await router.handleGetSessionStatus(), 'alpha');
            await refusedAs('INVALID_ARGUMENT', router.handleAddBreakpoint({ fileFullPath: '/not/in/any/workspace.c', line: 1 }),
                /No open VS Code window has/);
        });

        test('an empty registry is reported as such', async () => {
            await refusedAs('WINDOW_UNREACHABLE', newRouter().handleGetSessionStatus(), /No CMSIS Developer Assistant-enabled VS Code window/);
        });

        test('a pinned window that is gone is reported as unreachable', async () => {
            const gone = await openWindow('gone');
            await openWindow('other');
            const router = newRouter();
            router.selectDebugWindow({ pid: gone.pid });
            livePids.delete(gone.pid);
            await refusedAs('WINDOW_UNREACHABLE', router.handleGetSessionStatus(), /pinned with select_debug_window .* is gone/);
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
            assert.throws(() => newRouter().selectDebugWindow({ workspaceFolder: '/nowhere' }), (failure: unknown) =>
                failure instanceof ToolError && failure.code === 'INVALID_ARGUMENT'
                && /No registered window matches/.test(failure.message) && /Currently registered:\n.*alpha/.test(failure.hint ?? ''));
        });

        test('a selection without pid or folder asks for one', () => {
            assert.throws(() => newRouter().selectDebugWindow({}), (failure: unknown) =>
                failure instanceof ToolError && failure.code === 'INVALID_ARGUMENT' && /Pass either pid or workspaceFolder/.test(failure.message));
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

    suite('window selection for people (#16)', () => {
        const READ = { address: '0x0', length: 4 };
        /** Each choice gets its own time, as two clicks would. */
        let clock: number;
        setup(() => { clock = 1_000; });

        const registryView = (): WorkspaceRegistry => new WorkspaceRegistry(process.pid, dir, (pid) => livePids.has(pid));

        /** Save `w` as the default target, as Select Target Window does. */
        async function chooseDefault(w: FakeWindow, overrides: Partial<DefaultTarget> = {}): Promise<void> {
            await registryView().writeDefaultTarget({ pid: w.pid, workspaceFolder: w.entry.workspaceFolders[0], name: w.label, setAt: ++clock, ...overrides });
        }

        /** Two idle windows, each with its folder: the tie a default target resolves. */
        async function twoIdleWindows(): Promise<[FakeWindow, FakeWindow]> {
            const alpha = await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const beta = await openWindow('beta', { workspaceFolders: [folder('beta')] });
            return [alpha, beta];
        }

        test('the default target resolves the tie of two idle windows', async () => {
            const [, beta] = await twoIdleWindows();
            const router = newRouter();
            await refusedAs('AMBIGUOUS_WINDOW', router.handleReadMemory(READ));
            await chooseDefault(beta);
            assertAnsweredBy(await router.handleReadMemory(READ), 'beta');
            assert.deepStrictEqual(router.describeTarget(), { pid: beta.pid, name: 'beta', reason: 'default' });
        });

        test('a default whose pid is gone is found again by its folder, as after a window reload', async () => {
            const [, beta] = await twoIdleWindows();
            await chooseDefault(beta, { pid: FIRST_FAKE_PID - 1 });
            assertAnsweredBy(await newRouter().handleReadMemory(READ), 'beta');
        });

        test('the default comes after the session\'s own target, and a new choice drops that target but never a pin', async () => {
            const [alpha, beta] = await twoIdleWindows();
            const cached = newRouter();
            const pinned = newRouter();
            assertAnsweredBy(await cached.handleAddBreakpoint({ fileFullPath: path.join(folder('alpha'), 'main.c'), line: 3 }), 'alpha');
            pinned.selectDebugWindow({ pid: alpha.pid });
            await chooseDefault(beta);
            assertAnsweredBy(await cached.handleReadMemory(READ), 'beta');
            assertAnsweredBy(await pinned.handleReadMemory(READ), 'alpha');
            // Once seen, the choice no longer moves the session: a path and the cache hold again.
            assertAnsweredBy(await cached.handleAddBreakpoint({ fileFullPath: path.join(folder('alpha'), 'main.c'), line: 4 }), 'alpha');
            assertAnsweredBy(await cached.handleReadMemory(READ), 'alpha');
            // The same window chosen again is a new choice.
            await chooseDefault(beta);
            assertAnsweredBy(await cached.handleReadMemory(READ), 'beta');
        });

        test('removing the default leaves each session where it is', async () => {
            const [, beta] = await twoIdleWindows();
            const router = newRouter();
            await chooseDefault(beta);
            assertAnsweredBy(await router.handleReadMemory(READ), 'beta');
            await registryView().clearDefaultTarget();
            assertAnsweredBy(await router.handleReadMemory(READ), 'beta');
            await refusedAs('AMBIGUOUS_WINDOW', newRouter().handleReadMemory(READ));
        });

        test('a window argument by pid or by path routes the call and re-aims the later path-less calls', async () => {
            const [alpha] = await twoIdleWindows();
            const router = newRouter();
            assertAnsweredBy(await router.handleCmsisCommand({ action: 'status', window: String(alpha.pid) }), 'alpha');
            assertAnsweredBy(await router.handleReadMemory(READ), 'alpha');
            assert.deepStrictEqual(router.describeTarget(), { pid: alpha.pid, name: 'alpha', reason: 'window-arg' });
            assertAnsweredBy(await router.handleFlash({ window: path.join(folder('beta'), 'out') }), 'beta');
            assertAnsweredBy(await router.handleGetSessionStatus(), 'beta');
        });

        test('a window argument beats the pin for its own call, and the pin keeps the calls after it', async () => {
            const [alpha, beta] = await twoIdleWindows();
            const router = newRouter();
            router.selectDebugWindow({ pid: alpha.pid });
            assertAnsweredBy(await router.handleReset({ halt: true, window: String(beta.pid) }), 'beta');
            assertAnsweredBy(await router.handleReadMemory(READ), 'alpha');
        });

        test('the window argument never reaches the worker', async () => {
            const [alpha] = await twoIdleWindows();
            const answer = textOf(await newRouter().handleCmsisCommand({ action: 'build', target: 'HE', window: ` ${alpha.pid} ` }));
            assert.strictEqual(answer, echo('alpha', 'debug', 'handleCmsisCommand', { action: 'build', target: 'HE' }));
        });

        test('a window argument that matches nothing is INVALID_ARGUMENT with the candidates, and the session keeps its target', async () => {
            const [alpha, beta] = await twoIdleWindows();
            await chooseDefault(beta);
            const router = newRouter();
            assertAnsweredBy(await router.handleAddBreakpoint({ fileFullPath: path.join(folder('alpha'), 'main.c'), line: 3 }), 'alpha');
            const miss = await refusedAs('INVALID_ARGUMENT', router.handleFlash({ window: '4' }),
                /^The window argument "4" matches no open VS Code window\./, /Pass the pid of one of these, or a path inside its workspace:\n {2}• pid=/);
            assert.deepStrictEqual(miss.data, {
                candidates: [alpha, beta].map((w) => ({
                    pid: w.pid, name: w.label, workspaceFolders: w.entry.workspaceFolders, hasActiveSession: false, isDefault: w === beta,
                })),
            });
            await refusedAs('INVALID_ARGUMENT', router.handleFlash({ window: '/not/in/any/workspace' }),
                /^The window argument "\/not\/in\/any\/workspace" matches no open VS Code window\./);
            assertAnsweredBy(await router.handleReadMemory(READ), 'alpha');
        });

        test('the tie names a default whose window is not open, and its candidates carry isDefault and role', async () => {
            const a = await openWindow('boardA', { workspaceFolders: [folder('a')], role: 'router' });
            const b = await openWindow('boardB', { workspaceFolders: [folder('b')], role: 'worker' });
            await registryView().writeDefaultTarget({ pid: FIRST_FAKE_PID - 1, workspaceFolder: folder('closed'), name: 'closed-board', setAt: ++clock });
            const tie = await refusedAs('AMBIGUOUS_WINDOW', newRouter().handleReadMemory(READ),
                /none has an active debug session/,
                /The default target the user set in VS Code \(closed-board\) is not open\./,
                /cmsis_action load_and_debug and window set to its pid/,
                /click "CDA" in the VS Code status bar → Select Target Window/);
            const candidate = (w: FakeWindow, role: string): object => ({
                pid: w.pid, name: w.label, workspaceFolders: w.entry.workspaceFolders, hasActiveSession: false, isDefault: false, role,
            });
            assert.deepStrictEqual(tie.data, { candidates: [candidate(a, 'router'), candidate(b, 'worker')] });
        });

        test('the listing marks the default target and the router; a pin names the default it overrides', async () => {
            const alpha = await openWindow('alpha', { workspaceFolders: [folder('alpha')], role: 'router' });
            const beta = await openWindow('beta', { workspaceFolders: [folder('beta')], role: 'worker' });
            await chooseDefault(beta);
            const router = newRouter();
            const rows = router.listDebugWindows().split('\n');
            assert.match(rows.find((row) => row.includes(folder('beta'))) ?? '', /← default target \(set in VS Code\)$/);
            assert.match(rows.find((row) => row.includes(folder('alpha'))) ?? '', new RegExp(`^• pid=${alpha.pid} \\| .* \\| router$`));
            assert.match(router.selectDebugWindow({ pid: alpha.pid }),
                new RegExp(`\\nThe user set pid=${beta.pid} \\(beta\\) as the default target in VS Code; this pin overrides it for this session\\.$`));
            assert.match(router.selectDebugWindow({ pid: beta.pid }), /\nIt is also the default target the user set in VS Code\.$/);
            assert.deepStrictEqual(router.describeTarget(), { pid: beta.pid, name: 'beta', reason: 'pinned' });
        });

        test('a session describes no target before its first call, nor after its window became unreachable', async () => {
            const gone = await openWindow('gone');
            const router = newRouter();
            assert.strictEqual(router.describeTarget(), undefined);
            assertAnsweredBy(await router.handleGetSessionStatus(), 'gone');
            assert.deepStrictEqual(router.describeTarget(), { pid: gone.pid, name: 'gone', reason: 'only-window' });
            await gone.close();
            await refusedAs('WINDOW_UNREACHABLE', router.handleGetSessionStatus());
            assert.strictEqual(router.describeTarget(), undefined);
        });
    });

    suite('control server', () => {

        test('a wrong token is turned away', async () => {
            const alpha = await openWindow('alpha');
            saveRegistration('alpha', { ...alpha.entry, controlToken: 'not-the-token' });
            await refusedAs('WINDOW_UNREACHABLE', newRouter().handleGetSessionStatus(), /Could not reach .*control server returned 403/);
        });

        suite('the gate (#19)', () => {
            const STATUS_OP = '{"op":"handleGetSessionStatus","args":{}}';
            /** What a 403 or 404 says to whoever probes the port. */
            const POINTER = { error: 'internal endpoint of the CMSIS Developer Assistant; agents use the MCP tools list_debug_windows and select_debug_window' };

            /** Post the status op with these headers on top of the right token; the answer, or the client's error. */
            async function probe(solo: FakeWindow, headers: http.OutgoingHttpHeaders): Promise<RawReply> {
                return rawPost(solo.port, solo.token, [STATUS_OP], 0, headers);
            }

            function assertTurnedAway(reply: RawReply, status: number, label: string): void {
                assert.strictEqual(reply.status, status, label);
                assert.deepStrictEqual(JSON.parse(reply.body), POINTER, label);
                assert.match(reply.headers['content-type'] ?? '', /application\/json/, label);
            }

            test('a wrong token of any length, a non-ASCII one and a doubled header get 403, and the window keeps serving', async () => {
                const solo = await openWindow('solo');
                const sameLength = 'x'.repeat(solo.token.length);
                const latin1 = `${solo.token.slice(0, -1)}\u00f6`;
                const cases: Array<[string, http.OutgoingHttpHeaders]> = [
                    ['same length', { [TOKEN_HEADER]: sameLength }],
                    ['longer', { [TOKEN_HEADER]: `${solo.token}x` }],
                    ['shorter', { [TOKEN_HEADER]: solo.token.slice(1) }],
                    ['same length, one byte longer in UTF-8', { [TOKEN_HEADER]: latin1 }],
                    ['doubled', { [TOKEN_HEADER]: [solo.token, solo.token] }],
                    ['empty', { [TOKEN_HEADER]: '' }],
                ];
                for (const [label, headers] of cases) {
                    assertTurnedAway(await probe(solo, headers), 403, label);
                }
                assert.strictEqual(textOf(await newRouter().handleGetSessionStatus()), echo('solo', 'debug', 'handleGetSessionStatus', {}));
            });

            test('an Origin, even a local one, gets 403 with the right token', async () => {
                const solo = await openWindow('solo');
                for (const origin of ['http://evil.example', 'http://localhost:3001', 'null']) {
                    assertTurnedAway(await probe(solo, { Origin: origin }), 403, origin);
                }
            });

            test('a Host that is not this machine gets 403 with the right token', async () => {
                const solo = await openWindow('solo');
                for (const host of ['evil.example', `evil.example:${solo.port}`, `127.0.0.1.evil.example:${solo.port}`]) {
                    assertTurnedAway(await probe(solo, { Host: host }), 403, host);
                }
                const local = await probe(solo, { Host: `localhost:${solo.port}` });
                assert.strictEqual(local.status, 200, 'localhost is this machine');
            });

            test('another path or method gets 404 with the same pointer, before any token is looked at', async () => {
                const solo = await openWindow('solo');
                const answer = await new Promise<RawReply>((resolve, reject) => {
                    const request = http.request({ method: 'GET', hostname: '127.0.0.1', port: solo.port, path: '/', agent: false }, (reply) => {
                        const got: Buffer[] = [];
                        reply.on('data', (piece: Buffer) => got.push(piece));
                        reply.on('end', () => resolve({ status: reply.statusCode ?? 0, body: Buffer.concat(got).toString('utf8'), headers: reply.headers }));
                    });
                    request.on('error', reject);
                    request.end();
                });
                assertTurnedAway(answer, 404, 'GET /');
            });
        });

        test('the op hook hears every op start and end, a failed one too, and a listener that throws is only logged (#16)', async () => {
            const failing = {
                ...echoing<IDebuggingHandler>('solo', 'debug', DEBUG_OPS),
                handleReadMemory: () => Promise.reject(new ToolError('TARGET_RUNNING', 'running')),
            } as IDebuggingHandler;
            const control = new ControlServer(failing, 'tok');
            const port = await control.start();
            running.push(() => control.stop());
            const heard: string[] = [];
            control.onOp((op, phase) => heard.push(`${op} ${phase}`));
            await rawPost(port, 'tok', ['{"op":"handleGetThreads","args":{}}']);
            await rawPost(port, 'tok', ['{"op":"handleReadMemory","args":{}}']);
            await rawPost(port, 'tok', ['{"op":"handleNotAnOp","args":{}}']);
            assert.deepStrictEqual(heard, ['handleGetThreads start', 'handleGetThreads end', 'handleReadMemory start', 'handleReadMemory end']);
            control.onOp(() => { throw new Error('the listener broke'); });
            const answered = await rawPost(port, 'tok', ['{"op":"handleGetThreads","args":{}}']);
            assert.strictEqual(answered.status, 200);
            assert.strictEqual(JSON.parse(answered.body).result, echo('solo', 'debug', 'handleGetThreads', {}));
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
            const result = textOf(await newRouter().handleReadMemory({ address: '0x20000000', length: 64, format: 'hex' }));
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
            await refusedAs('INTERNAL', newRouter().handleGetSessionStatus(), /control response above \d+ bytes/);
        });

        test('a window that stopped listening is reported as unreachable', async () => {
            const gone = await openWindow('gone');
            saveRegistration('gone', { ...gone.entry, controlPort: 1 });
            await refusedWith(newRouter().handleGetSessionStatus(), /Could not reach the VS Code window/, /list_debug_windows/);
        });
    });

    suite('typed outcomes (#11)', () => {
        const refuseRunning = (): Promise<ToolText> =>
            Promise.reject(new ToolError('TARGET_RUNNING', 'Cannot read memory: session state is \'running\'.', 'Add a breakpoint first.'));
        const waiting = (): Promise<ToolText> => Promise.resolve({ text: 'still waiting', status: 'timeout', data: { waitedMs: 5 } });

        test('a worker ToolError arrives with its code, and the session keeps its target', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            await openWindow('beta', { workspaceFolders: [folder('beta')] }, true, { handleReadMemory: refuseRunning });
            const router = newRouter();
            assertAnsweredBy(await router.handleAddBreakpoint({ fileFullPath: path.join(folder('beta'), 'main.c'), line: 3 }), 'beta');
            const refused = await refusedAs('TARGET_RUNNING', router.handleReadMemory({ address: '0x0', length: 4 }), /session state is 'running'/);
            assert.strictEqual(refused.hint, 'Add a breakpoint first.');
            // Two idle windows: only the cached target can take a path-less call.
            assertAnsweredBy(await router.handleGetSessionStatus(), 'beta');
        });

        test('a worker reply with a status arrives whole', async () => {
            await openWindow('solo', {}, true, { handleWaitForStop: waiting });
            assert.deepStrictEqual(await newRouter().handleWaitForStop({}), { text: 'still waiting', status: 'timeout', data: { waitedMs: 5 } });
        });

        test('a dead port gives WINDOW_UNREACHABLE and clears the cached target', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const beta = await openWindow('beta', { workspaceFolders: [folder('beta')] });
            const router = newRouter();
            assertAnsweredBy(await router.handleAddBreakpoint({ fileFullPath: path.join(folder('beta'), 'main.c'), line: 3 }), 'beta');
            await beta.close();
            await refusedAs('WINDOW_UNREACHABLE', router.handleReadMemory({ address: '0x0', length: 4 }),
                new RegExp(`Could not reach the VS Code window handling this session \\(pid=${beta.pid}\\)`), /list_debug_windows/);
            // The target is forgotten: two idle windows are a tie.
            await refusedAs('AMBIGUOUS_WINDOW', router.handleReadMemory({ address: '0x0', length: 4 }));
        });

        test('a worker that never answers gives WORKER_TIMEOUT and keeps the target', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            await openStandIn(() => { /* never answers */ }, 'silent', { workspaceFolders: [folder('silent')] });
            const router = newRouter(200);
            await refusedAs('WORKER_TIMEOUT', router.handleAddBreakpoint({ fileFullPath: path.join(folder('silent'), 'main.c'), line: 3 }),
                /sent no response within/);
            // Still the target: a path-less call goes there again instead of being refused as a tie.
            await refusedAs('WORKER_TIMEOUT', router.handleReadMemory({ address: '0x0', length: 4 }));
        });

        test('replies of a 2.3.10 worker are classified', async () => {
            const legacy = (status: number, body: object) => (reply: http.ServerResponse): void => {
                reply.writeHead(status, JSON_TYPE).end(JSON.stringify(body));
            };
            await openStandIn(legacy(500, { error: 'Step over failed: Error: Cannot step over: session state is \'running\'. Add a breakpoint.' }), 'old-error');
            await refusedAs('TARGET_RUNNING', newRouter().handleStepOver({}), /^Step over failed/);
            fs.rmSync(path.join(dir, 'window-old-error.json'));

            await openStandIn(legacy(200, { result: 'Error in \'read_memory\': Cannot read memory: session state is \'no-session\'. No active debug session.' }), 'old-fence');
            const fenced = await refusedAs('NO_SESSION', newRouter().handleReadMemory({ address: '0x0', length: 4 }));
            assert.strictEqual(fenced.message, 'Cannot read memory: session state is \'no-session\'. No active debug session.');
            fs.rmSync(path.join(dir, 'window-old-fence.json'));

            const capText = '\'get_threads\' did not complete within 100 ms (handler-level cap). The DAP probe or target may be unresponsive.';
            await openStandIn(legacy(200, { result: capText }), 'old-cap');
            assert.deepStrictEqual(await newRouter().handleGetThreads({}), { text: capText, status: 'timeout' });
        });

        test('a typed reply is taken as it is, and fields this version does not know are ignored', async () => {
            const typed = (status: number, body: object) => (reply: http.ServerResponse): void => {
                reply.writeHead(status, { ...JSON_TYPE, [CONTROL_ENVELOPE_HEADER]: '2' }).end(JSON.stringify(body));
            };
            /** One call to a stand-in that is the only registered window while the call runs. */
            const callAlone = async <T>(label: string, answer: (reply: http.ServerResponse) => void,
                call: (router: RoutingDebuggingHandler) => Promise<T>): Promise<T> => {
                await openStandIn(answer, label);
                try {
                    return await call(newRouter());
                } finally {
                    fs.rmSync(path.join(dir, `window-${label}.json`));
                }
            };

            assert.deepStrictEqual(await callAlone('newer', typed(200, {
                result: { text: 'done', status: 'ok', data: { count: 2 } }, journalSeq: 7, journalErrors: 0,
            }), (router) => router.handleGetThreads({})), { text: 'done', status: 'ok', data: { count: 2 } });

            // Only a reply without the header is read as a 2.3.10 text.
            assert.strictEqual(await callAlone('newer-text', typed(200, { result: 'Error in \'x\': the text of a success', journalSeq: 8 }),
                (router) => router.handleGetThreads({})), 'Error in \'x\': the text of a success');

            const busy = await callAlone('newer-error', typed(500, {
                error: { message: 'busy', code: 'PROBE_BUSY', hint: 'Call stop_debugging first.', data: { owner: 'other' }, problems: [] },
                journalSeq: 9,
            }), (router) => refusedAs('PROBE_BUSY', router.handleGetThreads({})));
            assert.deepStrictEqual([busy.message, busy.hint, busy.data], ['busy', 'Call stop_debugging first.', { owner: 'other' }]);

            // A code of a later version is not guessed at; its message and hint still arrive.
            const unknown = await callAlone('newer-code', typed(500, { error: { message: 'port gone', code: 'PORT_CLOSED', hint: 'Open it again.' } }),
                (router) => refusedAs('INTERNAL', router.handleGetThreads({})));
            assert.strictEqual(errorDetail(unknown), 'port gone\nOpen it again.');
        });

        test('a failed channel is WINDOW_UNREACHABLE and drops the target; a 413 is INVALID_ARGUMENT and keeps it', async () => {
            await openWindow('alpha', { workspaceFolders: [folder('alpha')] });
            const cases: Array<[string, (reply: http.ServerResponse) => void, ErrorCode, RegExp]> = [
                ['stale-token', (reply) => { reply.writeHead(403).end(); }, 'WINDOW_UNREACHABLE', /control server returned 403/],
                ['other-server', (reply) => { reply.writeHead(404).end(); }, 'WINDOW_UNREACHABLE', /control server returned 404/],
                ['garbled', (reply) => { reply.writeHead(200, JSON_TYPE).end('<html>'); }, 'WINDOW_UNREACHABLE', /malformed control response: <html>/],
                ['hung-up', (reply) => { reply.socket?.destroy(); }, 'WINDOW_UNREACHABLE', /socket hang up|ECONNRESET/],
                ['too-large', (reply) => { reply.writeHead(413, JSON_TYPE).end(JSON.stringify({ error: 'control request above 1048576 bytes' })); },
                    'INVALID_ARGUMENT', /^control request above 1048576 bytes$/],
            ];
            for (const [label, answer, code, pattern] of cases) {
                await openStandIn(answer, label, { workspaceFolders: [folder(label)] });
                const router = newRouter();
                await refusedAs(code, router.handleAddBreakpoint({ fileFullPath: path.join(folder(label), 'main.c'), line: 3 }), pattern);
                // A forgotten target leaves two idle windows, a tie; a kept one takes the path-less call again.
                await refusedAs(code === 'WINDOW_UNREACHABLE' ? 'AMBIGUOUS_WINDOW' : code, router.handleReadMemory({ address: '0x0', length: 4 }));
                fs.rmSync(path.join(dir, `window-${label}.json`));
            }
        });

        test('the control server answers a router without the envelope header in the 2.3.10 shapes', async () => {
            const solo = await openWindow('solo', {}, true, { handleReadMemory: refuseRunning, handleWaitForStop: waiting });
            const call = (op: string, typed: boolean): Promise<RawReply> =>
                rawPost(solo.port, solo.token, [JSON.stringify({ op, args: {}, callId: 'reserved', sessionId: 'reserved', budgetMs: 5 })], 0,
                    typed ? { [CONTROL_ENVELOPE_HEADER]: '2' } : {});

            const oldFailure = await call('handleReadMemory', false);
            assert.strictEqual(oldFailure.status, 500);
            assert.deepStrictEqual(JSON.parse(oldFailure.body), { error: 'Cannot read memory: session state is \'running\'.\nAdd a breakpoint first.' });
            assert.strictEqual(oldFailure.headers[CONTROL_ENVELOPE_HEADER], undefined);
            const oldReply = await call('handleWaitForStop', false);
            assert.deepStrictEqual(JSON.parse(oldReply.body), { result: 'still waiting' });

            // A typed reply also carries the window's journal counters (#48).
            const counters = { journalSeq: 0, journalErrors: 0 };
            const typedFailure = await call('handleReadMemory', true);
            assert.strictEqual(typedFailure.status, 500);
            assert.strictEqual(typedFailure.headers[CONTROL_ENVELOPE_HEADER], '2');
            assert.deepStrictEqual(JSON.parse(typedFailure.body), {
                error: { message: 'Cannot read memory: session state is \'running\'.', code: 'TARGET_RUNNING', hint: 'Add a breakpoint first.' },
                ...counters,
            });
            const typedReply = await call('handleWaitForStop', true);
            assert.deepStrictEqual(JSON.parse(typedReply.body), { result: { text: 'still waiting', status: 'timeout', data: { waitedMs: 5 } }, ...counters });
            const typedText = await call('handleGetThreads', true);
            assert.deepStrictEqual(JSON.parse(typedText.body), { result: echo('solo', 'debug', 'handleGetThreads', {}), ...counters });
        });

        test('an unknown op and a missing handler group are TOOL_DISABLED', async () => {
            await openWindow('bare', {}, false);
            await refusedAs('TOOL_DISABLED', newRouter().serialOp('handleNotAnOp'), /not a known operation/);
            await refusedAs('TOOL_DISABLED', newRouter().packDocsOp('handleListTargetDocs', {}), /not available in this window/);
        });
    });

    suite('the problem journal across windows (#48)', () => {
        /** A stand-in that answers every request typed, `answer` as its body, and keeps the request bodies. */
        async function openRecorder(label: string, answer: object): Promise<{ window: FakeWindow; bodies: JsonObject[] }> {
            const bodies: JsonObject[] = [];
            const fake = http.createServer((incoming, reply) => {
                const parts: Buffer[] = [];
                incoming.on('data', (piece: Buffer) => parts.push(piece));
                incoming.on('end', () => {
                    bodies.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as JsonObject);
                    reply.writeHead(200, { ...JSON_TYPE, [CONTROL_ENVELOPE_HEADER]: '2' }).end(JSON.stringify(answer));
                });
            });
            await new Promise<void>((ready) => fake.listen(0, '127.0.0.1', ready));
            running.push(() => closeHttpServer(fake));
            const window = enrol(label, (fake.address() as AddressInfo).port, `token-${label}`, {}, () => closeHttpServer(fake));
            return { window, bodies };
        }

        const power = { source: 'gdb-server', origin: 'CMSIS Debugger: pyOCD', severity: 'error', message: 'Failed to power up DAP' } as const;

        test('the envelope carries the call id and the MCP session id of the call, and nothing without a call', async () => {
            const { bodies } = await openRecorder('recorder', { result: 'ok' });
            const router = newRouter();
            await runInCallContext({ callId: 'abcd1234-7', sessionId: 'abcd1234-5678-90ef' }, () => router.handleGetThreads({}));
            await router.handleGetThreads({});
            assert.deepStrictEqual(bodies[0], { op: 'handleGetThreads', args: {}, callId: 'abcd1234-7', sessionId: 'abcd1234-5678-90ef' });
            assert.deepStrictEqual(bodies[1], { op: 'handleGetThreads', args: {} });
        });

        test('a worker answers with its journal counters; a router without the envelope gets none', async () => {
            const solo = await openWindow('solo');
            solo.journal.append({ ...power });
            solo.journal.append({ ...power, severity: 'warning', message: 'slow probe' });
            const typed = await rawPost(solo.port, solo.token, ['{"op":"handleGetThreads","args":{}}'], 0, { [CONTROL_ENVELOPE_HEADER]: '2' });
            assert.deepStrictEqual(JSON.parse(typed.body), { result: echo('solo', 'debug', 'handleGetThreads', {}), journalSeq: 2, journalErrors: 1 });
            const old = await rawPost(solo.port, solo.token, ['{"op":"handleGetThreads","args":{}}']);
            assert.deepStrictEqual(JSON.parse(old.body), { result: echo('solo', 'debug', 'handleGetThreads', {}) });
        });

        test('a worker failure arrives with the problems its op produced, stamped with the call id', async () => {
            let journal: ProblemJournal | undefined;
            const failing = async (): Promise<ToolText> => {
                journal?.append({ ...power });
                throw new ToolError('TASK_FAILED', 'CMSIS \'load_and_debug\' did NOT survive the initial connect.', 'Check the probe.');
            };
            const beta = await openWindow('beta', { workspaceFolders: [folder('beta')] }, true, { handleCmsisCommand: failing });
            journal = beta.journal;
            const refused = await runInCallContext({ callId: 'feedbeef-3', sessionId: 'feedbeef-0000' },
                () => refusedAs('TASK_FAILED', newRouter().handleCmsisCommand({ action: 'load_and_debug' })));
            const problems = refused.data?.problems as JsonObject[];
            assert.deepStrictEqual(problems.map((record) => [record.seq, record.source, record.message, record.toolCallId]),
                [[1, 'gdb-server', 'Failed to power up DAP', 'feedbeef-3']]);
            assert.strictEqual(refused.hint, 'Check the probe.');
        });

        test('a timeout reply of a worker carries the problems of its wait', async () => {
            let journal: ProblemJournal | undefined;
            const waiting = async (): Promise<ToolText> => {
                journal?.append({ ...power, source: 'dap', severity: 'warning', message: 'adapter slow' });
                return { text: 'did not stop', status: 'timeout' };
            };
            const solo = await openWindow('solo', {}, true, { handleWaitForStop: waiting });
            journal = solo.journal;
            const reply = await newRouter().handleWaitForStop({});
            assert.ok(typeof reply !== 'string' && reply.status === 'timeout');
            assert.strictEqual(((reply.data as JsonObject).problems as JsonObject[])[0].message, 'adapter slow');
        });

        test('new errors in the target window: a note once per batch, the count in get_session_status, both gone after get_recent_problems', async () => {
            const solo = await openWindow('solo');
            const router = newRouter();
            const threads = echo('solo', 'debug', 'handleGetThreads', {});
            const status = echo('solo', 'debug', 'handleGetSessionStatus', {});
            assert.strictEqual(await router.handleGetThreads({}), threads, 'the first answer sets the baseline');
            solo.journal.append({ ...power, message: 'error response to \'setBreakpoints\': Cannot execute this command while the target is running.' });
            assert.strictEqual(await router.handleGetThreads({}), `${threads}\n\n${newErrorsNote(1, 1)}`);
            assert.strictEqual(await router.handleGetThreads({}), threads, 'once per batch');
            solo.journal.append({ ...power });
            assert.strictEqual(await router.handleGetThreads({}), `${threads}\n\n${newErrorsNote(2, 1)}`);
            assert.strictEqual(await router.handleGetSessionStatus(), `${status}\n${newErrorsStatusLine(2, 1)}`);
            assert.strictEqual(await router.handleGetSessionStatus(), `${status}\n${newErrorsStatusLine(2, 1)}`, 'the count stays until the agent looks');
            await router.handleGetRecentProblems({ sinceSeq: 1 });
            assert.strictEqual(await router.handleGetSessionStatus(), status);
            assert.strictEqual(await router.handleGetThreads({}), threads);
            // Another session keeps its own baseline, set by its first answer.
            assert.strictEqual(await newRouter().handleGetThreads({}), threads);
        });

        test('a worker that sends no counters (2.5.0) gives no note, whatever its journal holds', async () => {
            const { window } = await openRecorder('old-worker', { result: 'ok' });
            const router = newRouter();
            assert.strictEqual(await router.handleGetThreads({}), 'ok');
            window.journal.append({ ...power });
            assert.strictEqual(await router.handleGetThreads({}), 'ok');
            assert.strictEqual(await router.handleGetSessionStatus(), 'ok');
        });

        test('counters in a reply without the envelope header are not read', async () => {
            await openStandIn((reply) => {
                reply.writeHead(200, JSON_TYPE).end(JSON.stringify({ result: 'plain', journalSeq: 9, journalErrors: 9 }));
            });
            const router = newRouter();
            assert.strictEqual(await router.handleGetThreads({}), 'plain');
            assert.strictEqual(await router.handleGetThreads({}), 'plain');
        });
    });
});
