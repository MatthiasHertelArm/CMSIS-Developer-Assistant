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
import { EventEmitter } from 'events';
import { SerialPortMock } from 'serialport';
import type { ProblemInput } from '../core/problemJournal';
import { OwnedPort, PortOptions, SerialController, describeRelease, serialController } from '../core/serialController';
import { SerialHandler } from '../serialHandler';

/** Inject a fake port into the singleton (it has no port factory to swap). */
function injectPort(close: (cb: (err?: Error | null) => void) => void): void {
    const c = serialController as unknown as { port: unknown; openedAt: Date | null; currentPath: string | null; currentBaud: number | null };
    c.port = { isOpen: true, close };
    c.openedAt = new Date();
    c.currentPath = '/dev/tty.fake';
    c.currentBaud = 115200;
}

suite('serialController close', () => {
    test('a port whose close fails (adapter unplugged) is forgotten, so the next open works', async () => {
        injectPort(cb => cb(new Error('EIO: device gone')));
        assert.ok(serialController.isOpen());
        await assert.rejects(() => serialController.close(), /EIO/);
        assert.strictEqual(serialController.isOpen(), false);
        const status = serialController.status();
        assert.strictEqual(status.open, false);
        assert.strictEqual(status.path, null);
        assert.strictEqual(status.baudRate, null);
        assert.strictEqual(status.openedAt, null);
    });

    test('a port that closes cleanly ends in the same state', async () => {
        injectPort(cb => cb(null));
        await serialController.close();
        assert.strictEqual(serialController.isOpen(), false);
        assert.strictEqual(serialController.status().path, null);
        await serialController.close(); // idempotent
    });
});

/** A port that does what the test says; for the states the mock binding cannot reach. */
class ScriptedPort extends EventEmitter implements OwnedPort {
    isOpen = false;
    open(callback: (err: Error | null) => void): void {
        this.isOpen = true;
        callback(null);
    }
    close(callback: (err: Error | null) => void): void {
        this.isOpen = false;
        callback(null);
    }
    write(_data: Buffer, callback: (err: Error | null | undefined) => void): boolean {
        callback(null);
        return true;
    }
    drain(callback: (err: Error | null) => void): void {
        callback(null);
    }
}

/**
 * The owned port's state follows the port (#49, WP-F): an unplugged adapter
 * or a port that closed by itself is forgotten, its bytes stay readable, and
 * the serial tools say why the port is closed. Driven through serialport's
 * own `SerialPortMock`, whose `_disconnected` is what a failed read calls.
 */
suite('serialController follows the port (#49)', () => {
    /** 10:42:07 local time, so the rendered clock is the same everywhere. */
    const AT = new Date(2026, 8, 23, 10, 42, 7);
    let created: SerialPortMock[];

    setup(() => {
        SerialPortMock.binding.reset();
        created = [];
    });

    teardown(() => {
        SerialPortMock.binding.reset();
    });

    function mockController(): SerialController {
        return new SerialController({
            createPort: (options: PortOptions) => {
                const port = new SerialPortMock(options);
                created.push(port);
                return port;
            },
            clock: () => AT,
        });
    }

    /** Unplug the adapter behind `port` the way serialport sees it, and wait for its 'close'. */
    async function unplug(port: SerialPortMock): Promise<void> {
        const closed = new Promise<void>((resolve) => port.once('close', () => resolve()));
        port._disconnected(new Error('EIO: i/o error, read'));
        await closed;
    }

    test('an unplugged port is forgotten, its bytes stay readable, and the reason is kept', async () => {
        const controller = mockController();
        SerialPortMock.binding.createPort('/dev/ttyACM0');
        await controller.open({ path: '/dev/ttyACM0', baudRate: 921600 });
        created[0].port?.emitData(Buffer.from('boot ok\n'));
        assert.strictEqual((await controller.read({ waitMs: 2000, consume: false })).toString(), 'boot ok\n');

        await unplug(created[0]);
        const status = controller.status();
        assert.deepStrictEqual(
            [status.open, status.path, status.baudRate, status.openedAt, status.bufferedBytes],
            [false, null, null, null, 8]);
        assert.deepStrictEqual(status.lastRelease, { path: '/dev/ttyACM0', at: AT, reason: 'disconnected' });
        assert.strictEqual(describeRelease(status.lastRelease), '/dev/ttyACM0 disconnected at 10:42:07');
        await assert.rejects(controller.write('ping'), (failure: Error) =>
            failure.message === 'No serial port open: /dev/ttyACM0 disconnected at 10:42:07. Reopen it with serial_open.');
        assert.strictEqual((await controller.read()).toString(), 'boot ok\n', 'the bytes received before stay readable');

        await controller.open({ path: '/dev/ttyACM0' });
        assert.ok(controller.isOpen(), 'the same path opens again');
        assert.strictEqual(controller.status().lastRelease, null, 'a new open clears the reason');
        await controller.close();
    });

    test('a late close of a port that was replaced leaves the new one alone, and serial_close records no release', async () => {
        const controller = mockController();
        SerialPortMock.binding.createPort('COM7');
        SerialPortMock.binding.createPort('COM8');
        await controller.open({ path: 'COM7' });
        await controller.close();
        assert.strictEqual(controller.status().lastRelease, null, 'closing on purpose is not a release');
        await controller.open({ path: 'COM8' });

        created[0].emit('close', Object.assign(new Error('Port is not open'), { disconnected: true }));
        created[0].emit('error', new Error('late'));
        const status = controller.status();
        assert.deepStrictEqual([status.open, status.path, status.lastRelease], [true, 'COM8', null]);
        await controller.close();
    });

    test('an error while the port is open is only logged; one after it closed releases it with the message', async () => {
        const port = new ScriptedPort();
        const controller = new SerialController({ createPort: () => port, clock: () => AT });
        await controller.open({ path: 'COM9' });
        port.emit('error', new Error('framing error'));
        assert.ok(controller.isOpen());

        port.isOpen = false;
        port.emit('error', new Error('EIO: write failed'));
        const released = controller.status().lastRelease;
        assert.ok(released);
        assert.strictEqual(describeRelease(released), 'COM9 closed unexpectedly at 10:42:07 (EIO: write failed)');
        assert.strictEqual(controller.status().path, null);
    });

    test('the serial tools name the reason instead of "no port open"', async () => {
        const controller = mockController();
        const handler = new SerialHandler(controller);
        SerialPortMock.binding.createPort('COM7');
        assert.strictEqual(await handler.handleRead({}), 'Serial RX (owned): <no data>', 'never opened: as before');
        await controller.open({ path: 'COM7' });
        created[0].port?.emitData(Buffer.from('hello'));
        await controller.read({ waitMs: 2000, consume: false });
        await unplug(created[0]);

        const status = await handler.handleStatus();
        assert.ok(status.startsWith('Owned serial: closed (COM7 disconnected at 10:42:07), 5 byte(s) still buffered\n'), status);
        assert.strictEqual(await handler.handleRead({}),
            'Serial RX (owned): 5 byte(s)\nThe owned port is closed: COM7 disconnected at 10:42:07. Reopen it with serial_open.\n--- text ---\nhello');
        assert.strictEqual(await handler.handleRead({}),
            'Serial RX (owned): <no data>\nThe owned port is closed: COM7 disconnected at 10:42:07. Reopen it with serial_open.');
        await assert.rejects(handler.handleWrite({ data: 'x' }), /No serial port open: COM7 disconnected at 10:42:07\. Reopen it with serial_open\./);
        assert.strictEqual(await handler.handleClose(), 'No owned serial port was open (COM7 disconnected at 10:42:07).');
    });

    test('a port that cannot be opened and one that goes away are journaled as serial warnings, without payload (#48)', async () => {
        const journaled: ProblemInput[] = [];
        const controller = new SerialController({
            createPort: (options: PortOptions) => {
                const port = new SerialPortMock(options);
                created.push(port);
                return port;
            },
            clock: () => AT,
            journal: (problem) => journaled.push(problem),
        });
        await assert.rejects(controller.open({ path: '/dev/nope' }));
        SerialPortMock.binding.createPort('COM7');
        await controller.open({ path: 'COM7' });
        created[1].port?.emitData(Buffer.from('secret payload'));
        await controller.read({ waitMs: 2000, consume: false });
        await unplug(created[1]);
        await controller.open({ path: 'COM7' });
        await controller.close();

        assert.deepStrictEqual(journaled.map((problem) => [problem.source, problem.origin, problem.severity]),
            [['serial', '/dev/nope', 'warning'], ['serial', 'COM7', 'warning']]);
        assert.match(journaled[0].message, /nope/);
        assert.strictEqual(journaled[1].message, 'COM7 disconnected at 10:42:07');
        assert.ok(journaled.every((problem) => !problem.message.includes('secret') && typeof problem.hint === 'string'));
    });
});
