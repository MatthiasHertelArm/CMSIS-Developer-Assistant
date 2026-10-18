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
 * topic of the guide instead of a shell.
 *
 * Pure: no `vscode`, no file access.
 */

import * as path from 'path';
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

/** True for a `*.csolution.yml` or `*.csolution.yaml` path. */
export function isSolutionFile(file: string): boolean {
    return /\.csolution\.ya?ml$/i.test(file);
}

/** `a` and `b` name the same file or folder; case-insensitive where the platform's file names are. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
    const fold = (p: string): string => {
        const resolved = path.resolve(p).replace(/[\\/]+$/, '');
        return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
    };
    return fold(a) === fold(b);
}

/** Whether `target` is `folder` or lies below it. */
export function liesInside(target: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
    if (samePath(target, folder, platform)) {
        return true;
    }
    const relative = path.relative(path.resolve(folder), path.resolve(target));
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}
