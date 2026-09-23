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
import {
    breakpointTableFromMiReply,
    classifyGdbReply,
    dprintfFromMiReply,
    gdbRefusal,
    gdbSourceLocation,
    unknownBreakpointNumbers,
} from '../handler/gdbText';

/** GDB's own text, as cdt-gdb-adapter passes it on (#56). */
const RUNNING = 'Cannot execute this command while the target is running.\nUse the "interrupt" command to stop the target\nand then try again.';

/**
 * What GDB's replies to the CMSIS Debugger logpoint commands say, and where a
 * logpoint is set.
 */
suite('GDB replies for logpoints', () => {
    test('classification: done, running, rejected and failed', () => {
        assert.strictEqual(classifyGdbReply({ text: '', errored: false }), 'done');
        assert.strictEqual(classifyGdbReply({ text: 'Breakpoint 3 now unconditional.', errored: false }), 'done');
        assert.strictEqual(classifyGdbReply({ text: RUNNING, errored: true }), 'running');
        assert.strictEqual(classifyGdbReply({ text: RUNNING, errored: false }), 'running', 'GDB\'s running text is a refusal wherever it appears');
        for (const refusal of ['No source file named foo.c.', 'No line 99 in file "main.c".', 'No symbol "q" in current context.',
            'Function "nope" not defined.', 'A syntax error in expression, near `)\'.', 'Bad format string, missing \'"\'']) {
            assert.strictEqual(classifyGdbReply({ text: refusal, errored: true }), 'rejected', refusal);
        }
        assert.strictEqual(classifyGdbReply({ text: 'Remote connection closed', errored: true }), 'failed');
        assert.strictEqual(classifyGdbReply({ text: 'No symbol "q" in current context.', errored: false }), 'done',
            'text without an adapter error is output, not a refusal');
    });

    test('a refusal becomes the error of its kind', () => {
        const running = gdbRefusal('the logpoint', { text: RUNNING, errored: true });
        assert.strictEqual(running.code, 'TARGET_RUNNING');
        assert.strictEqual(running.message, 'GDB rejected the logpoint: the target is running.');
        assert.strictEqual(running.hint, 'pause_execution first, or wait_for_stop if a stop is expected.');
        const rejected = gdbRefusal('the logpoint condition', { text: 'No symbol "q" in current context.', errored: true });
        assert.strictEqual(rejected.code, 'INVALID_ARGUMENT');
        assert.strictEqual(rejected.message, 'GDB rejected the logpoint condition: No symbol "q" in current context.');
        assert.match(rejected.hint ?? '', /^Check that the line has code/);
        const failed = gdbRefusal('the delete of dprintf 3', { text: '', errored: true });
        assert.strictEqual(failed.code, 'INTERNAL');
        assert.strictEqual(failed.message, 'GDB rejected the delete of dprintf 3: no reason given');
    });

    test('the new dprintf from the -dprintf-insert result, with one or several locations', () => {
        const one = JSON.stringify({
            bkpt: { number: '3', type: 'dprintf', disp: 'keep', enabled: 'y', addr: '0x080002f4', func: 'main', file: 'main.c',
                fullname: '/w/main.c', line: '29', times: '0', 'original-location': 'main.c:29' },
            'cdt-token': '31', 'cdt-command': '-dprintf-insert "main.c:29" "tick\\n"',
        });
        assert.deepStrictEqual(dprintfFromMiReply(one), { number: 3, file: 'main.c', line: 29, address: '0x080002f4', locations: 1 });
        const several = JSON.stringify({
            bkpt: [{ number: '4', addr: '<MULTIPLE>' }, { number: '4.1', file: 'util.h', line: '7', addr: '0x08000400' }, { number: '4.2', addr: '0x08000500' }],
        });
        assert.deepStrictEqual(dprintfFromMiReply(several), { number: 4, file: 'util.h', line: 7, address: '<MULTIPLE>', locations: 2 });
        for (const junk of ['', '\r', 'Dprintf 3 at 0x80002f4: file main.c, line 29.', '{}', JSON.stringify({ bkpt: { number: 'x' } })]) {
            assert.strictEqual(dprintfFromMiReply(junk), undefined, junk);
        }
    });

    test('GDB\'s breakpoint table from the -break-list result', () => {
        const table = JSON.stringify({
            BreakpointTable: {
                nr_rows: '2', nr_cols: '6',
                body: [
                    { number: '1', type: 'breakpoint', times: '1', 'original-location': 'main' },
                    { number: '3', type: 'dprintf', times: '12', cond: 'counter % 100 == 0' },
                ],
            },
        });
        assert.deepStrictEqual(breakpointTableFromMiReply(table), [
            { number: 1, type: 'breakpoint', hits: 1, condition: undefined },
            { number: 3, type: 'dprintf', hits: 12, condition: 'counter % 100 == 0' },
        ]);
        assert.deepStrictEqual(breakpointTableFromMiReply(JSON.stringify({ BreakpointTable: { nr_rows: '0', body: [] } })), []);
        assert.strictEqual(breakpointTableFromMiReply('\r'), undefined);
        assert.strictEqual(breakpointTableFromMiReply(JSON.stringify({ bkpt: {} })), undefined);
    });

    test('the numbers `delete` did not know', () => {
        assert.deepStrictEqual(unknownBreakpointNumbers(''), []);
        assert.deepStrictEqual(unknownBreakpointNumbers('No breakpoint number 5.\nNo breakpoint number 12.\n'), [5, 12]);
    });

    test('a logpoint is set at its path relative to the workspace folder, else at its file name', () => {
        assert.strictEqual(gdbSourceLocation('/w/app/src/main.c', 12, ['/w/app']), 'src/main.c:12');
        assert.strictEqual(gdbSourceLocation('/w/app/src/main.c', 12, ['/w', '/w/app/']), 'src/main.c:12', 'the innermost folder');
        assert.strictEqual(gdbSourceLocation('/w/app/src/main.c', 12, ['/elsewhere']), 'main.c:12');
        assert.strictEqual(gdbSourceLocation('/w/application/main.c', 3, ['/w/app']), 'main.c:3', 'a folder name that is only a prefix');
        assert.strictEqual(gdbSourceLocation('C:\\w\\App\\src\\main.c', 7, ['c:\\w\\app']), 'src/main.c:7', 'Windows: any case, forward slashes');
        assert.strictEqual(gdbSourceLocation('main.c', 1, []), 'main.c:1');
    });
});
