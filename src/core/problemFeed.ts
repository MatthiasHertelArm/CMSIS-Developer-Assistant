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
 * How the problem journal (#48) reaches agents without their asking.
 *
 * In the window that runs a call, `runJournaled` registers the call in the
 * window's journal while it runs, and when the call fails or its wait runs
 * out, the records it produced ride along: at most five at warning or above,
 * as `data.problems`. The control server does this for forwarded calls, and
 * `journalLocally` for a server without a router.
 *
 * On the session's side, `ProblemNotices` remembers per window what the
 * agent has seen of its journal, from the counters each answer carries. The
 * first answer sets that baseline and `get_recent_problems` moves it. While
 * errors lie beyond it, `get_session_status` carries a count line, and one
 * successful result per new batch carries a note naming the call that shows
 * them. A window that sends no counters (2.5.0 and older) gets neither.
 *
 * `renderProblemsBlock` is the "Recent problems:" block the MCP result shows
 * under the text. Pure: no vscode.
 */

import type { IDebuggingHandler } from '../debuggingHandler';
import type { SessionHandlers } from '../debugMCPServer';
import { currentCallContext, runInCallContext, type CallContext } from './callContext';
import { DEBUG_OPS, type PackDocsOpName } from './opTable';
import {
    formatProblemLine,
    PROBLEM_SEVERITIES,
    PROBLEM_SOURCES,
    problemJson,
    type JournalCounters,
    type ProblemJournal,
    type ProblemRecord,
} from './problemJournal';
import { JsonObject, JsonValue, Refusal, ToolError, ToolReply, ToolText, isToolReply, toToolError } from './toolResult';

/** Records that ride along with one failed call. */
export const ATTACHED_MAX = 5;
/** The op of `get_recent_problems`, which moves the baseline. */
export const RECENT_PROBLEMS_OP = 'handleGetRecentProblems';
/** The op of `get_session_status`, which always carries the count line. */
export const SESSION_STATUS_OP = 'handleGetSessionStatus';

/** How a call ended in its window, and the journal's counters after it. */
export interface JournaledOutcome {
    outcome: ToolText | ToolError;
    counters: JournalCounters;
}

/** How the adapter tracker words a failed DAP response (src/utils/sessionStateTracker.ts). */
export function failedResponseMessage(command: string, reason: string): string {
    return `error response to '${command}': ${reason}`;
}

const FAILED_RESPONSE_PREFIX = /^error response to '[^']*': /;
/** Shorter texts are not compared: a few characters can occur in any message. */
const RESTATED_MIN_CHARS = 8;

/**
 * True for a record that only restates `failure`: the same code, or the same
 * words — a failed response whose reason the failure quotes, or one that
 * quotes the failure.
 */
function restates(record: ProblemRecord, failure: ToolError | undefined): boolean {
    if (failure === undefined) {
        return false;
    }
    if (record.code === failure.code) {
        return true;
    }
    const said = record.message.replace(FAILED_RESPONSE_PREFIX, '').trim();
    const told = failure.message.trim();
    if (said.length < RESTATED_MIN_CHARS || told.length < RESTATED_MIN_CHARS) {
        return said === told;
    }
    return told.includes(said) || said.includes(told);
}

/**
 * The records a failed or timed-out call takes along: from its start on, at
 * warning or above, not another call's, and not a restatement of the
 * failure. Errors before warnings, at most five, in journal order.
 */
function recordsFor(journal: ProblemJournal, startSeq: number, callId: string | undefined, failure?: ToolError): ProblemRecord[] {
    const own = journal.query({ sinceSeq: startSeq, minSeverity: 'warning' }).records
        .filter((record) => record.toolCallId === undefined || record.toolCallId === callId)
        .filter((record) => !restates(record, failure));
    const chosen = [...own.filter((record) => record.severity === 'error'), ...own.filter((record) => record.severity !== 'error')]
        .slice(0, ATTACHED_MAX);
    return chosen.sort((a, b) => a.seq - b.seq);
}

/** `failure` with `problems` added to its data; the same class, so a `Refusal` stays one. */
function failureWith(failure: ToolError, problems: readonly ProblemRecord[]): ToolError {
    if (problems.length === 0) {
        return failure;
    }
    const data: JsonObject = { ...(failure.data ?? {}), problems: problems.map(problemJson) };
    return failure instanceof Refusal
        ? new Refusal(failure.code, failure.message, failure.hint, data)
        : new ToolError(failure.code, failure.message, failure.hint, data);
}

function replyWith(reply: ToolReply, problems: readonly ProblemRecord[]): ToolReply {
    return problems.length === 0 ? reply : { ...reply, data: { ...(reply.data ?? {}), problems: problems.map(problemJson) } };
}

/**
 * Runs one op in this window: registered in the journal while it runs, in
 * `call`'s async context when there is one, with the records it produced
 * attached when it fails or its wait runs out. Never rejects: a failure is
 * the `outcome`, as a `ToolError`.
 */
export async function runJournaled(
    journal: ProblemJournal,
    call: CallContext | undefined,
    run: () => Promise<ToolText>,
): Promise<JournaledOutcome> {
    const flight = journal.beginCall(call?.callId);
    let outcome: ToolText | ToolError;
    try {
        const answer = await (call ? runInCallContext(call, run) : run());
        outcome = isToolReply(answer) && answer.status === 'timeout'
            ? replyWith(answer, recordsFor(journal, flight.startSeq, call?.callId))
            : answer;
    } catch (caught) {
        const failure = toToolError(caught);
        outcome = failureWith(failure, recordsFor(journal, flight.startSeq, call?.callId, failure));
    } finally {
        flight.end();
    }
    return { outcome, counters: journal.counters() };
}

// ── What the agent has seen ─────────────────────────────────────────────────

/** A window's journal as one session last saw it. */
interface Seen {
    /** The newest seq when the agent last looked. */
    seq: number;
    /** The error total when the agent last looked. */
    errors: number;
    /** The error total the last note or count line covered. */
    announced: number;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The note a successful result gets once per batch of new errors. */
export function newErrorsNote(count: number, since: number): string {
    return `Note: ${plural(count, 'new error')} in this window since you last looked — get_recent_problems {sinceSeq: ${since}}`;
}

/** The line `get_session_status` carries while errors lie beyond the baseline. */
export function newErrorsStatusLine(count: number, since: number): string {
    return `Problems: ${plural(count, 'new error')} since #${since} — get_recent_problems {sinceSeq: ${since}}`;
}

/** The error occurrences among the records attached to an outcome. */
function attachedErrors(outcome: ToolText | ToolError): number {
    const data = outcome instanceof ToolError ? outcome.data : isToolReply(outcome) ? outcome.data : undefined;
    const problems = data?.problems;
    if (!Array.isArray(problems)) {
        return 0;
    }
    let errors = 0;
    for (const problem of problems) {
        const fields = problem as { severity?: unknown; count?: unknown } | null;
        if (fields !== null && typeof fields === 'object' && fields.severity === 'error') {
            errors += typeof fields.count === 'number' && fields.count > 1 ? fields.count : 1;
        }
    }
    return errors;
}

function withLine(result: ToolText, line: string, separator: string): ToolText {
    return typeof result === 'string' ? `${result}${separator}${line}` : { ...result, text: `${result.text}${separator}${line}` };
}

/**
 * What one MCP session has seen of each window's journal, keyed by window
 * (the pid; one key for a server without a router).
 */
export class ProblemNotices {
    private readonly seen = new Map<string, Seen>();

    /**
     * The outcome of `op` in `window` as the agent gets it: with the count
     * line on `get_session_status`, or the one-time note on another
     * successful result, while errors lie beyond the baseline.
     */
    observe(window: string, counters: JournalCounters | undefined, op: string, outcome: ToolText | ToolError): ToolText | ToolError {
        if (!counters) {
            return outcome;
        }
        let seen = this.seen.get(window);
        if (!seen || counters.seq < seen.seq || counters.errors < seen.errors) {
            // The first answer sets the baseline; so does a journal that started over.
            seen = { seq: counters.seq, errors: counters.errors, announced: counters.errors };
            this.seen.set(window, seen);
        }
        if (op === RECENT_PROBLEMS_OP) {
            this.seen.set(window, { seq: counters.seq, errors: counters.errors, announced: counters.errors });
            return outcome;
        }
        const fresh = counters.errors - seen.errors;
        if (fresh <= 0) {
            return outcome;
        }
        const since = seen.seq + 1;
        if (outcome instanceof ToolError || (isToolReply(outcome) && outcome.status === 'timeout')) {
            // A result that shows every error not yet announced counts as the announcement.
            if (attachedErrors(outcome) >= counters.errors - seen.announced) {
                seen.announced = counters.errors;
            }
            return outcome;
        }
        if (op === SESSION_STATUS_OP) {
            seen.announced = counters.errors;
            return withLine(outcome, newErrorsStatusLine(fresh, since), '\n');
        }
        if (counters.errors > seen.announced) {
            seen.announced = counters.errors;
            return withLine(outcome, newErrorsNote(fresh, since), '\n\n');
        }
        return outcome;
    }
}

// ── The block under a result's text ─────────────────────────────────────────

const KNOWN_SOURCES: ReadonlySet<unknown> = new Set(PROBLEM_SOURCES);
const KNOWN_SEVERITIES: ReadonlySet<unknown> = new Set(PROBLEM_SEVERITIES);

/** A record as received in `data.problems`, possibly from another window; undefined for anything else. */
function recordOf(value: JsonValue): ProblemRecord | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const { seq, time, source, origin, severity, message } = value;
    if (typeof seq !== 'number' || !KNOWN_SOURCES.has(source) || !KNOWN_SEVERITIES.has(severity) || typeof message !== 'string') {
        return undefined;
    }
    const text = (field: JsonValue | undefined): string | undefined => (typeof field === 'string' ? field : undefined);
    const location = value.location;
    const where = typeof location === 'object' && location !== null && !Array.isArray(location) && typeof location.file === 'string'
        ? {
            file: location.file,
            ...(typeof location.line === 'number' ? { line: location.line } : {}),
            ...(typeof location.column === 'number' ? { column: location.column } : {}),
        }
        : undefined;
    return {
        seq,
        time: text(time) ?? '',
        source: source as ProblemRecord['source'],
        origin: text(origin) ?? '',
        severity: severity as ProblemRecord['severity'],
        message,
        ...(text(value.code) ? { code: text(value.code) as ProblemRecord['code'] } : {}),
        ...(where ? { location: where } : {}),
        ...(text(value.hint) ? { hint: text(value.hint) } : {}),
        ...(typeof value.count === 'number' ? { count: value.count } : {}),
    };
}

/**
 * `\nRecent problems:\n  #212 error …` for the records in `problems`, at most
 * five lines; empty when there are none or `problems` is not a list of them.
 */
export function renderProblemsBlock(problems: JsonValue | undefined): string {
    if (!Array.isArray(problems)) {
        return '';
    }
    const lines = problems.map(recordOf)
        .filter((record): record is ProblemRecord => record !== undefined)
        .slice(0, ATTACHED_MAX)
        .map((record) => `  ${formatProblemLine(record)}`);
    return lines.length === 0 ? '' : `\nRecent problems:\n${lines.join('\n')}`;
}

// ── A server without a router ───────────────────────────────────────────────

/** A debugging handler as a table of ops, the way `journalLocally` wraps it. */
type OpTable = Record<string, (args?: unknown) => Promise<ToolText>>;

/**
 * A session's handlers on a server without a router, every op run the way a
 * control server runs a forwarded one: journaled, with the problems of a
 * failure attached, and with this session's notices. The call context is the
 * one `MeasuredMcpServer` set for the call.
 */
export function journalLocally(handlers: SessionHandlers, journal: ProblemJournal): SessionHandlers {
    const notices = new ProblemNotices();
    const run = async (op: string, work: () => Promise<ToolText>): Promise<ToolText> => {
        const { outcome, counters } = await runJournaled(journal, currentCallContext(), work);
        const noticed = notices.observe('local', counters, op, outcome);
        if (noticed instanceof ToolError) {
            throw noticed;
        }
        return noticed;
    };
    const inner = handlers.debug as unknown as OpTable;
    const debug: OpTable = {};
    for (const op of DEBUG_OPS) {
        debug[op] = (args?: unknown) => run(op, () => {
            const method = inner[op];
            return typeof method === 'function' ? method.call(handlers.debug, args) : Promise.reject(new Error(`${op} is not implemented`));
        });
    }
    const docs = handlers.packDocs;
    return {
        debug: debug as unknown as IDebuggingHandler,
        serial: (op, args) => run(op, () => handlers.serial(op, args)),
        ...(docs ? { packDocs: (op: PackDocsOpName, args?: unknown) => run(op, () => docs(op, args)) } : {}),
    };
}
