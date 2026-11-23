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
 * 2 s, or once a Run that hosts none — the FVP model — ended by itself with
 * exit 0 before that: a completed run, shown with the Run's output when the
 * window captured it (#134). load_and_debug waits for its pre-launch Load,
 * then, like attach, for a session that it probes twice. rebuild and clean
 * run CMSIS Solution's Rebuild and Clean (1.72.0), the build task type with
 * `--rebuild` or `--clean`, as jobs of their own; stop_build ends the build
 * a call of this tool started, or, with none of its own running, the
 * build-type tasks of the window, and says whether one was running.
 *
 * One deadline per call (#12): the wait (60 s by default, up to 600 s) counts
 * from the call, so the solution checks and a target switch come out of it,
 * and the call answers before its fence. A job still going at the deadline is
 * answered with status `running`; `status` waits for it, and a repeated build,
 * rebuild, clean, load, erase or load_and_run attaches to the job in flight
 * instead of starting a second one. A build, rebuild or clean while another
 * of the three is in flight is refused: CMSIS Solution would start it only
 * after that one ended. A build, rebuild or clean while CMSIS Solution's own
 * setup task (`cbuild setup …`, after loading a solution or a target switch)
 * runs is held back until the setup ended (#138): the job is armed at once,
 * so `status` and a repeat find it, and its command goes out once no setup
 * is alive any more — after the call answered `running`, if need be. Held
 * longer than `SETUP_WAIT_MS`, stopped by stop_build, or overtaken by a
 * switch to another target, it is not started, and its result says why.
 * Without an open job, `status` waits for a running setup as for a job.
 *
 * A build, rebuild or clean starts through `build()` of CMSIS Solution's API
 * instead of its command where that API also hands out the result it
 * captured for the task (`getBuildResult`, #140): no command where the API
 * offers the call. `build()` starts the same task type with fewer options
 * than the command: `--packs` is passed as CMSIS Solution's setting
 * `downloadPacks` says, the schema check stays on, and the task's name shows
 * neither the solution nor the target set (`cbuild --active "" --schema`),
 * which CMSIS Solution fills in when the task runs. VS Code saves modified
 * files before the task as for any task (`task.saveBeforeRun`); a running
 * setup is waited for as below. On every other host the commands go out as
 * before: without `getBuildResult`, `build()` runs cbuild without the
 * solution and fails.
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
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
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
    NOTHING_STARTED_MS,
    runtimeOf,
    SETUP_WAIT_MS,
} from '../core/cmsisTasks';
import { idxFileName, IdxMessages, idxMessages, readToolsEnvironment, ToolsEnvironment } from '../core/buildFailure';
import {
    applyActiveSolution,
    formatTargetChoices,
    formatTargetName,
    listTargetTypes,
    parseTargetRef,
    resolveTargetSelection,
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
    projectRootOf,
    samePath,
    SOLUTION_EXTENSION_ID,
} from '../core/bootstrapState';
import { currentCallContext } from '../core/callContext';
import { failedResponseMessage } from '../core/problemFeed';
import type { ProblemJournal } from '../core/problemJournal';
import { activeTargetSetOf, solutionAnswerOf } from '../core/solutionAnswers';
import {
    acquireSolutionApi, peekSolutionApi, requireV3Method, solutionApiTooOld, solutionTooOldRefusal, V3_UPDATE_HINT, v3Method,
    type ApiConvertResult, type SolutionApi,
} from '../core/solutionApi';
import { ErrorCode, ToolError, ToolText } from '../core/toolResult';
import {
    activeLaunchConfigurations,
    AttachEndpoint,
    CmsisLaunchConfiguration,
    folderCmsisLaunchConfigurations,
    folderCmsisRunCommand,
    gdbServerKind,
    isFvpDebugger,
    isFvpSession,
    launchAttachEndpoints,
    runCommandKind,
    runTaskCbuildRun,
    runTaskGdbPorts,
    taskCommandWords,
} from '../core/gdbServerPorts';
import { gdbPortRefusal, type PortStart } from '../core/gdbPortGuard';
import type { GdbPortReservation } from '../core/gdbPortReservations';
import { cbuildRunDebugger, cbuildRunGdbPorts } from '../core/packDocs/cbuildRun';
import { AGENT_START_WINDOW_MS, expectAgentStart, FRAME_FOCUS_WAIT_MS, type StartFocusWatch } from '../utils/sessionStateTracker';
import { findSolutionFiles } from '../utils/solutionFiles';
import { resetApiToolsEnvironment, solutionGetter } from '../utils/solutionQueries';
import { HardwareTimeoutError, withTimeout } from '../utils/timeout';
import { survivesWindowReload } from '../core/clientHosting';
import { logger } from '../utils/logger';
import { failureText, LONG_LIMIT_CAP_MS } from './fence';
import { createSolution, CreateRequest } from './createSolution';
import type { HandlerHost } from './host';
import {
    flashFailedHint,
    formatDuration,
    idleStatus,
    jobResult,
    missingLaunchSetupRefusal,
    MissingTasksNote,
    missingTaskRefusal,
    probeRefusal,
    stillRunning,
    stuckFlashTask,
} from './jobText';
import { runInstallPack } from './installPack';
import { cancelPreparedLaunches, pendingLaunchNote, pendingStartLines, startsToTakeOver, takeOverNote } from './pendingStarts';
import { runOutputsOf } from '../runOutputCapture';
import { FVP_BREAK_FIRST, NO_FRAME_SELECTED } from './sessionText';
import { failedTaskProgram, gdbServerMissingHint } from './taskProgram';

export type CmsisAction = 'build' | 'rebuild' | 'clean' | 'refresh' | 'convert' | 'activate_environment' | 'load' | 'erase' | 'run' | 'load_and_run'
    | 'load_and_debug' | 'attach' | 'detach' | 'stop_run' | 'stop_build' | 'status' | 'open_solution' | 'install_pack' | 'create_solution';

/**
 * The Arm Tools Environment Manager's Reactivate Environment: it resolves
 * `vcpkg-configuration.json` again, downloads what is missing, and CMSIS
 * Solution then rewrites `.cmsis/tools-environment.yml`, the environment its
 * tasks run in. The command is hidden from the palette and runs from the
 * Explorer's context menu of the manifest, whose Uri it takes as its
 * argument; without one it fails ("reading 'fsPath'", Environment Manager
 * 1.26.0).
 */
const ENVIRONMENT_COMMAND = 'environment-manager.reactivate';
/** The Arm Tools Environment Manager extension, which registers that command. */
const ENVIRONMENT_EXTENSION = 'Arm.environment-manager';
/** CMSIS Solution's record of the tools environment, next to the solution; with a forward slash in replies on every platform. */
const TOOLS_ENVIRONMENT_FILE = '.cmsis/tools-environment.yml';
/** The vcpkg manifest the environment is resolved from. */
const VCPKG_CONFIGURATION_FILE = 'vcpkg-configuration.json';

/** The CMSIS Solution command behind each action. A Map, so `constructor` and friends are not actions. */
const ACTION_COMMANDS: ReadonlyMap<string, string> = new Map([
    ['build', 'cmsis-csolution.build'],
    ['rebuild', 'cmsis-csolution.rebuild'],
    ['clean', 'cmsis-csolution.clean'],
    ['refresh', 'cmsis-csolution.refresh'],
    ['activate_environment', ENVIRONMENT_COMMAND],
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
const LONG_WAIT_ACTIONS: ReadonlySet<string> = new Set(['build', 'rebuild', 'clean', 'refresh', 'convert', 'activate_environment', 'load', 'erase', 'run',
    'load_and_run', 'load_and_debug', 'status', 'install_pack', 'create_solution']);

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
    /** The window's problem journal: a launch reads what the debug adapter said about its GDB server there. */
    readonly journal: ProblemJournal;
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

/** `getSolutionFile` of CMSIS Solution's API, interpreted. Never throws. */
async function activeSolution(): Promise<SolutionAnswer> {
    try {
        const answer: unknown = await withTimeout('cmsis getSolutionFile', QUERY_MS,
            () => Promise.resolve(solutionGetter('getSolutionFile')));
        const { active, file } = solutionAnswerOf(answer);
        if (!active) {
            return { active: false, description: 'none' };
        }
        return { active: true, solutionPath: file, description: file ?? '<active, path unknown>' };
    } catch (caught) {
        return { active: false, description: `query failed: ${failureText(caught)}` };
    }
}

/** `getActiveTarget` of CMSIS Solution's API, trimmed; undefined when empty or unavailable. Never throws. */
export async function activeTargetName(): Promise<string | undefined> {
    try {
        const answer: unknown = await withTimeout('cmsis getActiveTargetSet', QUERY_MS,
            () => Promise.resolve(solutionGetter('getActiveTarget')));
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
 * The spelling of `name` among the targets API version 3 declares
 * (`getTargets`, case-sensitive in `setActiveTarget`): the exact one, else
 * the one that differs only in case. A request for a type alone
 * (`typeOnly`) whose target sets all have names takes the first target the
 * API lists for that type. Undefined when the API does not answer in time
 * or lists no such target.
 */
async function apiTargetSpelling(getTargets: () => PromiseLike<string[]>, name: string, typeOnly: boolean): Promise<string | undefined> {
    try {
        const targets = await withTimeout('cmsis getTargets', QUERY_MS, () => Promise.resolve(getTargets()));
        if (!Array.isArray(targets)) {
            return undefined;
        }
        const lower = name.toLowerCase();
        const typeOf = (target: string): string => target.split('@')[0];
        return targets.find((target) => target === name) ?? targets.find((target) => target.toLowerCase() === lower)
            ?? (typeOnly ? targets.find((target) => typeOf(target) === name) ?? targets.find((target) => typeOf(target).toLowerCase() === lower) : undefined);
    } catch {
        return undefined;
    }
}

/**
 * Make `wanted` the extension's active target and poll until the extension
 * reports it. The switch is CMSIS Solution's own, through `getTargets` and
 * `setActiveTarget` of its API version 3; an extension without them is
 * refused with the update hint, and `.vscode/cmsis.json` is never written
 * for a switch. Each failure says where it stopped and how to do it by hand.
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
    let declared: ReturnType<typeof listTargetTypes>;
    try {
        declared = listTargetTypes(solutionText);
    } catch (caught) {
        return {
            switched: false,
            code: 'INVALID_ARGUMENT',
            reason: `${solutionPath} cannot supply a valid target selection (${failureText(caught)}). No selection was changed.`,
            hint: 'Correct the csolution YAML and its target-types, then repeat this call.',
        };
    }
    const resolution = resolveTargetSelection(declared, wanted);
    if (!resolution.ok) {
        const choices = formatTargetChoices(declared) || '(none found)';
        return { switched: false, code: 'INVALID_ARGUMENT', reason: `${resolution.reason}. Active target: '${was}'. Declared targets: ${choices}.` };
    }

    const api = peekSolutionApi(host.solutionExtension());
    const getTargets = v3Method(api, 'getTargets');
    const setActiveTarget = v3Method(api, 'setActiveTarget');
    if (getTargets === undefined || setActiveTarget === undefined) {
        return {
            switched: false,
            code: 'TOOL_DISABLED',
            reason: `the active target is '${was}', and the CMSIS Solution extension offers no ${getTargets === undefined ? 'getTargets' : 'setActiveTarget'} `
                + `(API version 3) to select '${resolution.name}'. No selection was changed.`,
            hint: `${V3_UPDATE_HINT} Until then: ${SWITCH_BY_HAND}`,
        };
    }
    const spelling = await apiTargetSpelling(getTargets, resolution.name, resolution.set === undefined);
    if (spelling === undefined) {
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `the active target is '${was}', and the CMSIS Solution extension does not list '${resolution.name}' among its targets (getTargets), `
                + `although ${solutionPath} declares it: it may still be loading the solution. No selection was changed.`,
            hint: `Repeat the call in a few seconds. ${SWITCH_BY_HAND}`,
        };
    }
    try {
        await withTimeout('cmsis setActiveTarget', ACTIVATION_MS, () => Promise.resolve(setActiveTarget(spelling)));
    } catch (caught) {
        if (caught instanceof HardwareTimeoutError) {
            // The selection is saved before the refresh it waits for: the poll tells whether it took.
            return verifySwitch(wanted, `asked CMSIS Solution to select '${spelling}' (its refresh still running after ${ACTIVATION_MS / 1000} s)`, host);
        }
        return {
            switched: false,
            code: 'INTERNAL',
            reason: `the CMSIS Solution extension refused to select '${spelling}' (setActiveTarget: ${failureText(caught)}). Active target: '${was}'.`,
            hint: SWITCH_BY_HAND,
        };
    }
    return verifySwitch(wanted, `selected '${spelling}' through the CMSIS Solution API`, host);
}

/**
 * Poll until the extension reports `wanted` as its active target, for at
 * most {@link SWITCH_VERIFY_MS}; `done` says what the switch did, for the
 * failure text.
 */
async function verifySwitch(wanted: TargetRef, done: string, host: HandlerHost): Promise<SwitchResult> {
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
        reason: `${done}, but the CMSIS Solution extension `
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
        // A probe that runs out of time is no verdict on the probe hardware: the adapter may still be connecting.
        const why = caught instanceof HardwareTimeoutError ? `no answer within ${formatDuration(caught.timeoutMs)}` : failureText(caught);
        return { healthy: false, present: executor.hasDebugSession(), detail: `${label}: thread probe failed — ${why}` };
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
/** How a result names the start of a build that went through CMSIS Solution's API, where others name the command. */
const API_BUILD = 'build() of the CMSIS Solution API';

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
    const what = command === API_BUILD ? `${API_BUILD} failed` : `CMSIS command '${command}' failed`;
    return new ToolError('TASK_FAILED', `${what}: ${String(caught)}.`,
        'Ensure the CMSIS Solution extension is installed and a solution context is active.');
}

/**
 * The start of a build, rebuild or clean through `build()` of CMSIS Solution's API (#140); undefined where the
 * command starts it: another action, or an API without `build` or without `getBuildResult` — never on API version 3
 * alone, whose `build()` ran cbuild without the solution and the target set before build results were captured.
 */
function apiBuildStart(action: string, host: HandlerHost): (() => Thenable<unknown>) | undefined {
    if (!isBuildAction(action)) {
        return undefined;
    }
    let api: SolutionApi | undefined;
    try {
        api = peekSolutionApi(host.solutionExtension());
    } catch {
        return undefined;
    }
    const build = api?.build;
    if (!api || typeof build !== 'function' || v3Method(api, 'getBuildResult') === undefined) {
        return undefined;
    }
    const packs = host.downloadMissingPacks?.() ?? true;
    return () => build.call(api, { clean: action === 'clean', rebuild: action === 'rebuild', packs });
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
    /** The active solution's csolution file, when the extension names one: where its tools environment is. */
    readonly solutionPath?: string;
    /** Held across a pending reply, until a confirmed failure or the session/task ends. */
    readonly portReservations?: readonly GdbPortReservation[];
}

/**
 * The values of `debug.onTaskErrors` with which VS Code ends a launch whose
 * pre-launch task exited non-zero; with `prompt` (the default) it asks the
 * user, with `debugAnyway` it goes on.
 */
const LAUNCH_ENDS_ON_TASK_ERRORS: ReadonlySet<string> = new Set(['abort', 'showErrors']);

/** A failed start whose reservation waits for a session or task that may own it looks again after this long, then twice as long each time up to the maximum. */
const RELEASE_LOOK_FIRST_MS = 250;
const RELEASE_LOOK_MAX_MS = 5_000;

/**
 * A confirmed terminal start/run with no live owner: release only the ports
 * this call reserved. A debug session or a Load or Run task that is alive
 * may be the start's own, which takes the reservation over as soon as its
 * port shows, so nothing is released under it.
 *
 * It may as well have nothing to do with the start, and then nobody would
 * free the port. With `lookMs`, given where the start's end is final (its
 * job ended), the release is tried again when that task has ended, or after
 * `lookMs` for a session, as long as a reservation is still pending: one a
 * session or task took over is released at its end by the window's port
 * watch. A reservation a newer start of this window took over is told that
 * this start is over, so that the port does not come back to it.
 */
function releaseFailedStart(issue: Issue, lookMs?: number): void {
    const { executor, host } = issue.context;
    const reservations = issue.portReservations ?? [];
    if (lookMs !== undefined) {
        for (const reservation of reservations) {
            if (reservation.superseded) {
                reservation.release();
            }
        }
    }
    const owners = issue.tracker.liveExecutions().filter((execution) => execution.kind === 'run' || execution.kind === 'load' || execution.kind === 'loadRun');
    if (!executor.hasDebugSession() && owners.length === 0) {
        for (const reservation of reservations) {
            reservation.release();
        }
        return;
    }
    if (lookMs === undefined || !reservations.some((reservation) => reservation.pending)) {
        return;
    }
    const waited: Promise<unknown> = owners.length > 0 ? issue.tracker.waitForEnd(owners.map((owner) => owner.execution), lookMs) : host.sleep(lookMs);
    void waited.then(() => releaseFailedStart(issue, Math.min(lookMs * 2, RELEASE_LOOK_MAX_MS)), () => undefined);
}

/** A task can end after the tool's wait or before a port observation; release once its launch/run is terminal. */
function followStartJob(issue: Issue, job: Job): { dispose(): void } {
    const subscription = issue.tracker.onDidFinishJob((ended) => {
        if (ended.id !== job.id) {
            return;
        }
        subscription.dispose();
        if (ended.state === 'running-ok') {
            for (const reservation of issue.portReservations ?? []) {
                reservation.adopt();
            }
        }
        // A Run that completed or ended by itself (#134) holds no port any more, as little as a failed one.
        const runGone = (ended.action === 'run' || ended.action === 'load_and_run') && (ended.state === 'ok' || ended.state === 'ended');
        // After a pre-launch Load that exited non-zero, VS Code may still "Debug Anyway" (#127).
        const mayDebugAnyway = ended.action === 'load_and_debug' && ended.state === 'failed'
            && !LAUNCH_ENDS_ON_TASK_ERRORS.has(issue.context.host.debugTaskErrors());
        if ((ended.state === 'failed' || ended.state === 'cancelled' || runGone) && !mayDebugAnyway) {
            // The tracker announces the result before removing the live
            // execution. Inspect it after the task-end event has completed.
            queueMicrotask(() => releaseFailedStart(issue, RELEASE_LOOK_FIRST_MS));
        }
    });
    return subscription;
}

/** The latest time the call may wait until and still answer before its fence. */
function answerBy(issue: Issue): number {
    return issue.deadline - DEADLINE_MARGIN_MS;
}

/**
 * Issue the command, with `args` when it takes any, and give it the kick-off
 * (4 s, or what is left of the call) to fail; a failure within it rejects the
 * call, a later one is dropped (KB11). `returned` sees what the command
 * resolves with, `rejected` how it failed, early or late. `start` stands in
 * for the command: the API call that starts a build (`apiBuildStart`).
 */
async function issueCommand(
    issue: Issue,
    action: string,
    returned?: (value: unknown) => void,
    args: readonly unknown[] = [],
    rejected?: (failure: ToolError) => void,
    start?: () => Thenable<unknown>,
): Promise<void> {
    const { executor, host } = issue.context;
    let failure: ToolError | undefined;
    let pending: Thenable<unknown>;
    try {
        pending = start ? start() : vscode.commands.executeCommand(issue.command, ...args);
    } catch (caught) {
        pending = Promise.reject(caught);
    }
    const settled = Promise.resolve(pending).then(
        (value: unknown) => {
            returned?.(value);
        },
        (caught: unknown) => {
            failure = commandFailure(issue.command, action, caught, executor.getDiagnostics().serverVersion);
            rejected?.(failure);
            releaseFailedStart(issue);
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
async function runJob(given: Issue, action: JobAction, labels: ReadonlySet<string> | undefined, preface?: string): Promise<ToolText> {
    const start = apiBuildStart(action, given.context.host);
    // A build that goes through the API names that instead of the command in its results.
    const issue: Issue = start ? { ...given, command: API_BUILD } : given;
    const { tracker } = issue;
    const job = tracker.begin(action, issue.target);
    if (issue.portReservations?.length) {
        followStartJob(issue, job);
    }
    let issueNow = true;
    if (isBuildAction(action) && tracker.setupExecutions().length > 0) {
        // CMSIS Solution's setup is running: the build goes out once it ended (#138).
        if (!await setupsEnded(issue, job.id, answerBy(issue))) {
            void issueWhenSetupEnded(issue, job.id, action);
            const held = tracker.job(job.id) ?? job;
            return jobResult(held, { tag: issue.tag, now: issue.context.host.now(), command: issue.command, labels, preface });
        }
        issueNow = await mayIssueAfterHold(issue, job.id, action);
    }
    if (issueNow) {
        try {
            await issueCommand(issue, action, isBuildAction(action) ? (value) => tracker.identify(job.id, value) : undefined, [], undefined, start);
        } catch (caught) {
            tracker.settle(job.id, 'not-started', start ? 'Its start failed.' : 'Its command failed.');
            throw caught;
        }
        tracker.issued(job.id);
    }
    const outcome = await tracker.waitFor(job.id, answerBy(issue)) ?? job;
    const program = failedTaskProgram(issue.context.host, tracker, issue.solutionPath);
    // The last lines of a CMSIS Run that ended arrive just after its end (#134).
    const output = await runOutputsOf(tracker, [outcome], issue.context.host.now(), answerBy(issue) - issue.context.host.now());
    return jobResult(outcome, { tag: issue.tag, now: issue.context.host.now(), command: issue.command, labels, preface, program, output });
}

/**
 * Hold job `id` back while CMSIS Solution's setup tasks run (#138): true once
 * none is alive any more, or the job settled meanwhile (stop_build); false
 * when `until` (the host's clock) came first. A setup that follows another
 * is waited for too.
 */
async function setupsEnded(issue: Pick<Issue, 'tracker' | 'context'>, id: string, until: number): Promise<boolean> {
    const { tracker } = issue;
    const { host } = issue.context;
    for (;;) {
        const setups = tracker.setupExecutions();
        const job = tracker.job(id);
        if (setups.length === 0 || !job || isSettled(job.state)) {
            tracker.release(id);
            return true;
        }
        tracker.holdBack(id, setups[setups.length - 1].name);
        const left = until - host.now();
        if (left <= 0) {
            return false;
        }
        await tracker.waitForEnd(setups.map((setup) => setup.execution), left);
    }
}

/**
 * After the hold: may the held job's command go out? Not when the job
 * settled meanwhile (stop_build), nor when a build of its action already
 * started for it (the panel), nor when the active target is no longer the
 * job's — the setup it waited for may have been a switch to another one.
 * The job is settled with the reason in the last case.
 */
async function mayIssueAfterHold(issue: Issue, id: string, action: JobAction): Promise<boolean> {
    const job = issue.tracker.job(id);
    if (!job || isSettled(job.state) || executionIn(job, 'main') !== undefined) {
        return false;
    }
    const active = await activeTargetName();
    if (issue.target !== undefined && active !== undefined && active !== issue.target) {
        issue.tracker.settle(id, 'not-started', `The active target changed to '${active}' meanwhile, so the ${action} of '${issue.target}' `
            + 'did not go out.');
        return false;
    }
    return true;
}

/**
 * The rest of a held build after its call answered `running` (#138): wait
 * for the setups to end (at most `SETUP_WAIT_MS` from the start of the hold),
 * then issue the command with a kick-off of its own. Never rejects: what goes
 * wrong settles the job, and `status` reports it.
 */
async function issueWhenSetupEnded(issue: Issue, id: string, action: JobAction): Promise<void> {
    const { tracker } = issue;
    const { host } = issue.context;
    try {
        const since = tracker.job(id)?.heldBy?.since ?? host.now();
        if (!await setupsEnded(issue, id, since + SETUP_WAIT_MS)) {
            const name = tracker.job(id)?.heldBy?.name ?? 'cbuild setup';
            tracker.settle(id, 'not-started', `'${name}' was still running after ${formatDuration(SETUP_WAIT_MS)}, so the ${action} did not go out; `
                + 'it may be stuck: cmsis_action stop_build ends it.');
            return;
        }
        if (!await mayIssueAfterHold(issue, id, action)) {
            return;
        }
        // Looked up now: the extension may have been updated or reloaded while the build waited, and the
        // start then is the command again, under its own name.
        const start = apiBuildStart(action, host);
        const late: Issue = {
            ...issue, command: start ? API_BUILD : ACTION_COMMANDS.get(action) ?? issue.command,
            deadline: host.now() + KICKOFF_MS + DEADLINE_MARGIN_MS,
        };
        try {
            await issueCommand(late, action, (value) => tracker.identify(id, value), [], undefined, start);
        } catch (caught) {
            tracker.settle(id, 'not-started', `Its command failed: ${failureText(caught)}`);
            return;
        }
        tracker.issued(id);
    } catch (caught) {
        logger.warn(`CMSIS ${action}: the held job ${id} could not be started`, caught);
        tracker.settle(id, 'not-started', `Starting it failed: ${failureText(caught)}`);
    }
}

/** A repeated build, rebuild, clean, load, erase, run or load_and_run waits for the job in flight instead of starting a second one (#12). */
async function attachToJob(
    context: CmsisActionContext,
    job: Job,
    wanted: TargetRef | undefined,
    active: string | undefined,
    deadline: number,
    solutionPath?: string,
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
    const tracker = host.cmsisJobs();
    const outcome = await tracker.waitFor(job.id, deadline - DEADLINE_MARGIN_MS) ?? job;
    const output = await runOutputsOf(tracker, [outcome], host.now(), deadline - DEADLINE_MARGIN_MS - host.now());
    return jobResult(outcome, { tag: onTarget(runningOn), now: host.now(), preface, program: failedTaskProgram(host, tracker, solutionPath), output });
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
        // CMSIS Solution's own setup is work in flight, though no job's (#138): status waits for it as for a job.
        const setups = tracker.setupExecutions();
        if (setups.length > 0) {
            await tracker.waitForEnd(setups.map((setup) => setup.execution), deadline - DEADLINE_MARGIN_MS - host.now());
        }
        const completing = tracker.recent().find((job) => tracker.isCompleting(job.id));
        if (completing) {
            await tracker.waitFor(completing.id, deadline - DEADLINE_MARGIN_MS);
        }
        const output = await runOutputsOf(tracker, tracker.recent(), host.now(), deadline - DEADLINE_MARGIN_MS - host.now());
        // A launch without a pre-launch task has no job to show: its GDB port reservation says what is waiting (#127).
        const live = tracker.liveExecutions();
        const text = [idleStatus(tracker.recent(), live, host.now(), output), ...pendingStartLines(context.executor, host)].join('\n');
        const setup = tracker.setupExecutions()[0];
        if (!setup) {
            return text;
        }
        return {
            text: `${text}\nThis is not a failure: call cmsis_action {action:'status'} again to wait for the setup — a build, rebuild or clean `
                + 'started now waits for it too.',
            status: 'running',
            data: { task: { name: setup.name, kind: setup.kind, elapsedMs: setup.seeded ? null : Math.max(0, host.now() - setup.startedAt) } },
        };
    }
    const others = open.filter((job) => job.id !== latest.id).map((job) => `${job.action} (job ${job.id})`);
    const preface = others.length > 0 ? `Also in flight: ${others.join(', ')}. ` : undefined;
    // A stuck Load or Erase is answered at once: waiting out the budget on every call only hides it.
    const outcome = stuckFlashTask(latest, host.now()) ? latest : await tracker.waitFor(latest.id, deadline - DEADLINE_MARGIN_MS) ?? latest;
    const output = await runOutputsOf(tracker, [outcome], host.now(), deadline - DEADLINE_MARGIN_MS - host.now());
    return jobResult(outcome, { tag: onTarget(outcome.target), now: host.now(), preface, program: failedTaskProgram(host, tracker), output });
}

/** Names as a list: `'A'`, `'A' and 'B'`, `'A', 'B' and 'C'`. */
function nameList(executions: readonly ExecutionLike[]): string {
    const names = executions.map((execution) => `'${execution.task.name}'`);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

/** Keep a response margin without consuming the entire budget of a short stop call. */
function stopWaitMs(issue: Issue, requestedAt: number): number {
    const remaining = Math.max(0, issue.deadline - requestedAt);
    return Math.min(STOP_TOTAL_MS, remaining - Math.min(DEADLINE_MARGIN_MS, remaining / 4));
}

/** A caller's short wait expiring is not evidence that termination failed. */
function stopPending(issue: Issue, action: 'stop_run' | 'stop_build', alive: readonly ExecutionLike[], requestedAt: number, note = ''): ToolText {
    return {
        status: 'running',
        text: `CMSIS '${action}'${issue.tag}: stop requested; ${nameList(alive)} ${alive.length === 1 ? 'is' : 'are'} still running `
            + `${formatDuration(issue.context.host.now() - requestedAt)} after the stop request. This call's wait limit expired before `
            + `stop verification completed; termination is pending. Call cmsis_action {action:'status'}; if still running, retry `
            + `cmsis_action {action:'${action}', timeoutMs:15000}.${note}`,
    };
}

/**
 * stop_run, verified (#46): note the CMSIS executions, issue the command,
 * give CMSIS Solution's terminate 3 s, terminate what is left ourselves, and
 * report only what has ended within 10 s. A shorter caller deadline returns
 * a pending stop without prematurely terminating again or claiming failure.
 */
async function stopRun(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { executor, host } = issue.context;
    const snapshot = tracker.stoppableExecutions();
    const builds = tracker.buildExecutions();
    await issueCommand(issue, 'stop_run');
    const requestedAt = host.now();
    const totalMs = stopWaitMs(issue, requestedAt);
    const graceMs = Math.min(STOP_GRACE_MS, totalMs);
    const first = await tracker.waitForEnd(snapshot, graceMs);
    let alive = first.alive;
    const insisted = graceMs >= STOP_GRACE_MS ? [...alive] : [];
    if (insisted.length > 0) {
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
    const buildNote = await buildsAfterStopRun(tracker, builds);
    if (snapshot.length === 0) {
        return `CMSIS 'stop_run'${tag}: no CMSIS task of a run was running in this window. `
            + `'${issue.command}' was issued anyway; it also ends a debug session the CMSIS panel started.${buildNote}`;
    }
    if (alive.length > 0) {
        if (totalMs < STOP_TOTAL_MS) {
            return stopPending(issue, 'stop_run', alive, requestedAt, buildNote);
        }
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
        + `after the stop request${pushed}); ${probe}.${buildNote}`;
}

/**
 * stop_build while no build task runs: the diagnostic re-run of cbuild that
 * still checks a finished build, or collects its error lines, is no task, so
 * the tracker asks it to stop (#135). Its result keeps what it printed
 * before the stop; the answer waits for it as for a task, within the stop's
 * budget.
 */
async function stopChecks(issue: Issue): Promise<ToolText> {
    const { tracker, tag } = issue;
    const { host } = issue.context;
    const checking = tracker.recent().filter((job) => tracker.isCompleting(job.id));
    if (checking.length === 0) {
        return `CMSIS 'stop_build'${tag}: nothing to stop — no build is running in this window.`;
    }
    tracker.stopFollowUps();
    const requestedAt = host.now();
    const deadline = requestedAt + stopWaitMs(issue, requestedAt);
    for (const job of checking) {
        await tracker.waitFor(job.id, deadline);
    }
    const named = checking.map((job) => `${job.action} job ${job.id}`).join(' and ');
    const after = checking.some((job) => tracker.isCompleting(job.id))
        ? 'it is being stopped, and cmsis_action {action:\'status\'} shows what it found once it has ended'
        : 'it is stopped now, and cmsis_action {action:\'status\'} shows what it found before the stop';
    return `CMSIS 'stop_build'${tag}: no build is running in this window; the result of ${named} was still being checked by a diagnostic `
        + `re-run of cbuild, which is no CMSIS task — ${after}.`;
}

/**
 * What became of the builds that ran when stop_run was issued: stop_run is
 * not for them, but CMSIS Solution's Stop Running can end one, and a build
 * that runs on is stop_build's.
 */
async function buildsAfterStopRun(tracker: CmsisJobTracker, builds: readonly ExecutionLike[]): Promise<string> {
    if (builds.length === 0) {
        return '';
    }
    const { endedAt, alive } = await tracker.waitForEnd(builds, 0);
    const ended = builds.filter((execution) => endedAt.has(execution));
    const notes: string[] = [];
    if (ended.length > 0) {
        notes.push(` ${nameList(ended)}, a build, ended meanwhile: build again before load.`);
    }
    if (alive.length > 0) {
        notes.push(` ${nameList(alive)} still ${alive.length === 1 ? 'runs' : 'run'}: stop_run leaves builds alone — cmsis_action stop_build ends them.`);
    }
    return notes.join('');
}

/**
 * stop_build with a build of this extension's own in flight: terminate the
 * task executions `own` that `cmsis_action` calls started, and settle the
 * builds still held back behind a setup (#138) before their start goes out.
 * No command is issued: `cmsis-csolution.stopBuild` ends whichever build-type
 * task it finds. The executions get the stop's whole budget to end; the
 * answer names what else still runs, which the next stop_build ends.
 */
async function stopOwnBuilds(issue: Issue, own: readonly ExecutionLike[]): Promise<ToolText> {
    const { tracker, tag } = issue;
    const { host } = issue.context;
    const held = tracker.heldJobs();
    for (const job of held) {
        tracker.settle(job.id, 'cancelled', 'cmsis_action stop_build stopped it before its command went out.');
    }
    const jobs = [...held, ...tracker.requestStop(own)];
    const requestedAt = host.now();
    const totalMs = stopWaitMs(issue, requestedAt);
    for (const execution of own) {
        try {
            execution.terminate();
        } catch {
            // It may have ended in the meantime.
        }
    }
    const ended = await tracker.waitForEnd(own, totalMs);
    if (ended.alive.length > 0) {
        if (totalMs < STOP_TOTAL_MS) {
            return stopPending(issue, 'stop_build', ended.alive, requestedAt, ' Its outputs are incomplete: cmsis_action build before load or flash.');
        }
        throw new ToolError('TASK_FAILED',
            `CMSIS 'stop_build'${tag}: ${nameList(ended.alive)} ${ended.alive.length === 1 ? 'is' : 'are'} still running `
                + `${formatDuration(host.now() - requestedAt)} after the stop request, although terminated.`,
            'Stop it with the trash icon of its terminal in the Terminal panel, then call cmsis_action {action:\'status\'}.');
    }
    const others = tracker.buildExecutions().filter((execution) => !own.includes(execution));
    const left = others.length > 0
        ? ` ${nameList(others)} ${others.length === 1 ? 'was' : 'were'} not started by cmsis_action and still ${others.length === 1 ? 'runs' : 'run'}: `
            + `cmsis_action stop_build again ends ${others.length === 1 ? 'it' : 'them'}.`
        : '';
    const ids = jobs.length > 0 ? `job ${jobs.map((job) => job.id).join(', ')}` : '';
    if (own.length === 0) {
        return `CMSIS 'stop_build'${tag}: stopped ${held.map((job) => job.action).join(', ')} before ${held.length === 1 ? 'it' : 'they'} started (${ids}).${left}`;
    }
    const endedLast = Math.max(requestedAt, ...ended.endedAt.values());
    return `CMSIS 'stop_build'${tag}: stopped ${nameList(own)} (ended ${formatDuration(endedLast - requestedAt)} after the stop request`
        + `${ids ? `; ${ids}` : ''}). Its outputs are incomplete: cmsis_action build before load or flash.${left}`;
}

/**
 * stop_build: end a build that hangs. A build, rebuild or clean that a
 * `cmsis_action` call started is this extension's own and goes first
 * (`stopOwnBuilds`): only it is ended, and what else runs — a build the user
 * started in the CMSIS view, the cbuild setup CMSIS Solution runs after
 * loading a solution — is left alone and named. With no build of its own in
 * flight, the window's build-type tasks are ended through
 * `cmsis-csolution.stopBuild`, which ends one of them; give it 3 s,
 * terminate what is left ourselves, and report only what has ended within
 * 10 s; a shorter caller deadline leaves the stop pending. Their jobs count
 * as stopped once ended. With none running nothing is issued: a build whose
 * result is still being checked has its diagnostic re-run of cbuild stopped
 * instead (`stopChecks`), and with nothing at all the answer says so.
 */
async function stopBuild(issue: Issue): Promise<ToolText> {
    const { tracker } = issue;
    const { host } = issue.context;
    const tag = issue.tag;
    const running = tracker.buildExecutions();
    const own = tracker.ownBuildExecutions();
    if (own.length > 0 || tracker.heldJobs().length > 0) {
        return stopOwnBuilds(issue, own);
    }
    if (running.length === 0) {
        return stopChecks(issue);
    }
    const jobs = tracker.requestStop(running);
    let direct = '';
    try {
        await issueCommand(issue, 'stop_build');
    } catch (caught) {
        direct = `; '${issue.command}' failed (${failureText(caught)}), so they were terminated directly`;
    }
    const requestedAt = host.now();
    const totalMs = stopWaitMs(issue, requestedAt);
    const graceMs = direct ? 0 : Math.min(STOP_GRACE_MS, totalMs);
    const first = await tracker.waitForEnd(running, graceMs);
    let alive = first.alive;
    const insisted = !direct && graceMs >= STOP_GRACE_MS ? [...alive] : [];
    if (alive.length > 0 && (direct || insisted.length > 0)) {
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
        if (totalMs < STOP_TOTAL_MS) {
            return stopPending(issue, 'stop_build', alive, requestedAt,
                `${direct ? ` Stop command fallback${direct}.` : ''} Its outputs are incomplete: cmsis_action build before load or flash.`);
        }
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

/** The next step while `cmsis-csolution.autoDebugLaunch` is off: CMSIS Solution then writes no launch.json or tasks.json. */
const AUTO_DEBUG_LAUNCH_HINT = 'Ask the user to turn on cmsis-csolution.autoDebugLaunch (in Settings, or in Manage Solution Settings, command '
    + 'cmsis-csolution.manageSolution); CMSIS Solution then writes the CMSIS tasks and launch configurations. Until then, flash programs the target.';

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
    if (!host.autoDebugLaunch(folder)) {
        return {
            missing: {
                reason: 'the setting cmsis-csolution.autoDebugLaunch is off, so CMSIS Solution writes no tasks.json',
                hint: AUTO_DEBUG_LAUNCH_HINT,
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

/** What the session phase of load_and_debug and attach reads in the journal. */
interface SessionFacts {
    /** The first journal seq of this call's launch or attach. */
    sinceSeq: number;
    /** load_and_debug only: the `target.server` programs of the solution's CMSIS launch configurations. */
    servers?: readonly string[];
    /** Taken before the launch or attach was issued: the wait for the frame VS Code selects when the session stopped. */
    focus: StartFocusWatch;
}

/**
 * The state of a session that came up during the call (`start_debugging`,
 * the session phases of `cmsis_action`): read at once when the target
 * runs, and once VS Code has selected a frame for the stop when it stopped,
 * waiting at most `FRAME_FOCUS_WAIT_MS` and never past `leftMs`. Undefined
 * when VS Code selected none in that time: the reply then says
 * `NO_FRAME_SELECTED` instead of showing an empty state.
 */
export async function stateAfterStart(executor: IDebuggingExecutor, focus: StartFocusWatch, leftMs: number): Promise<DebugState | undefined> {
    const seen = await focus.settled(Math.max(Math.min(FRAME_FOCUS_WAIT_MS, leftMs), 0));
    return seen === 'none' ? undefined : executor.getCurrentDebugState(3);
}

/** The journal position a launch or attach about to be issued starts from. */
function journalStart(issue: Issue): number {
    return issue.context.journal.counters().seq + 1;
}

/** The start of the line the session tracker journals for a launch or attach request the debug adapter refused. */
const REFUSED_START = [failedResponseMessage('launch', ''), failedResponseMessage('attach', '')];

/**
 * Whether a load_and_debug or attach whose wait saw no live session failed:
 * the debug adapter or the GDB server journaled an error during this call
 * (from `sinceSeq`, not another call's). The wait polls at growing gaps, so
 * a session can start and fail between two polls; its records stay. While a
 * session is still there, only a refused launch or attach request counts:
 * other lines of a session coming up are no verdict. Records of VS Code's
 * views are `info` and never count.
 */
function startFailed(journal: ProblemJournal, sinceSeq: number, sessionThere: boolean): boolean {
    const callId = currentCallContext()?.callId;
    const errors = journal.query({ sinceSeq, sources: ['dap', 'gdb-server'], minSeverity: 'error' }).records
        .filter((record) => record.toolCallId === undefined || record.toolCallId === callId);
    if (!sessionThere) {
        return errors.length > 0;
    }
    return errors.some((record) => record.source === 'dap' && REFUSED_START.some((start) => record.message.startsWith(start)));
}

/** The next step after an attach whose session never came up or did not survive the connect. */
function attachFailedHint(runAlive: boolean): string {
    const noRun = !runAlive
        ? ' No CMSIS Run task is alive in this window — cmsis_action run starts the GDB server without programming '
            + '(the pyOCD task resets the target first); load_and_run programs first.'
        : '';
    return 'For \'attach\' this almost always means no GDB server is listening on the configured port: '
        + `start the GDB server first, or use 'load_and_debug' (which launches one).${noRun} `
        + 'Confirm with get_session_status / check_target_connection.';
}

/**
 * The last step of load_and_debug and attach: wait for the session, then
 * probe it twice. A session that ended before it came up is not probed.
 * For load_and_debug (`facts.servers`), a `GDB_SERVER_NOT_FOUND` the debug
 * adapter reported during the call makes a lost session, or one that never
 * showed, a failure whose hint says which PATH lacks the server. A session
 * that never showed is a failure too when the debug adapter or the GDB
 * server journaled an error during the call (`startFailed`); the problem
 * feed lists those records under the failure. Otherwise it is `running`.
 * A session that came up on an Arm FVP adds that only a breakpoint stops it.
 */
async function sessionPhase(issue: Issue, action: string, loadNote: string, runAlive: boolean, facts: SessionFacts): Promise<ToolText> {
    const { executor, host } = issue.context;
    const tag = issue.tag;
    const servers = facts.servers;
    const serverMissing = (): string | undefined => (servers
        ? gdbServerMissingHint(host, issue.context.journal, facts.sinceSeq, servers, issue.solutionPath)
        : undefined);
    const loaded = loadNote ? `${loadNote}; ` : '';
    const wait = await issue.context.awaitLiveSession(SESSION_WAIT_MS);
    if (wait === 'timeout') {
        const missing = serverMissing();
        if (missing !== undefined) {
            throw new ToolError('TASK_FAILED',
                `CMSIS '${action}'${tag} started no debug session — ${loaded}the debug adapter could not start the GDB server.`,
                missing);
        }
        if (startFailed(issue.context.journal, facts.sinceSeq, executor.hasDebugSession())) {
            const attach = action === 'attach';
            throw new ToolError('TASK_FAILED',
                `CMSIS '${action}'${tag} started no debug session — ${loaded}the debug adapter's ${attach ? 'attach' : 'launch'} failed.`,
                attach ? attachFailedHint(runAlive) : LOST_LAUNCH_HINT);
        }
        return {
            text: `CMSIS '${action}'${tag} issued via '${issue.command}'.${loadNote ? ` ${loadNote}` : ''} `
                + 'The flash/connect pipeline is running in the CMSIS extension '
                + '(a multi-core flash + attach typically takes 20-40 s). This tool does not block for the whole pipeline — '
                + 'poll get_session_status until it reports \'running\' or \'stopped\'. '
                + 'If get_session_status keeps reporting \'no-session\' with liveSessionsInThisWindow=0, '
                + 'the CMSIS panel is most likely showing a picker the user must resolve. '
                + 'Less often, this call and the poll landed in different windows — check with list_debug_windows and pin one with select_debug_window.'
                + pendingLaunchNote(issue.portReservations),
            status: 'running',
        };
    }
    const survival = wait === 'gone' ? ENDED_BEFORE_UP : await checkSurvival(executor, host);
    if (survival.stable) {
        for (const reservation of issue.portReservations ?? []) {
            reservation.adopt();
        }
        const state = await stateAfterStart(executor, facts.focus, answerBy(issue) - host.now());
        const shown = state === undefined ? NO_FRAME_SELECTED : `State: ${issue.context.renderFullState(state)}`;
        const fvp = isFvpSession(executor.getActiveSession()?.configuration) ? `\n${FVP_BREAK_FIRST}` : '';
        return `CMSIS '${action}' completed${tag} — ${loaded}debug session survived the connect (${survival.detail}). ${shown}${fvp}`;
    }
    if (survival.present) {
        // A slow multi-core start still has no threads at the second probe: not up yet, not failed (#47).
        return {
            text: `CMSIS '${action}'${tag}: ${loaded}the debug session is up but the target is not reporting threads yet — ${survival.detail}. `
                + 'This is not a failure: poll get_session_status until it reports \'running\' or \'stopped\'.',
            status: 'running',
        };
    }
    const failed = `CMSIS '${action}'${tag} started a debug session but it did NOT survive the initial connect — ${loaded}${survival.detail}.`;
    if (action !== 'attach') {
        // load_and_debug launched its own GDB server: the server's or GDB's own lines say why the session ended.
        throw new ToolError('TASK_FAILED', failed, serverMissing() ?? LOST_LAUNCH_HINT);
    }
    throw new ToolError('TASK_FAILED', failed, attachFailedHint(runAlive));
}

/** The next step after a load_and_debug whose session ended during the connect or never came up. */
const LOST_LAUNCH_HINT = 'The GDB server or GDB ended while connecting: their error lines, listed below when there are any, say why '
    + '(get_recent_problems {sources:[\'gdb-server\',\'dap\']} has the whole server log). Fix that, then cmsis_action load_and_debug again.';

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

/** The debugger the active target's cbuild-run.yml names and the GDB ports it lists; neither when there is no such file or it cannot be read. */
async function activeDebugger(host: HandlerHost): Promise<{ name?: string; ports: number[] }> {
    const runFile = await host.activeCbuildRunFile();
    if (!runFile) {
        return { ports: [] };
    }
    try {
        const content = await fs.promises.readFile(runFile, 'utf8');
        return { name: cbuildRunDebugger(content), ports: cbuildRunGdbPorts(content) };
    } catch {
        return { ports: [] };
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
        || isFvpDebugger((await activeDebugger(issue.context.host)).name);
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

/**
 * load_and_debug. With `loadFirst` — the launch configuration runs `CMSIS
 * Load` before its session, as the pyOCD and J-Link ones do — a Load that
 * never starts is the answer: CMSIS Solution showed a picker or a message
 * instead of launching, and the job stays in `status` as not started.
 * Without it (FVP, Arm Debugger) the session decides alone.
 */
async function loadAndDebug(issue: Issue, loadFirst: boolean, servers: readonly string[]): Promise<ToolText> {
    const { tracker } = issue;
    const { host } = issue.context;
    // Before the command: a frame VS Code holds from an earlier session is not this one's.
    const launch: SessionFacts = { sinceSeq: journalStart(issue), servers, focus: issue.context.executor.watchStartFocus() };
    const job = tracker.begin('load_and_debug', issue.target);
    const completion = issue.portReservations?.length ? followStartJob(issue, job) : undefined;
    expectSessionOf(issue);
    try {
        await issueCommand(issue, 'load_and_debug');
    } catch (caught) {
        tracker.settle(job.id, 'not-started', 'Its command failed.');
        throw caught;
    }
    tracker.issued(job.id);
    let first = await loadOrSession(issue, job.id, SESSION_WAIT_MS);
    if (first === 'neither' && loadFirst) {
        first = await loadOrSession(issue, job.id, Math.max(0, NOTHING_STARTED_MS - SESSION_WAIT_MS));
        if (first === 'neither') {
            tracker.settle(job.id, 'not-started', 'Neither its pre-launch Load nor a session started.');
            return jobResult(tracker.job(job.id) ?? job, { tag: issue.tag, now: host.now(), command: issue.command });
        }
    }
    if (first !== 'load') {
        completion?.dispose();
        tracker.discard(job.id);
        return sessionPhase(issue, 'load_and_debug', '', false, launch);
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
            flashFailedHint(load.name, failedTaskProgram(host, tracker, issue.solutionPath)(load)));
    }
    const loadNote = `'${load.name}' exited 0 after ${formatDuration(runtimeOf(load, host.now()))} (job ${outcome.id})`;
    return sessionPhase(issue, 'load_and_debug', loadNote, false, launch);
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
 * with: no folder open, the CMSIS Solution extension not installed or too
 * old to be asked (its getters are part of API version 3), no csolution in
 * the workspace, or one that the extension has not loaded.
 */
async function whyNoSolution(what: string, queried: string, host: HandlerHost, serverVersion: string): Promise<ToolError> {
    const folders = host.workspaceFolders();
    if (folders.length === 0) {
        return noWorkspaceRefusal(what);
    }
    if (!host.toolEnvironment().extension(SOLUTION_EXTENSION_ID)) {
        return missingSolutionExtensionRefusal(what);
    }
    const extension = host.solutionExtension();
    if (extension !== undefined && solutionApiTooOld(extension)) {
        return solutionTooOldRefusal(what, extension);
    }
    return noSolutionRefusal(what, queried, await workspaceSolutionFiles(host), folders.map((folder) => folder.name), serverVersion);
}

/**
 * What `open_solution` found at its path: the folder to open and the
 * csolution files in it. For a csolution no open folder holds, `folder`
 * becomes its project root (`projectRootOf`, #145) and `nested` is set when
 * that is not the csolution's own folder.
 */
interface SolutionPlace {
    folder: string;
    /** The csolution lies below `folder`, so the extension activates it only through `.vscode/cmsis.json`. */
    nested?: boolean;
    /** The csolution the caller named, when the path is a file. */
    named?: string;
    solutions: string[];
}

/**
 * The folder and csolution files `given` stands for: a folder as given, a
 * csolution with its own folder; a path that cannot be opened is
 * `INVALID_ARGUMENT`. `create_solution` activates through this too.
 */
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

/** Whether a file or folder exists at `file`. */
function entryExists(file: string): boolean {
    try {
        fs.statSync(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * The place to open for a csolution no open folder holds: its project root
 * (#145), where a `vcpkg-configuration.json` at the repository root lies
 * inside the opened folder. A folder path, and a csolution without a root
 * above its own folder, stay as they are.
 */
function projectPlaceOf(place: SolutionPlace): SolutionPlace {
    if (place.named === undefined) {
        return place;
    }
    const root = projectRootOf(place.named, os.homedir(), entryExists);
    return samePath(root, place.folder) ? place : { ...place, folder: root, nested: true };
}

/**
 * Before a folder opens with a csolution below it: name the csolution as
 * the folder's active solution in `.vscode/cmsis.json`, which the CMSIS
 * Solution extension reads when the folder opens (it activates by itself
 * only a csolution directly in the folder). A failure is logged and the
 * reply says how to activate the csolution once the window is there.
 */
function rememberActiveSolution(place: SolutionPlace): boolean {
    if (!place.nested || place.named === undefined) {
        return true;
    }
    const selectionFile = path.join(place.folder, '.vscode', 'cmsis.json');
    try {
        fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
        const previous = fs.existsSync(selectionFile) ? fs.readFileSync(selectionFile, 'utf8') : '';
        fs.writeFileSync(selectionFile, applyActiveSolution(previous, place.folder, place.named), 'utf8');
        return true;
    } catch (caught) {
        logger.warn(`open_solution: could not name ${place.named} as the active solution in ${selectionFile}`, failureText(caught));
        return false;
    }
}

/**
 * What the reply adds for a csolution below the opened folder: that the
 * extension was told to activate it, and how to make sure it did; nothing
 * for a csolution directly in the folder.
 */
function nestedNote(place: SolutionPlace, remembered: boolean): string {
    if (!place.nested || place.named === undefined) {
        return '';
    }
    const repeat = `cmsis_action {action:'open_solution', path:'${place.named}'}`;
    return remembered
        ? ` ${place.folder} is the project root that holds it; .vscode/cmsis.json there names it as the active solution. `
            + `If get_session_status then shows another active solution, ${repeat} in that window activates it.`
        : ` ${place.folder} is the project root that holds it; the solution could not be named in its .vscode/cmsis.json, `
            + `so once the window is there, ${repeat} activates it.`;
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
        // The activation is CMSIS Solution's own (API version 3); an extension without it is refused with the update hint.
        const activate = requireV3Method(await acquireSolutionApi(host.solutionExtension(), 'CMSIS \'open_solution\'', host),
            'activateSolution', 'CMSIS \'open_solution\'');
        try {
            await withTimeout('cmsis activateSolution', ACTIVATION_MS, () => Promise.resolve(activate(wanted)));
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
 * here. For a csolution no open folder holds, the folder opened is its
 * project root (`projectPlaceOf`), and a csolution below that root is named
 * in the root's `.vscode/cmsis.json` first, for the extension to activate
 * when the folder opens. A window without any folder opens it in itself when the client runs
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
    const asGiven = placeOf(given);
    const probe = asGiven.named ?? asGiven.folder;
    const folders = host.workspaceFolders();
    if (folders.some((folder) => liesInFolder(probe, folder.uri.fsPath))) {
        return activateHere(context, asGiven, deadline);
    }
    const place = projectPlaceOf(asGiven);
    const remembered = rememberActiveSolution(place);
    const empty = folders.length === 0;
    if (empty && survivesWindowReload(client)) {
        return openHere(context, place, remembered);
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
        text: `Opening ${place.folder} in a new VS Code window. ${solutionsNote(place)}${nestedNote(place, remembered)} `
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
function openHere(context: CmsisActionContext, place: SolutionPlace, remembered: boolean): ToolText {
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
            + `${solutionsNote(place)}${nestedNote(place, remembered)} Wait about 10 s, then call get_session_status; if the connection is refused or the session is unknown, `
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

    if (action === 'convert') {
        // Refused before a target switch: 1.72.0 has no convertSolution.
        requireV3Method(peekSolutionApi(host.solutionExtension()) ?? ({} as SolutionApi), 'convertSolution', `CMSIS 'convert'`);
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
        return attachToJob(context, inFlight, wanted, active, deadline, solution.solutionPath);
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
    if (action === 'convert') {
        return convertSolution(host, tag, deadline);
    }

    const command = ACTION_COMMANDS.get(action);
    if (command === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `Unknown CMSIS action: ${action}`);
    }

    // The label pre-check: a task the debugger adapter does not offer is refused before anything runs.
    const issue: Issue = { context, tracker, deadline, command, tag, target: active, solutionPath: solution.solutionPath };
    let labels: ReadonlySet<string> | undefined;
    let preface: string | undefined;
    const label = TASK_ACTIONS.has(action) ? ACTION_PHASES[action as JobAction].label : undefined;
    // Load & Debug and Attach start a launch configuration that CMSIS Solution writes together with its tasks.
    const launches = SESSION_ACTIONS.has(action);
    let launchConfigurations: CmsisLaunchConfiguration[] = [];
    if ((label !== undefined || launches) && solution.solutionPath) {
        const folder = selectionFolder(solution.solutionPath, host);
        labels = await tracker.taskLabels(folder);
        if (labels && !hasCmsisTasks(labels)) {
            const repair = await writeCmsisTasks(issue, folder);
            labels = repair.labels ?? labels;
            if (repair.wrote === undefined) {
                throw label !== undefined
                    ? missingTaskRefusal(action as JobAction, tag, label, labels, repair.missing)
                    : missingLaunchSetupRefusal(action, tag, repair.missing);
            }
            preface = `${repair.wrote} `;
        }
        if (label !== undefined && labels && !labels.has(label)) {
            throw missingTaskRefusal(action as JobAction, tag, label, labels);
        }
        if (launches) {
            launchConfigurations = await folderCmsisLaunchConfigurations(folder);
            const request = action === 'attach' ? 'attach' : 'launch';
            if (!host.autoDebugLaunch(folder) && !launchConfigurations.some((config) => config.request === request)) {
                throw missingLaunchSetupRefusal(action, tag, {
                    reason: `.vscode/launch.json has no ${request} configuration of CMSIS Solution, and the setting `
                        + 'cmsis-csolution.autoDebugLaunch is off, so CMSIS Solution writes none',
                    hint: AUTO_DEBUG_LAUNCH_HINT,
                });
            }
        }
    }

    if (TASK_ACTIONS.has(action) && solution.solutionPath) {
        const stale = staleEnvironmentNote(solution.solutionPath, host);
        if (stale) {
            preface = `${preface ?? ''}${stale} `;
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
            const sinceSeq = journalStart(issue);
            const focus = executor.watchStartFocus();
            expectSessionOf(issue);
            await issueCommand(issue, action);
            const answer = await sessionPhase(issue, action, '', runAlive, { sinceSeq, focus });
            return withPreface(runAlive ? answer : withoutRunNote(answer, endpoints), preface);
        }
        case 'refresh':
            if (!solution.solutionPath) {
                throw new ToolError('INTERNAL', `CMSIS 'refresh'${tag} not attempted: the CMSIS Solution extension names no solution file.`);
            }
            return refreshSolution(issue, solution.solutionPath);
        case 'activate_environment':
            if (!solution.solutionPath) {
                throw new ToolError('INTERNAL', `CMSIS 'activate_environment'${tag} not attempted: the CMSIS Solution extension names no solution file.`);
            }
            return activateEnvironment(issue, solution.solutionPath);
        case 'load_and_debug': {
            // CMSIS Solution starts the configuration of the active target's debugger, not an FVP's or another board's kept beside it.
            const active = await activeDebugger(host);
            const launchOnes = activeLaunchConfigurations(launchConfigurations.filter((config) => config.request === 'launch'), active.name, active.ports);
            const ports = await reserveLaunchPorts(issue, launchOnes);
            const loadFirst = launchOnes.some((config) => config.preLaunchTask === 'CMSIS Load');
            const servers = launchOnes.map((config) => config.server).filter((server): server is string => server !== undefined);
            // Released only on evidence that the launch is over (#127): its command failed (`issueCommand`), its Load ended
            // it (`followStartJob`), or its session came and went (the coordinator). A refusal or a timeout is none.
            return withPreface(await loadAndDebug({ ...issue, portReservations: ports.reservations }, loadFirst, servers),
                prefaceWith(ports.note, preface));
        }
        case 'run':
        case 'load_and_run': {
            // As for load_and_debug: a Run that has not started may still start once CMSIS Solution has fetched the tasks.
            const ports = solution.solutionPath
                ? await reserveRunPorts(issue, action, selectionFolder(solution.solutionPath, host)) : { reservations: [], note: '' };
            return runJob({ ...issue, portReservations: ports.reservations }, action, labels, prefaceWith(ports.note, preface));
        }
        default:
            return runJob(issue, action as JobAction, labels, preface);
    }
}

/** The reservations of a start's GDB ports, and the preface that says which pending starts of this window it took over. */
interface ReservedPorts {
    reservations: GdbPortReservation[];
    note: string;
}

/** `note` before `preface`; undefined when both are empty. */
function prefaceWith(note: string, preface: string | undefined): string | undefined {
    const text = `${note}${preface ?? ''}`;
    return text === '' ? undefined : text;
}

/**
 * Refuse a start whose GDB port another window or another program holds
 * (`HandlerHost.gdbPortHolder`, `src/core/gdbPortGuard.ts`): GDB would reach
 * that server instead of the new one, and halt that target. Each port is
 * asked once, in order, after atomically reserving it. A port this window
 * holds for a pending start of its own is taken over instead
 * (`startsToTakeOver`, #127): only once every port has passed, so that it is
 * never free in between; then VS Code is asked to cancel what it still
 * prepares of a launch taken over, before the new one goes out. Partial
 * acquisition is rolled back on any refusal (a port taken over goes back to
 * the start it covers); successful reservations outlive the call.
 */
async function reservePorts(issue: Issue, ports: ReadonlyArray<{ port: number; start: PortStart }>): Promise<ReservedPorts> {
    const { executor, host } = issue.context;
    const wanted: Array<{ port: number; start: PortStart }> = [];
    for (const entry of ports) {
        if (!wanted.some((known) => known.port === entry.port)) {
            wanted.push(entry);
        }
    }
    const takenOver = startsToTakeOver(executor, host, wanted);
    const own = new Set(wanted.map((entry) => entry.port).filter((port) => takenOver.some((start) => start.ports.includes(port))));
    const reservations: GdbPortReservation[] = [];
    const group = randomUUID();
    try {
        for (const { port, start } of wanted) {
            if (!own.has(port)) {
                reservations.push(host.reserveGdbPort(port, start, group));
            }
            const holder = await host.gdbPortHolder(port);
            if (holder) {
                logger.info(`${start.subject}: GDB port ${port} is held by ${holder.kind === 'window' ? `window pid ${holder.pid} (${holder.claim.label})` : 'another program'}`);
                throw gdbPortRefusal(start, port, holder);
            }
        }
        // The checks gave the earlier start time to come up: look again, synchronously, before taking its ports over.
        if (own.size > 0) {
            startsToTakeOver(executor, host, wanted.filter((entry) => own.has(entry.port)));
        }
        for (const { port, start } of wanted) {
            if (own.has(port)) {
                reservations.push(host.reserveGdbPort(port, start, group, true));
            }
        }
    } catch (caught) {
        for (const reservation of reservations) {
            reservation.release();
        }
        throw caught;
    }
    return { reservations, note: takeOverNote(takenOver, await cancelPreparedLaunches(executor, takenOver)) };
}

/** load_and_debug: the GDB ports the launch configurations fix for their servers. */
async function reserveLaunchPorts(issue: Issue, launches: readonly CmsisLaunchConfiguration[]): Promise<ReservedPorts> {
    const subject = `CMSIS 'load_and_debug'${issue.tag} not started`;
    return reservePorts(issue, launches.flatMap((config) => (config.gdbPort === undefined ? [] : [{
        port: config.gdbPort,
        start: { what: 'launch' as const, subject, configuration: config.name, server: config.gdbServer },
    }])));
}

/**
 * run and load_and_run: the GDB ports of the CMSIS Run task that tasks.json
 * holds, for pyOCD from the active target's cbuild-run file when its command
 * line names that file and no port. A Run that hosts no GDB server (the FVP
 * adapter's model) has none.
 */
async function reserveRunPorts(issue: Issue, action: string, folder: string): Promise<ReservedPorts> {
    const words = await folderCmsisRunCommand(folder);
    const file = runTaskCbuildRun(words);
    let fromFile: number[] = [];
    if (file !== undefined) {
        const runFile = file.includes('${') ? await issue.context.host.activeCbuildRunFile() : path.resolve(folder, file);
        try {
            fromFile = runFile ? cbuildRunGdbPorts(await fs.promises.readFile(runFile, 'utf8')) : [];
        } catch {
            fromFile = [];
        }
    }
    const start: PortStart = { what: 'run', subject: `CMSIS '${action}'${issue.tag} not started`, server: gdbServerKind(words) };
    return reservePorts(issue, runTaskGdbPorts(words, fromFile).map((port) => ({ port, start })));
}

/** How often `refresh` looks at the index csolution rewrites. */
const REFRESH_POLL_MS = 250;
/** The index lines a `refresh` result shows at most. */
const REFRESH_LINES = 10;

/** The modification time of a file, or undefined when it is not there. */
function mtimeOf(file: string): number | undefined {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
}

/**
 * `refresh`: CMSIS Solution's Refresh (Reload Packs, Update RTE), the button
 * of its panel. In 1.72.0 it reloads the solution's files and asks for a
 * convert with `updateRte`: csolution then writes the RTE files the
 * components need — a build without them fails with "not found; use
 * --update-rte" — and rewrites `<solution>.cbuild-idx.yml`. The call waits
 * until that file has changed and stays unchanged for one more look, then
 * answers with the errors and warnings csolution recorded there; a convert
 * that outlasts the wait (packs to download) answers `running`.
 */
async function refreshSolution(issue: Issue, solutionPath: string): Promise<ToolText> {
    const { host } = issue.context;
    const index = path.join(path.dirname(solutionPath), idxFileName(solutionPath));
    const before = mtimeOf(index);
    const issuedAt = host.now();
    await issueCommand(issue, 'refresh');
    let seen: number | undefined;
    for (;;) {
        const now = mtimeOf(index);
        if (now !== undefined && now !== before && now === seen) {
            break;
        }
        seen = now;
        if (host.now() >= answerBy(issue)) {
            return {
                text: `CMSIS 'refresh'${issue.tag} issued via '${issue.command}'; csolution has not rewritten ${path.basename(index)} after `
                    + `${formatDuration(host.now() - issuedAt)}. The convert may still load or download packs (the CMSIS Solution output `
                    + 'channel shows it): call cmsis_action build once it is done — do not issue refresh again.',
                status: 'running',
            };
        }
        await host.sleep(REFRESH_POLL_MS);
    }
    let messages: IdxMessages;
    try {
        messages = idxMessages(fs.readFileSync(index, 'utf8'));
    } catch (caught) {
        throw new ToolError('INTERNAL', `CMSIS 'refresh'${issue.tag}: csolution rewrote ${index}, but it could not be read (${failureText(caught)}).`);
    }
    return refreshResult(issue.tag, path.basename(index), messages, host.now() - issuedAt);
}

/** The answer of `refresh`: ✅ with csolution's warnings, or ❌ with its errors first. */
function refreshResult(tag: string, index: string, messages: IdxMessages, tookMs: number): ToolText {
    const all = [...messages.errors, ...messages.warnings];
    const lines = all.slice(0, REFRESH_LINES).map((message) => `  ${message.severity}: ${message.message}${message.context ? ` (${message.context})` : ''}`);
    if (all.length > REFRESH_LINES) {
        lines.push(`  … ${all.length - REFRESH_LINES} more in ${index}`);
    }
    const counts = `${messages.errors.length} error(s), ${messages.warnings.length} warning(s)`;
    if (messages.errors.length > 0) {
        throw new ToolError('TASK_FAILED',
            `❌ CMSIS 'refresh'${tag}: the convert with the RTE update recorded ${counts} in ${index} after ${formatDuration(tookMs)}:\n${lines.join('\n')}`,
            'Fix the first error (a missing pack or component, a name the csolution gets wrong), then cmsis_action refresh again; build once it '
                + 'records no error.');
    }
    const warned = lines.length > 0 ? ` csolution's warnings:\n${lines.join('\n')}\n` : ' ';
    return `✅ CMSIS 'refresh'${tag}: the solution was converted with the RTE update after ${formatDuration(tookMs)}, `
        + `and ${index} records ${counts}.${warned}Next: cmsis_action build.`;
}

/** The csolution messages a `convert` result lists at most. */
const CONVERT_LINES = 12;

/**
 * `convert`: csolution convert of the active target set through API version
 * 3 (`convertSolution`, without the RTE update and without a build). A
 * build in flight is not converted under. Errors are a `TASK_FAILED` with
 * csolution's lines; `detection` (a compiler or layer still to choose) says
 * where to choose it.
 */
async function convertSolution(host: HandlerHost, tag: string, deadline: number): Promise<ToolText> {
    const what = `CMSIS 'convert'${tag}`;
    const convert = requireV3Method(peekSolutionApi(host.solutionExtension()) ?? ({} as SolutionApi), 'convertSolution', what);
    const tracker = host.cmsisJobs();
    const building = BUILD_ACTIONS.map((kind) => tracker.inFlight(kind)).find((job): job is Job => job !== undefined);
    if (building) {
        throw new ToolError('TASK_FAILED', `${what} not started: the ${building.action} (job ${building.id}) is still running, and its cbuild converts too.`,
            'Wait for it with cmsis_action {action:\'status\'}; then repeat the call.');
    }
    const startedAt = host.now();
    const waitMs = Math.max(1, deadline - DEADLINE_MARGIN_MS - startedAt);
    let result: ApiConvertResult;
    try {
        result = await withTimeout('cmsis convertSolution', waitMs, () => Promise.resolve(convert({ updateRte: false })));
    } catch (caught) {
        if (caught instanceof HardwareTimeoutError) {
            return {
                text: `${what}: csolution convert is still running after ${formatDuration(waitMs)}; it has no cancel. `
                    + 'Repeat cmsis_action convert later, or build: the build converts first.',
                status: 'running',
                data: { action: 'convert' },
            };
        }
        throw new ToolError('TASK_FAILED', `❌ ${what}: CMSIS Solution's convertSolution rejected (${failureText(caught)}).`,
            'get_recent_problems shows what the extension reported.');
    }
    return convertResult(what, result, host.now() - startedAt);
}

/** The answer of `convert`: ✅ with csolution's warnings, or ❌ with its errors first. Exported for the tests. */
export function convertResult(what: string, result: ApiConvertResult, tookMs: number): ToolText {
    const texts = (list: unknown): string[] => (Array.isArray(list) ? list.filter((line): line is string => typeof line === 'string' && line.trim().length > 0) : []);
    const errors = texts(result?.logMessages?.errors);
    const warnings = texts(result?.logMessages?.warnings);
    const all = [...errors.map((line) => `error: ${line.trim()}`), ...warnings.map((line) => `warning: ${line.trim()}`)];
    if (all.length === 0) {
        all.push(...texts(result?.toolsOutputMessages).map((line) => line.trim()));
    }
    const lines = all.slice(0, CONVERT_LINES).map((line) => `  ${line}`);
    if (all.length > CONVERT_LINES) {
        lines.push(`  … ${all.length - CONVERT_LINES} more`);
    }
    const counts = `${errors.length} error(s), ${warnings.length} warning(s)`;
    const detection = result?.detection === true
        ? ' A compiler or a layer has to be chosen first: ask the user to choose it in Manage Solution Settings of the CMSIS view.' : '';
    if (result?.success !== true) {
        throw new ToolError('TASK_FAILED',
            `❌ ${what}: csolution convert failed (severity ${String(result?.severity ?? 'unknown')}, ${counts}) after ${formatDuration(tookMs)}`
                + `${lines.length > 0 ? `:\n${lines.join('\n')}` : '.'}${detection}`,
            'Fix the first error (a missing pack: cmsis_query {what:\'packs\', scope:\'missing\', context}), then convert again.');
    }
    const warned = lines.length > 0 ? ` csolution's messages:\n${lines.join('\n')}\n` : ' ';
    return {
        text: `✅ ${what}: csolution convert succeeded after ${formatDuration(tookMs)} (${counts}, without the RTE update).${detection}${warned}Next: cmsis_action build.`,
        status: 'ok',
        data: { action: 'convert', success: true, severity: String(result.severity), detection: result.detection === true, errors: errors.length, warnings: warnings.length },
    };
}

/** The tools a `activate_environment` result lists at most. */
const ENVIRONMENT_TOOLS_LISTED = 12;
/**
 * After the Environment Manager's activation ended, CMSIS Solution gets this
 * long to rewrite `.cmsis/tools-environment.yml` before the call says it
 * did not (#139).
 */
const ENVIRONMENT_REWRITE_GRACE_MS = 5_000;

/**
 * Where the tools environment of a solution is recorded and resolved from:
 * `.cmsis/tools-environment.yml` next to the solution (else in the folder
 * that holds it), and the nearest `vcpkg-configuration.json` from the
 * solution's directory up to that folder.
 */
function environmentFiles(solutionPath: string, host: HandlerHost): { environment: string; configuration?: string } {
    const solutionDir = path.dirname(solutionPath);
    const folder = selectionFolder(solutionPath, host);
    const candidates = [path.join(solutionDir, TOOLS_ENVIRONMENT_FILE), path.join(folder, TOOLS_ENVIRONMENT_FILE)];
    const environment = candidates.find((file) => mtimeOf(file) !== undefined) ?? candidates[0];
    let configuration: string | undefined;
    for (let dir = solutionDir; ; dir = path.dirname(dir)) {
        const file = path.join(dir, VCPKG_CONFIGURATION_FILE);
        if (mtimeOf(file) !== undefined) {
            configuration = file;
            break;
        }
        if (dir === folder || path.dirname(dir) === dir || !dir.startsWith(folder)) {
            break;
        }
    }
    return { environment, configuration };
}

/**
 * One sentence before a task's result when the environment it ran in does
 * not match `vcpkg-configuration.json`: the manifest is newer than
 * `.cmsis/tools-environment.yml`, or that file is missing. Nothing when the
 * solution has no manifest, or the record is current.
 */
function staleEnvironmentNote(solutionPath: string, host: HandlerHost): string | undefined {
    const { environment, configuration } = environmentFiles(solutionPath, host);
    if (configuration === undefined) {
        return undefined;
    }
    const recorded = mtimeOf(environment);
    const manifest = mtimeOf(configuration) ?? 0;
    const name = path.relative(path.dirname(solutionPath), configuration) || VCPKG_CONFIGURATION_FILE;
    if (recorded === undefined) {
        return `Note: the tools environment of ${name} has not been activated in this window (no .cmsis/tools-environment.yml, the record `
            + 'of the tools the CMSIS tasks run with): cmsis_action activate_environment does it.';
    }
    if (manifest > recorded) {
        return `Note: ${name} is newer than .cmsis/tools-environment.yml (the record of the tools the CMSIS tasks run with), so the tasks `
            + 'still run with the tools of the earlier activation: cmsis_action activate_environment re-resolves it.';
    }
    return undefined;
}

/**
 * `activate_environment`: the Arm Tools Environment Manager's Reactivate
 * Environment, which an agent could only ask the user for. It resolves
 * `vcpkg-configuration.json` again and installs what is missing; CMSIS
 * Solution then rewrites `.cmsis/tools-environment.yml`. The call waits
 * until that file has changed and stays unchanged for one more look, then
 * lists the tools it names. The command's promise is the end of the
 * activation (#139; Environment Manager 1.26.0 resolves it with `false` when
 * the activation failed), unless the Environment Manager offers its
 * activation events (`watchActivation()`), which then say when it ended or
 * failed: once it has ended, the record gets
 * `ENVIRONMENT_REWRITE_GRACE_MS` to change, and a record that stays as it
 * was is answered at once — CMSIS Solution writes it only when its content
 * changes, so the environment was current already. A resolution that
 * outlasts the wait (downloads, a licence dialog) answers `running`.
 */
async function activateEnvironment(issue: Issue, solutionPath: string): Promise<ToolText> {
    const { host } = issue.context;
    const { environment, configuration } = environmentFiles(solutionPath, host);
    const known = await vscode.commands.getCommands(true);
    if (!known.includes(issue.command)) {
        throw new ToolError('TASK_FAILED',
            `CMSIS 'activate_environment'${issue.tag} not attempted: the command '${issue.command}' is not registered in this window, so the `
                + `Arm Tools Environment Manager extension (${ENVIRONMENT_EXTENSION}) is not installed or not active.`,
            'Ask the user to install the Arm Tools Environment Manager (it comes with the Keil Studio Pack, Arm.keil-studio-pack) and reload the window.');
    }
    if (configuration === undefined) {
        throw new ToolError('INVALID_ARGUMENT',
            `CMSIS 'activate_environment'${issue.tag} not attempted: no ${VCPKG_CONFIGURATION_FILE} from ${path.dirname(solutionPath)} up to the `
                + 'workspace folder, so there is no environment to activate.',
            'The CMSIS tasks run with the tools the CMSIS Solution extension bundles; a project that needs others declares them in vcpkg-configuration.json.');
    }
    const before = mtimeOf(environment);
    const issuedAt = host.now();
    // What the command's promise settled with, once it has: the end of the activation (#139). Where the promise
    // settles at once instead (measured: 68 ms), the Environment Manager's own events say when the activation is over,
    // so they decide whenever it offers them.
    const ended: { done: boolean; value?: unknown; failure?: ToolError } = { done: false };
    const activation = watchActivation(() => host.now());
    try {
        await issueCommand(issue, 'activate_environment', (value) => {
            Object.assign(ended, { done: true, value });
        }, [vscode.Uri.file(configuration)], (failure) => {
            Object.assign(ended, { done: true, failure });
        });
        const manifest = path.basename(configuration);
        let seen: number | undefined;
        let endedAt: number | undefined;
        for (;;) {
            const now = mtimeOf(environment);
            if (now !== undefined && now !== before && now === seen) {
                break;
            }
            seen = now;
            if (ended.failure) {
                throw ended.failure;
            }
            if (((ended.done && ended.value === false) || activation.failed) && now === before) {
                throw new ToolError('TASK_FAILED',
                    `❌ CMSIS 'activate_environment'${issue.tag}: the Arm Tools Environment Manager reports that the activation of ${manifest} failed `
                        + `after ${formatDuration(host.now() - issuedAt)}; ${TOOLS_ENVIRONMENT_FILE} was not rewritten.`,
                    'Ask the user for the reason the Arm Tools output channel or the Arm Tools status bar item gives (a tool that could not be '
                        + 'downloaded, a registry that could not be reached, a licence); fix it, then call cmsis_action activate_environment again.');
            }
            if (endedAt === undefined && activation.at !== undefined) {
                endedAt = activation.at;
            }
            if (!activation.events && ended.done && endedAt === undefined) {
                endedAt = host.now();
            }
            if (endedAt !== undefined && now === before && host.now() - endedAt >= ENVIRONMENT_REWRITE_GRACE_MS) {
                // The API's environment from before the activation may lack the tools it just activated (measured: test/measure/solution-api).
                resetApiToolsEnvironment();
                return unchangedActivation(issue.tag, manifest, environment, endedAt - issuedAt);
            }
            if (host.now() >= answerBy(issue)) {
                return {
                    text: `CMSIS 'activate_environment'${issue.tag} issued via '${issue.command}'; CMSIS Solution has not rewritten `
                        + `${TOOLS_ENVIRONMENT_FILE} after ${formatDuration(host.now() - issuedAt)}. The Environment Manager may still download tools, `
                        + 'or wait for the user in the window (a licence or an activation prompt): ask the user to look, then call '
                        + 'cmsis_action activate_environment again — a second activation of the same manifest is harmless.',
                    status: 'running',
                };
            }
            await host.sleep(REFRESH_POLL_MS);
        }
        let tools: ToolsEnvironment;
        try {
            tools = readToolsEnvironment(fs.readFileSync(environment, 'utf8'));
        } catch (caught) {
            throw new ToolError('INTERNAL', `CMSIS 'activate_environment'${issue.tag}: ${environment} was rewritten, but it could not be read (${failureText(caught)}).`);
        }
        // The API's environment from before the activation may lack the tools it just activated (measured: test/measure/solution-api).
        resetApiToolsEnvironment();
        return activationResult(issue.tag, manifest, tools, host.now() - issuedAt);
    } finally {
        activation.dispose();
    }
}

/** What the Environment Manager reported since `watchActivation` began: when an activation ended, or that one failed. */
interface ActivationWatch {
    /** Whether the Environment Manager offers its activation events at all. */
    events: boolean;
    at?: number;
    failed?: boolean;
    dispose(): void;
}

/** The Environment Manager's activation events (its API version 1), or a watch that never fires when it offers none. */
function watchActivation(now: () => number): ActivationWatch {
    const watch: ActivationWatch = { events: false, dispose: () => undefined };
    try {
        const exports = vscode.extensions.getExtension(ENVIRONMENT_EXTENSION)?.exports as { getApi?: (version: number) => unknown } | undefined;
        const manager = exports?.getApi?.(1) as { onDidActivate?: vscode.Event<unknown>; onDidFailActivation?: vscode.Event<unknown> } | undefined;
        const subscriptions = [
            manager?.onDidActivate?.(() => { watch.at = now(); }),
            manager?.onDidFailActivation?.(() => { watch.failed = true; }),
        ].filter((s): s is vscode.Disposable => s !== undefined);
        watch.events = subscriptions.length > 0;
        watch.dispose = () => subscriptions.forEach((s) => s.dispose());
    } catch (caught) {
        logger.debug(`activate_environment: no activation events from ${ENVIRONMENT_EXTENSION} (${failureText(caught)})`);
    }
    return watch;
}

/** The tools of a record as indented lines, at most `ENVIRONMENT_TOOLS_LISTED` of them. */
function toolLines(tools: ToolsEnvironment): string[] {
    const named = tools.tools.map((tool) => (tool.version && !tool.name.includes(tool.version) ? `${tool.name} ${tool.version}` : tool.name));
    const listed = named.slice(0, ENVIRONMENT_TOOLS_LISTED).map((line) => `  ${line}`);
    if (named.length > ENVIRONMENT_TOOLS_LISTED) {
        listed.push(`  … ${named.length - ENVIRONMENT_TOOLS_LISTED} more`);
    }
    return listed;
}

/** The answer of `activate_environment`: the tools the rewritten record names. */
function activationResult(tag: string, manifest: string, tools: ToolsEnvironment, tookMs: number): string {
    const listed = toolLines(tools);
    const inventory = listed.length > 0 ? ` Tools of the CMSIS tasks now:\n${listed.join('\n')}\n` : ' ';
    return `✅ CMSIS 'activate_environment'${tag}: ${manifest} was resolved and ${TOOLS_ENVIRONMENT_FILE} rewritten after ${formatDuration(tookMs)}.`
        + `${inventory}Next: cmsis_action build.`;
}

/**
 * The answer of `activate_environment` when the activation ended and the
 * record stayed as it was (#139): CMSIS Solution writes it only when its
 * content changes, so the environment was current already. A record that
 * does not exist at all is said, with where it was looked for.
 */
function unchangedActivation(tag: string, manifest: string, environment: string, tookMs: number): string {
    const head = `CMSIS 'activate_environment'${tag}: the Arm Tools Environment Manager resolved ${manifest} after ${formatDuration(tookMs)}`;
    let text: string;
    try {
        text = fs.readFileSync(environment, 'utf8');
    } catch {
        return `⚠️ ${head}, but CMSIS Solution has not written ${TOOLS_ENVIRONMENT_FILE} (looked for ${environment}) `
            + `${formatDuration(ENVIRONMENT_REWRITE_GRACE_MS)} after it ended. The CMSIS tasks run with the tools of the CMSIS Solution `
            + 'extension then: ask the user whether the solution is the one CMSIS Solution has open in this window.';
    }
    let listed: string[] = [];
    try {
        listed = toolLines(readToolsEnvironment(text));
    } catch {
        // The record is there; the answer does without its list.
    }
    const inventory = listed.length > 0 ? ` Tools of the CMSIS tasks:\n${listed.join('\n')}\n` : ' ';
    return `✅ ${head}; ${TOOLS_ENVIRONMENT_FILE} did not change, so the environment was presumably current already `
        + `(CMSIS Solution rewrites the record only when it changes).${inventory}Next: cmsis_action build.`;
}

/** A result with the sentence the tasks repair wrote in front, when there is one. */
function withPreface(answer: ToolText, preface: string | undefined): ToolText {
    if (preface === undefined) {
        return answer;
    }
    return typeof answer === 'string' ? `${preface}${answer}` : { ...answer, text: `${preface}${answer.text}` };
}
