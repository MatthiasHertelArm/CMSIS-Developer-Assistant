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
 * Asking the CMSIS Solution extension what it knows about its active target
 * instead of guessing it: the `cbuild-run.yml` (`getCbuildRunFile`) and the
 * folders of the target's DFP and BSP (`getDfpPath`, `getBspPath`), and for
 * `get_session_status` the active csolution (`getSolutionFile`). These are
 * getters of its API version 3, asked by name (`peekSolutionApi`, which
 * neither activates the extension nor throws). The hidden commands of the
 * same meaning, which 1.72.0 had instead, are not asked any more: an
 * extension without API version 3 gives no answer here. A getter is asked
 * only while the extension is active: it has no solution loaded before. An
 * inactive extension, a missing getter, a failed or slow answer (3 s) all
 * come back as no answer, and the callers keep their own lookup as the
 * fallback. The answers are interpreted by `src/core/solutionAnswers.ts`.
 */

import * as vscode from 'vscode';
import { SOLUTION_EXTENSION_ID } from '../core/bootstrapState';
import { ActivePackFolders, activeTargetSetOf, cbuildRunFileOf, packFolderOf, solutionAnswerOf, type SolutionFileAnswer } from '../core/solutionAnswers';
import { peekSolutionApi, v3Method, type SolutionApi, type SolutionApiV3Methods } from '../core/solutionApi';
import { logger } from './logger';
import { withTimeout } from './timeout';

/** The getters of CMSIS Solution's API version 3 that are asked here, by their names. */
export type SolutionGetter = 'getSolutionFile' | 'getActiveTarget' | 'getDeviceName' | 'getBoardName' | 'getDfpName' | 'getBspName'
    | 'getDfpPath' | 'getBspPath' | 'getPackRootPath' | 'getCbuildRunFile';

/** How long one question may take. */
export const SOLUTION_QUERY_MS = 3_000;

/** What the questions need from VS Code; the tests hand in their own. */
export interface SolutionSource {
    /** Whether the CMSIS Solution extension is installed and active. */
    extensionActive(): boolean;
    /** The extension's API version 3 without activating it (`peekSolutionApi`); undefined when it offers none. */
    api(): SolutionApi | undefined;
    /** The fence of one question; {@link SOLUTION_QUERY_MS} when absent. */
    timeoutMs?: number;
}

/** VS Code itself, looked up per call. */
export const VSCODE_SOLUTION_SOURCE: SolutionSource = {
    extensionActive: () => vscode.extensions.getExtension(SOLUTION_EXTENSION_ID)?.isActive === true,
    api: () => peekSolutionApi(vscode.extensions.getExtension(SOLUTION_EXTENSION_ID)),
};

/** The getter `name` of API version 3, when the source's API offers it. */
function getterOf(name: SolutionGetter, source: SolutionSource): SolutionApiV3Methods[SolutionGetter] | undefined {
    try {
        return v3Method(source.api(), name);
    } catch {
        return undefined;
    }
}

/** What one getter said, kept apart from no answer at all: `getSolutionFile` answers `undefined` for "no solution". */
type SolutionReply = { answered: true; value: unknown } | { answered: false };

/** One getter of API version 3, asked as the module comment says. Never throws. */
async function replyOf(name: SolutionGetter, source: SolutionSource): Promise<SolutionReply> {
    try {
        if (!source.extensionActive()) {
            return { answered: false };
        }
        const getter = getterOf(name, source);
        if (getter === undefined) {
            logger.debug(`${name}: not offered by this CMSIS Solution version`);
            return { answered: false };
        }
        return await withTimeout(`cmsis ${name}`, source.timeoutMs ?? SOLUTION_QUERY_MS,
            async (): Promise<SolutionReply> => ({ answered: true, value: await getter() }));
    } catch (caught) {
        logger.debug(`${name}: no answer (${caught instanceof Error ? caught.message : String(caught)})`);
        return { answered: false };
    }
}

/**
 * The getter's answer from API version 3; undefined when the extension
 * offers no API version 3 or not that getter. For the callers that keep
 * their own fence and activation rule; may reject as the getter does.
 */
export function solutionGetter(name: SolutionGetter, source: SolutionSource = VSCODE_SOLUTION_SOURCE): Thenable<unknown> {
    const getter = getterOf(name, source);
    return getter !== undefined ? Promise.resolve(getter()) : Promise.resolve(undefined);
}

/**
 * The answer of one getter of API version 3; undefined when the extension
 * is not active, does not offer it, fails or does not answer in time.
 * Never throws.
 */
export async function askSolution(name: SolutionGetter, source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<unknown> {
    const reply = await replyOf(name, source);
    return reply.answered ? reply.value : undefined;
}

/**
 * Which csolution the extension has active in this window (#124): a file,
 * or none. Undefined when the extension gave no answer, as for every getter
 * here; that is not the same as "none". Never throws.
 */
export async function activeSolutionAnswer(source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<SolutionFileAnswer | undefined> {
    const reply = await replyOf('getSolutionFile', source);
    return reply.answered ? solutionAnswerOf(reply.value) : undefined;
}

/** What CMSIS Solution says about the target of its active solution (#141). */
export interface ActiveTargetAnswer {
    /** The active target set, `type` or `type@set`; absent when none is selected. */
    active?: string;
    /** Every target set the solution declares, in its order, from `getTargets` of API version 3; absent without it. */
    declared?: string[];
}

/**
 * The active target set of the extension's active solution and, where API
 * version 3 lists them, the target sets the solution declares (#141).
 * Undefined when the extension gave no answer. Never throws.
 */
export async function activeTargetAnswer(source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<ActiveTargetAnswer | undefined> {
    const reply = await replyOf('getActiveTarget', source);
    if (!reply.answered) {
        return undefined;
    }
    const active = activeTargetSetOf(reply.value);
    let declared: string[] | undefined;
    try {
        const getTargets = v3Method(source.api(), 'getTargets');
        if (getTargets) {
            const listed: unknown = await withTimeout('cmsis getTargets', source.timeoutMs ?? SOLUTION_QUERY_MS, () => Promise.resolve(getTargets()));
            if (Array.isArray(listed)) {
                declared = listed.filter((name): name is string => typeof name === 'string' && name.length > 0);
            }
        }
    } catch (caught) {
        logger.debug(`getTargets: no answer (${caught instanceof Error ? caught.message : String(caught)})`);
    }
    return { ...(active !== undefined ? { active } : {}), ...(declared !== undefined ? { declared } : {}) };
}

/**
 * The `cbuild-run.yml` of the extension's active target as it answers;
 * whether it exists is the caller's check. The one lookup of it: `flash`,
 * `cmsis_action` and the documentation tools ask here, through their hosts.
 */
export async function activeCbuildRunFile(source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<string | undefined> {
    return cbuildRunFileOf(await askSolution('getCbuildRunFile', source));
}

/** The folders the extension names for the active target's DFP and BSP; empty when it names none. */
export async function activePackFolders(source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<ActivePackFolders> {
    if (!safelyActive(source)) {
        return {};
    }
    const [dfp, bsp] = await Promise.all([askSolution('getDfpPath', source), askSolution('getBspPath', source)]);
    const folders: ActivePackFolders = {};
    const dfpFolder = packFolderOf(dfp);
    const bspFolder = packFolderOf(bsp);
    if (dfpFolder) {
        folders.dfp = dfpFolder;
    }
    if (bspFolder) {
        folders.bsp = bspFolder;
    }
    return folders;
}

/** How long `getToolsEnvironment` may take: it waits for Arm Tools to activate. */
export const TOOLS_ENVIRONMENT_MS = 5_000;
/** The last environment API version 3 answered, for the synchronous readers; never logged. */
let lastToolsEnvironment: string | undefined;
let toolsEnvironmentAsk: Promise<string | undefined> | undefined;

/**
 * The window's tools environment as CMSIS Solution's API version 3 answers
 * it (`getToolsEnvironment`, the text of a tools-environment.yml generated
 * fresh), for the readers whose `.cmsis/tools-environment.yml` is missing
 * because the solution was never converted. Only then: the file comes first.
 * Measured (test/measure/solution-api, 2026-11-16), the API is fast (about
 * 1 ms, 0.2–0.3 s for the first call of a window) but can be poorer than
 * the file: until the Environment Manager activates the project's vcpkg
 * tools it answers without them, while a file from an earlier conversion
 * lists them. An activation rewrites the file and drops the cached answer. Undefined without version 3, an
 * inactive extension, or no answer within {@link TOOLS_ENVIRONMENT_MS}.
 * Never throws; the text holds expanded variables and is never logged.
 */
export function apiToolsEnvironment(source: SolutionSource = VSCODE_SOLUTION_SOURCE, ms: number = TOOLS_ENVIRONMENT_MS): Promise<string | undefined> {
    if (toolsEnvironmentAsk !== undefined) {
        return toolsEnvironmentAsk;
    }
    const ask = (async (): Promise<string | undefined> => {
        try {
            if (!safelyActive(source)) {
                return undefined;
            }
            const getter = v3Method(source.api(), 'getToolsEnvironment');
            if (getter === undefined) {
                return undefined;
            }
            const text: unknown = await withTimeout('cmsis getToolsEnvironment', ms, () => Promise.resolve(getter()));
            if (typeof text === 'string' && text.trim().length > 0) {
                lastToolsEnvironment = text;
                return text;
            }
            return undefined;
        } catch (caught) {
            logger.debug(`getToolsEnvironment: no answer (${caught instanceof Error ? caught.message : String(caught)})`);
            return undefined;
        }
    })();
    toolsEnvironmentAsk = ask;
    // Cleared here, after the assignment, and not in a `finally` of the ask:
    // an ask that ends before its first await (inactive extension, no
    // version 3) would clear the slot before it is filled, and every later
    // call would get that settled promise. Only the ask that still holds the
    // slot clears it; `ask` never rejects.
    void ask.finally(() => {
        if (toolsEnvironmentAsk === ask) {
            toolsEnvironmentAsk = undefined;
        }
    });
    return ask;
}

/**
 * The environment the API answered last, for a synchronous reader, and a
 * fresh ask started for the next one. Undefined until an ask succeeded.
 */
export function cachedApiToolsEnvironment(source: SolutionSource = VSCODE_SOLUTION_SOURCE): string | undefined {
    void apiToolsEnvironment(source);
    return lastToolsEnvironment;
}

/** Forget the cached environment: after an activation that rewrote the file, and between tests. */
export function resetApiToolsEnvironment(): void {
    lastToolsEnvironment = undefined;
    toolsEnvironmentAsk = undefined;
}

/**
 * The active target's device and board as API version 3 names them
 * (`getDeviceName`, `getBoardName`): the keys of CMSIS Solution's document
 * inventory. Empty without version 3.
 */
export async function activeHardwareNames(source: SolutionSource = VSCODE_SOLUTION_SOURCE): Promise<{ device?: string; board?: string }> {
    const api = safelyActive(source) ? source.api() : undefined;
    const ask = async (name: 'getDeviceName' | 'getBoardName'): Promise<string | undefined> => {
        const getter = v3Method(api, name);
        if (getter === undefined) {
            return undefined;
        }
        try {
            const value: unknown = await withTimeout(`cmsis ${name}`, source.timeoutMs ?? SOLUTION_QUERY_MS, () => Promise.resolve(getter()));
            return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
        } catch {
            return undefined;
        }
    };
    const [device, board] = await Promise.all([ask('getDeviceName'), ask('getBoardName')]);
    return { ...(device ? { device } : {}), ...(board ? { board } : {}) };
}

function safelyActive(source: SolutionSource): boolean {
    try {
        return source.extensionActive();
    } catch {
        return false;
    }
}
