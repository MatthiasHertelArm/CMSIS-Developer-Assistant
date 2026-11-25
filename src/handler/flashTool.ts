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
 * The `flash` tool: pick the `*.cbuild-run.yml` to program and run
 * `pyocd load` on it, reporting bytes, rate and the failure lines instead of
 * pointing at an output channel. The process handling and the pyOCD lookup
 * live in `src/core/flashController.ts`. pyOCD's exit status decides; a
 * success lists the warnings pyOCD logged, and is ⚠️ when it could not add
 * part of the image, since the target then does not hold the image as built.
 *
 * Refused while a debug session, a CMSIS Run task, a Load or Erase, or
 * another `flash` holds the probe (#46), since programming then wedges the
 * probe or waits for it forever. The pyOCD is the one the CMSIS tasks use:
 * the CMSIS Debugger's bundled one first (#45). The probe is the one
 * CMSIS Solution's CMSIS Load task selects: `--probe` by the debug adapter
 * the cbuild-run file names, `--uid` by its probe ID or the setting
 * `cmsis-csolution.probe-id`; several probes and none selected is
 * `TASK_FAILED` naming them, since pyOCD then chooses none. Refusals and
 * failures reject with a `ToolError`; a pyOCD run that was killed at the
 * budget answers with status `timeout` (#11). The budget may run to 600 s
 * (#12) and is counted from the call, so the file and pyOCD lookups come
 * out of it: when they leave less than `MIN_PROGRAM_MS`, nothing is
 * programmed and the answer says so, also with status `timeout`. The call
 * holds the probe from its guard on, lookups included, so a second `flash`
 * is refused whenever it comes; a pyOCD that is starting when the wait ends
 * is let finish its start under that mark, and no further one is tried.
 * Without a folder open and without a named file the refusal is
 * `NO_WORKSPACE`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { guardProbe } from '../core/cmsisTasks';
import {
    fileExists, FlashResult, flashWithPyocd, ProbeSelection, probePyocd, PyocdCandidate, pyocdProbeType, resolvePyocd,
} from '../core/flashController';
import { cbuildRunDebugger, cbuildRunProbeId, parseCbuildRun } from '../core/packDocs/cbuildRun';
import { noWorkspaceRefusal } from '../core/bootstrapState';
import { ToolError, ToolText } from '../core/toolResult';
import { apiToolsEnvironment } from '../utils/solutionQueries';
import { LONG_LIMIT_CAP_MS } from './fence';
import type { HandlerHost } from './host';
import { formatDuration, probeRefusal } from './jobText';

/** Programming budget and fence default without a `timeoutMs`. */
const DEFAULT_FLASH_MS = 60_000;
/** Kept back from the budget so the tool answers before its fence. */
export const FENCE_MARGIN_MS = 1_500;
/**
 * The least budget programming is started with: a pyOCD killed sooner than that would stop while it connects or
 * erases. With the margin above it is why the tool takes no `timeoutMs` under `FLASH_MIN_WAIT_MS`.
 */
export const MIN_PROGRAM_MS = 1_000;
/** The CMSIS Debugger extension, which bundles pyOCD under `tools/pyocd`. */
const CMSIS_DEBUGGER_ID = 'Arm.vscode-cmsis-debugger';

/** What the fence answers if the tool itself does not answer in time. */
export const FLASH_FENCE_ADVICE = 'The call may still be at work: it looks for pyOCD, whose first start can take a minute, or pyOCD is ending. '
    + 'It starts no programming after its wait, and flash answers PROBE_BUSY until it has ended — call flash again then, and do not run '
    + 'pyOCD yourself.';

/** The file to program, or why there is none (with what to do about it, where that is not in the sentence). */
type CbuildRunChoice = { file: string } | { problem: string; hint?: string } | { noWorkspace: true };

/** The `cmsis.cbuildRunFile` of the first launch configuration whose file exists. */
async function cbuildRunFromLaunchJson(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    try {
        const launchJson = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json'));
        const configurations: unknown = parse(launchJson.getText())?.configurations;
        if (!Array.isArray(configurations)) {
            return undefined;
        }
        for (const configuration of configurations) {
            const named: unknown = configuration?.cmsis?.cbuildRunFile;
            if (typeof named !== 'string' || named.length === 0 || named.includes('${command:')) {
                continue;
            }
            const candidate = path.isAbsolute(named) ? named : path.join(folder.uri.fsPath, named);
            if (fileExists(candidate)) {
                return candidate;
            }
        }
    } catch {
        // No readable launch.json: the out/ search below decides.
    }
    return undefined;
}

/**
 * The cbuild-run file to program: the explicit argument (relative to the
 * first workspace folder), else the one of the CMSIS Solution extension's
 * active target when that file exists, else launch.json's
 * `cmsis.cbuildRunFile`, else the only `out/**` match. Only the first
 * workspace folder is consulted.
 */
async function chooseCbuildRun(requested: string | undefined, host: HandlerHost): Promise<CbuildRunChoice> {
    const folder = host.workspaceFolders()[0];
    if (requested) {
        let file = requested;
        if (!path.isAbsolute(requested) && folder) {
            file = path.join(folder.uri.fsPath, requested);
        }
        return fileExists(file)
            ? { file }
            : { problem: `cbuild-run file not found: ${file}.`, hint: 'Pass an existing path, or omit cbuildRunFile to auto-resolve from launch.json / out/.' };
    }
    if (!folder) {
        return { noWorkspace: true };
    }
    const active = await host.activeCbuildRunFile();
    if (active && fileExists(active)) {
        return { file: active };
    }
    const fromLaunch = await cbuildRunFromLaunchJson(folder);
    if (fromLaunch) {
        return { file: fromLaunch };
    }
    const matches = await host.findFiles('out/**/*.cbuild-run.yml', '**/node_modules/**', 10);
    if (matches.length === 1) {
        return { file: matches[0].fsPath };
    }
    if (matches.length > 1) {
        return {
            problem: `Found ${matches.length} cbuild-run files under out/ — pass cbuildRunFile explicitly:\n  `
                + matches.map((uri) => uri.fsPath).join('\n  '),
        };
    }
    return {
        problem: 'No cbuild-run file found (launch.json has no resolvable cmsis.cbuildRunFile and out/ has none).',
        hint: 'Build first (cmsis_action build), or pass cbuildRunFile explicitly.',
    };
}

function tailBlock(lines: string[]): string {
    return lines.length > 0 ? lines.join('\n  ') : '<no output>';
}

/**
 * The text of the solution's `.cmsis/tools-environment.yml`: next to the
 * csolution the cbuild-run file names, else in the first workspace folder.
 */
function toolsEnvironment(cbuildRunFile: string, host: HandlerHost): string | undefined {
    const places: string[] = [];
    try {
        const solution = parseCbuildRun(fs.readFileSync(cbuildRunFile, 'utf8'), cbuildRunFile).solution;
        if (solution) {
            places.push(path.dirname(path.resolve(path.dirname(cbuildRunFile), solution)));
        }
    } catch {
        // No readable cbuild-run: the workspace folder is the only guess.
    }
    const folder = host.workspaceFolders()[0];
    if (folder) {
        places.push(folder.uri.fsPath);
    }
    for (const place of places) {
        try {
            return fs.readFileSync(path.join(place, '.cmsis', 'tools-environment.yml'), 'utf8');
        } catch {
            // Not there; try the next place.
        }
    }
    return undefined;
}

/** The usual wait for `pyocd --version`. */
const PYOCD_PROBE_MS = 5_000;
/** The wait for a pyOCD that did not answer in time, as on its first start after an install. */
const PYOCD_FIRST_START_MS = 60_000;

/** A runnable pyOCD, with its version and where it came from. */
interface FoundPyocd extends PyocdCandidate {
    version: string;
}

/**
 * The first pyOCD that answers `--version`, in lookup order; the ones that
 * did not are reported. Once `deadline` has passed no further candidate is
 * started (`untried` counts them): the call can program nothing any more. A
 * start that is under way then is let finish, so that the next call finds
 * that pyOCD started.
 */
async function findPyocd(cbuildRunFile: string, host: HandlerHost, deadline: number): Promise<{ found?: FoundPyocd; unusable: string[]; untried: number }> {
    const environment = host.toolEnvironment();
    const waits = environment.pyocdStartMs ?? { usual: PYOCD_PROBE_MS, first: PYOCD_FIRST_START_MS };
    const debuggerExtension = environment.extension(CMSIS_DEBUGGER_ID);
    const candidates = resolvePyocd({
        debuggerExtensionPath: debuggerExtension?.path,
        debuggerVersion: debuggerExtension?.version,
        // A solution never converted has no file: the API's environment of the window stands in (2.9.1 phase 4.3).
        toolsEnvironmentYml: toolsEnvironment(cbuildRunFile, host) ?? await apiToolsEnvironment(),
        platform: environment.platform,
        pathEnv: environment.pathEnv,
    });
    const unusable: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
        if (host.now() >= deadline) {
            return { unusable, untried: candidates.length - index };
        }
        const started = Date.now();
        let version = await probePyocd(candidate.bin, waits.usual);
        if (!version && Date.now() - started >= waits.usual) {
            // The first start of a freshly installed pyOCD on macOS (Gatekeeper's check, the bundle unpacking) can take
            // longer than a usual answer: a probe that ran out of time gets one longer wait before it counts as unusable.
            version = await probePyocd(candidate.bin, waits.first);
        }
        if (version) {
            return { found: { ...candidate, version }, unusable, untried: 0 };
        }
        unusable.push(candidate.bin);
    }
    return { unusable, untried: 0 };
}

/**
 * The probe to program, selected as CMSIS Solution 1.72.0 selects it for
 * its CMSIS tasks: the probe type of the debug adapter the cbuild-run
 * file's `debugger:` names, and the probe ID of that node (csolution writes
 * the target set's there), else of the setting `cmsis-csolution.probe-id`.
 */
function probeSelection(cbuildRunFile: string, host: HandlerHost): ProbeSelection {
    let content = '';
    try {
        content = fs.readFileSync(cbuildRunFile, 'utf8');
    } catch {
        // Unreadable here: pyOCD reports it, and no selection comes from it.
    }
    const type = pyocdProbeType(cbuildRunDebugger(content));
    const listed = cbuildRunProbeId(content);
    if (listed) {
        return { type, uid: listed, uidFrom: 'cbuild-run' };
    }
    const configured = host.solutionProbeId();
    return configured ? { type, uid: configured, uidFrom: 'setting' } : { type };
}

/** The probe ID with where it came from, as the results quote it. */
function probeIdText(probe: ProbeSelection): string {
    const from = probe.uidFrom === 'cbuild-run' ? 'the probe-id of the cbuild-run file\'s debugger' : 'the setting cmsis-csolution.probe-id';
    return `'${probe.uid}' (${from})`;
}

/** Where the user sets the probe ID: the place this one came from; the setting when there is none. */
function probeIdPlace(probe: ProbeSelection): string {
    return probe.uidFrom === 'cbuild-run'
        ? 'probe-id under debugger: of the target set in the csolution, which cmsis_action build writes into the cbuild-run file'
        : 'the setting cmsis-csolution.probe-id';
}

/** pyOCD's answer with `--no-wait` when it finds no free probe. */
const NO_PROBE = /No (?:connected|available) debug probe/i;

/** What a probe pyOCD cannot see means (#81): a serial port of the board does not prove that its probe is reachable. */
const NO_PROBE_HINT = 'pyOCD sees no free debug probe. Another task or session may hold it: cmsis_action {action:\'status\'} lists '
    + 'this window\'s CMSIS tasks, stop_run or stop_debugging frees it. Otherwise the board is not connected or its probe lacks the USB '
    + 'driver: ask the user to check the cable and the driver — a serial port in serial_list_ports does not prove that the probe is reachable. '
    + 'Do not retry until one of these changed.';

/** `NO_PROBE_HINT`, or with a probe ID: then that probe may be gone, or the ID names another one. */
function noProbeHint(probe: ProbeSelection): string {
    if (!probe.uid) {
        return NO_PROBE_HINT;
    }
    return `pyOCD sees no free debug probe whose unique ID contains ${probeIdText(probe)}. Another task or session may hold it: `
        + 'cmsis_action {action:\'status\'} lists this window\'s CMSIS tasks, stop_run or stop_debugging frees it. Otherwise that probe is '
        + `not connected or lacks its USB driver, or the ID names another one: ask the user to check the cable, the driver and ${probeIdPlace(probe)} `
        + '— a serial port in serial_list_ports does not prove that the probe is reachable. Do not retry until one of these changed.';
}

/** pyOCD listed several probes for the selection and chose none: the refusal names them and where the user picks one. */
function severalProbes(result: FlashResult, probe: ProbeSelection): ToolError {
    const scope = probe.uid ? ` whose unique ID contains ${probeIdText(probe)}` : probe.type ? ` of the type ${probe.type.replace(/:$/, '')}` : '';
    return new ToolError('TASK_FAILED',
        `❌ Flash FAILED (exit ${result.exitCode ?? 'unknown'}) — \`${result.commandLine}\`\n`
            + `pyOCD found ${result.probeChoices.length} debug probes${scope} and chose none:\n  `
            + result.probeChoices.map((listed) => `${listed.uid} (${listed.description})`).join('\n  '),
        `Ask the user which of them is connected to the board to program, and to set its unique ID in ${probeIdPlace(probe)}; `
            + 'CMSIS Solution\'s Load, Run and Debug select the probe by it as well. Then call flash again; do not choose a probe yourself.');
}

/**
 * A run that exited 0: ✅ with what pyOCD warned of, or ⚠️ when it could not
 * add data chunks of the image, which it then leaves out or overlaps, so
 * that the target does not hold the image as built.
 */
function describeSuccess(result: FlashResult, version: string): string {
    const amount = result.programmedBytes !== null ? ` — programmed ${result.programmedBytes} bytes` : '';
    const rate = result.kbps !== null ? ` at ${result.kbps} kB/s` : '';
    const run = `${amount}${rate} (pyOCD ${version}: \`${result.commandLine}\`).`;
    const next = 'Use cmsis_action attach or load_and_debug to start a debug session.';
    const warned = [...result.errorLines, ...result.warningLines];
    if (warned.length === 0) {
        return `✅ Flash succeeded${run} ${next}`;
    }
    const list = `\npyOCD warned:\n  ${warned.join('\n  ')}\n`;
    if (result.droppedChunks === 0) {
        return `✅ Flash succeeded${run}${list}${next}`;
    }
    const chunks = result.droppedChunks === 1 ? 'a data chunk' : `${result.droppedChunks} data chunks`;
    return `⚠️ Flash exited 0, but pyOCD could not add ${chunks} of the image${run}${list}`
        + 'So the target does not hold the image as built. Check which sections load at the addresses pyOCD names, for example with '
        + `get_section_layout or lookup_symbol {address}, before you debug it. ${next}`;
}

/**
 * The outcome of a pyOCD run: success as text (`describeSuccess`), a killed
 * run as status `timeout`, a failed one as `TASK_FAILED`, with the probes
 * pyOCD listed when it chose none.
 */
function describeFlash(result: FlashResult, budgetMs: number, version: string, probe: ProbeSelection): ToolText {
    if (result.timedOut) {
        return {
            text: `Flash timed out after ${Math.round(budgetMs / 1000)} s — the pyOCD process was killed.\n`
                + `Output tail:\n  ${tailBlock(result.outputTail)}\n`
                + 'Retry, or investigate why programming stalls (probe connection, target held in reset).',
            status: 'timeout',
        };
    }
    if (result.ok) {
        return describeSuccess(result, version);
    }
    if (result.probeChoices.length > 1) {
        throw severalProbes(result, probe);
    }
    const errors = result.errorLines.length > 0 ? `Errors:\n  ${result.errorLines.join('\n  ')}\n` : '';
    const noProbe = result.outputTail.some((line) => NO_PROBE.test(line));
    throw new ToolError('TASK_FAILED',
        `❌ Flash FAILED (exit ${result.exitCode ?? 'unknown'}) — \`${result.commandLine}\`\n`
            + `${errors}Output tail:\n  ${tailBlock(result.outputTail)}`,
        noProbe ? noProbeHint(probe) : 'This is a terminal result — fix the cause and re-run flash.');
}

/** The wait of a `flash` call: `timeoutMs` when positive (at most 600 s), else 60 s. */
export function flashTimeoutMs(timeoutMs: number | undefined): number {
    return typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, LONG_LIMIT_CAP_MS) : DEFAULT_FLASH_MS;
}

/** Programming under a live debug session wedges most probes: refused. */
function refuseUnderSession(executor: IDebuggingExecutor): void {
    if (executor.hasDebugSession()) {
        throw new ToolError('PROBE_BUSY',
            'Refusing to flash while a debug session is active — programming under a live session wedges most probes.',
            'Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.');
    }
}

/** The answer of a call whose lookups left no time to program: pyOCD was not started on the target. */
function notStarted(waitMs: number, tookMs: number, found: boolean): ToolText {
    return {
        text: `Flash not started — nothing was programmed. Finding the cbuild-run file and pyOCD took ${formatDuration(tookMs)} of the `
            + `${formatDuration(waitMs)} wait, ${found ? 'which leaves too little time to program' : 'and pyOCD had not answered by then'}. `
            + 'The first start of a newly installed pyOCD can take a minute. Call flash again, with a larger timeoutMs if this happens '
            + 'again; do not run pyOCD yourself.',
        status: 'timeout',
    };
}

/** The body of `flash`, run inside the handler's fence; `waitMs` counts from the call. */
export async function runFlash(
    executor: IDebuggingExecutor,
    host: HandlerHost,
    request: { cbuildRunFile?: string; timeoutMs?: number },
    waitMs: number = flashTimeoutMs(request.timeoutMs),
): Promise<ToolText> {
    const called = host.now();
    const deadline = called + waitMs;
    refuseUnderSession(executor);
    const tracker = host.cmsisJobs();
    const verdict = guardProbe('flash', tracker.probeOwners(), false);
    if (!verdict.allowed) {
        throw probeRefusal('flash', '', verdict, host.now());
    }
    // The probe is this call's from here on, before the first await: a second flash that comes while the file and
    // pyOCD are looked up is refused like one that comes while pyOCD programs.
    const release = tracker.beginFlash();
    try {
        const choice = await chooseCbuildRun(request.cbuildRunFile, host);
        if ('noWorkspace' in choice) {
            // No folder and no file named: the same refusal as cmsis_action's, with the way to open a project.
            throw noWorkspaceRefusal('flash');
        }
        if ('problem' in choice) {
            throw new ToolError('INVALID_ARGUMENT', choice.problem, choice.hint);
        }
        const pyocd = await findPyocd(choice.file, host, deadline);
        if (!pyocd.found && pyocd.untried === 0) {
            const tried = pyocd.unusable.length > 0 ? ` (found, but it did not run: ${pyocd.unusable.join(', ')})` : '';
            throw new ToolError('TOOL_DISABLED',
                `pyOCD not found: it ships with the CMSIS Debugger extension (${CMSIS_DEBUGGER_ID}), and neither the solution's `
                    + `.cmsis/tools-environment.yml nor PATH names another one${tried}.`,
                'Install or enable the CMSIS Debugger extension, or use cmsis_action load, which flashes through the CMSIS Solution '
                    + 'extension. Do not install pyOCD yourself.');
        }
        // The lookups came out of the wait. What is left may be nothing: the fence has answered by then, or is about
        // to, and a pyOCD started now would be killed while it connects or erases.
        const budgetMs = deadline - host.now() - FENCE_MARGIN_MS;
        if (!pyocd.found || budgetMs < MIN_PROGRAM_MS) {
            return notStarted(waitMs, host.now() - called, pyocd.found !== undefined);
        }
        // A session may have started while pyOCD was looked up.
        refuseUnderSession(executor);
        const probe = probeSelection(choice.file, host);
        const result = await flashWithPyocd(choice.file, budgetMs, { bin: pyocd.found.bin, probe });
        return describeFlash(result, budgetMs, `${pyocd.found.version} from ${pyocd.found.from}`, probe);
    } finally {
        release();
    }
}
