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
import { BusyTable, LagMonitor, NoticeGate, secondsText } from '../core/windowHealth';

/**
 * What a window knows about its own health (#14): the busy table, the
 * event-loop lag, the notice gate and the seconds in messages.
 */
suite('Window health', () => {

    test('the busy table keeps each run until it ends, fenced or not, oldest first, with a ticket of its own', () => {
        let now = 1_000;
        const busy = new BusyTable(() => now);
        const first = busy.begin('handleCmsisCommand', 'abcd1234-1');
        now = 2_000;
        const second = busy.begin('handleCmsisCommand');
        assert.notStrictEqual(first.ticket, second.ticket);
        assert.deepStrictEqual(busy.list().map((run) => [run.op, run.startedAt, run.fenced]),
            [['handleCmsisCommand', 1_000, false], ['handleCmsisCommand', 2_000, false]]);
        assert.strictEqual(first.callId, 'abcd1234-1');
        now = 5_000;
        busy.fence(first);
        assert.deepStrictEqual([first.fenced, first.fencedAt], [true, 5_000]);
        assert.strictEqual(busy.list().length, 2, 'a fenced run stays until it settles');
        busy.end(first);
        busy.end(first);
        assert.deepStrictEqual(busy.list(), [second]);
    });

    test('the notice gate lets one notice per key through in its window', () => {
        const gate = new NoticeGate(600_000);
        assert.strictEqual(gate.allow('start_debugging', 0), true);
        assert.strictEqual(gate.allow('start_debugging', 599_999), false);
        assert.strictEqual(gate.allow('stop_debugging', 1), true, 'every key has its own window');
        assert.strictEqual(gate.allow('start_debugging', 600_000), true);
        assert.strictEqual(gate.allow('start_debugging', 600_001), false, 'the window counts from the notice that passed');
    });

    test('seconds in messages: one decimal below 10 s, whole seconds above', () => {
        assert.deepStrictEqual([0, 350, 2_000, 9_940, 10_000, 190_000, 194_600, -5].map(secondsText),
            ['0 s', '0.4 s', '2 s', '9.9 s', '10 s', '190 s', '195 s', '0 s']);
    });

    test('the lag monitor reports a blocked event loop, and starts over on reset', async () => {
        const lag = new LagMonitor();
        try {
            await new Promise((wake) => setTimeout(wake, 60));
            const blockedUntil = Date.now() + 250;
            while (Date.now() < blockedUntil) {
                // The event loop is blocked, as by a synchronous call in the extension host.
            }
            await new Promise((wake) => setTimeout(wake, 60));
            const figures = lag.read();
            assert.ok(figures.max >= 150, `max ${figures.max} ms after a 250 ms block`);
            assert.ok(figures.p99 <= figures.max);
            lag.reset();
            assert.deepStrictEqual(lag.read(), { p99: 0, max: 0 });
        } finally {
            lag.dispose();
        }
    });
});
