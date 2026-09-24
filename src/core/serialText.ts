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
 * What the serial tools say about a held port and its release rule (#49):
 * the sentence `serial_open` answers with and the clause of `serial_status`.
 * Every text names the rule, so an agent knows when the port goes away
 * without being told the setting.
 *
 * Pure: no vscode.
 */

import type { SerialHold } from './serialController';
import type { ReleaseRule } from './serialLease';

/** The sentence `serial_open` adds: when the port it opened is released. */
export function ruleSentence(rule: ReleaseRule, idleSeconds: number): string {
    switch (rule) {
        case 'idle':
            return idleSeconds > 0
                ? `It is released after ${idleSeconds} s without a serial call, or when this MCP session ends.`
                : 'It is released when this MCP session ends (the idle release is off).';
        case 'debug-session-end':
            return 'It is released when the debug session in this window ends, or when this MCP session ends.';
        case 'manual':
            return 'It stays open until serial_close, also after this MCP session ends.';
    }
}

/** Who holds the port, seen from the MCP session `sessionId` that asks. */
export function holderWords(owner: string | undefined, sessionId: string | undefined): string {
    if (owner === undefined) {
        return 'an unknown session';
    }
    return owner === sessionId ? 'this session' : `another MCP session (${owner.slice(0, 8)})`;
}

/** The rule of a held port in a few words: `released after 300 s without a serial call`. */
export function ruleWords(hold: SerialHold): string {
    if (hold.capture) {
        return 'serial_capture running';
    }
    switch (hold.rule) {
        case 'idle':
            return hold.idleSeconds > 0 ? `released after ${hold.idleSeconds} s without a serial call` : 'no idle release';
        case 'debug-session-end':
            return 'released when the debug session ends';
        case 'manual':
            return 'released only by serial_close';
    }
}

/** The clause `serial_status` adds to an open port: `held by this session, released after 300 s without a serial call`. */
export function holdClause(hold: SerialHold, sessionId: string | undefined): string {
    return `held by ${holderWords(hold.owner, sessionId)}, ${ruleWords(hold)}`;
}
