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
 * What this window knows about its debug sessions from the DAP traffic the
 * adapter tracker sees: the live sessions and the one to act on, whether each
 * target is stopped, waits for the next stop and for a session's end, the
 * recent adapter lines behind launch failures, the output a GDB command
 * prints (#56), when the adapter has answered VS Code's `setBreakpoints`, and
 * the GDB `dprintf` logpoints set in a session. Everything a session holds
 * goes when it ends.
 */

import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Per-session record of the most recent execution-state events seen on the
 * Debug Adapter Protocol channel. We track this because neither
 * `vscode.debug.activeDebugSession` nor `vscode.debug.activeStackItem` is a
 * reliable "is the target stopped?" signal on embedded targets:
 *
 *   - `activeStackItem` is `undefined` whenever the CPU is running.
 *   - It is also `undefined` for a brief window after a stop event, before
 *     VS Code surfaces the new stack frame.
 *   - It can remain set briefly after a `continued` event.
 *
 * The DAP `stopped` / `continued` events are the ground truth, so we record
 * them here and expose a synchronous query.
 */
interface SessionExecState {
    /** Last execution-state transition observed on this session. */
    lastEvent: 'stopped' | 'continued' | null;
    /** Reason from the DAP `stopped` event (e.g. "breakpoint", "step", "exception"). */
    stoppedReason: string | null;
    /** Thread from the DAP `stopped` event, when the adapter reported one. */
    stoppedThreadId: number | null;
    /** Wall-clock time of the last transition. */
    lastEventAt: number;
}

const sessionStates = new WeakMap<vscode.DebugSession, SessionExecState>();

/**
 * Live debug sessions seen by the adapter tracker, most-recently-started last.
 * `vscode.debug.activeDebugSession` only reflects the session the VS Code UI
 * currently has focused — it is `undefined` whenever focus is elsewhere, which
 * is common with `gdbtarget` multi-core launches. This list lets us answer
 * "is there a debug session at all?" independently of UI focus.
 *
 * Note: a debug session in a *different* VS Code window runs in a different
 * extension host and is genuinely invisible here — that case cannot be fixed.
 */
const liveSessions: vscode.DebugSession[] = [];

/** Sessions the tracker has seen end, so a wait that starts afterwards knows at once. */
const endedSessions = new WeakSet<vscode.DebugSession>();

function getOrInit(session: vscode.DebugSession): SessionExecState {
    let state = sessionStates.get(session);
    if (!state) {
        state = { lastEvent: null, stoppedReason: null, stoppedThreadId: null, lastEventAt: 0 };
        sessionStates.set(session, state);
    }
    return state;
}

function addLiveSession(session: vscode.DebugSession): void {
    if (!liveSessions.includes(session)) {
        liveSessions.push(session);
    }
}

function removeLiveSession(session: vscode.DebugSession): void {
    const idx = liveSessions.indexOf(session);
    if (idx !== -1) {
        liveSessions.splice(idx, 1);
    }
}

/**
 * The most-recently-started live debug session, or `undefined` if none.
 * Use as a fallback when `vscode.debug.activeDebugSession` is `undefined`
 * but a session is in fact running in this window.
 */
export function getMostRecentLiveSession(): vscode.DebugSession | undefined {
    return liveSessions.length > 0 ? liveSessions[liveSessions.length - 1] : undefined;
}

/** Number of live debug sessions this extension host has seen via the adapter tracker. */
export function getLiveSessionCount(): number {
    return liveSessions.length;
}

/** Names of the live debug sessions, for diagnostics. */
export function getLiveSessionNames(): string[] {
    return liveSessions.map(s => s.name);
}

/**
 * Resolve "the debug session the agent should operate on": VS Code's focused
 * session if there is one, otherwise the most-recently-started tracked
 * session. This is the single source of truth the executor should use
 * instead of reading `vscode.debug.activeDebugSession` directly.
 */
export function resolveActiveSession(): vscode.DebugSession | undefined {
    return vscode.debug.activeDebugSession ?? getMostRecentLiveSession();
}

/**
 * Authoritative answer to "is this session currently stopped at a frame the
 * agent can inspect?". Combines DAP event history with VS Code's
 * `activeStackItem` to ride out the brief races on either side of a stop.
 */
export function isSessionStopped(session: vscode.DebugSession): boolean {
    const state = sessionStates.get(session);

    // Authoritative if we have seen DAP events for this session.
    if (state?.lastEvent === 'stopped') {
        return true;
    }
    if (state?.lastEvent === 'continued') {
        return false;
    }

    // No DAP events yet (e.g. attach without an initial stop) — fall back to
    // VS Code's view. This is the same heuristic the rest of the executor
    // used historically.
    const item = vscode.debug.activeStackItem;
    return item !== undefined && 'frameId' in item && item.session === session;
}

/**
 * Reason the target is currently stopped, or null if running / unknown.
 * Useful for surfacing "stopped at breakpoint" vs "stopped at exception".
 */
export function getStoppedReason(session: vscode.DebugSession): string | null {
    const state = sessionStates.get(session);
    return state?.lastEvent === 'stopped' ? state.stoppedReason : null;
}

// ── Awaitable stop events ─────────────────────────────────────────

/** Outcome of waiting for the next DAP `stopped` event on a session. */
export type StopWaitResult =
    | { kind: 'stopped'; reason: string | null; threadId: number | null }
    | { kind: 'timeout' }
    | { kind: 'ended' };

interface StopWaiter {
    session: vscode.DebugSession;
    settle: (result: StopWaitResult) => void;
    timer: NodeJS.Timeout;
}

// Module-level waiter set because the tracker is a singleton. A Set (not a
// single slot) so concurrent waiters on the same session all settle.
const stopWaiters = new Set<StopWaiter>();

function settleStopWaiters(session: vscode.DebugSession, result: StopWaitResult): void {
    for (const waiter of [...stopWaiters]) {
        if (waiter.session === session) {
            waiter.settle(result);
        }
    }
}

/**
 * Resolve on the NEXT DAP `stopped` event for this session (ground truth —
 * the same signal isSessionStopped records), on session termination, or on
 * timeout. Never rejects; the caller distinguishes outcomes via `kind`. A
 * session the tracker has already seen end resolves `ended` at once.
 */
export function waitForStopEvent(session: vscode.DebugSession, timeoutMs: number): Promise<StopWaitResult> {
    if (endedSessions.has(session)) {
        return Promise.resolve({ kind: 'ended' });
    }
    const ms = Math.min(Math.max(timeoutMs, 100), 60_000);
    return new Promise((resolve) => {
        const waiter = {} as StopWaiter;
        const settle = (result: StopWaitResult) => {
            stopWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            resolve(result);
        };
        waiter.session = session;
        waiter.settle = settle;
        waiter.timer = setTimeout(() => settle({ kind: 'timeout' }), ms);
        stopWaiters.add(waiter);
    });
}

// ── Recent adapter traffic (launch-failure diagnostics) ───────────

// Ring buffer of recent adapter-originated error/output lines, keyed by
// session.id (NOT the WeakMap — these must survive session termination,
// which is exactly when launch-failure reporting needs them). Retained for
// the last few sessions only.
const DIAG_RING_SIZE = 20;
const DIAG_LINE_CAP = 300;
const DIAG_KEPT_SESSIONS = 3;
const diagnosticsBySessionId = new Map<string, string[]>();

function recordDiagnostic(session: vscode.DebugSession, line: string): void {
    const trimmed = line.length > DIAG_LINE_CAP ? line.substring(0, DIAG_LINE_CAP - 1) + '…' : line;
    let buffer = diagnosticsBySessionId.get(session.id);
    if (!buffer) {
        buffer = [];
        diagnosticsBySessionId.set(session.id, buffer);
        // Prune oldest session ids (Map preserves insertion order).
        while (diagnosticsBySessionId.size > DIAG_KEPT_SESSIONS) {
            const oldest = diagnosticsBySessionId.keys().next().value!;
            if (oldest === session.id) { break; }
            diagnosticsBySessionId.delete(oldest);
        }
    }
    buffer.push(trimmed);
    if (buffer.length > DIAG_RING_SIZE) { buffer.shift(); }
}

/** The most recent session's captured adapter errors/output, oldest first. */
export function getRecentDiagnostics(): string[] {
    const last = [...diagnosticsBySessionId.values()].pop();
    return last ? [...last] : [];
}

// ── Output capture (GDB commands on cdt-gdb-adapter) ──────────────

/**
 * The text a session's adapter prints while a GDB command runs. cdt-gdb-adapter
 * answers a CLI command's evaluate request with an empty reply and sends the
 * command's text as `output` events; a capture collects them.
 */
export interface OutputCapture {
    /**
     * Ends the capture once no output has arrived for `quietMs`, and at the
     * latest `capMs` after this call or when the session ends, and resolves
     * the text collected.
     */
    settle(quietMs: number, capMs: number): Promise<string>;
    /** Ends the capture now and returns the text collected. */
    stop(): string;
}

interface Capture {
    session: vscode.DebugSession;
    categories: ReadonlySet<string>;
    chunks: string[];
    lastAt: number;
    open: boolean;
    /** Wakes a pending `settle` when output arrives or the session ends. */
    nudge?: () => void;
}

const captures = new Set<Capture>();

/**
 * Starts collecting the `output` events of `session` in `categories`. Start
 * it before the request whose output it is meant for is sent.
 */
export function captureOutput(session: vscode.DebugSession, categories: readonly string[] = ['stdout']): OutputCapture {
    const capture: Capture = { session, categories: new Set(categories), chunks: [], lastAt: Date.now(), open: true };
    captures.add(capture);
    const stop = (): string => {
        capture.open = false;
        capture.nudge = undefined;
        captures.delete(capture);
        return capture.chunks.join('');
    };
    const settle = (quietMs: number, capMs: number): Promise<string> => new Promise((resolve) => {
        const began = Date.now();
        let timer: NodeJS.Timeout | undefined;
        const check = (): void => {
            clearTimeout(timer);
            const now = Date.now();
            const quietUntil = Math.max(capture.lastAt, began) + quietMs;
            const capUntil = began + capMs;
            if (!capture.open || now >= quietUntil || now >= capUntil) {
                resolve(stop());
                return;
            }
            timer = setTimeout(check, Math.min(quietUntil, capUntil) - now);
        };
        capture.nudge = check;
        check();
    });
    return { settle, stop };
}

function collectOutput(session: vscode.DebugSession, category: unknown, text: string): void {
    for (const capture of captures) {
        if (capture.session === session && capture.open && capture.categories.has(String(category ?? 'console'))) {
            capture.chunks.push(text);
            capture.lastAt = Date.now();
            capture.nudge?.();
        }
    }
}

function closeCaptures(session: vscode.DebugSession): void {
    for (const capture of [...captures]) {
        if (capture.session === session) {
            capture.open = false;
            if (capture.nudge) {
                capture.nudge();
            } else {
                captures.delete(capture);
            }
        }
    }
}

// ── Breakpoint changes reaching the adapter ───────────────────────

/** The source of each `setBreakpoints` request VS Code sent, by request seq, until the adapter answers. */
const pendingBreakpointRequests = new WeakMap<vscode.DebugSession, Map<number, string>>();

interface BreakpointSyncWaiter {
    session: vscode.DebugSession;
    remaining: Set<string>;
    settle: (applied: boolean) => void;
}

const breakpointSyncWaiters = new Set<BreakpointSyncWaiter>();

/** A source path as a comparison key: forward slashes, a lower-case drive, case-folded on Windows. */
function pathKey(fsPath: string): string {
    const forward = fsPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (drive) => drive.toLowerCase());
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Resolves true once the adapter of `session` has answered a
 * `setBreakpoints` request for each of `sourcePaths`, sent after this call;
 * false when `timeoutMs` passes first or the session ends. Call it before the
 * change to VS Code's breakpoint model that makes VS Code send the requests.
 */
export function awaitBreakpointsApplied(session: vscode.DebugSession, sourcePaths: readonly string[], timeoutMs: number): Promise<boolean> {
    if (sourcePaths.length === 0) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const waiter = {} as BreakpointSyncWaiter;
        const timer = setTimeout(() => waiter.settle(false), Math.max(timeoutMs, 0));
        waiter.session = session;
        waiter.remaining = new Set(sourcePaths.map(pathKey));
        waiter.settle = (applied) => {
            clearTimeout(timer);
            breakpointSyncWaiters.delete(waiter);
            resolve(applied);
        };
        breakpointSyncWaiters.add(waiter);
    });
}

function noteBreakpointRequest(session: vscode.DebugSession, message: any): void {
    const sourcePath = message?.arguments?.source?.path;
    if (typeof message?.seq !== 'number' || typeof sourcePath !== 'string') {
        return;
    }
    let pending = pendingBreakpointRequests.get(session);
    if (!pending) {
        pending = new Map();
        pendingBreakpointRequests.set(session, pending);
    }
    pending.set(message.seq, sourcePath);
}

function noteBreakpointResponse(session: vscode.DebugSession, message: any): void {
    const pending = pendingBreakpointRequests.get(session);
    const sourcePath = pending?.get(message?.request_seq);
    if (sourcePath === undefined) {
        return;
    }
    pending?.delete(message.request_seq);
    const key = pathKey(sourcePath);
    for (const waiter of [...breakpointSyncWaiters]) {
        if (waiter.session === session && waiter.remaining.delete(key) && waiter.remaining.size === 0) {
            waiter.settle(true);
        }
    }
}

// ── GDB dprintf logpoints (CMSIS Debugger) ────────────────────────

/** A logpoint the tools set as a GDB `dprintf` in a session. */
export interface GdbLogpoint {
    /** GDB's breakpoint number. */
    number: number;
    /** The source path the agent gave. */
    file: string;
    line: number;
    message: string;
    condition?: string;
}

const gdbLogpointsBySession = new WeakMap<vscode.DebugSession, Map<number, GdbLogpoint>>();

export function rememberGdbLogpoint(session: vscode.DebugSession, logpoint: GdbLogpoint): void {
    let known = gdbLogpointsBySession.get(session);
    if (!known) {
        known = new Map();
        gdbLogpointsBySession.set(session, known);
    }
    known.set(logpoint.number, { ...logpoint });
}

export function forgetGdbLogpoints(session: vscode.DebugSession, numbers: readonly number[]): void {
    const known = gdbLogpointsBySession.get(session);
    for (const number of numbers) {
        known?.delete(number);
    }
}

/** The session's logpoints, by GDB number; none once the session has ended. */
export function gdbLogpointsOf(session: vscode.DebugSession): GdbLogpoint[] {
    return [...(gdbLogpointsBySession.get(session)?.values() ?? [])]
        .sort((a, b) => a.number - b.number)
        .map((logpoint) => ({ ...logpoint }));
}

// ── Session end ────────────────────────────────────────────────────

interface EndWaiter {
    session: vscode.DebugSession;
    settle: (ended: boolean) => void;
}

const endWaiters = new Set<EndWaiter>();

/**
 * Resolves true when `session` ends (at once when this window no longer
 * tracks it as live), false when `timeoutMs` passes first.
 */
export function waitForSessionEnd(session: vscode.DebugSession, timeoutMs: number): Promise<boolean> {
    if (endedSessions.has(session) || !liveSessions.includes(session)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const waiter = {} as EndWaiter;
        const timer = setTimeout(() => waiter.settle(false), Math.max(timeoutMs, 0));
        waiter.session = session;
        waiter.settle = (ended) => {
            clearTimeout(timer);
            endWaiters.delete(waiter);
            resolve(ended);
        };
        endWaiters.add(waiter);
    });
}

/** Everything the tracker holds for a session goes when it ends, and whoever waits on it is told. */
function sessionEnded(session: vscode.DebugSession): void {
    endedSessions.add(session);
    sessionStates.delete(session);
    removeLiveSession(session);
    settleStopWaiters(session, { kind: 'ended' });
    closeCaptures(session);
    gdbLogpointsBySession.delete(session);
    pendingBreakpointRequests.delete(session);
    for (const waiter of [...breakpointSyncWaiters]) {
        if (waiter.session === session) {
            waiter.settle(false);
        }
    }
    for (const waiter of [...endWaiters]) {
        if (waiter.session === session) {
            waiter.settle(true);
        }
    }
}

// ── The tracker ────────────────────────────────────────────────────

/**
 * The adapter tracker of one session: what `registerSessionStateTracker`'s
 * factory hands VS Code for every session, exported so tests can feed it
 * messages. Adds the session to the live list.
 */
export function createSessionTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    // VS Code's restart of an adapter without a restart request relaunches it in the same session.
    endedSessions.delete(session);
    addLiveSession(session);
    return {
        onWillReceiveMessage(message: any): void {
            if (message?.type === 'request' && message.command === 'setBreakpoints') {
                noteBreakpointRequest(session, message);
            }
        },
        onDidSendMessage(message: any): void {
            if (message?.type === 'response' && message.command === 'setBreakpoints') {
                noteBreakpointResponse(session, message);
            }
            // Failed request responses carry the adapter's own error
            // text — the detail start_debugging failures otherwise
            // leave in the extension-host log.
            if (message?.type === 'response' && message.success === false) {
                recordDiagnostic(session, `error response to '${message.command}': ${message.message ?? '<no message>'}`);
                return;
            }
            if (message?.type !== 'event') { return; }
            if (message.event === 'output') {
                const category = message.body?.category;
                collectOutput(session, category, String(message.body?.output ?? ''));
                // Adapter stderr/console/important output (GDB server
                // banners, connect errors). stdout is deliberately
                // excluded — chatty target printf would flush real
                // errors out of the ring.
                if (category === 'stderr' || category === 'console' || category === 'important') {
                    recordDiagnostic(session, `[${category}] ${String(message.body?.output ?? '').trim()}`);
                }
                return;
            }
            if (message.event === 'breakpoint') {
                // GDB deleted a breakpoint (a `delete` typed in the Debug Console, say).
                const removedId = message.body?.breakpoint?.id;
                if (message.body?.reason === 'removed' && typeof removedId === 'number') {
                    forgetGdbLogpoints(session, [removedId]);
                }
                return;
            }
            const state = getOrInit(session);
            if (message.event === 'stopped') {
                state.lastEvent = 'stopped';
                state.stoppedReason = message.body?.reason ?? null;
                state.stoppedThreadId = message.body?.threadId ?? null;
                state.lastEventAt = Date.now();
                logger.debug(`[session-tracker] stopped (${state.stoppedReason}) on ${session.name}`);
                settleStopWaiters(session, { kind: 'stopped', reason: state.stoppedReason, threadId: state.stoppedThreadId });
            } else if (message.event === 'continued') {
                state.lastEvent = 'continued';
                state.stoppedReason = null;
                state.stoppedThreadId = null;
                state.lastEventAt = Date.now();
                logger.debug(`[session-tracker] continued on ${session.name}`);
            } else if (message.event === 'terminated' || message.event === 'exited') {
                sessionEnded(session);
            }
        },
        onWillStopSession(): void {
            sessionEnded(session);
        },
        onError(error: Error): void {
            logger.debug(`[session-tracker] adapter error on ${session.name}`, error);
            recordDiagnostic(session, `adapter error: ${error.message ?? String(error)}`);
        },
    };
}

/**
 * Register a global DebugAdapterTracker that records `stopped` and
 * `continued` events for every debug session VS Code starts. Call once
 * during extension activation.
 */
export function registerSessionStateTracker(context: vscode.ExtensionContext): void {
    const factory: vscode.DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
            return createSessionTracker(session);
        },
    };

    // Register for every debug type. VS Code lets us pass '*' to match all.
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('*', factory),
    );

    // Belt-and-braces: also drop sessions on the VS Code termination event,
    // in case the adapter tracker's onWillStopSession did not fire.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            sessionEnded(session);
        }),
    );

    logger.info('Session state tracker registered (DAP stopped/continued events + live-session list)');
}
