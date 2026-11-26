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
 * The two source tools end to end through the handler, against the scripted
 * clangd of `sourceBrowseScript.ts`: what an agent reads for a name, a use
 * site, an id and each relation, what the handler does to get there (the
 * first document, the changed unit, the repeated request, the new client
 * after a restart), and every refusal.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { ClangdExtensionHandle } from '../core/sourceBrowse/clangdApi';
import { ToolError, textOf } from '../core/toolResult';
import { SOURCE_RELATIONS, SourceBrowseHandler, SourceFindArgs, SourceGetArgs } from '../sourceBrowseHandler';
import { ScriptedClangd, SkippingClock, WindowScript, scriptedHost, serverError } from './sourceBrowseScript';

suite('Source browsing: the handler', () => {
    let server: ScriptedClangd;
    let handler: SourceBrowseHandler;

    /** A handler on the scripted clangd, in a window a test may change. */
    const windowWith = (script: WindowScript = {}): SourceBrowseHandler => new SourceBrowseHandler(scriptedHost(server, new SkippingClock(), script), { timeoutMs: 20_000 });
    const find = async (args: SourceFindArgs, on: SourceBrowseHandler = handler): Promise<string> => textOf(await on.handleSourceFind(args));
    const get = async (args: SourceGetArgs, on: SourceBrowseHandler = handler): Promise<string> => textOf(await on.handleSourceGet(args));
    /** The refusal a call ends with. */
    const refusal = async (call: Promise<unknown>): Promise<ToolError> => {
        try {
            await call;
        } catch (caught) {
            assert.ok(caught instanceof ToolError, `a ToolError, not ${String(caught)}`);
            return caught;
        }
        throw new assert.AssertionError({ message: 'the call was expected to be refused' });
    };

    setup(() => {
        server = new ScriptedClangd();
        handler = windowWith();
    });

    teardown(() => {
        server.dispose();
    });

    // ------------------------------------------------------------ source_find

    test('a name answers with a card: what it is, where, its id, and what source_get returns', async () => {
        const text = await find({ name: 'led_on' });
        assert.match(text, /^Source index: Demo\.Debug\+Sim \(3 translation units indexed; clangd 21\.0\.0\)\.\nPaths: relative paths start at /);
        assert.ok(text.includes(`relative paths start at ${server.root}.`));
        assert.match(text, /\nled_on: function\n {2}void led_on\(unsigned int index\)\n {2}→ void\n {2}Parameters:\n {2}- unsigned int index\n {2}Switch one LED on\.\n/);
        assert.match(text, /\n {2}defined {4}src\/led\.c:10\n {2}declared {3}src\/led\.h:7\n {2}id {9}led_on@src\/led\.c:10:6\n/);
        assert.match(text, /\n {2}available {2}definition, references \(3 in 3 files\), callers \(1\), callees \(1\)$/);
    });

    test('the first call opens a translation unit, because clangd answers nothing by name before', async () => {
        assert.strictEqual(server.opened.size, 0);
        await find({ name: 'main' });
        assert.ok(server.opened.has(pathToFileURL(server.file('src/led.c')).href), 'the first unit of the solution is opened');
        const openedBefore = server.opened.size;
        await find({ name: 'lit' });
        assert.strictEqual(server.opened.size, openedBefore, 'a second call opens nothing for the same client');
    });

    test('a name is asked again while the index of a new client loads', async () => {
        server.loadingAnswers = 3;
        const text = await find({ name: 'led_lit' });
        assert.match(text, /led_lit: function/);
        assert.ok(server.asked.filter((method) => method === 'workspace/symbol').length >= 4);
    });

    test('a name without a use in the units is waited for longer while clangd still builds its index', async () => {
        fs.rmSync(path.join(server.root, 'out', '.cache'), { recursive: true });
        server.loadingAnswers = 8;
        const text = await find({ name: 'Shape' });
        assert.match(text, /Shape: class/);
        assert.ok(!text.includes('found      from its use'), 'the index answered in the end');
        assert.ok(server.asked.filter((method) => method === 'workspace/symbol').length >= 9);
    });

    test('with the index built, a name that is nowhere is asked again only while the client is new', async () => {
        const clock = new SkippingClock();
        const own = new SourceBrowseHandler(scriptedHost(server, clock), { timeoutMs: 20_000 });
        const asksFor = async (name: string): Promise<number> => {
            const before = server.asked.length;
            assert.match(await find({ name }, own), new RegExp(`No symbol named '${name}'`));
            return server.asked.slice(before).filter((method) => method === 'workspace/symbol').length;
        };
        assert.strictEqual(await asksFor('nowhere_at_all'), 4, 'within the second a new client loads its index in');
        clock.advance(6_000);
        assert.strictEqual(await asksFor('nowhere_else'), 1, 'not later, and never for the eight seconds of an index being built');
    });

    test('several symbols of one name answer with their ids', async () => {
        const text = await find({ name: 'helper' });
        assert.match(text, /2 symbols are named 'helper'\. Pass the id of one to source_get, or the name with fileFullPath to source_find:/);
        assert.match(text, /\n {2}helper@src\/led\.c:22:13 {2}\(function\)\n {2}helper@src\/main\.c:3:13 {2}\(function\)$/);
        const one = await find({ name: 'helper', fileFullPath: 'src/main.c' });
        assert.match(one, /helper: function\n[\s\S]*defined {4}src\/main\.c:3\n/);
    });

    test('a qualified name with a file is the symbol of that scope, not the first of the name in the file', async () => {
        // The outline of the source file writes both as the server does: Inch::scale, then Mile::scale.
        const defined = await find({ name: 'Mile::scale', fileFullPath: 'src/shape.cpp' });
        assert.match(defined, /\nscale: static-method in Mile\n[\s\S]*\n {2}defined {4}src\/shape\.cpp:6\n {2}declared {3}src\/shape\.hpp:10\n/);
        // The header has no outline entry for them here: the places in its text are asked about, and the first is Inch's.
        const declared = await find({ name: 'Mile::scale', fileFullPath: 'src/shape.hpp' });
        assert.match(declared, /\nscale: static-method in Mile\n[\s\S]*\n {2}defined {4}src\/shape\.cpp:6\n/);
        assert.match(await find({ name: 'Inch::scale', fileFullPath: 'src/shape.cpp' }), /\nscale: static-method in Inch\n[\s\S]*\n {2}defined {4}src\/shape\.cpp:5\n/);
        assert.match(await find({ name: 'scale', fileFullPath: 'src/shape.cpp' }), /\nscale: static-method in Inch\n/, 'a plain name is the first one of the file, as before');
        const other = await refusal(find({ name: 'Yard::scale', fileFullPath: 'src/shape.hpp' }));
        assert.strictEqual(other.code, 'INVALID_ARGUMENT');
        assert.match(other.message, /'Yard::scale' does not stand in src\/shape\.hpp: where 'scale' stands there, it is the name of another scope\./);
        const absent = await refusal(find({ name: 'Mile::nothing', fileFullPath: 'src/shape.hpp' }));
        assert.match(absent.message, /'nothing' does not stand in src\/shape\.hpp\./);
    });

    test('a qualified name the index does not have is found from a use of that scope, not from the first use of the name', async () => {
        const text = await find({ name: 'Mile::scale' });
        assert.match(text, /\nscale: static-method in Mile\n[\s\S]*\n {2}defined {4}src\/shape\.cpp:6\n/);
        assert.match(text, /\n {2}found {6}from its use at src\/shape\.cpp:6 \(not in the index by name\)\n/);
        assert.match(await find({ name: 'Yard::scale' }), /No symbol named 'Yard::scale'/, 'a use in another scope is not the symbol');
        assert.match(await find({ name: 'scale' }), /\nscale: static-method in Inch\n/, 'a plain name is the first use, as before');
    });

    test('a name in another case is found when no symbol has it as written', async () => {
        assert.match(await find({ name: 'LED_ON' }), /led_on: function/);
    });

    test('a macro is not in the index by name and is found from a use', async () => {
        const text = await find({ name: 'LED_COUNT' });
        assert.match(text, /LED_COUNT: macro\n {2}#define LED_COUNT 4U\n {2}defined {4}src\/led\.h:4\n {2}found {6}from its use at src\/led\.c:12 \(not in the index by name\)\n/);
        assert.match(text, /id {9}LED_COUNT@src\/led\.h:4:9\n {2}available {2}definition, references \(3 in 3 files\)$/);
    });

    test('a name nobody has is answered with the nearest names and the other ways to ask', async () => {
        const text = await find({ name: 'led' });
        assert.match(text, /No symbol named 'led' in the index of Demo\.Debug\+Sim, and no use of it in its translation units\./);
        assert.match(text, /Nearest names: led_on, led_lit\./);
        assert.match(text, /pass fileFullPath and line\. A symbol of an assembler file is not indexed: lookup_symbol/);
    });

    test('a use site finds a local variable, also from a line nearby', async () => {
        const text = await find({ fileFullPath: server.file('src/main.c'), line: 10, name: 'i' });
        assert.match(text, /^i: variable$/m);
        assert.match(text, /defined {4}src\/main\.c:9\n {2}id {9}i@src\/main\.c:9:23\n/);
        assert.match(await find({ fileFullPath: 'src/main.c', line: 12, name: 'i' }), /^i: variable$/m);
    });

    test('a line without a name is the function it lies in; a line in none is refused', async () => {
        assert.match(await find({ fileFullPath: 'src/main.c', line: 10 }), /blink_all: function/);
        const outside = await refusal(find({ fileFullPath: 'src/main.c', line: 13 }));
        assert.strictEqual(outside.code, 'INVALID_ARGUMENT');
        assert.match(outside.message, /Line 13 of src\/main\.c lies in no function or type\./);
        const absent = await refusal(find({ fileFullPath: 'src/main.c', line: 2, name: 'record' }));
        assert.match(absent.message, /'record' does not stand on line 2 of src\/main\.c, nor within 5 lines of it\./);
        const past = await refusal(find({ fileFullPath: 'src/main.c', line: 400, name: 'main' }));
        assert.match(past.message, /line 400 is past its end/);
    });

    test('a file alone answers with its outline', async () => {
        const text = await find({ fileFullPath: 'src/led.c' });
        assert.match(text, /Outline of src\/led\.c \(5 symbols; lines, name, kind\)\./);
        assert.match(text, /\n {2}3 {9}lit: variable\n {2}5-8 {7}record: function\n {2}10-15 {5}led_on: function\n {2}17-20 {5}led_lit: function\n {2}22-25 {5}helper: function$/);
        assert.match(await find({ fileFullPath: 'src/led.c', limit: 2 }), /helper|… and 3 more \(raise limit\)$/);
    });

    test('a file that is missing, or no C or C++ document, is refused', async () => {
        const missing = await refusal(find({ fileFullPath: 'src/none.c' }));
        assert.strictEqual(missing.code, 'INVALID_ARGUMENT');
        assert.match(missing.message, /fileFullPath 'src\/none\.c' is not a file/);
        const assembler = await refusal(find({ fileFullPath: 'src/startup.s' }));
        assert.strictEqual(assembler.code, 'INVALID_ARGUMENT');
        assert.match(assembler.message, /is no C or C\+\+ document for VS Code \(language 'arm'\)/);
        assert.match(assembler.hint ?? '', /lookup_symbol/);
    });

    test('arguments that say nothing are answered with what to pass', async () => {
        assert.match(await find({}), /^Pass name \(a symbol/);
        assert.strictEqual(await find({ line: 3 }), 'line needs fileFullPath: the file the line is in.');
        assert.strictEqual(await find({ fileFullPath: 'src/main.c', line: 0 }), 'line counts from 1.');
        assert.match(await get({}), /^Pass symbol \(an id of source_find, or a name that is unique\) and what \(definition, references/);
        assert.strictEqual(await get({ symbol: 'main', what: 'users' }), `what 'users' is none of ${SOURCE_RELATIONS.join(', ')}.`);
        assert.strictEqual(server.asked.length, 0, 'none of them reaches clangd');
    });

    // ------------------------------------------------------------- source_get

    test('the definition is the source of the symbol with its line numbers', async () => {
        const text = await get({ symbol: 'led_on', what: 'definition' });
        assert.match(text, /\nled_on: defined at src\/led\.c:10-15 \(6 lines\)\n {2}10 {2}void led_on\(unsigned int index\)\n {2}11 {2}\{\n {2}12 {6}if \(index < LED_COUNT\) \{\n/);
        assert.match(text, /\n {2}15 {2}\}$/);
        assert.match(await get({ symbol: 'LED_COUNT', what: 'definition' }), /\nLED_COUNT: defined at src\/led\.h:4\n {2}4 {2}#define LED_COUNT 4U$/);
    });

    test('references are grouped by file, each with its line, the definition and declaration marked', async () => {
        const text = await get({ symbol: 'led_on', what: 'references' });
        assert.match(text, /\n3 references to led_on in 3 files:\nsrc\/led\.c\n {6}10 {2}void led_on\(unsigned int index\) {3}\(definition\)\nsrc\/led\.h\n {7}7 {2}void led_on\(unsigned int index\); {3}\(declaration\)\nsrc\/main\.c\n {6}10 {2}led_on\(i\);$/);
        const limited = await get({ symbol: 'led_on', what: 'references', limit: 2 });
        assert.match(limited, /… and 1 more \(raise limit\)$/);
        assert.ok(!limited.includes('src/main.c'));
    });

    test('callers are a tree of ids with the lines of the calls, as deep as asked', async () => {
        const one = await get({ symbol: 'record', what: 'callers' });
        assert.match(one, /\n1 callers of record \(each an id, with the lines of the calls\):\n {2}led_on@src\/led\.c:10:6 {2}\(function\)\n {8}13 {2}record\(index\);$/);
        const three = await get({ symbol: 'record', what: 'callers', depth: 3 });
        assert.match(three, /3 callers of record, 3 levels deep/);
        assert.match(three, /\n {2}led_on@src\/led\.c:10:6 {2}\(function\)\n {8}13 {2}record\(index\);\n {4}blink_all@src\/main\.c:7:13 {2}\(function\)\n {10}10 {2}led_on\(i\);\n {6}main@src\/main\.c:14:5 {2}\(function\)\n {12}16 {2}blink_all\(\);$/);
    });

    test('a hierarchy ends at the limit, and at a function it has listed already', async () => {
        const limited = await get({ symbol: 'record', what: 'callers', depth: 3, limit: 2 });
        assert.match(limited, /2 callers of record/);
        assert.match(limited, /… the limit of entries ended the list \(raise limit\)$/);
        const recursive = await get({ symbol: `helper@${server.file('src/led.c')}:22:13`, what: 'callers', depth: 3 });
        assert.match(recursive, /helper@src\/led\.c:22:13 {2}\(function; callers listed above\)/);
    });

    test('callees carry the file of the call where it is not their own', async () => {
        const text = await get({ symbol: 'main', what: 'callees' });
        assert.match(text, /\n2 callees of main \(each an id, with the lines of the calls\):\n {2}blink_all@src\/main\.c:7:13 {2}\(function\)\n {8}16 {2}blink_all\(\);\n {2}led_lit@src\/led\.c:17:14 {2}\(function\)\n {4}src\/main\.c:17 {2}return \(int\)led_lit\(\);$/);
    });

    test('a clangd without callees, and a symbol the relation does not fit, are said so', async () => {
        server.missingMethods.add('callHierarchy/outgoingCalls');
        assert.match(await get({ symbol: 'main', what: 'callees' }), /This clangd \(clangd version 21\.0\.0 \(scripted\)\) does not answer callees; callees came with clangd 20\.$/);
        assert.match(await get({ symbol: 'lit', what: 'callers' }), /lit has no callers: clangd knows no function at src\/led\.c:3\.$/);
        assert.match(await get({ symbol: 'main', what: 'supertypes' }), /main has no supertypes: clangd knows no class or struct at src\/main\.c:14\.$/);
        assert.match(await get({ symbol: 'main', what: 'callers' }), /main has no callers in the index\. A call from an assembler file, or through a function pointer, is not one\.$/);
    });

    test('the types above and below a class, and its implementations', async () => {
        const card = await find({ name: 'Shape' });
        assert.match(card, /Shape: class\n {2}class Shape \{\}\n {2}Size: 1 bytes, alignment 1 bytes\n/);
        assert.match(card, /available {2}definition, references \(2 in 1 file\), supertypes \(0\), subtypes \(1\), implementations$/);
        assert.match(await get({ symbol: 'Shape', what: 'subtypes' }), /\n1 subtypes of Shape \(each an id\):\n {2}Circle@src\/shape\.hpp:6:7 {2}\(class\)$/);
        assert.match(await get({ symbol: 'Circle', what: 'supertypes' }), /\n {2}Shape@src\/shape\.hpp:3:7 {2}\(class\)$/);
        assert.match(await get({ symbol: 'Shape', what: 'implementations' }), /\n1 implementation of Shape:\nsrc\/shape\.hpp\n {7}6 {2}class Circle : public Shape \{$/);
        assert.match(await get({ symbol: 'main', what: 'implementations' }), /clangd knows no implementation of main/);
    });

    test('an id is taken back, also after its file changed, and falls back to the name', async () => {
        const id = /id {9}(\S+)/.exec(await find({ name: 'record' }))?.[1] ?? '';
        assert.strictEqual(id, 'record@src/led.c:5:13');
        assert.match(await get({ symbol: id, what: 'references' }), /2 references to record in 1 file:/);
        const file = server.file('src/led.c');
        fs.writeFileSync(file, `/* one line more */\n${fs.readFileSync(file, 'utf8')}`);
        assert.match(await get({ symbol: id, what: 'definition' }), /record: defined at src\/led\.c:6-9 \(4 lines\)/);
        const gone = await get({ symbol: 'nothing@src/led.c:5:13', what: 'references' });
        assert.match(gone, /The id nothing@src\/led\.c:5:13 no longer names a place where 'nothing' stands\.\nNo symbol named 'nothing'/);
    });

    test('an id answers only where its name stands as a whole name, not where a longer name begins with it', async () => {
        // The id of a function `led` at the place where `led_on` stands now, as after a rename of the function.
        const stale = 'led@src/led.c:10:6';
        const text = await get({ symbol: stale, what: 'definition' });
        assert.ok(!text.includes('led_on: defined'), 'the symbol that stands there now is another one');
        assert.match(text, /The id led@src\/led\.c:10:6 no longer names a place where 'led' stands\.\nNo symbol named 'led'/);
        // The same place under its own name still answers.
        assert.match(await get({ symbol: 'led_on@src/led.c:10:6', what: 'definition' }), /led_on: defined at src\/led\.c:10-15/);
    });

    test('a long answer ends within the budget and says what it left out', async () => {
        const file = server.file('src/main.c');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    blink_all();\n', '    blink_all();\n'.repeat(40)));
        const text = await get({ symbol: 'main', what: 'definition', maxChars: 500 });
        assert.ok(text.length <= 500, `${text.length} characters`);
        assert.match(text, /main: defined at src\/main\.c:14-57 \(44 lines\)/);
        assert.match(text, /… \(\+\d+ lines not shown: raise maxChars, or lower limit or depth\)$/);
    });

    // ------------------------------------------------- what the handler does

    test('a request refused because the document was not known yet is repeated', async () => {
        await find({ name: 'main' });
        server.refuseNextPosition = true;
        assert.match(await find({ fileFullPath: 'src/led.c', line: 19, name: 'lit' }), /lit: variable/);
    });

    test('a unit that changed on disk after it was indexed is opened before the answer', async () => {
        await find({ name: 'main' });
        const unit = server.file('src/shape.cpp');
        assert.ok(!server.opened.has(pathToFileURL(unit).href));
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(unit, later, later);
        await find({ name: 'main' });
        assert.ok(server.opened.has(pathToFileURL(unit).href), 'the changed unit is opened, so that clangd reads it again');
    });

    test('the first line says how far the index is, and when it is another target than the active one', async () => {
        fs.rmSync(path.join(server.root, 'out', '.cache', 'clangd', 'index', 'shape.cpp.0123456789ABCDEF.idx'));
        assert.match(await find({ name: 'main' }), /^Source index: Demo\.Debug\+Sim \(2 of 3 translation units indexed, so answers can be incomplete; clangd 21\.0\.0\)\./);
        fs.rmSync(path.join(server.root, 'out', '.cache'), { recursive: true });
        assert.match(await find({ name: 'main' }), /^Source index: Demo\.Debug\+Sim \(clangd has written no index yet, so answers by name can be incomplete; clangd 21\.0\.0\)\./);
        const elsewhere = windowWith({ imageFolders: [path.join(server.root, 'out', 'Other')] });
        assert.match(await find({ name: 'main' }, elsewhere), /\nNote: this is the project CMSIS Solution set up for clangd, not the active target's \(out\/Other\); the user chooses it in the CMSIS view/);
        const same = windowWith({ imageFolders: [path.join(server.root, 'out')] });
        assert.ok(!(await find({ name: 'main' }, same)).includes('Note:'));
    });

    test('a call that loses its client to a restart of clangd is made again with the new one', async () => {
        const second = new ScriptedClangd();
        try {
            let current = server;
            const extension: ClangdExtensionHandle = { isActive: true, exports: { getApi: () => ({ languageClient: current }) }, activate: () => Promise.resolve(undefined) };
            const host = scriptedHost(server, new SkippingClock(), { extension });
            // The documents the window opens reach whichever server runs.
            const open = host.openDocument;
            host.openDocument = async (file) => {
                const document = await open(file);
                second.opened.add(document.uri);
                return document;
            };
            let failed = false;
            server.onRequest = (method) => {
                if (method === 'textDocument/hover' && !failed) {
                    failed = true;
                    server.running = false;
                    current = second;
                    throw serverError(-32097, 'Pending response rejected since connection got disposed');
                }
            };
            const text = textOf(await new SourceBrowseHandler(host, { timeoutMs: 20_000 }).handleSourceFind({ name: 'main' }));
            assert.match(text, /main: function/);
            assert.ok(second.asked.includes('textDocument/hover'), 'the new client answered');
        } finally {
            second.dispose();
        }
    });

    test('a refusal of clangd that is no restart is a TASK_FAILED with its text', async () => {
        server.onRequest = (method) => {
            if (method === 'textDocument/references') {
                throw serverError(-32001, 'invalid AST');
            }
        };
        const failed = await refusal(get({ symbol: 'main', what: 'references' }));
        assert.strictEqual(failed.code, 'TASK_FAILED');
        assert.strictEqual(failed.message, 'clangd refused the request: invalid AST (-32001).');
    });

    // --------------------------------------------------------------- refusals

    test('no folder, no compile database, no clangd: each refusal says what is missing', async () => {
        const noFolder = await refusal(find({ name: 'main' }, windowWith({ folders: [] })));
        assert.strictEqual(noFolder.code, 'NO_WORKSPACE');

        const noSetup = await refusal(find({ name: 'main' }, windowWith({ arguments: [] })));
        assert.strictEqual(noSetup.code, 'TOOL_DISABLED');
        assert.match(noSetup.message, /clangd is not pointed at a compile database \(no --compile-commands-dir in the setting clangd\.arguments/);
        assert.match(noSetup.hint ?? '', /cmsis-csolution\.generateClangSetup[\s\S]*cmsis_action \{action:'convert'\}[\s\S]*Arm Environment Manager/);

        const noDatabase = await refusal(find({ name: 'main' }, windowWith({ arguments: ['--compile-commands-dir', path.join(server.root, 'build')] })));
        assert.strictEqual(noDatabase.code, 'TOOL_DISABLED');
        assert.strictEqual(noDatabase.message, 'source_find not attempted: the folder clangd is pointed at, build, has no compile_commands.json.');

        const noExtension = await refusal(find({ name: 'main' }, windowWith({ extension: null })));
        assert.strictEqual(noExtension.code, 'TOOL_DISABLED');
        assert.match(noExtension.message, /the clangd extension \(llvm-vs-code-extensions\.vscode-clangd\) is not installed or is disabled/);
        assert.strictEqual(server.asked.length, 0);
    });

    test('a compile database in the workspace folder is found without the setting', async () => {
        fs.copyFileSync(path.join(server.root, 'out', 'compile_commands.json'), path.join(server.root, 'compile_commands.json'));
        const text = await find({ name: 'main' }, windowWith({ arguments: ['--header-insertion=never'] }));
        assert.match(text, /^Source index: \S+ \(clangd has written no index yet/);
        assert.match(text, /main: function/);
    });
});
