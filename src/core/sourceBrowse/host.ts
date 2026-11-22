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
 * The seam between the source-browsing core and its window. Nothing under
 * `core/sourceBrowse/` imports `vscode`: the clangd extension, its settings,
 * the documents of the editor and the clock arrive through this interface,
 * which `sourceBrowseHost.ts` fills in the extension and a scripted object
 * fills in the tests.
 */

import type { PackDocsLog } from '../packDocs/host';
import type { Clock } from '../solutionApi';
import type { ClangdExtensionHandle } from './clangdApi';
import type { OpenedDocument } from './protocol';

/** The settings of the clangd extension as the window has them, variables not substituted. */
export interface ClangdWindowSettings {
    /** `clangd.enable`. */
    enable: boolean;
    /** `clangd.path`. */
    path: string;
    /** `clangd.arguments`: what CMSIS Solution writes `--compile-commands-dir` into. */
    arguments: readonly unknown[];
}

/** What a request to the language server can be cancelled with. */
export interface Cancellation {
    /** Handed to the client's `sendRequest`. */
    readonly token: unknown;
    cancel(): void;
    dispose(): void;
}

export interface SourceBrowseHost {
    /** Absolute paths of the open workspace folders (empty when none). */
    workspaceFolders(): string[];
    /** The CMSIS pack root, when the window knows one. */
    packRoot(): Promise<string | undefined>;
    /** The clangd extension, or undefined when it is not installed or is disabled. */
    clangdExtension(): ClangdExtensionHandle | undefined;
    clangdSettings(): ClangdWindowSettings;
    /**
     * The value of a `${name}` the clangd extension substitutes in its
     * settings (`workspaceFolder`, `userHome`, `env:NAME`, `config:key`);
     * undefined for a name without a value.
     */
    variable(name: string): string | undefined;
    /**
     * Opens the document of `file` in the window without showing it, so that
     * the language client tells the server about it; resolves with the URI
     * the client uses for it, its language and its text as the editor has it.
     */
    openDocument(file: string): Promise<OpenedDocument>;
    /** The text of `file`: the editor's when the document is open there, else the file's; undefined when it cannot be read. */
    readText(file: string): Promise<string | undefined>;
    /** A cancellation for one request; the tests run without. */
    cancellation?(): Cancellation;
    /** The folders that hold the images of the active target, to tell whether the index covers it; undefined when unknown. */
    activeImageFolders?(): Promise<string[] | undefined>;
    log: PackDocsLog;
    clock: Clock;
}
