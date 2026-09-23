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
 * The handler-level fence around the inspection and CMSIS tools. A call that
 * outlives its limit answers with a text saying so instead of hanging the
 * agent, and a call that fails answers `Error in '<tool>': …`. Both are
 * ordinary tool results, not MCP errors (#11); `src/core/toolMetrics.ts`
 * recognises them by the `did not complete within` and `Error in '` markers.
 */

import type { HandlerHost } from './host';

/** The limit when the caller passes no positive `timeoutMs`. */
const UNSPECIFIED_LIMIT_MS = 30_000;
/** The most any single call may ask for (#12). */
const LIMIT_CAP_MS = 60_000;

/** What a caught value says: an Error's message, anything else as a string. */
export function failureText(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** The limit for a tool call's `timeoutMs`: clamped when positive, else the 30 s default. */
export function fenceLimitMs(timeoutMs: number | undefined): number {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        return Math.min(timeoutMs, LIMIT_CAP_MS);
    }
    return UNSPECIFIED_LIMIT_MS;
}

function overrunNotice(label: string, limitMs: number): string {
    return `'${label}' did not complete within ${limitMs} ms (handler-level cap). `
        + 'The DAP probe or target may be unresponsive — call get_session_status / check_target_connection to confirm. '
        + 'Note: the underlying request may still be running on the server; consider restart_debugging if subsequent calls also stall.';
}

/**
 * Race `body` against the limit for `timeoutMs`. Never rejects.
 *
 * The timer is armed before the body starts, so a body whose own wait is as
 * long as the fence loses the tie. A body that loses keeps running — a DAP
 * request cannot be withdrawn — and whatever it produces later, a rejection
 * included, is dropped.
 */
export async function fenced(
    label: string,
    timeoutMs: number | undefined,
    timers: Pick<HandlerHost, 'startTimer'>,
    body: () => Promise<string>,
): Promise<string> {
    const limitMs = fenceLimitMs(timeoutMs);
    let disarm: () => void = () => undefined;
    const expiry = new Promise<string>((settle) => {
        disarm = timers.startTimer(limitMs, () => settle(overrunNotice(label, limitMs)));
    });
    const answer = body().then(
        (text) => text,
        (caught: unknown) => `Error in '${label}': ${failureText(caught)}`,
    );
    try {
        return await Promise.race([answer, expiry]);
    } finally {
        disarm();
    }
}
