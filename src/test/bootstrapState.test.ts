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

// What an empty window lacks, as the refusals and status lines say it; the active-solution line; path comparison, the CMSIS Solution extension's csolution search, the csolution walk, the project root of open_solution and the note on a .vscode.d drop-in CMSIS Solution does not read.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    bootstrapStatusLines,
    isSolutionFile,
    liesInside,
    LISTED_SOLUTION_GLOB,
    listedSolutionExclude,
    missingSolutionExtensionRefusal,
    noSolutionRefusal,
    noWorkspaceRefusal,
    projectRootOf,
    samePath,
    solutionStatusLine,
    strayDropInNote,
    targetStatusLine,
} from '../core/bootstrapState';
import type { SolutionFileAnswer } from '../core/solutionAnswers';
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
            assert.match(refusal.message, /reports no active solution in this VS Code window \(getSolutionFile → none\)\.$/);
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

    test('the active-target line: the target set and the declared ones, as cmsis_action takes them (#141)', () => {
        assert.strictEqual(targetStatusLine({ active: 'STM32F407VGTx@console', declared: ['STM32F407VGTx@console', 'STM32F407VGTx@file-io'] }),
            'Active target: STM32F407VGTx@console (declared: STM32F407VGTx@console, STM32F407VGTx@file-io)');
        assert.strictEqual(targetStatusLine({ active: 'MPS3' }), 'Active target: MPS3', 'the list is not known');
        assert.strictEqual(targetStatusLine({ active: 'MPS3', declared: [] }), 'Active target: MPS3');
        assert.strictEqual(targetStatusLine({ declared: ['HE', 'HP'] }), 'Active target: none selected (declared: HE, HP)');
        assert.strictEqual(targetStatusLine({}), undefined, 'nothing known, nothing said');
        const many = Array.from({ length: 15 }, (_, index) => `T${index}`);
        assert.strictEqual(targetStatusLine({ active: 'T0', declared: [...many, 'T0'] }),
            `Active target: T0 (declared: ${many.slice(0, 12).join(', ')}, … 3 more)`, 'at most twelve, a repeated name once');
    });

    test('the active-solution line: the csolution and its innermost workspace folder, none, or nothing to say (#124)', () => {
        const folders = ['/w/repo', '/w/repo/app', '/w/other'];
        const line = (answer: SolutionFileAnswer | undefined, lastKnown?: string, open: readonly string[] = folders): string | undefined =>
            solutionStatusLine({ answer, lastKnown, folders: open }, 'linux');
        assert.strictEqual(line({ active: true, file: '/w/repo/app/Blinky.csolution.yml' }),
            'Active solution: /w/repo/app/Blinky.csolution.yml (workspace folder /w/repo/app)');
        assert.strictEqual(line({ active: true, file: '/w/repo/lib/Blinky.csolution.yml' }),
            'Active solution: /w/repo/lib/Blinky.csolution.yml (workspace folder /w/repo)', 'a csolution below the folder');
        assert.strictEqual(line({ active: true, file: '/x/Blinky.csolution.yml' }),
            'Active solution: /x/Blinky.csolution.yml (in no open workspace folder)');
        assert.strictEqual(solutionStatusLine({ answer: { active: true, file: 'C:\\W\\Repo\\Blinky.csolution.yml' }, folders: ['c:\\w\\repo'] }, 'win32'),
            'Active solution: C:\\W\\Repo\\Blinky.csolution.yml (workspace folder c:\\w\\repo)', 'compared as the platform compares');
        assert.strictEqual(line({ active: false }), 'Active solution: none in this VS Code window');
        assert.strictEqual(line({ active: false }, undefined, []), undefined, 'the Workspace line says what an empty window lacks');
        assert.strictEqual(line({ active: true }), undefined, 'active, but no file named: nothing to name');
        assert.strictEqual(line(undefined), undefined, 'no answer is not "none"');

        // Without an answer in time, the csolution the window published last, said to be that (a switch may be under way).
        assert.strictEqual(line(undefined, '/w/repo/Blinky.csolution.yml'),
            'Active solution: /w/repo/Blinky.csolution.yml (workspace folder /w/repo; last known, CMSIS Solution did not answer just now)');
        assert.strictEqual(line({ active: false }, '/w/repo/Blinky.csolution.yml'), 'Active solution: none in this VS Code window',
            'an answer in time wins over the last known one');
        assert.strictEqual(line({ active: true, file: '/w/other/New.csolution.yml' }, '/w/repo/Blinky.csolution.yml'),
            'Active solution: /w/other/New.csolution.yml (workspace folder /w/other)');
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

    test('the platform named decides the path syntax and the letter case, whatever the host is', () => {
        // Windows: separators, the drive letter and the letter case do not count.
        assert.ok(samePath('C:/Work/App/Blinky.csolution.yml', 'c:\\work\\app\\Blinky.csolution.yml', 'win32'));
        assert.ok(liesInside('C:/Work/App/Blinky.csolution.yml', 'c:\\work', 'win32'));
        assert.ok(liesInside('c:\\work', 'C:/Work/', 'win32'));
        assert.ok(liesInside('C:\\w\\app', 'c:\\', 'win32'));
        assert.ok(!liesInside('C:/Work2/Blinky.csolution.yml', 'c:\\work', 'win32'));
        assert.ok(!liesInside('D:/work/Blinky.csolution.yml', 'c:\\work', 'win32'));
        // macOS: the letter case does not count, in the folder's own part either.
        assert.ok(samePath('/Users/me/Work/Blinky.csolution.yml', '/users/me/work/blinky.csolution.yml', 'darwin'));
        assert.ok(liesInside('/Users/me/WORK/app/Blinky.csolution.yml', '/Users/me/work', 'darwin'));
        assert.ok(!liesInside('/Users/me/work-other/Blinky.csolution.yml', '/Users/me/work', 'darwin'));
        // Linux: it does.
        assert.ok(!samePath('/home/me/Work', '/home/me/work', 'linux'));
        assert.ok(!liesInside('/home/me/WORK/app', '/home/me/work', 'linux'));
        assert.ok(liesInside('/home/me/work/app', '/home/me/work/', 'linux'));
        assert.ok(liesInside('/w/app', '/', 'linux'));
    });

    test('the CMSIS Solution extension\'s csolution search: its include, hidden folders always left out, the exclude setting added', () => {
        assert.strictEqual(LISTED_SOLUTION_GLOB, '**/*.csolution.{yaml,yml}');
        assert.strictEqual(listedSolutionExclude(undefined), '**/.*/**');
        assert.strictEqual(listedSolutionExclude('  '), '**/.*/**');
        assert.strictEqual(listedSolutionExclude(42), '**/.*/**');
        assert.strictEqual(listedSolutionExclude(' **/legacy/** '), '{**/.*/**,**/legacy/**}');
        assert.strictEqual(listedSolutionExclude('{**/a/**, **/b/**}'), '{**/.*/**,**/a/**, **/b/**}');
    });

    test('the project root open_solution opens for a csolution: the nearest folder with .git or vcpkg-configuration.json, never home or above (#145)', () => {
        const markers = (...present: string[]): ((file: string) => boolean) => (file) => present.includes(file);
        const home = '/home/u';
        const solution = '/home/u/repo/Infineon/T2G-B-H/App.csolution.yml';
        // The manifest at the repository root, the .git folder there, or a .git file (a worktree, a submodule): all the same.
        assert.strictEqual(projectRootOf(solution, home, markers('/home/u/repo/vcpkg-configuration.json'), 'linux'), '/home/u/repo');
        assert.strictEqual(projectRootOf(solution, home, markers('/home/u/repo/.git'), 'linux'), '/home/u/repo');
        // The nearest marker wins, the csolution's own folder included.
        assert.strictEqual(projectRootOf(solution, home, markers('/home/u/repo/.git', '/home/u/repo/Infineon/vcpkg-configuration.json'), 'linux'),
            '/home/u/repo/Infineon');
        assert.strictEqual(projectRootOf(solution, home, markers('/home/u/repo/.git', '/home/u/repo/Infineon/T2G-B-H/.git'), 'linux'),
            '/home/u/repo/Infineon/T2G-B-H');
        // No marker, or one only in home or above it: the csolution's own folder.
        assert.strictEqual(projectRootOf(solution, home, markers(), 'linux'), '/home/u/repo/Infineon/T2G-B-H');
        assert.strictEqual(projectRootOf(solution, home, markers('/home/u/.git', '/home/.git', '/.git'), 'linux'), '/home/u/repo/Infineon/T2G-B-H');
        // Outside home the walk goes up to the file system root, which it never takes.
        assert.strictEqual(projectRootOf('/opt/fw/app/App.csolution.yml', home, markers('/opt/fw/.git'), 'linux'), '/opt/fw');
        assert.strictEqual(projectRootOf('/opt/fw/app/App.csolution.yml', home, markers('/.git'), 'linux'), '/opt/fw/app');
        // Beside home, the folders that hold home are not taken either.
        assert.strictEqual(projectRootOf('/home/shared/app/App.csolution.yml', home, markers('/home/.git'), 'linux'), '/home/shared/app');
        assert.strictEqual(projectRootOf('/home/shared/app/App.csolution.yml', home, markers('/home/shared/.git'), 'linux'), '/home/shared');
        // Windows: home compared without letter case, the drive root never taken.
        const asked: string[] = [];
        const winRoot = projectRootOf('C:\\Users\\U\\repo\\app\\App.csolution.yml', 'c:\\users\\u', (file) => {
            asked.push(file);
            return false;
        }, 'win32');
        assert.strictEqual(winRoot, 'C:\\Users\\U\\repo\\app');
        assert.deepStrictEqual(asked, ['C:\\Users\\U\\repo\\app\\.git', 'C:\\Users\\U\\repo\\app\\vcpkg-configuration.json',
            'C:\\Users\\U\\repo\\.git', 'C:\\Users\\U\\repo\\vcpkg-configuration.json']);
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

suite('Stray drop-in note (#147)', () => {
    const probeOf = (files: readonly string[], entries: Readonly<Record<string, readonly string[]>> = {}) => ({
        exists: (file: string) => files.includes(file),
        entries: (folder: string) => entries[folder] ?? [],
    });
    const folder = '/ws/repo';
    const nested = '/ws/repo/Sensor/Sensor.csolution.yml';

    test('names the root drop-in file the extension does not read, the folder it belongs in and how the merge runs again', () => {
        const note = strayDropInNote(nested, folder, probeOf(['/ws/repo/.vscode.d/tasks.json']), 'linux');
        assert.ok(note !== undefined);
        assert.ok(note.startsWith('/ws/repo/.vscode.d/tasks.json is not read:'), note);
        assert.ok(note.includes('it belongs in /ws/repo/Sensor/.vscode.d.'), note);
        assert.ok(note.includes('cmsis_action refresh'), note);
        assert.ok(note.includes('Update Debug Tasks and Launch Configurations'), note);
    });

    test('names both files when both lie there', () => {
        const note = strayDropInNote(nested, folder, probeOf(['/ws/repo/.vscode.d/tasks.json', '/ws/repo/.vscode.d/launch.json']), 'linux');
        assert.ok(note?.startsWith('/ws/repo/.vscode.d/tasks.json and /ws/repo/.vscode.d/launch.json are not read:'), note);
        assert.ok(note?.includes('they belong in /ws/repo/Sensor/.vscode.d.'), note);
    });

    test('says nothing without a drop-in file at the root: a bare .vscode.d folder or other files in it do not count', () => {
        assert.strictEqual(strayDropInNote(nested, folder, probeOf([]), 'linux'), undefined);
        assert.strictEqual(strayDropInNote(nested, folder, probeOf(['/ws/repo/.vscode.d', '/ws/repo/.vscode.d/settings.json']), 'linux'), undefined);
    });

    test('says nothing for a csolution in the folder itself or outside it', () => {
        const files = ['/ws/repo/.vscode.d/tasks.json'];
        assert.strictEqual(strayDropInNote('/ws/repo/Blinky.csolution.yml', folder, probeOf(files), 'linux'), undefined);
        assert.strictEqual(strayDropInNote('/ws/other/Blinky.csolution.yml', folder, probeOf(files), 'linux'), undefined);
    });

    test('says nothing while a csolution lies at the root too: the root drop-in is that one\'s', () => {
        const probe = probeOf(['/ws/repo/.vscode.d/tasks.json'], { '/ws/repo': ['.vscode.d', 'Blinky.csolution.yml', 'Sensor'] });
        assert.strictEqual(strayDropInNote(nested, folder, probe, 'linux'), undefined);
    });

    test('compares Windows paths as Windows does', () => {
        const probe = probeOf(['C:\\ws\\repo\\.vscode.d\\tasks.json']);
        const note = strayDropInNote('c:\\WS\\repo\\Sensor\\Sensor.csolution.yml', 'C:\\ws\\repo', probe, 'win32');
        assert.ok(note?.includes('c:\\WS\\repo\\Sensor\\.vscode.d.'), note);
        assert.strictEqual(strayDropInNote('C:\\ws\\repo\\Blinky.csolution.yml', 'c:\\WS\\repo', probe, 'win32'), undefined);
    });
});
