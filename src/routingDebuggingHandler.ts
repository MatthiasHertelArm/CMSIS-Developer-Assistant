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
 * The debugging handler the router window gives each MCP session. It runs
 * nothing itself: every call goes over HTTP to the control server of the
 * window that owns the target, so one MCP URL reaches whichever window holds
 * the board, and two sessions can drive two boards at once.
 *
 * The target comes from a fixed ladder — the call's `window` argument, its
 * path, the pin, the session's established target, the sole window with a
 * debug session, the sole window — and a tie is refused with a listing,
 * never guessed. The two routing tools, `list_debug_windows` and
 * `select_debug_window`, are answered here.
 *
 * The worker's outcome comes back typed (#11): its result as it is, its
 * `ToolError` with code and hint, and the session keeps its target either
 * way. Only a failure of the channel itself — nothing listening, a dropped
 * connection, a wrong token, an answer that is not a control reply — makes
 * the session forget the window, as `WINDOW_UNREACHABLE`. A window that does
 * not answer in time is busy, not gone: `WORKER_TIMEOUT`, target kept.
 */

import * as http from 'http';
import type { IDebuggingHandler } from './debuggingHandler';
import {
    CONTROL_ENVELOPE_HEADER,
    CONTROL_ENVELOPE_VERSION,
    CONTROL_RESPONSE_MAX_BYTES,
    DEBUG_OPS,
    DebugOpName,
    TargetHint,
    WINDOW_ARGUMENT,
    forwardTimeoutMs,
    targetHintOf,
} from './core/opTable';
import {
    JsonObject,
    ToolError,
    ToolText,
    isErrorCode,
    isToolReply,
    toToolError,
    upgradeLegacyText,
} from './core/toolResult';
import {
    describeWindow,
    ResolutionReason,
    WindowRegistration,
    WorkspaceRegistry,
} from './utils/workspaceRegistry';
import { logger } from './utils/logger';

/** Must match the header the control server checks. */
const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
/** How much of an unparsable reply the error quotes. */
const MALFORMED_PREVIEW_CHARS = 200;

const NO_WINDOW_ERROR = 'No CMSIS Developer Assistant-enabled VS Code window is currently registered.';
const NO_WINDOW_HINT = 'Open your project in VS Code and wait for the extension to activate.';
const NO_WINDOW_LISTING = 'No CMSIS Developer Assistant-enabled VS Code windows are currently registered.';
const SELECT_NEEDS_ARGUMENT = 'Pass either pid or workspaceFolder.';
const SELECT_HINT = 'Call list_debug_windows to see the options.';
const LISTING_FOOTER = 'Pin one for this session with select_debug_window({ pid }) when the automatic choice is wrong, '
    + 'or pass window to a tool that takes it.';
const UNREACHABLE_HINT = 'It may have been closed. Call list_debug_windows to see what is still open.';
const BUSY_HINT = 'The call may still be running there. Call get_session_status to see the state of that window, then retry.';

/** One method per debugging op; the class gets them from the op table below. */
type DebugForwarders = { [Op in DebugOpName]: (args?: unknown) => Promise<ToolText> };

interface Resolved {
    entry: WindowRegistration;
    reason: ResolutionReason;
}

/**
 * The control channel itself failed: nothing listens on the port, the
 * connection dropped, the token is stale, or the answer is not a control
 * reply. The only failure after which the session forgets the window.
 */
class ChannelFailure extends Error {}

/** A window as `AMBIGUOUS_WINDOW` and a `window` argument that matches nothing list it in `data.candidates`. */
function candidateOf(w: WindowRegistration): JsonObject {
    const candidate: JsonObject = {
        pid: w.pid,
        name: w.name,
        workspaceFolders: Array.isArray(w.workspaceFolders) ? [...w.workspaceFolders] : [],
        hasActiveSession: w.hasActiveSession === true,
    };
    // Windows of 2.5.0 and earlier publish no role.
    if (w.role === 'router' || w.role === 'worker') {
        candidate.role = w.role;
    }
    return candidate;
}

/** The arguments as the worker gets them: without `window`, which only the router reads. */
function withoutWindow(args: unknown): unknown {
    if (typeof args !== 'object' || args === null || !Object.prototype.hasOwnProperty.call(args, WINDOW_ARGUMENT)) {
        return args;
    }
    const rest: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    delete rest[WINDOW_ARGUMENT];
    return rest;
}

/** The indented window list inside routing errors and the selection miss. */
function bulletList(windows: WindowRegistration[]): string {
    return windows.map((w) => `  • ${describeWindow(w)}`).join('\n');
}

/** Declaration merge: the class instance carries one forwarder per `DEBUG_OPS` name. */
export interface RoutingDebuggingHandler extends DebugForwarders {}

export class RoutingDebuggingHandler implements IDebuggingHandler {
    static {
        // Generated from the op table rather than written out: a tool added to
        // IDebuggingHandler must be added to DEBUG_OPS (opTable checks that),
        // and it is then routable here with no further change.
        for (const op of DEBUG_OPS) {
            Object.defineProperty(RoutingDebuggingHandler.prototype, op, {
                configurable: true,
                writable: true,
                value(this: RoutingDebuggingHandler, args?: unknown): Promise<ToolText> {
                    return this.relay(op, args);
                },
            });
        }
    }

    /** The window this session last reached; reused while it stays registered on the same port. */
    private target: WindowRegistration | undefined;
    /** Set by `select_debug_window`; only a later selection replaces it. */
    private pinnedPid: number | undefined;

    /**
     * @param defaultToolMs the tool timeout a call gets without its own `timeoutMs`.
     * @param answerWithinMs how long a window may stay silent before the call ends
     *   as `WORKER_TIMEOUT`; by default `forwardTimeoutMs` (tests shorten it).
     */
    constructor(
        private readonly registry: WorkspaceRegistry,
        defaultToolMs: number,
        private readonly answerWithinMs: (op: string, args: unknown) => number = (op, args) => forwardTimeoutMs(op, args, defaultToolMs),
    ) {}

    serialOp(op: string, args?: unknown): Promise<ToolText> {
        return this.relay(op, args);
    }

    packDocsOp(op: string, args?: unknown): Promise<ToolText> {
        return this.relay(op, args);
    }

    /** The `list_debug_windows` text. Changes nothing. */
    listDebugWindows(): string {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return NO_WINDOW_LISTING;
        }
        const rows = windows.map((w) => `• ${describeWindow(w)}${this.markers(w)}`);
        return `Registered VS Code windows:\n${rows.join('\n')}\n\n${LISTING_FOOTER}`;
    }

    /**
     * The `select_debug_window` text; on a match the window is pinned for this
     * session. A call without a selector, or one that matches no window, is
     * refused with `INVALID_ARGUMENT`.
     */
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string {
        const { pid, workspaceFolder } = args;
        if (pid === undefined && !workspaceFolder) {
            throw new ToolError('INVALID_ARGUMENT', SELECT_NEEDS_ARGUMENT, SELECT_HINT);
        }
        const chosen = pid !== undefined
            ? this.registry.findByPid(pid)
            : this.registry.findByWorkspaceFolder(workspaceFolder as string);
        if (!chosen) {
            const wanted = pid !== undefined ? `pid=${pid}` : `"${workspaceFolder}"`;
            const windows = this.registry.list();
            const known = windows.length > 0
                ? `Currently registered:\n${bulletList(windows)}`
                : 'No windows are registered.';
            throw new ToolError('INVALID_ARGUMENT', `No registered window matches ${wanted}.`, known);
        }
        this.pinnedPid = chosen.pid;
        this.target = chosen;
        return `This session is now pinned to: ${describeWindow(chosen)}\n`
            + 'Every subsequent tool call runs in that window until you pin another.';
    }

    /** ` ← current target, pinned` (whichever apply) for a listing row. */
    private markers(w: WindowRegistration): string {
        const marks: string[] = [];
        if (this.target !== undefined && this.target.pid === w.pid) {
            marks.push('current target');
        }
        if (this.pinnedPid === w.pid) {
            marks.push('pinned');
        }
        return marks.length > 0 ? `  ← ${marks.join(', ')}` : '';
    }

    /**
     * One forwarded call: pick the window, send, and hand back what it
     * answered. The worker's own failure passes as its `ToolError`; only a
     * failed channel drops the window as this session's target.
     */
    private async relay(op: string, args: unknown): Promise<ToolText> {
        const given = args === undefined ? {} : args;
        const { entry, reason } = this.resolveTarget(targetHintOf(given));
        const sent = withoutWindow(given);
        logger.info(`Routing ${op} → pid=${entry.pid} port=${entry.controlPort} (via ${reason})`);
        try {
            return await this.post(entry, op, sent);
        } catch (failure) {
            if (!(failure instanceof ChannelFailure)) {
                throw toToolError(failure);
            }
            if (this.target !== undefined && this.target.pid === entry.pid) {
                this.target = undefined;
            }
            throw new ToolError('WINDOW_UNREACHABLE',
                `Could not reach the VS Code window handling this session (pid=${entry.pid}): ${failure.message}`, UNREACHABLE_HINT);
        }
    }

    /** The resolution ladder; the first rung that applies decides, and a miss throws. */
    private resolveTarget(hint: TargetHint | undefined): Resolved {
        if (hint !== undefined && hint.source === 'window') {
            // Named for this call, and like a path it re-aims the session's later path-less calls.
            const named = this.namedWindow(hint);
            this.target = named;
            return { entry: named, reason: 'window-arg' };
        }
        if (hint !== undefined) {
            // A named file must never run in another window, cached or pinned.
            const owner = this.registry.findByPath(hint.path);
            if (!owner) {
                throw this.unroutable(hint.path);
            }
            this.target = owner;
            return { entry: owner, reason: 'path' };
        }
        if (this.pinnedPid !== undefined) {
            const pinned = this.registry.findByPid(this.pinnedPid);
            if (!pinned) {
                throw new ToolError('WINDOW_UNREACHABLE',
                    `The window pinned with select_debug_window (pid=${this.pinnedPid}) is gone.`,
                    'Pin another with select_debug_window, or call list_debug_windows to see what is open.');
            }
            this.target = pinned;
            return { entry: pinned, reason: 'pinned' };
        }
        if (this.target !== undefined && this.registry.isLive(this.target)) {
            return { entry: this.target, reason: 'cached' };
        }
        this.target = undefined;
        const debugging = this.registry.findSoleActiveSession();
        if (debugging) {
            this.target = debugging;
            return { entry: debugging, reason: 'active-session' };
        }
        const only = this.registry.findSoleWindow();
        if (only) {
            this.target = only;
            return { entry: only, reason: 'only-window' };
        }
        throw this.unroutable(undefined);
    }

    /** The window a `window` argument names; one that matches nothing is refused with the candidates. */
    private namedWindow(hint: TargetHint & { source: 'window' }): WindowRegistration {
        const found = 'pid' in hint ? this.registry.findByPid(hint.pid) : this.registry.findByPath(hint.path);
        if (found) {
            return found;
        }
        const windows = this.registry.list();
        if (windows.length === 0) {
            throw new ToolError('WINDOW_UNREACHABLE', NO_WINDOW_ERROR, NO_WINDOW_HINT);
        }
        const given = 'pid' in hint ? String(hint.pid) : hint.path;
        throw new ToolError('INVALID_ARGUMENT', `The window argument "${given}" matches no open VS Code window.`,
            `Pass the pid of one of these, or a path inside its workspace:\n${bulletList(windows)}`,
            { candidates: windows.map(candidateOf) });
    }

    /**
     * Why no window could take the call, from a fresh look at the registry:
     * no window at all, a path outside every workspace, or a tie, which lists
     * every registered window as a candidate.
     */
    private unroutable(hint: string | undefined): ToolError {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return new ToolError('WINDOW_UNREACHABLE', NO_WINDOW_ERROR, NO_WINDOW_HINT);
        }
        const listing = bulletList(windows);
        if (hint !== undefined) {
            return new ToolError('INVALID_ARGUMENT', `No open VS Code window has "${hint}" inside its workspace.`,
                `Open the folder containing it, or pass a path that is inside one of these:\n${listing}`);
        }
        const candidates = { candidates: windows.map(candidateOf) };
        const debugging = windows.filter((w) => w.hasActiveSession).length;
        if (debugging > 1) {
            return new ToolError('AMBIGUOUS_WINDOW',
                `${debugging} VS Code windows have an active debug session, so there is no unambiguous target for this call.`,
                `Pick one with select_debug_window:\n${listing}`, candidates);
        }
        return new ToolError('AMBIGUOUS_WINDOW',
            `${windows.length} VS Code windows are registered and none has an active debug session, `
                + 'so there is no unambiguous target for this call.',
            `Start a session in one with cmsis_action load_and_debug and window set to its pid, `
                + `or pin one with select_debug_window:\n${listing}`, candidates);
    }

    /**
     * POST `{op, args}` to the window's control server, asking for the typed
     * envelope, and resolve with its outcome. Rejects with the worker's
     * `ToolError`, with `WORKER_TIMEOUT` when the window stays silent, and with
     * a `ChannelFailure` when the channel itself fails.
     */
    private post(entry: WindowRegistration, op: string, args: unknown): Promise<ToolText> {
        const body = Buffer.from(JSON.stringify({ op, args }), 'utf8');
        const idleLimitMs = this.answerWithinMs(op, args);
        return new Promise<ToolText>((resolve, reject) => {
            const outgoing = http.request({
                host: '127.0.0.1',
                port: entry.controlPort,
                path: '/op',
                method: 'POST',
                // Socket inactivity, not a wall-clock deadline.
                timeout: idleLimitMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    [TOKEN_HEADER]: entry.controlToken,
                    [CONTROL_ENVELOPE_HEADER]: String(CONTROL_ENVELOPE_VERSION),
                },
            }, (incoming) => {
                const parts: Buffer[] = [];
                let size = 0;
                let refused = false;
                incoming.on('data', (chunk: Buffer) => {
                    if (refused) {
                        return;
                    }
                    size += chunk.length;
                    if (size > CONTROL_RESPONSE_MAX_BYTES) {
                        refused = true;
                        parts.length = 0;
                        // The window answered, only too much: it stays the target.
                        reject(new ToolError('INTERNAL', `control response above ${CONTROL_RESPONSE_MAX_BYTES} bytes from pid ${entry.pid}`));
                        outgoing.destroy();
                        return;
                    }
                    parts.push(chunk);
                });
                incoming.on('error', (fault: Error) => reject(new ChannelFailure(fault.message)));
                incoming.on('end', () => {
                    if (refused) {
                        return;
                    }
                    try {
                        const typed = incoming.headers[CONTROL_ENVELOPE_HEADER] !== undefined;
                        resolve(readReply(incoming.statusCode, typed, Buffer.concat(parts).toString('utf8')));
                    } catch (failure) {
                        reject(failure);
                    }
                });
            });
            outgoing.on('timeout', () => {
                reject(new ToolError('WORKER_TIMEOUT',
                    `The VS Code window handling this session (pid=${entry.pid}) sent no response within `
                    + `${Math.round(idleLimitMs / 1000)}s — it may be busy or wedged.`, BUSY_HINT));
                outgoing.destroy();
            });
            outgoing.on('error', (fault: Error) => reject(new ChannelFailure(fault.message)));
            outgoing.end(body);
        });
    }
}

/** The fields of a typed error reply, validated one by one. */
function typedError(reported: Record<string, unknown>): ToolError {
    const { message, code, hint, data } = reported;
    const detail = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as JsonObject : undefined;
    return new ToolError(isErrorCode(code) ? code : 'INTERNAL',
        typeof message === 'string' ? message : 'The window reported a failure without a message.',
        typeof hint === 'string' ? hint : undefined, detail);
}

/**
 * A complete control-server reply as the call's outcome, or the failure it
 * reports, thrown. `typed` says the worker marked the reply with the
 * envelope header; a string result without it comes from a 2.3.10 worker
 * and is read with `upgradeLegacyText`.
 */
function readReply(status: number | undefined, typed: boolean, body: string): ToolText {
    if (status === 403 || status === 404) {
        // A stale token, or something else listening on the port.
        throw new ChannelFailure(`control server returned ${status}`);
    }
    let reply: unknown;
    try {
        reply = body.length === 0 ? {} : JSON.parse(body);
    } catch {
        reply = null;
    }
    if (typeof reply !== 'object' || reply === null) {
        throw new ChannelFailure(`malformed control response: ${body.slice(0, MALFORMED_PREVIEW_CHARS)}`);
    }
    const { result, error } = reply as { result?: unknown; error?: unknown };
    if (status === 413) {
        throw new ToolError('INVALID_ARGUMENT', typeof error === 'string' ? error : 'control request too large');
    }
    if (status === 200 && typeof result === 'string') {
        if (typed) {
            return result;
        }
        const upgraded = upgradeLegacyText(result);
        if (upgraded instanceof ToolError) {
            throw upgraded;
        }
        return upgraded;
    }
    if (status === 200 && isToolReply(result)) {
        return result;
    }
    if (status === 500 && typeof error === 'string') {
        throw toToolError(error);
    }
    if (status === 500 && typeof error === 'object' && error !== null) {
        throw typedError(error as Record<string, unknown>);
    }
    throw new ChannelFailure(status === 200
        ? `malformed control response: ${body.slice(0, MALFORMED_PREVIEW_CHARS)}`
        : `control server returned ${status}`);
}
