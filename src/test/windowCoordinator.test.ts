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

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { SERVER_VERSION } from '../debuggingExecutor';
import { WindowCoordinator, type DebugSessionEvents } from '../windowCoordinator';
import { WindowRegistration, WorkspaceRegistry } from '../utils/workspaceRegistry';
import { logger } from '../utils/logger';
import { createSessionTracker } from '../utils/sessionStateTracker';

suite('WindowCoordinator serial teardown', () => {
    let dir: string;
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-coordinator-')); });
    teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('dispose releases the serial backends of this window, whether or not it was the router', async () => {
        let calls = 0;
        const coordinator = new WindowCoordinator({
            port: 0, timeoutInSeconds: 1, hardwareTimeouts: {},
            registry: new WorkspaceRegistry(process.pid, dir),
            serialTeardown: async () => { calls++; },
        });
        assert.ok(!coordinator.isRouter(), 'never started: a worker');
        await coordinator.dispose();
        assert.strictEqual(calls, 1);
    });

    test('a teardown that never settles cannot hold deactivate', async () => {
        const coordinator = new WindowCoordinator({
            port: 0, timeoutInSeconds: 1, hardwareTimeouts: {},
            registry: new WorkspaceRegistry(process.pid, dir),
            serialTeardown: () => new Promise<void>(() => { /* wedged tty */ }),
        });
        const t0 = Date.now();
        await coordinator.dispose();
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 1_900 && elapsed < 2_600, `dispose took ${elapsed} ms`);
    });

    test('a failing teardown is logged, not thrown', async () => {
        const coordinator = new WindowCoordinator({
            port: 0, timeoutInSeconds: 1, hardwareTimeouts: {},
            registry: new WorkspaceRegistry(process.pid, dir),
            serialTeardown: async () => { throw new Error('EIO'); },
        });
        await coordinator.dispose();
    });
});

/**
 * The window's entry and the watch on the router window (#14): what the
 * coordinator publishes, and when a worker whose bid for the port fails
 * warns that the router stopped running.
 */
suite('WindowCoordinator and the router window (#14)', () => {
    /** A pid that only this suite's liveness checks take for alive: the stuck router. */
    const ROUTER_PID = 700_201;
    const noTeardown = async (): Promise<void> => undefined;
    let dir: string;
    let closers: Array<() => Promise<void>>;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-coordinator-'));
        closers = [];
    });
    teardown(async () => {
        for (const close of closers) {
            await close();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A registry over the test directory that takes this process and the stuck router for alive. */
    const registryView = (): WorkspaceRegistry => new WorkspaceRegistry(process.pid, dir, (pid) => pid === process.pid || pid === ROUTER_PID);

    /** Write the entry of another window by hand. */
    function plant(label: string, entry: Partial<WindowRegistration>): void {
        const full: WindowRegistration = {
            pid: ROUTER_PID, controlPort: 1, controlToken: 'token', workspaceFolders: [], name: label, updatedAt: Date.now(), ...entry,
        };
        fs.writeFileSync(path.join(dir, `window-${label}.json`), JSON.stringify(full));
    }

    /** Hold a loopback port with a server that accepts connections and never answers, as a blocked router does. */
    async function holdSilently(): Promise<number> {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => { sockets.add(socket); });
        await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
        closers.push(() => new Promise<void>((closed) => {
            for (const socket of sockets) {
                socket.destroy();
            }
            server.close(() => closed());
        }));
        return (server.address() as AddressInfo).port;
    }

    /** Hold a loopback port with a server that answers every request at once, as a healthy router does. */
    async function holdAnswering(): Promise<number> {
        const server = http.createServer((_incoming, reply) => { reply.writeHead(400).end(); });
        await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
        closers.push(() => new Promise<void>((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
        }));
        return (server.address() as AddressInfo).port;
    }

    /** A worker for `port` whose warnings land in `shown` and whose clock is `now()`. */
    function worker(port: number, shown: string[], now: () => number): WindowCoordinator {
        const coordinator = new WindowCoordinator({
            port, timeoutInSeconds: 1, hardwareTimeouts: {}, registry: registryView(), serialTeardown: noTeardown,
            notify: (message) => {
                shown.push(message);
                return Promise.resolve(undefined);
            },
            clock: now,
            timings: { routerProbeMs: 150 },
        });
        closers.push(() => coordinator.dispose());
        return coordinator;
    }

    test('the window publishes its role and the extension version', async () => {
        const registry = registryView();
        const coordinator = new WindowCoordinator({ port: 0, timeoutInSeconds: 1, hardwareTimeouts: {}, registry, serialTeardown: noTeardown });
        const context = { subscriptions: [] as vscode.Disposable[] };
        try {
            await coordinator.start(context as unknown as vscode.ExtensionContext);
            const own = registry.list().find((entry) => entry.pid === process.pid);
            assert.deepStrictEqual([own?.role, own?.version], ['router', SERVER_VERSION]);
            assert.strictEqual(own?.busy, undefined, 'nothing runs yet');
            assert.strictEqual(own?.lagMs, undefined, 'the lag comes with the first heartbeat');
        } finally {
            await coordinator.dispose();
            for (const subscription of context.subscriptions) {
                subscription.dispose();
            }
        }
    });

    test('the window publishes the csolution the CMSIS Solution extension names, and drops it when the solution closes', async () => {
        const registry = registryView();
        let answer: unknown = { solutionFile: '/w/Blinky.csolution.yml' };
        const coordinator = new WindowCoordinator({
            port: 0, timeoutInSeconds: 1, hardwareTimeouts: {}, registry, serialTeardown: noTeardown,
            solutionFile: () => Promise.resolve(answer),
        });
        const context = { subscriptions: [] as vscode.Disposable[] };
        const published = async (expected: string | undefined): Promise<void> => {
            for (let tries = 0; tries < 50; tries++) {
                if (registry.list().find((entry) => entry.pid === process.pid)?.cmsisProject === expected) {
                    return;
                }
                await new Promise((later) => setTimeout(later, 20));
            }
            assert.fail(`cmsisProject is not ${expected ?? 'unset'}`);
        };
        try {
            await coordinator.start(context as unknown as vscode.ExtensionContext);
            await published('/w/Blinky.csolution.yml');
            answer = '';
            coordinator.publish();
            await published(undefined);
        } finally {
            await coordinator.dispose();
            for (const subscription of context.subscriptions) {
                subscription.dispose();
            }
        }
    });

    test('a stale router entry and a silent port raise one warning per episode', async () => {
        const port = await holdSilently();
        const base = Date.now();
        let now = base;
        plant('stuck', { role: 'router', name: 'CDA-Testdrive', updatedAt: base - 75_000 });
        const shown: string[] = [];
        const coordinator = worker(port, shown, () => now);
        await coordinator.pollPromotion();
        assert.ok(!coordinator.isRouter());
        assert.deepStrictEqual(shown, ['CMSIS Developer Assistant: the router window (pid 700201, CDA-Testdrive) has not responded for 75 s, '
            + 'so agents cannot reach any window. Reload or close that window; another window takes over automatically.']);
        now += 10_000;
        await coordinator.pollPromotion();
        assert.strictEqual(shown.length, 1, 'once per episode');
    });

    /** A log channel that records what reaches it at the level the user picked, as logger.test.ts has it. */
    class RecordingChannel {
        readonly lines: string[] = [];
        constructor(public logLevel: number) { }
        trace(line: string): void { this.lines.push(`trace ${line}`); }
        debug(line: string): void { this.lines.push(`debug ${line}`); }
        info(line: string): void { this.lines.push(`info ${line}`); }
        warn(line: string): void { this.lines.push(`warn ${line}`); }
        error(line: string): void { this.lines.push(`error ${line}`); }
    }

    /** Run `work` with the logger writing to a recording channel at `level`, and give back its lines. */
    async function logged(level: number, work: () => Promise<void>): Promise<string[]> {
        const swap = logger as unknown as { channel: unknown };
        const original = swap.channel;
        const channel = new RecordingChannel(level);
        swap.channel = channel;
        try {
            await work();
        } finally {
            swap.channel = original;
        }
        return channel.lines;
    }

    test('a worker says once that it is a worker; the polls that keep losing the port are debug lines', async () => {
        const port = await holdAnswering();
        plant('router', { role: 'router', updatedAt: Date.now() });
        const coordinator = worker(port, [], () => Date.now());
        const atInfo = await logged(vscode.LogLevel.Info, async () => {
            await coordinator.pollPromotion();
            await coordinator.pollPromotion();
            await coordinator.pollPromotion();
        });
        assert.deepStrictEqual(atInfo, ['info Another window is the router; this window is a worker.']);
        const atDebug = await logged(vscode.LogLevel.Debug, () => coordinator.pollPromotion());
        assert.deepStrictEqual(atDebug.filter((line) => !line.startsWith('debug ')), [], atDebug.join('\n'));
        assert.ok(atDebug.some((line) => line === `debug Still a worker: port ${port} is taken`), atDebug.join('\n'));
        // The poll finds the port answering and builds no server for it (#14).
        assert.ok(!atDebug.some((line) => line.startsWith('debug Opening the MCP endpoint on')), atDebug.join('\n'));
    });

    test('a window that joins or leaves the registry is one info line; a look that finds the same windows logs nothing', async () => {
        const port = await holdAnswering();
        const coordinator = worker(port, [], () => Date.now());
        plant('CDA-Testdrive', { role: 'router', updatedAt: Date.now() });
        const joined = await logged(vscode.LogLevel.Info, async () => coordinator.observeWindows());
        assert.deepStrictEqual(joined, ['info Window pid 700201 (CDA-Testdrive) joined the registry; 1 window registered']);
        const same = await logged(vscode.LogLevel.Info, async () => coordinator.observeWindows());
        assert.deepStrictEqual(same, []);
        fs.rmSync(path.join(dir, 'window-CDA-Testdrive.json'));
        const left = await logged(vscode.LogLevel.Info, async () => coordinator.observeWindows());
        assert.deepStrictEqual(left, ['info Window pid 700201 (CDA-Testdrive) left the registry; 0 windows registered']);
    });

    test('a healthy router raises none: its fresh entry spares the check, and a port that answers ends the episode', async () => {
        const port = await holdAnswering();
        plant('healthy', { role: 'router', updatedAt: Date.now() });
        const shown: string[] = [];
        await worker(port, shown, () => Date.now()).pollPromotion();
        // A stale router entry whose port still answers: the pid belongs to another process now.
        plant('healthy', { role: 'router', updatedAt: Date.now() - 75_000 });
        await worker(port, shown, () => Date.now()).pollPromotion();
        assert.deepStrictEqual(shown, []);
    });

    test('a router of 2.5.0, which writes no role, is named by its port once the port has been silent for a minute', async () => {
        const port = await holdSilently();
        plant('old-router', { updatedAt: Date.now() });
        const shown: string[] = [];
        let now = Date.now();
        const coordinator = worker(port, shown, () => now);
        await coordinator.pollPromotion();
        now += 50_000;
        await coordinator.pollPromotion();
        assert.deepStrictEqual(shown, [], 'silent for less than a minute');
        now += 20_000;
        await coordinator.pollPromotion();
        assert.deepStrictEqual(shown, [`CMSIS Developer Assistant: the window serving port ${port} has not responded for 70 s, `
            + 'so agents cannot reach any window. Reload or close that window; another window takes over automatically.']);
    });
});

/**
 * The debug session the window publishes: the session tracker's live
 * sessions decide, not VS Code's focus alone, which still names a session
 * while its end is announced. The fake events stand for `vscode.debug`; a
 * session's end reaches the coordinator's listener before the tracker drops
 * the session, the harder of the two orders.
 */
suite('WindowCoordinator and the debug session it publishes', () => {
    /** VS Code's debug API as the coordinator reads it, with events the test fires. */
    class FakeDebug implements DebugSessionEvents {
        activeDebugSession: vscode.DebugSession | undefined;
        readonly started = new vscode.EventEmitter<vscode.DebugSession>();
        readonly terminated = new vscode.EventEmitter<vscode.DebugSession>();
        readonly focused = new vscode.EventEmitter<vscode.DebugSession | undefined>();
        readonly onDidStartDebugSession = this.started.event;
        readonly onDidTerminateDebugSession = this.terminated.event;
        readonly onDidChangeActiveDebugSession = this.focused.event;
    }

    let dir: string;
    let trackers: Map<vscode.DebugSession, vscode.DebugAdapterTracker>;
    let debug: FakeDebug;
    let registry: WorkspaceRegistry;
    let coordinator: WindowCoordinator;
    let context: { subscriptions: vscode.Disposable[] };

    setup(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-coordinator-'));
        trackers = new Map();
        debug = new FakeDebug();
        registry = new WorkspaceRegistry(process.pid, dir, (pid) => pid === process.pid);
        coordinator = new WindowCoordinator({
            port: 0, timeoutInSeconds: 1, hardwareTimeouts: {}, registry, debug,
            serialTeardown: async () => undefined,
            solutionFile: () => undefined,
        });
        context = { subscriptions: [] };
        await coordinator.start(context as unknown as vscode.ExtensionContext);
    });
    teardown(async () => {
        await coordinator.dispose();
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        for (const tracker of trackers.values()) {
            tracker.onWillStopSession?.();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A session the adapter tracker holds live, as VS Code hands it one at the session's start. */
    function live(name: string): vscode.DebugSession {
        const session = { id: `coordinator-${name}`, name, type: 'gdbtarget', configuration: { name } } as unknown as vscode.DebugSession;
        trackers.set(session, createSessionTracker(session));
        return session;
    }

    /** VS Code announces the end of `session`, maybe still focused; then the tracker's own end listener drops it. */
    function end(session: vscode.DebugSession): void {
        debug.terminated.fire(session);
        trackers.get(session)?.onWillStopSession?.();
    }

    /** What this window's registry entry says about its debug session. */
    function published(): [boolean | undefined, string | undefined] {
        const own = registry.list().find((entry) => entry.pid === process.pid);
        return [own?.hasActiveSession, own?.activeConfigurationName];
    }

    test('a session that ends while VS Code still has it focused is published as ended', () => {
        const session = live('STLink@pyOCD (launch)');
        debug.activeDebugSession = session;
        debug.started.fire(session);
        assert.deepStrictEqual(published(), [true, 'STLink@pyOCD (launch)']);
        // VS Code announces the end before it moves the focus.
        end(session);
        assert.deepStrictEqual(published(), [false, undefined]);
    });

    test('of two sessions, the one that remains keeps the flag and gives its name when the other ends', () => {
        const fvp = live('Arm-FVP@GDB (launch)');
        const board = live('STLink@pyOCD (launch)');
        debug.activeDebugSession = board;
        debug.started.fire(board);
        assert.deepStrictEqual(published(), [true, 'STLink@pyOCD (launch)']);
        end(board);
        assert.deepStrictEqual(published(), [true, 'Arm-FVP@GDB (launch)']);
        debug.activeDebugSession = fvp;
        end(fvp);
        assert.deepStrictEqual(published(), [false, undefined]);
    });

    test('a change of the focused session is published, and so is a focus that leaves an ended session', () => {
        const core0 = live('Core0');
        const core1 = live('Core1');
        debug.activeDebugSession = core0;
        debug.started.fire(core1);
        assert.deepStrictEqual(published(), [true, 'Core0'], 'the focused session, though not the most recent');
        debug.activeDebugSession = core1;
        debug.focused.fire(core1);
        assert.deepStrictEqual(published(), [true, 'Core1']);
        // The adapters stop, VS Code's end events not yet delivered: the focus that leaves them publishes.
        for (const tracker of trackers.values()) {
            tracker.onWillStopSession?.();
        }
        debug.activeDebugSession = undefined;
        debug.focused.fire(undefined);
        assert.deepStrictEqual(published(), [false, undefined]);
    });
});
