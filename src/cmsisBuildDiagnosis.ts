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
 * The error lines of a failed CMSIS build (#15), and the check of a build
 * that exited 0.
 *
 * When a build or rebuild job of the window's CMSIS job tracker settles as
 * failed with an exit code other than 0, `attachBuildDiagnosis` hands the
 * tracker the work that completes the job's result
 * (`CmsisJobTracker.completeWith`). The failing `cmsis_action build` call
 * shows the lines if they arrive within its deadline;
 * `cmsis_action {action:'status'}` shows them afterwards. A stopped build
 * (Stop Build, `cmsis_action stop_build`) is `cancelled`, not failed, and is
 * left alone.
 *
 * A build that exited 0 is checked the same way before it counts as a
 * success: CMSIS Solution 1.70.1 closes its build task with 0 whatever cbuild
 * returned (its `BuildRunner` ignores the exit code the toolbox manager
 * hands back, and the pseudoterminal then closes with 0). Errors in a fresh
 * cbuild-idx.yml make it a failure; images all rewritten since the build
 * task started (`onStarted` notes their times) confirm it; otherwise stage B
 * below decides — its re-run fails
 * where the build failed and succeeds when there was nothing to rebuild —
 * and when it cannot run, the result says the build is not confirmed.
 *
 * A clean that exited 0 is checked against the images of the active target
 * that were there when its task started (`onStarted` notes them before
 * cbuild runs): all gone confirms it, one left makes it unconfirmed.
 *
 *   1. Stage A reads the `messages` of the solution's `*.cbuild-idx.yml`
 *      (in the solution directory, or under CMSIS Solution's `--output`
 *      prefix) when the file was written after the build started. Errors
 *      there — missing packs or components, schema errors — are the answer,
 *      labelled "from csolution", and nothing is re-run. Stage A always runs.
 *   2. Stage B runs cbuild once more with `--log` into
 *      `<solutionDir>/out/cmsis-developer-assistant/build-diagnostic.log`,
 *      with the arguments of `cbuildDiagnosticArgs` (no pack download, no
 *      RTE update, no clean; `--skip-convert` after a fresh index), in the
 *      environment of `.cmsis/tools-environment.yml` with the extension's
 *      pack root. The build is incremental: what compiled before is up to
 *      date, and the failing translation unit fails again.
 *
 * Guards of the re-run: the setting `cmsis-developer-assistant.build.diagnosticRerun`
 * (window scope, read for every failure); no shell; a limit of 30 min
 * (`DIAGNOSTIC_RERUN_CAP_MS`), meant for a tool that hangs, not for a long
 * build, which goes on as the job's follow-up; it starts only while no other
 * build, rebuild or clean is alive, and one that starts meanwhile kills it
 * and everything it started; `cmsis_action stop_build` stops it as well
 * (`stopAll`), since it is no task. CMSIS Solution's own setup task
 * (`cbuild setup …`, after loading a solution or a target switch) is no
 * newer build (#138): the re-run waits until no setup is alive (at most
 * `SETUP_WAIT_MS`), and a setup that starts while it runs stops it, after
 * which it waits for that setup and runs again, so that the build still gets
 * a verified result. A missing
 * environment file or cbuild, or the setting off, is said in the result,
 * which then names `get_build_diagnostics`.
 *
 * A stop ends what the report reads (#135). The kill leaves ninja a
 * `FAILED:` step for the compiler it ended and cbuild an `error building`
 * line: the stop's, not the build's. So the report takes the output that
 * came before the stop and the log as long as it was then; after a stop at
 * the limit or by stop_build the log is cut there too, with a line that says
 * so, for `get_build_diagnostics`. A re-run cut off before any error line
 * leaves a failed build without lines and a build that exited 0 not
 * confirmed — never failed.
 *
 * One re-run at a time owns the log, the one file `get_build_diagnostics`
 * reads. A newer re-run stops the older ones and waits until each has let
 * go of it: its cbuild closed, or the kill's grace ran out (on POSIX the
 * kill turns into SIGKILL within it). A superseded re-run reports at once,
 * without reading, cutting or marking the log, and the newer one removes the
 * log before its cbuild starts. A late write of the old cbuild then goes to
 * the removed file (POSIX) or makes the removal fail, so that the newer
 * re-run says it could not start (Windows) — never into the newer log.
 *
 * Assumed, not yet confirmed on a live installation (this was written
 * without hardware or network):
 *   - `cbuild … --skip-convert --log <file>` still runs cbuild2cmake, CMake
 *     and ninja, and the log carries the compiler's lines; the output cbuild
 *     prints is parsed as well, in case the log does not;
 *   - cbuild alone writes its `--log` file, through the handle it opened at
 *     its start, which the ownership of the log above rests on;
 *   - the environment of tools-environment.yml plus `CMSIS_PACK_ROOT`
 *     reproduces the extension's own build on macOS and Windows;
 *   - CMSIS Solution does not write build outputs from its csolution RPC
 *     while the re-run builds (only its build tasks are watched).
 *
 * Everything outside VS Code and the file system comes through a
 * `DiagnosisHost`; tests give it a fake spawn, a hand-moved clock and fixed
 * settings, and `vscodeDiagnosisHost` is the real one.
 */

import * as vscode from 'vscode';
import { spawn as spawnProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CmsisJobTracker, LiveExecution, TaskDefinitionLike, TrackerClock } from './cmsisJobTracker';
import {
    BuildFailureReport,
    cbuildDiagnosticArgs,
    cbuildExecutable,
    DIAGNOSTIC_LOG_PATH,
    DIAGNOSTIC_RERUN_CAP_MS,
    DIAGNOSTIC_RERUN_CAP_TEXT,
    diagnosticEnvironment,
    IDX_FRESHNESS_SLACK_MS,
    idxBuildFiles,
    idxFileName,
    IdxMessages,
    idxMessages,
    messagesFromLog,
    primaryOutputs,
    readToolsEnvironment,
    RerunOutcome,
    RerunSkip,
    rerunSkipText,
} from './core/buildFailure';
import { parseCbuildRunOutputs, parseCbuildYml } from './core/buildInfo/artifacts';
import { BuildLogSummary, parseBuildLog, readBuildLog } from './core/buildInfo/buildLog';
import { renderBuildFailure } from './core/buildInfo/render';
import {
    BUILD_TASK_KINDS,
    BuildCheck,
    BuildMessage,
    isBuildAction,
    Job,
    JobDiagnosis,
    JobExecution,
    MAX_BUILD_MESSAGES,
    SETUP_TASK_KINDS,
    SETUP_WAIT_MS,
} from './core/cmsisTasks';
import { knownMessageLines } from './core/knowledge/knownMessageLookup';
import { activeTargetSetOf, solutionFileOf } from './core/solutionAnswers';
import { formatDuration } from './handler/jobText';
import { logger } from './utils/logger';
import { withTimeout } from './utils/timeout';
import { effectiveToolchainPackRoot } from './utils/toolchainPackRoot';

/** An output stream of the child, as far as the re-run reads it. */
export interface DiagnosticOutput {
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
}

/** The part of a child process the re-run uses. */
export interface DiagnosticChild {
    readonly pid?: number;
    readonly stdout: DiagnosticOutput | null;
    readonly stderr: DiagnosticOutput | null;
    on(event: 'close', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
}

/** How the re-run is started: never through a shell. */
export interface DiagnosticSpawnOptions {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    windowsHide: true;
    /** A process group of its own on POSIX, so that the kill reaches CMake, ninja and the compilers. */
    detached: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
}

export type DiagnosticSpawn = (command: string, args: readonly string[], options: DiagnosticSpawnOptions) => DiagnosticChild;

/** What the diagnosis takes from its surroundings. */
export interface DiagnosisHost {
    /** `cmsis-developer-assistant.build.diagnosticRerun`, read for every failed build. */
    rerunEnabled(): boolean;
    /** The active solution file, for a task definition that does not name one. */
    solutionFile(): Promise<string | undefined>;
    /** The active target set, for a task definition whose `active` is a variable. */
    activeTarget(): Promise<string | undefined>;
    /** CMSIS Solution's `outputDirectory` setting; cbuild's `--output` is it under the solution directory. */
    outputDirectorySetting(): string | undefined;
    /** `CMSIS_PACK_ROOT` as the CMSIS Solution extension resolves it. */
    packRoot(): Promise<string | undefined>;
    /** Where cbuild runs, as for the extension's own build: the first workspace folder. */
    workingDirectory(): string | undefined;
    /** The environment the re-run starts from. */
    baseEnvironment(): Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    spawn: DiagnosticSpawn;
    /** End the child and whatever it started. */
    killTree(child: DiagnosticChild): void;
    /** The tracker's clock: job times, the cap and the kill grace. */
    readonly clock: TrackerClock;
    /** Lines for the error messages the knowledge index knows; absent or empty without the knowledge tools. */
    knownMessageLines?(messages: readonly string[]): string[] | Promise<string[]>;
}

/** A build result names at most this many units of the knowledge index. */
const MAX_KNOWN_MESSAGE_LINES = 3;
/** After a kill, the re-run counts as ended this long later even without a `close` event. */
const KILL_GRACE_MS = 5_000;
/** What is kept of cbuild's own output, the end of it, for when the log is missing or short. */
const OUTPUT_TAIL_BYTES = 256 * 1024;
/** What is read of a stopped re-run's log, the end of what it had at the stop, as `readBuildLog` reads a log. */
const LOG_READ_BYTES = 16 * 1024 * 1024;
/** How long a CMSIS Solution query may take. */
const QUERY_MS = 5_000;
/** A re-run stopped by a setup task that starts while it runs is started again at most this often (#138). */
const MAX_SETUP_RESTARTS = 3;
/** At most this many cleans keep the images they found at their start, waiting for their end. */
const MAX_CLEAN_SNAPSHOTS = 8;
/** Definition fields that must not hold a variable the re-run cannot resolve (`solution` and `active` are resolved). */
const LITERAL_FIELDS = ['generator', 'intermediateDirectory', 'outputDirectory', 'cmakeTarget', 'toolchain'];

/**
 * Why a re-run was stopped before cbuild ended by itself: its limit,
 * `cmsis_action stop_build`, a newer build or re-run, CMSIS Solution's setup
 * task (after which it runs again, #138), the end of the extension.
 */
type StopReason = 'cap' | 'request' | 'superseded' | 'setup' | 'disposed';

/** A stop: why it came, and how many bytes the log had then. */
interface RerunStop {
    reason: StopReason;
    logBytes: number;
}

/** How a re-run ended, as the runner sees it. */
type RunResult =
    | { kind: 'spawn-failed'; error: string }
    | {
        kind: 'ended';
        /** cbuild's exit code; null when it was stopped. */
        exitCode: number | null;
        /** The end of what cbuild printed; after a stop, of what it printed before the stop. */
        output: string;
        stop?: RerunStop;
    };

/**
 * A stop after which the re-run still owns the log; a superseded re-run never
 * touches it again (#135), and one stopped for a setup starts it afresh (#138).
 */
type OwnStop = Exclude<StopReason, 'superseded' | 'setup'>;

/** Why a stop came, as the line it leaves in the log says it. */
const STOP_CAUSES: Readonly<Record<OwnStop, string>> = {
    cap: `at its ${DIAGNOSTIC_RERUN_CAP_TEXT} limit`,
    request: 'by cmsis_action stop_build',
    disposed: 'because the extension shut down',
};

/** What a clean was to remove: the images of its target that existed when it started; none known when the definition does not say. */
export interface CleanSnapshot {
    images?: string[];
    solutionDir?: string;
    target?: string;
}

/** A re-run in progress, as `dispose` and the build-start watch stop it. */
interface RunningRerun {
    stop(reason: StopReason): void;
}

/** The counts when a build ended: a build start or a stop_build counted after them supersedes or stops its re-run. */
interface RerunMarks {
    buildStarts: number;
    stopRequests: number;
}

/** The last `limit` bytes of a stream of text, up to `close`. */
class OutputTail {
    private chunks: string[] = [];
    private size = 0;
    private closed = false;

    constructor(private readonly limit: number) {}

    add(chunk: unknown): void {
        if (this.closed) {
            return;
        }
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        this.chunks.push(text);
        this.size += text.length;
        while (this.size > this.limit && this.chunks.length > 1) {
            this.size -= this.chunks.shift()?.length ?? 0;
        }
    }

    text(): string {
        return this.chunks.join('');
    }

    /** Keep no more: what comes after is the stop's, not the build's. */
    close(): void {
        this.closed = true;
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** The size of a file in bytes; 0 when it is not there. */
function sizeOf(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

/** The text of the first `bytes` bytes of `file`, the last `LOG_READ_BYTES` of them at most; empty when it cannot be read. */
function readHead(file: string, bytes: number): string {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const start = Math.max(0, bytes - LOG_READ_BYTES);
        const buffer = Buffer.alloc(bytes - start);
        const read = fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8', 0, read);
    } catch {
        return '';
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch {
                // Read already, or never opened.
            }
        }
    }
}

/**
 * The log of a re-run stopped at its limit, by stop_build or as the
 * extension shuts down, as it was when the stop came; undefined when it was
 * empty or missing then. Only a re-run that still owns the log calls it: a
 * superseded one leaves the log to the newer re-run. What cbuild wrote after
 * the stop is the stop's doing — ninja's `FAILED:` for the compiler it
 * ended, `ninja: build stopped`, cbuild's `error building` — so it is cut
 * from the file too, and a line says where and why, so that
 * `get_build_diagnostics` does not read it as the build's (#135). The cut is
 * best effort; the report never reads past the stop either way.
 */
function logBeforeStop(logFile: string, logBytes: number, reason: OwnStop): BuildLogSummary | undefined {
    if (!isFile(logFile)) {
        return undefined;
    }
    const kept = Math.min(logBytes, sizeOf(logFile));
    const head = readHead(logFile, kept);
    try {
        fs.truncateSync(logFile, kept);
        const newline = head.length > 0 && !head.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(logFile, `${newline}[cmsis-developer-assistant] This diagnostic re-run was stopped here ${STOP_CAUSES[reason]}, `
            + 'before cbuild finished; what ninja and cbuild printed because of the stop is left out.\n');
    } catch (caught) {
        logger.debug('Build diagnosis: the log of the stopped re-run could not be cut', caught);
    }
    return head.length > 0 ? parseBuildLog(head, logFile) : undefined;
}

/** A string field of the definition that holds a VS Code variable (`${command:…}`). */
function holdsVariable(value: unknown): boolean {
    return typeof value === 'string' && value.includes('${');
}

/**
 * The newest `<solution>.cbuild-idx.yml` written since the build started:
 * under `--output` first, then next to the solution; with its messages.
 */
function freshIndex(solution: string, output: string | undefined, startedAt: number): { file: string; messages: IdxMessages } | undefined {
    const name = idxFileName(solution);
    const candidates = [...(output ? [path.join(output, name)] : []), path.join(path.dirname(solution), name)];
    for (const file of candidates) {
        try {
            if (fs.statSync(file).mtimeMs + IDX_FRESHNESS_SLACK_MS < startedAt) {
                continue;
            }
            return { file, messages: idxMessages(fs.readFileSync(file, 'utf8')) };
        } catch {
            // Not there, or not readable: the next candidate.
        }
    }
    return undefined;
}

/** A report with no lines of its own: why, and csolution's warnings when there are some. */
function withoutLines(skip: RerunSkip, csolutionWarnings: BuildMessage[], idxFile?: string): BuildFailureReport {
    return {
        source: 'none', errors: [], warnings: [], errorCount: 0, warningCount: 0, failedSteps: [],
        csolutionWarnings, ...(idxFile ? { idxFile } : {}), skipped: rerunSkipText(skip),
    };
}

/** An image a build should have written, and when it was written last (undefined: missing). */
interface ImageStamp {
    file: string;
    mtimeMs?: number;
}

/** The modification time of a file, or undefined when it is not there. */
function mtimeOf(file: string): number | undefined {
    try {
        const stat = fs.statSync(file);
        return stat.isFile() ? stat.mtimeMs : undefined;
    } catch {
        return undefined;
    }
}

/** The primary outputs of a cbuild.yml, or of a cbuild-run.yml; none when it cannot be read. */
function outputsOf(file: string, kind: 'cbuild' | 'cbuild-run'): string[] {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return primaryOutputs(kind === 'cbuild' ? parseCbuildYml(text, file).outputs : parseCbuildRunOutputs(text, file).outputs);
    } catch {
        return [];
    }
}

/**
 * The images the build of `solution` writes: the primary outputs of each
 * context the solution's cbuild-idx.yml names (under `--output` first, then
 * next to the solution), else those of the cbuild-run.yml it names, else
 * those of `out/<solution>+<active>.cbuild-run.yml`. The index need not be
 * fresh: csolution leaves files it would not change alone.
 */
function expectedImages(solution: string, output: string | undefined, active: string | undefined): string[] {
    const name = idxFileName(solution);
    const base = path.dirname(solution);
    for (const index of [...(output ? [path.join(output, name)] : []), path.join(base, name)]) {
        let text: string;
        try {
            text = fs.readFileSync(index, 'utf8');
        } catch {
            continue;
        }
        const named = idxBuildFiles(text);
        const directory = path.dirname(index);
        const images = named.cbuilds.flatMap((file) => outputsOf(path.resolve(directory, file), 'cbuild'));
        if (images.length === 0 && named.cbuildRun) {
            images.push(...outputsOf(path.resolve(directory, named.cbuildRun), 'cbuild-run'));
        }
        if (images.length > 0) {
            return [...new Set(images)];
        }
    }
    if (!active) {
        return [];
    }
    const stem = path.basename(solution).replace(/\.csolution\.ya?ml$/i, '');
    return outputsOf(path.join(output ?? path.join(base, 'out'), `${stem}+${active}.cbuild-run.yml`), 'cbuild-run');
}

/** When each image was written last, by path; undefined for one that was not there. */
type ImageStamps = ReadonlyMap<string, number | undefined>;

/**
 * Whether the build wrote an image. With what its start found, only a change
 * counts: a failed build that starts right after a good one leaves an image
 * younger than the slack. Without it, an image written since the build
 * started, give or take the slack of coarse file times, counts.
 */
function writtenByBuild(image: ImageStamp, before: ImageStamps | undefined, startedAt: number): boolean {
    if (image.mtimeMs === undefined) {
        return false;
    }
    if (before?.has(image.file)) {
        const earlier = before.get(image.file);
        return earlier === undefined || image.mtimeMs > earlier;
    }
    return image.mtimeMs + IDX_FRESHNESS_SLACK_MS >= startedAt;
}

/** A file as the check's text shows it: relative to the solution directory when inside it. */
function shown(file: string, solutionDir: string): string {
    const relative = path.relative(solutionDir, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replace(/\\/g, '/') : file;
}

/** What the check found about the images: the first one not rewritten, and how old it is. */
function staleText(stale: readonly ImageStamp[], startedAt: number, solutionDir: string): string {
    if (stale.length === 0) {
        return 'The build names no image to look at';
    }
    const first = stale[0];
    const more = stale.length > 1 ? ` (and ${stale.length - 1} more)` : '';
    return first.mtimeMs === undefined
        ? `The image ${shown(first.file, solutionDir)}${more} is missing`
        : `The image ${shown(first.file, solutionDir)}${more} was not rewritten: it is from ${formatDuration(startedAt - first.mtimeMs)} before the build started`;
}

/** The diagnosis of a build that exited 0: what its check found, and the sentence the result adds. */
function checked(check: BuildCheck, text: string, note?: string): JobDiagnosis {
    return {
        state: 'done', check, source: 'none', errors: [], warnings: [], errorCount: 0, warningCount: 0,
        ...(note ? { note } : {}), text,
    };
}

/** The job's diagnosis from a report: the structured lists, the counts and the text the result shows. */
export function diagnosisOf(report: BuildFailureReport, solutionDir: string | undefined): JobDiagnosis {
    const warnings = [...report.warnings, ...report.csolutionWarnings];
    let note = report.skipped;
    if (report.source === 'rerun') {
        note = 'a re-run recompiles only what failed, so its warnings are those of the files it recompiled';
        const stopped = report.rerun?.stopped;
        if (stopped) {
            const how = stopped === 'cap' ? `was cut off at its ${DIAGNOSTIC_RERUN_CAP_TEXT} limit` : 'was stopped by cmsis_action stop_build';
            note = `the re-run ${how}, so its lines are only those it printed before the stop; ${note}`;
        }
    }
    return {
        state: 'done',
        source: report.source,
        errors: report.errors.slice(0, MAX_BUILD_MESSAGES),
        warnings: warnings.slice(0, MAX_BUILD_MESSAGES),
        errorCount: report.errorCount,
        warningCount: report.warningCount + report.csolutionWarnings.length,
        ...(report.logFile ? { logFile: report.logFile } : {}),
        ...(note ? { note } : {}),
        text: renderBuildFailure(report, { root: solutionDir }),
    };
}

/**
 * Collects the error lines of failed build jobs and hands them to the
 * tracker. One re-run at a time, which owns the log: the newest stops the
 * older ones and starts once they have let go of it; `dispose` kills those
 * still going.
 */
export class BuildDiagnosisRunner {
    private readonly running = new Set<RunningRerun>();
    /** The images each clean found at its start, by execution key. */
    private readonly cleanSnapshots = new Map<number, CleanSnapshot>();
    /** When each image of a build or rebuild was written last, as its start found them, by execution key. */
    private readonly buildSnapshots = new Map<number, ImageStamps>();
    /** Settles when the re-run that holds the log lets go of it; the next one waits for it (#135). */
    private logTurn: Promise<void> = Promise.resolve();
    /** Re-runs that asked for the log so far: one whose number is not the last was superseded by a newer one. */
    private turns = 0;
    /** Build-type executions started so far: one that starts while a re-run waits for the log supersedes it. */
    private buildStarts = 0;
    /** `cmsis_action stop_build` requests so far: one that comes while a re-run waits for the log stops it. */
    private stopRequests = 0;
    /** Re-runs waiting for a setup task to end, woken by what may end their wait: a build start, a newer re-run, stop_build, disposal. */
    private readonly nudges = new Set<() => void>();
    private disposed = false;
    private readonly disposal: Promise<void>;
    private signalDisposal: () => void = () => undefined;

    constructor(private readonly tracker: CmsisJobTracker, private readonly host: DiagnosisHost) {
        this.disposal = new Promise<void>((resolve) => {
            this.signalDisposal = resolve;
        });
    }

    /**
     * An `onDidFinishJob` listener: a build or rebuild that failed with an
     * exit code other than 0 gets its diagnosis, one that exited 0 gets its
     * check, since CMSIS Solution reports 0 for failed builds too, and a clean
     * that exited 0 gets the check of what it removed.
     */
    onFinished(job: Job): void {
        const decided = job.executions.find((execution) => execution.key === job.decidedBy);
        if (!isBuildAction(job.action) || !decided || decided.exitCode === undefined) {
            return;
        }
        const snapshot = this.cleanSnapshots.get(decided.key);
        this.cleanSnapshots.delete(decided.key);
        const before = this.buildSnapshots.get(decided.key);
        this.buildSnapshots.delete(decided.key);
        if (job.state === 'failed' && decided.exitCode !== 0) {
            this.tracker.completeWith(job.id, this.diagnose(decided).then((diagnosis) => this.withKnownMessages(diagnosis)));
        } else if (job.state === 'ok' && decided.exitCode === 0 && job.action === 'clean') {
            this.tracker.completeWith(job.id, Promise.resolve(this.checkClean(snapshot)));
        } else if (job.state === 'ok' && decided.exitCode === 0 && this.tracker.definitionOf(decided.key)?.clean !== true) {
            this.tracker.completeWith(job.id, this.check(decided, before).then((diagnosis) => this.withKnownMessages(diagnosis)));
        }
    }

    /**
     * An `onDidStartExecution` listener: a clean notes the images of its
     * target that exist now, before cbuild gets to them, for `checkClean`; a
     * build or rebuild notes when each image was written last, so that its
     * check counts only an image written since. Every build-type start is
     * counted, for the re-runs that wait for the log.
     */
    onStarted(execution: LiveExecution): void {
        // CMSIS Solution's setup is no newer build: a re-run waits for it instead (#138).
        if (BUILD_TASK_KINDS.has(execution.kind) && !SETUP_TASK_KINDS.has(execution.kind)) {
            this.buildStarts++;
            this.nudge();
        }
        if (execution.kind === 'build' || execution.kind === 'rebuild') {
            this.noteImageStamps(execution.key);
            return;
        }
        if (execution.kind !== 'clean') {
            return;
        }
        try {
            this.cleanSnapshots.set(execution.key, this.imagesNow(this.tracker.definitionOf(execution.key) ?? {}));
        } catch (caught) {
            logger.debug('Build check: the images before a clean could not be read', caught);
            this.cleanSnapshots.set(execution.key, {});
        }
        for (const key of this.cleanSnapshots.keys()) {
            if (this.cleanSnapshots.size <= MAX_CLEAN_SNAPSHOTS) {
                break;
            }
            this.cleanSnapshots.delete(key);
        }
    }

    /**
     * Remember the images of a starting build and when each was written last
     * (undefined: not there). Nothing is remembered when the definition names
     * the solution through a variable; the check then falls back to the age
     * of the images.
     */
    private noteImageStamps(key: number): void {
        try {
            const where = this.buildFiles(this.tracker.definitionOf(key) ?? {});
            if (where) {
                this.buildSnapshots.set(key, new Map(expectedImages(where.solution, where.output, where.target).map((file) => [file, mtimeOf(file)])));
            }
        } catch (caught) {
            logger.debug('Build check: the images before a build could not be read', caught);
        }
        for (const old of this.buildSnapshots.keys()) {
            if (this.buildSnapshots.size <= MAX_CLEAN_SNAPSHOTS) {
                break;
            }
            this.buildSnapshots.delete(old);
        }
    }

    /** The solution, output folder and target a task definition names; undefined when the solution is named through a variable. */
    private buildFiles(definition: TaskDefinitionLike): { solution: string; solutionDir: string; output?: string; target?: string } | undefined {
        const named = definition.solution;
        if (typeof named !== 'string' || named.length === 0 || holdsVariable(named)) {
            return undefined;
        }
        const cwd = this.host.workingDirectory();
        const solution = path.isAbsolute(named) || !cwd ? named : path.join(cwd, named);
        const solutionDir = path.dirname(solution);
        const setting = this.host.outputDirectorySetting();
        const output = setting ? path.join(solutionDir, setting) : undefined;
        const target = typeof definition.active === 'string' && definition.active.length > 0 && !holdsVariable(definition.active)
            ? definition.active
            : undefined;
        return { solution, solutionDir, ...(output ? { output } : {}), ...(target ? { target } : {}) };
    }

    /** The images the active target's build writes that exist now; none known when the definition names the solution through a variable. */
    private imagesNow(definition: TaskDefinitionLike): CleanSnapshot {
        const where = this.buildFiles(definition);
        if (!where) {
            return {};
        }
        const images = expectedImages(where.solution, where.output, where.target).filter((file) => mtimeOf(file) !== undefined);
        return { images, solutionDir: where.solutionDir, ...(where.target ? { target: where.target } : {}) };
    }

    /**
     * The check of a clean that exited 0: are the images that were there when
     * it started gone? CMSIS Solution reports exit 0 for a failed clean too.
     */
    checkClean(snapshot: CleanSnapshot | undefined): JobDiagnosis {
        const images = snapshot?.images;
        if (!images) {
            return checked('cleaned', 'Which images were there before the clean is not known, so their removal was not checked.');
        }
        const solutionDir = snapshot?.solutionDir ?? '';
        if (images.length === 0) {
            return checked('cleaned', `No image${snapshot?.target ? ` of ${snapshot.target}` : ''} was there to remove.`);
        }
        const more = (list: readonly string[]): string => (list.length > 1 ? ` (and ${list.length - 1} more)` : '');
        const left = images.filter((file) => mtimeOf(file) !== undefined);
        if (left.length > 0) {
            return checked('unverified', `${shown(left[0], solutionDir)}${more(left)} is still there, and CMSIS Solution reports exit 0 `
                + 'for a failed clean too, so this clean may have failed.');
        }
        return checked('cleaned', `Removed: ${shown(images[0], solutionDir)}${more(images)}.`);
    }

    /** The diagnosis with a line for each error message the knowledge index has a unit for, in the context of the active target. */
    async withKnownMessages(diagnosis: JobDiagnosis): Promise<JobDiagnosis> {
        if (diagnosis.errors.length === 0 || !this.host.knownMessageLines) {
            return diagnosis;
        }
        let lines: string[] = [];
        try {
            lines = (await this.host.knownMessageLines(diagnosis.errors.map((error) => error.message))).slice(0, MAX_KNOWN_MESSAGE_LINES);
        } catch (caught) {
            logger.debug('Build diagnosis: the knowledge lookup failed', caught);
        }
        return lines.length > 0 ? { ...diagnosis, text: [diagnosis.text, ...lines].filter((part) => part.length > 0).join('\n') } : diagnosis;
    }

    /** The check of the build `decided` ran, which exited 0; never rejects. */
    async check(decided: JobExecution, before?: ImageStamps): Promise<JobDiagnosis> {
        const marks = this.marks();
        try {
            return await this.checkResult(decided, before, marks);
        } catch (caught) {
            logger.warn('Build check: looking at the result failed', caught);
            return checked('unverified', `Exit 0 is not confirmed: checking the result failed (${messageOf(caught)}).`);
        }
    }

    /** The diagnosis of the build `decided` ran; never rejects. */
    async diagnose(decided: JobExecution): Promise<JobDiagnosis> {
        const marks = this.marks();
        try {
            return await this.collect(decided, marks);
        } catch (caught) {
            logger.warn('Build diagnosis: collecting the error lines failed', caught);
            return diagnosisOf(withoutLines({ kind: 'spawn-failed', error: messageOf(caught) }, []), undefined);
        }
    }

    /** The counts now, taken as a build ends, before anything its re-run waits for. */
    private marks(): RerunMarks {
        return { buildStarts: this.buildStarts, stopRequests: this.stopRequests };
    }

    /**
     * `cmsis_action stop_build`: stop the re-runs that are going, which keep
     * what they printed before the stop, and those waiting for the log, which
     * then do not start. The diagnostic re-run is no task, so stopping tasks
     * does not reach it.
     */
    stopAll(): void {
        this.stopRequests++;
        this.nudge();
        for (const rerun of [...this.running]) {
            rerun.stop('request');
        }
    }

    dispose(): void {
        this.disposed = true;
        this.signalDisposal();
        this.nudge();
        for (const rerun of [...this.running]) {
            rerun.stop('disposed');
        }
        this.cleanSnapshots.clear();
    }

    private async collect(decided: JobExecution, marks: RerunMarks): Promise<JobDiagnosis> {
        const definition: TaskDefinitionLike = this.tracker.definitionOf(decided.key) ?? {};
        if (definition.clean === true) {
            return diagnosisOf(withoutLines({ kind: 'clean' }, []), undefined);
        }
        const cwd = this.host.workingDirectory();
        const solution = await this.solutionOf(definition, cwd);
        if (!solution) {
            return diagnosisOf(withoutLines({ kind: 'no-solution' }, []), undefined);
        }
        const solutionDir = path.dirname(solution);
        const setting = this.host.outputDirectorySetting();
        const output = setting ? path.join(solutionDir, setting) : undefined;

        const index = freshIndex(solution, output, decided.startedAt);
        if (index && index.messages.errors.length > 0) {
            const { errors, warnings } = index.messages;
            return diagnosisOf({
                source: 'csolution', errors, warnings, errorCount: errors.length, warningCount: warnings.length,
                failedSteps: [], csolutionWarnings: [], idxFile: index.file,
            }, solutionDir);
        }
        const csolutionWarnings = index?.messages.warnings ?? [];
        const report = await this.rerun(definition, decided, { solution, output, cwd, index: index?.file }, csolutionWarnings, marks);
        return diagnosisOf(report, solutionDir);
    }

    /**
     * Did a build that exited 0 build? Errors in a fresh cbuild-idx.yml say
     * no. Images all written since the build started say yes. Otherwise the
     * diagnostic re-run decides: it fails where the build failed, and
     * succeeds at once when there was nothing to rebuild.
     */
    private async checkResult(decided: JobExecution, before: ImageStamps | undefined, marks: RerunMarks): Promise<JobDiagnosis> {
        const definition: TaskDefinitionLike = this.tracker.definitionOf(decided.key) ?? {};
        const cwd = this.host.workingDirectory();
        const solution = await this.solutionOf(definition, cwd);
        if (!solution) {
            return checked('unverified', 'Exit 0 is not confirmed: the solution file of the build is not known, so its result could not be checked.');
        }
        const solutionDir = path.dirname(solution);
        const setting = this.host.outputDirectorySetting();
        const output = setting ? path.join(solutionDir, setting) : undefined;

        const index = freshIndex(solution, output, decided.startedAt);
        if (index && index.messages.errors.length > 0) {
            const { errors, warnings } = index.messages;
            return {
                ...diagnosisOf({
                    source: 'csolution', errors, warnings, errorCount: errors.length, warningCount: warnings.length,
                    failedSteps: [], csolutionWarnings: [], idxFile: index.file,
                }, solutionDir),
                check: 'failed',
            };
        }
        const active = typeof definition.active === 'string' && !holdsVariable(definition.active)
            ? definition.active
            : await this.host.activeTarget();
        const images: ImageStamp[] = expectedImages(solution, output, active).map((file) => ({ file, mtimeMs: mtimeOf(file) }));
        const stale = images.filter((image) => !writtenByBuild(image, before, decided.startedAt));
        if (images.length > 0 && stale.length === 0) {
            return checked('rebuilt', '');
        }
        const why = staleText(stale, decided.startedAt, solutionDir);
        const csolutionWarnings = index?.messages.warnings ?? [];
        const report = await this.rerun(definition, decided, { solution, output, cwd, index: index?.file }, csolutionWarnings, marks);
        const rerun = report.rerun;
        if (report.source === 'none' || !rerun) {
            return checked('unverified', `${why}, and CMSIS Solution reports exit 0 for a failed build too, so this build may have failed. `
                + `It could not be checked: ${report.skipped ?? 'there was nothing to run'}.`, report.skipped);
        }
        if (report.errorCount > 0 || report.failedSteps.length > 0 || (rerun.exitCode !== null && rerun.exitCode !== 0)) {
            return { ...diagnosisOf(report, solutionDir), check: 'failed' };
        }
        if (rerun.exitCode === 0) {
            return checked('up-to-date', `${why}; a check re-run of cbuild succeeded (exit 0), so the build is up to date.`);
        }
        const mayHaveFailed = `${why}, and CMSIS Solution reports exit 0 for a failed build too, so this build may have failed.`;
        // Stopped before any error line: no verdict either way, and what the stop printed is none (#135).
        if (rerun.stopped) {
            const atLimit = rerun.stopped === 'cap';
            const who = atLimit
                ? `the CMSIS Developer Assistant stopped its re-run of cbuild at its ${DIAGNOSTIC_RERUN_CAP_TEXT} limit`
                : 'cmsis_action stop_build stopped its re-run of cbuild';
            return checked('unverified', `${mayHaveFailed} The check could not decide: ${who}, before cbuild finished, `
                + 'and no compiler, linker or ninja error had appeared by then.',
            atLimit ? `the check re-run of cbuild was cut off at its ${DIAGNOSTIC_RERUN_CAP_TEXT} limit` : 'the check re-run of cbuild was stopped by cmsis_action stop_build');
        }
        return checked('unverified', `${mayHaveFailed} The check could not decide: its re-run of cbuild ended without an exit code `
            + 'before it printed an error line.');
    }

    /** The solution file: the definition's, resolved against the working directory, else the active one. */
    private async solutionOf(definition: TaskDefinitionLike, cwd: string | undefined): Promise<string | undefined> {
        const named = typeof definition.solution === 'string' && definition.solution.length > 0 && !holdsVariable(definition.solution)
            ? definition.solution
            : await this.host.solutionFile();
        if (!named) {
            return undefined;
        }
        return path.isAbsolute(named) || !cwd ? named : path.join(cwd, named);
    }

    /**
     * Stage B: the gates, the re-run, and the report of its log. The re-run
     * owns the log: it stops the older re-runs and waits until they have let
     * go of it (#135), and it starts only if no build, newer re-run or
     * `cmsis_action stop_build` came meanwhile.
     */
    private async rerun(
        definition: TaskDefinitionLike,
        decided: JobExecution,
        where: { solution: string; output: string | undefined; cwd: string | undefined; index: string | undefined },
        csolutionWarnings: BuildMessage[],
        marks: RerunMarks,
    ): Promise<BuildFailureReport> {
        const skipped = (skip: RerunSkip): BuildFailureReport => withoutLines(skip, csolutionWarnings, where.index);
        if (!this.host.rerunEnabled()) {
            return skipped({ kind: 'setting-off' });
        }
        const solutionDir = path.dirname(where.solution);
        const environmentFile = path.join(solutionDir, '.cmsis', 'tools-environment.yml');
        let environmentText: string;
        try {
            environmentText = fs.readFileSync(environmentFile, 'utf8');
        } catch {
            return skipped({ kind: 'no-environment', file: '.cmsis/tools-environment.yml' });
        }
        const tools = readToolsEnvironment(environmentText);
        const cbuild = cbuildExecutable(tools, this.host.platform);
        if (!cbuild || !isFile(cbuild)) {
            return skipped({ kind: 'no-cbuild', directory: cbuild ? path.dirname(cbuild) : undefined });
        }
        const unresolved = LITERAL_FIELDS.find((field) => holdsVariable(definition[field]));
        if (unresolved) {
            return skipped({ kind: 'unresolved', field: unresolved });
        }
        let active = typeof definition.active === 'string' ? definition.active : '';
        if (holdsVariable(active)) {
            const resolved = await this.host.activeTarget();
            if (!resolved) {
                return skipped({ kind: 'unresolved', field: 'active' });
            }
            active = resolved;
        }

        const turn = ++this.turns;
        for (const older of [...this.running]) {
            older.stop('superseded');
        }
        this.nudge();
        return this.inLogTurn(async () => {
            const env = diagnosticEnvironment(this.host.baseEnvironment(), tools, await this.host.packRoot(), this.host.platform);
            const logFile = path.join(solutionDir, ...DIAGNOSTIC_LOG_PATH.split('/'));
            const waitUntil = this.host.clock.now() + SETUP_WAIT_MS;
            let result: RunResult | undefined;
            for (let attempt = 0; ; attempt++) {
                // CMSIS Solution's setup task first (#138): a re-run beside it would build from files it rewrites.
                const setup = await this.setupsEnded(turn, marks, waitUntil);
                // Decided with no wait left before the spawn, once the older re-runs have let go of the log.
                if (this.disposed) {
                    return skipped({ kind: 'spawn-failed', error: 'the extension shut down' });
                }
                if (turn !== this.turns || this.buildStarts !== marks.buildStarts) {
                    return skipped({ kind: 'superseded' });
                }
                if (this.stopRequests !== marks.stopRequests) {
                    return skipped({ kind: 'stopped' });
                }
                if (setup !== undefined || attempt > MAX_SETUP_RESTARTS) {
                    const name = setup ?? this.tracker.setupExecutions()[0]?.name ?? 'cbuild setup';
                    return skipped({ kind: 'setup-running', name, waited: formatDuration(this.host.clock.now() - (waitUntil - SETUP_WAIT_MS)) });
                }
                const other = this.otherBuild(decided.key);
                if (other) {
                    return skipped({ kind: 'build-running', name: other.name });
                }
                fs.mkdirSync(path.dirname(logFile), { recursive: true });
                fs.rmSync(logFile, { force: true });
                const args = cbuildDiagnosticArgs(definition, {
                    solution: where.solution, active, output: where.output, logFile, skipConvert: where.index !== undefined,
                });
                logger.info(`Build diagnosis: ${cbuild} ${args.join(' ')}`);
                result = await this.run(cbuild, args, env, where.cwd ?? solutionDir, decided.key, logFile);
                if (result.kind !== 'ended' || result.stop?.reason !== 'setup') {
                    break;
                }
                logger.info('Build diagnosis: a CMSIS Solution setup task started during the re-run; it runs again once the setup ended');
            }
            if (result.kind === 'spawn-failed') {
                return skipped({ kind: 'spawn-failed', error: result.error });
            }
            const stop = result.stop;
            // Superseded, it lets go at once: the log is the newer re-run's, never read, cut or marked by this one (#135).
            if (stop?.reason === 'superseded' || stop?.reason === 'setup') {
                return skipped({ kind: 'superseded' });
            }
            // After any other stop, the log as it was then: what follows in it is the stop's.
            const logged = stop ? logBeforeStop(logFile, stop.logBytes, stop.reason) : isFile(logFile) ? readBuildLog(logFile) : undefined;
            const printed = parseBuildLog(result.output, 'cbuild output');
            // The log is the record; cbuild's own output stands in when the log is missing or has no error.
            const summary: BuildLogSummary = logged && (logged.errors > 0 || printed.errors === 0) ? logged : printed;
            const { errors, warnings } = messagesFromLog(summary);
            const cause = stop?.reason === 'cap' || stop?.reason === 'request' ? stop.reason : undefined;
            const outcome: RerunOutcome = {
                exitCode: result.exitCode, ...(cause ? { stopped: cause } : {}), ...(summary.status ? { status: summary.status } : {}),
            };
            return {
                source: 'rerun', errors, warnings, errorCount: summary.errors, warningCount: summary.warnings,
                failedSteps: summary.failedSteps, csolutionWarnings, ...(where.index ? { idxFile: where.index } : {}),
                ...(logged ? { logFile } : {}), rerun: outcome,
            };
        });
    }

    /**
     * Run `work` once the re-run before it has let go of the log; the next
     * one waits until `work` has settled, however it ends. A re-run waiting
     * when the extension shuts down goes on at once, only to skip.
     */
    private async inLogTurn<T>(work: () => Promise<T>): Promise<T> {
        const previous = this.logTurn;
        let release: () => void = () => undefined;
        this.logTurn = new Promise<void>((resolve) => {
            release = resolve;
        });
        try {
            await Promise.race([previous, this.disposal]);
            return await work();
        } finally {
            release();
        }
    }

    /** A build, rebuild or clean other than the failed one that is alive; a setup is waited for instead (#138). */
    private otherBuild(ownKey: number): LiveExecution | undefined {
        return this.tracker.liveExecutions().find((execution) => BUILD_TASK_KINDS.has(execution.kind)
            && !SETUP_TASK_KINDS.has(execution.kind) && execution.key !== ownKey);
    }

    /**
     * Wait until no CMSIS Solution setup task is alive (#138), or until
     * something ends the wait: a build start, a newer re-run, stop_build or
     * the end of the extension (the caller tells which). Undefined when no
     * setup is alive any more or the wait was ended so; the name of the setup
     * still running when `until` came.
     */
    private async setupsEnded(turn: number, marks: RerunMarks, until: number): Promise<string | undefined> {
        for (;;) {
            const setups = this.tracker.setupExecutions();
            const interrupted = this.disposed || turn !== this.turns || this.buildStarts !== marks.buildStarts
                || this.stopRequests !== marks.stopRequests;
            if (setups.length === 0 || interrupted) {
                return undefined;
            }
            const left = until - this.host.clock.now();
            if (left <= 0) {
                return setups[setups.length - 1].name;
            }
            logger.info(`Build diagnosis: the re-run waits for '${setups[setups.length - 1].name}' to end`);
            let wake: () => void = () => undefined;
            const nudged = new Promise<void>((resolve) => {
                wake = resolve;
            });
            this.nudges.add(wake);
            try {
                await Promise.race([this.tracker.waitForEnd(setups.map((setup) => setup.execution), left), nudged]);
            } finally {
                this.nudges.delete(wake);
            }
        }
    }

    /** Wake the re-runs that wait for a setup task, so that they look again whether to go on. */
    private nudge(): void {
        for (const wake of [...this.nudges]) {
            wake();
        }
    }

    /**
     * Run cbuild under the cap; a build-type task that starts meanwhile stops
     * it. A stop notes how long `logFile` is at that moment and keeps no
     * more output: what follows is the stop's.
     */
    private run(command: string, args: string[], env: Record<string, string>, cwd: string, ownKey: number, logFile: string): Promise<RunResult> {
        return new Promise((resolve) => {
            const output = new OutputTail(OUTPUT_TAIL_BYTES);
            let stopped: RerunStop | undefined;
            let settled = false;
            let child: DiagnosticChild | undefined;
            let cancelCap: () => void = () => undefined;
            let cancelGrace: () => void = () => undefined;
            let watch: { dispose(): void } | undefined;
            const finish = (result: RunResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cancelCap();
                cancelGrace();
                watch?.dispose();
                this.running.delete(rerun);
                resolve(result);
            };
            const ended = (code: number | null): void => {
                finish({ kind: 'ended', exitCode: stopped ? null : code, output: output.text(), ...(stopped ? { stop: stopped } : {}) });
            };
            const rerun: RunningRerun = {
                stop: (reason) => {
                    if (settled || stopped || !child) {
                        return;
                    }
                    // Before the kill: from here on ninja and cbuild print the stop itself, not the build.
                    output.close();
                    stopped = { reason, logBytes: sizeOf(logFile) };
                    logger.info(`Build diagnosis: stopping the re-run (${reason})`);
                    try {
                        this.host.killTree(child);
                    } catch (caught) {
                        logger.warn('Build diagnosis: the re-run could not be killed', caught);
                    }
                    cancelGrace = this.host.clock.startTimer(KILL_GRACE_MS, () => ended(null));
                },
            };
            try {
                child = this.host.spawn(command, args, {
                    cwd, env, shell: false, windowsHide: true, detached: this.host.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
                });
            } catch (caught) {
                finish({ kind: 'spawn-failed', error: messageOf(caught) });
                return;
            }
            child.stdout?.on('data', (chunk: unknown) => output.add(chunk));
            child.stderr?.on('data', (chunk: unknown) => output.add(chunk));
            child.on('error', (error: Error) => {
                // Without a pid it never started; a later error (a failed kill) waits for `close`.
                if (child?.pid === undefined) {
                    finish({ kind: 'spawn-failed', error: error.message });
                }
            });
            child.on('close', (code: number | null) => ended(code));
            this.running.add(rerun);
            cancelCap = this.host.clock.startTimer(DIAGNOSTIC_RERUN_CAP_MS, () => rerun.stop('cap'));
            watch = this.tracker.onDidStartExecution((execution) => {
                if (BUILD_TASK_KINDS.has(execution.kind) && execution.key !== ownKey) {
                    // A setup of CMSIS Solution is no newer build (#138): the re-run makes way for it and runs again after it.
                    rerun.stop(SETUP_TASK_KINDS.has(execution.kind) ? 'setup' : 'superseded');
                }
            });
        });
    }
}

/** Give the tracker's failed builds their error lines; `stopFollowUps` stops the re-runs; the result stops the listeners and any re-run. */
export function attachBuildDiagnosis(tracker: CmsisJobTracker, host: DiagnosisHost): { dispose(): void } {
    const runner = new BuildDiagnosisRunner(tracker, host);
    const finished = tracker.onDidFinishJob((job) => runner.onFinished(job));
    const started = tracker.onDidStartExecution((execution) => runner.onStarted(execution));
    const stopRequested = tracker.onDidRequestFollowUpStop(() => runner.stopAll());
    return {
        dispose: () => {
            finished.dispose();
            started.dispose();
            stopRequested.dispose();
            runner.dispose();
        },
    };
}

// ── The real host ───────────────────────────────────────────────────────────

/** A CMSIS Solution query's answer, read by `interpret`; undefined when it fails or is slow. Never throws. */
async function askFor(command: string, interpret: (answer: unknown) => string | undefined): Promise<string | undefined> {
    try {
        return interpret(await withTimeout(command, QUERY_MS, () => Promise.resolve(vscode.commands.executeCommand<unknown>(command))));
    } catch {
        return undefined;
    }
}

/** End `child` and its descendants: `taskkill /T` on Windows, its process group elsewhere. */
function killProcessTree(child: DiagnosticChild, platform: NodeJS.Platform): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (platform === 'win32') {
        const killer = spawnProcess('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        return;
    }
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
    const hard = setTimeout(() => {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            // The group has gone.
        }
    }, 2_000);
    hard.unref();
}

/** VS Code, Node's processes and this extension host's environment. Reads nothing until a build fails. */
export function vscodeDiagnosisHost(clock: TrackerClock): DiagnosisHost {
    return {
        rerunEnabled: () => vscode.workspace.getConfiguration('cmsis-developer-assistant').get<boolean>('build.diagnosticRerun', true) !== false,
        solutionFile: () => askFor('cmsis-csolution.getSolutionFile', solutionFileOf),
        activeTarget: () => askFor('cmsis-csolution.getActiveTargetSet', activeTargetSetOf),
        outputDirectorySetting: () => {
            const value: unknown = vscode.workspace.getConfiguration('cmsis-csolution').get<unknown>('outputDirectory');
            return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
        },
        packRoot: () => effectiveToolchainPackRoot(),
        workingDirectory: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        baseEnvironment: () => process.env,
        platform: process.platform,
        spawn: (command, args, options) => spawnProcess(command, [...args], options),
        killTree: (child) => killProcessTree(child, process.platform),
        clock,
        knownMessageLines,
    };
}
