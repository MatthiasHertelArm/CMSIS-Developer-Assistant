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
    DEBUG_OPS,
    INTERNAL_OPS,
    PACKDOCS_OPS,
    SERIAL_OPS,
    forwardTimeoutMs,
    isInternalOp,
    isKnownOp,
    isPackDocsDocOp,
    isPackDocsOp,
    isSerialOp,
    targetHintOf,
    workerFenceMs,
} from '../core/opTable';

/** The router's own default in these cases: 30 s per tool call. */
const TOOL_MS = 30_000;
const TEN_MINUTES = 600_000;

suite('Op table', () => {

    test('the control server accepts table names only, never object internals', () => {
        for (const accepted of ['handleReadMemory', 'handleFlash', 'handleOpen']) {
            assert.ok(isKnownOp(accepted), `${accepted} should be dispatchable`);
        }
        for (const refused of ['handleNotARealOp', 'constructor', '__proto__']) {
            assert.ok(!isKnownOp(refused), `${refused} must be refused`);
        }
    });

    test('serial ops are told apart from debugging ops', () => {
        assert.strictEqual(isSerialOp('handleListPorts'), true);
        assert.strictEqual(isSerialOp('handleReadMemory'), false);
    });

    test('documentation and build-artefact ops form their own group with two halves', () => {
        assert.ok(isKnownOp('handleSearchTargetDocs'));
        assert.ok(isKnownOp('handleGetMemoryUsage'));
        assert.ok(isPackDocsOp('handleListTargetDocs') && isPackDocsDocOp('handleListTargetDocs'),
            'listing target documents is a documentation op');
        assert.ok(isPackDocsOp('handleLookupSymbol') && !isPackDocsDocOp('handleLookupSymbol'),
            'a symbol lookup belongs to the build-artefact half');
        assert.strictEqual(isPackDocsOp('handleReadMemory'), false);
        assert.strictEqual(isSerialOp('handleFetchDoc'), false);
        assert.strictEqual(PACKDOCS_OPS.length, 10);
    });

    test('each name belongs to exactly one group', () => {
        const everyName: string[] = [...DEBUG_OPS, ...SERIAL_OPS, ...PACKDOCS_OPS];
        const repeated = everyName.filter((name, index) => everyName.indexOf(name) !== index);
        assert.deepStrictEqual(repeated, []);
    });

    test('the path hint is fileFullPath first, then workingDirectory, and never an empty string', () => {
        assert.deepStrictEqual(targetHintOf({ fileFullPath: '/a/main.c', workingDirectory: '/b' }), { source: 'path', path: '/a/main.c' });
        assert.deepStrictEqual(targetHintOf({ workingDirectory: '/b' }), { source: 'path', path: '/b' });
        assert.strictEqual(targetHintOf({ address: '0x20000000', length: 16 }), undefined);
        assert.strictEqual(targetHintOf(undefined), undefined);
        assert.strictEqual(targetHintOf({ fileFullPath: '' }), undefined);
    });

    test('the window argument comes first: all digits is a pid, anything else a path, blank is nothing (#16)', () => {
        assert.deepStrictEqual(targetHintOf({ window: '4711', fileFullPath: '/a/main.c' }), { source: 'window', pid: 4711 });
        assert.deepStrictEqual(targetHintOf({ window: ' 4711 ' }), { source: 'window', pid: 4711 });
        assert.deepStrictEqual(targetHintOf({ window: '/work/board-b' }), { source: 'window', path: '/work/board-b' });
        assert.deepStrictEqual(targetHintOf({ window: '4711/src' }), { source: 'window', path: '4711/src' });
        assert.deepStrictEqual(targetHintOf({ window: '  ', workingDirectory: '/b' }), { source: 'path', path: '/b' });
        assert.strictEqual(targetHintOf({ window: 4711 }), undefined, 'the argument is a string; a number is not read as one');
    });

    test('the forward timeout outlasts the tool budget, with a ten-minute floor for slow ops', () => {
        assert.ok(forwardTimeoutMs('handleReadMemory', { timeoutMs: 5_000 }, TOOL_MS) > 5_000,
            'a per-call budget is extended, not cut');
        assert.strictEqual(forwardTimeoutMs('handleStepOver', {}, TOOL_MS), 45_000);
        for (const slow of ['handleCmsisCommand', 'handleFlash', 'handleSearchTargetDocs']) {
            assert.ok(forwardTimeoutMs(slow, {}, TOOL_MS) >= TEN_MINUTES, `${slow} keeps the floor`);
        }
        assert.ok(forwardTimeoutMs('handleReadDocPages', { timeoutMs: TEN_MINUTES }, TOOL_MS) >= 615_000);
        // cmsis_action and flash may wait 600 s for their job (#12): the router waits longer than that.
        assert.ok(forwardTimeoutMs('handleCmsisCommand', { timeoutMs: TEN_MINUTES }, TOOL_MS) >= 615_000);
        assert.ok(forwardTimeoutMs('handleFlash', { timeoutMs: TEN_MINUTES }, TOOL_MS) >= 615_000);
        assert.strictEqual(forwardTimeoutMs('handleLookupSymbol', {}, TOOL_MS), 45_000,
            'build-artefact ops have no floor');
    });

    test('a serial wait the call names is waited for in full, whatever the default (#49)', () => {
        assert.strictEqual(forwardTimeoutMs('handleCapture', { path: 'COM7', durationMs: 60_000 }, 10_000), 75_000);
        assert.strictEqual(forwardTimeoutMs('handleRead', { waitMs: 50_000 }, 10_000), 65_000);
        assert.strictEqual(forwardTimeoutMs('handleCapture', { durationMs: 1_000 }, TOOL_MS), 45_000, 'a short one keeps the default');
        assert.strictEqual(forwardTimeoutMs('handleRead', { waitMs: -5, durationMs: 'long' }, TOOL_MS), 45_000);
    });

    test('the margin and the slow-op floor can be injected (#14)', () => {
        assert.strictEqual(forwardTimeoutMs('handleStepOver', {}, 1_000, { marginMs: 500 }), 1_500);
        assert.strictEqual(forwardTimeoutMs('handleFlash', {}, 1_000, { marginMs: 500, slowFloorMs: 4_000 }), 4_000);
        assert.strictEqual(forwardTimeoutMs('handleFlash', { timeoutMs: 9_000 }, 1_000, { marginMs: 500, slowFloorMs: 4_000 }), 9_500);
    });

    test('the worker\'s fence answers 5 s inside the budget, never below 1 s, never beyond a timer\'s range (#14)', () => {
        // The proposal's table: start_debugging, the slow ops, read_memory with timeoutMs 5000.
        assert.strictEqual(workerFenceMs(forwardTimeoutMs('handleStartDebugging', {}, 180_000)), 190_000);
        assert.strictEqual(workerFenceMs(forwardTimeoutMs('handleCmsisCommand', {}, 180_000)), 595_000);
        assert.strictEqual(workerFenceMs(forwardTimeoutMs('handleReadMemory', { timeoutMs: 5_000 }, 180_000)), 15_000);
        assert.strictEqual(workerFenceMs(5), 1_000, 'a budget too small for any fence');
        assert.strictEqual(workerFenceMs(1e12), 2_147_483_647);
        assert.strictEqual(workerFenceMs(400, { fenceMarginMs: 100, minFenceMs: 10 }), 300);
    });

    test('internal ops are answered by the control server itself: no tool, no dispatch (#14)', () => {
        assert.deepStrictEqual([...INTERNAL_OPS], ['health', 'sessionEnded']);
        for (const op of INTERNAL_OPS) {
            assert.ok(isInternalOp(op));
            assert.ok(!isKnownOp(op), `${op} is not dispatched to a handler`);
            assert.ok(!(DEBUG_OPS as readonly string[]).includes(op));
        }
        assert.ok(!isInternalOp('handleGetSessionStatus'));
        assert.ok(!isInternalOp('constructor'));
    });
});
