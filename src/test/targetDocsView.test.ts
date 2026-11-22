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
 * The Target Documents view, as far as it can be asked without the editor:
 * when it shows (a csolution in the workspace, in either spelling, also one
 * made after activation) and which task's end makes it read the target's
 * documents again. The view itself is registered once per window by the
 * extension's activation, so the tests drive the two functions behind it
 * over a workspace of their own.
 */

import * as assert from 'assert';
import { LISTED_SOLUTION_GLOB, isSolutionFile } from '../core/bootstrapState';
import { SolutionSearch, followSolutions, mayChangeTarget } from '../targetDocsView';

/** A workspace whose files the test names; it records the searches and hands out the watchers' listeners. */
function fakeWorkspace(files: string[], options: { watchers?: boolean } = {}): {
    workspace: SolutionSearch; files: string[]; searches: string[][]; disposed: string[];
    created(): void; deleted(): void; foldersChanged(): void;
} {
    const searches: string[][] = [];
    const disposed: string[] = [];
    const listeners: Record<'create' | 'delete' | 'folders', Array<() => void>> = { create: [], delete: [], folders: [] };
    const listen = (kind: 'create' | 'delete' | 'folders') => (listener: () => void): { dispose(): void } => {
        listeners[kind].push(listener);
        return { dispose: () => { disposed.push(kind); } };
    };
    const workspace: SolutionSearch = {
        findFiles: async (include, exclude, maxResults) => {
            searches.push([include, exclude, String(maxResults)]);
            // As the glob `**/*.csolution.{yaml,yml}` finds them.
            return files.filter(isSolutionFile).slice(0, maxResults);
        },
        onDidChangeWorkspaceFolders: listen('folders'),
    };
    if (options.watchers !== false) {
        workspace.createFileSystemWatcher = (glob, ignoreCreate, ignoreChange, ignoreDelete) => {
            searches.push(['watch', glob, [ignoreCreate, ignoreChange, ignoreDelete].join(',')]);
            return { onDidCreate: listen('create'), onDidDelete: listen('delete'), dispose: () => { disposed.push('watcher'); } };
        };
    }
    const fire = (kind: 'create' | 'delete' | 'folders') => (): void => listeners[kind].forEach((listener) => listener());
    return { workspace, files, searches, disposed, created: fire('create'), deleted: fire('delete'), foldersChanged: fire('folders') };
}

/** Let the pending searches answer. */
async function settled(): Promise<void> {
    for (let round = 0; round < 5; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

suite('Target Documents view: when it shows and what reloads it', () => {
    test('a workspace whose only solution is a .csolution.yaml shows the view', async () => {
        const w = fakeWorkspace(['/w/Blinky/Blinky.csolution.yaml', '/w/Blinky/main.c']);
        const seen: boolean[] = [];
        followSolutions(w.workspace, (present) => seen.push(present));
        await settled();
        assert.deepStrictEqual(seen, [true]);
        assert.strictEqual(LISTED_SOLUTION_GLOB, '**/*.csolution.{yaml,yml}');
        assert.deepStrictEqual(w.searches, [['watch', LISTED_SOLUTION_GLOB, 'false,true,false'], [LISTED_SOLUTION_GLOB, '**/node_modules/**', '1']],
            'creations and deletions are watched, changes are not; one file is enough');
    });

    test('a csolution created after activation shows the view, the last one deleted hides it, and a folder that comes is searched', async () => {
        const w = fakeWorkspace(['/w/notes.txt']);
        const seen: boolean[] = [];
        const watching = followSolutions(w.workspace, (present) => seen.push(present));
        await settled();
        assert.deepStrictEqual(seen, [false]);
        w.files.push('/w/App/App.csolution.yml');
        w.created();
        await settled();
        assert.deepStrictEqual(seen, [false, true], 'create_solution into the open folder');
        w.files.length = 1;
        w.deleted();
        await settled();
        assert.deepStrictEqual(seen, [false, true, false]);
        w.files.push('/other/Other.csolution.yml');
        w.foldersChanged();
        await settled();
        assert.deepStrictEqual(seen, [false, true, false, true], 'a workspace folder added later');
        watching.forEach((item) => item.dispose());
        assert.deepStrictEqual(w.disposed.sort(), ['create', 'delete', 'folders', 'watcher']);
    });

    test('only the newest search answers, and a host without file watchers still searches', async () => {
        const answers: Array<(found: unknown[]) => void> = [];
        const seen: boolean[] = [];
        let foldersChanged: () => void = () => undefined;
        followSolutions({
            findFiles: () => new Promise<unknown[]>((resolve) => answers.push(resolve)),
            onDidChangeWorkspaceFolders: (listener) => { foldersChanged = listener; return { dispose: () => undefined }; },
        }, (present) => seen.push(present));
        foldersChanged();
        assert.strictEqual(answers.length, 2);
        answers[1](['/w/App.csolution.yml']);
        await settled();
        answers[0]([]);
        await settled();
        assert.deepStrictEqual(seen, [true], 'the older search, answered last, is not the state');
        const failing: boolean[] = [];
        followSolutions({ findFiles: () => Promise.reject(new Error('search service gone')) }, (present) => failing.push(present));
        await settled();
        assert.deepStrictEqual(failing, [], 'a failed search sets nothing and throws nothing');
    });

    test('the end of a task of CMSIS Solution\'s build type may mean another target; other tasks do not', () => {
        assert.strictEqual(mayChangeTarget({ definition: { type: 'cmsis-csolution.build', setup: true } as { type: string } }), true, 'cbuild setup after a target switch');
        assert.strictEqual(mayChangeTarget({ definition: { type: 'cmsis-csolution.build' } }), true, 'a build: it writes the cbuild-run file');
        assert.strictEqual(mayChangeTarget({ definition: { type: 'shell' } }), false);
        assert.strictEqual(mayChangeTarget({ definition: {} }), false);
        assert.strictEqual(mayChangeTarget({}), false);
        assert.strictEqual(mayChangeTarget(undefined), false);
    });
});
