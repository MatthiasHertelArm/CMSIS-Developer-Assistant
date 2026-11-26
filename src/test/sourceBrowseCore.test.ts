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
import { hoverText, isCallable, isOverridable, isRecord, parseHover } from '../core/sourceBrowse/hoverText';
import { LspError, SourceIndex, SymbolInformation, contains, isUnknownDocument, kindName, lastLineOf, locationsOf } from '../core/sourceBrowse/protocol';
import { fitBudget, renderIndexState } from '../core/sourceBrowse/render';
import { displayPath, findNear, formatSymbolId, occurrences, parseSymbolId, positionOf, resolvePath, unqualified } from '../core/sourceBrowse/symbolId';
import { Lookup, enclosingSymbol, fileOfUri, rankHits, searchUseSites, symbolAtName } from '../core/sourceBrowse/symbolQuery';

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
        }
        assert.strictEqual(parseSymbolId('main@src/main.c:1:1', {}), undefined, 'a relative path without a solution folder');
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
        const limits = { files: 10, characters: 1_000_000, places: 4 };

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
