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
 * What a CMSIS task is, and when a `cmsis_action` job is done (#47, #46).
 *
 * The CMSIS Solution extension (1.70.1) runs two families of tasks:
 *
 *   - builds: its own task type `cmsis-csolution.build` (a CustomExecution,
 *     labelled `cbuild <solution> --active <target> …`); `cbuild setup` is the
 *     same type with `setup: true` and is never the result of a build;
 *   - the panel's Load, Run, Load+Run, Erase and TargetInfo buttons: tasks the
 *     debugger adapter template writes into `.vscode/tasks.json`, so VS Code
 *     reports them with source `Workspace` under the exact labels
 *     `CMSIS Load`, `CMSIS Run`, … — the labels the extension itself looks up.
 *     The Arm Debugger adapters have one `arm-debugger.flash` task named
 *     `CMSIS Load+Run` instead.
 *
 * `classifyCmsisTask` says which of these a task is; `reduceJob` folds the
 * task events a job sees into its state (armed → started → ok, failed,
 * cancelled, running-ok, or not-started); `guardProbe` decides whether an
 * action may touch the probe while other owners hold it. The texts agents
 * read are built in `src/handler/jobText.ts`.
 *
 * Pure: no `vscode`, no timers. Time comes in with every event.
 */

/** The parts of a task the classifier reads. */
export interface TaskFacts {
    name: string;
    source: string;
    /** `definition.type`. */
    type?: string;
    /** `definition.setup` of a build task. */
    setup?: boolean;
}

export type CmsisTaskKind = 'build' | 'setup' | 'load' | 'run' | 'loadRun' | 'erase' | 'targetInfo';

/** The task type of CMSIS Solution builds (and of `cbuild setup`). */
export const BUILD_TASK_TYPE = 'cmsis-csolution.build';
/** The single Load+Run task of the Arm Debugger adapter templates. */
export const ARM_DEBUGGER_FLASH_TYPE = 'arm-debugger.flash';
/** The source VS Code gives tasks from tasks.json. */
export const WORKSPACE_SOURCE = 'Workspace';

/** The panel's task labels, as the adapter templates write them and the extension looks them up. */
export const CMSIS_TASK_LABELS: ReadonlyMap<string, CmsisTaskKind> = new Map<string, CmsisTaskKind>([
    ['CMSIS Load', 'load'],
    ['CMSIS Run', 'run'],
    ['CMSIS Load+Run', 'loadRun'],
    ['CMSIS Erase', 'erase'],
    ['CMSIS TargetInfo', 'targetInfo'],
]);

/**
 * The kind of a task by the rules CMSIS Solution itself applies: the build
 * type, the Arm Debugger's flash task, or an exact label from tasks.json.
 * The global fallback of the TargetInfo button (`Target Information`, source
 * `CMSIS`, `pyocd list`) counts as TargetInfo. Anything else is undefined.
 */
export function classifyCmsisTask(facts: TaskFacts): CmsisTaskKind | undefined {
    if (facts.type === BUILD_TASK_TYPE) {
        return facts.setup === true ? 'setup' : 'build';
    }
    if (facts.type === ARM_DEBUGGER_FLASH_TYPE && facts.name === 'CMSIS Load+Run') {
        return 'loadRun';
    }
    if (facts.source === WORKSPACE_SOURCE) {
        return CMSIS_TASK_LABELS.get(facts.name);
    }
    if (facts.source === 'CMSIS' && facts.name === 'Target Information') {
        return 'targetInfo';
    }
    return undefined;
}

/**
 * A panel label in another case, with other spacing or from another source.
 * The tracker uses it only when `classifyCmsisTask` found nothing, and logs
 * that it did.
 */
export function classifyByLabelLoosely(facts: TaskFacts): CmsisTaskKind | undefined {
    const wanted = facts.name.trim().replace(/\s+/g, ' ').toLowerCase();
    for (const [label, kind] of CMSIS_TASK_LABELS) {
        if (label.toLowerCase() === wanted) {
            return kind;
        }
    }
    return undefined;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** The `cmsis_action` actions that run a CMSIS task and are followed as jobs. */
export type JobAction = 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug';

/** A job this window's cmsis_action began, or an execution started elsewhere (the panel) that the tracker adopted. */
export type JobOrigin = 'call' | 'adopted';

export type JobState = 'armed' | 'started' | 'ok' | 'failed' | 'cancelled' | 'running-ok' | 'not-started';

/** The part an execution plays in its job; undefined for one that is only noted. */
export type JobRole = 'main' | 'load' | 'run';

/** How a job is judged done. */
type SettleRule = 'main-ends' | 'load-ends' | 'load-then-run';

interface ActionPhase {
    /** The kind each role binds, first come first served. */
    roles: Partial<Record<JobRole, CmsisTaskKind>>;
    settle: SettleRule;
    /** The tasks.json label the action runs, when it runs one by label. */
    label?: string;
}

/**
 * What each action waits for (#47, step 3):
 *   - build, load, erase: the bound execution's process ends;
 *   - load_and_run: a single task (Arm Debugger, uVision) ends, or, for the
 *     compound of the pyOCD, J-Link and FVP templates, Load ended 0 and
 *     Run's process started and is still alive 2 s later — the rule the
 *     extension's own panel state uses;
 *   - load_and_debug: its pre-launch task `CMSIS Load` ends, when there is
 *     one (the FVP and Arm Debugger templates have none).
 */
export const ACTION_PHASES: Readonly<Record<JobAction, ActionPhase>> = {
    build: { roles: { main: 'build' }, settle: 'main-ends' },
    load: { roles: { main: 'load' }, settle: 'main-ends', label: 'CMSIS Load' },
    erase: { roles: { main: 'erase' }, settle: 'main-ends', label: 'CMSIS Erase' },
    load_and_run: { roles: { main: 'loadRun', load: 'load', run: 'run' }, settle: 'load-then-run', label: 'CMSIS Load+Run' },
    load_and_debug: { roles: { load: 'load' }, settle: 'load-ends' },
};

/** A job that saw no expected task start this long after its command went out has `not-started`. */
export const NOTHING_STARTED_MS = 10_000;
/** How long CMSIS Run must stay up after its process started before load_and_run counts as running. */
export const RUN_GRACE_MS = 2_000;

/** One task execution as a job saw it. Times are the tracker's clock. */
export interface JobExecution {
    /** The tracker's handle for the execution. */
    key: number;
    name: string;
    kind: CmsisTaskKind;
    /** Undefined: seen while the job was open, but not one of its tasks (a note). */
    role?: JobRole;
    startedAt: number;
    processStartedAt?: number;
    processEndedAt?: number;
    exitCode?: number;
    endedAt?: number;
}

export interface Job {
    readonly id: string;
    readonly action: JobAction;
    /** The target the job runs on, when known. */
    readonly target?: string;
    readonly origin: JobOrigin;
    readonly armedAt: number;
    /** When the command went out and its kick-off ended; starts the not-started window. */
    readonly issuedAt?: number;
    readonly state: JobState;
    readonly settledAt?: number;
    /** The execution whose start or end decided the state. */
    readonly decidedBy?: number;
    /** Every CMSIS execution that started while the job was open, bound or not, in order. */
    readonly executions: readonly JobExecution[];
    /** Executions alive when the job was armed: they never complete it. */
    readonly preexisting: readonly number[];
    /** The execution the build command returned, once known. */
    readonly identity?: number;
    /** Remarks for the result, e.g. why the job was settled from outside. */
    readonly notes: readonly string[];
    /** Why a failed build failed (#15), attached after the job settled; see `JobDiagnosis`. */
    readonly diagnosis?: JobDiagnosis;
}

/**
 * One message of a failed build (#15), as a compiler, the linker, CMake,
 * ninja or csolution printed it. `file` is as the tool wrote it (usually
 * absolute); the journal of #48 takes these as problems of source `build`.
 */
export interface BuildMessage {
    severity: 'error' | 'warning';
    file?: string;
    line?: number;
    column?: number;
    /** The tool's code or flag: `L6218E`, `-Wunused-variable`, or `csolution` for a cbuild-family line. */
    code?: string;
    message: string;
    /** The build context (`.Debug+MPS3`) of a csolution message. */
    context?: string;
}

/**
 * What the extension found out about a failed build (#15), attached to its
 * job once the job settled (`CmsisJobTracker.completeWith`):
 *
 *   - `pending` while the csolution index is read and the diagnostic re-run
 *     of cbuild goes on; the job's result then says the lines are coming;
 *   - `done` with the error and warning lines, where they came from, and the
 *     text the `cmsis_action` result shows.
 *
 * `errors` and `warnings` are the structured form: every message with file,
 * line, column and text, at most `MAX_BUILD_MESSAGES` of each; the counts
 * are the full ones.
 */
export interface JobDiagnosis {
    state: 'pending' | 'done';
    /** `csolution`: a fresh cbuild-idx.yml; `rerun`: cbuild re-run with --log; `none`: neither produced lines. */
    source: 'csolution' | 'rerun' | 'none';
    errors: readonly BuildMessage[];
    warnings: readonly BuildMessage[];
    errorCount: number;
    warningCount: number;
    /** The re-run's log file, absolute. */
    logFile?: string;
    /** Why there was no re-run, or what limits its lines. */
    note?: string;
    /** The block the job's result shows: at most 10 message lines and 3 000 characters. */
    text: string;
}

/** The structured lists of a diagnosis keep at most this many messages each. */
export const MAX_BUILD_MESSAGES = 200;

/** A failed build's diagnosis while its lines are being collected. */
export const PENDING_DIAGNOSIS: JobDiagnosis = Object.freeze({
    state: 'pending', source: 'none', errors: [], warnings: [], errorCount: 0, warningCount: 0, text: '',
});

/** An execution as a start event names it. */
interface Sighting {
    key: number;
    name: string;
    kind: CmsisTaskKind;
    at: number;
}

/** What the tracker tells a job; only CMSIS executions are reported. */
export type JobEvent =
    | ({ type: 'taskStart' } & Sighting)
    | ({ type: 'processStart' } & Sighting)
    | ({ type: 'identity' } & Sighting)
    | { type: 'processEnd'; key: number; exitCode: number | undefined; at: number }
    | { type: 'taskEnd'; key: number; at: number }
    | { type: 'issued'; at: number }
    | { type: 'tick'; at: number };

const SETTLED: ReadonlySet<JobState> = new Set<JobState>(['ok', 'failed', 'cancelled', 'running-ok', 'not-started']);

/** True once the state no longer changes. */
export function isSettled(state: JobState): boolean {
    return SETTLED.has(state);
}

/** A fresh job, armed at `at`; `preexisting` are the executions alive at that moment. */
export function armJob(fields: { id: string; action: JobAction; target?: string; origin: JobOrigin; at: number; preexisting: readonly number[] }): Job {
    return {
        id: fields.id, action: fields.action, target: fields.target, origin: fields.origin,
        armedAt: fields.at, state: 'armed', executions: [], preexisting: [...fields.preexisting], notes: [],
    };
}

/** The execution bound to `role`, if any. */
export function executionIn(job: Job, role: JobRole): JobExecution | undefined {
    return job.executions.find((execution) => execution.role === role);
}

/** Executions seen while the job was open that are not its tasks. */
export function bystanders(job: Job): JobExecution[] {
    return job.executions.filter((execution) => execution.role === undefined);
}

function hasEnded(execution: JobExecution): boolean {
    return execution.processEndedAt !== undefined || execution.endedAt !== undefined;
}

/** How long an execution ran: to its process end, else its task end, else `now`. */
export function runtimeOf(execution: JobExecution, now: number): number {
    const from = execution.processStartedAt ?? execution.startedAt;
    const to = execution.processEndedAt ?? execution.endedAt ?? now;
    return Math.max(0, to - from);
}

function withExecution(job: Job, key: number, change: (execution: JobExecution) => JobExecution): Job {
    if (!job.executions.some((execution) => execution.key === key)) {
        return job;
    }
    return { ...job, executions: job.executions.map((execution) => (execution.key === key ? change(execution) : execution)) };
}

/** The role a newly started execution of `kind` would take in this job, if one is free. */
function freeRole(job: Job, key: number, kind: CmsisTaskKind): JobRole | undefined {
    const roles = ACTION_PHASES[job.action].roles;
    for (const role of Object.keys(roles) as JobRole[]) {
        if (roles[role] !== kind || executionIn(job, role) !== undefined) {
            continue;
        }
        // Once the build command has returned its execution, no other build is this job's.
        if (role === 'main' && job.identity !== undefined && job.identity !== key) {
            continue;
        }
        return role;
    }
    return undefined;
}

function sighted(job: Job, event: Extract<JobEvent, { type: 'taskStart' | 'processStart' }>): Job {
    if (job.preexisting.includes(event.key)) {
        return job;
    }
    const known = job.executions.find((execution) => execution.key === event.key);
    if (known) {
        return event.type === 'processStart' && known.processStartedAt === undefined
            ? withExecution(job, event.key, (execution) => ({ ...execution, processStartedAt: event.at }))
            : job;
    }
    if (isSettled(job.state)) {
        return job;
    }
    const execution: JobExecution = {
        key: event.key, name: event.name, kind: event.kind, role: freeRole(job, event.key, event.kind), startedAt: event.at,
        ...(event.type === 'processStart' ? { processStartedAt: event.at } : {}),
    };
    return { ...job, executions: [...job.executions, execution] };
}

/** The build command returned this execution: it is the job's build, whatever started first. */
function identified(job: Job, event: Extract<JobEvent, { type: 'identity' }>): Job {
    if (job.preexisting.includes(event.key) || isSettled(job.state)) {
        return { ...job, identity: event.key };
    }
    const roles = ACTION_PHASES[job.action].roles;
    if (roles.main !== event.kind) {
        return job;
    }
    const executions: JobExecution[] = job.executions.map((execution) => {
        if (execution.key === event.key) {
            return { ...execution, role: 'main' };
        }
        return execution.role === 'main' ? { ...execution, role: undefined } : execution;
    });
    if (!executions.some((execution) => execution.key === event.key)) {
        executions.push({ key: event.key, name: event.name, kind: event.kind, role: 'main', startedAt: event.at });
    }
    return { ...job, identity: event.key, executions };
}

/** Fold one event into the job. A settled job keeps its state; its executions still record their ends. */
export function reduceJob(job: Job, event: JobEvent): Job {
    let next: Job;
    switch (event.type) {
        case 'issued':
            next = job.issuedAt === undefined ? { ...job, issuedAt: event.at } : job;
            break;
        case 'tick':
            next = job;
            break;
        case 'identity':
            next = identified(job, event);
            break;
        case 'taskStart':
        case 'processStart':
            next = sighted(job, event);
            break;
        case 'processEnd':
            next = withExecution(job, event.key, (execution) => execution.processEndedAt !== undefined
                ? execution
                : { ...execution, processEndedAt: event.at, exitCode: event.exitCode });
            break;
        case 'taskEnd':
            next = withExecution(job, event.key, (execution) => execution.endedAt !== undefined ? execution : { ...execution, endedAt: event.at });
            break;
    }
    return isSettled(next.state) ? next : judged(next, event.at);
}

/** Settle a job from outside (its command failed before a task started); a settled job stays as it is. */
export function settleJob(job: Job, state: JobState, at: number, note?: string): Job {
    if (isSettled(job.state)) {
        return job;
    }
    return { ...job, state, settledAt: isSettled(state) ? at : undefined, notes: note ? [...job.notes, note] : job.notes };
}

interface Verdict {
    state: JobState;
    by?: number;
}

function judged(job: Job, now: number): Job {
    const verdict = verdictOf(job, now);
    if (verdict.state === job.state && verdict.by === job.decidedBy) {
        return job;
    }
    return { ...job, state: verdict.state, decidedBy: verdict.by, settledAt: isSettled(verdict.state) ? now : undefined };
}

/** ok for exit 0, failed for another code, cancelled when the task ended without one. */
function byExitCode(execution: JobExecution): Verdict {
    if (execution.exitCode === 0) {
        return { state: 'ok', by: execution.key };
    }
    return { state: execution.exitCode === undefined ? 'cancelled' : 'failed', by: execution.key };
}

function awaitingStart(job: Job, now: number): Verdict {
    return job.issuedAt !== undefined && now - job.issuedAt >= NOTHING_STARTED_MS ? { state: 'not-started' } : { state: 'armed' };
}

function verdictOf(job: Job, now: number): Verdict {
    const main = executionIn(job, 'main');
    switch (ACTION_PHASES[job.action].settle) {
        case 'main-ends':
            if (!main) {
                return awaitingStart(job, now);
            }
            return hasEnded(main) ? byExitCode(main) : { state: 'started' };
        case 'load-ends': {
            // A missing pre-launch task is no failure: the handler settles the job once the session decides.
            const load = executionIn(job, 'load');
            if (!load) {
                return { state: 'armed' };
            }
            return hasEnded(load) ? byExitCode(load) : { state: 'started' };
        }
        case 'load-then-run':
            return loadThenRun(job, now);
    }
}

function loadThenRun(job: Job, now: number): Verdict {
    const main = executionIn(job, 'main');
    const load = executionIn(job, 'load');
    const run = executionIn(job, 'run');
    // A Load+Run with a process of its own is a single task (Arm Debugger flash, uVision): its exit decides.
    if (main && main.processStartedAt !== undefined) {
        return hasEnded(main) ? byExitCode(main) : { state: 'started' };
    }
    if (load && hasEnded(load) && load.exitCode !== 0) {
        return byExitCode(load);
    }
    if (run && hasEnded(run)) {
        // Run hosts the GDB server and is meant to stay up: ending at all is a failure.
        return { state: run.exitCode === undefined ? 'cancelled' : 'failed', by: run.key };
    }
    if (load && hasEnded(load) && run?.processStartedAt !== undefined) {
        return now - run.processStartedAt >= RUN_GRACE_MS ? { state: 'running-ok', by: run.key } : { state: 'started' };
    }
    if (main && main.endedAt !== undefined) {
        return { state: 'failed', by: main.key };
    }
    if (!main && !load && !run) {
        return awaitingStart(job, now);
    }
    return { state: 'started' };
}

/** When the verdict may change with time alone: the not-started window, or the end of Run's grace. */
export function nextTimeCheck(job: Job): number | undefined {
    if (isSettled(job.state)) {
        return undefined;
    }
    if (job.state === 'armed' && job.issuedAt !== undefined && ACTION_PHASES[job.action].settle !== 'load-ends') {
        return job.issuedAt + NOTHING_STARTED_MS;
    }
    const load = executionIn(job, 'load');
    const run = executionIn(job, 'run');
    if (job.action === 'load_and_run' && load && hasEnded(load) && run?.processStartedAt !== undefined && !hasEnded(run)) {
        return run.processStartedAt + RUN_GRACE_MS;
    }
    return undefined;
}

// ── Probe guard (#46) ─────────────────────────────────────────────────────────

/** Something that holds, or is about to hold, the probe in this window. */
export interface ProbeOwner {
    name: string;
    kind: CmsisTaskKind | 'flash';
    /** Unknown for an execution that was already running when the tracker started. */
    startedAt?: number;
}

/** The actions the guard judges: every cmsis_action action and flash. */
export type GuardedAction =
    | 'build' | 'status' | 'detach' | 'stop_run' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'flash';

/**
 * Why an action may not touch the probe: CMSIS Run (or Load+Run) hosts a GDB
 * server on it, a Load, Erase, TargetInfo or `flash` is using it, or a debug
 * session holds it.
 */
export type GuardVerdict = { allowed: true } | { allowed: false; reason: 'server' | 'busy' | 'session'; owner?: ProbeOwner };

/** Hold the probe until they are stopped. */
const SERVER_KINDS: ReadonlySet<string> = new Set(['run', 'loadRun']);
/** Hold it until they end on their own. */
const TRANSIENT_KINDS: ReadonlySet<string> = new Set(['load', 'erase', 'targetInfo', 'flash']);
/** Never touch the probe (a target switch under a session is refused elsewhere). */
const PROBE_FREE_ACTIONS: ReadonlySet<GuardedAction> = new Set<GuardedAction>(['build', 'status', 'detach', 'stop_run']);

/**
 * The guard matrix of #46. `attach` may run beside a live Run task: it
 * connects to the GDB server Run hosts. A repeated load, erase or
 * load_and_run attaches to its own job before the guard is asked.
 */
export function guardProbe(action: GuardedAction, owners: readonly ProbeOwner[], session: boolean): GuardVerdict {
    if (PROBE_FREE_ACTIONS.has(action)) {
        return { allowed: true };
    }
    // Name CMSIS Run itself rather than the compound Load+Run that waits on it.
    const server = owners.find((owner) => owner.kind === 'run') ?? owners.find((owner) => SERVER_KINDS.has(owner.kind));
    if (server && action !== 'attach') {
        return { allowed: false, reason: 'server', owner: server };
    }
    const busy = owners.find((owner) => TRANSIENT_KINDS.has(owner.kind));
    if (busy) {
        return { allowed: false, reason: 'busy', owner: busy };
    }
    return session ? { allowed: false, reason: 'session' } : { allowed: true };
}
