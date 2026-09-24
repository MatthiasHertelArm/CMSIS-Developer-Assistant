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
import type { IDebuggingHandler } from '../debuggingHandler';
import { currentCallContext, runInCallContext } from '../core/callContext';
import {
    ProblemNotices,
    journalLocally,
    newErrorsNote,
    newErrorsStatusLine,
    renderProblemsBlock,
    runJournaled,
} from '../core/problemFeed';
import {
    JOURNAL_CAPACITY,
    ProblemInput,
    ProblemJournal,
    ProblemRecord,
    formatProblemLine,
    problemJournal,
    problemJson,
} from '../core/problemJournal';
import { JsonObject, Refusal, ToolError, ToolReply, ToolText, isToolReply } from '../core/toolResult';
import { PROBLEMS_REPLY_MAX_BYTES, renderProblemPage } from '../handler/problemText';

/** A clock the test moves by hand, from a fixed moment. */
function handClock(): { now: () => number; advance: (ms: number) => void } {
    let at = Date.UTC(2026, 8, 24, 10, 42, 7);
    return { now: () => at, advance: (ms) => { at += ms; } };
}

function problem(fields: Partial<ProblemInput> = {}): ProblemInput {
    return { source: 'dap', origin: 'CMSIS Debugger: pyOCD', severity: 'error', message: 'Failed to power up DAP', ...fields };
}

/** The severities of a journal's records, oldest first. */
function weights(journal: ProblemJournal): string {
    return journal.query().records.map((record) => record.severity[0]).join('');
}

suite('Problem journal', () => {
    test('a record gets a seq and a time; absent fields stay absent, the message is trimmed and capped at 300 characters', () => {
        const clock = handClock();
        const journal = new ProblemJournal(clock.now);
        const first = journal.append(problem({ message: '  Failed to power up DAP\n', hint: 'Check the power.' }));
        assert.deepStrictEqual({ ...first }, {
            seq: 1, time: '2026-09-24T10:42:07.000Z', source: 'dap', origin: 'CMSIS Debugger: pyOCD', severity: 'error',
            message: 'Failed to power up DAP', hint: 'Check the power.',
        });
        assert.ok(Object.isFrozen(first));
        const long = journal.append(problem({ message: 'x'.repeat(400) }));
        assert.strictEqual(long.message.length, 300);
        assert.ok(long.message.endsWith('…'));
        assert.strictEqual(long.seq, 2);
    });

    test(`at ${JOURNAL_CAPACITY} records the oldest info goes first, then the oldest warning, then the oldest error`, () => {
        const journal = new ProblemJournal(handClock().now);
        journal.append(problem({ message: 'the error' }));
        journal.append(problem({ severity: 'warning', message: 'the warning' }));
        for (let index = 0; index < JOURNAL_CAPACITY - 2; index++) {
            journal.append(problem({ severity: 'info', message: `chatter ${index}` }));
        }
        assert.strictEqual(journal.size, JOURNAL_CAPACITY);
        journal.append(problem({ severity: 'info', message: 'one more' }));
        const kept = journal.query().records;
        assert.strictEqual(kept.length, JOURNAL_CAPACITY);
        assert.deepStrictEqual(kept.slice(0, 3).map((record) => record.message), ['the error', 'the warning', 'chatter 1']);

        const small = new ProblemJournal(handClock().now, 3);
        small.append(problem({ severity: 'warning', message: 'w1' }));
        small.append(problem({ message: 'e1' }));
        small.append(problem({ severity: 'warning', message: 'w2' }));
        small.append(problem({ message: 'e2' }));
        assert.strictEqual(weights(small), 'ewe', 'no info: the oldest warning went');
        small.append(problem({ message: 'e3' }));
        small.append(problem({ severity: 'warning', message: 'w3' }));
        assert.deepStrictEqual(small.query().records.map((record) => record.message), ['e1', 'e2', 'e3'],
            'full of errors: a new warning is the one that goes');
        small.append(problem({ message: 'e4' }));
        assert.deepStrictEqual(small.query().records.map((record) => record.message), ['e2', 'e3', 'e4'],
            'and a new error pushes out the oldest error');
    });

    test('a repeat within 10 s is counted in its record, which takes a new seq; after 10 s it is a record of its own', () => {
        const clock = handClock();
        const journal = new ProblemJournal(clock.now);
        journal.append(problem());
        journal.append(problem({ message: 'something else' }));
        clock.advance(9_000);
        const repeat = journal.append(problem());
        assert.deepStrictEqual([repeat.seq, repeat.count, repeat.time], [3, 2, '2026-09-24T10:42:16.000Z']);
        assert.deepStrictEqual(journal.query().records.map((record) => record.seq), [2, 3], 'the repeat took no slot');
        clock.advance(10_001);
        const later = journal.append(problem());
        assert.strictEqual(later.count, undefined);
        assert.strictEqual(journal.size, 3);
        // Another origin, code or source is another problem.
        journal.append(problem({ origin: 'Other session' }));
        journal.append(problem({ code: 'DAP_POWER_UP_FAILED' }));
        assert.strictEqual(journal.size, 5);
    });

    test('the counters are the newest seq and every error appended, repeats included, and never go down', () => {
        const journal = new ProblemJournal(handClock().now, 2);
        assert.deepStrictEqual(journal.counters(), { seq: 0, errors: 0 });
        journal.append(problem());
        journal.append(problem());
        journal.append(problem({ severity: 'warning', message: 'w' }));
        journal.append(problem({ message: 'e2' }));
        journal.append(problem({ message: 'e3' }));
        assert.deepStrictEqual(journal.counters(), { seq: 5, errors: 4 });
        assert.strictEqual(journal.nextSeq, 6);
    });

    test('a query returns from sinceSeq on, the newest `limit` of them oldest first, with nextSeq and what the limit left out', () => {
        const journal = new ProblemJournal(handClock().now);
        for (let index = 1; index <= 6; index++) {
            journal.append(problem({ message: `problem ${index}` }));
        }
        const all = journal.query();
        assert.deepStrictEqual([all.records.length, all.nextSeq, all.omitted], [6, 7, 0]);
        const since = journal.query({ sinceSeq: 4 });
        assert.deepStrictEqual(since.records.map((record) => record.seq), [4, 5, 6]);
        const limited = journal.query({ sinceSeq: 2, limit: 2 });
        assert.deepStrictEqual([limited.records.map((record) => record.seq), limited.omitted], [[5, 6], 3]);
        const beyond = journal.query({ sinceSeq: 7 });
        assert.deepStrictEqual([beyond.records, beyond.nextSeq, beyond.omitted], [[], 7, 0]);
    });

    test('a query narrows by sources and by the lightest severity', () => {
        const journal = new ProblemJournal(handClock().now);
        journal.append(problem({ severity: 'info', message: 'banner' }));
        journal.append(problem({ source: 'build', severity: 'warning', message: 'unused variable' }));
        journal.append(problem({ source: 'serial', severity: 'warning', message: 'COM7 disconnected' }));
        journal.append(problem({ source: 'build', message: 'undeclared' }));
        assert.deepStrictEqual(journal.query({ minSeverity: 'warning' }).records.map((record) => record.seq), [2, 3, 4]);
        assert.deepStrictEqual(journal.query({ minSeverity: 'error' }).records.map((record) => record.seq), [4]);
        assert.deepStrictEqual(journal.query({ sources: ['build'] }).records.map((record) => record.seq), [2, 4]);
        assert.deepStrictEqual(journal.query({ sources: ['build', 'serial'], minSeverity: 'warning' }).records.map((record) => record.seq), [2, 3, 4]);
        assert.deepStrictEqual(journal.query({ sources: [] }).records.length, 4, 'an empty source list is no filter');
    });

    test('a record carries the call id of its async context, else of the only call running, else none', () => {
        const journal = new ProblemJournal(handClock().now);
        assert.strictEqual(journal.append(problem({ message: 'idle' })).toolCallId, undefined);
        const only = journal.beginCall('abcd1234-1');
        assert.strictEqual(journal.callsInFlight(), 1);
        assert.strictEqual(journal.append(problem({ message: 'by timing' })).toolCallId, 'abcd1234-1');
        const second = journal.beginCall('abcd1234-2');
        assert.strictEqual(journal.append(problem({ message: 'two running' })).toolCallId, undefined);
        const inside = runInCallContext({ callId: 'abcd1234-2' }, () => journal.append(problem({ message: 'in context' })));
        assert.strictEqual(inside.toolCallId, 'abcd1234-2');
        assert.strictEqual(journal.append(problem({ message: 'given', toolCallId: 'x-9' })).toolCallId, 'x-9');
        second.end();
        only.end();
        only.end();
        assert.strictEqual(journal.callsInFlight(), 0);
        assert.strictEqual(only.startSeq, 2);
    });

    test('listeners see every record kept; a failing listener costs neither the record nor the others', () => {
        const journal = new ProblemJournal(handClock().now);
        const seen: number[] = [];
        journal.onDidAppend(() => { throw new Error('listener bug'); });
        const subscription = journal.onDidAppend((record) => seen.push(record.seq));
        journal.append(problem());
        journal.append(problem());
        subscription.dispose();
        journal.append(problem({ message: 'unseen' }));
        assert.deepStrictEqual(seen, [1, 2]);
        assert.strictEqual(journal.size, 2);
    });

    test('one line per record: number, severity, source, code, location, message, count and next step', () => {
        const record: ProblemRecord = {
            seq: 212, time: '2026-09-24T10:42:07.000Z', source: 'build', origin: 'cbuild blinky', severity: 'error', code: 'BUILD_ERROR',
            message: '\'x\' undeclared\n  (first use in this function)', location: { file: 'src/main.c', line: 42, column: 5 },
            hint: 'Fix the source.', count: 3,
        };
        assert.strictEqual(formatProblemLine(record),
            '#212 error build [BUILD_ERROR] src/main.c:42:5: \'x\' undeclared (first use in this function) (×3) → Fix the source.');
        assert.strictEqual(formatProblemLine(record, { seq: false, origin: true, time: true }),
            '2026-09-24T10:42:07.000Z error build (cbuild blinky) [BUILD_ERROR] src/main.c:42:5: \'x\' undeclared (first use in this function) (×3) → Fix the source.');
        const bare: ProblemRecord = { seq: 1, time: '', source: 'dap', origin: '', severity: 'info', message: 'banner' };
        assert.strictEqual(formatProblemLine(bare), '#1 info dap banner');
    });

    test('as JSON a record has only the fields it has', () => {
        const journal = new ProblemJournal(handClock().now);
        const record = journal.append(problem({ location: { file: 'main.c', line: 3 }, code: 'DAP_POWER_UP_FAILED' }));
        assert.deepStrictEqual(problemJson(record), {
            seq: 1, time: '2026-09-24T10:42:07.000Z', source: 'dap', origin: 'CMSIS Debugger: pyOCD', severity: 'error',
            message: 'Failed to power up DAP', code: 'DAP_POWER_UP_FAILED', location: { file: 'main.c', line: 3 },
        });
    });

    test('the window has one journal', () => {
        assert.strictEqual(problemJournal(), problemJournal());
    });
});

suite('Problem feed', () => {
    const failing = (journal: ProblemJournal, records: ProblemInput[], failure: Error): () => Promise<ToolText> => async () => {
        for (const record of records) {
            journal.append(record);
        }
        throw failure;
    };

    test('a failed call takes along its records: warning and above, errors first, at most five, none of another call, none that restate it', async () => {
        const journal = new ProblemJournal(handClock().now);
        journal.append(problem({ message: 'before the call' }));
        const { outcome, counters } = await runJournaled(journal, { callId: 'sess0001-4' }, failing(journal, [
            problem({ severity: 'info', message: 'GDB banner' }),
            problem({ severity: 'warning', message: 'w1' }),
            problem({ severity: 'warning', message: 'w2' }),
            problem({ severity: 'warning', message: 'w3' }),
            problem({ severity: 'warning', message: 'w4' }),
            problem({ message: 'e1' }),
            problem({ message: 'e2' }),
            problem({ message: 'another call', toolCallId: 'sess0001-3' }),
            problem({ severity: 'warning', message: 'error response to \'launch\': Failed to launch the GDB server' }),
            problem({ severity: 'warning', message: 'same code', code: 'TASK_FAILED' }),
        ], new ToolError('TASK_FAILED', 'Could not start: Failed to launch the GDB server', 'Check the server.', { job: 'd-1' })));
        assert.ok(outcome instanceof ToolError);
        const data = outcome.data as JsonObject;
        const problems = data.problems as JsonObject[];
        assert.deepStrictEqual(problems.map((record) => record.message), ['w1', 'w2', 'w3', 'e1', 'e2']);
        assert.strictEqual(data.job, 'd-1', 'the failure keeps its own data');
        assert.deepStrictEqual([outcome.code, outcome.message, outcome.hint], ['TASK_FAILED', 'Could not start: Failed to launch the GDB server', 'Check the server.']);
        assert.ok(problems.every((record) => record.toolCallId === 'sess0001-4'));
        assert.deepStrictEqual(counters, journal.counters());
        assert.strictEqual(journal.callsInFlight(), 0);
    });

    test('a refusal keeps its class; a failure without records of its own stays as it was; a plain error gets its code', async () => {
        const journal = new ProblemJournal(handClock().now);
        const refused = await runJournaled(journal, undefined, failing(journal, [problem({ severity: 'warning', message: 'w' })],
            new Refusal('NO_SESSION', 'Cannot step: no session.')));
        assert.ok(refused.outcome instanceof Refusal);
        assert.strictEqual(((refused.outcome as ToolError).data?.problems as JsonObject[]).length, 1);
        const bare = new ToolError('INVALID_ARGUMENT', 'bad line');
        const quiet = await runJournaled(journal, undefined, failing(journal, [], bare));
        assert.strictEqual(quiet.outcome, bare);
        const plain = await runJournaled(journal, undefined, failing(journal, [], new Error('No active debug session.')));
        assert.strictEqual((plain.outcome as ToolError).code, 'NO_SESSION');
    });

    test('a reply whose wait ran out takes the records along in its data; a success does not', async () => {
        const journal = new ProblemJournal(handClock().now);
        const waited = await runJournaled(journal, undefined, async () => {
            journal.append(problem({ severity: 'warning', message: 'probe slow' }));
            return { text: 'did not stop', status: 'timeout', data: { waitedMs: 5 } };
        });
        const reply = waited.outcome as ToolReply;
        assert.deepStrictEqual([reply.status, reply.data?.waitedMs, (reply.data?.problems as JsonObject[])[0].message], ['timeout', 5, 'probe slow']);
        const fine = await runJournaled(journal, undefined, async () => {
            journal.append(problem({ message: 'unrelated' }));
            return 'done';
        });
        assert.strictEqual(fine.outcome, 'done');
    });

    test('the op runs in the call context the envelope named, and is registered while it runs', async () => {
        const journal = new ProblemJournal(handClock().now);
        let seen: unknown;
        let running = 0;
        await runJournaled(journal, { callId: 'abcd1234-9', sessionId: 'abcd1234-rest' }, async () => {
            seen = currentCallContext();
            running = journal.callsInFlight();
            return 'ok';
        });
        assert.deepStrictEqual(seen, { callId: 'abcd1234-9', sessionId: 'abcd1234-rest' });
        assert.strictEqual(running, 1);
        assert.strictEqual(journal.callsInFlight(), 0);
    });

    suite('what an agent is told about new errors', () => {
        const at = (seq: number, errors: number): { seq: number; errors: number } => ({ seq, errors });

        test('the first answer sets the baseline; one note per new batch, counted from the last look', () => {
            const notices = new ProblemNotices();
            assert.strictEqual(notices.observe('4711', at(10, 3), 'handleReadMemory', 'bytes'), 'bytes', 'errors before the first answer are not news');
            const noted = notices.observe('4711', at(12, 5), 'handleGetThreads', 'threads');
            assert.strictEqual(noted, `threads\n\n${newErrorsNote(2, 11)}`);
            assert.strictEqual(newErrorsNote(2, 11), 'Note: 2 new errors in this window since you last looked — get_recent_problems {sinceSeq: 11}');
            assert.strictEqual(notices.observe('4711', at(12, 5), 'handleGetThreads', 'threads'), 'threads', 'once per batch');
            const more = notices.observe('4711', at(13, 6), 'handleReadMemory', { text: 'bytes', status: 'ok' });
            assert.ok(isToolReply(more) && more.text === `bytes\n\n${newErrorsNote(3, 11)}`);
        });

        test('get_session_status carries the count line while there are new errors; get_recent_problems moves the baseline', () => {
            const notices = new ProblemNotices();
            notices.observe('4711', at(10, 3), 'handleGetSessionStatus', 'State: stopped');
            assert.strictEqual(notices.observe('4711', at(11, 4), 'handleGetSessionStatus', 'State: stopped'),
                `State: stopped\n${newErrorsStatusLine(1, 11)}`);
            assert.strictEqual(newErrorsStatusLine(1, 11), 'Problems: 1 new error since #11 — get_recent_problems {sinceSeq: 11}');
            assert.strictEqual(notices.observe('4711', at(11, 4), 'handleGetThreads', 'threads'), 'threads', 'the status line announced it');
            assert.strictEqual(notices.observe('4711', at(11, 4), 'handleGetSessionStatus', 'State: stopped'),
                `State: stopped\n${newErrorsStatusLine(1, 11)}`, 'the count stays until the agent looks');
            assert.strictEqual(notices.observe('4711', at(11, 4), 'handleGetRecentProblems', 'records'), 'records');
            assert.strictEqual(notices.observe('4711', at(11, 4), 'handleGetSessionStatus', 'State: stopped'), 'State: stopped');
        });

        test('each window has its baseline; no counters, no notes', () => {
            const notices = new ProblemNotices();
            notices.observe('1', at(1, 0), 'handleGetThreads', 'a');
            notices.observe('2', at(50, 9), 'handleGetThreads', 'b');
            assert.strictEqual(notices.observe('2', at(50, 9), 'handleGetThreads', 'b'), 'b');
            assert.ok(String(notices.observe('1', at(2, 1), 'handleGetThreads', 'a')).includes('1 new error'));
            assert.strictEqual(notices.observe('3', undefined, 'handleGetThreads', 'c'), 'c');
            assert.strictEqual(notices.observe('3', undefined, 'handleGetSessionStatus', 'c'), 'c');
        });

        test('a failure gets no note; when it shows every error not yet announced, the next success gets none either', () => {
            const notices = new ProblemNotices();
            notices.observe('1', at(4, 1), 'handleGetThreads', 'a');
            const shown = new ToolError('TASK_FAILED', 'Load failed', undefined, { problems: [{ seq: 5, severity: 'error', message: 'x' }] });
            assert.strictEqual(notices.observe('1', at(5, 2), 'handleCmsisCommand', shown), shown);
            assert.strictEqual(notices.observe('1', at(5, 2), 'handleGetThreads', 'a'), 'a');
            const unshown = new ToolError('TASK_FAILED', 'Load failed');
            notices.observe('1', at(6, 3), 'handleCmsisCommand', unshown);
            assert.ok(String(notices.observe('1', at(6, 3), 'handleGetThreads', 'a')).endsWith(newErrorsNote(2, 5)));
        });
    });

    test('the block under a result lists at most five records and skips what is not one', () => {
        const record = (seq: number): JsonObject => ({ seq, time: '', source: 'gdb-server', origin: 'pyOCD', severity: 'error', message: `line ${seq}` });
        assert.strictEqual(renderProblemsBlock([record(1), { seq: 'x' }, 7, record(2)]),
            '\nRecent problems:\n  #1 error gdb-server line 1\n  #2 error gdb-server line 2');
        assert.strictEqual(renderProblemsBlock([1, 2, 3, 4, 5, 6, 7].map(record)).split('\n').length, 7);
        assert.strictEqual(renderProblemsBlock(undefined), '');
        assert.strictEqual(renderProblemsBlock([]), '');
        assert.strictEqual(renderProblemsBlock({ seq: 1 }), '');
    });

    test('without a router every op runs through the journal with the session\'s notices', async () => {
        const journal = new ProblemJournal(handClock().now);
        const debug = {
            handleGetThreads: async () => 'threads',
            handleReadMemory: async () => {
                journal.append(problem({ message: 'Failed to power up DAP' }));
                throw new ToolError('TIMEOUT', 'read timed out');
            },
        } as unknown as IDebuggingHandler;
        const local = journalLocally({ debug, serial: async (op) => `serial ${op}` }, journal);
        assert.strictEqual(await local.debug.handleGetThreads({}), 'threads');
        await assert.rejects(local.debug.handleReadMemory({ address: '0x0', length: 4 }), (failure: unknown) =>
            failure instanceof ToolError && (failure.data?.problems as JsonObject[])[0].message === 'Failed to power up DAP');
        assert.strictEqual(await local.debug.handleGetThreads({}), 'threads', 'the failure showed the error');
        journal.append(problem({ message: 'while nobody looked' }));
        // Counted since the agent last looked (never): the error the failure showed, and this one.
        assert.strictEqual(await local.serial('handleStatus'), `serial handleStatus\n\n${newErrorsNote(2, 1)}`);
        await assert.rejects(local.debug.handleStepOver({}), /handleStepOver is not implemented/);
        assert.strictEqual(local.packDocs, undefined);
    });
});

suite('get_recent_problems reply', () => {
    test('one line per record, then nextSeq; data carries the cursor, the counts and the records', () => {
        const journal = new ProblemJournal(handClock().now);
        journal.append(problem({ code: 'DAP_POWER_UP_FAILED', source: 'gdb-server', hint: 'Check the power.' }));
        journal.append(problem({ severity: 'warning', source: 'serial', origin: 'COM7', message: 'COM7 disconnected at 10:42:07' }));
        const reply = renderProblemPage(journal.query({ minSeverity: 'warning', limit: 20 }), { minSeverity: 'warning' });
        assert.deepStrictEqual(reply, {
            text: '#1 error gdb-server [DAP_POWER_UP_FAILED] Failed to power up DAP → Check the power.\n'
                + '#2 warning serial COM7 disconnected at 10:42:07\nnextSeq=3',
            status: 'ok',
            data: {
                nextSeq: 3, returned: 2, omitted: 0,
                records: journal.query({ minSeverity: 'warning' }).records.map(problemJson),
            },
        });
        const cut = renderProblemPage(journal.query({ limit: 1 }), { minSeverity: 'info' });
        assert.ok(cut.text.startsWith('… 1 older record left out: raise limit (at most 50)'), cut.text);
        assert.deepStrictEqual(cut.data, { nextSeq: 3, returned: 1, omitted: 1, records: [problemJson(journal.query().records[1])] });
    });

    test('an empty reply says what was asked for and stays under 200 bytes', () => {
        const journal = new ProblemJournal(handClock().now);
        const empty = renderProblemPage(journal.query({ sinceSeq: 118 }), { sinceSeq: 118, minSeverity: 'warning' });
        assert.strictEqual(empty.text, 'No warnings or errors since #118 (nextSeq=1).');
        assert.ok(Buffer.byteLength(JSON.stringify(empty)) < 200);
        assert.strictEqual(renderProblemPage(journal.query(), { minSeverity: 'error', sources: ['dap', 'gdb-server'] }).text,
            'No errors from dap, gdb-server recorded in this window (nextSeq=1).');
    });

    test('a reply keeps within 8 kB: the oldest lines go and count as omitted', () => {
        const journal = new ProblemJournal(handClock().now);
        for (let index = 0; index < 50; index++) {
            journal.append(problem({ message: `${index} ${'y'.repeat(280)}`, hint: 'z'.repeat(60) }));
        }
        const reply = renderProblemPage(journal.query({ limit: 50 }), { minSeverity: 'warning' });
        assert.ok(Buffer.byteLength(reply.text) <= PROBLEMS_REPLY_MAX_BYTES, `${Buffer.byteLength(reply.text)} bytes`);
        const data = reply.data as JsonObject;
        assert.strictEqual((data.returned as number) + (data.omitted as number), 50);
        assert.ok(reply.text.includes('#50 error'), 'the newest line is kept');
        const records = data.records as JsonObject[];
        assert.strictEqual(records.length, data.returned, 'one record per line');
        assert.ok(Buffer.byteLength(JSON.stringify(records)) <= PROBLEMS_REPLY_MAX_BYTES, `${Buffer.byteLength(JSON.stringify(records))} bytes of records`);
        assert.strictEqual(records[records.length - 1].seq, 50, 'the newest record is kept');
    });
});
