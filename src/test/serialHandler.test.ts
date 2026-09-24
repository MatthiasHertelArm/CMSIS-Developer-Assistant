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
import { CAPTURE_HALF_BYTES, CaptureRecord, captureDurationMs, untilPattern } from '../core/serialCapture';
import { PORT_HELD_HINT, SerialController } from '../core/serialController';
import { SerialMonitorBridge } from '../core/serialMonitorBridge';
import { ToolError, ToolReply, ToolText, textOf } from '../core/toolResult';
import { SerialHandler } from '../serialHandler';
import { FakeSerialMonitor, ManualTime, MockSerial, PATH_FIXTURES, ScriptedPort, fakeSerialMonitor, mockSerial } from './serialFixtures';

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

/** The reply of a capture, which always carries a status. */
function asReply(result: ToolText): ToolReply {
    assert.ok(typeof result !== 'string', `a capture answers with a reply, not: ${textOf(result)}`);
    return result;
}

/**
 * `serial_capture` (#49): one call opens the port, reads until a match or the
 * deadline, and closes it again in every case — a match, the deadline, a read
 * that throws, a port that goes away — and refuses before touching a port
 * when the regex is invalid or the slot is taken. Mock ports that echo what
 * is written stand in for the board.
 */
suite('serial_capture (#49)', () => {
    setup(() => SerialPortMock.binding.reset());
    teardown(() => SerialPortMock.binding.reset());

    /** A handler over mock ports whose device echoes what is written, like a board's shell. */
    function echoing(path: string): { serial: MockSerial; handler: SerialHandler } {
        SerialPortMock.binding.createPort(path, { echo: true });
        const serial = mockSerial();
        return { serial, handler: new SerialHandler(serial.controller, { idleCloseSeconds: () => 300 }) };
    }

    test('it stops at the first match of until and closes the port, for every path spelling', async () => {
        for (const path of PATH_FIXTURES) {
            const { serial, handler } = echoing(path);
            const reply = asReply(await asSession(SESSION_A, () =>
                handler.handleCapture({ path, write: 'version\nREADY\n', until: 'READY', durationMs: 10_000 })));
            assert.strictEqual(reply.status, 'ok', path);
            assert.match(reply.text, new RegExp(`^Captured 14 B from ${path.replace(/[\\.]/g, '\\$&')} in \\d+\\.\\d s after writing 14 B \\(matched /READY/\\)\\. Port closed\\.\\n--- text ---\\nversion\\nREADY\\n$`));
            assert.deepStrictEqual({ ...reply.data, elapsedMs: 0 },
                { path, bytes: 14, elapsedMs: 0, stop: 'match', omittedBytes: 0, written: 14 });
            assert.ok((reply.data?.elapsedMs as number) < 5_000, 'stopped at the match, not at the deadline');
            const status = serial.controller.status();
            assert.deepStrictEqual([status.open, status.lastRelease, status.bufferedBytes], [false, null, 0], `${path} is free again`);
        }
    });

    test('without a match it stops at the deadline: ok without until, timeout with it', async () => {
        const { serial, handler } = echoing('COM7');
        const quiet = asReply(await handler.handleCapture({ path: 'COM7', durationMs: 150 }));
        assert.strictEqual(quiet.status, 'ok');
        assert.match(quiet.text, /^Captured 0 B from COM7 in 0\.\d s \(deadline\)\. Port closed\.\nNothing arrived\. Check baudRate; /);
        const missed = asReply(await handler.handleCapture({ path: 'COM7', durationMs: 150, until: '/ready/i', write: 'boot\n' }));
        assert.strictEqual(missed.status, 'timeout');
        assert.match(missed.text, /^Captured 5 B from COM7 in 0\.\d s after writing 5 B \(deadline; \/ready\/i not seen\)\. Port closed\.\n--- text ---\nboot\n$/);
        assert.ok(!serial.controller.isOpen());
    });

    test('a read that throws still closes the port', async () => {
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        const serial = mockSerial();
        class FailingRead extends SerialController {
            override read(): Promise<Buffer> {
                return Promise.reject(new Error('EIO: read failed'));
            }
        }
        const failing = new FailingRead({
            createPort: (options) => new SerialPortMock(options), clock: () => serial.time.date(), timers: serial.time, journal: () => undefined,
        });
        const handler = new SerialHandler(failing, { idleCloseSeconds: () => 300 });
        await assert.rejects(handler.handleCapture({ path: '/dev/ttyACM0', durationMs: 1_000 }), /EIO: read failed/);
        assert.strictEqual(failing.isOpen(), false);
        assert.strictEqual(failing.hold(), undefined);
    });

    test('an invalid until is INVALID_ARGUMENT before any port is touched', async () => {
        const { serial, handler } = echoing('COM7');
        await assert.rejects(handler.handleCapture({ path: 'COM7', until: '(unclosed', durationMs: 1_000 }), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'INVALID_ARGUMENT' && /^until is not a valid regular expression: /.test(failure.message));
        assert.deepStrictEqual(serial.ports, [], 'no port was even created: opening it could reset the board through DTR');
    });

    test('a port the window holds already is PORT_HELD, and that port is left alone', async () => {
        const { serial, handler } = echoing('COM7');
        SerialPortMock.binding.createPort('COM8');
        await asSession(SESSION_A, () => handler.handleOpen({ path: 'COM7' }));
        await assert.rejects(asSession(SESSION_B, () => handler.handleCapture({ path: 'COM8', durationMs: 1_000 })), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_HELD'
                && failure.message === 'COM7 is open in this window (held by another MCP session (aaaaaaaa)), so serial_capture cannot take the port.'
                && failure.hint === 'serial_read {waitMs} reads the open port; serial_close it to use serial_capture.');
        assert.strictEqual(serial.controller.hold()?.path, 'COM7');
        assert.strictEqual(serial.ports.length, 1);
    });

    test('a port another program holds is PORT_HELD, and nothing stays open', async () => {
        const controller = new SerialController({ createPort: () => new ScriptedPort('Opening COM7: Access denied'), journal: () => undefined });
        const handler = new SerialHandler(controller, { idleCloseSeconds: () => 300 });
        await assert.rejects(handler.handleCapture({ path: 'COM7', durationMs: 1_000 }), (failure: unknown) =>
            failure instanceof ToolError && failure.code === 'PORT_HELD' && failure.hint === PORT_HELD_HINT);
        assert.strictEqual(controller.isOpen(), false);
    });

    test('serial_status shows the capture while it runs; an unplug ends it with the reason', async () => {
        const { serial, handler } = echoing('COM7');
        const capture = asSession(SESSION_A, () => handler.handleCapture({ path: 'COM7', durationMs: 10_000 }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const status = await asSession(SESSION_A, () => handler.handleStatus());
        assert.match(status.split('\n')[0], /^Owned serial: OPEN on COM7 @ 115200 baud, .*; held by this session, serial_capture running$/);
        serial.ports[0].port?.emitData(Buffer.from('partial'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        serial.ports[0]._disconnected(new Error('EIO: i/o error, read'));
        const reply = asReply(await capture);
        assert.strictEqual(reply.status, 'ok');
        assert.match(reply.text, /^Captured 7 B from COM7 in \d+\.\d s \(COM7 disconnected at 10:42:07\)\. Port closed\.\n--- text ---\npartial$/);
        assert.ok((reply.data?.elapsedMs as number) < 5_000);
        assert.strictEqual(reply.data?.stop, 'closed');
    });

    test('the answer keeps the first and the last 8 kB and counts the bytes between', async () => {
        const { handler } = echoing('COM7');
        const body = `BEGIN${'x'.repeat(40_000)}END`;
        const reply = asReply(await handler.handleCapture({ path: 'COM7', write: body, until: 'END$', durationMs: 20_000 }));
        const [first, marker, head, omitted, tail] = reply.text.split('\n');
        assert.match(first, /^Captured 40008 B from COM7 .* \(matched \/END\$\/\)\. Port closed\. Showing the first and the last 8 kB\.$/);
        assert.strictEqual(marker, '--- text ---');
        assert.ok(head.startsWith('BEGIN') && head.length === CAPTURE_HALF_BYTES);
        assert.strictEqual(omitted, `… ${40_008 - 2 * CAPTURE_HALF_BYTES} bytes omitted …`);
        assert.ok(tail.endsWith('END') && tail.length === CAPTURE_HALF_BYTES);
        assert.ok(Buffer.byteLength(reply.text) < 17_000, `${Buffer.byteLength(reply.text)} bytes`);
        assert.strictEqual(reply.data?.omittedBytes, 40_008 - 2 * CAPTURE_HALF_BYTES);
    });

    suite('the capture record', () => {
        test('the cut never splits a character', () => {
            const record = new CaptureRecord();
            const euro = '€';   // three bytes in UTF-8
            record.append(Buffer.from(euro.repeat(10_000)));
            const excerpt = record.excerpt();
            assert.ok(!excerpt.head.includes('\uFFFD') && !(excerpt.tail ?? '').includes('\uFFFD'));
            assert.strictEqual(Buffer.byteLength(excerpt.head) + excerpt.omitted + Buffer.byteLength(excerpt.tail ?? ''), 30_000);
        });

        test('a match is looked for in the newest bytes and the 8 kB before them, however long the capture', () => {
            const record = new CaptureRecord();
            record.append(Buffer.from('MARK'));
            record.append(Buffer.from('y'.repeat(20_000)));
            assert.ok(record.searchText(20_000).includes('MARK'), 'the 8 kB before the new bytes reach back to it');
            assert.ok(!record.searchText(10).includes('MARK'), 'the window behind a small chunk does not');
            record.append(Buffer.from('z'.repeat(2 * 1024 * 1024)));
            assert.strictEqual(record.bytes, 4 + 20_000 + 2 * 1024 * 1024);
            const excerpt = record.excerpt();
            assert.ok(excerpt.head.startsWith('MARK') && (excerpt.tail ?? '').endsWith('z'));
            assert.strictEqual(record.searchText(10).length, 8 * 1024 + 10);
        });

        test('until: a plain pattern or /source/flags; g and y are dropped; the length is kept in range', () => {
            assert.strictEqual(untilPattern(undefined), undefined);
            assert.strictEqual(untilPattern(''), undefined);
            assert.strictEqual(String(untilPattern('READY')), '/READY/');
            assert.strictEqual(String(untilPattern('/boot (ok|done)/gi')), '/boot (ok|done)/i');
            assert.deepStrictEqual([50, 100, 3_000.4, 60_000, 90_000, Number.NaN, undefined].map(captureDurationMs),
                [100, 100, 3_000, 60_000, 60_000, 100, 100]);
        });
    });
});
