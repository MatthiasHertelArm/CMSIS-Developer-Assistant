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
    ErrorCode,
    ToolError,
    classifyError,
    errorDetail,
    errorText,
    isErrorCode,
    isToolReply,
    textOf,
    toToolError,
    upgradeLegacyText,
    wrapError,
} from '../core/toolResult';
import { HardwareTimeoutError } from '../utils/timeout';

/**
 * The outcome vocabulary of #11: the codes plain errors are given, the
 * wrap that keeps a code, the flattening for peers that take text, and the
 * reading of what a 2.3.10 window sends.
 */
suite('Tool outcomes', () => {

    suite('classifyError', () => {
        const families: Array<[string, ErrorCode]> = [
            ['Cannot read memory: session state is \'no-session\'.', 'NO_SESSION'],
            ['No active debug session.', 'NO_SESSION'],
            ['Reading the variables failed: Error: No debug session is running in this window', 'NO_SESSION'],
            ['Cannot step over: session state is \'initializing\'.', 'NO_SESSION'],
            ['Cannot read variables: session state is \'running\'.', 'TARGET_RUNNING'],
            ['Evaluating the expression failed: Error: Cannot execute this command while the target is running.', 'TARGET_RUNNING'],
            ['Cannot get threads: session state is \'unresponsive\'.', 'TIMEOUT'],
            ['Step over failed: HardwareTimeoutError: Hardware operation \'DAP next\' timed out after 50ms.', 'TIMEOUT'],
            ['pdftotext timed out after 100 ms on /x/manual.pdf', 'TIMEOUT'],
            ['CMSIS \'detach\' failed: no active CMSIS solution.', 'CMSIS_NO_SOLUTION'],
            ['No active solution', 'CMSIS_NO_SOLUTION'],
            ['Invalid line number 0: must be a 1-based integer.', 'INVALID_ARGUMENT'],
            ['Unbalanced \'{\' in logMessage at position 2. Use {{ for a literal brace.', 'INVALID_ARGUMENT'],
            ['Empty interpolation \'{}\' in logMessage at position 2.', 'INVALID_ARGUMENT'],
            ['No location given: pass `line` (1-based line number).', 'INVALID_ARGUMENT'],
            ['Could not find any lines containing: return;', 'INVALID_ARGUMENT'],
            ['The debug adapter returned no result for this expression.', 'INTERNAL'],
            ['', 'INTERNAL'],
        ];
        for (const [message, code] of families) {
            test(`${code}: ${message || '(empty)'}`, () => {
                assert.strictEqual(classifyError(message), code);
            });
        }

        test('the first family that matches decides', () => {
            assert.strictEqual(classifyError('session state is \'no-session\' although the target is running'), 'NO_SESSION');
            assert.strictEqual(classifyError('Cannot step: session state is \'running\'; the last request timed out after 5 ms'), 'TARGET_RUNNING');
        });
    });

    suite('toToolError', () => {
        test('a ToolError passes unchanged', () => {
            const typed = new ToolError('PROBE_BUSY', 'busy', 'stop_debugging first', { owner: 'x' });
            assert.strictEqual(toToolError(typed), typed);
        });

        test('a plain Error keeps its message and gets a classified code', () => {
            const typed = toToolError(new Error('No active debug session.'));
            assert.ok(typed instanceof ToolError);
            assert.deepStrictEqual([typed.code, typed.message, typed.hint, typed.data], ['NO_SESSION', 'No active debug session.', undefined, undefined]);
        });

        test('the class name of the error takes part in the classification', () => {
            const typed = toToolError(new HardwareTimeoutError('DAP threads', 3000));
            assert.strictEqual(typed.code, 'TIMEOUT');
            assert.ok(typed.message.startsWith('Hardware operation \'DAP threads\' timed out after 3000ms.'), typed.message);
        });

        test('anything else becomes its string form, without throwing', () => {
            assert.deepStrictEqual([toToolError('plain words').code, toToolError('plain words').message], ['INTERNAL', 'plain words']);
            assert.strictEqual(toToolError(Object.create(null)).message, '[object Object]');
        });
    });

    suite('wrapError', () => {
        test('keeps the code, hint and data of a ToolError and prefixes its message', () => {
            const cause = new ToolError('TARGET_RUNNING', 'Cannot step over: session state is \'running\'.', 'Add a breakpoint.', { state: 'running' });
            const wrapped = wrapError('Step over failed', cause);
            assert.strictEqual(wrapped.code, 'TARGET_RUNNING');
            assert.strictEqual(wrapped.message, 'Step over failed: Error: Cannot step over: session state is \'running\'.');
            assert.strictEqual(wrapped.hint, 'Add a breakpoint.');
            assert.deepStrictEqual(wrapped.data, { state: 'running' });
        });

        test('reads a plain cause as String(err), as the plain re-wraps did, and classifies it', () => {
            const wrapped = wrapError('Reading the variables failed', new HardwareTimeoutError('DAP scopes', 80));
            assert.strictEqual(wrapped.code, 'TIMEOUT');
            assert.ok(wrapped.message.startsWith('Reading the variables failed: HardwareTimeoutError: Hardware operation \'DAP scopes\''), wrapped.message);
            assert.strictEqual(wrapError('Adding the breakpoint failed', new Error('add bad')).message, 'Adding the breakpoint failed: Error: add bad');
            assert.strictEqual(wrapError('Adding the breakpoint failed', new Error('add bad')).code, 'INTERNAL');
        });
    });

    suite('texts', () => {
        test('textOf flattens a reply and passes a string', () => {
            assert.strictEqual(textOf('plain'), 'plain');
            assert.strictEqual(textOf({ text: 'still running', status: 'running', data: { taskName: 'cbuild' } }), 'still running');
        });

        test('an error reads as [CODE] message, then the hint on its own line', () => {
            const withHint = new ToolError('NO_SESSION', 'Cannot read memory: session state is \'no-session\'.', 'Call start_debugging first.');
            assert.strictEqual(errorDetail(withHint), 'Cannot read memory: session state is \'no-session\'.\nCall start_debugging first.');
            assert.strictEqual(errorText(withHint), '[NO_SESSION] Cannot read memory: session state is \'no-session\'.\nCall start_debugging first.');
            assert.strictEqual(errorText(new ToolError('INTERNAL', 'x')), '[INTERNAL] x');
        });
    });

    suite('what another window sends', () => {
        test('codes and replies are validated field by field', () => {
            assert.ok(isErrorCode('AMBIGUOUS_WINDOW'));
            assert.ok(!isErrorCode('NOT_A_CODE') && !isErrorCode(undefined) && !isErrorCode(7));
            assert.ok(isToolReply({ text: 'x', status: 'timeout' }));
            assert.ok(isToolReply({ text: 'x', status: 'ok', data: { a: 1 } }));
            for (const bad of [null, 'x', { text: 'x' }, { text: 'x', status: 'error' }, { text: 1, status: 'ok' }, { text: 'x', status: 'ok', data: [1] }]) {
                assert.ok(!isToolReply(bad), JSON.stringify(bad));
            }
        });

        test('a 2.3.10 fence failure becomes a classified ToolError without the tool label', () => {
            const upgraded = upgradeLegacyText('Error in \'read_memory\': Cannot read memory: session state is \'no-session\'. '
                + 'No active debug session. Call start_debugging first.');
            assert.ok(upgraded instanceof ToolError);
            assert.strictEqual(upgraded.code, 'NO_SESSION');
            assert.strictEqual(upgraded.message, 'Cannot read memory: session state is \'no-session\'. No active debug session. Call start_debugging first.');
            const docs = upgradeLegacyText('list_target_docs failed: disk on fire');
            assert.ok(docs instanceof ToolError && docs.code === 'INTERNAL' && docs.message === 'disk on fire');
        });

        test('a 2.3.10 cap becomes a timeout reply with its text unchanged', () => {
            const cap = '\'get_call_stack\' did not complete within 30000 ms (handler-level cap). The DAP probe or target may be unresponsive.';
            assert.deepStrictEqual(upgradeLegacyText(cap), { text: cap, status: 'timeout' });
            const docs = 'search_target_docs timed out after 100 ms. The work continues in the background.';
            assert.deepStrictEqual(upgradeLegacyText(docs), { text: docs, status: 'timeout' });
        });

        test('any other text stays the text it was', () => {
            for (const text of ['Call stack (3 frames):', 'Note: Error in \'x\': not at the start', 'Target stopped (reason: breakpoint).']) {
                assert.strictEqual(upgradeLegacyText(text), text);
            }
        });
    });
});
