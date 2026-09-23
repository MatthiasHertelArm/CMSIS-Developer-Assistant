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
 * debug commands on the target the agent names, and report how it ended —
 * the exit code of the cbuild / flash task, or whether the debug session the
 * command started survived its first seconds.
 *
 * The extension's commands answer before their work is done, so the outcome
 * comes from elsewhere: `vscode.tasks` process events for the build-class
 * actions, and a session wait plus two thread probes for `load_and_debug` /
 * `attach`. A requested target that is not active is switched by writing the
 * extension's `.vscode/cmsis.json` and re-activating the solution, and the
 * switch is verified before anything runs.
 *
 * Refusals and failed tasks reject with a `ToolError` (`PROBE_BUSY`,
 * `CMSIS_NO_SOLUTION`, `INVALID_ARGUMENT`, `TASK_FAILED`); an action that is
 * still going when the call returns answers with status `running` (#11).
 *
 * Known gaps kept on purpose (fixed separately): the fence can fire before
 * the task waiter (KB2), the task match is case-sensitive and not tied to
 * the command's own task (KB5), late command failures are dropped (KB11),
 * and an unknown action is noticed only after the solution checks (KB17).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { DebugState } from '../debugState';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import {
    applyTargetSelection,
    formatTargetChoices,
    listTargetTypes,
    parseTargetRef,
    resolveTargetSelection,
    solutionDisplayName,
    TargetRef,
    targetMatches,
} from '../core/cmsisTarget';
import { ErrorCode, ToolError, ToolText } from '../core/toolResult';
import { withTimeout } from '../utils/timeout';
import { failureText } from './fence';
import type { HandlerHost, TaskFeed } from './host';
import { recentAdapterTraffic } from './sessionText';

export type CmsisAction = 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach' | 'stop_run';

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

/** Actions that run a cbuild or flash task, with the sentence that follows their success. */
const TASK_ACTIONS: ReadonlyMap<string, string> = new Map([
    ['build', ' The firmware is built — use cmsis_action load or load_and_debug to flash it.'],
    ['load', ' Firmware flashed. Use cmsis_action attach or load_and_debug to start a debug session.'],
    ['erase', ' Target flash erased.'],
    ['load_and_run', ' Firmware flashed and running (no debug session).'],
]);

const SESSION_ACTIONS: ReadonlySet<string> = new Set(['load_and_debug', 'attach']);

/** Fence defaults without a positive `timeoutMs`: task actions get the cap, the rest the usual 30 s. */
const TASK_ACTION_DEFAULT_MS = 60_000;
const OTHER_ACTION_DEFAULT_MS = 30_000;
/** How long the command itself gets to fail before the call moves on. */
const KICKOFF_MS = 4_000;
/** The opportunistic wait for a session started by load_and_debug / attach. */
const SESSION_WAIT_MS = 8_000;
/** Budget of the two-probe survival check. */
const SURVIVAL_BUDGET_MS = 8_000;
/** Budgets of the extension queries. */
const QUERY_MS = 5_000;
const ACTIVATION_MS = 10_000;
/** How long, and how often, a switched target is checked. */
const SWITCH_VERIFY_MS = 15_000;
const SWITCH_POLL_MS = 500;

const SWITCH_BY_HAND = 'Switch it by hand in the CMSIS Solution panel (Manage Solution → Target) and repeat the call.';

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

/** The timeout the call runs under: `timeoutMs` when positive, else the action's default. */
export function actionTimeoutMs(action: string, timeoutMs: number | undefined): number {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        return timeoutMs;
    }
    return isTaskAction(action) ? TASK_ACTION_DEFAULT_MS : OTHER_ACTION_DEFAULT_MS;
}

/** The task waiter's budget, counted from when it is armed. */
function taskBudgetMs(effectiveMs: number): number {
    return Math.max(5_000, effectiveMs - 3_000);
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

interface TaskOutcome {
    /** A matching task process ended. */
    ended: boolean;
    /** A matching task process started while the waiter was armed. */
    started: boolean;
    exitCode?: number;
    taskName?: string;
}

/**
 * A cbuild / CMSIS task, judged from its name, source and definition type.
 * Only the type is lower-cased and the match is case-sensitive, so
 * `CMSIS Load` from a `shell` task never matches (KB5).
 */
function looksLikeCmsisTask(task: vscode.Task): boolean {
    const source = typeof task.source === 'string' ? task.source : '';
    const kind = task.definition?.type ? String(task.definition.type).toLowerCase() : '';
    return /cmsis|cbuild/.test(`${task.name} ${source} ${kind}`);
}

/**
 * Wait for the first matching task process to end, from any execution
 * (KB5), or for the budget to run out. Never rejects; on settling it stops
 * its timer and drops its subscriptions.
 */
function watchCmsisTask(feed: TaskFeed, budgetMs: number, host: HandlerHost): { outcome: Promise<TaskOutcome>; abandon(): void } {
    let started = false;
    let startedName: string | undefined;
    let settled = false;
    let deliver: (outcome: TaskOutcome) => void = () => undefined;
    const outcome = new Promise<TaskOutcome>((resolve) => {
        deliver = resolve;
    });
    const subscriptions: vscode.Disposable[] = [];
    let stopTimer: () => void = () => undefined;
    const settle = (result: TaskOutcome): void => {
        if (settled) {
            return;
        }
        settled = true;
        stopTimer();
        for (const subscription of subscriptions) {
            try {
                subscription.dispose();
            } catch {
                // A failing dispose must not keep the result from the caller.
            }
        }
        deliver(result);
    };
    const expire = (): void => settle({ ended: false, started, taskName: startedName });
    subscriptions.push(feed.onDidStartTaskProcess((event) => {
        const task = event.execution.task;
        if (looksLikeCmsisTask(task)) {
            started = true;
            startedName = task.name;
        }
    }));
    subscriptions.push(feed.onDidEndTaskProcess((event) => {
        const task = event.execution.task;
        if (looksLikeCmsisTask(task)) {
            settle({ ended: true, started, exitCode: event.exitCode, taskName: task.name });
        }
    }));
    stopTimer = host.startTimer(budgetMs, expire);
    return { outcome, abandon: expire };
}

/** One look at the session: does it exist, and does the adapter report threads? */
async function probeThreads(executor: IDebuggingExecutor, label: string, probeMs: number): Promise<{ healthy: boolean; detail: string }> {
    if (!executor.hasDebugSession()) {
        return { healthy: false, detail: `${label}: no session object` };
    }
    try {
        const threads = await executor.getThreads(probeMs);
        if (threads.length > 0) {
            return { healthy: true, detail: `${label}: ${threads.length} thread(s)` };
        }
        return { healthy: false, detail: `${label}: session object present but 0 threads — adapter is not connected to a target` };
    } catch (caught) {
        return { healthy: false, detail: `${label}: thread probe failed — ${failureText(caught)}` };
    }
}

/** Two probes on the probe schedule; only the second one decides. */
async function checkSurvival(executor: IDebuggingExecutor, host: HandlerHost): Promise<{ stable: boolean; detail: string }> {
    const plan = probeSchedule(SURVIVAL_BUDGET_MS);
    await host.sleep(plan.firstDelayMs);
    const early = await probeThreads(executor, `t+${Math.round(plan.firstDelayMs / 1000)}s`, plan.probeMs);
    await host.sleep(plan.secondDelayMs);
    const lateAt = Math.round((plan.firstDelayMs + plan.probeMs + plan.secondDelayMs) / 1000);
    const late = await probeThreads(executor, `t+${lateAt}s`, plan.probeMs);
    return late.healthy
        ? { stable: true, detail: `${early.detail}, ${late.detail} — target threads present` }
        : { stable: false, detail: `${early.detail}, then ${late.detail}` };
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

/**
 * The result of a task action once its waiter settled: success as text, a
 * task still going as status `running`, a failed or cancelled task as
 * `TASK_FAILED`.
 */
function taskResult(action: string, tag: string, command: string, effectiveMs: number, result: TaskOutcome): ToolText {
    if (result.ended && result.exitCode === 0) {
        return `✅ CMSIS '${action}' succeeded${tag} (task '${result.taskName}' exited 0).${TASK_ACTIONS.get(action) ?? ''}`;
    }
    if (result.ended && typeof result.exitCode === 'number') {
        throw new ToolError('TASK_FAILED',
            `❌ CMSIS '${action}' FAILED${tag} — task '${result.taskName}' exited with code ${result.exitCode}.`,
            'Open the CMSIS/cbuild terminal or the Problems panel to read the compiler/linker errors, fix them in the source, '
                + `then re-run cmsis_action ${action}. This is a terminal result — do not wait for an output file.`);
    }
    if (result.ended) {
        throw new ToolError('TASK_FAILED',
            `CMSIS '${action}'${tag} — task '${result.taskName}' ended without an exit code (it may have been cancelled).`,
            `Re-run cmsis_action ${action} to get a definite result.`);
    }
    if (!result.started) {
        return `CMSIS '${action}'${tag} issued via '${command}', but no cbuild/flash task ran within the wait window. `
            + `This usually means the active context is already up to date (nothing to ${action}), `
            + 'or the CMSIS Solution panel is showing a picker that needs manual selection. '
            + 'This is a terminal result — do not wait for an output file. Re-run the action or check the CMSIS panel.';
    }
    const waitedSeconds = Math.round(taskBudgetMs(effectiveMs) / 1000);
    return {
        text: `CMSIS '${action}'${tag} is still running after ${waitedSeconds}s (task '${result.taskName ?? command}' has not finished). `
            + 'Large clean builds can take longer than this. The tool returned so you are not blocked — '
            + `re-run cmsis_action ${action} to get the final exit status, or watch the CMSIS terminal. Do NOT poll for an output file.`,
        status: 'running',
    };
}

/**
 * The body of `cmsis_action`, run inside the handler's fence. `effectiveMs`
 * is the unclamped timeout: the fence caps itself at 60 s while the task
 * waiter keeps the full value (KB2).
 */
export async function runCmsisAction(
    context: CmsisActionContext,
    action: string,
    target: string | undefined,
    effectiveMs: number,
): Promise<ToolText> {
    const { executor, host } = context;
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
    let switchedFrom: string | undefined;
    if (target !== undefined && target !== null) {
        const wanted = parseTargetRef(target);
        if (!wanted) {
            throw new ToolError('INVALID_ARGUMENT', `CMSIS '${action}' not attempted: target '${target}' is not a valid reference — `
                + 'pass a target-type name or type@set as declared in the csolution, e.g. \'MPS3\' or \'HP@debug\'.');
        }
        if (!targetMatches(active, wanted)) {
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
    }
    const tag = active ? ` on ${active}${switchedFrom !== undefined ? `, switched from ${switchedFrom}` : ''}` : '';

    const command = ACTION_COMMANDS.get(action);
    if (command === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `Unknown CMSIS action: ${action}`);
    }

    const waiter = isTaskAction(action) ? watchCmsisTask(host.taskFeed(), taskBudgetMs(effectiveMs), host) : undefined;

    let failure: ToolError | undefined;
    let pending: Thenable<unknown>;
    try {
        pending = vscode.commands.executeCommand(command);
    } catch (caught) {
        pending = Promise.reject(caught);
    }
    const settled = Promise.resolve(pending).then(
        () => undefined,
        (caught: unknown) => {
            failure = commandFailure(command, action, caught, executor.getDiagnostics().serverVersion);
        },
    );
    await new Promise<void>((proceed) => {
        const cancel = host.startTimer(KICKOFF_MS, proceed);
        void settled.then(() => {
            cancel();
            proceed();
        });
    });
    if (failure) {
        waiter?.abandon();
        throw failure;
    }

    if (SESSION_ACTIONS.has(action)) {
        if (!(await context.awaitLiveSession(SESSION_WAIT_MS))) {
            return {
                text: `CMSIS '${action}'${tag} issued via '${command}'. The flash/connect pipeline is running in the CMSIS extension `
                    + '(a multi-core flash + attach typically takes 20-40 s). This tool does not block for the whole pipeline — '
                    + 'poll get_session_status until it reports \'running\' or \'stopped\'. '
                    + 'If get_session_status keeps reporting \'no-session\' with liveSessionsInThisWindow=0, '
                    + 'the CMSIS panel is most likely showing a picker the user must resolve. '
                    + 'Less often, this call and the poll landed in different windows — check with list_debug_windows and pin one with select_debug_window.',
                status: 'running',
            };
        }
        const survival = await checkSurvival(executor, host);
        if (survival.stable) {
            const state = await executor.getCurrentDebugState(3);
            return `CMSIS '${action}' completed${tag} — debug session survived the connect (${survival.detail}). `
                + `State: ${context.renderFullState(state)}`;
        }
        throw new ToolError('TASK_FAILED',
            `CMSIS '${action}'${tag} started a debug session but it did NOT survive the initial connect — ${survival.detail}.`,
            'For \'attach\' this almost always means no GDB server is listening on the configured port: '
                + 'start the GDB server first, or use \'load_and_debug\' (which launches one). '
                + `Confirm with get_session_status / check_target_connection.${recentAdapterTraffic()}`);
    }

    if (waiter) {
        return taskResult(action, tag, command, effectiveMs, await waiter.outcome);
    }

    return `CMSIS '${action}'${tag} issued via '${command}'. It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.`;
}
