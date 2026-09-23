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
import * as vscode from 'vscode';
import {
    awaitBreakpointsApplied,
    captureOutput,
    createSessionTracker,
    forgetGdbLogpoints,
    gdbLogpointsOf,
    getLiveSessionNames,
    rememberGdbLogpoint,
    waitForSessionEnd,
    waitForStopEvent,
} from '../utils/sessionStateTracker';

/** A session as the tracker sees it, with the tracker VS Code would give it. */
interface Tracked {
    session: vscode.DebugSession;
    tracker: vscode.DebugAdapterTracker;
    output(text: string, category?: string): void;
    event(event: string, body?: unknown): void;
}

let sessionCount = 0;
const open: Tracked[] = [];

function track(type = 'gdbtarget'): Tracked {
    const session = { id: `tracker-test-${++sessionCount}`, name: `Tracker test ${sessionCount}`, type, configuration: {} } as unknown as vscode.DebugSession;
    const tracker = createSessionTracker(session);
    const tracked: Tracked = {
        session,
        tracker,
        output: (text, category = 'stdout') => tracker.onDidSendMessage?.({ type: 'event', event: 'output', body: { category, output: text } }),
        event: (event, body = {}) => tracker.onDidSendMessage?.({ type: 'event', event, body }),
    };
    open.push(tracked);
    return tracked;
}

const delay = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/**
 * The session tracker's hooks for #13 and #56: the output a GDB command
 * prints, the adapter's answers to VS Code's `setBreakpoints`, the GDB
 * logpoints of a session, and the wait for a session's end.
 */
suite('Session state tracker', () => {
    teardown(() => {
        for (const tracked of open.splice(0)) {
            tracked.tracker.onWillStopSession?.();
        }
    });

    suite('output capture', () => {
        test('collects its session\'s stdout in order, and nothing after it stopped', () => {
            const a = track();
            const b = track();
            const capture = captureOutput(a.session);
            a.output('r0             0x2a                42\n');
            a.output('GDB banner\n', 'console');
            b.output('other session\n');
            a.output('r1             0x0                 0\n');
            assert.strictEqual(capture.stop(), 'r0             0x2a                42\nr1             0x0                 0\n');
            a.output('late\n');
            assert.strictEqual(capture.stop(), 'r0             0x2a                42\nr1             0x0                 0\n');
        });

        test('settle waits until the output has been quiet for the quiet period', async () => {
            const a = track();
            const capture = captureOutput(a.session);
            a.output('Resetting target with halt\n');
            const began = Date.now();
            const settled = capture.settle(60, 2000);
            await delay(30);
            a.output('Successfully halted device on reset\n');
            const text = await settled;
            const took = Date.now() - began;
            assert.strictEqual(text, 'Resetting target with halt\nSuccessfully halted device on reset\n');
            assert.ok(took >= 80 && took < 1000, `quiet period counted from the last output: ${took} ms`);
        });

        test('settle gives up at the cap while output keeps coming, and at once when the session ends', async () => {
            const a = track();
            const chatty = captureOutput(a.session);
            const timer = setInterval(() => a.output('.'), 10);
            const began = Date.now();
            try {
                const text = await chatty.settle(40, 150);
                const took = Date.now() - began;
                assert.ok(took >= 140 && took < 1000, `capped: ${took} ms`);
                assert.ok(text.length > 3, text);
            } finally {
                clearInterval(timer);
            }

            const b = track();
            const cut = captureOutput(b.session);
            b.output('half a line');
            const settled = cut.settle(5000, 10_000);
            const ended = Date.now();
            b.event('terminated');
            assert.strictEqual(await settled, 'half a line');
            assert.ok(Date.now() - ended < 1000);
        });

        test('a capture started before the request sees output that comes before the reply', async () => {
            const a = track();
            const capture = captureOutput(a.session);
            a.output('Dprintf 3 at 0x80002f4: file main.c, line 29.\n');
            assert.strictEqual(await capture.settle(0, 100), 'Dprintf 3 at 0x80002f4: file main.c, line 29.\n');
        });
    });

    suite('setBreakpoints answered by the adapter', () => {
        function request(t: Tracked, seq: number, sourcePath: string): void {
            t.tracker.onWillReceiveMessage?.({ type: 'request', seq, command: 'setBreakpoints', arguments: { source: { path: sourcePath }, breakpoints: [] } });
        }
        function respond(t: Tracked, requestSeq: number): void {
            t.tracker.onDidSendMessage?.({ type: 'response', request_seq: requestSeq, command: 'setBreakpoints', success: true, body: { breakpoints: [] } });
        }

        test('resolves once every file has been answered, not before', async () => {
            const a = track();
            let settled = false;
            const applied = awaitBreakpointsApplied(a.session, ['/w/main.c', '/w/led.c'], 2000).then((value) => {
                settled = true;
                return value;
            });
            request(a, 7, '/w/main.c');
            request(a, 8, '/w/led.c');
            respond(a, 7);
            await delay(10);
            assert.strictEqual(settled, false, 'led.c has not been answered');
            respond(a, 8);
            assert.strictEqual(await applied, true);
        });

        test('answers for other files and sessions do not count; the wait is bounded and ends with the session', async () => {
            const a = track();
            const b = track();
            const began = Date.now();
            const applied = awaitBreakpointsApplied(a.session, ['/w/main.c'], 120);
            request(b, 1, '/w/main.c');
            respond(b, 1);
            request(a, 2, '/w/other.c');
            respond(a, 2);
            assert.strictEqual(await applied, false);
            assert.ok(Date.now() - began >= 100);

            const ending = awaitBreakpointsApplied(a.session, ['/w/main.c'], 5000);
            a.event('terminated');
            assert.strictEqual(await ending, false);
            assert.strictEqual(await awaitBreakpointsApplied(b.session, [], 5000), true, 'nothing to wait for');
        });

        test('paths compare with forward slashes and a lower-case drive letter', async () => {
            const a = track();
            const applied = awaitBreakpointsApplied(a.session, ['C:\\w\\main.c'], 2000);
            request(a, 3, 'c:/w/main.c');
            respond(a, 3);
            assert.strictEqual(await applied, true);
        });
    });

    suite('GDB logpoints of a session', () => {
        test('remembered by number, listed in order, forgotten by number and on GDB\'s own delete', () => {
            const a = track();
            const b = track();
            rememberGdbLogpoint(a.session, { number: 5, file: '/w/main.c', line: 30, message: 'b' });
            rememberGdbLogpoint(a.session, { number: 3, file: '/w/main.c', line: 29, message: 'a', condition: 'n > 1' });
            rememberGdbLogpoint(b.session, { number: 3, file: '/w/led.c', line: 17, message: 'other' });
            assert.deepStrictEqual(gdbLogpointsOf(a.session).map((logpoint) => logpoint.number), [3, 5]);
            const copy = gdbLogpointsOf(a.session)[0];
            copy.line = 99;
            assert.strictEqual(gdbLogpointsOf(a.session)[0].line, 29, 'callers get copies');

            forgetGdbLogpoints(a.session, [5, 42]);
            assert.deepStrictEqual(gdbLogpointsOf(a.session).map((logpoint) => logpoint.number), [3]);
            a.event('breakpoint', { reason: 'changed', breakpoint: { id: 3, verified: true } });
            assert.strictEqual(gdbLogpointsOf(a.session).length, 1);
            a.event('breakpoint', { reason: 'removed', breakpoint: { id: 3, verified: false } });
            assert.deepStrictEqual(gdbLogpointsOf(a.session), []);
            assert.strictEqual(gdbLogpointsOf(b.session).length, 1, 'the other session keeps its own');
        });

        test('forgotten when the session ends, whichever way it ends', () => {
            for (const end of ['terminated', 'exited', 'stop']) {
                const a = track();
                rememberGdbLogpoint(a.session, { number: 3, file: '/w/main.c', line: 29, message: 'a' });
                if (end === 'stop') {
                    a.tracker.onWillStopSession?.();
                } else {
                    a.event(end);
                }
                assert.deepStrictEqual(gdbLogpointsOf(a.session), [], end);
            }
        });
    });

    suite('session end', () => {
        test('the wait resolves when the session ends, false when it does not, true for a session that is gone', async () => {
            const a = track();
            assert.ok(getLiveSessionNames().includes(a.session.name));
            const ending = waitForSessionEnd(a.session, 5000);
            a.tracker.onWillStopSession?.();
            assert.strictEqual(await ending, true);
            assert.ok(!getLiveSessionNames().includes(a.session.name));
            assert.strictEqual(await waitForSessionEnd(a.session, 5000), true, 'already gone');

            const b = track();
            assert.strictEqual(await waitForSessionEnd(b.session, 50), false);
        });

        test('a stop wait on a session that has ended resolves at once, until an adapter starts in it again', async () => {
            const a = track();
            a.event('terminated');
            const began = Date.now();
            assert.deepStrictEqual(await waitForStopEvent(a.session, 5000), { kind: 'ended' });
            assert.ok(Date.now() - began < 1000);
            // VS Code's restart of an adapter without a restart request reuses the session.
            const again = createSessionTracker(a.session);
            const stop = waitForStopEvent(a.session, 5000);
            again.onDidSendMessage?.({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
            assert.deepStrictEqual(await stop, { kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            again.onWillStopSession?.();
        });
    });
});
