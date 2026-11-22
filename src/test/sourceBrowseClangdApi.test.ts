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
 * The seam to the clangd extension: every way of getting its running
 * language client, and every way of not getting one as the refusal an agent
 * reads.
 */

import * as assert from 'assert';
import { ClangdExtensionHandle, DOWNLOAD_COMMAND, LanguageClientLike, acquireClangdClient, isRunning } from '../core/sourceBrowse/clangdApi';
import { ToolError } from '../core/toolResult';
import { SkippingClock } from './sourceBrowseScript';

const SETTINGS = { enable: true, path: 'clangd' };
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A client in a state; `runningAfter` polls of `isRunning` make it run. */
function client(state: 'running' | 'starting' | 'stopped', runningAfter = Number.POSITIVE_INFINITY): LanguageClientLike & { polls: number } {
    return {
        polls: 0,
        state: state === 'running' ? 2 : state === 'starting' ? 3 : 1,
        isRunning(): boolean {
            this.polls++;
            return state === 'running' || this.polls > runningAfter;
        },
        sendRequest: () => Promise.resolve(null),
    };
}

/** An active extension whose API hands out what `languageClient` returns at that moment. */
function extension(languageClient: () => LanguageClientLike | undefined, more: Partial<ClangdExtensionHandle> = {}): ClangdExtensionHandle {
    return { isActive: true, version: '0.6.0', exports: { getApi: () => ({ languageClient: languageClient() }) }, activate: () => Promise.resolve(undefined), ...more };
}

suite('Source browsing: the clangd extension\'s client', () => {
    const acquire = (handle: ClangdExtensionHandle | undefined, settings = SETTINGS, budgetMs = 5_000): Promise<LanguageClientLike> => {
        const clock = new SkippingClock();
        return acquireClangdClient(handle, settings, 'source_find', clock, clock.now() + budgetMs);
    };
    const refused = async (call: Promise<unknown>): Promise<ToolError> => {
        try {
            await call;
        } catch (caught) {
            assert.ok(caught instanceof ToolError, `a ToolError, not ${String(caught)}`);
            return caught;
        }
        throw new assert.AssertionError({ message: 'expected a refusal' });
    };

    test('a running client is handed out as it is', async () => {
        const running = client('running');
        assert.strictEqual(await acquire(extension(() => running)), running);
    });

    test('an extension that is not installed is named, and nothing is installed', async () => {
        const error = await refused(acquire(undefined));
        assert.strictEqual(error.code, 'TOOL_DISABLED');
        assert.strictEqual(error.message, 'source_find not attempted: the clangd extension (llvm-vs-code-extensions.vscode-clangd) is not installed or is disabled in this window.');
        assert.strictEqual(error.hint, 'It is part of the Keil Studio Pack: ask the user to install or enable it. Nothing is installed by this tool.');
    });

    test('an inactive extension is activated and its exports are used', async () => {
        const running = client('running');
        let activated = 0;
        const handle: ClangdExtensionHandle = {
            isActive: false,
            // As VS Code does for an extension that is not active.
            get exports(): unknown {
                throw new Error('Extension \'llvm-vs-code-extensions.vscode-clangd\' is not known or not activated');
            },
            activate: () => {
                activated++;
                return Promise.resolve({ getApi: () => ({ languageClient: running }) });
            },
        };
        assert.strictEqual(await acquire(handle), running);
        assert.strictEqual(activated, 1);
    });

    test('an activation that fails or does not end is a refusal of its own', async () => {
        const failing = await refused(acquire({ isActive: false, exports: undefined, version: '0.6.0', activate: () => Promise.reject(new Error('boom')) }));
        assert.strictEqual(failing.code, 'TASK_FAILED');
        assert.strictEqual(failing.message, 'source_find not attempted: the clangd extension 0.6.0 failed to activate (boom).');
        const hanging = await refused(acquire({ isActive: false, exports: undefined, activate: () => never() }));
        assert.strictEqual(hanging.code, 'TIMEOUT');
        assert.match(hanging.message, /the clangd extension did not finish activating within \d+(\.\d)? s\./);
    });

    test('an extension without the API, or without its version 1, is asked to be updated', async () => {
        const none = await refused(acquire({ isActive: true, exports: {}, version: '0.1.0', activate: () => Promise.resolve(undefined) }));
        assert.strictEqual(none.code, 'TOOL_DISABLED');
        assert.strictEqual(none.message, 'source_find not attempted: the clangd extension 0.1.0 offers no public API (no getApi).');
        const old = await refused(acquire({ isActive: true, activate: () => Promise.resolve(undefined), exports: { getApi: () => { throw new Error('No API version 1 found'); } } }));
        assert.strictEqual(old.code, 'TOOL_DISABLED');
        assert.match(old.message, /offers no API version 1 \(No API version 1 found\)\./);
        assert.strictEqual(old.hint, 'Ask the user to update the clangd extension.');
    });

    test('no client means clangd is switched off, or has no executable: the refusal says which, and downloads nothing', async () => {
        const off = await refused(acquire(extension(() => undefined), { enable: false, path: 'clangd' }));
        assert.strictEqual(off.code, 'TOOL_DISABLED');
        assert.strictEqual(off.message, 'source_find not attempted: clangd is switched off in this window (setting clangd.enable).');
        const missing = await refused(acquire(extension(() => undefined), { enable: true, path: '/opt/llvm/bin/clangd' }));
        assert.strictEqual(missing.code, 'TOOL_DISABLED');
        assert.strictEqual(missing.message,
            'source_find not attempted: the clangd extension has no language server, the executable \'/opt/llvm/bin/clangd\' (setting clangd.path) was not found.');
        assert.ok(missing.hint?.includes(`"${DOWNLOAD_COMMAND}"`) && missing.hint.endsWith('Nothing is downloaded by this tool.'));
    });

    test('a starting client is waited for, and a client replaced by a restart is the one handed out', async () => {
        const starting = client('starting', 3);
        assert.strictEqual(await acquire(extension(() => starting)), starting);
        assert.ok(starting.polls >= 4, `${starting.polls} polls`);
        const stopped = client('stopped');
        const fresh = client('running');
        let asked = 0;
        assert.strictEqual(await acquire(extension(() => (++asked > 2 ? fresh : stopped))), fresh);
    });

    test('a client that does not come up by the deadline is a TIMEOUT that says what state it is in', async () => {
        const starting = await refused(acquire(extension(() => client('starting')), SETTINGS, 2_000));
        assert.strictEqual(starting.code, 'TIMEOUT');
        assert.strictEqual(starting.message, 'source_find not attempted: clangd is still starting in this window.');
        assert.match(starting.hint ?? '', /repeat the call in a few seconds/);
        const stopped = await refused(acquire(extension(() => client('stopped')), SETTINGS, 2_000));
        assert.strictEqual(stopped.message, 'source_find not attempted: clangd is not running in this window.');
    });

    test('a client without isRunning is judged by its state', () => {
        assert.strictEqual(isRunning({ state: 2, sendRequest: () => Promise.resolve(null) }), true);
        assert.strictEqual(isRunning({ state: 3, sendRequest: () => Promise.resolve(null) }), false);
        assert.strictEqual(isRunning({ sendRequest: () => Promise.resolve(null) }), false);
    });
});
