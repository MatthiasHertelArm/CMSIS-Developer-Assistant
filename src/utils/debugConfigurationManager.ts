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
 * The debug configuration `start_debugging` runs.
 *
 * A CMSIS (`gdbtarget`) session is normally started by the name of an entry
 * in the folder's `.vscode/launch.json`, without this module. The handler
 * comes here when the agent names no configuration (the user then chooses
 * one in a quick-pick) or names the sentinel `Default Configuration`. For the
 * sentinel, and whenever a named entry cannot be used, a launch configuration
 * is synthesized from the source file's extension: a heuristic for general,
 * non-embedded debugging.
 *
 * The quick-pick waits for a person in a window the agent cannot see, so the
 * handler bounds it with a cancellation token (#14). When the token fires,
 * the picker closes and rejects with `PickerCancelled`, which names the
 * configurations it offered so that the agent can pass one by name.
 *
 * `launch.json` is read through the VS Code document model, so edits that are
 * not saved yet count, and parsed as JSONC: generated files carry comments
 * and trailing commas. No YAML is read here; the `*.cbuild-run.yml` files
 * belong to `core/cmsisTarget.ts` and `core/buildInfo/`.
 *
 * Nothing runs at load time and the constructor touches no `vscode` API: the
 * transport tests construct this class under a minimal stub.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import { logger } from './logger';

/** The name that asks for a synthesized configuration. `DebuggingHandler` compares against the same text. */
const AUTO_CONFIG_NAME = 'Default Configuration';

/** Every configuration name built here starts with it; it is what VS Code shows as the session name. */
const NAME_PREFIX = 'CMSIS Developer Assistant';

const IN_TERMINAL = 'integratedTerminal';

// The configuration quick-pick.
const PICKER_TITLE = 'Choose Debug Configuration';
const PICKER_PROMPT = 'Which launch configuration should the debug session use?';
/** Label, and returned name, of an entry that has no `name`. */
const NO_NAME = '(no name)';
const AUTO_ITEM_NOTE = 'Beta: derive the settings from the file type automatically';
const AUTO_ITEM_DETAIL = `${NAME_PREFIX} guesses the debugger and its settings from the source file's extension. The guess can be wrong for some projects.`;
/** The rejection when the picker is closed without a choice; the handler passes it on to the agent. */
const PICK_ABANDONED = 'The user closed the configuration picker without choosing a debug configuration';

/**
 * The configuration picker was closed by its cancellation token, not by the
 * user (#14): nobody chose in time. `offered` holds the names of the
 * `launch.json` entries it showed, for the agent's next call.
 */
export class PickerCancelled extends Error {
    constructor(readonly offered: readonly string[]) {
        super('The configuration picker was closed before anybody chose a debug configuration');
        this.name = 'PickerCancelled';
    }
}

/** Lower-cased source extension → the VS Code debug type used for it. */
const DEBUG_TYPES: ReadonlyMap<string, string> = new Map([
    ['.py', 'python'],
    ['.js', 'node'], ['.ts', 'node'], ['.jsx', 'node'], ['.tsx', 'node'],
    ['.java', 'java'],
    ['.cs', 'coreclr'],
    ['.cpp', 'cppdbg'], ['.cc', 'cppdbg'], ['.c', 'cppdbg'],
    ['.go', 'go'],
    ['.rs', 'lldb'],
    ['.php', 'php'],
    ['.rb', 'ruby'],
]);

/** The type of every extension the table does not list, and of a file without one. */
const FALLBACK_TYPE = 'python';

/** One element of `configurations`, as far as this module looks into it. */
interface LaunchEntry {
    name?: string;
    type?: string;
    request?: string;
    [field: string]: unknown;
}

type Fields = Record<string, unknown>;

/**
 * `<folder>/.vscode/launch.json`. Throws where the API has no `Uri.joinPath`
 * (the transport tests' stub): the prompt lets that escape, the other
 * readers treat it as "no file".
 */
function launchFileIn(folder: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(folder, '.vscode', 'launch.json');
}

/**
 * The `configurations` array of a launch.json as the editor sees it, or `[]`
 * when there is none (empty or broken text parses to no array). Rejects when
 * the document cannot be opened.
 */
async function launchEntries(file: vscode.Uri): Promise<LaunchEntry[]> {
    const doc = await vscode.workspace.openTextDocument(file);
    const tree = parseJsonc(doc.getText()) as { configurations?: unknown } | null | undefined;
    const list = tree?.configurations;
    return Array.isArray(list) ? list as LaunchEntry[] : [];
}

/**
 * The quick-pick, closed when `cancel` fires. Resolves undefined when it is
 * closed without a choice, by the user or by `cancel`. VS Code closes the
 * picker on the token; the race ends the wait even where it would not.
 */
async function pickUnlessCancelled(
    items: vscode.QuickPickItem[],
    options: vscode.QuickPickOptions,
    cancel: vscode.CancellationToken | undefined,
): Promise<vscode.QuickPickItem | undefined> {
    if (cancel === undefined) {
        return vscode.window.showQuickPick(items, options);
    }
    if (cancel.isCancellationRequested) {
        return undefined;
    }
    let listening: vscode.Disposable | undefined;
    const cancelled = new Promise<undefined>((closed) => {
        listening = cancel.onCancellationRequested(() => closed(undefined));
    });
    const shown = Promise.resolve(vscode.window.showQuickPick(items, options, cancel)).catch((failure: unknown) => {
        // A token that fires as the picker opens makes VS Code reject rather than resolve.
        if (cancel.isCancellationRequested) {
            return undefined;
        }
        throw failure;
    });
    try {
        return await Promise.race([shown, cancelled]);
    } finally {
        listening?.dispose();
    }
}

/** A launch request named `<prefix> <title>`; `type`, `request` and `name` come first. */
function launchRequest(debugType: string, title: string, fields: Fields): vscode.DebugConfiguration {
    return { type: debugType, request: 'launch', name: `${NAME_PREFIX} ${title}`, ...fields };
}

/** The base name without its extension: the Java main class. */
function stem(source: string): string {
    return path.basename(source, path.extname(source));
}

/** The program cppdbg launches: a lower-case `.c`, `.cc` or `.cpp` becomes `.exe`, on every OS. */
function executableFor(source: string): string {
    return source.replace(/\.(?:cpp|cc|c)$/, '.exe');
}

/** A tool installed in the workspace's `node_modules`; VS Code substitutes the variable. */
function workspaceBin(tool: string): string {
    return `\${workspaceFolder}/node_modules/.bin/${tool}`;
}

/** Run a file of the given debug type, no test filter. */
function plainLaunch(debugType: string, source: string): vscode.DebugConfiguration {
    const folder = path.dirname(source);
    const asScript: Fields = { program: source, console: IN_TERMINAL, cwd: folder, env: {}, stopOnEntry: false };
    switch (debugType) {
        case 'node':
            return launchRequest('pwa-node', 'Node.js Launch', asScript);
        case 'java':
            return launchRequest('java', 'Java Launch', { mainClass: stem(source), console: IN_TERMINAL, cwd: folder });
        case 'coreclr':
            return launchRequest('coreclr', '.NET Launch', { program: source, console: IN_TERMINAL, cwd: folder, stopAtEntry: false });
        case 'cppdbg':
            return launchRequest('cppdbg', 'C++ Launch', { program: executableFor(source), cwd: folder, console: IN_TERMINAL });
        case 'go':
            return launchRequest('go', 'Go Launch', { mode: 'debug', program: source, cwd: folder });
        default:
            // Python, and the types without a recipe of their own (lldb, php, ruby).
            return launchRequest('python', 'Python Launch', asScript);
    }
}

/**
 * The unittest target of one Python test: `module.Test` when the name is
 * already qualified, else `module.Class.Test` with the first capitalised
 * `class` word anywhere in the file (comments included), else `module.Test`.
 */
async function unittestTarget(source: string, test: string): Promise<string> {
    const fileName = path.basename(source);
    const moduleName = fileName.endsWith('.py') ? fileName.slice(0, -3) : fileName;
    if (test.includes('.')) {
        return `${moduleName}.${test}`;
    }
    try {
        const text = await fs.promises.readFile(source, 'utf8');
        const found = /class\s+([A-Z][A-Za-z0-9_]*)/.exec(text);
        if (found) {
            return `${moduleName}.${found[1]}.${test}`;
        }
    } catch (failure) {
        logger.warn(`Could not look for a test class in ${source}`, failure);
    }
    return `${moduleName}.${test}`;
}

/** Run one named test of a file. .NET never gets here: its test filter is not supported and is ignored. */
async function singleTestLaunch(debugType: string, source: string, test: string): Promise<vscode.DebugConfiguration> {
    const folder = path.dirname(source);
    switch (debugType) {
        case 'python': {
            const target = await unittestTarget(source, test);
            return launchRequest('python', `Python Test: ${test}`, {
                module: 'unittest', args: [target, '-v'], console: IN_TERMINAL, cwd: folder, env: {},
                stopOnEntry: false, justMyCode: false, purpose: ['debug-test'],
            });
        }
        case 'node': {
            const fileName = path.basename(source);
            const jest = fileName.includes('.test.') || fileName.includes('.spec.');
            const title = jest ? `Jest Test: ${test}` : `Mocha Test: ${test}`;
            const runnerArgs = jest ? ['--testNamePattern', test, '--runInBand', source] : ['--grep', test, source];
            return launchRequest('pwa-node', title, {
                program: workspaceBin(jest ? 'jest' : 'mocha'), args: runnerArgs,
                console: IN_TERMINAL, cwd: folder, env: {}, stopOnEntry: false,
            });
        }
        case 'java': {
            const mainClass = stem(source);
            return launchRequest('java', `JUnit Test: ${test}`, {
                mainClass, args: ['--tests', `${mainClass}.${test}`], console: IN_TERMINAL, cwd: folder,
            });
        }
        default:
            return launchRequest(debugType, `Launch (test filtering not supported for ${debugType})`, {
                program: source, console: IN_TERMINAL, cwd: folder, stopOnEntry: false,
            });
    }
}

export interface IDebugConfigurationManager {
    getDebugConfig(workDir: string, sourceFile: string, launchName?: string, testName?: string): Promise<vscode.DebugConfiguration>;
    /** `cancel` closes the picker; it then rejects with `PickerCancelled` (#14). */
    promptForConfiguration(workDir: string, cancel?: vscode.CancellationToken): Promise<string | undefined>;
    detectLanguageFromFilePath(sourceFile: string): string;
}

export class DebugConfigurationManager implements IDebugConfigurationManager {

    /** The sentinel configuration name. */
    static getAutoLaunchConfigName(): string {
        return AUTO_CONFIG_NAME;
    }

    /**
     * The configuration to start for `sourceFile`: the `launch.json` entry
     * called `launchName` (renamed for the session), or a synthesized one
     * for the sentinel, an unknown name, a missing or broken file. The
     * synthesized configuration runs in the file's own directory, whatever
     * `workDir` is.
     */
    async getDebugConfig(workDir: string, sourceFile: string, launchName?: string, testName?: string): Promise<vscode.DebugConfiguration> {
        if (launchName !== AUTO_CONFIG_NAME) {
            const named = await this.namedEntry(workDir, launchName);
            if (named) {
                return named;
            }
        }
        const debugType = this.detectLanguageFromFilePath(sourceFile);
        if (testName && debugType !== 'coreclr') {
            return singleTestLaunch(debugType, sourceFile, testName);
        }
        return plainLaunch(debugType, sourceFile);
    }

    /**
     * Let the user choose among the folder's `launch.json` entries and the
     * sentinel, which is always offered last. Resolves the chosen label;
     * rejects when the picker is closed without a choice, and with
     * `PickerCancelled` when `cancel` closed it (#14).
     */
    async promptForConfiguration(workDir: string, cancel?: vscode.CancellationToken): Promise<string | undefined> {
        try {
            // Built before the read's own error handling on purpose: a failure here reaches the caller.
            const file = launchFileIn(vscode.Uri.file(workDir));
            const entries = await launchEntries(file).catch((failure: unknown): LaunchEntry[] => {
                logger.warn(`No configurations to offer from ${file.fsPath}`, failure);
                return [];
            });
            const items: vscode.QuickPickItem[] = entries.map((entry) => ({
                label: entry.name || NO_NAME,
                description: entry.type ? `Debugger type: ${entry.type}` : '',
                detail: entry.request ? `Request kind: ${entry.request}` : '',
            }));
            items.push({ label: AUTO_CONFIG_NAME, description: AUTO_ITEM_NOTE, detail: AUTO_ITEM_DETAIL });
            const picked = await pickUnlessCancelled(items, { placeHolder: PICKER_PROMPT, title: PICKER_TITLE }, cancel);
            if (!picked) {
                if (cancel?.isCancellationRequested) {
                    throw new PickerCancelled(entries.map((entry) => entry.name).filter((name): name is string => typeof name === 'string' && name.length > 0));
                }
                throw new Error(PICK_ABANDONED);
            }
            return picked.label;
        } catch (failure) {
            if (failure instanceof PickerCancelled) {
                // Expected: the agent is told, with the configurations to name.
                logger.warn(`${failure.message} (${workDir})`);
            } else {
                logger.error('Choosing a debug configuration failed', failure);
            }
            throw failure;
        }
    }

    /** The debug type for a source file, from its extension; unknown or none means Python. */
    detectLanguageFromFilePath(sourceFile: string): string {
        return DEBUG_TYPES.get(path.extname(sourceFile).toLowerCase()) ?? FALLBACK_TYPE;
    }

    /**
     * True when the folder has a file-system path. A missing folder or URI is
     * returned as it is (`undefined`, `null`) rather than as `false`.
     */
    validateWorkspace(folder: vscode.WorkspaceFolder): boolean {
        try {
            return (folder && folder.uri && typeof folder.uri.fsPath === 'string' && folder.uri.fsPath.length > 0) as boolean;
        } catch (failure) {
            logger.warn('Could not validate the workspace folder', failure);
            return false;
        }
    }

    /** The entry names of the folder's `launch.json`, in file order; `[]` when there are none or it cannot be read. */
    async getAvailableConfigurations(folder: vscode.WorkspaceFolder): Promise<string[]> {
        try {
            const entries = await launchEntries(launchFileIn(folder.uri));
            return entries.map((entry) => entry.name || NO_NAME);
        } catch (failure) {
            logger.warn('Could not list the launch configurations', failure);
            return [];
        }
    }

    async hasLaunchJson(folder: vscode.WorkspaceFolder): Promise<boolean> {
        try {
            await vscode.workspace.openTextDocument(launchFileIn(folder.uri));
            return true;
        } catch {
            return false;
        }
    }

    /** The named entry of `<workDir>/.vscode/launch.json`, renamed; `undefined` when there is none to use. */
    private async namedEntry(workDir: string, launchName: string | undefined): Promise<vscode.DebugConfiguration | undefined> {
        try {
            const entries = await launchEntries(launchFileIn(vscode.Uri.file(workDir)));
            if (entries.length === 0) {
                logger.info(`${workDir}/.vscode/launch.json lists no configurations; synthesizing one`);
                return undefined;
            }
            if (!launchName) {
                return undefined;
            }
            const entry = entries.find((candidate) => candidate.name === launchName);
            if (!entry) {
                logger.warn(`${workDir} has no launch configuration named "${launchName}"; synthesizing one`);
                return undefined;
            }
            return { ...entry, name: `${NAME_PREFIX} Launch (${launchName})` } as vscode.DebugConfiguration;
        } catch (failure) {
            logger.warn(`Could not read the launch configurations of ${workDir}; synthesizing one`, failure);
            return undefined;
        }
    }
}
