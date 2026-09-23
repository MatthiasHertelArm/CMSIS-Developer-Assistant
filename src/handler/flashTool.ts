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
 * pointing at an output channel. The process handling lives in
 * `src/core/flashController.ts`.
 *
 * Refused under a live debug session, since programming then wedges most
 * probes. Like `cmsis_action` it does not see a CMSIS Run task holding the
 * probe (KB4). Refusals and failures reject with a `ToolError`; a pyOCD run
 * that was killed at the budget answers with status `timeout` (#11).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { parse } from 'jsonc-parser';
import type { IDebuggingExecutor } from '../debuggingExecutor';
import { fileExists, FlashResult, flashWithPyocd, probePyocd } from '../core/flashController';
import { ToolError, ToolText } from '../core/toolResult';
import type { HandlerHost } from './host';

/** Programming budget and fence default without a `timeoutMs`. */
const DEFAULT_FLASH_MS = 60_000;
/** Kept back from the budget so the tool answers before its fence. */
const FENCE_MARGIN_MS = 1_500;

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

/** The fence timeout of a `flash` call. */
export function flashTimeoutMs(timeoutMs: number | undefined): number {
    return timeoutMs ?? DEFAULT_FLASH_MS;
}

/** The body of `flash`, run inside the handler's fence. */
export async function runFlash(
    executor: IDebuggingExecutor,
    host: HandlerHost,
    request: { cbuildRunFile?: string; timeoutMs?: number },
): Promise<ToolText> {
    if (executor.hasDebugSession()) {
        throw new ToolError('PROBE_BUSY',
            'Refusing to flash while a debug session is active — programming under a live session wedges most probes.',
            'Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.');
    }
    const choice = await chooseCbuildRun(request.cbuildRunFile, host);
    if ('problem' in choice) {
        throw new ToolError('INVALID_ARGUMENT', choice.problem, choice.hint);
    }
    const version = await probePyocd();
    if (!version) {
        throw new ToolError('TASK_FAILED', 'pyocd not found on PATH.',
            'Install it (pip install pyocd / pipx install pyocd), '
                + 'or use cmsis_action load, which drives the CMSIS Solution extension\'s own flash pipeline.');
    }
    const budgetMs = Math.max(flashTimeoutMs(request.timeoutMs) - FENCE_MARGIN_MS, 1_000);
    return describeFlash(await flashWithPyocd(choice.file, budgetMs), budgetMs, version);
}
