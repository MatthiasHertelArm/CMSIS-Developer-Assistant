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
 * What a VS Code window still lacks before the CMSIS tools can work in it,
 * and the texts that say so: no folder open, the CMSIS Solution or the CMSIS
 * Debugger extension missing, a folder without a csolution, a csolution the
 * extension has not loaded. `cmsis_action` and `flash` refuse with these
 * texts, and `get_session_status` carries one line per gap while no debug
 * session runs. Each text names the next step, so an agent that starts in an
 * empty window is sent to `cmsis_action open_solution` and the `bootstrap`
 * topic of the guide instead of a shell. The search by which the CMSIS
 * Solution extension lists the csolution files of a window is here too, so
 * that `open_solution` can run the same one. So is the line on the solution
 * the window has active, which `get_session_status` carries in every state:
 * the answer to which project "the current solution" is (#124). And the project
 * root `open_solution` opens for a csolution (#145).
 *
 * Pure: no `vscode`, no file access (the root walk is handed its file test).
 */

import * as path from 'path';
import type { SolutionFileAnswer } from './solutionAnswers';
import { ToolError } from './toolResult';

/** The CMSIS Solution extension: build, load and debug commands, `launch.json`. */
export const SOLUTION_EXTENSION_ID = 'Arm.cmsis-csolution';
/** The CMSIS Debugger extension: the `gdbtarget` sessions, pyOCD and GDB. */
export const DEBUGGER_EXTENSION_ID = 'Arm.vscode-cmsis-debugger';
/** The extension pack that installs both, with the Arm Tools Environment Manager. */
export const STUDIO_PACK_ID = 'Arm.keil-studio-pack';

/** Where the steps from an empty window to a debugged board are written down. */
export const BOOTSTRAP_POINTER = 'get_debug_instructions {topic:\'bootstrap\'} has the steps from an empty window to a debugged board.';

const OPEN_A_SOLUTION = 'Open the project with cmsis_action {action:\'open_solution\', path:\'<folder or *.csolution.yml>\'}.';
const INSTALL_STUDIO_PACK = `Ask the user to install the Keil Studio Pack (${STUDIO_PACK_ID}) in VS Code and to reload the window.`;

/** What the window has, as far as the CMSIS tools care. */
export interface WindowFacts {
    /** Number of open workspace folders. */
    folders: number;
    /** Whether the CMSIS Solution extension is installed. */
    solutionExtension: boolean;
    /** Whether the CMSIS Debugger extension is installed. */
    debuggerExtension: boolean;
}

/** The refusal of a tool that needs a project while the window has no folder open. */
export function noWorkspaceRefusal(what: string): ToolError {
    return new ToolError('NO_WORKSPACE',
        `${what} not attempted: no folder is open in this VS Code window, so there is no CMSIS solution to act on.`,
        `${OPEN_A_SOLUTION} No project yet? ${BOOTSTRAP_POINTER}`);
}

/** The refusal of a CMSIS action while the CMSIS Solution extension is not installed. */
export function missingSolutionExtensionRefusal(what: string): ToolError {
    return new ToolError('CMSIS_NO_SOLUTION',
        `${what} not attempted: the CMSIS Solution extension (${SOLUTION_EXTENSION_ID}) is not installed in this VS Code, `
            + 'so there is no active solution.',
        `${INSTALL_STUDIO_PACK} ${BOOTSTRAP_POINTER}`);
}

/**
 * The refusal of a CMSIS action in a window with a folder and the extension,
 * but no active solution. `solutionFiles` are the csolution files found in
 * the workspace (undefined when the search could not run), `folderNames` the
 * open folders, `queried` what the extension answered.
 */
export function noSolutionRefusal(
    what: string,
    queried: string,
    solutionFiles: readonly string[] | undefined,
    folderNames: readonly string[],
    serverVersion: string,
): ToolError {
    const message = `${what} not attempted: the CMSIS Solution extension reports no active solution in this VS Code window `
        + `(cmsis-csolution.getSolutionFile → ${queried}).`;
    if (solutionFiles !== undefined && solutionFiles.length === 0) {
        const where = folderNames.length > 0 ? ` (${folderNames.join(', ')})` : '';
        return new ToolError('CMSIS_NO_SOLUTION', message,
            `The open folder${folderNames.length === 1 ? '' : 's'}${where} contain${folderNames.length === 1 ? 's' : ''} no *.csolution.yml. `
                + 'Create the solution first, or open the folder that has it: '
                + `cmsis_action {action:'open_solution', path}. ${BOOTSTRAP_POINTER}`);
    }
    if (solutionFiles !== undefined) {
        const first = solutionFiles[0];
        const more = solutionFiles.length > 1 ? ` (and ${solutionFiles.length - 1} more)` : '';
        return new ToolError('CMSIS_NO_SOLUTION', message,
            `A solution file exists: ${first}${more}. The extension may still be loading it, or failed to load it. `
                + `cmsis_action {action:'open_solution', path:'${first}'} activates it; `
                + 'get_recent_problems shows what the extension reported.');
    }
    return new ToolError('CMSIS_NO_SOLUTION', message,
        'cmsis_action operates on whatever solution that extension has active. '
            + 'Fixes: (1) open the folder containing the project\'s *.csolution.yml in the VS Code window running this MCP server '
            + `(serverVersion=${serverVersion}), or cmsis_action {action:'open_solution', path}; `
            + '(2) in the CMSIS Solution panel, confirm a solution + active context is selected; '
            + '(3) if the solution is open in a different window, pass window to cmsis_action or call select_debug_window.');
}

/**
 * The lines `get_session_status` adds while no debug session runs in a
 * window without a folder: that no folder is open, and which of the CMSIS
 * extensions are missing. A window with a folder gets none: there the
 * refusal of `cmsis_action` names what is missing, and a project of another
 * kind is not told about CMSIS extensions.
 */
export function bootstrapStatusLines(facts: WindowFacts): string[] {
    if (facts.folders > 0) {
        return [];
    }
    const lines = [`Workspace: no folder is open in this VS Code window. ${OPEN_A_SOLUTION} ${BOOTSTRAP_POINTER}`];
    const missing: string[] = [];
    if (!facts.solutionExtension) {
        missing.push(`CMSIS Solution (${SOLUTION_EXTENSION_ID})`);
    }
    if (!facts.debuggerExtension) {
        missing.push(`CMSIS Debugger (${DEBUGGER_EXTENSION_ID})`);
    }
    if (missing.length > 0) {
        lines.push(`Extensions: ${missing.join(' and ')} not installed, so cmsis_action and gdbtarget sessions cannot work here. `
            + INSTALL_STUDIO_PACK);
    }
    return lines;
}

/** What `get_session_status` knows about the solution of its window (#124). */
export interface SolutionFacts {
    /** What the CMSIS Solution extension answered in the time the status waits; undefined when it did not. */
    answer: SolutionFileAnswer | undefined;
    /** The csolution the window published last (`cmsis=` of the window listing), for when no answer came. */
    lastKnown?: string;
    /** The paths of the open workspace folders. */
    folders: readonly string[];
}

/** How the line says that it names the csolution the window published last, not one the extension named just now. */
const LAST_KNOWN = 'last known, CMSIS Solution did not answer just now';

/**
 * The line of `get_session_status` on the solution the CMSIS Solution
 * extension has active in the window (#124): its csolution file and the
 * workspace folder that holds it (the innermost one, when folders nest), or
 * that none is active while a folder is open; a window without a folder has
 * its `Workspace:` line instead. Without an answer the line names the
 * csolution the window published last, and says so: a solution may have
 * just been switched. Undefined when there is neither, or the answer names
 * no file: agents are told to ask the user then, never to take the shell's
 * working directory.
 */
export function solutionStatusLine(facts: SolutionFacts, platform: NodeJS.Platform = process.platform): string | undefined {
    const { answer, lastKnown, folders } = facts;
    if (answer === undefined) {
        return lastKnown === undefined ? undefined : namedSolutionLine(lastKnown, folders, platform, LAST_KNOWN);
    }
    if (!answer.active) {
        return folders.length > 0 ? 'Active solution: none in this VS Code window' : undefined;
    }
    return answer.file === undefined ? undefined : namedSolutionLine(answer.file, folders, platform);
}

/** `Active solution: <file> (workspace folder <folder>)`, with `note` after the folder when given. */
function namedSolutionLine(file: string, folders: readonly string[], platform: NodeJS.Platform, note?: string): string {
    const holder = folders.filter((folder) => liesInside(file, folder, platform))
        .reduce<string | undefined>((inner, folder) => (inner === undefined || folder.length > inner.length ? folder : inner), undefined);
    const where = holder === undefined ? 'in no open workspace folder' : `workspace folder ${holder}`;
    return `Active solution: ${file} (${where}${note === undefined ? '' : `; ${note}`})`;
}

/** True for a `*.csolution.yml` or `*.csolution.yaml` path. */
export function isSolutionFile(file: string): boolean {
    return /\.csolution\.ya?ml$/i.test(file);
}

/** What the CMSIS Solution extension searches every workspace folder for when it lists the csolution files (1.72.0 `getSolutionPaths`). */
export const LISTED_SOLUTION_GLOB = '**/*.csolution.{yaml,yml}';
/** Hidden folders, which that search always leaves out. */
const HIDDEN_FOLDERS_GLOB = '**/.*/**';

/**
 * The exclude of that search (1.72.0 `getExcludeGlob`): hidden folders, and
 * the glob of the setting `cmsis-csolution.exclude` when it is set; a
 * setting in braces adds its alternatives.
 */
export function listedSolutionExclude(setting: unknown): string {
    const configured = typeof setting === 'string' ? setting.trim() : '';
    if (configured.length === 0) {
        return HIDDEN_FOLDERS_GLOB;
    }
    const alternatives = configured.startsWith('{') && configured.endsWith('}') ? configured.slice(1, -1).trim() : configured;
    return `{${HIDDEN_FOLDERS_GLOB},${alternatives}}`;
}

/** The path functions of `platform`: Windows paths for win32, POSIX paths for every other platform. */
function pathsOf(platform: NodeJS.Platform): typeof path.posix {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** `p` resolved in the platform's path syntax, in lower case where the platform's file names ignore case (Windows, macOS). */
function comparablePath(p: string, platform: NodeJS.Platform): string {
    const resolved = pathsOf(platform).resolve(p);
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** `a` and `b` name the same file or folder; case-insensitive where the platform's file names are. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
    return comparablePath(a, platform) === comparablePath(b, platform);
}

/** Whether `target` is `folder` or lies below it, both compared as `samePath` compares. */
export function liesInside(target: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
    const inner = comparablePath(target, platform);
    const outer = comparablePath(folder, platform);
    if (inner === outer) {
        return true;
    }
    const paths = pathsOf(platform);
    const relative = paths.relative(outer, inner);
    return relative.length > 0 && !relative.startsWith('..') && !paths.isAbsolute(relative);
}

/** The entries that mark the top of a project above a csolution: a git repository (a folder, or a file in a worktree or submodule) and the tools manifest. */
export const PROJECT_ROOT_MARKERS: readonly string[] = ['.git', 'vcpkg-configuration.json'];

/**
 * The folder `open_solution` opens for a csolution no open folder holds
 * (#145): the nearest folder from the csolution's own up that has an entry
 * of `PROJECT_ROOT_MARKERS`, so that a `vcpkg-configuration.json` at the
 * repository root lies inside the opened folder. The walk never takes the
 * user's home folder, the file system root or a folder that holds home; without
 * a marker below those, the csolution's own folder. `exists` answers
 * whether a path exists, file or folder.
 */
export function projectRootOf(
    solutionFile: string,
    home: string,
    exists: (file: string) => boolean,
    platform: NodeJS.Platform = process.platform,
): string {
    const paths = pathsOf(platform);
    const own = paths.dirname(solutionFile);
    for (let dir = own; ; dir = paths.dirname(dir)) {
        if (paths.dirname(dir) === dir || liesInside(home, dir, platform)) {
            return own;
        }
        if (PROJECT_ROOT_MARKERS.some((marker) => exists(paths.join(dir, marker)))) {
            return dir;
        }
    }
}
