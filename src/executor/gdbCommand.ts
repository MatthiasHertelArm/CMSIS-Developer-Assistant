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
 * One raw GDB command, sent in the dialect of the session's adapter
 * (src/core/gdbDialect.ts) as a REPL `evaluate` request, with its text.
 *
 * On the CMSIS Debugger the text of a CLI command arrives as `output` events
 * (category `stdout`), which a capture on the session tracker collects from
 * just before the request goes out until the output has settled after the
 * reply; an MI command's result is the reply itself. On `cppdbg` the reply
 * carries the text.
 */

import * as vscode from 'vscode';
import { gdbDialectFor, isMiCommand } from '../core/gdbDialect';
import { captureOutput } from '../utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout';
import { EvaluateBody, FrameArg, messageOf } from './common';

/** What GDB made of a command: its text, or the adapter's error text when `errored`. */
export interface GdbReply {
    text: string;
    errored: boolean;
}

/**
 * How long the output has to stay quiet after the reply before the text
 * counts as complete. cdt-gdb-adapter sends a command's console records as
 * `output` events before it answers the request, and the adapter tracker sees
 * them in that order, so the text is normally complete when the reply
 * arrives; the quiet period covers output dispatched in the same turn as the
 * reply (a monitor command's target stream, a warning the adapter raises
 * after answering). 50 ms is several event-loop turns of the extension host
 * and adds little to a command that takes one probe round trip.
 */
export const OUTPUT_QUIET_MS = 50;

/**
 * The most the settle adds, even while output keeps coming: a running
 * target that prints (semihosting, dprintf hits) must not hold the call.
 */
export const OUTPUT_SETTLE_CAP_MS = 250;

/**
 * cdt-gdb-adapter's default evaluate answer. To a `>` command it means the
 * adapter skipped the request because its session is not ready (starting or
 * ending); a command it ran answers '\r' or its MI result.
 */
const SKIPPED = 'Error: could not evaluate expression';

/**
 * Sends `command` (without prefix) to GDB in `frame`. An adapter error comes
 * back as an `errored` reply with the adapter's text; only a timeout rejects,
 * with the `HardwareTimeoutError`.
 */
export async function runGdbCommand(session: vscode.DebugSession, command: string, frame: FrameArg, budgetMs: number): Promise<GdbReply> {
    const dialect = gdbDialectFor(session.type);
    const capture = dialect.textChannel === 'output-events' ? captureOutput(session) : undefined;
    try {
        const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
            { expression: `${dialect.prefix}${command}`, context: 'repl', ...frame }, budgetMs);
        const result = String(reply?.result ?? '').trim();
        if (!capture) {
            return { text: result, errored: false };
        }
        if (result === SKIPPED) {
            capture.stop();
            return { text: `The debug adapter did not run the command: its session is not ready (it answered "${SKIPPED}").`, errored: true };
        }
        const printed = (await capture.settle(OUTPUT_QUIET_MS, OUTPUT_SETTLE_CAP_MS)).trim();
        // A CLI command answers '\r' (trimmed away); an MI command answers its result as JSON.
        const text = isMiCommand(command) && result ? [printed, result].filter(Boolean).join('\n') : printed || result;
        return { text, errored: false };
    } catch (err) {
        capture?.stop();
        if (err instanceof HardwareTimeoutError) {
            throw err;
        }
        return { text: messageOf(err).trim(), errored: true };
    }
}
