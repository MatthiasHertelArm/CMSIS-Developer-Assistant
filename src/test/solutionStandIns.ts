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
 * Test support: the getters of CMSIS Solution's API version 3, served to the
 * code under test. The test host has no CMSIS Solution extension, and the
 * getters are asked through the default source of `solutionQueries.ts`
 * (`VSCODE_SOLUTION_SOURCE`), which looks the extension up in VS Code. A
 * test puts its own answers behind that source for as long as it runs.
 *
 * Many tests script the extension by the ids its hidden commands had in
 * 1.72.0 (`cmsis-csolution.getSolutionFile`, ...). `GETTER_OF_COMMAND` names
 * the getter that answers the same, so that one table of stand-ins serves
 * both the actions, which are still commands, and the getters, which are
 * not.
 */

import * as vscode from 'vscode';
import type { SolutionApi } from '../core/solutionApi';
import { VSCODE_SOLUTION_SOURCE, type SolutionGetter } from '../utils/solutionQueries';

/** The getter of API version 3 that answers what the hidden command of that id answered in CMSIS Solution 1.72.0. */
export const GETTER_OF_COMMAND: Readonly<Record<string, SolutionGetter>> = {
    'cmsis-csolution.getSolutionFile': 'getSolutionFile',
    'cmsis-csolution.getActiveTargetSet': 'getActiveTarget',
    'cmsis-csolution.getDeviceName': 'getDeviceName',
    'cmsis-csolution.getBoardName': 'getBoardName',
    'cmsis-csolution.getDfpName': 'getDfpName',
    'cmsis-csolution.getBspName': 'getBspName',
    'cmsis-csolution.getDfpPath': 'getDfpPath',
    'cmsis-csolution.getBspPath': 'getBspPath',
    'cmsis-csolution.getPackRootPath': 'getPackRootPath',
    'cmsis-csolution.getCbuildRunFile': 'getCbuildRunFile',
};

/**
 * Serve `getters`, by their names in API version 3, as the API of the CMSIS
 * Solution extension to the callers that ask a getter directly
 * (`solutionGetter`). The source keeps reporting the extension as not
 * active, as the test host has none: the lookups that ask only an active
 * extension stay unanswered, unless a test hands in a source of its own.
 * Disposing the result puts back what the source answered before, so the
 * calls nest.
 */
export function serveSolutionGetters(getters: Record<string, () => unknown>): vscode.Disposable {
    const { api } = VSCODE_SOLUTION_SOURCE;
    const served: Record<string, () => Promise<unknown>> = {};
    for (const [name, answer] of Object.entries(getters)) {
        served[name] = async () => answer();
    }
    VSCODE_SOLUTION_SOURCE.api = () => served as unknown as SolutionApi;
    return new vscode.Disposable(() => {
        VSCODE_SOLUTION_SOURCE.api = api;
    });
}

/**
 * Stand-ins for the CMSIS Solution extension, keyed by the ids of its
 * commands: an id that `GETTER_OF_COMMAND` knows is served as its getter of
 * API version 3 and is not registered as a command, so a test fails when the
 * code under test still runs it; every other id is registered as a command.
 * Dispose the result afterwards.
 */
export function standInsFor(handlers: Record<string, (...args: unknown[]) => unknown>): vscode.Disposable {
    const getters: Record<string, () => unknown> = {};
    const commands: vscode.Disposable[] = [];
    for (const [id, run] of Object.entries(handlers)) {
        const getter = GETTER_OF_COMMAND[id];
        if (getter !== undefined) {
            getters[getter] = () => run();
        } else {
            commands.push(vscode.commands.registerCommand(id, run));
        }
    }
    return vscode.Disposable.from(serveSolutionGetters(getters), ...commands);
}
