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
 * What is said about a held port and its release rule (#49): to agents, the
 * sentence `serial_open` answers with, the clause of `serial_status`, the
 * line of `get_session_status` and the note of the tools that program the
 * target; to people, the status-bar item and its tooltip. Every text names
 * the rule, so an agent knows when the port goes away without being told the
 * setting.
 *
 * Pure: no vscode.
 */

import { clockTime, describeRelease, reopenAdvice, type SerialHold, type SerialStatus } from './serialController';
import type { ReleaseRule } from './serialLease';
import { durationText } from './windowStatus';

/** The part of the controller the texts read; reading it touches nothing. */
export interface SerialState {
    hold(): SerialHold | undefined;
    status(): SerialStatus;
}

/** What the status-bar item shows. */
export interface SerialHoldView {
    text: string;
    tooltip: string;
}

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

/**
 * The line of `get_session_status`: `Serial: COM7 open (this session, idle
 * 42 s of 300 s)` while a port is held, `Serial: COM7 released at 10:47:07
 * after 300 s without a serial call` after a release; nothing otherwise.
 */
export function serialSessionLine(serial: SerialState, sessionId: string | undefined): string | undefined {
    const hold = serial.hold();
    if (hold !== undefined) {
        const state = hold.rule === 'idle' && hold.idleSeconds > 0 && !hold.capture
            ? `idle ${Math.round(hold.idleForMs / 1000)} s of ${hold.idleSeconds} s`
            : ruleWords(hold);
        return `Serial: ${hold.path} open (${holderWords(hold.owner, sessionId)}, ${state})`;
    }
    const status = serial.status();
    return !status.open && status.lastRelease ? `Serial: ${describeRelease(status.lastRelease)}` : undefined;
}

/**
 * The line `flash` and the programming actions of `cmsis_action` add when
 * the window held `path` as they started (#49): programming can make the
 * probe's virtual COM port re-enumerate, which closes the port. Nothing when
 * the port was closed on purpose meanwhile.
 */
export function programmingNote(path: string, serial: SerialState): string | undefined {
    if (serial.hold()?.path === path) {
        return `${path} is open in this window; if the probe's VCP re-enumerates during programming, reopen it.`;
    }
    const release = serial.status().lastRelease;
    return release && release.path === path ? `${describeRelease(release)}, during programming. ${reopenAdvice(release)}` : undefined;
}

/** When the held port goes, for people. */
function releaseForPeople(hold: SerialHold): string {
    if (hold.capture) {
        return 'when its serial_capture ends, within a minute';
    }
    switch (hold.rule) {
        case 'idle':
            return hold.idleSeconds > 0 && hold.idleReleaseInMs !== undefined
                ? `after ${hold.idleSeconds} s without a serial call (in ${durationText(hold.idleReleaseInMs)}), or when the agent's session ends`
                : 'when the agent\'s session ends (the idle release is off)';
        case 'debug-session-end':
            return 'when the debug session in this window ends, or when the agent\'s session ends';
        case 'manual':
            return 'only when the agent closes it (releaseOn manual)';
    }
}

/**
 * The status-bar item while an agent holds a port: `$(plug) Serial: COM7
 * (agent)`, and a tooltip with the baud rate, since when, the owner's short
 * id and when the port is released. A click releases it.
 */
export function renderSerialHold(hold: SerialHold, now: number): SerialHoldView {
    return {
        text: `$(plug) Serial: ${hold.path} (agent)`,
        tooltip: [
            `CMSIS Developer Assistant: an agent holds ${hold.path}.`,
            `${hold.baudRate} baud, open since ${clockTime(hold.openedAt)} (${durationText(now - hold.openedAt.getTime())})`,
            `Owner: ${hold.owner ? `MCP session ${hold.owner.slice(0, 8)}` : 'an unknown session'}`,
            `Released: ${releaseForPeople(hold)}`,
            '',
            'Click to release it for the Serial Monitor or a terminal.',
        ].join('\n'),
    };
}
