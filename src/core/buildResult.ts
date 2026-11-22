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
 * The result CMSIS Solution captures for a build task (#140): cbuild's exit
 * code and everything the task wrote to its terminal, which API version 3
 * hands out as `getBuildResult(execution)`. With it a build needs no check
 * of its images and no second run of cbuild: the exit code is cbuild's own,
 * and the output is the original one, warnings of a successful build
 * included.
 *
 * This module holds what needs no editor: the shape of the result, the
 * terminal text turned into the lines of a log, and where that log goes.
 * `src/cmsisBuildDiagnosis.ts` asks for the result and makes the job's
 * diagnosis from it.
 *
 * Measured on CMSIS Solution 1.72.1-115 (2026-11-18): the result settles
 * with the task's end event; cbuild's own lines end in CR LF, those of the
 * tools under it in CR CR LF; ninja redraws its progress line with a bare CR
 * and `ESC[K`; compilers colour their diagnostics. A stopped build has no
 * exit code and ends in `^C`.
 *
 * Pure: no vscode.
 */

/** What `getBuildResult` answers, as far as this extension reads it. */
export interface CapturedBuildResult {
    /** The runner's exit code: cbuild's, or a negative toolbox error. Absent for a build that was skipped or stopped. */
    exitCode?: number;
    /** The task's terminal output, in order, formatting included. */
    output: string;
}

/** How long a captured result may take to settle after its task ended, before the build is checked the old way. */
export const RESULT_FENCE_MS = 10_000;

/** What is read of a captured output, the end of it, as `readBuildLog` reads a log: the failure and the summary are there. */
export const RESULT_OUTPUT_MAX_CHARS = 16 * 1024 * 1024;

/** The first line of an output whose beginning was left out. */
export const RESULT_OUTPUT_CUT = '[cmsis-developer-assistant] The output was longer than 16 MB: its beginning is left out.';

/** The folder of the logs this extension writes, under the solution's folder; with forward slashes on every platform. */
export const RESULT_LOG_FOLDER = 'out/cmsis-developer-assistant';

/** CSI sequences (colours, `ESC[K`) and OSC sequences (titles, shell integration). */
const CONTROL_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** `value` as a captured result; undefined when it is none: no text, or an exit code that is no number. */
export function capturedResultOf(value: unknown): CapturedBuildResult | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const { exitCode, output } = value as { exitCode?: unknown; output?: unknown };
    if (typeof output !== 'string' || (exitCode !== undefined && typeof exitCode !== 'number')) {
        return undefined;
    }
    return exitCode === undefined ? { output } : { exitCode, output };
}

/**
 * The terminal output of a build as the lines of a log: control sequences
 * removed, every line ending a plain LF, and each state of a line that a
 * bare CR redrew (ninja's progress) on a line of its own, without the states
 * it redrew unchanged. A line the build printed twice, each ended by a line
 * feed, stays twice: the count of a diagnostic is read from the log. Ends
 * with a line feed unless it is empty. Of an output longer
 * than `RESULT_OUTPUT_MAX_CHARS` only the end is kept, from a line's start,
 * under a line that says so.
 */
export function cleanBuildOutput(output: string): string {
    const lines: string[] = [];
    let text = output;
    if (text.length > RESULT_OUTPUT_MAX_CHARS) {
        const tail = text.slice(text.length - RESULT_OUTPUT_MAX_CHARS);
        const lineStart = tail.indexOf('\n');
        text = tail.slice(lineStart + 1);
        lines.push(RESULT_OUTPUT_CUT);
    }
    for (const raw of text.replace(CONTROL_SEQUENCES, '').split(/\r*\n/)) {
        const states = raw.split('\r').map((state) => state.trimEnd()).filter((state) => state.length > 0);
        if (states.length === 0) {
            // A blank line stays one; the blank a CR-first line leaves does not.
            if (raw.length === 0) {
                lines.push('');
            }
            continue;
        }
        // A repeat is a state a bare CR redrew unchanged; an equal line after a line feed was printed twice and stays.
        let previous: string | undefined;
        for (const state of states) {
            if (state !== previous) {
                lines.push(state);
            }
            previous = state;
        }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * The log of a build's captured output, relative to the solution's folder:
 * one file per target set, which the next build of that target set
 * overwrites. A target name keeps its letters, digits and `@ + . _ -`.
 */
export function resultLogPath(target: string | undefined): string {
    const safe = (target ?? '').replace(/[^A-Za-z0-9@+._-]/g, '_').replace(/^\.+/, '');
    // `build-diagnostic.log` is the diagnostic re-run's.
    const name = safe === 'diagnostic' ? 'diagnostic_' : safe;
    return `${RESULT_LOG_FOLDER}/${name.length > 0 ? `build-${name}` : 'build'}.log`;
}

/**
 * Whether `file` is the captured log of `targetType`: of the target type
 * itself (`build-<type>.log`) or of one of its target sets
 * (`build-<type>@<set>.log`), in the folder of these logs. Undefined for a
 * file that is no captured log of a named target, which may be anybody's: a
 * log elsewhere, `build.log` of a build whose target was unknown, the
 * diagnostic re-run's.
 */
export function isResultLogOf(file: string, targetType: string): boolean | undefined {
    const normal = `/${file.replace(/\\/g, '/')}`;
    const folder = `/${RESULT_LOG_FOLDER}/`;
    const at = normal.lastIndexOf(folder);
    const name = at < 0 ? '' : normal.slice(at + folder.length).toLowerCase();
    if (!/^build-[^/]+\.log$/.test(name) || name === 'build-diagnostic.log') {
        return undefined;
    }
    const nameOf = (target: string): string => resultLogPath(target).slice(RESULT_LOG_FOLDER.length + 1).toLowerCase();
    return name === nameOf(targetType) || name.startsWith(nameOf(`${targetType}@`).slice(0, -'.log'.length));
}

/** The first line of that log: which task's output it is, and how cbuild ended. */
export function resultLogHeader(taskName: string, exitCode: number): string {
    return `[cmsis-developer-assistant] Output of '${taskName}' as CMSIS Solution captured it; cbuild exit code ${exitCode}.\n`;
}
