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
 * `cmsis_action`: run one of the CMSIS Solution extension's build, flash and
 * debug commands on the target the agent names, and report how it ended.
 *
 * The extension's commands answer before their work is done, so the outcome
 * comes from the window's CMSIS job tracker (#47): the call arms a job before
 * its command goes out, the job binds the task execution that starts for it
 * (for a build, the execution the command returns), and the result names the
 * task, its exit code, how long it ran and the job id. load_and_run is done
 * once Load ended 0 and CMSIS Run, which hosts the GDB server, stayed up for
 * 2 s. load_and_debug waits for its pre-launch Load, then, like attach, for a
 * session that it probes twice.
 *
 * One deadline per call (#12): the wait (60 s by default, up to 600 s) counts
 * from the call, so the solution checks and a target switch come out of it,
 * and the call answers before its fence. A job still going at the deadline is
 * answered with status `running`; `status` waits for it, and a repeated build,
 * load, erase or load_and_run attaches to the job in flight instead of
 * starting a second one.
 *
 * Before anything is issued (#46): a debug session refuses load_and_debug and
 * attach, the probe guard refuses what CMSIS Run, a Load, an Erase, `flash` or
 * a session blocks, a target that is not active is switched through
 * `.vscode/cmsis.json` and verified, and a task the debugger adapter does not
 * offer is refused by its label. stop_run waits until the CMSIS tasks ended.
 *
 * Refusals and failed tasks reject with a `ToolError` (`PROBE_BUSY`,
 * `CMSIS_NO_SOLUTION`, `INVALID_ARGUMENT`, `TASK_FAILED`); an action that is
 * still going when the call returns answers with status `running` (#11).
 *
 * Known gaps kept on purpose (fixed separately): late command failures are
 * dropped (KB11), and an unknown action is noticed only after the solution
 * checks (KB17).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DebugState } from '../debugState';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import type { CmsisJobTracker, ExecutionLike } from '../cmsisJobTracker';
import { ACTION_PHASES, executionIn, guardProbe, GuardedAction, isSettled, Job, JobAction, runtimeOf } from '../core/cmsisTasks';
import {
    applyTargetSelection,
    formatTargetChoices,
    formatTargetName,
    listTargetTypes,
    parseTargetRef,
    resolveTargetSelection,
    solutionDisplayName,
    TargetRef,
    targetMatches,
} from '../core/cmsisTarget';
import { ErrorCode, ToolError, ToolText } from '../core/toolResult';
import { withTimeout } from '../utils/timeout';
import { failureText, LONG_LIMIT_CAP_MS } from './fence';
import type { HandlerHost } from './host';
import { formatDuration, idleStatus, jobResult, missingTaskRefusal, probeRefusal, stillRunning } from './jobText';
import { recentAdapterTraffic } from './sessionText';

export type CmsisAction = 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach' | 'stop_run' | 'status';

/** The CMSIS Solution command behind each action. A Map, so `constructor` and friends are not actions. */
const ACTION_COMMANDS: ReadonlyMap<string, string> = new Map([
    ['build', 'cmsis-csolution.build'],
    ['load', 'cmsis-csolution.cmsisLoad'],
    ['erase', 'cmsis-csolution.cmsisErase'],
    ['load_and_run', 'cmsis-csolution.cmsisLoadAndRun'],
    ['load_and_debug', 'cmsis-csolution.cmsisLoadAndDebug'],
    ['attach', 'cmsis-csolution.cmsisAttachDebugger'],
    ['detach', 'cmsis-csolution.cmsisDetachDebugger'],
    ['stop_run', 'cmsis-csolution.cmsisStopRun'],
]);

/** Actions that run a cbuild or flash task and end with its result; a repeated one attaches to the job in flight. */
const TASK_ACTIONS: ReadonlySet<string> = new Set(['build', 'load', 'erase', 'load_and_run']);
const SESSION_ACTIONS: ReadonlySet<string> = new Set(['load_and_debug', 'attach']);
/** Actions whose default wait is the long one: they wait for a task. */
const LONG_WAIT_ACTIONS: ReadonlySet<string> = new Set(['build', 'load', 'erase', 'load_and_run', 'load_and_debug', 'status']);

/** Waits without a positive `timeoutMs`: 60 s for the task actions and status (#12), 30 s for the rest. */
const LONG_WAIT_DEFAULT_MS = 60_000;
const OTHER_WAIT_DEFAULT_MS = 30_000;
/** Kept back from the call's deadline so its own answer beats the fence. */
const DEADLINE_MARGIN_MS = 1_500;
/** How long the command itself gets to fail before the call moves on. */
const KICKOFF_MS = 4_000;
/** The opportunistic wait for a session started by load_and_debug / attach. */
const SESSION_WAIT_MS = 8_000;
/** Budget of the two-probe survival check. */
const SURVIVAL_BUDGET_MS = 8_000;
/** How often load_and_debug looks for its pre-launch Load or a session. */
const LOAD_OR_SESSION_POLL_MS = 250;
/** stop_run: the CMSIS Solution's own terminate gets this long, the whole stop this long. */
const STOP_GRACE_MS = 3_000;
const STOP_TOTAL_MS = 10_000;
/** Budgets of the extension queries. */
const QUERY_MS = 5_000;
const ACTIVATION_MS = 10_000;
/** How long, and how often, a switched target is checked. */
const SWITCH_VERIFY_MS = 15_000;
const SWITCH_POLL_MS = 500;

const SWITCH_BY_HAND = 'Switch it by hand in the CMSIS Solution panel (Manage Solution → Target) and repeat the call.';

/** What the fence answers if the call itself does not answer in time. */
export const CMSIS_FENCE_ADVICE = 'The CMSIS action may still go on in the CMSIS extension — '
    + 'call cmsis_action {action:\'status\'} to see its job; do not start it again.';

/** What `cmsis_action` needs from the handler that runs it. */
export interface CmsisActionContext {
    readonly executor: IDebuggingExecutor;
    readonly host: HandlerHost;
    /** The handler's session wait with an 8 s override. */
    awaitLiveSession(overrideMs: number): Promise<boolean>;
    /** The full state rendering, which also records the breakpoint list. */
    renderFullState(state: DebugState): string;
}

/** Whether the action runs a cbuild / flash task (build, load, erase, load_and_run). */
export function isTaskAction(action: string): boolean {
    return TASK_ACTIONS.has(action);
}

/** The wait of a call: `timeoutMs` when positive (at most 600 s), else the action's default. */
export function actionTimeoutMs(action: string, timeoutMs: number | undefined): number {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        return Math.min(timeoutMs, LONG_LIMIT_CAP_MS);
    }
    return LONG_WAIT_ACTIONS.has(action) ? LONG_WAIT_DEFAULT_MS : OTHER_WAIT_DEFAULT_MS;
}

/**
 * When the survival probe looks: a first probe about a third into the
 * budget, a second one three quarters in, each allowed a quarter of the
 * budget (at most 5 s) for its threads request.
 */
export function probeSchedule(budgetMs: number): { firstDelayMs: number; secondDelayMs: number; probeMs: number } {
    const budget = Math.max(budgetMs, 1_000);
    const probeMs = Math.min(5_000, Math.floor(budget / 4));
    const firstDelayMs = Math.floor(budget * 0.35);
    const secondDelayMs = Math.max(0, Math.floor(budget * 0.75) - firstDelayMs - probeMs);
    return { firstDelayMs, secondDelayMs, probeMs };
}

interface SolutionAnswer {
    active: boolean;
    solutionPath?: string;
    /** How the answer reads in the no-solution text. */
    description: string;
}

/** `cmsis-csolution.getSolutionFile`, interpreted. Never throws. */
async function activeSolution(): Promise<SolutionAnswer> {
    try {
        const answer: unknown = await withTimeout('cmsis getSolutionFile', QUERY_MS,
            () => Promise.resolve(vscode.commands.executeCommand<unknown>('cmsis-csolution.getSolutionFile')));
        if (!answer) {
            return { active: false, description: 'none' };
        }
        if (typeof answer === 'string') {
            return { active: true, solutionPath: answer, description: answer };
        }
        if (typeof answer === 'object') {
            const fields = answer as { solutionFile?: string; fsPath?: string; path?: string; uri?: { fsPath?: string; path?: string } };
            const solutionPath = fields.solutionFile ?? fields.fsPath ?? fields.path ?? fields.uri?.fsPath ?? fields.uri?.path;
            return { active: true, solutionPath, description: solutionPath ?? '<active, path unknown>' };
        }
        return { active: true, description: '<active, path unknown>' };
    } catch (caught) {
        return { active: false, description: `query failed: ${failureText(caught)}` };
    }
}

/** `cmsis-csolution.getActiveTargetSet`, trimmed; undefined when empty or unavailable. Never throws. */
export async function activeTargetName(): Promise<string | undefined> {
    try {
        const answer: unknown = await withTimeout('cmsis getActiveTargetSet', QUERY_MS,
            () => Promise.resolve(vscode.commands.executeCommand<unknown>('cmsis-csolution.getActiveTargetSet')));
        const name = typeof answer === 'string' ? answer.trim() : '';
        return name.length > 0 ? name : undefined;
    } catch {
        return undefined;
    }
}

/** A failed switch says why, with the code the refusal carries and, when there is one, what to do instead. */
type SwitchResult = { switched: true; active: string } | { switched: false; code: ErrorCode; reason: string; hint?: string };

/** The folder whose `.vscode/cmsis.json` the extension reads for this solution. */
function selectionFolder(solutionPath: string, host: HandlerHost): string {
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(solutionPath));
    if (owner) {
        return owner.uri.fsPath;
    }
    const first = host.workspaceFolders()[0];
    return first ? first.uri.fsPath : path.dirname(solutionPath);
}

/**
 * Make `wanted` the extension's active target: write the selection into
 * cmsis.json, re-activate the solution, and poll until the extension
 * reports it. Each failure says where it stopped and how to do it by hand.
 */
async function switchActiveTarget(
    solutionPath: string | undefined,
    wanted: TargetRef,
    current: string | undefined,
    host: HandlerHost,
): Promise<SwitchResult> {
    const was = current ?? '(none)';
    if (!solutionPath || !fs.existsSync(solutionPath)) {
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `the active target is '${was}' and the csolution path could not be resolved from the CMSIS Solution extension, `
                + 'so the target cannot be switched.',
            hint: SWITCH_BY_HAND,
        };
    }
    let solutionText: string;
    try {
        solutionText = fs.readFileSync(solutionPath, 'utf8');
    } catch (caught) {
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `the active target is '${was}' and ${solutionPath} could not be read (${failureText(caught)}).`,
            hint: SWITCH_BY_HAND,
        };
    }
    const declared = listTargetTypes(solutionText);
    const resolution = resolveTargetSelection(declared, wanted);
    if (!resolution.ok) {
        const choices = formatTargetChoices(declared) || '(none found)';
        return { switched: false, code: 'INVALID_ARGUMENT', reason: `${resolution.reason}. Active target: '${was}'. Declared targets: ${choices}.` };
    }

    const folder = selectionFolder(solutionPath, host);
    const selectionFile = path.join(folder, '.vscode', 'cmsis.json');
    try {
        fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
        const previous = fs.existsSync(selectionFile) ? fs.readFileSync(selectionFile, 'utf8') : '';
        const updated = applyTargetSelection(previous, solutionDisplayName(folder, solutionPath), resolution.type, resolution.setIndex);
        fs.writeFileSync(selectionFile, updated, 'utf8');
    } catch (caught) {
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `could not write ${selectionFile} to select '${resolution.name}' (${failureText(caught)}).`,
            hint: SWITCH_BY_HAND,
        };
    }

    try {
        await withTimeout('cmsis deactivateSolution', ACTIVATION_MS,
            () => Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.deactivateSolution')));
        await withTimeout('cmsis activateSolution', ACTIVATION_MS,
            () => Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.activateSolution', solutionPath)));
    } catch (caught) {
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `wrote '${resolution.name}' to ${selectionFile} but re-activating the solution so the extension picks it up failed `
                + `(${failureText(caught)}).`,
            hint: SWITCH_BY_HAND,
        };
    }

    const giveUpAt = host.now() + SWITCH_VERIFY_MS;
    let reported: string | undefined;
    for (;;) {
        reported = await activeTargetName();
        if (reported && targetMatches(reported, wanted)) {
            return { switched: true, active: reported };
        }
        if (host.now() > giveUpAt) {
            break;
        }
        await host.sleep(SWITCH_POLL_MS);
    }
    return {
        switched: false,
        code: 'INTERNAL',
        reason: `wrote '${resolution.name}' to ${selectionFile} and re-activated the solution, but the CMSIS Solution extension `
            + `still reports '${reported ?? '(none)'}' as the active target after 15 s.`,
        hint: SWITCH_BY_HAND,
    };
}

/** One look at the session: does it exist, and does the adapter report threads? */
async function probeThreads(
    executor: IDebuggingExecutor,
    label: string,
    probeMs: number,
): Promise<{ healthy: boolean; present: boolean; detail: string }> {
    if (!executor.hasDebugSession()) {
        return { healthy: false, present: false, detail: `${label}: no session object` };
    }
    try {
        const threads = await executor.getThreads(probeMs);
        if (threads.length > 0) {
            return { healthy: true, present: true, detail: `${label}: ${threads.length} thread(s)` };
        }
        return { healthy: false, present: true, detail: `${label}: session object present, 0 threads so far` };
    } catch (caught) {
        return { healthy: false, present: executor.hasDebugSession(), detail: `${label}: thread probe failed — ${failureText(caught)}` };
    }
}

/** Two probes on the probe schedule; only the second one decides, and says whether the session object is still there. */
async function checkSurvival(executor: IDebuggingExecutor, host: HandlerHost): Promise<{ stable: boolean; present: boolean; detail: string }> {
    const plan = probeSchedule(SURVIVAL_BUDGET_MS);
    await host.sleep(plan.firstDelayMs);
    const early = await probeThreads(executor, `t+${Math.round(plan.firstDelayMs / 1000)}s`, plan.probeMs);
    await host.sleep(plan.secondDelayMs);
    const lateAt = Math.round((plan.firstDelayMs + plan.probeMs + plan.secondDelayMs) / 1000);
    const late = await probeThreads(executor, `t+${lateAt}s`, plan.probeMs);
    return late.healthy
        ? { stable: true, present: true, detail: `${early.detail}, ${late.detail} — target threads present` }
        : { stable: false, present: late.present, detail: `${early.detail}, then ${late.detail}` };
}

/** How a rejected CMSIS command reads once it reaches the fence. */
function commandFailure(command: string, action: string, caught: unknown, serverVersion: string): ToolError {
    if (/no active solution/i.test(failureText(caught))) {
        return new ToolError('CMSIS_NO_SOLUTION',
            `CMSIS '${action}' failed: no active CMSIS solution. The CMSIS Solution extension has no solution context in THIS VS Code window.`,
            'Fixes:\n'
            + `  1. Make sure the VS Code window running this MCP server (serverVersion=${serverVersion}) has the project's *.csolution.yml folder open — each window is independent.\n`
            + '  2. In that window, open the CMSIS Solution panel and confirm a solution + active context is selected (Manage Solution).\n'
            + '  3. If the solution is open in a different window, drive cmsis_action from that window\'s MCP server instead.\n'
            + 'cmsis_action operates on whatever solution the CMSIS Solution extension has active — it cannot select one for you.');
    }
    return new ToolError('TASK_FAILED', `CMSIS command '${command}' failed: ${String(caught)}.`,
        `Ensure the CMSIS Solution extension is installed and a solution context is active.${recentAdapterTraffic()}`);
}

/** ` on HE`, or nothing when the target is unknown. */
function onTarget(target: string | undefined): string {
    return target ? ` on ${target}` : '';
}

/** What one call works with once its checks are done. */
interface Issue {
    readonly context: CmsisActionContext;
    readonly tracker: CmsisJobTracker;
    /** When the call answers at the latest, on the host's clock. */
    readonly deadline: number;
    readonly command: string;
    /** ` on HE` or ` on HP@debug, switched from HE`. */
    readonly tag: string;
    readonly target: string | undefined;
}

/** The latest time the call may wait until and still answer before its fence. */
function answerBy(issue: Issue): number {
    return issue.deadline - DEADLINE_MARGIN_MS;
}

/**
 * Issue the command and give it the kick-off (4 s, or what is left of the
 * call) to fail; a failure within it rejects the call, a later one is
 * dropped (KB11). `returned` sees what the command resolves with.
 */
async function issueCommand(issue: Issue, action: string, returned?: (value: unknown) => void): Promise<void> {
    const { executor, host } = issue.context;
    let failure: ToolError | undefined;
    let pending: Thenable<unknown>;
    try {
        pending = vscode.commands.executeCommand(issue.command);
    } catch (caught) {
        pending = Promise.reject(caught);
    }
    const settled = Promise.resolve(pending).then(
        (value: unknown) => {
            returned?.(value);
        },
        (caught: unknown) => {
            failure = commandFailure(issue.command, action, caught, executor.getDiagnostics().serverVersion);
        },
    );
    const kickoffMs = Math.max(0, Math.min(KICKOFF_MS, answerBy(issue) - host.now()));
    await new Promise<void>((proceed) => {
        const cancel = host.startTimer(kickoffMs, proceed);
        void settled.then(() => {
            cancel();
            proceed();
        });
    });
    if (failure) {
        throw failure;
    }
}

/** build, load, erase, load_and_run: arm a job, issue the command, wait for the job until the deadline. */
async function runJob(issue: Issue, action: JobAction, labels: ReadonlySet<string> | undefined): Promise<ToolText> {
    const { tracker } = issue;
    const job = tracker.begin(action, issue.target);
    try {
        await issueCommand(issue, action, action === 'build' ? (value) => tracker.identify(job.id, value) : undefined);
    } catch (caught) {
        tracker.settle(job.id, 'not-started', 'Its command failed.');
        throw caught;
    }
    tracker.issued(job.id);
    const outcome = await tracker.waitFor(job.id, answerBy(issue)) ?? job;
    return jobResult(outcome, { tag: issue.tag, now: issue.context.host.now(), command: issue.command, labels });
}

/** A repeated build, load, erase or load_and_run waits for the job in flight instead of starting a second one (#12). */
async function attachToJob(
    context: CmsisActionContext,
    job: Job,
    wanted: TargetRef | undefined,
    active: string | undefined,
    deadline: number,
): Promise<ToolText> {
    const { host } = context;
    const runningOn = job.target ?? active;
    const ago = formatDuration(host.now() - job.armedAt);
    if (wanted && !targetMatches(runningOn, wanted)) {
        throw new ToolError('TASK_FAILED',
            `CMSIS '${job.action}' not started on '${formatTargetName(wanted.type, wanted.set)}': the ${job.action} started ${ago} ago `
                + `on '${runningOn ?? '?'}' is still running (job ${job.id}).`,
            `Wait for it with cmsis_action {action:'status'}, then run ${job.action} on the other target.`);
    }
    const from = job.origin === 'adopted' ? ' from the CMSIS panel' : '';
    const preface = `Attached to the ${job.action} started${from} ${ago} ago (job ${job.id}, not started again). `;
    const outcome = await host.cmsisJobs().waitFor(job.id, deadline - DEADLINE_MARGIN_MS) ?? job;
    return jobResult(outcome, { tag: onTarget(runningOn), now: host.now(), preface });
}

/**
 * `status`: wait for the latest job in flight until the deadline and give
 * its result; with none, the recent results and the live CMSIS tasks, once
 * the error lines of a failed build are in (#15) or the deadline passed.
 * Launches nothing, and needs no solution.
 */
async function reportStatus(context: CmsisActionContext, deadline: number): Promise<ToolText> {
    const { host } = context;
    const tracker = host.cmsisJobs();
    const open = tracker.openJobs();
    const latest = open[open.length - 1];
    if (!latest) {
        const completing = tracker.recent().find((job) => tracker.isCompleting(job.id));
        if (completing) {
            await tracker.waitFor(completing.id, deadline - DEADLINE_MARGIN_MS);
        }
        return idleStatus(tracker.recent(), tracker.liveExecutions(), host.now());
    }
    const others = open.filter((job) => job.id !== latest.id).map((job) => `${job.action} (job ${job.id})`);
    const preface = others.length > 0 ? `Also in flight: ${others.join(', ')}. ` : undefined;
    const outcome = await tracker.waitFor(latest.id, deadline - DEADLINE_MARGIN_MS) ?? latest;
    return jobResult(outcome, { tag: onTarget(outcome.target), now: host.now(), preface });
}

/** Names as a list: `'A'`, `'A' and 'B'`, `'A', 'B' and 'C'`. */
function nameList(executions: readonly ExecutionLike[]): string {
    const names = executions.map((execution) => `'${execution.task.name}'`);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

/**
 * stop_run, verified (#46): note the CMSIS executions, issue the command,
 * give CMSIS Solution's terminate 3 s, terminate what is left ourselves, and
 * report only what has ended within 10 s.
 */
async function stopRun(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { executor, host } = issue.context;
    const snapshot = tracker.stoppableExecutions();
    await issueCommand(issue, 'stop_run');
    const requestedAt = host.now();
    const totalMs = Math.max(0, Math.min(STOP_TOTAL_MS, answerBy(issue) - requestedAt));
    const first = await tracker.waitForEnd(snapshot, Math.min(STOP_GRACE_MS, totalMs));
    let alive = first.alive;
    const insisted = [...alive];
    if (alive.length > 0) {
        for (const execution of alive) {
            try {
                execution.terminate();
            } catch {
                // It may have ended in the meantime.
            }
        }
        const second = await tracker.waitForEnd(alive, Math.max(0, totalMs - (host.now() - requestedAt)));
        for (const [execution, at] of second.endedAt) {
            first.endedAt.set(execution, at);
        }
        alive = second.alive;
    }
    const tag = issue.tag;
    if (snapshot.length === 0) {
        return `CMSIS 'stop_run'${tag}: nothing to stop — no CMSIS task is running in this window. `
            + `'${issue.command}' was issued anyway; it also ends a debug session the CMSIS panel started.`;
    }
    if (alive.length > 0) {
        throw new ToolError('PROBE_BUSY',
            `CMSIS 'stop_run'${tag}: ${nameList(alive)} ${alive.length === 1 ? 'is' : 'are'} still running `
                + `${formatDuration(host.now() - requestedAt)} after the stop request, although terminated twice.`,
            'Stop it with the trash icon in the Terminal panel, then call cmsis_action {action:\'status\'}.');
    }
    const endedLast = Math.max(requestedAt, ...first.endedAt.values());
    const pushed = insisted.length > 0 ? `; ${nameList(insisted)} needed a second terminate` : '';
    const probe = executor.hasDebugSession()
        ? 'a debug session is still active — stop_debugging frees the probe'
        : 'the probe is free';
    return `CMSIS 'stop_run'${tag}: stopped ${nameList(snapshot)} (ended ${formatDuration(endedLast - requestedAt)} `
        + `after the stop request${pushed}); ${probe}.`;
}

/** The last step of load_and_debug and attach: wait for the session, then probe it twice. */
async function sessionPhase(issue: Issue, action: string, loadNote: string, runAlive: boolean): Promise<ToolText> {
    const { executor, host } = issue.context;
    const tag = issue.tag;
    if (!(await issue.context.awaitLiveSession(SESSION_WAIT_MS))) {
        return {
            text: `CMSIS '${action}'${tag} issued via '${issue.command}'.${loadNote ? ` ${loadNote}` : ''} `
                + 'The flash/connect pipeline is running in the CMSIS extension '
                + '(a multi-core flash + attach typically takes 20-40 s). This tool does not block for the whole pipeline — '
                + 'poll get_session_status until it reports \'running\' or \'stopped\'. '
                + 'If get_session_status keeps reporting \'no-session\' with liveSessionsInThisWindow=0, '
                + 'the CMSIS panel is most likely showing a picker the user must resolve. '
                + 'Less often, this call and the poll landed in different windows — check with list_debug_windows and pin one with select_debug_window.',
            status: 'running',
        };
    }
    const survival = await checkSurvival(executor, host);
    const loaded = loadNote ? `${loadNote}; ` : '';
    if (survival.stable) {
        const state = await executor.getCurrentDebugState(3);
        return `CMSIS '${action}' completed${tag} — ${loaded}debug session survived the connect (${survival.detail}). `
            + `State: ${issue.context.renderFullState(state)}`;
    }
    if (survival.present) {
        // A slow multi-core start still has no threads at the second probe: not up yet, not failed (#47).
        return {
            text: `CMSIS '${action}'${tag}: ${loaded}the debug session is up but the target is not reporting threads yet — ${survival.detail}. `
                + 'This is not a failure: poll get_session_status until it reports \'running\' or \'stopped\'.',
            status: 'running',
        };
    }
    const noRun = action === 'attach' && !runAlive
        ? ' No CMSIS Run task is alive in this window — load_and_run first, or load_and_debug.'
        : '';
    throw new ToolError('TASK_FAILED',
        `CMSIS '${action}'${tag} started a debug session but it did NOT survive the initial connect — ${loaded}${survival.detail}.`,
        'For \'attach\' this almost always means no GDB server is listening on the configured port: '
            + `start the GDB server first, or use 'load_and_debug' (which launches one).${noRun} `
            + `Confirm with get_session_status / check_target_connection.${recentAdapterTraffic()}`);
}

/** Wait until load_and_debug's pre-launch Load started or a session exists, for at most `budgetMs`. */
async function loadOrSession(issue: Issue, jobId: string, budgetMs: number): Promise<'load' | 'session' | 'neither'> {
    const { executor, host } = issue.context;
    const giveUpAt = host.now() + budgetMs;
    for (;;) {
        const job = issue.tracker.job(jobId);
        if (job && executionIn(job, 'load')) {
            return 'load';
        }
        if (executor.hasDebugSession()) {
            return 'session';
        }
        if (host.now() >= giveUpAt) {
            return 'neither';
        }
        await host.sleep(LOAD_OR_SESSION_POLL_MS);
    }
}

/**
 * load_and_debug: the pyOCD and J-Link launch configurations run `CMSIS
 * Load` as their pre-launch task; its result comes first, and a failed Load
 * is the answer before any session probe. Without one (FVP, Arm Debugger)
 * the session decides alone.
 */
async function loadAndDebug(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { host } = issue.context;
    const job = tracker.begin('load_and_debug', issue.target);
    try {
        await issueCommand(issue, 'load_and_debug');
    } catch (caught) {
        tracker.settle(job.id, 'not-started', 'Its command failed.');
        throw caught;
    }
    tracker.issued(job.id);
    if ((await loadOrSession(issue, job.id, SESSION_WAIT_MS)) !== 'load') {
        tracker.discard(job.id);
        return sessionPhase(issue, 'load_and_debug', '', false);
    }
    const loadBy = Math.max(host.now(), answerBy(issue) - SESSION_WAIT_MS - SURVIVAL_BUDGET_MS);
    const outcome = await tracker.waitFor(job.id, loadBy) ?? job;
    const load = executionIn(outcome, 'load');
    if (!isSettled(outcome.state) || !load) {
        return stillRunning(outcome, { tag: issue.tag, now: host.now() });
    }
    if (outcome.state !== 'ok') {
        const ended = load.exitCode !== undefined ? `exited with code ${load.exitCode}` : 'ended without an exit code';
        throw new ToolError('TASK_FAILED',
            `❌ CMSIS 'load_and_debug' FAILED${issue.tag} — its pre-launch task '${load.name}' ${ended} after `
                + `${formatDuration(runtimeOf(load, host.now()))}; no debug session was started (job ${outcome.id}).`,
            `Read the '${load.name}' terminal, or call flash, which returns pyOCD's own error lines. If it says "Waiting for a debug probe", `
                + 'something else holds the probe — cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks.');
    }
    const loadNote = `'${load.name}' exited 0 after ${formatDuration(runtimeOf(load, host.now()))} (job ${outcome.id})`;
    return sessionPhase(issue, 'load_and_debug', loadNote, false);
}

/**
 * The body of `cmsis_action`, run inside the handler's fence. `waitMs` is
 * the call's whole wait; everything, the checks and a target switch
 * included, comes out of it.
 */
export async function runCmsisAction(
    context: CmsisActionContext,
    action: string,
    target: string | undefined,
    waitMs: number,
): Promise<ToolText> {
    const { executor, host } = context;
    const deadline = host.now() + waitMs;
    const tracker = host.cmsisJobs();
    if (action === 'status') {
        return reportStatus(context, deadline);
    }
    if (SESSION_ACTIONS.has(action) && executor.hasDebugSession()) {
        const status = await executor.getSessionStatus();
        throw new ToolError('PROBE_BUSY',
            `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). Refusing to ${action}.`,
            'Use stop_debugging or restart_debugging first, or proceed with inspection.');
    }

    const solution = await activeSolution();
    if (!solution.active) {
        throw new ToolError('CMSIS_NO_SOLUTION',
            `CMSIS '${action}' not attempted: the CMSIS Solution extension reports no active solution in this VS Code window `
                + `(cmsis-csolution.getSolutionFile → ${solution.description}).`,
            'cmsis_action operates on whatever solution that extension has active — it cannot select one. '
                + 'Fixes: (1) open the folder containing the project\'s *.csolution.yml in the VS Code window running this MCP server '
                + `(serverVersion=${executor.getDiagnostics().serverVersion}); `
                + '(2) in the CMSIS Solution panel, confirm a solution + active context is selected; '
                + '(3) if the solution is open in a different window, drive cmsis_action from that window\'s MCP server.');
    }

    let active = await activeTargetName();
    let wanted: TargetRef | undefined;
    if (target !== undefined && target !== null) {
        wanted = parseTargetRef(target);
        if (!wanted) {
            throw new ToolError('INVALID_ARGUMENT', `CMSIS '${action}' not attempted: target '${target}' is not a valid reference — `
                + 'pass a target-type name or type@set as declared in the csolution, e.g. \'MPS3\' or \'HP@debug\'.');
        }
    }

    const inFlight = TASK_ACTIONS.has(action) ? tracker.inFlight(action as JobAction) : undefined;
    if (inFlight) {
        return attachToJob(context, inFlight, wanted, active, deadline);
    }
    if (ACTION_COMMANDS.has(action)) {
        const verdict = guardProbe(action as GuardedAction, tracker.probeOwners(), executor.hasDebugSession());
        if (!verdict.allowed) {
            const session = verdict.reason === 'session' ? await executor.getSessionStatus() : undefined;
            throw probeRefusal(action, onTarget(target ?? active), verdict, host.now(),
                session ? { name: session.sessionName, state: session.state } : undefined);
        }
    }

    let switchedFrom: string | undefined;
    if (wanted && !targetMatches(active, wanted)) {
        if (executor.hasDebugSession()) {
            throw new ToolError('PROBE_BUSY',
                `CMSIS '${action}' not attempted: the active target is '${active ?? '(none)'}' and switching to '${target}' `
                    + 're-activates the solution, which is not done under a live debug session.',
                'Call stop_debugging first, then repeat this call.');
        }
        const outcome = await switchActiveTarget(solution.solutionPath, wanted, active, host);
        if (!outcome.switched) {
            throw new ToolError(outcome.code, `CMSIS '${action}' not attempted: ${outcome.reason}`, outcome.hint);
        }
        switchedFrom = active ?? '(none)';
        active = outcome.active;
    }
    const tag = active ? ` on ${active}${switchedFrom !== undefined ? `, switched from ${switchedFrom}` : ''}` : '';

    const command = ACTION_COMMANDS.get(action);
    if (command === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `Unknown CMSIS action: ${action}`);
    }

    // The label pre-check: a task the debugger adapter does not offer is refused before anything runs.
    let labels: ReadonlySet<string> | undefined;
    const label = TASK_ACTIONS.has(action) ? ACTION_PHASES[action as JobAction].label : undefined;
    if (label !== undefined && solution.solutionPath) {
        labels = await tracker.taskLabels(selectionFolder(solution.solutionPath, host));
        if (labels && !labels.has(label)) {
            throw missingTaskRefusal(action as JobAction, tag, label, labels);
        }
    }

    const issue: Issue = { context, tracker, deadline, command, tag, target: active };
    switch (action) {
        case 'stop_run':
            return stopRun(issue);
        case 'detach':
            await issueCommand(issue, action);
            return `CMSIS '${action}'${tag} issued via '${command}'. It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.`;
        case 'attach': {
            const runAlive = tracker.probeOwners().some((owner) => owner.kind === 'run' || owner.kind === 'loadRun');
            await issueCommand(issue, action);
            return sessionPhase(issue, action, '', runAlive);
        }
        case 'load_and_debug':
            return loadAndDebug(issue);
        default:
            return runJob(issue, action as JobAction, labels);
    }
}
