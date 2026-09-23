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
 * live in `src/core/flashController.ts`.
 *
 * Refused while a debug session, a CMSIS Run task, a Load or Erase, or
 * another `flash` holds the probe (#46), since programming then wedges the
 * probe or waits for it forever. The pyOCD is the one the CMSIS tasks use:
 * the CMSIS Debugger's bundled one first (#45). Refusals and failures reject
 * with a `ToolError`; a pyOCD run that was killed at the budget answers with
 * status `timeout` (#11). The budget may run to 600 s (#12) and is counted
 * from the call, so the file and pyOCD lookups come out of it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { guardProbe } from '../core/cmsisTasks';
import { fileExists, FlashResult, flashWithPyocd, probePyocd, PyocdCandidate, resolvePyocd } from '../core/flashController';
import { parseCbuildRun } from '../core/packDocs/cbuildRun';
import { ToolError, ToolText } from '../core/toolResult';
import { LONG_LIMIT_CAP_MS } from './fence';
import type { HandlerHost } from './host';
import { probeRefusal } from './jobText';

/** Programming budget and fence default without a `timeoutMs`. */
const DEFAULT_FLASH_MS = 60_000;
/** Kept back from the budget so the tool answers before its fence. */
const FENCE_MARGIN_MS = 1_500;
/** The CMSIS Debugger extension, which bundles pyOCD under `tools/pyocd`. */
const CMSIS_DEBUGGER_ID = 'Arm.vscode-cmsis-debugger';

/** What the fence answers if the tool itself does not answer in time. */
export const FLASH_FENCE_ADVICE = 'pyOCD may still be programming the target; flash answers PROBE_BUSY until it has ended — '
    + 'do not start it again, and do not run pyOCD yourself.';

/** The file to program, or why there is none (with what to do about it, where that is not in the sentence). */
type CbuildRunChoice = { file: string } | { problem: string; hint?: string };

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
 * first workspace folder), else launch.json's `cmsis.cbuildRunFile`, else the
 * only `out/**` match. Only the first workspace folder is consulted.
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
        return { problem: 'No workspace folder open and no cbuildRunFile argument given — cannot resolve what to flash.' };
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

/** A runnable pyOCD, with its version and where it came from. */
interface FoundPyocd extends PyocdCandidate {
    version: string;
}

/** The first pyOCD that answers `--version`, in lookup order; the ones that did not are reported. */
async function findPyocd(cbuildRunFile: string, host: HandlerHost): Promise<{ found?: FoundPyocd; unusable: string[] }> {
    const environment = host.toolEnvironment();
    const debuggerExtension = environment.extension(CMSIS_DEBUGGER_ID);
    const candidates = resolvePyocd({
        debuggerExtensionPath: debuggerExtension?.path,
        debuggerVersion: debuggerExtension?.version,
        toolsEnvironmentYml: toolsEnvironment(cbuildRunFile, host),
        platform: environment.platform,
        pathEnv: environment.pathEnv,
    });
    const unusable: string[] = [];
    for (const candidate of candidates) {
        const version = await probePyocd(candidate.bin);
        if (version) {
            return { found: { ...candidate, version }, unusable };
        }
        unusable.push(candidate.bin);
    }
    return { unusable };
}

/** The outcome of a pyOCD run: success as text, a killed run as status `timeout`, a failed one as `TASK_FAILED`. */
function describeFlash(result: FlashResult, budgetMs: number, version: string): ToolText {
    if (result.timedOut) {
        return {
            text: `Flash timed out after ${Math.round(budgetMs / 1000)} s — the pyOCD process was killed.\n`
                + `Output tail:\n  ${tailBlock(result.outputTail)}\n`
                + 'Retry, or investigate why programming stalls (probe connection, target held in reset).',
            status: 'timeout',
        };
    }
    if (result.ok) {
        const amount = result.programmedBytes !== null ? ` — programmed ${result.programmedBytes} bytes` : '';
        const rate = result.kbps !== null ? ` at ${result.kbps} kB/s` : '';
        return `✅ Flash succeeded${amount}${rate} (pyOCD ${version}: \`${result.commandLine}\`). `
            + 'Use cmsis_action attach or load_and_debug to start a debug session.';
    }
    const errors = result.errorLines.length > 0 ? `Errors:\n  ${result.errorLines.join('\n  ')}\n` : '';
    throw new ToolError('TASK_FAILED',
        `❌ Flash FAILED (exit ${result.exitCode ?? 'unknown'}) — \`${result.commandLine}\`\n`
            + `${errors}Output tail:\n  ${tailBlock(result.outputTail)}`,
        'This is a terminal result — fix the cause and re-run flash.');
}

/** The wait of a `flash` call: `timeoutMs` when positive (at most 600 s), else 60 s. */
export function flashTimeoutMs(timeoutMs: number | undefined): number {
    return typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, LONG_LIMIT_CAP_MS) : DEFAULT_FLASH_MS;
}

/** The body of `flash`, run inside the handler's fence; `waitMs` counts from the call. */
export async function runFlash(
    executor: IDebuggingExecutor,
    host: HandlerHost,
    request: { cbuildRunFile?: string; timeoutMs?: number },
    waitMs: number = flashTimeoutMs(request.timeoutMs),
): Promise<ToolText> {
    const deadline = host.now() + waitMs;
    if (executor.hasDebugSession()) {
        throw new ToolError('PROBE_BUSY',
            'Refusing to flash while a debug session is active — programming under a live session wedges most probes.',
            'Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.');
    }
    const tracker = host.cmsisJobs();
    const verdict = guardProbe('flash', tracker.probeOwners(), false);
    if (!verdict.allowed) {
        throw probeRefusal('flash', '', verdict, host.now());
    }
    const choice = await chooseCbuildRun(request.cbuildRunFile, host);
    if ('problem' in choice) {
        throw new ToolError('INVALID_ARGUMENT', choice.problem, choice.hint);
    }
    const pyocd = await findPyocd(choice.file, host);
    if (!pyocd.found) {
        const tried = pyocd.unusable.length > 0 ? ` (found, but it did not run: ${pyocd.unusable.join(', ')})` : '';
        throw new ToolError('TOOL_DISABLED',
            `pyOCD not found: it ships with the CMSIS Debugger extension (${CMSIS_DEBUGGER_ID}), and neither the solution's `
                + `.cmsis/tools-environment.yml nor PATH names another one${tried}.`,
            'Install or enable the CMSIS Debugger extension, or use cmsis_action load, which flashes through the CMSIS Solution '
                + 'extension. Do not install pyOCD yourself.');
    }
    const release = tracker.beginFlash();
    try {
        const budgetMs = Math.max(deadline - host.now() - FENCE_MARGIN_MS, 1_000);
        const result = await flashWithPyocd(choice.file, budgetMs, { bin: pyocd.found.bin });
        return describeFlash(result, budgetMs, `${pyocd.found.version} from ${pyocd.found.from}`);
    } finally {
        release();
    }
}
