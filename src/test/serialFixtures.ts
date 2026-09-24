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

/**
 * What the serial suites share (#49): a clock and timers moved by hand, a
 * port that fails or answers as a test says, a Serial Monitor that has a
 * data event, and the device paths of every platform. Only mock ports:
 * serialport's `SerialPortMock` over its `MockBinding`, never a device.
 */

import { EventEmitter } from 'events';
import { SerialPortMock } from 'serialport';
import type { ProblemInput } from '../core/problemJournal';
import { OwnedPort, PortOptions, SerialController } from '../core/serialController';
import type { LeaseTimers } from '../core/serialLease';
import type { BridgeExtension } from '../core/serialMonitorBridge';

/** Device paths as each platform spells them. */
export const PATH_FIXTURES = ['COM7', '\\\\.\\COM12', '/dev/cu.usbmodem1102', '/dev/tty.usbmodem1102', '/dev/ttyACM0'];

/** 10:42:07 local time, so rendered clock times are the same everywhere. */
export const T0 = new Date(2026, 8, 23, 10, 42, 7).getTime();

/** A clock that stands still until `advance`, which fires the timers that fall due, in order. */
export class ManualTime implements LeaseTimers {
    private at = T0;
    private pending: Array<{ due: number; fire: () => void; live: boolean }> = [];

    now(): number {
        return this.at;
    }

    date(): Date {
        return new Date(this.at);
    }

    after(ms: number, fire: () => void): () => void {
        const timer = { due: this.at + ms, fire, live: true };
        this.pending.push(timer);
        return () => { timer.live = false; };
    }

    /** Timers armed and not yet fired or cancelled. */
    armed(): number {
        return this.pending.filter((timer) => timer.live).length;
    }

    /** Move the clock by `ms` seconds' worth of milliseconds, firing each timer at its own time. */
    advance(ms: number): void {
        const until = this.at + ms;
        for (;;) {
            const next = this.pending.filter((timer) => timer.live && timer.due <= until).sort((a, b) => a.due - b.due)[0];
            if (next === undefined) {
                break;
            }
            next.live = false;
            this.at = next.due;
            next.fire();
        }
        this.at = until;
        this.pending = this.pending.filter((timer) => timer.live);
    }

    /** `advance` in seconds. */
    advanceSeconds(seconds: number): void {
        this.advance(seconds * 1000);
    }
}

/** A port that does what the test says; for the states the mock binding cannot reach. */
export class ScriptedPort extends EventEmitter implements OwnedPort {
    isOpen = false;
    written: Buffer[] = [];

    /** @param failOpen the message the open fails with, if it should fail. */
    constructor(private readonly failOpen?: string) {
        super();
    }

    open(callback: (err: Error | null) => void): void {
        if (this.failOpen !== undefined) {
            callback(new Error(this.failOpen));
            return;
        }
        this.isOpen = true;
        callback(null);
    }

    close(callback: (err: Error | null) => void): void {
        this.isOpen = false;
        callback(null);
    }

    write(data: Buffer, callback: (err: Error | null | undefined) => void): boolean {
        this.written.push(Buffer.from(data));
        callback(null);
        return true;
    }

    drain(callback: (err: Error | null) => void): void {
        callback(null);
    }
}

/** A controller over mock ports, a hand-moved clock and a journal the test reads. */
export interface MockSerial {
    controller: SerialController;
    time: ManualTime;
    /** Every mock port the controller created, in order. */
    ports: SerialPortMock[];
    journaled: ProblemInput[];
}

/** A controller over `SerialPortMock`; the paths must exist in `SerialPortMock.binding` (`createPort`). */
export function mockSerial(time: ManualTime = new ManualTime()): MockSerial {
    const ports: SerialPortMock[] = [];
    const journaled: ProblemInput[] = [];
    const controller = new SerialController({
        createPort: (options: PortOptions) => {
            const port = new SerialPortMock(options);
            ports.push(port);
            return port;
        },
        clock: () => time.date(),
        timers: time,
        journal: (problem) => journaled.push(problem),
    });
    return { controller, time, ports, journaled };
}

/** A Serial Monitor whose API has the data event the bridge looks for. */
export interface FakeSerialMonitor {
    extension: BridgeExtension;
    /** Deliver bytes as the Serial Monitor would. */
    emit(data: string): void;
    /** True while the bridge listens. */
    listening(): boolean;
}

export function fakeSerialMonitor(): FakeSerialMonitor {
    let listener: ((event: unknown) => void) | undefined;
    const api = {
        onDidReceiveData: (callback: (event: unknown) => void) => {
            listener = callback;
            return { dispose: () => { listener = undefined; } };
        },
    };
    return {
        extension: { isActive: true, exports: api, activate: async () => api },
        emit: (data) => listener?.({ data: Buffer.from(data, 'utf8') }),
        listening: () => listener !== undefined,
    };
}
