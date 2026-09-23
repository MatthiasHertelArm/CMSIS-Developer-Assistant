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
    bytesFromMiMemoryReply,
    CMSIS_DEBUGGER_TYPE,
    gdbDialectFor,
    gdbRequestRefusal,
    isMiCommand,
    miQuoted,
    miReadMemoryCommand,
    passthroughCommand,
} from '../core/gdbDialect';
import { ToolError } from '../core/toolResult';

/**
 * How raw GDB commands reach GDB per debug adapter (#56): the `>` prefix of
 * cdt-gdb-adapter, the `-exec ` prefix of MIEngine, the agent's two
 * spellings, and the MI memory result.
 */
suite('GDB dialect', () => {
    test('the CMSIS Debugger takes `>` and prints a command\'s text as output events; every other adapter takes `-exec `', () => {
        assert.deepStrictEqual(gdbDialectFor(CMSIS_DEBUGGER_TYPE), { prefix: '>', textChannel: 'output-events' });
        assert.strictEqual(CMSIS_DEBUGGER_TYPE, 'gdbtarget');
        for (const other of ['cppdbg', 'cortex-debug', 'python', undefined]) {
            assert.deepStrictEqual(gdbDialectFor(other), { prefix: '-exec ', textChannel: 'evaluate-result' }, String(other));
        }
    });

    test('an agent\'s GDB command in either spelling, and expressions that only look like one', () => {
        assert.strictEqual(passthroughCommand('-exec info registers'), 'info registers');
        assert.strictEqual(passthroughCommand('  -exec   x/8xw $sp '), 'x/8xw $sp');
        assert.strictEqual(passthroughCommand('>info registers'), 'info registers');
        assert.strictEqual(passthroughCommand(' > monitor reset halt'), 'monitor reset halt');
        assert.strictEqual(passthroughCommand('>-data-read-memory-bytes 0x20000000 4'), '-data-read-memory-bytes 0x20000000 4');
        assert.strictEqual(passthroughCommand('-exec'), '');
        assert.strictEqual(passthroughCommand('-execCount'), undefined, 'the negation of a variable is an expression');
        assert.strictEqual(passthroughCommand('-exec_count + 1'), undefined);
        assert.strictEqual(passthroughCommand('counter > 3'), undefined);
        assert.strictEqual(passthroughCommand('$pc'), undefined);
    });

    test('an MI command starts with a dash', () => {
        assert.ok(isMiCommand('-data-read-memory-bytes 0x0 4'));
        assert.ok(isMiCommand('  -break-list'));
        assert.ok(!isMiCommand('info breakpoints'));
    });

    test('a refused run-control request: TARGET_RUNNING with the pause hint, else INTERNAL with GDB\'s text', () => {
        const running = gdbRequestRefusal('next', 'Cannot execute this command while the target is running.\nUse the "interrupt" command to stop the target\nand then try again.');
        assert.ok(running instanceof ToolError);
        assert.strictEqual(running.code, 'TARGET_RUNNING');
        assert.strictEqual(running.message, 'GDB rejected \'next\': the target is running.');
        assert.strictEqual(running.hint, 'pause_execution first, or wait_for_stop if a stop is expected.');
        const other = gdbRequestRefusal('stepIn', 'Thread 2 does not exist');
        assert.strictEqual(other.code, 'INTERNAL');
        assert.strictEqual(other.message, 'GDB rejected \'stepIn\': Thread 2 does not exist');
        assert.strictEqual(other.hint, undefined);
        assert.strictEqual(gdbRequestRefusal('pause', '  ').message, 'GDB rejected \'pause\': no reason given');
    });

    test('the memory read comes back as MI JSON; only a block that starts at the address counts', () => {
        assert.strictEqual(miReadMemoryCommand('0x20000000', 4), '-data-read-memory-bytes 0x20000000 4');
        const reply = JSON.stringify({
            memory: [{ begin: '0x20000000', offset: '0x00000000', end: '0x20000004', contents: '2a000000' }],
            'cdt-token': '12', 'cdt-command': '-data-read-memory-bytes 0x20000000 4',
        });
        assert.deepStrictEqual([...bytesFromMiMemoryReply(reply, '0x20000000') ?? []], [0x2a, 0, 0, 0]);
        const lower = JSON.stringify({ memory: [{ begin: '0xe000ed2c', offset: '0x00000000', contents: '00000040' }] });
        assert.deepStrictEqual([...bytesFromMiMemoryReply(lower, '0xE000ED2C') ?? []], [0, 0, 0, 0x40], 'the address is compared as a number');
        assert.strictEqual(bytesFromMiMemoryReply(reply, '0x20000004'), undefined, 'a block elsewhere');
        const offset = JSON.stringify({ memory: [{ begin: '0x20000000', offset: '0x4', contents: 'ff00ff00' }] });
        assert.deepStrictEqual([...bytesFromMiMemoryReply(offset, '0x20000004') ?? []], [0xff, 0, 0xff, 0]);
        for (const junk of ['\r', 'Error: could not evaluate expression', '{}', JSON.stringify({ memory: [] }),
            JSON.stringify({ memory: [{ begin: '0x0', contents: 'xyz' }] }), JSON.stringify({ memory: [{ begin: 'nope', contents: '00' }] })]) {
            assert.strictEqual(bytesFromMiMemoryReply(junk, '0x0'), undefined, junk);
        }
    });

    test('an MI c-string argument is quoted with backslashes and quotes escaped', () => {
        assert.strictEqual(miQuoted('src/main.c:12'), '"src/main.c:12"');
        assert.strictEqual(miQuoted('a + b'), '"a + b"');
        assert.strictEqual(miQuoted('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
    });
});
