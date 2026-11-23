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

// What the CMSIS Solution extension's getter answers mean, and when they are not asked:
// an inactive extension, a missing getter, an empty answer, a timeout, "<not found>".

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';
import {
    activeTargetSetOf,
    cbuildRunFileOf,
    packFolderCandidates,
    packFolderOf,
    solutionAnswerOf,
    solutionFileOf,
    solutionNameOf,
    targetTypeOf,
} from '../core/solutionAnswers';
import type { SolutionApi } from '../core/solutionApi';
import {
    activeCbuildRunFile,
    activePackFolders,
    activeSolutionAnswer,
    askSolution,
    SolutionSource,
} from '../utils/solutionQueries';

/** The getters of CMSIS Solution's API version 3 that these tests script. */
const GET_BSP_PATH = 'getBspPath';
const GET_CBUILD_RUN_FILE = 'getCbuildRunFile';
const GET_DFP_PATH = 'getDfpPath';
const GET_SOLUTION_FILE = 'getSolutionFile';

const RUN_FILE = path.resolve('/w/Blinky+HW.cbuild-run.yml');

/**
 * A CMSIS Solution extension whose API version 3 answers from `answers`; `asked` records the getters that ran.
 * `registered` names the getters the API offers, when they are not those of `answers`.
 */
function stubCommands(answers: Record<string, () => unknown>, options: { active?: boolean; registered?: string[]; timeoutMs?: number } = {}): {
    source: SolutionSource; asked: string[];
} {
    const asked: string[] = [];
    const api: Record<string, () => Promise<unknown>> = {};
    for (const name of options.registered ?? Object.keys(answers)) {
        api[name] = async () => {
            asked.push(name);
            return answers[name]?.();
        };
    }
    const source: SolutionSource = {
        extensionActive: () => options.active ?? true,
        api: () => api as unknown as SolutionApi,
        timeoutMs: options.timeoutMs,
    };
    return { source, asked };
}

suite('CMSIS Solution answers', () => {
    test('getSolutionFile: a path, an object that names one, or none', () => {
        assert.strictEqual(solutionFileOf('/w/Blinky.csolution.yml'), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf(' /w/Blinky.csolution.yml '), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ solutionFile: '/w/Blinky.csolution.yml' }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ uri: { fsPath: '/w/Blinky.csolution.yml' } }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf({ uri: { path: '/w/Blinky.csolution.yml' } }), '/w/Blinky.csolution.yml');
        assert.strictEqual(solutionFileOf(''), undefined, 'no solution loaded');
        assert.strictEqual(solutionFileOf({}), undefined);
        assert.strictEqual(solutionFileOf(null), undefined);
        assert.strictEqual(solutionFileOf(undefined), undefined);

        assert.deepStrictEqual(solutionAnswerOf('/w/Blinky.csolution.yml'), { active: true, file: '/w/Blinky.csolution.yml' });
        assert.deepStrictEqual(solutionAnswerOf({}), { active: true }, 'an object without a path: active, path unknown');
        assert.deepStrictEqual(solutionAnswerOf(42), { active: true });
        for (const none of ['', '  ', undefined, null, false, 0]) {
            assert.deepStrictEqual(solutionAnswerOf(none), { active: false }, JSON.stringify(none));
        }
        assert.strictEqual(solutionNameOf('/w/Blinky.csolution.yml'), 'Blinky');
        assert.strictEqual(solutionNameOf({ fsPath: '/w/Blinky.csolution.yaml' }), 'Blinky');
        assert.strictEqual(solutionNameOf(''), undefined);
    });

    test('getActiveTargetSet: the set, its target-type, or none', () => {
        assert.strictEqual(activeTargetSetOf(' HW@Debug '), 'HW@Debug');
        assert.strictEqual(activeTargetSetOf(''), undefined);
        assert.strictEqual(activeTargetSetOf({ set: 'HW' }), undefined);
        assert.strictEqual(targetTypeOf('HW@Debug'), 'HW');
        assert.strictEqual(targetTypeOf('HW'), 'HW');
        assert.strictEqual(targetTypeOf('@Debug'), undefined);
        assert.strictEqual(targetTypeOf(undefined), undefined);
    });

    test('getCbuildRunFile counts only as an absolute path; "" and a relative answer are none', () => {
        assert.strictEqual(cbuildRunFileOf(RUN_FILE), RUN_FILE);
        assert.strictEqual(cbuildRunFileOf(` ${RUN_FILE} `), RUN_FILE);
        assert.strictEqual(cbuildRunFileOf(''), undefined);
        assert.strictEqual(cbuildRunFileOf('out/Blinky+HW.cbuild-run.yml'), undefined);
        assert.strictEqual(cbuildRunFileOf(undefined), undefined);
        assert.strictEqual(cbuildRunFileOf({ fsPath: RUN_FILE }), undefined);
    });

    test('getDfpPath and getBspPath: "<not found>" and "" are none; a relative folder is resolved against each base', () => {
        assert.strictEqual(packFolderOf('<not found>'), undefined);
        assert.strictEqual(packFolderOf(' <not found> '), undefined);
        assert.strictEqual(packFolderOf(''), undefined);
        assert.strictEqual(packFolderOf(undefined), undefined);
        assert.strictEqual(packFolderOf('/packs/Keil/X/1.0.0'), '/packs/Keil/X/1.0.0');
        const absolute = path.resolve('/packs/Keil/X/1.0.0');
        assert.deepStrictEqual(packFolderCandidates(absolute, [path.resolve('/w')]), [absolute]);
        const bases = [path.resolve('/w/out/app/HW/Debug'), path.resolve('/w/out/lib/HW/Debug'), path.resolve('/w/out/app/HW/Debug')];
        assert.deepStrictEqual(packFolderCandidates('../../../../packs/X', bases), [path.resolve('/w/packs/X')],
            'the cbuild.yml files of one target lie at the same depth: one candidate');
        assert.deepStrictEqual(packFolderCandidates('../X', [path.resolve('/w/a'), path.resolve('/w/b/c')]), [path.resolve('/w/X'), path.resolve('/w/b/X')]);
        assert.deepStrictEqual(packFolderCandidates('../X', []), []);
    });

    test('the getters are asked while the extension is active and its API has them', async () => {
        const { source, asked } = stubCommands({
            [GET_CBUILD_RUN_FILE]: () => RUN_FILE,
            [GET_DFP_PATH]: () => '/packs/Keil/STM32F7xx_DFP/3.0.0',
            [GET_BSP_PATH]: () => '../../../../bsp',
        });
        assert.strictEqual(await activeCbuildRunFile(source), RUN_FILE);
        assert.deepStrictEqual(await activePackFolders(source), { dfp: '/packs/Keil/STM32F7xx_DFP/3.0.0', bsp: '../../../../bsp' });
        assert.deepStrictEqual(asked.sort(), [GET_BSP_PATH, GET_CBUILD_RUN_FILE, GET_DFP_PATH]);
    });

    test('an inactive extension is not asked: it has no solution loaded', async () => {
        const { source, asked } = stubCommands({ [GET_CBUILD_RUN_FILE]: () => RUN_FILE, [GET_DFP_PATH]: () => '/p' }, { active: false });
        assert.strictEqual(await activeCbuildRunFile(source), undefined);
        assert.deepStrictEqual(await activePackFolders(source), {});
        assert.deepStrictEqual(asked, []);
        const throwing: SolutionSource = { ...source, extensionActive: () => { throw new Error('no extension API'); } };
        assert.strictEqual(await activeCbuildRunFile(throwing), undefined);
        assert.deepStrictEqual(await activePackFolders(throwing), {});
    });

    test('a CMSIS Solution version without the getter is not asked', async () => {
        const { source, asked } = stubCommands({ [GET_CBUILD_RUN_FILE]: () => RUN_FILE }, { registered: ['getSolutionFile'] });
        assert.strictEqual(await activeCbuildRunFile(source), undefined);
        assert.deepStrictEqual(await activePackFolders(source), {});
        assert.deepStrictEqual(asked, [], 'found by name, not by a call that fails');
    });

    test('"", "<not found>", a failing getter and a timeout are no answer', async () => {
        const empty = stubCommands({ [GET_CBUILD_RUN_FILE]: () => '', [GET_DFP_PATH]: () => '<not found>', [GET_BSP_PATH]: () => '' });
        assert.strictEqual(await activeCbuildRunFile(empty.source), undefined);
        assert.deepStrictEqual(await activePackFolders(empty.source), {});

        const failing = stubCommands({ [GET_CBUILD_RUN_FILE]: () => { throw new Error('no solution'); } });
        assert.strictEqual(await activeCbuildRunFile(failing.source), undefined);

        const slow = stubCommands({
            [GET_CBUILD_RUN_FILE]: () => new Promise(() => { /* never answers */ }),
            [GET_DFP_PATH]: () => new Promise(() => { /* never answers */ }),
            [GET_BSP_PATH]: () => '/bsp',
        }, { timeoutMs: 50 });
        const started = Date.now();
        assert.strictEqual(await activeCbuildRunFile(slow.source), undefined);
        assert.deepStrictEqual(await activePackFolders(slow.source), { bsp: '/bsp' }, 'the answer that came is kept');
        assert.ok(Date.now() - started < 2_000, 'the fence, not the getter, ends the wait');

        const unreadable: SolutionSource = { ...empty.source, api: () => { throw new Error('the extension is gone'); } };
        assert.strictEqual(await askSolution(GET_CBUILD_RUN_FILE, unreadable), undefined, 'an API that cannot be read is no answer');
        const withoutApi: SolutionSource = { ...empty.source, api: () => undefined };
        assert.strictEqual(await askSolution(GET_CBUILD_RUN_FILE, withoutApi), undefined, 'CMSIS Solution 1.72.0: no API version 3, no answer');
    });

    test('in this VS Code, without the CMSIS Solution extension, a stand-in of the hidden command of 1.72.0 is never run', async () => {
        let ran = 0;
        const stand = vscode.commands.registerCommand('cmsis-csolution.getCbuildRunFile', () => { ran++; return RUN_FILE; });
        try {
            assert.strictEqual(await activeCbuildRunFile(), undefined);
            assert.strictEqual(ran, 0);
        } finally {
            stand.dispose();
        }
    });

    test('the active solution: a file or none is an answer; no answer stays apart from "none" (#124)', async () => {
        const file = path.resolve('/w/Blinky.csolution.yml');
        assert.deepStrictEqual(await activeSolutionAnswer(stubCommands({ [GET_SOLUTION_FILE]: () => file }).source), { active: true, file });
        for (const none of ['', undefined]) {
            const { source, asked } = stubCommands({ [GET_SOLUTION_FILE]: () => none });
            assert.deepStrictEqual(await activeSolutionAnswer(source), { active: false }, `${JSON.stringify(none)} means no solution is loaded`);
            assert.deepStrictEqual(asked, [GET_SOLUTION_FILE]);
        }

        const inactive = stubCommands({ [GET_SOLUTION_FILE]: () => file }, { active: false });
        assert.strictEqual(await activeSolutionAnswer(inactive.source), undefined);
        assert.deepStrictEqual(inactive.asked, [], 'an inactive extension is not asked');
        const unoffered = stubCommands({ [GET_SOLUTION_FILE]: () => file }, { registered: [GET_CBUILD_RUN_FILE] });
        assert.strictEqual(await activeSolutionAnswer(unoffered.source), undefined);
        assert.deepStrictEqual(unoffered.asked, []);
        const failing = stubCommands({ [GET_SOLUTION_FILE]: () => { throw new Error('not ready'); } });
        assert.strictEqual(await activeSolutionAnswer(failing.source), undefined);
        const slow = stubCommands({ [GET_SOLUTION_FILE]: () => new Promise(() => { /* never answers */ }) }, { timeoutMs: 50 });
        assert.strictEqual(await activeSolutionAnswer(slow.source), undefined, 'the fence ends the wait');
        assert.strictEqual(await askSolution(GET_SOLUTION_FILE, stubCommands({ [GET_SOLUTION_FILE]: () => file }).source), file,
            'askSolution answers the value as before');
    });
});
