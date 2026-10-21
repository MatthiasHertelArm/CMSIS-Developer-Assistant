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
 * session that it probes twice. rebuild and clean run CMSIS Solution's
 * Rebuild and Clean (1.72.0), the build task type with `--rebuild` or
 * `--clean`, as jobs of their own; stop_build ends the build-type tasks of
 * the window and says whether one was running.
 *
 * One deadline per call (#12): the wait (60 s by default, up to 600 s) counts
 * from the call, so the solution checks and a target switch come out of it,
 * and the call answers before its fence. A job still going at the deadline is
 * answered with status `running`; `status` waits for it, and a repeated build,
 * rebuild, clean, load, erase or load_and_run attaches to the job in flight
 * instead of starting a second one. A build, rebuild or clean while another
 * of the three is in flight is refused: CMSIS Solution would start it only
 * after that one ended.
 *
 * Before anything is issued (#46): a debug session refuses load_and_debug and
 * attach, the probe guard refuses what CMSIS Run, a Load, an Erase, `flash` or
 * a session blocks, a target that is not active is switched through
 * `.vscode/cmsis.json` and verified, and a task the debugger adapter does not
 * offer is refused by its label. stop_run waits until the CMSIS tasks ended.
 * A tasks.json with no CMSIS task at all, while the active target's
 * cbuild-run.yml names a debugger, is written once through
 * `cmsis-csolution.updateDebugTasks` (what CMSIS Solution runs after each
 * successful convert) and the labels are read again; otherwise, or when that
 * did not help, the refusal names Manage Solution Settings.
 *
 * Refusals and failed tasks reject with a `ToolError` (`PROBE_BUSY`,
 * `CMSIS_NO_SOLUTION`, `NO_WORKSPACE`, `INVALID_ARGUMENT`, `TASK_FAILED`); an
 * action that is still going when the call returns answers with status
 * `running` (#11). Without an active solution the refusal says which part is
 * missing: a folder (`NO_WORKSPACE`), the CMSIS Solution extension, a
 * csolution file, or the extension's activation of one that is there.
 *
 * `open_solution` is the one action that needs no active solution: it opens
 * the folder of a csolution in a new VS Code window, or, when that folder is
 * already open here, makes the solution the extension's active one. The
 * router then aims the session at the window that holds the folder.
 * `install_pack` needs none either: it installs one pack version through the
 * extension, after the user accepted its licence (`./installPack.ts`).
 * `create_solution` needs none either: CMSIS Solution's API creates the
 * project from an example or template (`createSolution.ts`).
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
import {
    ACTION_PHASES,
    BUILD_ACTIONS,
    executionIn,
    guardProbe,
    GuardedAction,
    hasCmsisTasks,
    isBuildAction,
    isSettled,
    Job,
    JobAction,
    runtimeOf,
} from '../core/cmsisTasks';
import { DIAGNOSTIC_RERUN_CAP_MS } from '../core/buildFailure';
import { cbuildRunDebugger } from '../core/packDocs/cbuildRun';
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
import {
    isSolutionFile,
    liesInside,
    LISTED_SOLUTION_GLOB,
    listedSolutionExclude,
    missingSolutionExtensionRefusal,
    noSolutionRefusal,
    noWorkspaceRefusal,
    samePath,
    SOLUTION_EXTENSION_ID,
} from '../core/bootstrapState';
import { activeTargetSetOf, solutionAnswerOf } from '../core/solutionAnswers';
import { ErrorCode, ToolError, ToolText } from '../core/toolResult';
import { AttachEndpoint, isFvpDebugger, launchAttachEndpoints, runCommandKind, taskCommandWords } from '../core/gdbServerPorts';
import { AGENT_START_WINDOW_MS, expectAgentStart } from '../utils/sessionStateTracker';
import { findSolutionFiles } from '../utils/solutionFiles';
import { HardwareTimeoutError, withTimeout } from '../utils/timeout';
import { survivesWindowReload } from '../core/clientHosting';
import { logger } from '../utils/logger';
import { failureText, LONG_LIMIT_CAP_MS } from './fence';
import { createSolution, CreateRequest } from './createSolution';
import type { HandlerHost } from './host';
import { flashFailedHint, formatDuration, idleStatus, jobResult, MissingTasksNote, missingTaskRefusal, probeRefusal, stillRunning } from './jobText';
import { runInstallPack } from './installPack';

export type CmsisAction = 'build' | 'rebuild' | 'clean' | 'load' | 'erase' | 'run' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach'
    | 'stop_run' | 'stop_build' | 'status' | 'open_solution' | 'install_pack' | 'create_solution';

/** The CMSIS Solution command behind each action. A Map, so `constructor` and friends are not actions. */
const ACTION_COMMANDS: ReadonlyMap<string, string> = new Map([
    ['build', 'cmsis-csolution.build'],
    ['rebuild', 'cmsis-csolution.rebuild'],
    ['clean', 'cmsis-csolution.clean'],
    ['stop_build', 'cmsis-csolution.stopBuild'],
    ['load', 'cmsis-csolution.cmsisLoad'],
    ['erase', 'cmsis-csolution.cmsisErase'],
    ['run', 'cmsis-csolution.cmsisRun'],
    ['load_and_run', 'cmsis-csolution.cmsisLoadAndRun'],
    ['load_and_debug', 'cmsis-csolution.cmsisLoadAndDebug'],
    ['attach', 'cmsis-csolution.cmsisAttachDebugger'],
    ['detach', 'cmsis-csolution.cmsisDetachDebugger'],
    ['stop_run', 'cmsis-csolution.cmsisStopRun'],
]);

/** Actions that run a CMSIS task and end with its result; a repeated one attaches to the job in flight. */
const TASK_ACTIONS: ReadonlySet<string> = new Set(['build', 'rebuild', 'clean', 'load', 'erase', 'run', 'load_and_run']);
const SESSION_ACTIONS: ReadonlySet<string> = new Set(['load_and_debug', 'attach']);
/** Actions whose default wait is the long one: they wait for a task. */
const LONG_WAIT_ACTIONS: ReadonlySet<string> = new Set(['build', 'rebuild', 'clean', 'load', 'erase', 'run', 'load_and_run', 'load_and_debug', 'status',
    'install_pack', 'create_solution']);

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
/** stop_run and stop_build: the CMSIS Solution's own terminate gets this long, the whole stop this long. */
const STOP_GRACE_MS = 3_000;
const STOP_TOTAL_MS = 10_000;
/** Budgets of the extension queries. */
const QUERY_MS = 5_000;
const ACTIVATION_MS = 10_000;
/** How long, and how often, a switched target is checked. */
const SWITCH_VERIFY_MS = 15_000;
const SWITCH_POLL_MS = 500;

/** How long Update Debug Tasks may take, and how long its tasks then get to show in VS Code's task list. */
const UPDATE_TASKS_MS = 10_000;
const TASKS_APPEAR_MS = 5_000;
const TASKS_POLL_MS = 500;

/** How long the workspace search for csolution files may take before the refusal goes without it. */
const SOLUTION_SEARCH_MS = 2_000;
/** How long open_solution waits for the extension to report the solution it activated. */
const OPEN_VERIFY_MS = 20_000;
/** Where the workspace search does not look for a csolution. */
const SOLUTION_SEARCH_EXCLUDE = '**/{node_modules,out,tmp,build}/**';
/** How long open_solution's search for the csolution files the CMSIS Solution extension lists may take; it returns all of them. */
const SOLUTION_LIST_MS = 5_000;

const SWITCH_BY_HAND = 'Switch it by hand in the CMSIS Solution panel (Manage Solution → Target) and repeat the call.';

/** open_solution: the user selects the solution when the extension did not take it. */
const SELECT_SOLUTION_BY_HAND = 'Ask the user to select it in the CMSIS view (Select as Active Solution), or to reload the window, '
    + 'then repeat this call; get_recent_problems shows what the extension reported.';
/** open_solution: the extension's activateSolution did not return; it waits in its picker when it does not know the path. */
const PICKER_HINT = 'If VS Code shows the CMSIS Solution extension\'s "Select a solution" picker, the extension did not recognise the path: '
    + 'ask the user to pick the solution there or in the CMSIS view (Select as Active Solution), then repeat this call. '
    + 'get_recent_problems shows what the extension reported.';
/** open_solution: which csolution files the CMSIS Solution extension lists, and so can activate. */
const UNLISTED_HINT = 'It lists only files whose names end in .csolution.yml or .csolution.yaml, that ending in lower case, outside hidden folders '
    + 'and outside what the settings cmsis-csolution.exclude and files.exclude exclude. Ask the user to rename or move the file, '
    + 'or to change the setting, then repeat this call.';

/** What the fence answers if the call itself does not answer in time. */
export const CMSIS_FENCE_ADVICE = 'The CMSIS action may still go on in the CMSIS extension — '
    + 'call cmsis_action {action:\'status\'} to see its job; do not start it again.';

/**
 * How the handler's wait for a live session ended: `live` (running or
 * stopped), `gone` (a session showed up and ended before it came up), or
 * `timeout`.
 */
export type LiveSessionWait = 'live' | 'gone' | 'timeout';

/** What `cmsis_action` needs from the handler that runs it. */
export interface CmsisActionContext {
    readonly executor: IDebuggingExecutor;
    readonly host: HandlerHost;
    /** The handler's session wait with an 8 s override, ended early by a session that ends before it comes up. */
    awaitLiveSession(overrideMs: number): Promise<LiveSessionWait>;
    /** The full state rendering, which also records the breakpoint list. */
    renderFullState(state: DebugState): string;
}

/** Whether the action runs a CMSIS task (build, rebuild, clean, load, erase, run, load_and_run). */
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
        const { active, file } = solutionAnswerOf(answer);
        if (!active) {
            return { active: false, description: 'none' };
        }
        return { active: true, solutionPath: file, description: file ?? '<active, path unknown>' };
    } catch (caught) {
        return { active: false, description: `query failed: ${failureText(caught)}` };
    }
}

/** `cmsis-csolution.getActiveTargetSet`, trimmed; undefined when empty or unavailable. Never throws. */
export async function activeTargetName(): Promise<string | undefined> {
    try {
        const answer: unknown = await withTimeout('cmsis getActiveTargetSet', QUERY_MS,
            () => Promise.resolve(vscode.commands.executeCommand<unknown>('cmsis-csolution.getActiveTargetSet')));
        return activeTargetSetOf(answer);
    } catch {
        return undefined;
    }
}

/** A failed switch says why, with the code the refusal carries and, when there is one, what to do instead. */
type SwitchResult = { switched: true; active: string } | { switched: false; code: ErrorCode; reason: string; hint?: string };

/**
 * The workspace folder that holds the solution: where CMSIS Solution keeps its
 * `.vscode/tasks.json` and `launch.json` (1.72.0 `solutionManager.workspaceFolder`).
 */
function selectionFolder(solutionPath: string, host: HandlerHost): string {
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(solutionPath));
    if (owner) {
        return owner.uri.fsPath;
    }
    const first = host.workspaceFolders()[0];
    return first ? first.uri.fsPath : path.dirname(solutionPath);
}

/**
 * The folder whose `.vscode/cmsis.json` CMSIS Solution reads the active target
 * from: the workspace's first folder, whichever folder holds the solution
 * (1.72.0 `CmsisSettingsJsonFile`); not `selectionFolder` when the solution
 * lies in another folder of a multi-root workspace.
 */
function targetSettingsFolder(solutionPath: string, host: HandlerHost): string {
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

    const folder = targetSettingsFolder(solutionPath, host);
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

/** The verdict on a session that ended before it came up, which leaves nothing to probe. */
const ENDED_BEFORE_UP = { stable: false, present: false, detail: 'it ended before it came up' };

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
        'Ensure the CMSIS Solution extension is installed and a solution context is active.');
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

/**
 * build, rebuild, clean, load, erase, run, load_and_run: arm a job, issue the
 * command, wait for the job until the deadline. The build commands return
 * their task's execution, which is the job's task. `preface` goes before the
 * result.
 */
async function runJob(issue: Issue, action: JobAction, labels: ReadonlySet<string> | undefined, preface?: string): Promise<ToolText> {
    const { tracker } = issue;
    const job = tracker.begin(action, issue.target);
    try {
        await issueCommand(issue, action, isBuildAction(action) ? (value) => tracker.identify(job.id, value) : undefined);
    } catch (caught) {
        tracker.settle(job.id, 'not-started', 'Its command failed.');
        throw caught;
    }
    tracker.issued(job.id);
    const outcome = await tracker.waitFor(job.id, answerBy(issue)) ?? job;
    return jobResult(outcome, { tag: issue.tag, now: issue.context.host.now(), command: issue.command, labels, preface });
}

/** A repeated build, rebuild, clean, load, erase, run or load_and_run waits for the job in flight instead of starting a second one (#12). */
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

/**
 * stop_build: end the window's build-type tasks — a build, rebuild or clean,
 * or the cbuild setup CMSIS Solution runs after loading a solution —
 * through `cmsis-csolution.stopBuild`, which ends one of them; give it 3 s,
 * terminate what is left ourselves, and report only what has ended within
 * 10 s. Their jobs count as stopped. With none running nothing is issued,
 * and the answer says so, also when a build's result is still being checked:
 * that check is no task, and `status` waits for it.
 */
async function stopBuild(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { host } = issue.context;
    const tag = issue.tag;
    const running = tracker.buildExecutions();
    if (running.length === 0) {
        const checking = tracker.recent().filter((job) => tracker.isCompleting(job.id)).map((job) => `${job.action} job ${job.id}`);
        const note = checking.length > 0
            ? ` The result of ${checking.join(' and ')} is still being checked (a diagnostic re-run of cbuild, at most `
                + `${DIAGNOSTIC_RERUN_CAP_MS / 1_000} s); that is no CMSIS task and ends by itself — cmsis_action {action:'status'} waits for it.`
            : '';
        return `CMSIS 'stop_build'${tag}: nothing to stop — no build is running in this window.${note}`;
    }
    const jobs = tracker.requestStop(running);
    let direct = '';
    try {
        await issueCommand(issue, 'stop_build');
    } catch (caught) {
        direct = `; '${issue.command}' failed (${failureText(caught)}), so they were terminated directly`;
    }
    const requestedAt = host.now();
    const totalMs = Math.max(0, Math.min(STOP_TOTAL_MS, answerBy(issue) - requestedAt));
    const first = await tracker.waitForEnd(running, direct ? 0 : Math.min(STOP_GRACE_MS, totalMs));
    let alive = first.alive;
    const insisted = direct ? [] : [...alive];
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
    if (alive.length > 0) {
        throw new ToolError('TASK_FAILED',
            `CMSIS 'stop_build'${tag}: ${nameList(alive)} ${alive.length === 1 ? 'is' : 'are'} still running `
                + `${formatDuration(host.now() - requestedAt)} after the stop request, although terminated${direct ? '' : ' twice'}.`,
            'Stop it with the trash icon of its terminal in the Terminal panel, then call cmsis_action {action:\'status\'}.');
    }
    const endedLast = Math.max(requestedAt, ...first.endedAt.values());
    const pushed = insisted.length > 0 ? `; ${nameList(insisted)} needed a second terminate` : '';
    const ids = jobs.length > 0 ? `; job ${jobs.map((job) => job.id).join(', ')}` : '';
    return `CMSIS 'stop_build'${tag}: stopped ${nameList(running)} (ended ${formatDuration(endedLast - requestedAt)} after the stop request`
        + `${pushed}${direct}${ids}). Its outputs are incomplete: cmsis_action build before load or flash.`;
}

/** `cmsis-csolution.autoDebugLaunch` is off: CMSIS Solution then writes no launch.json or tasks.json. Never throws. */
function autoDebugLaunchOff(folder: string): boolean {
    try {
        return vscode.workspace.getConfiguration('cmsis-csolution', vscode.Uri.file(folder)).get<boolean>('autoDebugLaunch', true) === false;
    } catch {
        return false;
    }
}

/** What the one run of Update Debug Tasks did for a tasks.json without CMSIS tasks: the labels after it, and what the result or the refusal says. */
interface TasksRepair {
    labels?: ReadonlySet<string>;
    /** Set when the CMSIS tasks are there now: the sentence the result starts with. */
    wrote?: string;
    /** Set when they are not: why, for the refusal. */
    missing?: MissingTasksNote;
}

const BUILD_FIRST_HINT = 'cmsis_action build first: its convert writes the cbuild-run.yml, and CMSIS Solution then writes the CMSIS tasks '
    + 'when the target set names a debugger. If it names none, ask the user to choose one in Manage Solution Settings '
    + '(command cmsis-csolution.manageSolution) on its Debugger page. Until then, flash programs the target.';

/**
 * A tasks.json without CMSIS tasks while the active target's cbuild-run.yml
 * names a debugger: run `cmsis-csolution.updateDebugTasks` once — what CMSIS
 * Solution runs after each successful convert; it rewrites only the CMSIS
 * tasks and the launch configurations it generated — and read the labels
 * again until they show, for at most 5 s. Not when no debugger is named (the
 * command does nothing then) or `cmsis-csolution.autoDebugLaunch` is off (it
 * writes no file then). At most once per call: the caller then proceeds or
 * refuses.
 *
 * The cbuild-run.yml is the one the extension names (the host's lookup, as
 * for `flash`): Update Debug Tasks reads that file and no other, so another
 * one found on disk would not predict what it does.
 */
async function writeCmsisTasks(issue: Pick<Issue, 'context' | 'tracker' | 'deadline'>, folder: string): Promise<TasksRepair> {
    const { host } = issue.context;
    if (autoDebugLaunchOff(folder)) {
        return {
            missing: {
                reason: 'the setting cmsis-csolution.autoDebugLaunch is off, so CMSIS Solution writes no tasks.json',
                hint: 'Ask the user to turn on cmsis-csolution.autoDebugLaunch (in Settings, or in Manage Solution Settings, command '
                    + 'cmsis-csolution.manageSolution); CMSIS Solution then writes the CMSIS tasks. Until then, flash programs the target.',
            },
        };
    }
    const runFile = await host.activeCbuildRunFile();
    if (!runFile || !fs.existsSync(runFile)) {
        return { missing: { reason: 'the active target has no cbuild-run.yml yet', hint: BUILD_FIRST_HINT } };
    }
    let debuggerName: string | undefined;
    try {
        debuggerName = cbuildRunDebugger(fs.readFileSync(runFile, 'utf8'));
    } catch {
        // Unreadable: no debugger is known.
    }
    if (!debuggerName) {
        return { missing: { reason: `${path.basename(runFile)} names no debugger` } };
    }
    const updateMs = Math.max(1, Math.min(UPDATE_TASKS_MS, issue.deadline - DEADLINE_MARGIN_MS - host.now()));
    try {
        await withTimeout('cmsis updateDebugTasks', updateMs,
            () => Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.updateDebugTasks')));
    } catch (caught) {
        return { missing: { reason: `Update Debug Tasks (cmsis-csolution.updateDebugTasks) for the debugger '${debuggerName}' failed: ${failureText(caught)}` } };
    }
    logger.info(`cmsis_action: tasks.json had no CMSIS tasks; ran cmsis-csolution.updateDebugTasks for '${debuggerName}'`);
    const giveUpAt = Math.min(issue.deadline - DEADLINE_MARGIN_MS, host.now() + TASKS_APPEAR_MS);
    let labels: ReadonlySet<string> | undefined;
    for (;;) {
        labels = await issue.tracker.taskLabels(folder, true);
        if (labels && hasCmsisTasks(labels)) {
            return { labels, wrote: `tasks.json had no CMSIS tasks; Update Debug Tasks wrote them for the debugger '${debuggerName}'.` };
        }
        if (host.now() >= giveUpAt) {
            break;
        }
        await host.sleep(TASKS_POLL_MS);
    }
    return { labels, missing: { reason: `Update Debug Tasks (cmsis-csolution.updateDebugTasks) ran for the debugger '${debuggerName}' but wrote none` } };
}

/**
 * The last step of load_and_debug and attach: wait for the session, then
 * probe it twice. A session that ended before it came up is not probed.
 */
async function sessionPhase(issue: Issue, action: string, loadNote: string, runAlive: boolean): Promise<ToolText> {
    const { executor, host } = issue.context;
    const tag = issue.tag;
    const wait = await issue.context.awaitLiveSession(SESSION_WAIT_MS);
    if (wait === 'timeout') {
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
    const survival = wait === 'gone' ? ENDED_BEFORE_UP : await checkSurvival(executor, host);
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
        ? ' No CMSIS Run task is alive in this window — cmsis_action run starts the GDB server without programming '
            + '(the pyOCD task resets the target first); load_and_run programs first.'
        : '';
    throw new ToolError('TASK_FAILED',
        `CMSIS '${action}'${tag} started a debug session but it did NOT survive the initial connect — ${loaded}${survival.detail}.`,
        'For \'attach\' this almost always means no GDB server is listening on the configured port: '
            + `start the GDB server first, or use 'load_and_debug' (which launches one).${noRun} `
            + 'Confirm with get_session_status / check_target_connection.');
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
/**
 * The session this call is about to have CMSIS Solution start counts as the
 * agent's, for as long as the call may wait plus a minute: a failed start
 * then reaches the agent instead of VS Code's modal dialog.
 */
function expectSessionOf(issue: Issue): void {
    expectAgentStart(Math.max(AGENT_START_WINDOW_MS, answerBy(issue) - issue.context.host.now() + 60_000));
}

/** The attach endpoints as the refusal and the note name them: `localhost:3333 ('… (attach)')`. */
function endpointList(endpoints: readonly AttachEndpoint[]): string {
    return endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port} ('${endpoint.name}')`).join(', ');
}

/** The debugger the active target's cbuild-run.yml names; undefined when there is none or it cannot be read. */
async function activeDebuggerName(host: HandlerHost): Promise<string | undefined> {
    const runFile = await host.activeCbuildRunFile();
    if (!runFile) {
        return undefined;
    }
    try {
        return cbuildRunDebugger(await fs.promises.readFile(runFile, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Before an attach while a CMSIS Run task is alive: refuse it when that task
 * is an FVP model without its GDB server plugin (the FVP adapter's Run; the
 * plugin belongs to the launch configuration), so that nothing the window
 * started listens on the attach configurations' ports and load_and_debug is
 * the way. The task's command line tells; where it does not (a model shim),
 * the target's Arm-FVP debugger does. The ports are never tried: a GDB server
 * takes a connection as a client (`src/core/gdbServerPorts.ts`).
 */
async function refuseAttachToBareModel(issue: Issue, endpoints: readonly AttachEndpoint[]): Promise<void> {
    if (endpoints.length === 0) {
        return;
    }
    const kinds = issue.tracker.liveExecutions().filter((live) => live.kind === 'run')
        .map((live) => runCommandKind(taskCommandWords(live.execution.task)));
    if (kinds.includes('gdbServer')) {
        return;
    }
    const bareModel = (kinds.length > 0 && kinds.every((kind) => kind === 'bareModel'))
        || isFvpDebugger(await activeDebuggerName(issue.context.host));
    if (!bareModel) {
        return;
    }
    throw new ToolError('NO_SESSION',
        `CMSIS 'attach'${issue.tag} not started: a CMSIS Run task is alive in this window, but it runs the FVP model without the `
            + `GDB server plugin: nothing it started listens on ${endpointList(endpoints)}.`,
        'This adapter\'s CMSIS Run hosts no GDB server (an FVP runs the image without one; the plugin belongs to the launch configuration). '
            + 'Use load_and_debug, which launches the server with the session; cmsis_action stop_run ends the running task first.');
}

/**
 * An attach with no CMSIS Run task alive goes ahead unchecked: a GDB server
 * started outside the window may listen, and GDB's own connect finds out. A
 * reply that is still `running` says what happens when none does.
 */
function withoutRunNote(answer: ToolText, endpoints: readonly AttachEndpoint[]): ToolText {
    if (typeof answer === 'string' || answer.status !== 'running' || endpoints.length === 0) {
        return answer;
    }
    return {
        ...answer,
        text: `${answer.text} No CMSIS Run task is alive in this window, so only a GDB server started outside it can serve `
            + `${endpointList(endpoints)}; without one the session ends at GDB's 15 s connect timeout. With a probe adapter, `
            + 'cmsis_action run starts the server without programming; load_and_debug starts a session of its own.',
    };
}

async function loadAndDebug(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { host } = issue.context;
    const job = tracker.begin('load_and_debug', issue.target);
    expectSessionOf(issue);
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
            flashFailedHint(load.name));
    }
    const loadNote = `'${load.name}' exited 0 after ${formatDuration(runtimeOf(load, host.now()))} (job ${outcome.id})`;
    return sessionPhase(issue, 'load_and_debug', loadNote, false);
}

/** The csolution files of the open workspace, at most five, or undefined when the search failed or took too long. */
async function workspaceSolutionFiles(host: HandlerHost): Promise<string[] | undefined> {
    try {
        const found = await withTimeout('csolution search', SOLUTION_SEARCH_MS,
            () => Promise.resolve(host.findFiles('**/*.csolution.{yml,yaml}', SOLUTION_SEARCH_EXCLUDE, 5)));
        return found.map((uri) => uri.fsPath).sort();
    } catch {
        return undefined;
    }
}

/**
 * The csolution files the CMSIS Solution extension lists for this window, as
 * it spells them: its own search (1.72.0 `getSolutionPaths`), every workspace
 * folder with its include and exclude, no limit, `Uri.fsPath` of each.
 * Undefined when the search failed or took too long.
 */
async function listedSolutions(host: HandlerHost): Promise<string[] | undefined> {
    try {
        const exclude = listedSolutionExclude(vscode.workspace.getConfiguration('cmsis-csolution').get<unknown>('exclude'));
        const found = await withTimeout('csolution list', SOLUTION_LIST_MS,
            () => Promise.resolve(host.findFiles(LISTED_SOLUTION_GLOB, exclude)));
        return found.map((uri) => uri.fsPath);
    } catch {
        return undefined;
    }
}

/** The real path of an existing file or folder: links resolved, the names as the file system stores them; undefined when it cannot be resolved. */
function realPathOf(file: string): string | undefined {
    try {
        return fs.realpathSync.native(file);
    } catch {
        return undefined;
    }
}

/** Whether `a` and `b` are the same file: the same real path when both resolve, else the same path (`samePath`). */
function sameFile(a: string, b: string): boolean {
    const realA = realPathOf(a);
    const realB = realA === undefined ? undefined : realPathOf(b);
    return realA !== undefined && realB !== undefined ? realA === realB : samePath(a, b);
}

/** Whether `target` is `folder` or lies below it, as written or once both are resolved to real paths. */
function liesInFolder(target: string, folder: string): boolean {
    if (liesInside(target, folder)) {
        return true;
    }
    const realTarget = realPathOf(target);
    const realFolder = realTarget === undefined ? undefined : realPathOf(folder);
    return realTarget !== undefined && realFolder !== undefined && liesInside(realTarget, realFolder);
}

/**
 * `file` spelled as the CMSIS Solution extension lists it, or undefined when
 * the extension does not list it. Its activateSolution takes a path only when
 * it equals, character for character, an entry of its list (`Uri.fsPath`:
 * the workspace folder as VS Code has it, the names below it as on disk, on
 * Windows the drive letter in lower case); for any other path it opens its
 * "Select a solution" picker and waits for the user (#84, #99). The entry is
 * the same file by real path, so another letter case, other separators or a
 * path through a link find it; one spelled as given comes first. Without the
 * list, the path goes in as `Uri.file` writes it.
 */
async function solutionAsListed(file: string, host: HandlerHost): Promise<string | undefined> {
    const listed = await listedSolutions(host);
    if (listed === undefined) {
        return vscode.Uri.file(file).fsPath;
    }
    const same = listed.filter((entry) => sameFile(entry, file));
    return same.find((entry) => samePath(entry, file)) ?? same[0];
}

/**
 * Why the window has no active solution, as the refusal an action answers
 * with: no folder open, the CMSIS Solution extension not installed, no
 * csolution in the workspace, or one that the extension has not loaded.
 */
async function whyNoSolution(what: string, queried: string, host: HandlerHost, serverVersion: string): Promise<ToolError> {
    const folders = host.workspaceFolders();
    if (folders.length === 0) {
        return noWorkspaceRefusal(what);
    }
    if (!host.toolEnvironment().extension(SOLUTION_EXTENSION_ID)) {
        return missingSolutionExtensionRefusal(what);
    }
    return noSolutionRefusal(what, queried, await workspaceSolutionFiles(host), folders.map((folder) => folder.name), serverVersion);
}

/** What `open_solution` found at its path: the folder to open and the csolution files in it. */
interface SolutionPlace {
    folder: string;
    /** The csolution the caller named, when the path is a file. */
    named?: string;
    solutions: string[];
}

/** The folder and csolution files `given` stands for; a path that cannot be opened is `INVALID_ARGUMENT`. */
function placeOf(given: string | undefined): SolutionPlace {
    const usage = 'Pass path: the absolute path of a *.csolution.yml, or of the folder that holds the project.';
    if (typeof given !== 'string' || given.trim().length === 0) {
        throw new ToolError('INVALID_ARGUMENT', 'CMSIS \'open_solution\' not attempted: no path given.', usage);
    }
    const wanted = given.trim();
    if (!path.isAbsolute(wanted)) {
        throw new ToolError('INVALID_ARGUMENT', `CMSIS 'open_solution' not attempted: '${wanted}' is not an absolute path.`, usage);
    }
    let stats: fs.Stats;
    try {
        stats = fs.statSync(wanted);
    } catch {
        throw new ToolError('INVALID_ARGUMENT', `CMSIS 'open_solution' not attempted: ${wanted} does not exist.`, usage);
    }
    if (stats.isDirectory()) {
        return { folder: wanted, solutions: findSolutionFiles(wanted) };
    }
    if (!isSolutionFile(wanted)) {
        throw new ToolError('INVALID_ARGUMENT', `CMSIS 'open_solution' not attempted: ${wanted} is neither a folder nor a *.csolution.yml.`, usage);
    }
    return { folder: path.dirname(wanted), named: wanted, solutions: [wanted] };
}

/** `, which has N csolution files: a, b` or the note that there is none yet. */
function solutionsNote(place: SolutionPlace): string {
    if (place.solutions.length === 0) {
        return 'It has no *.csolution.yml yet: create the solution there before cmsis_action build.';
    }
    const names = place.solutions.map((file) => path.relative(place.folder, file) || path.basename(file));
    return place.solutions.length === 1 ? `Solution: ${names[0]}.` : `Solutions: ${names.join(', ')}.`;
}

/**
 * `open_solution` for a folder this window already has open: make the
 * csolution the extension's active one, unless it is, and report the active
 * solution and target. With several csolution files and none named, the
 * extension's own choice stands and the files are listed.
 */
async function activateHere(context: CmsisActionContext, place: SolutionPlace, deadline: number): Promise<ToolText> {
    const { executor, host } = context;
    const here = `${place.folder} is open in this VS Code window.`;
    if (place.solutions.length === 0) {
        return `${here} ${solutionsNote(place)}`;
    }
    if (!host.toolEnvironment().extension(SOLUTION_EXTENSION_ID)) {
        throw missingSolutionExtensionRefusal('CMSIS \'open_solution\'');
    }
    const named = place.named ?? (place.solutions.length === 1 ? place.solutions[0] : undefined);
    let current = await activeSolution();
    const isActive = (file: string): boolean => current.active && current.solutionPath !== undefined && sameFile(current.solutionPath, file);
    if (named === undefined) {
        const active = current.active ? `Active solution: ${current.description}.` : 'None is active.';
        return `${here} ${solutionsNote(place)} ${active} Pass the path of one *.csolution.yml to activate it.`;
    }
    let wanted = named;
    if (!isActive(named)) {
        const listed = await solutionAsListed(named, host);
        if (listed === undefined) {
            // Asked for a path it does not list, the extension would only open its picker.
            throw new ToolError('INVALID_ARGUMENT',
                `CMSIS 'open_solution' not attempted: the CMSIS Solution extension does not list ${named} as a solution of this window, `
                    + 'so it would ask the user to pick another one instead.',
                UNLISTED_HINT);
        }
        if (executor.hasDebugSession()) {
            throw new ToolError('PROBE_BUSY',
                `CMSIS 'open_solution' not attempted: activating ${named} re-loads the solution, which is not done under a live debug session.`,
                'Call stop_debugging first, then repeat this call.');
        }
        wanted = listed;
        try {
            await withTimeout('cmsis activateSolution', ACTIVATION_MS,
                () => Promise.resolve(vscode.commands.executeCommand('cmsis-csolution.activateSolution', wanted)));
        } catch (caught) {
            if (caught instanceof HardwareTimeoutError) {
                throw new ToolError('TASK_FAILED',
                    `CMSIS 'open_solution' failed: the CMSIS Solution extension did not activate ${wanted} within ${ACTIVATION_MS / 1000} s.`,
                    PICKER_HINT);
            }
            throw new ToolError('TASK_FAILED', `CMSIS 'open_solution' failed: the CMSIS Solution extension did not activate ${wanted} (${failureText(caught)}).`,
                SELECT_SOLUTION_BY_HAND);
        }
        const giveUpAt = Math.min(deadline - DEADLINE_MARGIN_MS, host.now() + OPEN_VERIFY_MS);
        for (;;) {
            current = await activeSolution();
            if (isActive(wanted) || host.now() > giveUpAt) {
                break;
            }
            await host.sleep(SWITCH_POLL_MS);
        }
        if (!isActive(wanted)) {
            if (current.active && current.solutionPath !== undefined) {
                // The extension kept the solution it had: a build now would build that one (#99).
                throw new ToolError('TASK_FAILED',
                    `CMSIS 'open_solution' failed: the CMSIS Solution extension was asked to activate ${wanted} but still reports `
                        + `${current.solutionPath} as the active solution, so CMSIS actions would run on that one.`,
                    SELECT_SOLUTION_BY_HAND);
            }
            return {
                text: `${here} The CMSIS Solution extension was asked to activate ${wanted} but reports `
                    + `'${current.description}' as the active solution so far. It may still be loading: repeat this call until it names `
                    + 'the active solution, then cmsis_action build; get_recent_problems shows load errors.',
                status: 'running',
                data: { opened: place.folder, newWindow: false, solution: wanted },
            };
        }
    }
    // The path as the extension reports it, whichever spelling the caller used.
    const solution = current.solutionPath ?? wanted;
    const target = await activeTargetName();
    return {
        text: `${here} Active solution: ${solution}${target ? `, target ${target}` : ''}. Next: cmsis_action build, then load_and_debug.`,
        status: 'ok',
        data: { opened: place.folder, newWindow: false, solution },
    };
}

/** How long after the reply a window without a folder waits before it opens the folder in itself, so the reply gets out first. */
const RELOAD_DELAY_MS = 1_000;

/**
 * `open_solution`: open the folder of a csolution in a VS Code window and
 * make the solution active. A folder this window has open is activated
 * here. A window without any folder opens it in itself when the client runs
 * outside the window (`survivesWindowReload`): VS Code reloads the window
 * for that, the MCP server with it, so the reply goes out first and the
 * folder is opened a second later; the agent is told to come back after the
 * reload. Otherwise — another folder is open, or the client is a chat inside
 * this window that the reload would end — the folder opens in a new window,
 * so the window that answers keeps running; the router follows the new
 * window once it registers (`data.newWindow`).
 */
async function openSolution(context: CmsisActionContext, given: string | undefined, deadline: number, client: string | undefined): Promise<ToolText> {
    const { host } = context;
    const place = placeOf(given);
    const probe = place.named ?? place.folder;
    const folders = host.workspaceFolders();
    if (folders.some((folder) => liesInFolder(probe, folder.uri.fsPath))) {
        return activateHere(context, place, deadline);
    }
    const empty = folders.length === 0;
    if (empty && survivesWindowReload(client)) {
        return openHere(context, place);
    }
    try {
        await withTimeout('vscode.openFolder', KICKOFF_MS, () => Promise.resolve(host.openFolder(place.folder, true)));
    } catch (caught) {
        throw new ToolError('TASK_FAILED', `CMSIS 'open_solution' failed: VS Code did not open ${place.folder} (${failureText(caught)}).`,
            'Ask the user to open the folder in VS Code (File → Open Folder), then call list_debug_windows.');
    }
    const data: { opened: string; newWindow: boolean; solution?: string } = { opened: place.folder, newWindow: true };
    if (place.named !== undefined || place.solutions.length === 1) {
        data.solution = place.named ?? place.solutions[0];
    }
    const stays = empty ? ' This window stays without a folder: your client runs inside it, and opening the folder here would reload the window and end your session.' : '';
    return {
        text: `Opening ${place.folder} in a new VS Code window. ${solutionsNote(place)} `
            + 'The window joins the CMSIS Developer Assistant once its extensions have started, and the CMSIS Solution extension '
            + `then loads the solution. Reach it with window: '${place.folder}' on cmsis_action, or select_debug_window.${stays}`,
        status: 'ok',
        data,
    };
}

/**
 * `open_solution` from a window without a folder: the folder is opened in
 * this window after the reply left. The window reloads, the MCP server
 * starts again a few seconds later and knows no session; the text says what
 * the agent does then. A failure to open is logged, since nobody is left to
 * tell: the agent sees it when the status still shows no folder.
 */
function openHere(context: CmsisActionContext, place: SolutionPlace): ToolText {
    const { host } = context;
    void host.sleep(RELOAD_DELAY_MS).then(() => host.openFolder(place.folder, false)).catch((caught: unknown) => {
        logger.warn(`open_solution: VS Code did not open ${place.folder} in this window`, failureText(caught));
    });
    const data: { opened: string; newWindow: boolean; reloads: boolean; solution?: string } = { opened: place.folder, newWindow: false, reloads: true };
    if (place.named !== undefined || place.solutions.length === 1) {
        data.solution = place.named ?? place.solutions[0];
    }
    return {
        text: `Opening ${place.folder} in this window, which has no folder: VS Code reloads it in a second, and the MCP server with it. `
            + `${solutionsNote(place)} Wait about 10 s, then call get_session_status; if the connection is refused or the session is unknown, `
            + 'connect again — the server listens on the same port. The CMSIS Solution extension loads the solution once the window is back.',
        status: 'ok',
        data,
    };
}

/**
 * The body of `cmsis_action`, run inside the handler's fence. `waitMs` is
 * the call's whole wait; everything, the checks and a target switch
 * included, comes out of it. `openPath` is the path of `open_solution`,
 * `pack` the pack of `install_pack`, `creation` the arguments of
 * `create_solution`.
 */
export async function runCmsisAction(
    context: CmsisActionContext,
    action: string,
    target: string | undefined,
    waitMs: number,
    openPath?: string,
    client?: string,
    pack?: string,
    creation?: CreateRequest,
): Promise<ToolText> {
    const { executor, host } = context;
    const deadline = host.now() + waitMs;
    const tracker = host.cmsisJobs();
    if (action === 'status') {
        return reportStatus(context, deadline);
    }
    if (action === 'open_solution') {
        return openSolution(context, openPath, deadline, client);
    }
    if (action === 'install_pack') {
        return runInstallPack(host, pack, deadline);
    }
    if (action === 'create_solution') {
        // In the window that keeps the folder, the new csolution is activated as open_solution activates one.
        return createSolution(host, { ...creation, path: openPath, client }, deadline - DEADLINE_MARGIN_MS,
            (file, remaining) => activateHere(context, placeOf(file), remaining));
    }
    if (SESSION_ACTIONS.has(action) && executor.hasDebugSession()) {
        const status = await executor.getSessionStatus();
        throw new ToolError('PROBE_BUSY',
            `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). Refusing to ${action}.`,
            'Use stop_debugging or restart_debugging first, or proceed with inspection.');
    }

    const solution = await activeSolution();
    if (!solution.active) {
        throw await whyNoSolution(`CMSIS '${action}'`, solution.description, host, executor.getDiagnostics().serverVersion);
    }

    let active = await activeTargetName();
    if (action === 'stop_build') {
        // It stops whatever builds, whichever target: never a target switch first.
        return stopBuild({ context, tracker, deadline, command: ACTION_COMMANDS.get(action) as string, tag: onTarget(active), target: active });
    }
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
    if (isBuildAction(action)) {
        const other = BUILD_ACTIONS.map((kind) => tracker.inFlight(kind)).find((job): job is Job => job !== undefined);
        if (other) {
            throw new ToolError('TASK_FAILED',
                `CMSIS '${action}'${onTarget(active)} not started: the ${other.action} started ${formatDuration(host.now() - other.armedAt)} ago `
                    + `(job ${other.id}) is still running, and CMSIS Solution would start the ${action} only after it.`,
                'Wait for it with cmsis_action {action:\'status\'}, or end it with cmsis_action {action:\'stop_build\'}; then repeat the call.');
        }
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
    const issue: Issue = { context, tracker, deadline, command, tag, target: active };
    let labels: ReadonlySet<string> | undefined;
    let preface: string | undefined;
    const label = TASK_ACTIONS.has(action) ? ACTION_PHASES[action as JobAction].label : undefined;
    if (label !== undefined && solution.solutionPath) {
        const folder = selectionFolder(solution.solutionPath, host);
        labels = await tracker.taskLabels(folder);
        if (labels && !hasCmsisTasks(labels)) {
            const repair = await writeCmsisTasks(issue, folder);
            labels = repair.labels ?? labels;
            if (repair.wrote === undefined) {
                throw missingTaskRefusal(action as JobAction, tag, label, labels, repair.missing);
            }
            preface = `${repair.wrote} `;
        }
        if (labels && !labels.has(label)) {
            throw missingTaskRefusal(action as JobAction, tag, label, labels);
        }
    }

    switch (action) {
        case 'stop_run':
            return stopRun(issue);
        case 'detach':
            await issueCommand(issue, action);
            return `CMSIS '${action}'${tag} issued via '${command}'. It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.`;
        case 'attach': {
            const runAlive = tracker.probeOwners().some((owner) => owner.kind === 'run' || owner.kind === 'loadRun');
            const endpoints = solution.solutionPath ? await launchAttachEndpoints(selectionFolder(solution.solutionPath, host)) : [];
            if (runAlive && solution.solutionPath) {
                await refuseAttachToBareModel(issue, endpoints);
            }
            expectSessionOf(issue);
            await issueCommand(issue, action);
            const answer = await sessionPhase(issue, action, '', runAlive);
            return runAlive ? answer : withoutRunNote(answer, endpoints);
        }
        case 'load_and_debug':
            return loadAndDebug(issue);
        default:
            return runJob(issue, action as JobAction, labels, preface);
    }
}
