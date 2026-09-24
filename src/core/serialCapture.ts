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
 * What `serial_capture` keeps of the bytes it reads and how it answers (#49).
 * A capture opens the port, reads until a regex matches or its time runs
 * out, and closes the port again, so nothing is left held. Its answer is at
 * most 16 kB of text: the first and the last 8 kB, with the count of the
 * bytes between, cut at character boundaries.
 *
 * The capture keeps up to 1 MiB and then only the first 8 kB and the newest
 * bytes. The regex is tried on the newest chunk and the 8 kB before it, so a
 * long capture costs the same per chunk as a short one; a match must fit in
 * that window.
 *
 * Pure: no vscode, no port.
 */

import { ToolError, type ToolReply } from './toolResult';

/** The shortest and the longest capture. */
export const CAPTURE_MIN_MS = 100;
export const CAPTURE_MAX_MS = 60_000;
/** The answer shows this much from each end. */
export const CAPTURE_HALF_BYTES = 8 * 1024;
/** Bytes kept before the middle of a capture is dropped. */
const KEEP_MAX_BYTES = 1024 * 1024;
/** How far back from a new chunk a match is looked for. */
const MATCH_WINDOW_BYTES = 8 * 1024;

/** How a capture ended: the regex matched, its time ran out, or the port went away while it read. */
export type CaptureStop = 'match' | 'deadline' | 'closed';

/** Everything the answer of a capture is made from. */
export interface CaptureOutcome {
    path: string;
    record: CaptureRecord;
    /** Milliseconds from the open to the stop. */
    elapsedMs: number;
    stop: CaptureStop;
    until?: RegExp;
    /** Bytes written after the open. */
    written: number;
    /** Why the port went away, for `closed`. */
    closedBecause?: string;
}

/** A capture's length in range: 100 ms to 60 s. */
export function captureDurationMs(durationMs: unknown): number {
    const asked = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : CAPTURE_MIN_MS;
    return Math.min(Math.max(Math.round(asked), CAPTURE_MIN_MS), CAPTURE_MAX_MS);
}

/**
 * `until` as a regex: `/source/flags` or a plain pattern; none for an empty
 * one. `g` and `y` are dropped, since they make a test depend on the one
 * before. A pattern that does not compile is `INVALID_ARGUMENT`, before any
 * port is touched.
 */
export function untilPattern(until: string | undefined): RegExp | undefined {
    if (until === undefined || until.length === 0) {
        return undefined;
    }
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(until);
    try {
        return literal ? new RegExp(literal[1], literal[2].replace(/[gy]/g, '')) : new RegExp(until);
    } catch (caught) {
        throw new ToolError('INVALID_ARGUMENT',
            `until is not a valid regular expression: ${caught instanceof Error ? caught.message : String(caught)}`,
            'Pass a JavaScript regular expression, such as READY or /boot (ok|done)/i.');
    }
}

/** The index at or before `at` where a character starts: never inside a UTF-8 sequence. */
function charStartAtOrBefore(bytes: Buffer, at: number): number {
    let index = Math.min(at, bytes.length);
    while (index > 0 && index < bytes.length && (bytes[index] & 0xc0) === 0x80) {
        index -= 1;
    }
    return index;
}

/** The index at or after `at` where a character starts. */
function charStartAtOrAfter(bytes: Buffer, at: number): number {
    let index = Math.max(at, 0);
    while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) {
        index += 1;
    }
    return index;
}

/** The bytes a capture read: all of them up to 1 MiB, then the first 8 kB and the newest ones. */
export class CaptureRecord {
    private kept: Buffer = Buffer.alloc(0);
    private dropped = 0;
    private total = 0;

    /** Bytes read in all. */
    get bytes(): number {
        return this.total;
    }

    append(chunk: Buffer): void {
        this.total += chunk.length;
        this.kept = Buffer.concat([this.kept, chunk]);
        if (this.kept.length > KEEP_MAX_BYTES) {
            const head = this.kept.subarray(0, CAPTURE_HALF_BYTES);
            const tail = this.kept.subarray(this.kept.length - (KEEP_MAX_BYTES - CAPTURE_HALF_BYTES));
            this.dropped += this.kept.length - head.length - tail.length;
            this.kept = Buffer.concat([head, tail]);
        }
    }

    /** The text a match is looked for in once `newBytes` arrived: those bytes and the 8 kB before them. */
    searchText(newBytes: number): string {
        const from = charStartAtOrAfter(this.kept, this.kept.length - newBytes - MATCH_WINDOW_BYTES);
        return this.kept.subarray(from).toString('utf8');
    }

    /** The whole text when it fits in 16 kB; else the first and the last 8 kB and how many bytes lie between. */
    excerpt(): { head: string; omitted: number; tail?: string } {
        if (this.total <= 2 * CAPTURE_HALF_BYTES) {
            return { head: this.kept.toString('utf8'), omitted: 0 };
        }
        const headEnd = charStartAtOrBefore(this.kept, CAPTURE_HALF_BYTES);
        const tailStart = charStartAtOrAfter(this.kept, this.kept.length - CAPTURE_HALF_BYTES);
        const shown = headEnd + (this.kept.length - tailStart);
        return {
            head: this.kept.subarray(0, headEnd).toString('utf8'),
            omitted: this.total - shown,
            tail: this.kept.subarray(tailStart).toString('utf8'),
        };
    }
}

/** `1.2 s`. */
function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

/** Why the capture stopped, as the first line says it. */
function stopWords(outcome: CaptureOutcome): string {
    switch (outcome.stop) {
        case 'match':
            return `matched ${String(outcome.until)}`;
        case 'deadline':
            return outcome.until ? `deadline; ${String(outcome.until)} not seen` : 'deadline';
        case 'closed':
            return outcome.closedBecause ?? 'the port closed';
    }
}

/**
 * The answer of a capture: one line with what was read, for how long and
 * why it stopped, then the text. A capture whose `until` never matched is a
 * `timeout` reply; every other one is `ok`. `data` repeats the numbers.
 */
export function renderCapture(outcome: CaptureOutcome): ToolReply {
    const { record } = outcome;
    const wrote = outcome.written > 0 ? ` after writing ${outcome.written} B` : '';
    const excerpt = record.excerpt();
    const shortened = excerpt.omitted > 0 ? ' Showing the first and the last 8 kB.' : '';
    const lines = [`Captured ${record.bytes} B from ${outcome.path} in ${seconds(outcome.elapsedMs)}${wrote} (${stopWords(outcome)}). `
        + `Port closed.${shortened}`];
    if (record.bytes === 0) {
        lines.push('Nothing arrived. Check baudRate; for what the firmware prints at start-up: '
            + 'serial_open, then reset, then serial_read {waitMs}, then serial_close.');
    } else {
        lines.push('--- text ---', excerpt.head);
        if (excerpt.tail !== undefined) {
            lines.push(`… ${excerpt.omitted} bytes omitted …`, excerpt.tail);
        }
    }
    return {
        text: lines.join('\n'),
        status: outcome.stop === 'deadline' && outcome.until !== undefined ? 'timeout' : 'ok',
        data: {
            path: outcome.path, bytes: record.bytes, elapsedMs: Math.round(outcome.elapsedMs), stop: outcome.stop,
            omittedBytes: excerpt.omitted, written: outcome.written,
        },
    };
}
