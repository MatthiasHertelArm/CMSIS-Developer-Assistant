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
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { SERVER_VERSION } from '../debuggingExecutor';
import { WindowCoordinator } from '../windowCoordinator';
import { WindowRegistration, WorkspaceRegistry } from '../utils/workspaceRegistry';

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
