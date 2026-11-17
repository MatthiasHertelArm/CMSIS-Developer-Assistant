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
 * The window's pending GDB starts (#127): launches and CMSIS Runs that
 * reserved their GDB ports and that no session or task has taken over yet.
 *
 * `cmsis_action load_and_debug` hands its launch to CMSIS Solution, whose
 * command returns before VS Code has taken the launch up, and VS Code tells
 * nobody when it drops a start before the debug adapter starts: a picker or
 * a dialog cancelled, a launch CMSIS Solution reports only in its own
 * message. A CMSIS Run task starts only once CMSIS Solution has fetched the
 * tasks. None of these late starts passes the window's guard, so their
 * reservations stay until there is evidence that the start is gone
 * (`src/core/gdbPortReservations.ts`). What this module does instead:
 *
 *   - `get_session_status` and `cmsis_action status` name each pending start
 *     that nothing of the window may still take over;
 *   - the window's next start on such a port takes it over
 *     (`startsToTakeOver`), and asks VS Code first to cancel what it still
 *     prepares of a launch taken over, so that the old launch does not come up
 *     beside the new one; a start that a session, a CMSIS task or a job of the
 *     window may still take over, or one that has not had
 *     `TAKE_OVER_AFTER_MS` to come up, is refused, naming what it waits for;
 *   - `stop_debugging` without a session asks VS Code to cancel what it still
 *     prepares (`cancelPendingLaunches`); a cancel is no evidence, since it
 *     does not reach a launch VS Code has not taken up yet, so the port stays.
 */

import type { IDebuggingExecutor } from '../debuggingExecutor';
import { NOTHING_STARTED_MS } from '../core/cmsisTasks';
import { gdbPortRefusal, pendingLaunchCauses, type PortStart, type StartWait } from '../core/gdbPortGuard';
import type { GdbPortReservation, PendingGdbStart } from '../core/gdbPortReservations';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';
import { failureText } from './fence';
import type { HandlerHost } from './host';
import { formatDuration } from './jobText';

/** The CMSIS task kinds that may still take a pending start over: a pre-launch Load, a Run, a Load+Run. */
const BACKING_KINDS: ReadonlySet<string> = new Set(['load', 'run', 'loadRun']);
/** The `cmsis_action` jobs whose task may still start and take a pending start over. */
const BACKING_JOBS: ReadonlySet<string> = new Set(['run', 'load_and_run', 'load_and_debug']);
/** How long the cancel request may take; VS Code answers it at once while no session runs. */
const CANCEL_WAIT_MS = 5_000;
/**
 * A pending start of the window that has gone this long without a session
 * or task may be taken over by the window's next start: as long as a CMSIS
 * job waits for its task to start.
 */
export const TAKE_OVER_AFTER_MS = NOTHING_STARTED_MS;

/** What `stop_debugging` found and did about the window's pending starts. */
export interface PendingStartsOutcome {
    pending: readonly PendingGdbStart[];
    /** What may still take them over; then nothing was cancelled. */
    wait?: StartWait;
    /** Whether VS Code was asked to cancel what it still prepares of a launch. */
    cancelled: boolean;
}

/** `GDB port 3333`, `GDB ports 3333 and 3334`. */
function portsText(ports: readonly number[]): string {
    if (ports.length === 1) {
        return `GDB port ${ports[0]}`;
    }
    return `GDB ports ${ports.slice(0, -1).join(', ')} and ${ports[ports.length - 1]}`;
}

/**
 * What may still take this window's pending starts over: a debug session, a
 * CMSIS Load, Run or Load+Run task, or a job of `run`, `load_and_run` or
 * `load_and_debug` whose task has not started yet; undefined when nothing.
 */
function waitOf(executor: IDebuggingExecutor, host: HandlerHost): StartWait | undefined {
    if (executor.hasDebugSession()) {
        return { kind: 'session' };
    }
    const jobs = host.cmsisJobs();
    const task = jobs.liveExecutions().find((execution) => BACKING_KINDS.has(execution.kind));
    if (task) {
        return { kind: 'task', name: task.name };
    }
    const job = jobs.openJobs().find((open) => BACKING_JOBS.has(open.action));
    return job ? { kind: 'job', id: job.id, action: job.action } : undefined;
}

/** What a stop reply says a start still waits for. */
function waitText(wait: StartWait): string {
    switch (wait.kind) {
        case 'session':
            return 'a debug session of this window may still take it over';
        case 'task':
            return `its task '${wait.name}' still runs; cmsis_action stop_run ends that task`;
        case 'job':
            return `its ${wait.action} (job ${wait.id}) has not started its task yet; cmsis_action {action:'status'} follows it`;
        case 'starting':
            return 'it may still come up';
    }
}

/** One pending start as `get_session_status` and `cmsis_action status` name it. */
export function pendingStartLine(start: PendingGdbStart): string {
    const reserved = `${portsText(start.ports)} ${formatDuration(start.ageMs)} ago`;
    if (start.what === 'run') {
        return `Pending CMSIS Run: it reserved ${reserved}, and no CMSIS Run task has started yet. The port stays reserved for this window `
            + 'while that task may still start: a new start here takes it over.';
    }
    return `Pending launch: '${start.label}' reserved ${reserved} and has started no debug session yet. If none comes, `
        + `${pendingLaunchCauses(start.server === 'Arm FVP')}: ask the user what VS Code shows. The port stays reserved for this window while `
        + 'that launch may still begin: a new start here takes it over, and stop_debugging asks VS Code to cancel the launch.';
}

/**
 * The lines the status tools add, one per pending start; none when nothing
 * is pending, or while a session, a task or a job may still take the starts
 * over: the status shows that one already. Never throws.
 */
export function pendingStartLines(executor: IDebuggingExecutor, host: HandlerHost): string[] {
    try {
        const pending = host.pendingGdbStarts();
        if (pending.length === 0 || waitOf(executor, host)) {
            return [];
        }
        return pending.map((start) => pendingStartLine(start));
    } catch (caught) {
        logger.warn('The pending GDB starts of the status could not be listed', caught);
        return [];
    }
}

/**
 * Before a start of this window reserves `wanted`: the window's own pending
 * starts on those ports, which it takes over. One that a session, a CMSIS
 * task or a job of the window may still take over, or that has not had
 * `TAKE_OVER_AFTER_MS` to come up, refuses the start instead (`PROBE_BUSY`,
 * naming what it waits for).
 */
export function startsToTakeOver(
    executor: IDebuggingExecutor, host: HandlerHost, wanted: ReadonlyArray<{ port: number; start: PortStart }>,
): PendingGdbStart[] {
    const pending = host.pendingGdbStarts();
    const chosen: PendingGdbStart[] = [];
    for (const { port, start } of wanted) {
        const own = pending.find((candidate) => candidate.ports.includes(port));
        if (!own || chosen.includes(own)) {
            continue;
        }
        const wait: StartWait | undefined = waitOf(executor, host)
            ?? (own.ageMs < TAKE_OVER_AFTER_MS ? { kind: 'starting', takeOverAfterMs: TAKE_OVER_AFTER_MS } : undefined);
        if (wait) {
            throw gdbPortRefusal(start, port, {
                kind: 'own', what: own.what, label: own.label, ageMs: own.ageMs, adopted: false, server: own.server, waitingFor: wait,
            });
        }
        chosen.push(own);
    }
    return chosen;
}

/**
 * Ask VS Code to cancel what it still prepares of a launch among `starts`,
 * while no session is listed (`cancelPendingStarts` of the executor). Best
 * effort, and no evidence: it does not reach a launch VS Code has not taken
 * up yet. True when the request went out. Never throws.
 */
export async function cancelPreparedLaunches(executor: IDebuggingExecutor, starts: readonly PendingGdbStart[]): Promise<boolean> {
    if (!starts.some((start) => start.what === 'launch')) {
        return false;
    }
    try {
        return await withTimeout('cancel the prepared debug start', CANCEL_WAIT_MS, () => executor.cancelPendingStarts());
    } catch (caught) {
        logger.info(`VS Code was not asked to cancel the pending debug start: ${failureText(caught)}`);
        return false;
    }
}

/** A pending start as the replies name it: `this window's launch of 'X' (GDB port 3333, reserved 3 min ago), which …`. */
function startPhrase(start: PendingGdbStart): string {
    const reserved = `${portsText(start.ports)}, reserved ${formatDuration(start.ageMs)} ago`;
    return start.what === 'run'
        ? `this window's CMSIS Run (${reserved}), whose task has not started`
        : `this window's launch of '${start.label}' (${reserved}), which has started no debug session`;
}

/** The preface of a start that took this window's own pending starts over; '' when it took none over. */
export function takeOverNote(starts: readonly PendingGdbStart[], cancelled: boolean): string {
    if (starts.length === 0) {
        return '';
    }
    const asked = cancelled ? '; VS Code was asked to cancel that launch first' : '';
    return `Took over the GDB port${starts.some((start) => start.ports.length > 1) || starts.length > 1 ? 's' : ''} of `
        + `${starts.map((start) => startPhrase(start)).join(' and ')}${asked}. `;
}

/**
 * `stop_debugging` without a session: when nothing of the window may still
 * take its pending starts over, ask VS Code to cancel what it still prepares
 * of a pending launch. Releases nothing. Never throws.
 */
export async function cancelPendingLaunches(executor: IDebuggingExecutor, host: HandlerHost): Promise<PendingStartsOutcome> {
    try {
        const pending = host.pendingGdbStarts();
        if (pending.length === 0) {
            return { pending, cancelled: false };
        }
        const wait = waitOf(executor, host);
        if (wait) {
            return { pending, wait, cancelled: false };
        }
        return { pending, cancelled: await cancelPreparedLaunches(executor, pending) };
    } catch (caught) {
        logger.warn('The pending GDB starts of this window could not be looked at', caught);
        return { pending: [], cancelled: false };
    }
}

/** The sentences `stop_debugging` adds about the window's pending starts, with a leading space; '' when there are none. */
export function pendingStartsNote(outcome: PendingStartsOutcome): string {
    if (outcome.pending.length === 0) {
        return '';
    }
    const phrases = outcome.pending.map((start) => startPhrase(start)).join('; ');
    if (outcome.wait) {
        return ` Still pending: ${phrases} — ${waitText(outcome.wait)}.`;
    }
    const several = outcome.pending.reduce((count, start) => count + start.ports.length, 0) > 1;
    const cancelled = outcome.cancelled ? ' VS Code was asked to cancel what it still prepares of that launch, as the Debug toolbar\'s Stop does.' : '';
    const why = outcome.pending.some((start) => start.what === 'launch')
        ? 'a cancel does not reach a launch VS Code has not taken up yet'
        : 'CMSIS Solution may still start that task';
    return ` Pending: ${phrases}.${cancelled} ${several ? 'Their ports stay' : 'Its port stays'} reserved for this window, since ${why}: `
        + `the next start here takes ${several ? 'them' : 'it'} over, and a reload of the window frees ${several ? 'them' : 'it'}.`;
}

/**
 * The sentence the `running` reply of `load_and_debug` ends with while its
 * reservations wait for the session; '' when there are none or a session
 * took them over.
 */
export function pendingLaunchNote(reservations: readonly GdbPortReservation[] | undefined): string {
    const ports = [...new Set((reservations ?? []).filter((reservation) => reservation.pending).map((reservation) => reservation.port))]
        .sort((a, b) => a - b);
    if (ports.length === 0) {
        return '';
    }
    return ` Until a session of it has come up and ended, this window keeps ${portsText(ports)} reserved for it; if none comes, `
        + 'a new load_and_debug here takes the port over, and stop_debugging asks VS Code to cancel the launch.';
}
