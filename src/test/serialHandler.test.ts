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
import { SerialPortMock } from 'serialport';
import { runInCallContext } from '../core/callContext';
import type { ProblemInput } from '../core/problemJournal';
import { SerialMonitorBridge } from '../core/serialMonitorBridge';
import { SerialHandler } from '../serialHandler';
import { FakeSerialMonitor, ManualTime, MockSerial, fakeSerialMonitor, mockSerial } from './serialFixtures';

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Run `work` as a tool call of MCP session `sessionId`, as the control server runs a forwarded op. */
function asSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    return runInCallContext({ callId: `${sessionId.slice(0, 8)}-1`, sessionId }, work);
}

/** A handler over mock ports, a hand-moved clock, a Serial Monitor with a data event, and an idle limit the test sets. */
interface World {
    serial: MockSerial;
    monitor: FakeSerialMonitor;
    bridge: SerialMonitorBridge;
    handler: SerialHandler;
    /** What the bridge journaled. */
    bridgeJournal: ProblemInput[];
    /** `serial.idleCloseSeconds` as the handler reads it at each open. */
    setIdle(seconds: number): void;
}

function world(): World {
    const time = new ManualTime();
    const serial = mockSerial(time);
    const monitor = fakeSerialMonitor();
    const bridgeJournal: ProblemInput[] = [];
    const bridge = new SerialMonitorBridge({ lookup: () => monitor.extension, timers: time, journal: (problem) => bridgeJournal.push(problem) });
    let idle = 300;
    const handler = new SerialHandler(serial.controller, { bridge, idleCloseSeconds: () => idle });
    return { serial, monitor, bridge, handler, bridgeJournal, setIdle: (seconds) => { idle = seconds; } };
}

/**
 * The serial handler under the release rules (#49): `serial_open` holds the
 * port for the calling MCP session under its `releaseOn`, the idle limit is
 * the setting at each open, `serial_status` names the holder and the rule,
 * and the end of a session releases the port and the Serial Monitor
 * subscription it held. Mock ports only.
 */
suite('SerialHandler release rules (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    test('serial_open holds the port for the calling session and says when it is released, per rule', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        const answers: string[] = [];
        for (const releaseOn of [undefined, 'debug-session-end', 'manual', 'sometime'] as const) {
            const opened = await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7', releaseOn: releaseOn as never }));
            answers.push(opened.split('. ')[1]);
            assert.strictEqual(w.serial.controller.hold()?.owner, SESSION_A);
            await w.handler.handleClose();
        }
        w.setIdle(0);
        answers.push((await w.handler.handleOpen({ path: 'COM7' })).split('. ')[1]);
        assert.strictEqual(w.serial.controller.hold()?.owner, undefined, 'a call outside any session records no holder');
        assert.deepStrictEqual(answers, [
            'It is released after 300 s without a serial call, or when this MCP session ends',
            'It is released when the debug session in this window ends, or when this MCP session ends',
            'It stays open until serial_close, also after this MCP session ends',
            'It is released after 300 s without a serial call, or when this MCP session ends',
            'It is released when this MCP session ends (the idle release is off)',
        ]);
    });

    test('the idle limit is the setting at each open, so a change needs no reload', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        w.setIdle(60);
        await w.handler.handleOpen({ path: 'COM7' });
        w.setIdle(600);
        w.serial.time.advanceSeconds(60);
        assert.strictEqual(w.serial.controller.status().lastRelease?.reason, 'idle', 'the port opened under 60 s keeps 60 s');
        await w.handler.handleOpen({ path: 'COM7' });
        w.serial.time.advanceSeconds(599);
        assert.ok(w.serial.controller.isOpen());
        w.serial.time.advanceSeconds(1);
        assert.strictEqual(w.serial.controller.status().lastRelease?.idleSeconds, 600);
    });

    test('serial_status names the holder and the rule, as the asking session sees it', async () => {
        const w = world();
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: '/dev/ttyACM0', baudRate: 921600 }));
        const clauseFor = async (sessionId: string | undefined): Promise<string> => {
            const status = sessionId ? await asSession(sessionId, () => w.handler.handleStatus()) : await w.handler.handleStatus();
            return status.split('\n')[0].replace(/^.*\); /, '');
        };
        assert.strictEqual(await clauseFor(SESSION_A), 'held by this session, released after 300 s without a serial call');
        assert.strictEqual(await clauseFor(SESSION_B), 'held by another MCP session (aaaaaaaa), released after 300 s without a serial call');
        await w.handler.handleClose();
        await w.handler.handleOpen({ path: '/dev/ttyACM0', releaseOn: 'manual' });
        assert.strictEqual(await clauseFor(SESSION_B), 'held by an unknown session, released only by serial_close');
    });

    test('the end of a session releases its port and its Serial Monitor subscription, and says so', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7' }));
        await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
        assert.ok(w.monitor.listening());

        assert.strictEqual(await w.handler.sessionEnded(SESSION_B), 'MCP session bbbbbbbb ended: it held no serial port in this window.');
        assert.ok(w.serial.controller.isOpen() && w.monitor.listening(), 'another session\'s end changes nothing');
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A),
            'MCP session aaaaaaaa ended: released COM7 and ended the Serial Monitor subscription.');
        assert.strictEqual(w.serial.controller.status().lastRelease?.reason, 'owner-gone');
        assert.ok(!w.monitor.listening());
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A), 'MCP session aaaaaaaa ended: it held no serial port in this window.');
    });

    test('a manual port outlives its session; its Serial Monitor subscription does not', async () => {
        const w = world();
        SerialPortMock.binding.createPort('COM7');
        await asSession(SESSION_A, () => w.handler.handleOpen({ path: 'COM7', releaseOn: 'manual' }));
        await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
        assert.strictEqual(await w.handler.sessionEnded(SESSION_A), 'MCP session aaaaaaaa ended: ended the Serial Monitor subscription.');
        assert.ok(w.serial.controller.isOpen());
        w.serial.time.advanceSeconds(86_400);
        assert.ok(w.serial.controller.isOpen(), 'and never goes for idleness');
    });

    suite('the Serial Monitor subscription follows the same rules', () => {
        test('after the idle limit without a serial call it ends and drops its buffer', async () => {
            const w = world();
            await asSession(SESSION_A, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('hello');
            w.serial.time.advanceSeconds(200);
            assert.match(await w.handler.handleRead({ from: 'monitor', consume: false }), /5 byte\(s\) \(peek\)/);
            w.serial.time.advanceSeconds(299);
            assert.ok(w.monitor.listening(), 'the read restarted the idle time');
            await w.handler.handleStatus();
            w.serial.time.advanceSeconds(299);
            assert.ok(w.monitor.listening(), 'so did the status');
            w.serial.time.advanceSeconds(1);
            assert.ok(!w.monitor.listening());
            assert.strictEqual(await w.handler.handleRead({ from: 'monitor' }), 'Serial RX (monitor): <no data>', 'the buffer went with it');
            assert.deepStrictEqual(w.bridgeJournal.map((problem) => [problem.source, problem.origin, problem.severity, problem.message]),
                [['serial', 'Serial Monitor', 'info', 'Serial Monitor subscription ended after 300 s without a serial call']]);
        });

        test('the end of the session that subscribed ends it; an unsubscribe keeps the buffer as before', async () => {
            const w = world();
            await asSession(SESSION_B, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('abc');
            assert.strictEqual(await w.handler.handleUnsubscribeMonitor(), 'Unsubscribed from Serial Monitor data.');
            assert.match(await w.handler.handleRead({ from: 'monitor' }), /3 byte\(s\)/);
            assert.strictEqual(w.bridge.sessionEnded(SESSION_B), false, 'nothing left to end');
            await asSession(SESSION_B, () => w.handler.handleSubscribeMonitor());
            w.monitor.emit('xyz');
            assert.strictEqual(w.bridge.sessionEnded(SESSION_B), true);
            assert.strictEqual(await w.handler.handleRead({ from: 'monitor' }), 'Serial RX (monitor): <no data>');
            assert.strictEqual(w.bridgeJournal.at(-1)?.message, 'Serial Monitor subscription ended: the MCP session that subscribed ended');
        });
    });
});
