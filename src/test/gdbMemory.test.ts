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
import type * as vscode from 'vscode';
import {
    attemptsText, CAUSE_MAX_CHARS, classifyReadFailure, DHCSR_ADDRESS, isLockedUp, LOCKUP_NOTE, wedgeHint,
} from '../core/probeWedge';
import { ToolError } from '../core/toolResult';
import { explainReadFailure, MemoryReadFailure, probeDebugPort, readWordThroughGdb, withEarlierAttempts } from '../executor/gdbMemory';
import { HardwareTimeoutError } from '../utils/timeout';

/**
 * The read ladder and the DHCSR read of #3 over scripted sessions: each
 * strategy's cause is kept, and a failure becomes PROBE_WEDGED when the
 * debug port does not answer either, INVALID_ARGUMENT when it does.
 */

type Answer = (command: string, args: Record<string, unknown>) => unknown;

interface Recorded {
    session: vscode.DebugSession;
    requests: Array<{ command: string; args: Record<string, unknown> }>;
}

/** A session whose adapter answers through `answer`: a value, a promise, or a throw. */
function scripted(answer: Answer, type = 'gdbtarget', request = 'launch'): Recorded {
    const requests: Recorded['requests'] = [];
    const session = {
        type, name: 'S', configuration: { type, name: 'S', request },
        customRequest: (command: string, args: Record<string, unknown>) => {
            requests.push({ command, args });
            try {
                return Promise.resolve(answer(command, args));
            } catch (caught) {
                return Promise.reject(caught);
            }
        },
    };
    return { session: session as unknown as vscode.DebugSession, requests };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);
const bytes = (word: number): { data: string } => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(word >>> 0, 0);
    return { data: buffer.toString('base64') };
};

const BROKEN = 'Remote communication error.  Target disconnected.: Broken pipe.';

/** The ladder of 0xE000ED28 failing as a wedged probe fails it, with DAP readMemory's cause in front. */
async function wedgedRead(recorded: Recorded): Promise<unknown> {
    try {
        await readWordThroughGdb(recorded.session, '0xE000ED28', {}, 1_000);
    } catch (caught) {
        return withEarlierAttempts(caught, [{ strategy: 'DAP readMemory', cause: BROKEN }]);
    }
    assert.fail('the ladder should have failed');
}

async function explained(recorded: Recorded, caught: unknown, budgetMs = 1_000): Promise<unknown> {
    return explainReadFailure(recorded.session, '0xE000ED28', caught, budgetMs);
}

suite('memory reads and a wedged probe (#3)', () => {

    test('the ladder keeps why each strategy gave no value', async () => {
        const recorded = scripted((command, args) => {
            if (String(args.expression).startsWith('>')) {
                throw new Error('Unable to read memory.');
            }
            return { result: '' };
        });
        const failure = await wedgedRead(recorded);
        assert.ok(failure instanceof MemoryReadFailure);
        assert.deepStrictEqual(failure.attempts, [
            { strategy: 'DAP readMemory', cause: BROKEN },
            { strategy: 'watch expression', cause: 'empty result' },
            { strategy: 'MI read', cause: 'Unable to read memory.' },
        ]);
        assert.strictEqual(failure.message, `Failed to read memory at 0xE000ED28: DAP readMemory: ${BROKEN.replace(/\s+/g, ' ')}; `
            + 'watch expression: empty result; MI read: Unable to read memory.');
    });

    test('everything fails and DHCSR does not answer: PROBE_WEDGED with every cause, each at most 200 characters', async () => {
        const long = `GDB says: ${'x'.repeat(400)}`;
        const recorded = scripted((command) => {
            if (command === 'readMemory') {
                throw new Error(BROKEN);
            }
            throw new Error(long);
        });
        const error = await explained(recorded, await wedgedRead(recorded));
        assert.ok(error instanceof ToolError);
        assert.strictEqual(error.code, 'PROBE_WEDGED');
        assert.ok(error.message.startsWith(`Memory reads fail and the debug port does not answer (DHCSR at ${DHCSR_ADDRESS} unreadable: `
            + 'Remote communication error. Target disconnected.: Broken pipe.). Reading 0xE000ED28 — DAP readMemory: '), error.message);
        assert.ok(error.message.includes('watch expression: GDB says: x'), error.message);
        const clipped = /watch expression: (GDB says: x+…)/.exec(error.message)?.[1] ?? '';
        assert.strictEqual(clipped.length, CAUSE_MAX_CHARS);
        assert.strictEqual(error.hint, wedgeHint('launch'));
        const dhcsr = recorded.requests.filter((request) => request.args.memoryReference === DHCSR_ADDRESS);
        assert.deepStrictEqual(dhcsr.map((request) => [request.command, request.args.count]), [['readMemory', 4]], 'DHCSR is read once, 4 bytes');
    });

    test('DHCSR answers: the address is not readable in this state, INVALID_ARGUMENT naming it', async () => {
        const recorded = scripted((command, args) => {
            if (command === 'readMemory') {
                if (args.memoryReference === DHCSR_ADDRESS) {
                    return bytes(0x00030003);
                }
                throw new Error('Unable to read memory. (@ 0x60000000)');
            }
            return { result: 'Error: could not evaluate expression' };
        });
        const failure = new MemoryReadFailure('0x60000000', [{ strategy: 'DAP readMemory', cause: 'Unable to read memory. (@ 0x60000000)' }]);
        const error = await explainReadFailure(recorded.session, '0x60000000', failure, 1_000);
        assert.ok(error instanceof ToolError);
        assert.strictEqual(error.code, 'INVALID_ARGUMENT');
        assert.strictEqual(error.message, 'Cannot read 0x60000000 — the debug port answers, the address is not readable in this state: '
            + 'DAP readMemory: Unable to read memory. (@ 0x60000000)');
        assert.match(error.hint ?? '', /lookup_peripheral \{ address \}/);
    });

    test('a timeout, and DHCSR times out too: PROBE_WEDGED; a timeout on a port that answers stays the timeout', async () => {
        const hung = scripted(() => never());
        const timeout = new HardwareTimeoutError('DAP readMemory', 10_000);
        const wedged = await explained(hung, timeout, 50);
        assert.ok(wedged instanceof ToolError);
        assert.strictEqual(wedged.code, 'PROBE_WEDGED');
        assert.strictEqual(wedged.message, `Memory reads time out and the debug port does not answer (DHCSR at ${DHCSR_ADDRESS} timed out). `
            + 'Reading 0xE000ED28 — DAP readMemory: timed out after 10000 ms');

        const slow = scripted(() => bytes(0));
        assert.strictEqual(await explained(slow, timeout), timeout, 'the port answers: only the read was slow');
    });

    test('DHCSR is read within at most 1 s, whatever the budget', async () => {
        const hung = scripted(() => never());
        const began = Date.now();
        const probe = await probeDebugPort(hung.session, 60_000);
        const took = Date.now() - began;
        assert.deepStrictEqual(probe.readable ? undefined : [probe.timedOut], [true]);
        assert.ok(took >= 900 && took < 3_000, `${took} ms`);
    });

    test('S_LOCKUP in DHCSR is a core in lockup', async () => {
        const locked = await probeDebugPort(scripted(() => bytes(0x000b0003)).session, 1_000);
        assert.ok(locked.readable && isLockedUp(locked.dhcsr));
        const running = await probeDebugPort(scripted(() => bytes(0x01030003)).session, 1_000);
        assert.ok(running.readable && !isLockedUp(running.dhcsr));
        assert.match(LOCKUP_NOTE, /^The core is in lockup \(DHCSR\.S_LOCKUP=1\)/);
        const short = await probeDebugPort(scripted(() => ({ data: Buffer.from([1, 2]).toString('base64') })).session, 1_000);
        assert.deepStrictEqual(short, { readable: false, timedOut: false, cause: 'short reply (2 of 4 bytes)' });
    });

    test('other adapters read no DHCSR, and their failure keeps its causes', async () => {
        const recorded = scripted(() => {
            throw new Error('nope');
        }, 'cppdbg');
        const failure = await wedgedRead(recorded);
        assert.strictEqual(await explained(recorded, failure), failure);
        assert.ok(!recorded.requests.some((request) => request.args.memoryReference === DHCSR_ADDRESS));
        assert.ok(failure instanceof MemoryReadFailure);
        assert.deepStrictEqual(failure.attempts.map((attempt) => attempt.strategy), ['DAP readMemory', 'watch expression', 'x/1xw', 'print/x']);
    });

    test('a DHCSR read the adapter cannot do tells nothing; a running target is not a wedge; other errors pass', async () => {
        const failure = new MemoryReadFailure('0x20000000', [{ strategy: 'DAP readMemory', cause: 'unrecognized request' }]);
        const unsupported = scripted(() => {
            throw new Error('unrecognized request');
        });
        assert.strictEqual(await explained(unsupported, failure), failure);

        const running = scripted(() => {
            throw new Error('Cannot execute this command while the target is running.');
        });
        const refused = await explained(running, failure);
        assert.ok(refused instanceof ToolError);
        assert.strictEqual(refused.code, 'TARGET_RUNNING');

        const other = new SyntaxError('Cannot convert 0xZZ to a BigInt');
        assert.strictEqual(await explained(scripted(() => bytes(0)), other), other);
    });

    test('the way out depends on who owns the GDB server; the agent is never told to start one', () => {
        const attach = wedgeHint('attach');
        assert.strictEqual(attach, 'This session is attached to a GDB server that keeps running: cmsis_action detach, then cmsis_action attach — '
            + 'reconnects without a reset; then get_fault_info.');
        const launch = wedgeHint('launch');
        assert.ok(launch.startsWith('This session launched its own GDB server: detaching or stopping the session stops that server'), launch);
        assert.ok(launch.includes('ask the user to restart the GDB server without a reset (J-Link -nohalt -noreset, pyOCD -O connect_mode=attach)'));
        assert.ok(launch.includes('do not start one yourself'));
        assert.ok(launch.endsWith('If the fault state does not matter: cmsis_action load_and_debug.'));
        assert.strictEqual(wedgeHint(undefined), launch);
        const wedged = classifyReadFailure({
            address: '0x0', attempts: [], timedOut: false, probe: { readable: false, timedOut: true, cause: 'x' }, request: 'attach',
        });
        assert.strictEqual(wedged?.hint, attach);
    });

    test('repeated causes are named once', () => {
        assert.strictEqual(attemptsText([
            { strategy: 'MI read', cause: 'Unable to read memory.' },
            { strategy: 'MI read', cause: 'Unable to read memory.' },
            { strategy: 'block read', cause: 'boom\n  second line' },
        ]), 'MI read: Unable to read memory.; block read: boom second line');
    });
});
