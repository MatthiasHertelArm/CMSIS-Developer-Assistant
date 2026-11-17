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
import { CmsisJobTracker } from '../cmsisJobTracker';
import {
    commandLineMatches,
    OUTPUT_KEPT_CHARS,
    outputData,
    renderOutput,
    RESULT_CHARS,
    RESULT_LINES,
    TerminalOutput,
    terminalLines,
} from '../core/runOutput';
import { attachRunOutput, KEPT_RUNS, MATCH_WINDOW_MS, OUTPUT_SETTLE_MS, RunOutputCapture, runOutputOf, runOutputsOf } from '../runOutputCapture';
import { FakeShell, FakeTasks, FixtureTask, ManualClock, settle } from './cmsisTaskFixtures';

/**
 * The output of CMSIS Run tasks (#134): what a terminal received turned into
 * the lines a reader sees, kept within a limit and shown in a reply; and the
 * capture that pairs a terminal's command, as VS Code reports it, with the
 * CMSIS Run the tracker sees, over fake shell executions and a hand-moved
 * clock.
 */

/** What the stand-in model of a local VS Code 1.146 run printed: ANSI colour, CRLF, CR CRLF, the EOT byte. */
const FVP_OUTPUT = 'telnetterminal0: Listening for serial connection on port 5000\r\n\x1b[32mBoot\x1b[0m\r\r\nTest 1: ok\r\nTest 2: ok\r\n'
    + 'Test_result: PASS\r\n\x04\r\nInfo: Simulation is stopping. Reason: EOT received.\r\n';
const FVP_WORDS = ['FVP_Corstone_SSE-300', '-f', 'fvp_config.txt', '-a', 'out/Blinky/SSE-300-MPS3/Debug/Blinky.axf'];
/** The command line VS Code reports for that shell task. */
const FVP_COMMAND_LINE = FVP_WORDS.join(' ');

const runTask = (words: readonly string[]): FixtureTask => ({
    name: 'CMSIS Run', source: 'Workspace', definition: { type: 'shell' }, execution: { command: words[0], args: words.slice(1) },
});

suite('CMSIS Run output', () => {

    suite('terminalLines', () => {
        test('escape sequences, the EOT byte and other controls go; CRLF and CR CRLF are one break', () => {
            assert.deepStrictEqual(terminalLines(FVP_OUTPUT), [
                'telnetterminal0: Listening for serial connection on port 5000', 'Boot', 'Test 1: ok', 'Test 2: ok', 'Test_result: PASS', '',
                'Info: Simulation is stopping. Reason: EOT received.',
            ]);
        });

        test('OSC strings (a window title, shell integration), cursor moves, a line a carriage return rewrote, a last line without its break', () => {
            const raw = '\x1b]0;FVP\x07\x1b]633;C\x07\x1b[?25l\x1b[2K\x1b[1;1HProgress 10%\rProgress 100%\r\nDone\x1b(B\tok\x07\nlast';
            assert.deepStrictEqual(terminalLines(raw), ['Progress 100%', 'Done\tok', 'last']);
        });

        test('a sequence cut at the end of the data is left out, not shown half', () => {
            assert.deepStrictEqual(terminalLines('one\r\ntwo\x1b[3'), ['one', 'two3'], 'a CSI without its final byte stays visible as text');
            assert.deepStrictEqual(terminalLines('one\r\ntwo\x1b]633;E;cmd'), ['one', 'two']);
            assert.deepStrictEqual(terminalLines('one\x1b'), ['one']);
            assert.deepStrictEqual(terminalLines(''), []);
        });
    });

    suite('TerminalOutput', () => {
        test('counts what arrived, keeps the last of it, and leaves out the cut line once data was dropped', () => {
            const output = new TerminalOutput();
            output.append('');
            assert.deepStrictEqual(output.view(10, 1_000), { lines: [], totalLines: 0, receivedChars: 0, droppedChars: 0, complete: false });
            const line = `${'x'.repeat(99)}\n`;
            const count = Math.ceil((OUTPUT_KEPT_CHARS * 2) / line.length);
            for (let index = 0; index < count; index++) {
                output.append(line);
            }
            output.append('tail without a break');
            const view = output.view(3, 1_000);
            assert.strictEqual(view.receivedChars, count * line.length + 20);
            assert.strictEqual(view.droppedChars, view.receivedChars - OUTPUT_KEPT_CHARS);
            assert.strictEqual(view.totalLines, count + 1);
            assert.deepStrictEqual(view.lines.slice(-1), ['tail without a break']);
            assert.strictEqual(view.lines.length, 3);
            assert.strictEqual(view.complete, false);
            output.finish();
            assert.strictEqual(output.complete, true);
        });

        test('the view fits its line and character limits, keeps at least the last line, and clips a long one', () => {
            const output = new TerminalOutput();
            output.append(Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\r\n'));
            const shown = output.view(RESULT_LINES, RESULT_CHARS);
            assert.strictEqual(shown.lines.length, RESULT_LINES);
            assert.strictEqual(shown.lines[shown.lines.length - 1], 'line 99');
            assert.strictEqual(output.view(10, 20).lines.join('\n').length <= 20, true);
            const long = new TerminalOutput();
            long.append('y'.repeat(5_000));
            const clipped = long.view(5, 50).lines;
            assert.strictEqual(clipped.length, 1, 'one line is shown even when it alone is over the limit');
            assert.ok(clipped[0].startsWith('yyy') && clipped[0].endsWith('… (+4700 chars)'), clipped[0]);
        });
    });

    suite('the reply block', () => {
        test('which lines these are: all, the last of more, so far, or possibly incomplete; and the data', () => {
            const output = new TerminalOutput();
            output.append(FVP_OUTPUT);
            output.finish();
            assert.strictEqual(renderOutput('CMSIS Run', output.view(RESULT_LINES, RESULT_CHARS), false),
                'Output of \'CMSIS Run\' (7 lines):\ntelnetterminal0: Listening for serial connection on port 5000\nBoot\nTest 1: ok\nTest 2: ok\n'
                + 'Test_result: PASS\n\nInfo: Simulation is stopping. Reason: EOT received.');
            assert.ok(renderOutput('CMSIS Run', output.view(2, RESULT_CHARS), false).startsWith('Output of \'CMSIS Run\' (the last 2 of 7 lines):\n\nInfo:'));
            const live = new TerminalOutput();
            live.append('Booting\r\n');
            assert.strictEqual(renderOutput('CMSIS Run', live.view(5, 100), true), 'Output of \'CMSIS Run\' so far (1 line):\nBooting');
            assert.strictEqual(renderOutput('CMSIS Run', live.view(5, 100), false),
                'Output of \'CMSIS Run\' (1 line; VS Code reported no end of it, so the last lines may be missing):\nBooting');
            assert.strictEqual(renderOutput('CMSIS Run', new TerminalOutput().view(5, 100), true), '\'CMSIS Run\' has printed nothing yet.');
            const silent = new TerminalOutput();
            silent.finish();
            assert.strictEqual(renderOutput('CMSIS Run', silent.view(5, 100), false), '\'CMSIS Run\' printed nothing.');
            assert.deepStrictEqual(outputData('CMSIS Run', live.view(5, 100)),
                { task: 'CMSIS Run', shownLines: 1, totalLines: 1, receivedChars: 9, droppedChars: 0, complete: false });
        });

        test('dropped data is named in kB', () => {
            const output = new TerminalOutput();
            output.append(`${'z'.repeat(OUTPUT_KEPT_CHARS + 12 * 1024)}\nend\n`);
            output.finish();
            assert.strictEqual(renderOutput('CMSIS Run', output.view(1, 100), false), 'Output of \'CMSIS Run\' (the last 1 of 2 lines; the first 12 kB were not kept):\nend');
        });
    });

    suite('commandLineMatches', () => {
        test('a shell task\'s command line, quoted for its shell, and a process task\'s after VS Code\'s "Executing task:" text', () => {
            assert.ok(commandLineMatches(FVP_COMMAND_LINE, FVP_WORDS));
            assert.ok(commandLineMatches('"C:\\Arm FVP\\FVP_MPS2_Cortex-M3.exe" -f "C:\\w\\fvp config.txt"', ['C:\\Arm FVP\\FVP_MPS2_Cortex-M3.exe', '-f', 'C:\\w\\fvp config.txt']));
            assert.ok(commandLineMatches('/opt/fvp/FVP_x -f my\\ config.txt', ['/opt/fvp/FVP_x', '-f', 'my config.txt']), 'a space escaped for bash');
            assert.ok(commandLineMatches(' *  Executing task: ./FVP_Fake_Model -f fvp_config.txt ', ['./FVP_Fake_Model', '-f', 'fvp_config.txt']));
        });

        test('a VS Code variable in a word matches what VS Code resolved it to', () => {
            assert.ok(commandLineMatches('pyocd gdbserver --cbuild-run /w/out/Blinky+F401.cbuild-run.yml --quiet',
                ['pyocd', 'gdbserver', '--cbuild-run', '${command:cmsis-csolution.getCbuildRunFile}', '--quiet']));
        });

        test('another command, a longer program name or no words do not match', () => {
            assert.ok(!commandLineMatches('FVP_Corstone_SSE-300 -f other.txt', FVP_WORDS));
            assert.ok(!commandLineMatches('FVP_Corstone_SSE-300_Ethos-U55 -f fvp_config.txt', ['FVP_Corstone_SSE-300', '-f', 'fvp_config.txt']));
            assert.ok(!commandLineMatches('ls -la', ['ls']), 'a word must stand alone: "ls -la" is not "ls"');
            assert.ok(!commandLineMatches(FVP_COMMAND_LINE, []));
            assert.ok(!commandLineMatches('', FVP_WORDS));
        });
    });

    suite('RunOutputCapture', () => {
        function world(): { tasks: FakeTasks; clock: ManualClock; tracker: CmsisJobTracker; shell: FakeShell; capture: RunOutputCapture } {
            const tasks = new FakeTasks();
            const clock = new ManualClock(1_000);
            const tracker = new CmsisJobTracker(tasks, clock);
            const shell = new FakeShell();
            return { tasks, clock, tracker, shell, capture: new RunOutputCapture(tracker, shell, clock) };
        }

        test('the terminal command that starts just before its CMSIS Run is its output, to the end of its stream', async () => {
            const { tasks, tracker, shell, capture } = world();
            const command = shell.start(FVP_COMMAND_LINE);
            const run = tasks.start(tasks.execution(runTask(FVP_WORDS)));
            const key = tracker.liveExecutions()[0].key;
            command.write(FVP_OUTPUT);
            await settle();
            assert.strictEqual(capture.outputOf(key)?.view(RESULT_LINES, RESULT_CHARS).lines[4], 'Test_result: PASS');
            tasks.finish(run, 0);
            const waited = capture.whenComplete(key, 1_000);
            command.write('late line\r\n');
            command.end();
            await waited;
            const view = capture.outputOf(key)?.view(RESULT_LINES, RESULT_CHARS);
            assert.strictEqual(view?.complete, true);
            assert.strictEqual(view?.lines[view.lines.length - 1], 'late line', 'what arrives after the task\'s end is part of it');
        });

        test('the terminal command that starts just after its CMSIS Run is paired too; another command is not', async () => {
            const { tasks, clock, tracker, shell, capture } = world();
            const unrelated = shell.start('npm run watch');
            tasks.start(tasks.execution(runTask(FVP_WORDS)));
            const key = tracker.liveExecutions()[0].key;
            clock.advance(clock.now() + 150);
            const command = shell.start(FVP_COMMAND_LINE);
            command.write('Hello\r\n');
            unrelated.write('compiled\r\n');
            await settle();
            assert.deepStrictEqual(capture.outputOf(key)?.view(5, 100).lines, ['Hello']);
        });

        test('a command and a Run more than the window apart are not paired, and a Run without a command line has no terminal to read', async () => {
            const { tasks, clock, tracker, shell, capture } = world();
            shell.start(FVP_COMMAND_LINE).write('stale\r\n');
            clock.advance(clock.now() + MATCH_WINDOW_MS + 1);
            tasks.start(tasks.execution(runTask(FVP_WORDS)));
            await settle();
            assert.strictEqual(capture.outputOf(tracker.liveExecutions()[0].key), undefined);
            const managed: FixtureTask = { name: 'CMSIS Run', source: 'Workspace', definition: { type: 'cmsis-csolution.pyocd', command: 'pyocd', args: ['gdbserver'] } };
            const other = world();
            other.shell.start('pyocd gdbserver');
            other.tasks.start(other.tasks.execution(managed));
            assert.strictEqual(other.capture.outputOf(other.tracker.liveExecutions()[0].key), undefined, 'CMSIS Solution runs it in its own pseudoterminal');
        });

        test(`the output of the last ${KEPT_RUNS} Runs is kept; Load and other kinds are never read`, async () => {
            const { tasks, tracker, shell, capture } = world();
            const keys: number[] = [];
            for (let index = 0; index <= KEPT_RUNS; index++) {
                shell.start(FVP_COMMAND_LINE).write(`run ${index}\r\n`);
                const run = tasks.start(tasks.execution(runTask(FVP_WORDS)));
                keys.push(tracker.liveExecutions().find((live) => live.kind === 'run')?.key ?? -1);
                tasks.finish(run, 0);
            }
            await settle();
            assert.strictEqual(capture.outputOf(keys[0]), undefined, 'the oldest went');
            assert.deepStrictEqual(capture.outputOf(keys[KEPT_RUNS])?.view(5, 100).lines, [`run ${KEPT_RUNS}`]);
            shell.start('pyocd load --cbuild-run x.yml');
            tasks.start(tasks.execution({ name: 'CMSIS Load', source: 'Workspace', definition: { type: 'shell' }, execution: { command: 'pyocd', args: ['load', '--cbuild-run', 'x.yml'] } }));
            assert.strictEqual(capture.outputOf(tracker.liveExecutions()[0].key), undefined);
        });

        test('the tracker\'s capture is found by the tracker; a reply waits for the rest of an ended Run\'s output, at most as long as it is told', async () => {
            const tasks = new FakeTasks();
            const clock = new ManualClock(1_000);
            const tracker = new CmsisJobTracker(tasks, clock);
            const shell = new FakeShell();
            assert.strictEqual(await runOutputsOf(tracker, [], clock.now(), 0), undefined, 'a tracker without a capture has no output');
            const attached = attachRunOutput(tracker, shell, clock);
            const job = tracker.begin('run', undefined);
            const command = shell.start(FVP_COMMAND_LINE);
            const run = tasks.start(tasks.execution(runTask(FVP_WORDS)));
            command.write('partial\r\n');
            tasks.finish(run, 0);
            const settled = tracker.job(job.id) ?? job;
            assert.strictEqual(settled.state, 'ok', 'the model ended by itself with exit 0: a completed run');
            let answered = false;
            const pending = runOutputsOf(tracker, [settled], clock.now(), 5 * OUTPUT_SETTLE_MS).then((outputs) => {
                answered = true;
                return outputs;
            });
            await settle();
            assert.strictEqual(answered, false, 'the stream has not ended: the reply waits');
            clock.advance(clock.now() + OUTPUT_SETTLE_MS);
            const outputs = await pending;
            const runExecution = settled.executions.find((execution) => execution.role === 'run');
            assert.ok(runExecution);
            const output = outputs?.(runExecution);
            assert.strictEqual(output?.complete, false, 'given up after OUTPUT_SETTLE_MS, not the longer wait it was offered');
            assert.deepStrictEqual(output?.view(5, 100).lines, ['partial']);
            let again = false;
            void runOutputsOf(tracker, [settled], clock.now(), 5 * OUTPUT_SETTLE_MS).then(() => {
                again = true;
            });
            await settle();
            assert.strictEqual(again, true, 'a Run that ended more than OUTPUT_SETTLE_MS ago is not waited for again');
            command.end();
            await settle();
            assert.strictEqual(output?.complete, true, 'it completes when the stream ends after all');
            attached.dispose();
            assert.strictEqual(runOutputOf(tracker), undefined);
            assert.strictEqual(shell.listenerCount(), 0, 'dispose drops the subscription');
        });
    });
});
