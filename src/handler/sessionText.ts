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
 * Texts about the debug session itself: why an inspection is refused in the
 * current state (with the code that refusal carries), what
 * `get_session_status` reports, the recent adapter lines appended to start
 * failures, and the call-stack and thread listings.
 *
 * `test/realboard/run.ts` reads `State: …` from the status and `frameId=N`
 * from the call stack; both stay in this form.
 */

import type { StackFrame } from '../debugState';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { shortenPath, truncateList } from '../core/textBudget';
import { ErrorCode, ToolError } from '../core/toolResult';
import { getRecentDiagnostics } from '../utils/sessionStateTracker';

export type SessionStatus = Awaited<ReturnType<IDebuggingExecutor['getSessionStatus']>>;
export type SessionState = SessionStatus['state'];
type Diagnostics = ReturnType<IDebuggingExecutor['getDiagnostics']>;
type ThreadEntry = Awaited<ReturnType<IDebuggingExecutor['getThreads']>>[number];

/** Frames listed when the caller did not ask for a depth. */
const DEFAULT_SHOWN_FRAMES = 20;
/** Threads listed before the rest is counted. */
const SHOWN_THREADS = 32;

/** What to do next when an inspection meets a session in this state. */
const REFUSAL_HINTS: Record<SessionState, string> = {
    'no-session': 'No active debug session. Call start_debugging first.',
    initializing: 'The debug adapter is still starting. Wait briefly and retry; the session has not torn down.',
    running: 'The target is currently running. Add a breakpoint or wait for the previous continue/step to stop '
        + 'before issuing another inspection or step command.',
    unresponsive: 'The probe/GDB server is unresponsive. Call check_target_connection to confirm, then restart_debugging or stop_debugging.',
    stopped: 'Session reports stopped — please retry the operation.',
};

/** The code of the refusal in each state; `stopped` means the state changed while the gate looked. */
const REFUSAL_CODES: Record<SessionState, ErrorCode> = {
    'no-session': 'NO_SESSION',
    initializing: 'NO_SESSION',
    running: 'TARGET_RUNNING',
    unresponsive: 'TIMEOUT',
    stopped: 'INTERNAL',
};

/** The closing hint of `get_session_status`, by state. */
function statusHint(state: SessionState, liveSessions: number): string {
    switch (state) {
        case 'no-session':
            return liveSessions === 0
                ? 'Hint: no debug session is running in the VS Code window this call was routed to. '
                    + 'Start one with cmsis_action load_and_debug (CMSIS targets) or start_debugging. '
                    + 'If a session IS running and you expected to reach it, it is in a different window: '
                    + 'call list_debug_windows to see which windows are registered and which one holds the session, '
                    + 'then select_debug_window to pin it for this session. '
                    + 'If you just reinstalled the extension, reload the window so the new build is active.'
                : 'Hint: call start_debugging or cmsis_action load_and_debug to attach.';
        case 'initializing':
            return 'Hint: the adapter is still starting — wait a moment and retry.';
        case 'running':
            return 'Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.';
        case 'stopped':
            return 'Hint: full inspection (variables, memory, registers) is available.';
        case 'unresponsive':
            return 'Hint: probe/GDB server is hung. Try restart_debugging, stop_debugging, or check the physical connection.';
    }
}

/**
 * Why `operation` needs a stopped target and the session is not in that
 * state: the state's code, and the next action for that state as the hint.
 */
export function stoppedTargetRefusal(operation: string, state: SessionState): ToolError {
    return new ToolError(REFUSAL_CODES[state], `Cannot ${operation}: session state is '${state}'.`,
        `${REFUSAL_HINTS[state]} Use get_session_status for a definitive, never-failing classification.`);
}

/** The last adapter lines of the most recent session, as a suffix; empty when there are none. */
export function recentAdapterTraffic(): string {
    const lines = getRecentDiagnostics();
    if (lines.length === 0) {
        return '';
    }
    return `\nRecent adapter traffic (last ${lines.length} lines):\n  ${lines.join('\n  ')}`;
}

/** The `get_session_status` text. */
export function renderSessionStatus(status: SessionStatus, diagnostics: Diagnostics): string {
    const lines = [`State: ${status.state}`];
    if (status.sessionName) {
        lines.push(`Session: ${status.sessionName}`);
    }
    if (status.sessionType) {
        lines.push(`Type: ${status.sessionType}`);
    }
    if (status.configurationName) {
        lines.push(`Configuration: ${status.configurationName}`);
    }
    const probe = typeof status.dapProbeMs === 'number' ? ` (probe ${status.dapProbeMs}ms)` : '';
    lines.push(`DAP responsive: ${status.dapResponsive}${probe}`);
    if (status.detail) {
        lines.push(`Detail: ${status.detail}`);
    }
    const names = diagnostics.liveSessionNames.length > 0 ? ` [${diagnostics.liveSessionNames.join(', ')}]` : '';
    const focused = diagnostics.hasVscodeActiveSession ? 'set' : 'undefined';
    lines.push(`Diagnostics: serverVersion=${diagnostics.serverVersion}, `
        + `liveSessionsInThisWindow=${diagnostics.liveSessionCount}${names}, vscodeActiveDebugSession=${focused}`);
    lines.push(statusHint(status.state, diagnostics.liveSessionCount));
    return lines.join('\n');
}

/** `source:line` with the source relative to a workspace folder, or `<no source>`. */
function whereIs(frame: StackFrame, roots: readonly string[]): string {
    const source = frame.source ? shortenPath(frame.source, roots) : '<no source>';
    return `${source}:${frame.line ?? '?'}`;
}

/**
 * The `get_call_stack` text. With an explicit depth every frame is listed;
 * otherwise the first twenty and a count of the rest.
 */
export function renderCallStack(frames: StackFrame[], depthGiven: boolean, roots: readonly string[]): string {
    if (frames.length === 0) {
        return 'No stack frames available.';
    }
    const { shown, hidden } = depthGiven ? { shown: frames, hidden: 0 } : truncateList(frames, DEFAULT_SHOWN_FRAMES);
    const lines = [`Call stack (${frames.length} frame${frames.length === 1 ? '' : 's'}):`];
    shown.forEach((frame, level) => {
        const handle = frame.frameId !== undefined ? ` [frameId=${frame.frameId}]` : '';
        lines.push(`  #${String(level).padStart(2)}  ${frame.name}  @ ${whereIs(frame, roots)}${handle}`);
    });
    if (hidden > 0) {
        lines.push(`  … ${hidden} more frames — pass levels to see all`);
    }
    lines.push('', 'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
    return lines.join('\n');
}

/** The `get_threads` text: each thread with its top frame when the adapter gave one. */
export function renderThreads(threads: ThreadEntry[], roots: readonly string[]): string {
    if (threads.length === 0) {
        return 'No threads reported by the debug adapter.';
    }
    const { shown, hidden } = truncateList(threads, SHOWN_THREADS);
    const lines = [`Threads / RTOS tasks (${threads.length}):`];
    for (const thread of shown) {
        const top = thread.topFrame ? `  → ${thread.topFrame.name} @ ${whereIs(thread.topFrame, roots)}` : '';
        lines.push(`  [${thread.id}] ${thread.name}${top}`);
    }
    if (hidden > 0) {
        lines.push(`  … ${hidden} more threads`);
    }
    lines.push('', 'Tip: pass a threadId to get_call_stack to inspect a specific task.');
    return lines.join('\n');
}
