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
 * The seam to the clangd extension (`llvm-vs-code-extensions.vscode-clangd`),
 * as far as this extension uses it: `exports.getApi(1).languageClient`, the
 * language client the editor itself talks to clangd through. The source
 * tools send their requests to that client, so they see the index the editor
 * sees, built for the context CMSIS Solution configured, and no second
 * clangd runs.
 *
 * The clangd extension is optional and no package of it is a dependency: the
 * shapes below are the part of its API and of the client that is read here.
 * `acquireClangdClient` activates the extension when it is installed but
 * inactive, asks for the client anew on every call (a restart of clangd puts
 * a new one into the API object, and CMSIS Solution restarts clangd whenever
 * it rewrites the setup), waits with a growing pause while the client starts,
 * and turns every way of not getting a running client into a typed refusal.
 * Nothing is repaired from here: a missing language server is named, not
 * downloaded.
 *
 * Pure: no `vscode`, no file access; the caller hands in the extension, the
 * settings and a clock.
 */

import type { Clock } from '../solutionApi';
import { settleWithin } from '../solutionApi';
import { ToolError } from '../toolResult';
import { secondsText } from '../windowHealth';

/** The identifier of the clangd extension. */
export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
/** The version of its API this extension asks for. */
export const CLANGD_API_VERSION = 1;
/** The command of the clangd extension that downloads a language server, as the Command Palette shows it. */
export const DOWNLOAD_COMMAND = 'clangd: Download language server';
/** How long an inactive clangd extension may take to activate. */
export const CLANGD_ACTIVATION_MS = 15_000;
/** How long a starting client is waited for, when the call's deadline allows it. */
export const CLIENT_START_MS = 20_000;

/** `State.Running` of vscode-languageclient; `isRunning()` is preferred where the client has it. */
const STATE_RUNNING = 2;
/** `State.Starting` of vscode-languageclient. */
const STATE_STARTING = 3;

/** The clangd extension as `vscode.extensions.getExtension` describes it. */
export interface ClangdExtensionHandle {
    readonly isActive: boolean;
    readonly exports: unknown;
    readonly version?: string;
    /** Activates the extension; resolves with its exports. */
    activate(): PromiseLike<unknown>;
}

/** The part of the language client that is used here. */
export interface LanguageClientLike {
    isRunning?(): boolean;
    readonly state?: number;
    /** One request to the server; `token` is a `vscode.CancellationToken`. Rejects with the server's error, which carries a `code`. */
    sendRequest(method: string, params: unknown, token?: unknown): PromiseLike<unknown>;
    readonly initializeResult?: {
        serverInfo?: { name?: string; version?: string };
        capabilities?: Record<string, unknown>;
    };
}

/** The settings of the clangd extension that decide whether it has a client. */
export interface ClangdSettings {
    /** `clangd.enable`. */
    enable: boolean;
    /** `clangd.path`, as written. */
    path: string;
}

/** A caught value's message. */
function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** ` 0.6.0` or nothing. */
function versionText(handle: ClangdExtensionHandle): string {
    return handle.version ? ` ${handle.version}` : '';
}

/** True for a client that answers requests. */
export function isRunning(client: LanguageClientLike): boolean {
    return typeof client.isRunning === 'function' ? client.isRunning() : client.state === STATE_RUNNING;
}

/** Resolves after `ms` on `clock`. */
function pause(ms: number, clock: Pick<Clock, 'startTimer'>): Promise<void> {
    return new Promise((resolve) => {
        clock.startTimer(ms, resolve);
    });
}

/** The refusal for an API object without a client: clangd is switched off, or the extension found no executable. */
function noClientRefusal(what: string, settings: ClangdSettings): ToolError {
    if (!settings.enable) {
        return new ToolError('TOOL_DISABLED', `${what} not attempted: clangd is switched off in this window (setting clangd.enable).`,
            'Ask the user to switch clangd.enable on.');
    }
    return new ToolError('TOOL_DISABLED',
        `${what} not attempted: the clangd extension has no language server, the executable '${settings.path}' (setting clangd.path) was not found.`,
        `Ask the user to run "${DOWNLOAD_COMMAND}" from the Command Palette, or to install clangd; then repeat the call. Nothing is downloaded by this tool.`);
}

/**
 * The running language client of the clangd extension. `what` names the call
 * in the refusals:
 * the extension not installed or disabled, without `getApi`, without API
 * version 1, or without a client (`TOOL_DISABLED`); an activation that fails
 * (`TASK_FAILED`) or takes longer than `activationMs` (`TIMEOUT`); a client
 * that is not running by `deadline` or after `startMs` (`TIMEOUT`).
 */
export async function acquireClangdClient(
    handle: ClangdExtensionHandle | undefined,
    settings: ClangdSettings,
    what: string,
    clock: Clock,
    deadline: number,
    limits: { activationMs?: number; startMs?: number } = {},
): Promise<LanguageClientLike> {
    if (handle === undefined) {
        throw new ToolError('TOOL_DISABLED',
            `${what} not attempted: the clangd extension (${CLANGD_EXTENSION_ID}) is not installed or is disabled in this window.`,
            'It is part of the Keil Studio Pack: ask the user to install or enable it. Nothing is installed by this tool.');
    }
    const activationMs = limits.activationMs ?? CLANGD_ACTIVATION_MS;
    // VS Code throws for the exports of an extension that is not active yet, so they are read only once it is.
    let exported: unknown;
    if (handle.isActive) {
        exported = handle.exports;
    } else {
        let activated: { value: unknown } | undefined;
        try {
            activated = await settleWithin(handle.activate(), Math.min(activationMs, Math.max(0, deadline - clock.now())), clock);
        } catch (caught) {
            throw new ToolError('TASK_FAILED', `${what} not attempted: the clangd extension${versionText(handle)} failed to activate (${messageOf(caught)}).`,
                'get_recent_problems shows what it reported; if it persists, ask the user to reload the window.');
        }
        if (activated === undefined) {
            throw new ToolError('TIMEOUT', `${what} not attempted: the clangd extension did not finish activating within ${secondsText(activationMs)}.`,
                'It may still be starting: repeat the call in a few seconds.');
        }
        exported = activated.value ?? handle.exports;
    }
    const surface = exported as { getApi?: unknown } | null | undefined;
    if (typeof surface?.getApi !== 'function') {
        throw new ToolError('TOOL_DISABLED', `${what} not attempted: the clangd extension${versionText(handle)} offers no public API (no getApi).`,
            'Ask the user to update the clangd extension.');
    }
    const getApi = surface.getApi as (version: number) => unknown;
    const startBy = Math.min(deadline, clock.now() + (limits.startMs ?? CLIENT_START_MS));
    let wait = 50;
    for (;;) {
        let client: LanguageClientLike | null | undefined;
        try {
            client = (getApi.call(surface, CLANGD_API_VERSION) as { languageClient?: LanguageClientLike | null } | null | undefined)?.languageClient;
        } catch (caught) {
            throw new ToolError('TOOL_DISABLED',
                `${what} not attempted: the clangd extension${versionText(handle)} offers no API version ${CLANGD_API_VERSION} (${messageOf(caught)}).`,
                'Ask the user to update the clangd extension.');
        }
        if (client === undefined || client === null || typeof client.sendRequest !== 'function') {
            throw noClientRefusal(what, settings);
        }
        if (isRunning(client)) {
            return client;
        }
        if (clock.now() + wait > startBy) {
            const state = client.state === STATE_STARTING ? 'is still starting' : 'is not running';
            throw new ToolError('TIMEOUT', `${what} not attempted: clangd ${state} in this window.`,
                'CMSIS Solution restarts it when the solution or the target changes: repeat the call in a few seconds. '
                + 'If it stays down, the Output channel "clangd" says why, and "clangd: Restart language server" starts it again.');
        }
        await pause(wait, clock);
        wait = Math.min(wait * 2, 1_000);
    }
}
