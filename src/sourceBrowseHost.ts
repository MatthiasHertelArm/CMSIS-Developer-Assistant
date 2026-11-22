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
 * The VS Code side of the source-browsing tools (experimental): the gate
 * `cmsis-developer-assistant.sourceBrowsing.enabled`, and the host object the
 * handler sees. Here the clangd extension is looked up, its settings are
 * read, a document is opened without being shown so that the language client
 * tells clangd about it, and a file's text is read as the editor has it.
 * Nothing under `core/sourceBrowse` imports `vscode`; this file is where
 * that ends.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BuildInfoHost } from './core/buildInfo/host';
import { resolveBuildContext } from './core/buildInfo/artifacts';
import { silentLog } from './core/packDocs/host';
import { CLANGD_EXTENSION_ID, ClangdExtensionHandle } from './core/sourceBrowse/clangdApi';
import type { SourceBrowseHost } from './core/sourceBrowse/host';
import { SourceBrowseHandler } from './sourceBrowseHandler';
import { logger } from './utils/logger';

const CONFIG = 'cmsis-developer-assistant';
/** A call of the source tools waits at most this long, whatever the general tool timeout is. */
const SOURCE_CALL_MS = 60_000;
/** The active target's image folders are asked for again after this long. */
const IMAGE_FOLDERS_MS = 5_000;

/** The gate of the source tools, read once at activation like the other tool groups: off unless switched on. */
export function readSourceBrowsingGate(): boolean {
    return vscode.workspace.getConfiguration(CONFIG).get<boolean>('sourceBrowsing.enabled', false);
}

/** The first workspace folder, which the clangd extension starts the server in. */
function firstFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * The value of a variable in a setting of the clangd extension, for the
 * names that extension substitutes: the home directory, the first workspace
 * folder (under three names), its base name, an environment variable and a
 * setting. A command is not run from here: such a placeholder stays.
 */
function clangdVariable(name: string): string | undefined {
    if (name === 'userHome') {
        return os.homedir();
    }
    if (name === 'workspaceFolder' || name === 'workspaceRoot' || name === 'cwd') {
        return firstFolder();
    }
    if (name === 'workspaceFolderBasename') {
        const folder = firstFolder();
        return folder === undefined ? undefined : path.basename(folder);
    }
    if (name.startsWith('env:')) {
        return process.env[name.slice('env:'.length)] ?? '';
    }
    if (name.startsWith('config:')) {
        const value = vscode.workspace.getConfiguration().get<unknown>(name.slice('config:'.length));
        return typeof value === 'string' ? value : undefined;
    }
    return undefined;
}

/** The clangd extension as the seam reads it; undefined when it is not installed or is disabled. */
function clangdExtension(): ClangdExtensionHandle | undefined {
    const extension = vscode.extensions.getExtension(CLANGD_EXTENSION_ID);
    if (extension === undefined) {
        return undefined;
    }
    const version = (extension.packageJSON as { version?: unknown } | undefined)?.version;
    return {
        get isActive(): boolean {
            return extension.isActive;
        },
        get exports(): unknown {
            return extension.exports;
        },
        version: typeof version === 'string' ? version : undefined,
        activate: () => extension.activate(),
    };
}

/**
 * The window as the source tools see it. `packRoot` is the pack root the
 * documentation tools resolved; `build` finds the active target's images, to
 * tell whether the index covers that target.
 */
export function makeSourceBrowseHost(packRoot: () => Promise<string | undefined>, build: BuildInfoHost): SourceBrowseHost {
    let images: { at: number; folders: string[] | undefined } | undefined;
    return {
        workspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
        packRoot,
        clangdExtension,
        clangdSettings: () => {
            const settings = vscode.workspace.getConfiguration('clangd');
            return {
                enable: settings.get<boolean>('enable', true),
                path: settings.get<string>('path', 'clangd'),
                arguments: settings.get<unknown[]>('arguments', []),
            };
        },
        variable: clangdVariable,
        openDocument: async (file) => {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            return { uri: document.uri.toString(), languageId: document.languageId, text: document.getText() };
        },
        readText: async (file) => {
            const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === 'file' && document.uri.fsPath === file);
            if (open !== undefined) {
                return open.getText();
            }
            try {
                return await fs.promises.readFile(file, 'utf8');
            } catch {
                return undefined;
            }
        },
        cancellation: () => {
            const source = new vscode.CancellationTokenSource();
            return { token: source.token, cancel: () => source.cancel(), dispose: () => source.dispose() };
        },
        activeImageFolders: async () => {
            const now = Date.now();
            if (images === undefined || now - images.at > IMAGE_FOLDERS_MS) {
                const context = await resolveBuildContext({ ...build, log: silentLog }, {});
                const folders = 'error' in context ? undefined : [...new Set(context.images.map((image) => path.dirname(image.elf.path)))];
                images = { at: now, folders };
            }
            return images.folders;
        },
        log: logger,
        clock: {
            now: () => Date.now(),
            startTimer: (ms, fire) => {
                const handle = setTimeout(fire, ms);
                return () => clearTimeout(handle);
            },
        },
    };
}

/** This window's source-browsing handler. It does nothing until a tool calls it. */
export function createSourceBrowseHandler(packRoot: () => Promise<string | undefined>, build: BuildInfoHost, timeoutInSeconds: number): SourceBrowseHandler {
    return new SourceBrowseHandler(makeSourceBrowseHost(packRoot, build), { timeoutMs: Math.min(timeoutInSeconds * 1000, SOURCE_CALL_MS) });
}
