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
 * The parts of the source-browsing core that need no server: how a file and
 * a symbol are named and read back, which compile database clangd runs with
 * and how far its index is, what a hover is taken apart into, which index
 * hits are the symbol a name means, and how a text is cut to its budget.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileCommandsDirOf, contextNameOf, indexCoverage, readCompileDatabase, substituteVariables } from '../core/sourceBrowse/context';
import { canonicalPath, openDocumentIndex } from '../core/sourceBrowse/filePaths';
import { hoverText, isCallable, isOverridable, isRecord, parseHover } from '../core/sourceBrowse/hoverText';
import { DocumentSymbol, LspError, Position, SourceIndex, SymbolInformation, contains, isUnknownDocument, kindName, lastLineOf, locationsOf } from '../core/sourceBrowse/protocol';
import { distinctPlaces, referencesOf } from '../core/sourceBrowse/relations';
import { fitBudget, renderIndexState } from '../core/sourceBrowse/render';
import { displayPath, findNear, formatSymbolId, isSymbolId, occurrences, parseSymbolId, positionOf, resolvePath, unqualified } from '../core/sourceBrowse/symbolId';
import { Lookup, enclosingSymbol, fileOfUri, isNamed, isQualified, isSymbolNamed, placeInFile, rankHits, searchUseSites, symbolAtName } from '../core/sourceBrowse/symbolQuery';

/** An absolute path of this platform under a made-up root. */
const at = (...parts: string[]): string => path.join(path.parse(process.cwd()).root, ...parts);
const SOLUTION = at('work', 'blinky');
const PACKS = at('home', 'packs');
const ROOTS = { solution: SOLUTION, packRoot: PACKS };

suite('Source browsing: names of files and symbols', () => {

    test('a path is shown relative to the solution, under the pack root variable, or absolute', () => {
        assert.strictEqual(displayPath(path.join(SOLUTION, 'src', 'main.c'), ROOTS), 'src/main.c');
        assert.strictEqual(displayPath(path.join(PACKS, 'ARM', 'CMSIS', '6.0.0', 'core.h'), ROOTS), '${CMSIS_PACK_ROOT}/ARM/CMSIS/6.0.0/core.h');
        assert.strictEqual(displayPath(at('opt', 'gcc', 'stdint.h'), ROOTS), at('opt', 'gcc', 'stdint.h'));
        assert.strictEqual(displayPath(SOLUTION, ROOTS), SOLUTION, 'the folder itself is no file inside it');
        assert.strictEqual(displayPath(path.join(SOLUTION, 'src', 'main.c'), {}), path.join(SOLUTION, 'src', 'main.c'));
    });

    test('a shown path resolves back, and one whose root is unknown does not', () => {
        assert.strictEqual(resolvePath('src/main.c', ROOTS), path.join(SOLUTION, 'src', 'main.c'));
        assert.strictEqual(resolvePath('${CMSIS_PACK_ROOT}/ARM/core.h', ROOTS), path.join(PACKS, 'ARM', 'core.h'));
        assert.strictEqual(resolvePath('$CMSIS_PACK_ROOT/ARM/core.h', ROOTS), path.join(PACKS, 'ARM', 'core.h'));
        assert.strictEqual(resolvePath(at('opt', 'x.h'), ROOTS), at('opt', 'x.h'));
        assert.strictEqual(resolvePath('${CMSIS_PACK_ROOT}/ARM/core.h', { solution: SOLUTION }), undefined);
        assert.strictEqual(resolvePath('src/main.c', {}), undefined);
    });

    test('an id is the place of the name and is read back as written', () => {
        const id = { name: 'osThreadNew', file: path.join(PACKS, 'ARM', 'RTX', 'rtx_thread.c'), line: 2434, column: 14 };
        const text = formatSymbolId(id, ROOTS);
        assert.strictEqual(text, 'osThreadNew@${CMSIS_PACK_ROOT}/ARM/RTX/rtx_thread.c:2434:14');
        assert.deepStrictEqual(parseSymbolId(text, ROOTS), id);
        assert.deepStrictEqual(parseSymbolId('  main@src/main.c:10:5 ', ROOTS), { name: 'main', file: path.join(SOLUTION, 'src', 'main.c'), line: 10, column: 5 });
        assert.deepStrictEqual(positionOf({ line: 10, column: 5 }), { line: 9, character: 4 });
    });

    test('a path with a colon or an at sign in it does not break an id', () => {
        // On Windows the absolute path has a drive letter and its colon.
        const odd = at('work', 'a@b', 'x.c');
        assert.deepStrictEqual(parseSymbolId(`run@${odd}:7:3`, {}), { name: 'run', file: odd, line: 7, column: 3 });
        assert.strictEqual(parseSymbolId(`operator==@${at('x.cpp')}:3:10`, {})?.name, 'operator==');
    });

    test('a text that is no id is none', () => {
        for (const text of ['main', 'main@src/main.c', 'main@src/main.c:10', '@src/main.c:1:1', 'main@src/main.c:0:1', 'main@src/main.c:x:1']) {
            assert.strictEqual(parseSymbolId(text, ROOTS), undefined, text);
            assert.strictEqual(isSymbolId(text), false, text);
        }
        assert.strictEqual(parseSymbolId('main@src/main.c:1:1', {}), undefined, 'a relative path without a solution folder');
        // The shape alone, for the router, which has no roots: any path, and nothing that is no text.
        for (const text of ['main@src/main.c:1:1', ' geo::Shape@${CMSIS_PACK_ROOT}/x.hpp:3:7 ', `run@${at('work', 'x.c')}:7:3`, 'operator==@x.cpp:3:10']) {
            assert.strictEqual(isSymbolId(text), true, text);
        }
        assert.ok(!isSymbolId(undefined) && !isSymbolId(7) && !isSymbolId(''));
    });

    test('a name is found as a whole identifier, a qualified one by its last part', () => {
        assert.deepStrictEqual(occurrences('  led_on(i); led_on_all(); x = led_on;', 'led_on'), [2, 31]);
        assert.deepStrictEqual(occurrences('int i = init(i);', 'i'), [4, 13]);
        assert.deepStrictEqual(occurrences('task.run(); Task::run();', 'app::Task::run'), [5, 18]);
        assert.deepStrictEqual(occurrences('~Task();', 'Task::~Task'), [0]);
        assert.deepStrictEqual(occurrences('a = b;', ''), []);
        assert.strictEqual(unqualified('geo::Shape'), 'Shape');
        assert.strictEqual(unqualified('main'), 'main');
    });

    test('a name is looked for on the line, then on the nearest lines, above before below', () => {
        const lines = ['foo();', '', 'bar();', '', 'foo();'];
        assert.deepStrictEqual(findNear(lines, 2, 'bar', 5), { line: 2, character: 0 });
        assert.deepStrictEqual(findNear(lines, 2, 'foo', 5), { line: 0, character: 0 });
        assert.deepStrictEqual(findNear(lines, 3, 'foo', 5), { line: 4, character: 0 });
        assert.strictEqual(findNear(lines, 2, 'foo', 1), undefined);
        assert.strictEqual(findNear(lines, 9, 'baz', 20), undefined);
    });
});

suite('Source browsing: the compile database and its index', () => {
    let folder: string;

    setup(() => {
        folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-source-context-')));
    });

    teardown(() => {
        fs.rmSync(folder, { recursive: true, force: true });
    });

    test('the folder is read from clangd\'s arguments in both spellings', () => {
        assert.strictEqual(compileCommandsDirOf(['--compile-commands-dir=${workspaceFolder}/out/Blinky']), '${workspaceFolder}/out/Blinky');
        assert.strictEqual(compileCommandsDirOf(['--background-index', '--compile-commands-dir', '/x/out']), '/x/out');
        assert.strictEqual(compileCommandsDirOf(['-compile-commands-dir=/x/out']), '/x/out');
        assert.strictEqual(compileCommandsDirOf(['--compile-commands-dir=']), undefined);
        assert.strictEqual(compileCommandsDirOf(['--query-driver=/x/**', 7, null]), undefined);
        assert.strictEqual(compileCommandsDirOf([]), undefined);
    });

    test('variables are substituted, and one without a value stays', () => {
        const lookup = (name: string): string | undefined => ({ workspaceFolder: '/work', 'env:HOME': '/home/me' } as Record<string, string>)[name];
        assert.strictEqual(substituteVariables('${workspaceFolder}/out/${env:HOME}', lookup), '/work/out//home/me');
        assert.strictEqual(substituteVariables('${command:cmsis-csolution.getInfoPath}', lookup), '${command:cmsis-csolution.getInfoPath}');
        assert.strictEqual(substituteVariables('/plain', lookup), '/plain');
    });

    test('the units are the files of the database, absolute and each once', () => {
        fs.writeFileSync(path.join(folder, 'compile_commands.json'), JSON.stringify([
            { directory: folder, file: path.join(folder, 'a.c'), command: 'cc -c a.c' },
            { directory: path.join(folder, 'sub'), file: 'b.c', arguments: ['cc', '-c', 'b.c'] },
            { directory: folder, file: path.join(folder, 'a.c'), command: 'cc -DX -c a.c' },
            { directory: folder },
        ]));
        const database = readCompileDatabase(folder);
        assert.deepStrictEqual(database?.units, [path.join(folder, 'a.c'), path.join(folder, 'sub', 'b.c')]);
        assert.strictEqual(database?.file, path.join(folder, 'compile_commands.json'));
    });

    test('a folder without a database, and a file that is none, give nothing', () => {
        assert.strictEqual(readCompileDatabase(folder), undefined);
        fs.writeFileSync(path.join(folder, 'compile_commands.json'), '{"not": "a list"}');
        assert.strictEqual(readCompileDatabase(folder), undefined);
        fs.writeFileSync(path.join(folder, 'compile_commands.json'), 'not json');
        assert.strictEqual(readCompileDatabase(folder), undefined);
    });

    test('the context is named by the one cbuild.yml beside the database or above it', () => {
        assert.strictEqual(contextNameOf(folder), undefined);
        const out = path.join(folder, 'outdir');
        fs.mkdirSync(out);
        fs.writeFileSync(path.join(folder, 'Blinky.Debug+MPS3.cbuild.yml'), '');
        assert.strictEqual(contextNameOf(out), 'Blinky.Debug+MPS3', 'in the folder above');
        fs.writeFileSync(path.join(out, 'App.Release+Board.cbuild.yml'), '');
        assert.strictEqual(contextNameOf(out), 'App.Release+Board', 'the folder itself comes first');
        fs.writeFileSync(path.join(out, 'Other.Release+Board.cbuild.yml'), '');
        assert.strictEqual(contextNameOf(out), undefined, 'two names name none');
    });

    test('the coverage counts the source files that have a shard, and the ones newer than theirs', () => {
        const units = ['a.c', 'b.cpp', 'startup.s', 'c.c'].map((name) => path.join(folder, name));
        for (const unit of units) {
            fs.writeFileSync(unit, '');
        }
        const database = { dir: folder, file: path.join(folder, 'compile_commands.json'), units };
        assert.strictEqual(indexCoverage(database), undefined, 'no index folder yet');
        const shards = path.join(folder, '.cache', 'clangd', 'index');
        fs.mkdirSync(shards, { recursive: true });
        fs.writeFileSync(path.join(shards, 'a.c.0123456789ABCDEF.idx'), '');
        fs.writeFileSync(path.join(shards, 'b.cpp.FEDCBA9876543210.idx'), '');
        fs.writeFileSync(path.join(shards, 'a.h.00000000000000AA.idx'), '');
        fs.writeFileSync(path.join(shards, 'notes.txt'), '');
        const later = new Date(Date.now() + 10_000);
        fs.utimesSync(units[1], later, later);
        const coverage = indexCoverage(database);
        assert.strictEqual(coverage?.indexed, 2);
        assert.strictEqual(coverage?.total, 3, 'the assembler file is not one clangd indexes');
        assert.deepStrictEqual(coverage?.missing, [units[3]]);
        assert.deepStrictEqual(coverage?.stale, [units[1]]);
    });

    test('units of one file name count only as far as there are shards of that name', () => {
        const [app, boot, util] = [path.join(folder, 'app', 'main.c'), path.join(folder, 'boot', 'main.c'), path.join(folder, 'util.c')];
        const base = Date.now() - 100_000;
        /** Sets the modification time of a file to `seconds` after the base. */
        const at = (file: string, seconds: number): void => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (!fs.existsSync(file)) {
                fs.writeFileSync(file, '');
            }
            const time = new Date(base + seconds * 1_000);
            fs.utimesSync(file, time, time);
        };
        const shards = path.join(folder, '.cache', 'clangd', 'index');
        const shard = (name: string): string => path.join(shards, name);
        const database = { dir: folder, file: path.join(folder, 'compile_commands.json'), units: [app, boot, util] };
        at(app, 10);
        at(boot, 1);
        at(util, 1);
        at(shard('util.c.00000000000000A1.idx'), 5);
        at(shard('main.c.00000000000000B1.idx'), 5);

        let coverage = indexCoverage(database);
        assert.deepStrictEqual([coverage?.indexed, coverage?.total], [2, 3], 'one shard named main.c is one indexed unit, not two');
        assert.deepStrictEqual(coverage?.missing, [app], 'of the two, the one changed last is taken as the one without a shard');
        assert.deepStrictEqual(coverage?.stale, []);

        at(shard('main.c.00000000000000B2.idx'), 20);
        coverage = indexCoverage(database);
        assert.deepStrictEqual([coverage?.indexed, coverage?.missing], [3, []]);
        assert.deepStrictEqual(coverage?.stale, [], 'each unit can be older than a shard of its name');

        // Which shard is whose cannot be told from its name: when not every unit can be older than one, each unit
        // that is newer than the oldest shard may be the changed one.
        at(boot, 6);
        at(app, 21);
        assert.deepStrictEqual(indexCoverage(database)?.stale, [app, boot]);
        at(shard('main.c.00000000000000B1.idx'), 19);
        assert.deepStrictEqual(indexCoverage(database)?.stale, [app], 'the one unit that is newer than the oldest shard');
        at(shard('main.c.00000000000000B2.idx'), 31);
        assert.deepStrictEqual(indexCoverage(database)?.stale, []);

        // A shard left from a file that is no unit any more does not count for one, and its age does not matter.
        at(shard('main.c.00000000000000B0.idx'), 2);
        at(shard('util.c.00000000000000A0.idx'), 0);
        coverage = indexCoverage(database);
        assert.deepStrictEqual([coverage?.indexed, coverage?.total, coverage?.stale], [3, 3, []]);
    });

    test('the editor\'s document of a file is found under another spelling of its path', function () {
        const real = path.join(folder, 'real');
        const link = path.join(folder, 'link');
        fs.mkdirSync(real);
        fs.writeFileSync(path.join(real, 'main.c'), '');
        fs.writeFileSync(path.join(real, 'other.c'), '');
        try {
            fs.symlinkSync(real, link, 'dir');
        } catch {
            // Windows refuses a symbolic link to an account without the right to make one.
            this.skip();
        }
        const file = path.join(real, 'main.c');
        const linked = path.join(link, 'main.c');
        assert.strictEqual(canonicalPath(linked), file);
        assert.strictEqual(canonicalPath(path.join(folder, 'gone.c')), path.join(folder, 'gone.c'), 'a path that does not exist is itself');
        const known = new Map<string, string>();
        assert.strictEqual(openDocumentIndex(file, [path.join(link, 'other.c'), linked], known), 1, 'the document opened through the link');
        assert.strictEqual(openDocumentIndex(linked, [file], known), 0, 'and the other way round');
        assert.strictEqual(openDocumentIndex(file, [linked, file], known), 1, 'the document of the very path comes first');
        assert.strictEqual(openDocumentIndex(file, [path.join(link, 'other.c')], known), -1);
        assert.strictEqual(openDocumentIndex(file, [], known), -1);
        assert.ok(known.has(linked), 'canonical paths are kept for the next call');
        // VS Code writes the drive letter of a Windows path in lower case; clangd and the compile database do not.
        assert.strictEqual(openDocumentIndex('C:\\work\\Main.c', ['c:\\work\\main.c'], new Map(), 'win32'), 0);
        assert.strictEqual(openDocumentIndex('/work/Main.c', ['/work/main.c'], new Map(), 'linux'), -1, 'where case counts, it counts');
    });

    test('the first lines say what the index covers and where the paths start', () => {
        const coverage = { indexed: 12, total: 12, missing: [], stale: [] };
        assert.strictEqual(renderIndexState({ context: 'Blinky.Debug+MPS3', folder: path.join(SOLUTION, 'out'), coverage, server: 'Apple clangd version 21.0.0 (clang-2100)' }, ROOTS),
            `Source index: Blinky.Debug+MPS3 (12 translation units indexed; clangd 21.0.0).\nPaths: relative paths start at ${SOLUTION}; \${CMSIS_PACK_ROOT} is ${PACKS}.`);
        assert.strictEqual(renderIndexState({ folder: path.join(SOLUTION, 'out', 'x'), coverage: { ...coverage, total: 1, indexed: 1 } }, { solution: SOLUTION }),
            `Source index: out/x (1 translation unit indexed).\nPaths: relative paths start at ${SOLUTION}.`);
        assert.strictEqual(renderIndexState({ folder: at('elsewhere'), coverage: { ...coverage, total: 0, indexed: 0 } }, {}), `Source index: ${at('elsewhere')}.`);
    });
});

suite('Source browsing: what clangd says on hover', () => {

    test('Markdown as the editor\'s client gets it is taken apart', () => {
        const hover = { contents: { kind: 'markdown', value: '### function `main`  \n\n---\n→ `int`  \nParameters:  \n- `int argc`\n\n@brief Main function  \n\n---\n```cpp\nint main(int argc)\n```' } };
        assert.deepStrictEqual(parseHover(hover), { kind: 'function', name: 'main', code: 'int main(int argc)', details: ['→ int', 'Parameters:', '- int argc', '@brief Main function'] });
    });

    test('a macro keeps its definition and expansion, a type its size', () => {
        const macro = parseHover({ contents: { kind: 'markdown', value: '### macro `GPIOA`  \nprovided by `"stm32u585xx.h"`  \n\n---\nType: `GPIO_TypeDef *`  \n\n---\n```cpp\n#define GPIOA GPIOA_NS\n\n// Expands to\n((GPIO_TypeDef *)0x42020000UL)\n```' } });
        assert.strictEqual(macro?.kind, 'macro');
        assert.strictEqual(macro?.name, 'GPIOA');
        assert.strictEqual(macro?.code, '#define GPIOA GPIOA_NS\n\n// Expands to\n((GPIO_TypeDef *)0x42020000UL)');
        assert.deepStrictEqual(macro?.details, ['provided by "stm32u585xx.h"', 'Type: GPIO_TypeDef *']);
        const type = parseHover({ contents: { kind: 'markdown', value: '### class `MemoryAllocator`  \n\n---\nSize: 24 bytes, alignment 4 bytes  \n\n---\n```cpp\n// In namespace executorch::runtime\nclass MemoryAllocator {}\n```' } });
        assert.strictEqual(type?.kind, 'class');
        assert.deepStrictEqual(type?.details, ['Size: 24 bytes, alignment 4 bytes']);
    });

    test('escaped marks and entities are plain text again', () => {
        const parts = parseHover({ contents: { kind: 'markdown', value: '### variable `x`  \n\n---\nType: `a\\_t &lt;int&gt;`  \nNote \\*not\\* bold &amp; so on\n\n---\n```cpp\na_t<int> x\n```' } });
        assert.deepStrictEqual(parts?.details, ['Type: a_t <int>', 'Note *not* bold & so on']);
    });

    test('the rule of a banner comment is no part of the documentation', () => {
        const parts = parseHover({ contents: { kind: 'markdown', value: '### function `Reset_Handler`  \n\n---\n→ `void`  \n\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\- Internal References ========  \n\n---\n```cpp\nvoid Reset_Handler(void)\n```' } });
        assert.deepStrictEqual(parts?.details, ['→ void', 'Internal References']);
    });

    test('plain text, the older forms and an empty hover are read too', () => {
        assert.deepStrictEqual(parseHover({ contents: { kind: 'plaintext', value: 'function main\n\n→ int\n\nint main(void)' } }),
            { kind: 'function', name: 'main', code: 'int main(void)', details: ['→ int'] });
        assert.strictEqual(hoverText({ contents: ['a', { language: 'cpp', value: 'int x' }] }), 'a\n\n```cpp\nint x\n```');
        assert.deepStrictEqual(parseHover({ contents: { language: 'cpp', value: 'int x' } }), { code: 'int x', details: [] });
        assert.deepStrictEqual(parseHover({ contents: 'just a sentence' }), { details: ['just a sentence'] });
        assert.strictEqual(parseHover(null), undefined);
        assert.strictEqual(parseHover({ contents: { kind: 'markdown', value: '  ' } }), undefined);
    });

    test('the kind word decides which relations a symbol has', () => {
        assert.ok(isCallable('function') && isCallable('instance-method') && isCallable('constructor') && !isCallable('variable') && !isCallable(undefined));
        assert.ok(isRecord('class') && isRecord('struct') && !isRecord('function') && !isRecord('type-alias'));
        assert.ok(isOverridable('instance-method') && isOverridable('method') && !isOverridable('static-method'));
    });
});

suite('Source browsing: answers of the server', () => {
    const hit = (name: string, containerName?: string): SymbolInformation =>
        ({ name, kind: 12, containerName, location: { uri: 'file:///x.c', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } });

    test('the hits that are the name come first, case deciding before it is ignored', () => {
        const hits = [hit('main'), hit('app_main'), hit('Main'), hit('mainnsppc0')];
        assert.deepStrictEqual(rankHits(hits, 'main').exact.map((h) => h.name), ['main']);
        assert.strictEqual(rankHits(hits, 'main').caseInsensitive, false);
        assert.deepStrictEqual(rankHits(hits, 'main').near.map((h) => h.name), ['app_main', 'Main', 'mainnsppc0']);
        const folded = rankHits([hit('Main'), hit('MAIN'), hit('remain')], 'main');
        assert.deepStrictEqual(folded.exact.map((h) => h.name), ['Main', 'MAIN']);
        assert.strictEqual(folded.caseInsensitive, true);
        assert.deepStrictEqual(rankHits(hits, 'nothing').exact, []);
    });

    test('a qualified name matches its scope, whole or by its tail', () => {
        const hits = [hit('run', 'app::Task'), hit('run', 'app::Other::'), hit('run'), hit('rerun', 'app::Task')];
        assert.deepStrictEqual(rankHits(hits, 'app::Task::run').exact, [hits[0]]);
        assert.deepStrictEqual(rankHits(hits, 'Task::run').exact, [hits[0]]);
        assert.deepStrictEqual(rankHits(hits, '::run').exact.length, 3, 'a leading :: is the name alone');
        assert.deepStrictEqual(rankHits(hits, 'Other::run').exact, [hits[1]]);
    });

    test('one rule says whether a symbol is the one a name means, with its scope or without', () => {
        assert.ok(isQualified('Task::run') && isQualified(' app::Task::run ') && !isQualified('run') && !isQualified('::run'));
        assert.ok(isNamed('run', 'app::Task', 'app::Task::run') && isNamed('run', 'app::Task', 'Task::run') && isNamed('run', 'app::Task', 'run'));
        assert.ok(isNamed('Task::run', 'app', 'app::Task::run'), 'an outline writes the class into the name of a member defined outside it');
        assert.ok(isNamed('Task::run', 'app', 'Task::run') && isNamed('Task::run', 'app', 'run') && isNamed('Task::run', undefined, 'Task::run'));
        assert.ok(!isNamed('run', 'app::Other', 'Task::run') && !isNamed('run', undefined, 'Task::run') && !isNamed('rerun', 'app::Task', 'run'));
        assert.ok(!isNamed('run', 'app::MyTask', 'Task::run'), 'a scope is matched whole, not by its ending');
        assert.ok(isNamed('run', undefined, '::run') && isNamed('RUN', 'App::Task', 'task::run', (text) => text.toLowerCase()));

        // What clangd described at a place: held against the scope only when clangd named one.
        assert.ok(isSymbolNamed({ name: 'run', container: 'app::Task', scoped: true }, 'Task::run'));
        assert.ok(!isSymbolNamed({ name: 'run', container: 'app::Other', scoped: true }, 'Task::run'));
        assert.ok(!isSymbolNamed({ name: 'run', scoped: true }, 'Task::run'), 'the global scope is a scope');
        assert.ok(isSymbolNamed({ name: 'run' }, 'Task::run'), 'a place whose scope is not known counts by its name');
        assert.ok(isSymbolNamed({ name: 'run', container: 'app::Other', scoped: true }, 'run') && !isSymbolNamed({ name: 'rerun', scoped: true }, 'run'));
    });

    test('a qualified name in a file is the symbol of that scope: in the outline, and where the text is asked about', async () => {
        const text = [
            'namespace geo {',
            'double Circle::area() const { return 1.0; }',
            'double Square::area() const { return 2.0; }',
            'double both(const Circle &c, const Square &s) { return c.area() + s.area(); }',
            '}',
        ];
        const name = (line: number, word: string, nth = 0): { start: Position; end: Position } => {
            let character = -1;
            for (let round = 0; round <= nth; round++) {
                character = text[line].indexOf(word, character + 1);
            }
            return { start: { line, character }, end: { line, character: character + word.length } };
        };
        const whole = (line: number): { start: Position; end: Position } => ({ start: { line, character: 0 }, end: { line, character: text[line].length } });
        // As clangd answers: the namespace, and in it the members under the names they are written with.
        const members: DocumentSymbol[] = [
            { name: 'Circle::area', kind: 6, range: whole(1), selectionRange: name(1, 'area') },
            { name: 'Square::area', kind: 6, range: whole(2), selectionRange: name(2, 'area') },
            { name: 'both', kind: 12, range: whole(3), selectionRange: name(3, 'both') },
        ];
        const outline: DocumentSymbol[] = [
            { name: 'geo', kind: 3, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }, selectionRange: name(0, 'geo'), children: members },
        ];
        /** The class whose `area` stands at a position: by the line, on the last line by the half. */
        const classAt = (position: Position): string | undefined => {
            const word = /[A-Za-z_]*$/.exec(text[position.line].slice(0, position.character))?.[0] + (/^[A-Za-z_]*/.exec(text[position.line].slice(position.character))?.[0] ?? '');
            if (word !== 'area') {
                return undefined;
            }
            return position.line === 1 || (position.line === 3 && position.character < text[3].indexOf('+')) ? 'Circle' : 'Square';
        };
        const asked: string[] = [];
        const serverWith = (symbols: DocumentSymbol[]): SourceIndex => ({
            generation: {},
            server: { callHierarchy: false, typeHierarchy: false },
            open: (file) => Promise.resolve({ uri: `file:///${file}`, languageId: 'cpp', text: text.join('\n') }),
            request: <T>(method: string, params: unknown): Promise<T> => {
                const position = (params as { position?: Position }).position;
                asked.push(method);
                const owner = position === undefined ? undefined : classAt(position);
                switch (method) {
                    case 'textDocument/documentSymbol': return Promise.resolve(symbols as T);
                    case 'textDocument/hover': return Promise.resolve((owner === undefined ? null : { contents: { kind: 'markdown', value: `### instance-method \`${owner}::area\`` } }) as T);
                    case 'textDocument/symbolInfo': return Promise.resolve((owner === undefined ? [] : [{ name: 'area', containerName: `geo::${owner}::` }]) as T);
                    default: return Promise.resolve(null as T);
                }
            },
        });
        const clock = { now: (): number => 0, startTimer: (): (() => void) => () => undefined };
        const place = (symbols: DocumentSymbol[], wanted: string): Promise<Position> =>
            placeInFile(new Lookup(serverWith(symbols), clock, 60_000, () => Promise.resolve(undefined)), 'shape.cpp', wanted, 'shape.cpp').then((found) => found.position);

        assert.deepStrictEqual(await place(outline, 'geo::Square::area'), name(2, 'area').start);
        assert.deepStrictEqual(await place(outline, 'Square::area'), name(2, 'area').start, 'not the area of Circle, which stands first');
        assert.deepStrictEqual(await place(outline, 'Circle::area'), name(1, 'area').start);
        assert.deepStrictEqual(await place(outline, 'area'), name(1, 'area').start, 'a plain name is the first of the outline');
        assert.deepStrictEqual(await place(outline, 'geo::both'), name(3, 'both').start);
        assert.ok(!asked.includes('textDocument/hover'), 'the outline answers without a question about a place');

        // Without an outline the places in the text are asked about, two on one line included.
        assert.deepStrictEqual(await place([], 'Square::area'), name(2, 'area').start);
        assert.deepStrictEqual(await place([members[2]], 'Square::area'), name(2, 'area').start, 'an outline without the name leaves it to the text too');
        assert.deepStrictEqual(await place([], 'area'), name(1, 'area').start, 'a plain name is the first place, and nothing is asked about it');
        await assert.rejects(place([], 'Triangle::area'), /'Triangle::area' does not stand in shape\.cpp: where 'area' stands there, it is the name of another scope\./);
        await assert.rejects(place([], 'Square::edge'), /'edge' does not stand in shape\.cpp\./);
    });

    test('a place clangd answers twice, under two spellings of a path, is one reference', async () => {
        const range = (line: number): { start: Position; end: Position } => ({ start: { line, character: 5 }, end: { line, character: 11 } });
        const at = (uri: string, ...lines: number[]): Array<{ uri: string; range: { start: Position; end: Position } }> => lines.map((line) => ({ uri, range: range(line) }));
        const clock = { now: (): number => 0, startTimer: (): (() => void) => () => undefined };
        const real = (file: string): string => file.replace(/^\/link\//, '/real/');
        /** The references of the symbol at /real/led.c:3, asked of a server that has the document under `opened` and gives `answer`. */
        const references = async (opened: string, answer: unknown): Promise<string[]> => {
            const index: SourceIndex = {
                generation: {},
                server: { callHierarchy: false, typeHierarchy: false },
                open: () => Promise.resolve({ uri: opened, languageId: 'c', text: '' }),
                request: <T>(): Promise<T> => Promise.resolve(answer as T),
            };
            const found = await referencesOf(new Lookup(index, clock, 60_000, () => Promise.resolve(undefined), real), { file: '/real/led.c', position: range(3).start });
            assert.strictEqual(found.files, new Set(found.places.map((place) => place.file)).size);
            return found.places.map((place) => `${place.file}:${place.position.line}`);
        };
        // Not on Windows, where a file URI without a drive letter is no path.
        if (process.platform !== 'win32') {
            // The editor has the file through a link, with two unsaved lines above: clangd answers from the document
            // (lines 5 and 11) and from the index of the saved file under the real path (lines 3 and 9), and from
            // the document once more under the real path.
            const twice = [...at('file:///link/led.c', 5, 11), ...at('file:///real/led.c', 5, 11, 3, 9), ...at('file:///real/main.c', 5)];
            assert.deepStrictEqual(await references('file:///link/led.c', twice), ['/real/led.c:5', '/real/led.c:11', '/real/main.c:5'], 'the document\'s own places count');
            // The document under the path clangd uses: nothing to choose, each place once.
            assert.deepStrictEqual(await references('file:///real/led.c', [...at('file:///real/led.c', 3, 9, 3), ...at('file:///real/main.c', 5)]),
                ['/real/led.c:3', '/real/led.c:9', '/real/main.c:5']);
            // An answer that names the document under no spelling the tools know is kept as it is, each place once.
            assert.deepStrictEqual(await references('file:///elsewhere/led.c', [...at('file:///link/led.c', 3), ...at('file:///real/led.c', 3, 9)]), ['/real/led.c:3', '/real/led.c:9']);
        }
        const a = { file: 'a.c', position: { line: 1, character: 2 } };
        assert.deepStrictEqual(distinctPlaces([a, { ...a }, { file: 'a.c', position: { line: 1, character: 3 } }, a]), [a, { file: 'a.c', position: { line: 1, character: 3 } }]);
    });

    test('a definition answer is read in every form the protocol allows', () => {
        const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
        assert.deepStrictEqual(locationsOf({ uri: 'file:///a.c', range }), [{ uri: 'file:///a.c', range }]);
        assert.deepStrictEqual(locationsOf([{ targetUri: 'file:///b.c', targetRange: range, targetSelectionRange: range }]), [{ uri: 'file:///b.c', range }]);
        assert.deepStrictEqual(locationsOf(null), []);
        assert.deepStrictEqual(locationsOf([{ nothing: true }]), []);
    });

    test('the refusal for a document the server was not told about is told apart', () => {
        assert.ok(isUnknownDocument(new LspError(-32602, 'trying to get AST for non-added document')));
        assert.ok(isUnknownDocument(Object.assign(new Error('Trying to get preamble for non-added document'), { code: -32602 })));
        assert.ok(!isUnknownDocument(new LspError(-32602, 'invalid position')));
        assert.ok(!isUnknownDocument(new LspError(-32001, 'non-added document')));
        assert.ok(!isUnknownDocument(undefined));
    });

    test('a position is inside a range up to, not including, its end; kinds have words', () => {
        const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
        assert.ok(contains(range, { line: 2, character: 4 }) && contains(range, { line: 2, character: 7 }));
        assert.ok(!contains(range, { line: 2, character: 8 }) && !contains(range, { line: 1, character: 5 }) && !contains(range, { line: 2, character: 3 }));
        assert.strictEqual(kindName(12), 'function');
        assert.strictEqual(kindName(23), 'struct');
        assert.strictEqual(kindName(99), 'symbol');
    });

    test('an outline answers which symbol a line lies in and whose name stands at a place', () => {
        const range = (first: number, last: number): { start: { line: number; character: number }; end: { line: number; character: number } } =>
            ({ start: { line: first, character: 0 }, end: { line: last, character: 1 } });
        const name = (line: number): { start: { line: number; character: number }; end: { line: number; character: number } } =>
            ({ start: { line, character: 6 }, end: { line, character: 10 } });
        const method = { name: 'area', kind: 6, range: range(4, 6), selectionRange: name(4) };
        const outline = [{ name: 'Shape', kind: 5, range: range(2, 8), selectionRange: name(2), children: [method] }, { name: 'main', kind: 12, range: range(10, 12), selectionRange: name(10) }];
        assert.strictEqual(enclosingSymbol(outline, 5)?.name, 'area', 'the innermost one');
        assert.strictEqual(enclosingSymbol(outline, 7)?.name, 'Shape');
        assert.strictEqual(enclosingSymbol(outline, 9), undefined);
        assert.strictEqual(symbolAtName(outline, { line: 4, character: 6 })?.name, 'area');
        assert.strictEqual(symbolAtName(outline, { line: 10, character: 8 })?.name, 'main');
        assert.strictEqual(symbolAtName(outline, { line: 10, character: 0 }), undefined);
    });

    test('a range that ends at column 0 of a later line does not include that line', () => {
        const name = { start: { line: 2, character: 5 }, end: { line: 2, character: 10 } };
        const first = { name: 'first', kind: 12, range: { start: { line: 2, character: 0 }, end: { line: 5, character: 0 } }, selectionRange: name };
        assert.strictEqual(lastLineOf(first.range), 4);
        assert.strictEqual(lastLineOf({ start: { line: 2, character: 0 }, end: { line: 5, character: 1 } }), 5);
        assert.strictEqual(lastLineOf({ start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }), 2, 'an empty range is its line');
        assert.strictEqual(enclosingSymbol([first], 4)?.name, 'first');
        assert.strictEqual(enclosingSymbol([first], 5), undefined, 'the line after the function lies in no function');
    });

    test('the search for a use site ends at its limits inside a file too, not only between files', async () => {
        /** A server nobody asks: the search reads texts only. */
        const index: SourceIndex = {
            generation: {},
            server: { callHierarchy: false, typeHierarchy: false },
            request: () => Promise.reject(new Error('not asked')),
            open: () => Promise.reject(new Error('not opened')),
        };
        const big = `${'x = 1;\n'.repeat(20_000)}needle();\n`;
        const texts: Record<string, string> = { 'small.c': 'int a;\nneedle();\n', 'big.c': big };
        const read = (file: string): Promise<string | undefined> => Promise.resolve(texts[file]);
        const still = { now: (): number => 0, startTimer: (): (() => void) => () => undefined };
        const limits = { files: 10, characters: 1_000_000, places: 4, perFile: 1 };

        const whole = await searchUseSites(new Lookup(index, still, 60_000, read), ['small.c', 'big.c'], 'needle', limits);
        assert.deepStrictEqual(whole, [{ file: 'small.c', position: { line: 1, character: 0 } }, { file: 'big.c', position: { line: 20_000, character: 0 } }]);

        const short = await searchUseSites(new Lookup(index, still, 60_000, read), ['big.c', 'small.c'], 'needle', { ...limits, characters: 5_000 });
        assert.deepStrictEqual(short, [], 'the character limit ends the scan of the large file, and no file is read after it');

        // A clock that moves on by a second every time it is read: the call's ten seconds end inside the file.
        let readAt = 0;
        const running = { now: (): number => (readAt += 1_000), startTimer: (): (() => void) => () => undefined };
        const late = await searchUseSites(new Lookup(index, running, 10_000, read), ['big.c'], 'needle', limits);
        assert.deepStrictEqual(late, [], 'the time is looked at while a file is scanned');
    });

    test('a file URI of the server is a path, percent signs decoded', () => {
        assert.strictEqual(fileOfUri(`file://${process.platform === 'win32' ? '/C:' : ''}/work/my%20project/main.c`), process.platform === 'win32' ? 'C:\\work\\my project\\main.c' : '/work/my project/main.c');
        assert.strictEqual(fileOfUri('untitled:Untitled-1'), 'untitled:Untitled-1');
    });

    test('a text over its budget ends on a whole line and says how many it left out', () => {
        const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1} ${'x'.repeat(20)}`).join('\n');
        assert.strictEqual(fitBudget(text, 5_000), text);
        const cut = fitBudget(text, 400);
        assert.ok(cut.length <= 400, `${cut.length} characters`);
        assert.match(cut, /^line 1 x+\n/);
        assert.match(cut, /\n… \(\+\d+ lines not shown: raise maxChars, or lower limit or depth\)$/);
        const kept = cut.split('\n').length - 1;
        assert.ok(cut.endsWith(`(+${40 - kept} lines not shown: raise maxChars, or lower limit or depth)`));
    });
});
