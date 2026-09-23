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
 * The vocabulary of tool outcomes (#11). A handler answers with a `ToolText`
 * — a plain text, which means success, or a `ToolReply` whose status says the
 * call is still `running` or ran out of time — and fails by throwing a
 * `ToolError` that carries an `ErrorCode` and, where one exists, the next step
 * as `hint`. `MeasuredMcpServer` maps both onto the MCP result; the control
 * channel between windows carries them as they are.
 *
 * Errors that are not `ToolError`s (the executor's, VS Code's, Node's) get a
 * code, and for some families a hint, from an ordered table of the message
 * families the code base and the adapters produce. New code throws
 * `ToolError` directly; the table is the safety net.
 *
 * `wrapError` puts what failed in front of a cause. A `Refusal` — a state
 * gate that already names what it refused and why — is complete and passes
 * unchanged, and a plain cause never reads as `Error: …`.
 *
 * Pure: no `vscode`, no MCP SDK.
 */

/** Why a tool call failed, as agents and the metrics read it. */
export type ErrorCode =
    | 'NO_SESSION' | 'TARGET_RUNNING' | 'TIMEOUT' | 'AMBIGUOUS_WINDOW' | 'WINDOW_UNREACHABLE'
    | 'WORKER_TIMEOUT' | 'CMSIS_NO_SOLUTION' | 'TASK_FAILED' | 'PROBE_BUSY' | 'PROBE_WEDGED'
    | 'PORT_HELD' | 'TOOL_DISABLED' | 'INVALID_ARGUMENT' | 'INTERNAL';

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
    'NO_SESSION', 'TARGET_RUNNING', 'TIMEOUT', 'AMBIGUOUS_WINDOW', 'WINDOW_UNREACHABLE',
    'WORKER_TIMEOUT', 'CMSIS_NO_SOLUTION', 'TASK_FAILED', 'PROBE_BUSY', 'PROBE_WEDGED',
    'PORT_HELD', 'TOOL_DISABLED', 'INVALID_ARGUMENT', 'INTERNAL',
]);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * A failure with a code. `message` says what failed, `hint` what to do about
 * it, and `data` carries machine-readable detail such as the candidate windows
 * of `AMBIGUOUS_WINDOW`.
 */
export class ToolError extends Error {
    constructor(readonly code: ErrorCode, message: string, readonly hint?: string, readonly data?: JsonObject) {
        super(message);
    }
}

/**
 * A `ToolError` that is complete as it stands: it names the operation it
 * refused and why, and its hint says what to do, like the state gate's
 * "Cannot step over: session state is 'running'.". `wrapError` passes it on
 * unchanged instead of putting a second "<what failed>:" in front of it.
 */
export class Refusal extends ToolError {}

/** An answer that is not a plain success: still `running`, or out of time with no final result (`timeout`). */
export interface ToolReply {
    text: string;
    status: 'ok' | 'running' | 'timeout';
    data?: JsonObject;
}

/** What a handler resolves with; a bare string is a success. */
export type ToolText = string | ToolReply;

const REPLY_STATUSES: ReadonlySet<unknown> = new Set(['ok', 'running', 'timeout']);

/** True for a `ToolReply`, as received from another window: a text, a known status, and an object as data. */
export function isToolReply(value: unknown): value is ToolReply {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { text, status, data } = value as Record<string, unknown>;
    const dataFits = data === undefined || (typeof data === 'object' && data !== null && !Array.isArray(data));
    return typeof text === 'string' && REPLY_STATUSES.has(status) && dataFits;
}

/** A family of error messages, the code it means and, where one fits every member, the next step. */
interface MessageFamily {
    pattern: RegExp;
    code: ErrorCode;
    hint?: string;
}

/**
 * Message families of errors thrown without a code, in the order they are
 * tried; the first that matches decides. The quoted words are session states
 * as the state refusals name them (`session state is 'running'`).
 */
const MESSAGE_FAMILIES: readonly MessageFamily[] = [
    { pattern: /no-session|No active debug session|No debug session is running|'initializing'/, code: 'NO_SESSION' },
    { pattern: /'running'|target is running/, code: 'TARGET_RUNNING' },
    { pattern: /'unresponsive'|HardwareTimeoutError|timed out after/, code: 'TIMEOUT' },
    { pattern: /no active (CMSIS )?solution/i, code: 'CMSIS_NO_SOLUTION' },
    { pattern: /Invalid line|must be a 1-based|Unbalanced|Empty interpolation|No location given|Could not find any lines/, code: 'INVALID_ARGUMENT' },
    // GDB's answer to a thread id it does not know, passed on by the adapter (get_call_stack { threadId }).
    { pattern: /Invalid thread id/, code: 'INVALID_ARGUMENT', hint: 'Call get_threads: it lists the current thread ids.' },
];

function familyOf(message: string): MessageFamily | undefined {
    return MESSAGE_FAMILIES.find((family) => family.pattern.test(message));
}

/** The code of an error that was thrown without one; `INTERNAL` when no family matches. */
export function classifyError(message: string): ErrorCode {
    return familyOf(message)?.code ?? 'INTERNAL';
}

/** True for a code this version knows, as received from another window. */
export function isErrorCode(value: unknown): value is ErrorCode {
    return typeof value === 'string' && KNOWN_CODES.has(value);
}

/**
 * A caught value as a string: `Name: message` for an Error, its string form
 * otherwise. Never throws, not even for an object without a string form.
 */
function described(caught: unknown): string {
    try {
        return String(caught);
    } catch {
        return Object.prototype.toString.call(caught);
    }
}

/** A `ToolError` passes unchanged; anything else keeps its message and gets a classified code and hint. */
export function toToolError(err: unknown): ToolError {
    if (err instanceof ToolError) {
        return err;
    }
    // The class name takes part in the classification: `HardwareTimeoutError: …`.
    const family = familyOf(described(err));
    return new ToolError(family?.code ?? 'INTERNAL', err instanceof Error ? err.message : described(err), family?.hint);
}

/**
 * A caught value as the cause of a wrapped message: a plain `Error` or a
 * `ToolError` by its message alone, since `Error: ` says nothing; a named
 * subclass as `Name: message`, where the name says what happened
 * (`HardwareTimeoutError: …`); anything else as its string form.
 */
function causeText(caught: unknown): string {
    if (caught instanceof ToolError || (caught instanceof Error && caught.name === 'Error')) {
        return caught.message;
    }
    return described(caught);
}

/**
 * Put `prefix` before a caught error, keeping its code, hint and data. A
 * `Refusal` is complete already and comes back unchanged.
 */
export function wrapError(prefix: string, err: unknown): ToolError {
    if (err instanceof Refusal) {
        return err;
    }
    const typed = toToolError(err);
    return new ToolError(typed.code, `${prefix}: ${causeText(err)}`, typed.hint, typed.data);
}

/** The text of an outcome, for a peer or a log line that takes a string only. */
export function textOf(result: ToolText): string {
    return typeof result === 'string' ? result : result.text;
}

/** An error's message with its hint on the next line: the text of a failed call without its code. */
export function errorDetail(err: ToolError): string {
    return err.hint ? `${err.message}\n${err.hint}` : err.message;
}

/** The text an agent reads for a failed call: `[CODE] message`, then the hint on its own line. */
export function errorText(err: ToolError): string {
    return `[${err.code}] ${errorDetail(err)}`;
}

/** 2.3.10 fences: a failed body, and the cap of the debugging fence. */
const LEGACY_FENCE_FAILURE = /^Error in '[^'\n]+': ([\s\S]*)$/;
const LEGACY_FENCE_CAP = /^'[^'\n]+' did not complete within \d+ ms \(handler-level cap\)\./;
/** 2.3.10 documentation and build-artefact fence: `<tool> failed: …` and `<tool> timed out after N ms. …`. */
const LEGACY_RUN_FAILURE = /^[a-z]+(?:_[a-z]+)+ failed: ([\s\S]*)$/;
const LEGACY_RUN_CAP = /^[a-z]+(?:_[a-z]+)+ timed out after \d+ ms\. /;

/**
 * A result a 2.3.10 window returned as text, in today's terms: a fenced
 * failure becomes a classified `ToolError` (returned, not thrown), a fence
 * cap a `timeout` reply, and everything else stays the text it was.
 */
export function upgradeLegacyText(text: string): ToolText | ToolError {
    const failure = LEGACY_FENCE_FAILURE.exec(text) ?? LEGACY_RUN_FAILURE.exec(text);
    if (failure) {
        return new ToolError(classifyError(failure[1]), failure[1]);
    }
    if (LEGACY_FENCE_CAP.test(text) || LEGACY_RUN_CAP.test(text)) {
        return { text, status: 'timeout' };
    }
    return text;
}
