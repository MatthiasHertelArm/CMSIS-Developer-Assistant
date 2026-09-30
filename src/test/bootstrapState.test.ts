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

// What an empty window lacks, as the refusals and status lines say it, and the csolution walk of open_solution.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    bootstrapStatusLines,
    isSolutionFile,
    liesInside,
    missingSolutionExtensionRefusal,
    noSolutionRefusal,
    noWorkspaceRefusal,
    samePath,
} from '../core/bootstrapState';
import { errorDetail, isErrorCode } from '../core/toolResult';
import { findSolutionFiles } from '../utils/solutionFiles';

suite('Bootstrap state', () => {
    test('NO_WORKSPACE is a code this version knows, and its refusal names open_solution and the bootstrap topic', () => {
        assert.ok(isErrorCode('NO_WORKSPACE'));
        const refusal = noWorkspaceRefusal('flash');
        assert.strictEqual(refusal.code, 'NO_WORKSPACE');
        assert.match(errorDetail(refusal), /^flash not attempted: no folder is open in this VS Code window/);
        assert.match(refusal.hint ?? '', /cmsis_action \{action:'open_solution', path:/);
        assert.match(refusal.hint ?? '', /get_debug_instructions \{topic:'bootstrap'\}/);
    });

    test('a missing CMSIS Solution extension is CMSIS_NO_SOLUTION with the pack to install', () => {
        const refusal = missingSolutionExtensionRefusal('CMSIS \'build\'');
        assert.strictEqual(refusal.code, 'CMSIS_NO_SOLUTION');
        assert.match(refusal.message, /Arm\.cmsis-csolution\) is not installed/);
        assert.match(refusal.hint ?? '', /Arm\.keil-studio-pack/);
    });

    test('no active solution: no csolution file, one the extension has not loaded, or an unknown workspace', () => {
        const none = noSolutionRefusal('CMSIS \'build\'', 'none', [], ['app', 'lib'], '2.5.9');
        assert.match(none.hint ?? '', /^The open folders \(app, lib\) contain no \*\.csolution\.yml\./);
        const several = noSolutionRefusal('CMSIS \'build\'', 'none', ['/w/a.csolution.yml', '/w/b.csolution.yml'], ['w'], '2.5.9');
        assert.match(several.hint ?? '', /^A solution file exists: \/w\/a\.csolution\.yml \(and 1 more\)\./);
        assert.match(several.hint ?? '', /open_solution', path:'\/w\/a\.csolution\.yml'\} activates it/);
        const unknown = noSolutionRefusal('CMSIS \'build\'', 'none', undefined, ['w'], '2.5.9');
        assert.match(unknown.hint ?? '', /serverVersion=2\.5\.9/);
        for (const refusal of [none, several, unknown]) {
            assert.strictEqual(refusal.code, 'CMSIS_NO_SOLUTION');
            assert.match(refusal.message, /reports no active solution in this VS Code window \(cmsis-csolution\.getSolutionFile → none\)\.$/);
        }
    });

    test('status lines: only for a window without a folder, the extensions only when missing', () => {
        assert.deepStrictEqual(bootstrapStatusLines({ folders: 1, solutionExtension: false, debuggerExtension: false }), []);
        const bare = bootstrapStatusLines({ folders: 0, solutionExtension: true, debuggerExtension: true });
        assert.strictEqual(bare.length, 1);
        assert.match(bare[0], /^Workspace: no folder is open in this VS Code window\./);
        const lines = bootstrapStatusLines({ folders: 0, solutionExtension: true, debuggerExtension: false });
        assert.strictEqual(lines.length, 2);
        assert.match(lines[1], /^Extensions: CMSIS Debugger \(Arm\.vscode-cmsis-debugger\) not installed/);
    });

    test('solution file names and path comparison follow the platform', () => {
        assert.ok(isSolutionFile('/w/Blinky.csolution.yml'));
        assert.ok(isSolutionFile('C:\\w\\Blinky.CSOLUTION.YAML'));
        assert.ok(!isSolutionFile('/w/Blinky.cproject.yml'));
        assert.ok(!isSolutionFile('/w/csolution.yml.bak'));
        const base = path.join(os.tmpdir(), 'Project');
        assert.ok(samePath(base, `${base}${path.sep}`));
        assert.ok(samePath(base, base.toUpperCase(), 'win32'));
        assert.ok(!samePath(base, base.toUpperCase(), 'linux') || base === base.toUpperCase());
        assert.ok(liesInside(path.join(base, 'app', 'main.c'), base));
        assert.ok(liesInside(base, base));
        assert.ok(!liesInside(`${base}-other`, base));
        assert.ok(!liesInside(path.dirname(base), base));
    });

    suite('the csolution walk', () => {
        let root: string;
        setup(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-walk-'));
        });
        teardown(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });
        const touch = (...parts: string[]): string => {
            const file = path.join(root, ...parts);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
            return file;
        };

        test('nearest first, three levels deep, skipping hidden folders and build output', () => {
            const top = touch('Top.csolution.yml');
            const nested = touch('examples', 'blinky', 'Blinky.csolution.yaml');
            const deep = touch('a', 'b', 'c', 'Deep.csolution.yml');
            touch('a', 'b', 'c', 'd', 'TooDeep.csolution.yml');
            touch('out', 'Copy.csolution.yml');
            touch('.git', 'Hidden.csolution.yml');
            touch('node_modules', 'pkg', 'Dep.csolution.yml');
            touch('notes.csolution.yml.txt');
            assert.deepStrictEqual(findSolutionFiles(root), [top, nested, deep]);
        });

        test('an empty or unreadable folder has none, and the list stops at ten', () => {
            assert.deepStrictEqual(findSolutionFiles(root), []);
            assert.deepStrictEqual(findSolutionFiles(path.join(root, 'absent')), []);
            for (let index = 0; index < 14; index++) {
                touch(`s${String(index).padStart(2, '0')}.csolution.yml`);
            }
            assert.strictEqual(findSolutionFiles(root).length, 10);
        });
    });
});
