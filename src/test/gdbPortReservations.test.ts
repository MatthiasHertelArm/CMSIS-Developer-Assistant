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

/** Atomic reservation, lifecycle and synchronized independent-controller regressions. */

import * as assert from 'assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GdbPortReservations } from '../core/gdbPortReservations';
import { ToolError } from '../core/toolResult';

const START = { what: 'launch' as const, subject: 'Test launch not started', configuration: 'Test GDB' };
const CLAIM = { port: 3333, source: 'session' as const, label: 'Test GDB' };

/** One controller message, bounded even if a child fails before its IPC reply. */
function message(child: ChildProcess, command?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            clearTimeout(timer);
            child.off('message', received);
            child.off('error', failed);
            child.off('exit', exited);
        };
        const received = (value: unknown): void => { cleanup(); resolve(value as Record<string, unknown>); };
        const failed = (error: Error): void => { cleanup(); reject(error); };
        const exited = (code: number | null): void => { cleanup(); reject(new Error(`Controller exited before reply (${code})`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Controller did not answer within 5 seconds')); }, 5_000);
        child.once('message', received);
        child.once('error', failed);
        child.once('exit', exited);
        if (command !== undefined) {
            child.send(command);
        }
    });
}

/** A dummy server chooses a currently unused port; no target/probe connection is made. */
async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

suite('GDB port reservations', () => {
    let directory: string;
    const managers: GdbPortReservations[] = [];
    const manager = (pid = process.pid, alive?: (pid: number) => boolean): GdbPortReservations => {
        const result = new GdbPortReservations(directory, pid, alive);
        managers.push(result);
        return result;
    };
    const busy = (work: () => unknown): void => {
        assert.throws(work, (error: unknown) => error instanceof ToolError && error.code === 'PROBE_BUSY');
    };
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-port-reservation-')); });
    teardown(() => {
        for (const item of managers.splice(0)) {
            item.dispose();
        }
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('only one window owns a port, and a failed start can release it without touching other ports', () => {
        const a = manager();
        const b = manager();
        const lease = a.acquire(3333, START, 'first');
        const other = a.acquire(3334, START, 'first');
        busy(() => b.acquire(3333, START, 'second'));
        lease.release();
        const replacement = b.acquire(3333, START, 'second');
        lease.release();
        busy(() => a.acquire(3333, START, 'first'));
        busy(() => b.acquire(3334, START, 'second'));
        replacement.release();
        other.release();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('pending launches do not expire with an empty status; adopted ports release when their session/task ends', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first');
        a.observe([]);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([CLAIM]);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        a.acquire(3333, START, 'first');
        a.observe([{ ...CLAIM, source: 'cmsis-run' }]);
        a.observe([]);
        b.acquire(3333, START, 'second').release();
    });

    test('shutdown releases only this manager; an observed dead process is reclaimed without stale release deleting its successor', () => {
        const a = manager(123456, () => true);
        const stale = a.acquire(3333, START, 'dead');
        const b = manager(process.pid, (pid) => pid !== 123456);
        const replacement = b.acquire(3333, START, 'live');
        stale.release();
        busy(() => b.acquire(3333, START, 'live'));
        replacement.release();
        a.acquire(3334, START, 'first');
        b.acquire(3333, START, 'second');
        a.dispose();
        busy(() => manager().acquire(3333, START, 'third'));
        b.dispose();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('alternative launch configurations form one lifecycle batch; unselected ports are freed when the chosen session ends', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, { ...START, configuration: 'Alternative' }, 'first', 'one-launch');
        a.observe([CLAIM]);
        busy(() => b.acquire(4444, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('an older asynchronous observation cannot adopt or release a newer pending launch', () => {
        const a = manager();
        const b = manager();
        const beforeStart = a.observationVersion();
        a.acquire(3333, START, 'first');
        a.observe([CLAIM], beforeStart);
        a.observe([]);
        busy(() => b.acquire(3333, START, 'second'));
        const afterStart = a.observationVersion();
        a.observe([CLAIM], afterStart);
        a.observe([]);
        b.acquire(3333, START, 'second').release();
    });

    test('a verified start adopts its batch without a positive port sample; older empty samples cannot release it', () => {
        const a = manager();
        const b = manager();
        const lease = a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, START, 'first', 'one-launch');
        const beforeConfirmation = a.observationVersion();
        lease.adopt();
        a.observe([], beforeConfirmation);
        busy(() => b.acquire(3333, START, 'second'));
        busy(() => b.acquire(4444, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
    });

    /**
     * Tester feedback on preview 4: a load_and_debug with a short timeoutMs answered `running`, its
     * session ended before any port sample saw it live, and the reservation stayed until the window closed.
     */
    test('a session that begins on a reserved port adopts its batch; its end releases it without any positive port sample', () => {
        const a = manager();
        const b = manager();
        a.acquire(3333, START, 'first', 'one-launch');
        a.acquire(4444, START, 'first', 'one-launch');
        a.acquire(5555, START, 'first', 'another-launch');
        const beforeBegin = a.observationVersion();
        a.adoptPort(3333);
        a.adoptPort(6666);
        a.observe([], beforeBegin);
        busy(() => b.acquire(3333, START, 'second'));
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(4444, START, 'second').release();
        busy(() => b.acquire(5555, START, 'second'));
    });

    /**
     * Issue #127: an FVP load_and_debug whose launch VS Code never started kept port 3333 reserved until the window was
     * reloaded; the next load_and_debug of the same window was refused as if another window held the port.
     */
    test('pending starts are listed with their ages until a session or task takes them over; a start of this window is refused as its own', () => {
        let now = 1_000_000;
        const a = new GdbPortReservations(directory, process.pid, undefined, undefined, () => now);
        managers.push(a);
        const b = manager();
        const fvp = { ...START, configuration: 'Arm-FVP@GDB (launch)', server: 'Arm FVP' as const };
        const launch = a.acquire(3333, fvp, 'first', 'launch');
        now += 1_000;
        const alternative = a.acquire(3334, START, 'first', 'launch');
        now += 1_000;
        a.acquire(4444, { what: 'run', subject: 'CMSIS \'run\' not started', server: 'pyOCD' }, 'first', 'run');
        assert.strictEqual(launch.port, 3333);
        assert.strictEqual(launch.pending, true);
        assert.deepStrictEqual(a.pending(), [
            { group: 'launch', what: 'launch', label: 'Arm-FVP@GDB (launch)', server: 'Arm FVP', ports: [3333, 3334], since: 1_000_000, ageMs: 2_000 },
            { group: 'run', what: 'run', label: 'CMSIS Run', server: 'pyOCD', ports: [4444], since: 1_002_000, ageMs: 0 },
        ]);

        // Without `takeOver`, a second start of this window on a port it reserved is refused as its own pending start.
        now += 178_000;
        assert.throws(() => a.acquire(3333, START, 'first'), (caught: unknown) => caught instanceof ToolError && caught.code === 'PROBE_BUSY'
            && caught.message.endsWith('which this window reserved 3 min ago for its own launch of \'Arm-FVP@GDB (launch)\', which has not come up yet.')
            && !(caught.hint ?? '').includes('reload'), 'its own pending launch');
        busy(() => b.acquire(3333, START, 'second'));

        // A session took the launch over: its whole batch, which no start of this window can take over now.
        launch.adopt();
        assert.strictEqual(launch.pending, false);
        assert.strictEqual(alternative.pending, false, 'the whole batch is taken over');
        assert.deepStrictEqual(a.pending().map((start) => start.group), ['run']);
        assert.throws(() => a.acquire(3334, START, 'first', undefined, true), (caught: unknown) => caught instanceof ToolError
            && caught.message.includes('which this window uses for its debug session \'Test GDB\''), 'its own session');
        a.observe([]);
        b.acquire(3333, START, 'second').release();
        b.acquire(3334, START, 'second').release();
        busy(() => b.acquire(4444, START, 'second'));
    });

    /** Review of #127: the port must never be free while a start of this window that covers it may still begin. */
    test('a start of this window takes its own pending port over without freeing it; when it is over, the port goes back to the earlier start', () => {
        let now = 1_000_000;
        const a = new GdbPortReservations(directory, process.pid, undefined, undefined, () => now);
        managers.push(a);
        const b = manager();
        const first = { ...START, configuration: 'Arm-FVP@GDB (launch)' };
        const earlier = a.acquire(3333, first, 'first', 'earlier');
        a.acquire(3334, first, 'first', 'earlier');
        now += 20_000;
        const beforeTakeOver = a.observationVersion();
        const next = a.acquire(3333, { ...START, configuration: 'Next launch' }, 'first', 'next', true);
        busy(() => b.acquire(3333, START, 'second'));
        assert.strictEqual(earlier.pending, false, 'the earlier handle no longer acts on the port');
        earlier.release();
        busy(() => b.acquire(3333, START, 'second'));
        assert.deepStrictEqual(a.pending().map((start) => [start.group, start.label, start.ports, start.since]), [
            ['earlier', 'Arm-FVP@GDB (launch)', [3334], 1_000_000],
            ['next', 'Next launch', [3333], 1_020_000],
        ], 'the other port of the earlier batch stays as it was');

        // An older port sample cannot adopt or release the reservation taken over.
        a.observe([CLAIM], beforeTakeOver);
        assert.strictEqual(next.pending, true);

        // The new start is over (its command failed): the port goes back to the earlier start, which may still begin.
        next.release();
        busy(() => b.acquire(3333, START, 'second'));
        const back = a.pending().find((start) => start.ports.includes(3333));
        assert.deepStrictEqual([back?.label, back?.since], ['Arm-FVP@GDB (launch)', 1_000_000]);

        // Taken over once more; this one's session comes and goes, and the earlier start keeps the port all the same.
        now += 20_000;
        const again = a.acquire(3333, { ...START, configuration: 'Next launch' }, 'first', 'again', true);
        again.adopt();
        a.observe([CLAIM]);
        a.observe([]);
        busy(() => b.acquire(3333, START, 'second'));
        assert.deepStrictEqual(a.pending().find((start) => start.ports.includes(3333))?.since, 1_000_000);

        // Shutdown ends every start of this window.
        a.dispose();
        b.acquire(3333, START, 'second').release();
        b.acquire(3334, START, 'second').release();
        assert.deepStrictEqual(fs.readdirSync(directory), []);
    });

    test('another window\'s reservation is refused with what reserved it there; a record of an older window keeps the reload advice', () => {
        const a = manager(4242, () => true);
        const b = manager(process.pid, () => true);
        a.acquire(3333, START, 'eval1');
        a.acquire(4444, { what: 'run', subject: 'CMSIS \'run\' not started' }, 'eval1');
        assert.throws(() => b.acquire(3333, START, 'second'), (caught: unknown) => caught instanceof ToolError
            && caught.message.endsWith('which window \'eval1\' (pid 4242) has reserved for \'Test GDB\'. GDB would connect to that server instead of the new one, '
                + 'and debug — and halt — that target.')
            && (caught.hint ?? '').startsWith('That window keeps the port while its launch may still come up. Wait for it, or end it there once the user '
                + 'agrees: select_debug_window {pid: 4242}, then stop_debugging once its session is up, or a reload of that window if it never comes'));
        assert.throws(() => b.acquire(4444, START, 'second'), (caught: unknown) => caught instanceof ToolError
            && caught.message.includes('has reserved for \'CMSIS Run\'') && (caught.hint ?? '').includes('cmsis_action stop_run with window: \'4242\' once it runs'));
        // A window of 2.8 or older writes no `what`.
        const older = path.join(directory, 'port-5555');
        fs.mkdirSync(older);
        fs.writeFileSync(path.join(older, 'owner-0123abcd.json'), JSON.stringify({ pid: 4242, name: 'eval1', label: 'Arm-FVP@GDB (launch)' }));
        assert.throws(() => b.acquire(5555, START, 'second'), (caught: unknown) => caught instanceof ToolError && (caught.hint ?? '').includes('reload that window'));
        fs.rmSync(older, { recursive: true, force: true });
    });

    test('invalid ports and malformed ownership fail closed; staging records are not left behind', () => {
        const a = manager();
        for (const port of [0, -1, 65536, 1.5, NaN]) {
            assert.throws(() => a.acquire(port, START, 'a'), /Invalid GDB port/);
        }
        const claimed = path.join(directory, 'port-3333');
        fs.mkdirSync(claimed);
        fs.writeFileSync(path.join(claimed, 'owner-dead.json'), '{}');
        assert.throws(() => a.acquire(3333, START, 'a'), /invalid owner record/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['port-3333']);
    });

    test('an unsafe reservation directory is not followed', function () {
        if (process.platform === 'win32') {
            this.skip();
        }
        const linked = path.join(directory, 'link');
        fs.symlinkSync(directory, linked, 'dir');
        const a = new GdbPortReservations(linked);
        assert.throws(() => a.acquire(3333, START, 'a'), /symbolic link/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['link']);
        const throughParent = new GdbPortReservations(path.join(linked, 'reservations'), process.pid, undefined, linked);
        assert.throws(() => throughParent.acquire(3333, START, 'a'), /symbolic link/);
        assert.deepStrictEqual(fs.readdirSync(directory), ['link'], 'a refused registry root cannot be bypassed by creating a child');
    });

    test('two synchronized independent processes cannot both preflight and start a server', async function () {
        this.timeout(15_000);
        const port = await freePort();
        const program = `
            require(${JSON.stringify(path.resolve(__dirname, '../../../test/transport/vscode-stub.js'))});
            const { GdbPortReservations } = require(${JSON.stringify(require.resolve('../core/gdbPortReservations'))});
            const { findGdbPortHolder } = require(${JSON.stringify(require.resolve('../core/gdbPortGuard'))});
            const net = require('node:net');
            const manager = new GdbPortReservations(${JSON.stringify(directory)});
            let lease, server;
            let preflights = 0;
            process.on('message', async command => {
                try {
                    if (command === 'acquire') {
                        lease = manager.acquire(${port}, ${JSON.stringify(START)}, 'controller-' + process.pid);
                        preflights++;
                        if (await findGdbPortHolder(${port}, [])) throw new Error('Port is already listening');
                        process.send({ state: 'reserved', preflights });
                    } else if (command === 'listen') {
                        if (!lease) throw new Error('No reservation');
                        server = net.createServer();
                        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(${port}, '127.0.0.1', resolve); });
                        process.send({ state: 'listening' });
                    } else if (command === 'release') {
                        if (server) await new Promise(resolve => server.close(resolve));
                        manager.dispose();
                        process.send({ state: 'released' });
                    }
                } catch (error) {
                    process.send({ state: 'refused', code: error.code, message: error.message, preflights });
                }
            });
            process.send({ state: 'ready' });
        `;
        const children = [0, 1].map(() => spawn(process.execPath, ['-e', program], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }));
        try {
            await Promise.all(children.map((child) => message(child)));
            const replies = await Promise.all(children.map((child) => message(child, 'acquire')));
            assert.strictEqual(replies.filter((reply) => reply.state === 'reserved').length, 1, JSON.stringify(replies));
            const winner = replies.findIndex((reply) => reply.state === 'reserved');
            const loser = 1 - winner;
            assert.strictEqual(replies[loser].code, 'PROBE_BUSY');
            assert.strictEqual(replies[loser].preflights, 0, 'the losing process is refused before probing or connecting');
            assert.strictEqual((await message(children[winner], 'listen')).state, 'listening');
            assert.strictEqual((await message(children[loser], 'acquire')).code, 'PROBE_BUSY');
            assert.strictEqual((await message(children[winner], 'release')).state, 'released');
            assert.strictEqual((await message(children[loser], 'acquire')).state, 'reserved');
            await message(children[loser], 'release');
        } finally {
            await Promise.all(children.map((child) => new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                    resolve();
                } else {
                    child.once('exit', () => resolve());
                    child.kill();
                }
            })));
        }
    });
});
