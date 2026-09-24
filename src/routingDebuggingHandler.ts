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
 * path, the pin, the session's established target, the default target the
 * user chose in VS Code, the sole window with a debug session, the sole
 * window — and a tie is refused with a listing, never guessed. A newly
 * chosen default drops the established target of every session, never a
 * pin (#16). The two routing tools, `list_debug_windows` and
 * `select_debug_window`, are answered here.
 *
 * The worker's outcome comes back typed (#11): its result as it is, its
 * `ToolError` with code and hint, and the session keeps its target either
 * way. Only a failure of the channel itself — nothing listening, a dropped
 * connection, a wrong token, an answer that is not a control reply — makes
 * the session forget the window, as `WINDOW_UNREACHABLE`. A window that does
 * not answer in time is busy, not gone: `WORKER_TIMEOUT`, target kept.
 *
 * The router also watches the window (#14). The envelope names the forward's
 * budget (`budgetMs`), so the worker's fence answers first. A window that
 * has not answered for 30 s is asked `health` before the call goes out, and
 * a forward still pending after 15 s asks every 15 s; a window that stays
 * silent for 2 s, or twice in a row while a call runs, is `WINDOW_UNREACHABLE`
 * and forgotten: its extension host is blocked, or it closed. A window that
 * answers health keeps its whole budget, however long a build takes. When the
 * budget runs out, `WORKER_TIMEOUT` keeps the target only if the last health
 * check passed. Any answer to `health` counts, since 2.5.0 answers it 500.
 *
 * The envelope carries the call's id and MCP session id from the call
 * context (#48), and the worker's reply its problem-journal counters. From
 * those the session's `ProblemNotices` add the count line to
 * `get_session_status` and a one-time note about new errors to a successful
 * result, per window; a worker that sends no counters gets neither.
 *
 * The session remembers the windows it forwarded to. When it ends, the MCP
 * server calls `sessionEnded`, which tells each of them with the internal op
 * `sessionEnded`, so they release the serial ports the session held (#49).
 */

import * as http from 'http';
import type { IDebuggingHandler } from './debuggingHandler';
import { currentCallContext } from './core/callContext';
import {
    CHANNEL_TIMINGS,
    CONTROL_ENVELOPE_HEADER,
    CONTROL_ENVELOPE_VERSION,
    CONTROL_RESPONSE_MAX_BYTES,
    DEBUG_OPS,
    DebugOpName,
    ForwardTimings,
    InternalOpName,
    TargetHint,
    WINDOW_ARGUMENT,
    forwardTimeoutMs,
    targetHintOf,
} from './core/opTable';
import { ProblemNotices } from './core/problemFeed';
import type { JournalCounters } from './core/problemJournal';
import {
    JsonObject,
    ToolError,
    ToolText,
    isErrorCode,
    isToolReply,
    textOf,
    toToolError,
    upgradeLegacyText,
} from './core/toolResult';
import { probeLoopback, secondsText } from './core/windowHealth';
import { toolNameOf, type SessionTarget } from './core/windowStatus';
import {
    DefaultTarget,
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
/** How an agent asks the user to choose: the status-bar item's click opens Select Target Window. */
const ASK_THE_USER = 'or ask the user to pick one: click "CDA" in the VS Code status bar → Select Target Window.';
const DEFAULT_MARK = 'default target (set in VS Code)';
const UNREACHABLE_HINT = 'It may have been closed. Call list_debug_windows to see what is still open.';
const BUSY_HINT = 'The call may still be running there. Call get_session_status to see the state of that window, then retry.';
/** How long a window may take to hear that a session ended; nobody waits for the answer. */
const SESSION_END_TIMEOUT_MS = 2_000;
/** After a window stopped answering health checks (#14). */
const SILENT_HINT = 'Call list_debug_windows; if it persists, reload that window.';
/** The internal op that asks a window whether its extension host runs. */
const HEALTH_OP: InternalOpName = 'health';
/** Health checks a pending forward may miss in a row before it is given up. */
const WATCHDOG_MISSES = 2;

/** One method per debugging op; the class gets them from the op table below. */
type DebugForwarders = { [Op in DebugOpName]: (args?: unknown) => Promise<ToolText> };

/**
 * How the router times a forward and watches the window it goes to (#14).
 * Every field has a default; the tests shorten them.
 */
export interface RoutingOptions {
    /** A forward's budget; `forwardTimeoutMs` with `forward` and the tool timeout by default. */
    budgetMs?: (op: string, args: unknown) => number;
    /** The margin and slow-op floor `forwardTimeoutMs` uses when `budgetMs` is not given. */
    forward?: ForwardTimings;
    /** Silence from a window after which a call asks it `health` first; 30 s. */
    quietMs?: number;
    /** How long a health check may take; 2 s. */
    healthTimeoutMs?: number;
    /** How often a pending forward checks its window's health, first after this long; 15 s. */
    watchdogEveryMs?: number;
    /** When each window last answered, by pid; the router window shares one map among its sessions. */
    heard?: Map<number, number>;
}

/** What a health check found: a window that answered, one that stayed silent, or a channel that failed. */
type HealthProbe = { kind: 'alive' } | { kind: 'silent' } | { kind: 'failed'; reason: string };

interface Resolved {
    entry: WindowRegistration;
    reason: ResolutionReason;
}

/** What a window answered: its outcome, a failure included, and its journal counters when it sent them. */
interface WorkerAnswer {
    outcome: ToolText | ToolError;
    counters?: JournalCounters;
}

/**
 * The control channel itself failed: nothing listens on the port, the
 * connection dropped, the token is stale, the answer is not a control reply,
 * or the window stopped answering health checks. The only failure after
 * which the session forgets the window; `reported` is what the agent gets
 * instead of the generic "Could not reach …".
 */
class ChannelFailure extends Error {
    constructor(message: string, readonly reported?: ToolError) {
        super(message);
    }
}

/** How a window is named in the watchdog's texts: pid, and the workspace name when it has one. */
function windowLabel(entry: WindowRegistration): string {
    return typeof entry.name === 'string' && entry.name.length > 0 ? `pid ${entry.pid} (${entry.name})` : `pid ${entry.pid}`;
}

/** A health check before the call went unanswered (#14). */
function silentBeforeCall(entry: WindowRegistration, healthTimeoutMs: number): ChannelFailure {
    return new ChannelFailure('no answer to a health check', new ToolError('WINDOW_UNREACHABLE',
        `The VS Code window ${windowLabel(entry)} did not answer a health check within ${secondsText(healthTimeoutMs)} — `
            + 'its extension host is blocked, or the window closed.', SILENT_HINT));
}

/** Health checks while the call ran went unanswered (#14). */
function silentDuringCall(entry: WindowRegistration, op: string, why: string): ChannelFailure {
    return new ChannelFailure(why, new ToolError('WINDOW_UNREACHABLE',
        `The VS Code window ${windowLabel(entry)} ${why} while '${toolNameOf(op)}' ran there — `
            + 'its extension host is blocked, or the window closed.',
        `${SILENT_HINT} The call may still finish there once the window answers again; get_session_status shows its state.`));
}

/**
 * Ask a window `health`, on a connection of its own. Any answer within
 * `timeoutMs` counts as alive, a 500 of a 2.5.0 window included: it shows
 * that the window's event loop runs.
 */
async function probeHealth(entry: WindowRegistration, timeoutMs: number): Promise<HealthProbe> {
    const body = Buffer.from(JSON.stringify({ op: HEALTH_OP, args: {} }), 'utf8');
    const outcome = await probeLoopback({
        port: entry.controlPort,
        path: '/op',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            [TOKEN_HEADER]: entry.controlToken,
            [CONTROL_ENVELOPE_HEADER]: String(CONTROL_ENVELOPE_VERSION),
        },
    }, body, timeoutMs);
    return outcome.kind === 'answered' ? { kind: 'alive' } : outcome;
}

/** A window as `AMBIGUOUS_WINDOW` and a `window` argument that matches nothing list it in `data.candidates`. */
function candidateOf(w: WindowRegistration, defaultPid: number | undefined): JsonObject {
    const candidate: JsonObject = {
        pid: w.pid,
        name: w.name,
        workspaceFolders: Array.isArray(w.workspaceFolders) ? [...w.workspaceFolders] : [],
        hasActiveSession: w.hasActiveSession === true,
        isDefault: w.pid === defaultPid,
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
    /** The rung that chose `target`, for the status bar; a reuse keeps it. */
    private targetReason: ResolutionReason | undefined;
    /** Set by `select_debug_window`; only a later selection replaces it. */
    private pinnedPid: number | undefined;
    /** `setAt` of the default target this session last saw; a new one drops `target`. */
    private defaultSetAt: number | undefined;
    /** What this session has seen of each window's problem journal (#48), by pid. */
    private readonly notices = new ProblemNotices();
    /** The windows this session forwarded a call to, by pid: those told when it ends (#49). */
    private readonly forwardedTo = new Set<number>();
    /** A forward's budget: how long a window may take before the call ends as `WORKER_TIMEOUT`. */
    private readonly budgetMs: (op: string, args: unknown) => number;
    private readonly quietMs: number;
    private readonly healthTimeoutMs: number;
    private readonly watchdogEveryMs: number;
    /** When each window last answered, by pid (#14). */
    private readonly heard: Map<number, number>;

    /**
     * @param defaultToolMs the tool timeout a call gets without its own `timeoutMs`.
     * @param options the budget and the health checks (#14); tests shorten them.
     */
    constructor(
        private readonly registry: WorkspaceRegistry,
        defaultToolMs: number,
        options: RoutingOptions = {},
    ) {
        this.budgetMs = options.budgetMs ?? ((op, args) => forwardTimeoutMs(op, args, defaultToolMs, options.forward));
        this.quietMs = options.quietMs ?? CHANNEL_TIMINGS.quietMs;
        this.healthTimeoutMs = options.healthTimeoutMs ?? CHANNEL_TIMINGS.healthTimeoutMs;
        this.watchdogEveryMs = options.watchdogEveryMs ?? CHANNEL_TIMINGS.watchdogEveryMs;
        this.heard = options.heard ?? new Map<number, number>();
    }

    serialOp(op: string, args?: unknown): Promise<ToolText> {
        return this.relay(op, args);
    }

    packDocsOp(op: string, args?: unknown): Promise<ToolText> {
        return this.relay(op, args);
    }

    /**
     * The `list_debug_windows` text, marking this session's target, its pin
     * and the default target. Changes nothing, except that a newly chosen
     * default drops the session's target, as it would on the next call.
     */
    listDebugWindows(): string {
        const chosen = this.followDefault();
        const windows = this.registry.list();
        if (windows.length === 0) {
            return NO_WINDOW_LISTING;
        }
        const defaultPid = chosen === undefined ? undefined : this.registry.findDefaultTarget(chosen, windows)?.pid;
        const rows = windows.map((w) => `• ${describeWindow(w)}${this.markers(w, defaultPid)}`);
        return `Registered VS Code windows:\n${rows.join('\n')}\n\n${LISTING_FOOTER}`;
    }

    /**
     * The `select_debug_window` text; on a match the window is pinned for this
     * session, over the default target, which the text names when one is set.
     * A call without a selector, or one that matches no window, is refused
     * with `INVALID_ARGUMENT`.
     */
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string {
        const { pid, workspaceFolder } = args;
        if (pid === undefined && !workspaceFolder) {
            throw new ToolError('INVALID_ARGUMENT', SELECT_NEEDS_ARGUMENT, SELECT_HINT);
        }
        const chosenDefault = this.followDefault();
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
        this.settle(chosen, 'pinned');
        const pinned = `This session is now pinned to: ${describeWindow(chosen)}\n`
            + 'Every subsequent tool call runs in that window until you pin another.';
        const preferred = chosenDefault === undefined ? undefined : this.registry.findDefaultTarget(chosenDefault);
        if (preferred === undefined) {
            return pinned;
        }
        return preferred.pid === chosen.pid
            ? `${pinned}\nIt is also the default target the user set in VS Code.`
            : `${pinned}\nThe user set pid=${preferred.pid} (${preferred.name}) as the default target in VS Code; `
                + 'this pin overrides it for this session.';
    }

    /**
     * The MCP session `sessionId`, which this handler served, ended (#49):
     * tell every window it forwarded to, all at once, so each releases the
     * serial port and the Serial Monitor subscription the session held there.
     * Nobody waits for more than 2 s; a window that is gone, silent, or of a
     * version without the op ("not a known operation") is passed by. Never
     * rejects.
     */
    async sessionEnded(sessionId: string): Promise<void> {
        const pids = [...this.forwardedTo];
        this.forwardedTo.clear();
        await Promise.all(pids.map(async (pid) => {
            const entry = this.registry.findByPid(pid);
            if (entry === undefined) {
                return;
            }
            try {
                const { outcome } = await this.post(entry, 'sessionEnded', { sessionId }, SESSION_END_TIMEOUT_MS);
                logger.debug(`Session end told to pid=${pid}: ${outcome instanceof ToolError ? outcome.message : textOf(outcome)}`);
            } catch (failure) {
                logger.debug(`Session end not told to pid=${pid}`, failure);
            }
        }));
    }

    /**
     * Where this session's path-less calls go and the rung that chose the
     * window, for the router's status bar (#16); undefined before the first
     * call and after the window went away. Reads nothing from disk.
     */
    describeTarget(): SessionTarget | undefined {
        if (this.target === undefined || this.targetReason === undefined) {
            return undefined;
        }
        return { pid: this.target.pid, name: this.target.name, reason: this.targetReason };
    }

    /** ` ← current target, pinned, default target (set in VS Code)` (whichever apply) for a listing row. */
    private markers(w: WindowRegistration, defaultPid: number | undefined): string {
        const marks: string[] = [];
        if (this.target !== undefined && this.target.pid === w.pid) {
            marks.push('current target');
        }
        if (this.pinnedPid === w.pid) {
            marks.push('pinned');
        }
        if (defaultPid === w.pid) {
            marks.push(DEFAULT_MARK);
        }
        return marks.length > 0 ? `  ← ${marks.join(', ')}` : '';
    }

    /**
     * One forwarded call: pick the window, check its health when it has
     * been quiet, send, and hand back what it answered, with this session's
     * notice of new errors in that window. The worker's own failure passes
     * as its `ToolError`; only a failed channel drops the window as this
     * session's target.
     */
    private async relay(op: string, args: unknown): Promise<ToolText> {
        const given = args === undefined ? {} : args;
        const { entry, reason } = this.resolveTarget(targetHintOf(given));
        const sent = withoutWindow(given);
        logger.debug(`Routing ${op} → pid=${entry.pid} port=${entry.controlPort} (via ${reason})`);
        this.forwardedTo.add(entry.pid);
        let answer: WorkerAnswer;
        try {
            await this.checkIfQuiet(entry);
            answer = await this.post(entry, op, sent);
        } catch (failure) {
            if (!(failure instanceof ChannelFailure)) {
                throw toToolError(failure);
            }
            if (this.target !== undefined && this.target.pid === entry.pid) {
                this.forget();
            }
            logger.info(`Routing ${op} → pid=${entry.pid} failed: ${failure.message}`);
            throw failure.reported ?? new ToolError('WINDOW_UNREACHABLE',
                `Could not reach the VS Code window handling this session (pid=${entry.pid}): ${failure.message}`, UNREACHABLE_HINT);
        }
        const noticed = this.notices.observe(String(entry.pid), answer.counters, op, answer.outcome);
        if (noticed instanceof ToolError) {
            throw noticed;
        }
        return noticed;
    }

    /** The resolution ladder; the first rung that applies decides, and a miss throws. */
    private resolveTarget(hint: TargetHint | undefined): Resolved {
        const chosenDefault = this.followDefault();
        if (hint !== undefined && hint.source === 'window') {
            // Named for this call, and like a path it re-aims the session's later path-less calls.
            return this.settle(this.namedWindow(hint, chosenDefault), 'window-arg');
        }
        if (hint !== undefined) {
            // A named file must never run in another window, cached or pinned.
            const owner = this.registry.findByPath(hint.path);
            if (!owner) {
                throw this.unroutable(hint.path, chosenDefault);
            }
            return this.settle(owner, 'path');
        }
        if (this.pinnedPid !== undefined) {
            const pinned = this.registry.findByPid(this.pinnedPid);
            if (!pinned) {
                throw new ToolError('WINDOW_UNREACHABLE',
                    `The window pinned with select_debug_window (pid=${this.pinnedPid}) is gone.`,
                    'Pin another with select_debug_window, or call list_debug_windows to see what is open.');
            }
            return this.settle(pinned, 'pinned');
        }
        if (this.target !== undefined && this.registry.isLive(this.target)) {
            return { entry: this.target, reason: 'cached' };
        }
        this.forget();
        const preferred = chosenDefault === undefined ? undefined : this.registry.findDefaultTarget(chosenDefault);
        if (preferred) {
            return this.settle(preferred, 'default');
        }
        const debugging = this.registry.findSoleActiveSession();
        if (debugging) {
            return this.settle(debugging, 'active-session');
        }
        const only = this.registry.findSoleWindow();
        if (only) {
            return this.settle(only, 'only-window');
        }
        throw this.unroutable(undefined, chosenDefault);
    }

    /** Make `entry` this session's target, chosen for `reason`. */
    private settle(entry: WindowRegistration, reason: ResolutionReason): Resolved {
        this.target = entry;
        this.targetReason = reason;
        return { entry, reason };
    }

    /** Forget this session's target; the pin stays. */
    private forget(): void {
        this.target = undefined;
        this.targetReason = undefined;
    }

    /**
     * Read the default target and, when it was chosen since this session last
     * looked, drop the session's target: a click in the status bar moves
     * path-less calls at once. The pin stays, and a default that was removed
     * leaves the session where it is.
     */
    private followDefault(): DefaultTarget | undefined {
        const chosen = this.registry.readDefaultTarget();
        if (chosen !== undefined && chosen.setAt !== this.defaultSetAt) {
            this.defaultSetAt = chosen.setAt;
            this.forget();
        }
        return chosen;
    }

    /** The window a `window` argument names; one that matches nothing is refused with the candidates. */
    private namedWindow(hint: TargetHint & { source: 'window' }, chosenDefault: DefaultTarget | undefined): WindowRegistration {
        const found = 'pid' in hint ? this.registry.findByPid(hint.pid) : this.registry.findByPath(hint.path);
        if (found) {
            return found;
        }
        const windows = this.registry.list();
        if (windows.length === 0) {
            throw new ToolError('WINDOW_UNREACHABLE', NO_WINDOW_ERROR, NO_WINDOW_HINT);
        }
        const given = 'pid' in hint ? String(hint.pid) : hint.path;
        const defaultPid = chosenDefault === undefined ? undefined : this.registry.findDefaultTarget(chosenDefault, windows)?.pid;
        throw new ToolError('INVALID_ARGUMENT', `The window argument "${given}" matches no open VS Code window.`,
            `Pass the pid of one of these, or a path inside its workspace:\n${bulletList(windows)}`,
            { candidates: windows.map((w) => candidateOf(w, defaultPid)) });
    }

    /**
     * Why no window could take the call, from a fresh look at the registry:
     * no window at all, a path outside every workspace, or a tie, which lists
     * every registered window as a candidate and names a default target
     * whose window is not open.
     */
    private unroutable(hint: string | undefined, chosenDefault: DefaultTarget | undefined): ToolError {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return new ToolError('WINDOW_UNREACHABLE', NO_WINDOW_ERROR, NO_WINDOW_HINT);
        }
        const listing = bulletList(windows);
        if (hint !== undefined) {
            return new ToolError('INVALID_ARGUMENT', `No open VS Code window has "${hint}" inside its workspace.`,
                `Open the folder containing it, or pass a path that is inside one of these:\n${listing}`);
        }
        const preferred = chosenDefault === undefined ? undefined : this.registry.findDefaultTarget(chosenDefault, windows);
        const candidates = { candidates: windows.map((w) => candidateOf(w, preferred?.pid)) };
        const closedDefault = chosenDefault !== undefined && preferred === undefined
            ? `The default target the user set in VS Code (${chosenDefault.name ?? `pid ${chosenDefault.pid}`}) is not open.\n`
            : '';
        const debugging = windows.filter((w) => w.hasActiveSession).length;
        if (debugging > 1) {
            return new ToolError('AMBIGUOUS_WINDOW',
                `${debugging} VS Code windows have an active debug session, so there is no unambiguous target for this call.`,
                `${closedDefault}Pin one with select_debug_window, ${ASK_THE_USER}\n${listing}`, candidates);
        }
        return new ToolError('AMBIGUOUS_WINDOW',
            `${windows.length} VS Code windows are registered and none has an active debug session, `
                + 'so there is no unambiguous target for this call.',
            `${closedDefault}Start a session in one with cmsis_action load_and_debug and window set to its pid, `
                + `pin one with select_debug_window, ${ASK_THE_USER}\n${listing}`, candidates);
    }

    /**
     * Ask the window `health` first when it has not answered for `quietMs`,
     * or never has (#14). A window that stays silent, or whose channel
     * fails, rejects as a `ChannelFailure`; one that answers is heard now.
     */
    private async checkIfQuiet(entry: WindowRegistration): Promise<void> {
        const last = this.heard.get(entry.pid);
        if (last !== undefined && Date.now() - last <= this.quietMs) {
            return;
        }
        const probe = await probeHealth(entry, this.healthTimeoutMs);
        if (probe.kind === 'alive') {
            this.heard.set(entry.pid, Date.now());
            return;
        }
        throw probe.kind === 'failed' ? new ChannelFailure(probe.reason) : silentBeforeCall(entry, this.healthTimeoutMs);
    }

    /**
     * POST `{op, args, budgetMs}` to the window's control server — with the
     * call's id and MCP session id when the call has a context — asking for
     * the typed envelope, and resolve with what the window answered, its
     * failure included.
     *
     * The budget is wall-clock time. While the call is pending, the window
     * is asked `health` every `watchdogEveryMs`; two misses in a row end the
     * call as a `ChannelFailure`. When the budget runs out the call ends as
     * `WORKER_TIMEOUT` after a passed health check, else as a
     * `ChannelFailure`. A failed channel rejects as a `ChannelFailure` too.
     * `budgetMs` defaults to the op's forward budget; the internal op
     * `sessionEnded` (#49), which nobody waits for, passes 2 s.
     */
    private post(entry: WindowRegistration, op: string, args: unknown, budgetMs = this.budgetMs(op, args)): Promise<WorkerAnswer> {
        const call = currentCallContext();
        const named = call ? { callId: call.callId, ...(call.sessionId ? { sessionId: call.sessionId } : {}) } : {};
        const body = Buffer.from(JSON.stringify({ op, args, ...named, budgetMs }), 'utf8');
        return new Promise<WorkerAnswer>((resolve, reject) => {
            let concluded = false;
            let lastCheckPassed = true;
            let misses = 0;
            let checking = false;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            let watchdog: ReturnType<typeof setInterval> | undefined;
            /** Settle once: stop the timers and run `settle`; false when the call had settled already. */
            const conclude = (settle: () => void): boolean => {
                if (concluded) {
                    return false;
                }
                concluded = true;
                clearTimeout(deadline);
                clearInterval(watchdog);
                settle();
                return true;
            };
            const outgoing = http.request({
                host: '127.0.0.1',
                port: entry.controlPort,
                path: '/op',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    [TOKEN_HEADER]: entry.controlToken,
                    [CONTROL_ENVELOPE_HEADER]: String(CONTROL_ENVELOPE_VERSION),
                },
            }, (incoming) => {
                const parts: Buffer[] = [];
                let size = 0;
                incoming.on('data', (chunk: Buffer) => {
                    if (concluded) {
                        return;
                    }
                    size += chunk.length;
                    if (size > CONTROL_RESPONSE_MAX_BYTES) {
                        parts.length = 0;
                        // The window answered, only too much: it stays the target.
                        conclude(() => reject(new ToolError('INTERNAL', `control response above ${CONTROL_RESPONSE_MAX_BYTES} bytes from pid ${entry.pid}`)));
                        outgoing.destroy();
                        return;
                    }
                    parts.push(chunk);
                });
                incoming.on('error', (fault: Error) => conclude(() => reject(new ChannelFailure(fault.message))));
                incoming.on('end', () => conclude(() => {
                    try {
                        const typed = incoming.headers[CONTROL_ENVELOPE_HEADER] !== undefined;
                        const answer = readReply(incoming.statusCode, typed, Buffer.concat(parts).toString('utf8'));
                        this.heard.set(entry.pid, Date.now());
                        resolve(answer);
                    } catch (failure) {
                        reject(failure);
                    }
                }));
            });
            deadline = setTimeout(() => {
                const ended = conclude(() => reject(lastCheckPassed
                    ? new ToolError('WORKER_TIMEOUT', `The VS Code window handling this session (pid=${entry.pid}) sent no response within `
                        + `${secondsText(budgetMs)} — it may be busy or wedged.`, BUSY_HINT)
                    : silentDuringCall(entry, op, `sent no response within ${secondsText(budgetMs)} and missed its last health check`)));
                if (ended) {
                    outgoing.destroy();
                }
            }, budgetMs);
            watchdog = setInterval(() => {
                if (checking || concluded) {
                    return;
                }
                checking = true;
                void probeHealth(entry, this.healthTimeoutMs).then((probe) => {
                    checking = false;
                    if (concluded) {
                        return;
                    }
                    if (probe.kind === 'alive') {
                        lastCheckPassed = true;
                        misses = 0;
                        this.heard.set(entry.pid, Date.now());
                        return;
                    }
                    lastCheckPassed = false;
                    misses += 1;
                    if (misses >= WATCHDOG_MISSES
                        && conclude(() => reject(silentDuringCall(entry, op, `missed ${misses} health checks in a row`)))) {
                        outgoing.destroy();
                    }
                });
            }, this.watchdogEveryMs);
            outgoing.on('error', (fault: Error) => conclude(() => reject(new ChannelFailure(fault.message))));
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

/** The problem-journal counters of a reply (#48); undefined when the worker sent none, as 2.5.0 does. */
function countersOf(reply: { journalSeq?: unknown; journalErrors?: unknown }): JournalCounters | undefined {
    const { journalSeq, journalErrors } = reply;
    const counts = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
    return counts(journalSeq) && counts(journalErrors) ? { seq: journalSeq, errors: journalErrors } : undefined;
}

/**
 * A complete control-server reply as what the window answered: its outcome,
 * a failure included, and its journal counters. Throws a `ChannelFailure`
 * for anything that is not a control reply. `typed` says the worker marked
 * the reply with the envelope header; a string result without it comes from
 * a 2.3.10 worker and is read with `upgradeLegacyText`.
 */
function readReply(status: number | undefined, typed: boolean, body: string): WorkerAnswer {
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
    const fields = reply as { result?: unknown; error?: unknown; journalSeq?: unknown; journalErrors?: unknown };
    const { result, error } = fields;
    const counters = typed ? countersOf(fields) : undefined;
    const answered = (outcome: ToolText | ToolError): WorkerAnswer => (counters ? { outcome, counters } : { outcome });
    if (status === 413) {
        return answered(new ToolError('INVALID_ARGUMENT', typeof error === 'string' ? error : 'control request too large'));
    }
    if (status === 200 && typeof result === 'string') {
        return answered(typed ? result : upgradeLegacyText(result));
    }
    if (status === 200 && isToolReply(result)) {
        return answered(result);
    }
    if (status === 500 && typeof error === 'string') {
        return answered(toToolError(error));
    }
    if (status === 500 && typeof error === 'object' && error !== null) {
        return answered(typedError(error as Record<string, unknown>));
    }
    throw new ChannelFailure(status === 200
        ? `malformed control response: ${body.slice(0, MALFORMED_PREVIEW_CHARS)}`
        : `control server returned ${status}`);
}
