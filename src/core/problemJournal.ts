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
 * The problem journal of a window (#48): one list of what went wrong, in one
 * record shape, whatever reported it — the debug adapter and the GDB server
 * behind it, failed CMSIS tasks and builds, the Problems panel, this
 * extension's notifications and errors, serial ports. `problemJournal()` is
 * the window's instance; every source appends to it, and agents read it
 * through `get_recent_problems` and the records that ride along with a
 * failed call (src/core/problemFeed.ts).
 *
 * - Every record gets `seq`, monotonic per window: the cursor an agent
 *   passes back as `sinceSeq`, which returns the records from that number on.
 * - 200 records are kept. When one more arrives, the oldest `info` goes
 *   first, then the oldest `warning`, then the oldest `error`, so chatty
 *   lines never push out the one error.
 * - A repeat — same source, origin, code and message within 10 s of the last
 *   time — takes no slot: the record counts it (`count`) and moves to the
 *   end with a new `seq` and time, so a cursor sees it again.
 * - `counters()` gives the newest seq and the number of errors ever
 *   appended, repeats included; a window's replies carry both, and the
 *   router tells an agent about errors it has not seen.
 * - While a tool call runs in this window it is registered (`beginCall`); a
 *   record appended inside the call's async context, or while that call is
 *   the only one running, carries its `toolCallId`.
 *
 * Messages are capped at 300 characters and otherwise kept as the source
 * wrote them. Pure: no vscode; the sources that need VS Code live in
 * src/windowProblems.ts.
 */

import { currentCallContext } from './callContext';
import type { ProblemCode } from './problemCodes';
import type { JsonObject } from './toolResult';

/** Where a problem was reported. */
export const PROBLEM_SOURCES = ['dap', 'gdb-server', 'task', 'build', 'problems', 'ui', 'extension', 'serial'] as const;
export type ProblemSource = typeof PROBLEM_SOURCES[number];

/** How much a problem weighs, heaviest first. */
export const PROBLEM_SEVERITIES = ['error', 'warning', 'info'] as const;
export type ProblemSeverity = typeof PROBLEM_SEVERITIES[number];

/** Records kept per window. */
export const JOURNAL_CAPACITY = 200;
/** A longer message is cut and ends in an ellipsis. */
export const MESSAGE_MAX_CHARS = 300;
/** A repeat within this time of the record's last occurrence is counted, not added. */
export const REPEAT_WINDOW_MS = 10_000;

/** A file and line a problem points at, relative to the workspace folder where it lies in one. */
export interface ProblemLocation {
    file: string;
    line?: number;
    column?: number;
}

/** One problem as the journal keeps it. */
export interface ProblemRecord {
    /** Monotonic per window: the cursor. */
    seq: number;
    /** ISO 8601, of the latest occurrence. */
    time: string;
    source: ProblemSource;
    /** The debug session name, task name, diagnostic source or extension id. */
    origin: string;
    severity: ProblemSeverity;
    code?: ProblemCode;
    /** As the source wrote it, at most 300 characters. */
    message: string;
    location?: ProblemLocation;
    /** The DAP session's id; the MCP session is a different thing. */
    debugSessionId?: string;
    /** The tool call running in this window when the problem was recorded. */
    toolCallId?: string;
    /** The next step, where one is known. */
    hint?: string;
    /** Occurrences folded into this record, when more than one. */
    count?: number;
}

/** What a source hands in; the journal adds `seq`, `time` and, where it can, `toolCallId`. */
export interface ProblemInput {
    source: ProblemSource;
    origin: string;
    severity: ProblemSeverity;
    code?: ProblemCode;
    message: string;
    location?: ProblemLocation;
    debugSessionId?: string;
    toolCallId?: string;
    hint?: string;
}

/** Which records to read; every field narrows. */
export interface ProblemQuery {
    /** The first seq to return: the `nextSeq` of the previous page. */
    sinceSeq?: number;
    sources?: readonly ProblemSource[];
    /** The lightest severity to return; `info` (everything) when absent. */
    minSeverity?: ProblemSeverity;
    /** At most this many, the newest; all when absent. */
    limit?: number;
}

/** What a query found. */
export interface ProblemPage {
    /** Oldest first. */
    records: ProblemRecord[];
    /** The seq the next record will get: `sinceSeq` for the next query. */
    nextSeq: number;
    /** Matching records the limit left out, the oldest ones. */
    omitted: number;
}

/** The two monotonic counters a window's replies carry. */
export interface JournalCounters {
    /** The newest seq given out; 0 before the first record. */
    seq: number;
    /** Errors ever appended, repeats included. */
    errors: number;
}

/** A tool call registered while it runs in this window. */
export interface CallInFlight {
    /** The seq the first record of the call can have. */
    readonly startSeq: number;
    readonly callId?: string;
    /** Unregisters the call; once is enough. */
    end(): void;
}

const SEVERITY_WEIGHT: Readonly<Record<ProblemSeverity, number>> = { error: 2, warning: 1, info: 0 };

/** True when `severity` is `floor` or heavier. */
export function atLeast(severity: ProblemSeverity, floor: ProblemSeverity): boolean {
    return SEVERITY_WEIGHT[severity] >= SEVERITY_WEIGHT[floor];
}

/** `text` trimmed and cut to `MESSAGE_MAX_CHARS`, never inside a surrogate pair. */
function capped(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= MESSAGE_MAX_CHARS) {
        return trimmed;
    }
    let cut = MESSAGE_MAX_CHARS - 1;
    const last = trimmed.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        cut -= 1;
    }
    return `${trimmed.slice(0, cut)}…`;
}

/** What makes two inputs the same problem. */
function repeatKey(input: { source: string; origin: string; code?: string; message: string }): string {
    return [input.source, input.origin, input.code ?? '', input.message].join('\u0000');
}

/** A record without the keys whose value is undefined, frozen. */
function sealed(record: ProblemRecord): ProblemRecord {
    const kept = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as unknown as ProblemRecord;
    if (kept.location) {
        kept.location = Object.freeze({ ...kept.location });
    }
    return Object.freeze(kept);
}

interface Entry {
    record: ProblemRecord;
    /** Milliseconds of the latest occurrence. */
    at: number;
    key: string;
}

/** The problem journal of one window; see the module comment. */
export class ProblemJournal {
    private entries: Entry[] = [];
    private next = 1;
    private errorTotal = 0;
    private readonly calls = new Map<number, string | undefined>();
    private callCount = 0;
    private readonly listeners = new Set<(record: ProblemRecord) => void>();

    constructor(
        private readonly clock: () => number = () => Date.now(),
        private readonly capacity: number = JOURNAL_CAPACITY,
    ) {}

    /** Records one problem, or counts it as a repeat of a recent one; the record as kept. */
    append(input: ProblemInput): ProblemRecord {
        const now = this.clock();
        const message = capped(input.message);
        const key = repeatKey({ ...input, message });
        const toolCallId = input.toolCallId ?? this.callNow();
        const repeated = this.recentRepeat(key, now);
        let record: ProblemRecord;
        if (repeated) {
            this.entries = this.entries.filter((entry) => entry !== repeated);
            record = sealed({
                ...repeated.record,
                seq: this.next++,
                time: new Date(now).toISOString(),
                count: (repeated.record.count ?? 1) + 1,
                toolCallId,
                debugSessionId: input.debugSessionId ?? repeated.record.debugSessionId,
            });
        } else {
            record = sealed({
                seq: this.next++,
                time: new Date(now).toISOString(),
                source: input.source,
                origin: input.origin,
                severity: input.severity,
                code: input.code,
                message,
                location: input.location,
                debugSessionId: input.debugSessionId,
                toolCallId,
                hint: input.hint,
            });
        }
        this.entries.push({ record, at: now, key });
        this.evictOverCapacity();
        if (record.severity === 'error') {
            this.errorTotal += 1;
        }
        for (const listener of [...this.listeners]) {
            try {
                listener(record);
            } catch {
                // A listener that fails must not cost the source its record.
            }
        }
        return record;
    }

    /** The matching records, oldest first: the newest `limit` of them. */
    query(query: ProblemQuery = {}): ProblemPage {
        const since = query.sinceSeq ?? 0;
        const floor = query.minSeverity ?? 'info';
        const sources = query.sources && query.sources.length > 0 ? new Set<ProblemSource>(query.sources) : undefined;
        const matching = this.entries
            .map((entry) => entry.record)
            .filter((record) => record.seq >= since && atLeast(record.severity, floor) && (!sources || sources.has(record.source)));
        const limit = query.limit === undefined ? matching.length : Math.max(0, Math.floor(query.limit));
        const records = limit >= matching.length ? matching : matching.slice(matching.length - limit);
        return { records, nextSeq: this.next, omitted: matching.length - records.length };
    }

    /** The newest seq and the error total. */
    counters(): JournalCounters {
        return { seq: this.next - 1, errors: this.errorTotal };
    }

    /** The seq the next record will get. */
    get nextSeq(): number {
        return this.next;
    }

    /** Records kept now. */
    get size(): number {
        return this.entries.length;
    }

    /** Registers a tool call that starts running in this window. */
    beginCall(callId?: string): CallInFlight {
        const handle = ++this.callCount;
        this.calls.set(handle, callId);
        return { startSeq: this.next, callId, end: () => { this.calls.delete(handle); } };
    }

    /** Tool calls running in this window now. */
    callsInFlight(): number {
        return this.calls.size;
    }

    /** Called with every record as it is kept, a repeat included. */
    onDidAppend(listener: (record: ProblemRecord) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    /** The call this record belongs to: the current async context's, else the only call running. */
    private callNow(): string | undefined {
        const context = currentCallContext();
        if (context) {
            return context.callId;
        }
        if (this.calls.size === 1) {
            return this.calls.values().next().value;
        }
        return undefined;
    }

    private recentRepeat(key: string, now: number): Entry | undefined {
        for (let index = this.entries.length - 1; index >= 0; index--) {
            const entry = this.entries[index];
            if (entry.key === key) {
                return now - entry.at <= REPEAT_WINDOW_MS ? entry : undefined;
            }
        }
        return undefined;
    }

    /** Drops the oldest info, else the oldest warning, else the oldest error, until the journal fits. */
    private evictOverCapacity(): void {
        while (this.entries.length > this.capacity) {
            const byWeight = (severity: ProblemSeverity): number => this.entries.findIndex((entry) => entry.record.severity === severity);
            const info = byWeight('info');
            const warning = info >= 0 ? info : byWeight('warning');
            this.entries.splice(warning >= 0 ? warning : 0, 1);
        }
    }
}

/** The record as JSON, for `data.problems` and the control envelope. */
export function problemJson(record: ProblemRecord): JsonObject {
    const json: JsonObject = {
        seq: record.seq, time: record.time, source: record.source, origin: record.origin, severity: record.severity, message: record.message,
    };
    if (record.code !== undefined) {
        json.code = record.code;
    }
    if (record.location !== undefined) {
        const location: JsonObject = { file: record.location.file };
        if (record.location.line !== undefined) {
            location.line = record.location.line;
        }
        if (record.location.column !== undefined) {
            location.column = record.location.column;
        }
        json.location = location;
    }
    for (const key of ['debugSessionId', 'toolCallId', 'hint'] as const) {
        const value = record[key];
        if (value !== undefined) {
            json[key] = value;
        }
    }
    if (record.count !== undefined) {
        json.count = record.count;
    }
    return json;
}

/** How a record is shown on one line; `seq` and `origin` are optional, `time` is for humans. */
export interface LineOptions {
    seq?: boolean;
    time?: boolean;
    origin?: boolean;
}

/**
 * One record on one line: `#212 error gdb-server [DAP_POWER_UP_FAILED]
 * Failed to power up DAP → Check the board's power …`, with `file:line: `
 * before the message and ` (×3)` after it where they apply. Line breaks in
 * the message become spaces.
 */
export function formatProblemLine(record: ProblemRecord, options: LineOptions = { seq: true }): string {
    const parts: string[] = [];
    if (options.time) {
        parts.push(record.time);
    }
    if (options.seq !== false) {
        parts.push(`#${record.seq}`);
    }
    parts.push(record.severity, record.source);
    if (options.origin && record.origin) {
        parts.push(`(${record.origin})`);
    }
    if (record.code) {
        parts.push(`[${record.code}]`);
    }
    const where = record.location
        ? `${record.location.file}${record.location.line !== undefined ? `:${record.location.line}` : ''}`
            + `${record.location.line !== undefined && record.location.column !== undefined ? `:${record.location.column}` : ''}: `
        : '';
    const times = record.count !== undefined && record.count > 1 ? ` (×${record.count})` : '';
    const next = record.hint ? ` → ${record.hint}` : '';
    parts.push(`${where}${record.message.replace(/\s*[\r\n]+\s*/g, ' ')}${times}${next}`);
    return parts.join(' ');
}

let windowJournal: ProblemJournal | undefined;

/**
 * The journal of this window (one per extension host), created on first use.
 * Sources append to it; #49's serial releases and #14's worker fence journal
 * through it too.
 */
export function problemJournal(): ProblemJournal {
    windowJournal ??= new ProblemJournal();
    return windowJournal;
}
