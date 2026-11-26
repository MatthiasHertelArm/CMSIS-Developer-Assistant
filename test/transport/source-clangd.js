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

// The source-browsing tools against a real clangd.
//
// Runs out/src/sourceBrowseHandler.js with a host whose "clangd extension"
// is a clangd of this machine, spoken to over stdio, and a small C and C++
// project written into a temporary folder with its compile database. What
// the unit tests script, this checks against the real server: the index by
// name, a macro found from a use, the outline, the definition text,
// references, callers and callees, the type hierarchy, an id passed back, a
// file changed on disk, a document the editor has open through a symbolic
// link with unsaved text, and the refusals.
//
// The answers depend on the clangd of the machine, so this is a local check
// like test:surface, not a CI job. Without a clangd on the PATH it says so
// and passes. Everything else that keeps it from checking is a failure: a
// CLANGD that is no clangd, a clangd that goes away or stays silent, and a
// run that ends before its summary.
//
//   node test/transport/source-clangd.js           (clangd from PATH)
//   CLANGD=/path/to/clangd node test/transport/source-clangd.js
//   SHOW=1 node test/transport/source-clangd.js    (prints every reply)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const { SourceBrowseHandler } = require(path.join(OUT, 'sourceBrowseHandler.js'));
const { silentLog } = require(path.join(OUT, 'core', 'packDocs', 'host.js'));
const { openDocumentIndex } = require(path.join(OUT, 'core', 'sourceBrowse', 'filePaths.js'));

let failures = 0;
let passes = 0;
/** Set when the run reached its summary, or the skip it documents: an exit without it is no pass. */
let verdict = false;
/** How long clangd may take to answer `initialize`. */
const START_MS = 30_000;
/** How long the whole run may take. */
const RUN_MS = 10 * 60_000;
function check(name, ok, detail) {
    if (ok) { passes++; console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
    // SHOW=1 prints every reply, to read the texts an agent gets.
    if (ok && process.env.SHOW && typeof detail === 'string') { console.log(detail.split('\n').map((line) => `         | ${line}`).join('\n')); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The project ────────────────────────────────────────────────────────────

const FILES = {
    'src/led.h': [
        '#ifndef LED_H',
        '#define LED_H',
        '',
        '#define LED_COUNT 4U',
        '',
        '/** Switch one LED on. */',
        'void led_on(unsigned int index);',
        '',
        '/** How many LEDs are on. */',
        'unsigned int led_lit(void);',
        '',
        '#endif',
    ],
    'src/led.c': [
        '#include "led.h"',
        '',
        'static unsigned int lit;',
        '',
        'static void record(unsigned int index)',
        '{',
        '    lit |= 1U << index;',
        '}',
        '',
        'void led_on(unsigned int index)',
        '{',
        '    if (index < LED_COUNT) {',
        '        record(index);',
        '    }',
        '}',
        '',
        'unsigned int led_lit(void)',
        '{',
        '    return lit;',
        '}',
    ],
    'src/main.c': [
        '#include "led.h"',
        '',
        'static void blink_all(void)',
        '{',
        '    for (unsigned int i = 0U; i < LED_COUNT; i++) {',
        '        led_on(i);',
        '    }',
        '}',
        '',
        'int main(void)',
        '{',
        '    blink_all();',
        '    return (int)led_lit();',
        '}',
    ],
    'src/shape.hpp': [
        '#pragma once',
        '',
        'namespace geo {',
        '',
        'class Shape {',
        'public:',
        '    virtual ~Shape() = default;',
        '    virtual double area() const = 0;',
        '};',
        '',
        'class Circle : public Shape {',
        'public:',
        '    explicit Circle(double radius) : radius_(radius) {}',
        '    double area() const override;',
        'private:',
        '    double radius_;',
        '};',
        '',
        'class Square : public Shape {',
        'public:',
        '    explicit Square(double side) : side_(side) {}',
        '    double area() const override;',
        'private:',
        '    double side_;',
        '};',
        '',
        'template <class T> class Stack {',
        'public:',
        '    void push(T value);',
        '    T top;',
        '};',
        '',
        '}  // namespace geo',
    ],
    'src/limits.hpp': [
        '#pragma once',
        '',
        '#define MAX_SIDE 100.0',
    ],
    'src/shape.cpp': [
        '#include "shape.hpp"',
        '#include "limits.hpp"',
        '',
        'namespace geo {',
        '',
        'double Circle::area() const',
        '{',
        '    return 3.14159 * radius_ * radius_;',
        '}',
        '',
        'double Square::area() const',
        '{',
        '    return side_ > MAX_SIDE ? 0.0 : side_ * side_;',
        '}',
        '',
        'double both(const Circle &circle, const Square &square)',
        '{',
        '    return circle.area() + square.area();',
        '}',
        '',
        '}  // namespace geo',
        '',
        'template <class T> void geo::Stack<T>::push(T value) { top = value; }',
    ],
};

/** Writes the project and its compile database; returns the folder, symbolic links resolved. */
function writeProject() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-source-')));
    for (const [name, lines] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), lines.join('\n') + '\n');
    }
    const out = path.join(root, 'out');
    fs.mkdirSync(out);
    const units = Object.keys(FILES).filter((name) => /\.(c|cpp)$/.test(name));
    fs.writeFileSync(path.join(out, 'compile_commands.json'), JSON.stringify(units.map((name) => ({
        directory: root,
        file: path.join(root, name),
        command: `${name.endsWith('.cpp') ? 'clang++ -std=c++17' : 'clang -std=c11'} -I${path.join(root, 'src')} -c ${path.join(root, name)}`,
    })), null, 2));
    fs.writeFileSync(path.join(out, 'Demo.Debug+Host.cbuild.yml'), 'build:\n');
    return root;
}

// ── clangd over stdio, with the face of a language client ───────────────────

class StdioClient {
    constructor(command, args, cwd) {
        this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        this.buffer = Buffer.alloc(0);
        this.pending = new Map();
        this.nextId = 1;
        this.versions = new Map();
        this.initializeResult = undefined;
        /** Why the server is gone, once it is: every request waiting for it is rejected, and so is every later one. */
        this.gone = undefined;
        this.child.stdout.on('data', (chunk) => this.read(chunk));
        this.child.on('error', (error) => this.end(`${command} could not be started: ${error.message}`));
        this.child.on('exit', (code, signal) => this.end(`${command} exited (${signal ?? `code ${code}`})`));
        // A write to a server that has gone fails later, as an event of the pipe.
        this.child.stdin.on('error', (error) => this.end(`${command} closed its input: ${error.message}`));
    }

    /** The server is gone: no request waits for an answer that cannot come. */
    end(why) {
        if (this.gone !== undefined) { return; }
        this.gone = why;
        for (const entry of this.pending.values()) { entry.reject(new Error(why)); }
        this.pending.clear();
    }

    isRunning() {
        return this.initializeResult !== undefined && this.gone === undefined && this.child.exitCode === null;
    }

    write(message) {
        if (this.gone !== undefined) { return; }
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.child.stdin.write(body);
    }

    read(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) { return; }
            const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))[1]);
            if (this.buffer.length < headerEnd + 4 + length) { return; }
            const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'));
            this.buffer = this.buffer.subarray(headerEnd + 4 + length);
            if (message.id !== undefined && message.method === undefined) {
                const entry = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (entry && message.error) { entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); }
                else if (entry) { entry.resolve(message.result); }
            } else if (message.id !== undefined) {
                this.write({ jsonrpc: '2.0', id: message.id, result: null });
            }
        }
    }

    sendRequest(method, params) {
        if (this.gone !== undefined) {
            return Promise.reject(new Error(`${this.gone}: ${method} was not sent`));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }

    async start(root) {
        const initialized = this.sendRequest('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            capabilities: {
                textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, callHierarchy: {}, typeHierarchy: {} },
            },
        });
        // A server that runs and says nothing would be waited for until the run's own limit.
        let waiting;
        const silent = new Promise((_, reject) => {
            waiting = setTimeout(() => reject(new Error(`the server did not answer initialize within ${START_MS / 1000} s`)), START_MS);
        });
        try {
            this.initializeResult = await Promise.race([initialized, silent]);
        } catch (caught) {
            this.child.kill();
            throw caught;
        } finally {
            clearTimeout(waiting);
        }
        this.notify('initialized', {});
    }

    /** What a language client does when the editor opens or reloads a document. */
    open(file) {
        const uri = pathToFileURL(file).href;
        const text = fs.readFileSync(file, 'utf8');
        const known = this.versions.get(uri);
        if (known === undefined) {
            this.versions.set(uri, { version: 1, text });
            this.notify('textDocument/didOpen', { textDocument: { uri, languageId: /\.(cpp|hpp)$/.test(file) ? 'cpp' : 'c', version: 1, text } });
        } else if (known.text !== text) {
            known.version++;
            known.text = text;
            this.notify('textDocument/didChange', { textDocument: { uri, version: known.version }, contentChanges: [{ text }] });
        }
        return { uri, languageId: /\.(cpp|hpp)$/.test(file) ? 'cpp' : 'c', text };
    }

    /** What a language client has done for a document the editor holds with text of its own, unsaved. */
    openWith(file, text) {
        const uri = pathToFileURL(file).href;
        const languageId = /\.(cpp|hpp)$/.test(file) ? 'cpp' : 'c';
        this.versions.set(uri, { version: 1, text });
        this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
        return { uri, languageId, text };
    }

    async stop() {
        await Promise.race([this.sendRequest('shutdown', null), sleep(2000)]).catch(() => undefined);
        this.notify('exit');
        await sleep(100);
        this.child.kill();
    }
}

// ── The run ────────────────────────────────────────────────────────────────

/** Runs the checks; resolves with 'skipped' when the machine has no clangd on the PATH and none was named. */
async function main() {
    const named = process.env.CLANGD;
    const clangd = named || 'clangd';
    const version = spawnSync(clangd, ['--version'], { encoding: 'utf8' });
    if (!named && version.error?.code === 'ENOENT') {
        console.log('no clangd on the PATH: the check against a real clangd is skipped. Set CLANGD to run it.');
        return 'skipped';
    }
    // A clangd that was named has to be one, and so has a `clangd` the PATH has: skipping here would pass a run that checked nothing.
    if (version.error || version.status !== 0 || !/clangd version/i.test(version.stdout)) {
        const said = version.error?.message ?? `exit code ${version.status}, "${(version.stdout || version.stderr || '').split('\n')[0]}"`;
        throw new Error(`${named ? `CLANGD=${named}` : 'the clangd on the PATH'} is no clangd: --version gave ${said}.`);
    }
    console.log(`clangd: ${version.stdout.split('\n')[0]}`);
    const root = writeProject();
    const out = path.join(root, 'out');
    const client = new StdioClient(clangd, [`--compile-commands-dir=${out}`, '--log=error'], root);
    await client.start(root);

    const host = {
        workspaceFolders: () => [root],
        packRoot: async () => undefined,
        clangdExtension: () => ({ isActive: true, version: 'stdio', exports: { getApi: () => ({ languageClient: client }) }, activate: async () => undefined }),
        clangdSettings: () => ({ enable: true, path: clangd, arguments: ['--compile-commands-dir=${workspaceFolder}/out'] }),
        variable: (name) => (name === 'workspaceFolder' ? root : undefined),
        openDocument: async (file) => client.open(file),
        readText: async (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } },
        log: silentLog,
        clock: { now: () => Date.now(), startTimer: (ms, fire) => { const handle = setTimeout(fire, ms); return () => clearTimeout(handle); } },
    };
    const handler = new SourceBrowseHandler(host, { timeoutMs: 30_000 });
    const text = (result) => (typeof result === 'string' ? result : result.text);
    const find = async (args) => text(await handler.handleSourceFind(args));
    const get = async (args) => text(await handler.handleSourceGet(args));
    const failure = async (run) => { try { await run(); return undefined; } catch (caught) { return caught; } };

    console.log('source_find');
    const ledOn = await find({ name: 'led_on' });
    check('the first line names the context and the paths', /^Source index: Demo\.Debug\+Host/.test(ledOn) && ledOn.includes(`relative paths start at ${root}`), ledOn.split('\n').slice(0, 3).join(' | '));
    check('a function by name: kind, signature, where defined and declared, an id', /led_on: function/.test(ledOn) && /defined {4}src\/led\.c:10/.test(ledOn)
        && /declared {3}src\/led\.h:7/.test(ledOn) && /id {9}led_on@src\/led\.c:10:6/.test(ledOn), ledOn);
    check('the card says what source_get returns, with counts', /available {2}definition, references \(3 in 3 files\), callers \(1\), callees/.test(ledOn), ledOn.split('\n').pop());
    // No open document includes limits.hpp yet, so the index does not have this macro by name.
    const macro = await find({ name: 'MAX_SIDE' });
    check('a macro by name is found from a use, with its definition', /MAX_SIDE: macro/.test(macro) && /#define MAX_SIDE 100\.0/.test(macro)
        && /found {6}from its use at src\/shape\.cpp:13/.test(macro) && /defined {4}src\/limits\.hpp:3/.test(macro), macro);
    const openMacro = await find({ name: 'LED_COUNT' });
    check('a macro of a header an open document includes is in the index by name', /LED_COUNT: macro/.test(openMacro) && /#define LED_COUNT 4U/.test(openMacro)
        && /defined {4}src\/led\.h:4/.test(openMacro), openMacro);
    const local = await find({ name: 'record' });
    check('a function of one source file by name', /record: function/.test(local) && /defined {4}src\/led\.c:5/.test(local), local);
    const outline = await find({ fileFullPath: path.join(root, 'src', 'led.c') });
    check('the outline of a file lists its symbols with their lines', /Outline of src\/led\.c/.test(outline) && /5-8\s+record: function/.test(outline)
        && /10-15\s+led_on: function/.test(outline), outline);
    const loop = await find({ fileFullPath: 'src/main.c', line: 6, name: 'i' });
    check('a local variable from a use site', /^i: (variable|param)/m.test(loop) && /defined {4}src\/main\.c:5/.test(loop), loop);
    const enclosing = await find({ fileFullPath: 'src/main.c', line: 6 });
    check('a line without a name is the function it lies in', /blink_all: function/.test(enclosing), enclosing);
    const nearLine = await find({ fileFullPath: 'src/main.c', line: 13, name: 'blink_all' });
    check('a name one line off is still found', /blink_all: function/.test(nearLine), nearLine);
    const missing = await find({ name: 'no_such_symbol_xyz' });
    check('a name nobody has is reported with the other ways to ask', /No symbol named 'no_such_symbol_xyz'/.test(missing) && /fileFullPath and line/.test(missing), missing);
    const wrongFile = await failure(() => find({ fileFullPath: 'src/none.c' }));
    check('a file that does not exist is an INVALID_ARGUMENT', wrongFile?.code === 'INVALID_ARGUMENT', String(wrongFile?.message ?? wrongFile));
    const shape = await find({ name: 'geo::Shape' });
    check('a class by its qualified name offers the type hierarchy', /Shape: class in geo/.test(shape) && /supertypes \(0\), subtypes \(2\)/.test(shape), shape);

    // Circle::area stands first in the file, in its outline and in its text.
    const squareArea = await find({ fileFullPath: 'src/shape.cpp', name: 'geo::Square::area' });
    check('a qualified name with a file is the symbol of that scope, not the first of the name', /area: instance-method in geo::Square/.test(squareArea)
        && /defined {4}src\/shape\.cpp:11/.test(squareArea), squareArea);
    const squareTail = await find({ fileFullPath: 'src/shape.cpp', name: 'Square::area' });
    check('the tail of the qualified name is enough', /area: instance-method in geo::Square/.test(squareTail) && /defined {4}src\/shape\.cpp:11/.test(squareTail), squareTail);
    const squareDeclared = await find({ fileFullPath: 'src/shape.hpp', name: 'Square::area' });
    check('in the header the scope is the class around the member', /area: instance-method in geo::Square/.test(squareDeclared)
        && /declared {3}src\/shape\.hpp:22/.test(squareDeclared), squareDeclared);
    const noTriangle = await failure(() => find({ fileFullPath: 'src/shape.cpp', name: 'Triangle::area' }));
    check('a scope the file does not have is an INVALID_ARGUMENT, not the area of another class', noTriangle?.code === 'INVALID_ARGUMENT'
        && /it is the name of another scope/.test(noTriangle.message), String(noTriangle?.message ?? noTriangle));
    // clangd writes the member of a class template as geo::Stack<T>::push in the outline, and its scope as geo::Stack.
    const pushed = await find({ fileFullPath: 'src/shape.cpp', name: 'Stack::push' });
    check('the member of a class template is found under the name of the template', /push: instance-method in geo::Stack/.test(pushed)
        && /defined {4}src\/shape\.cpp:23/.test(pushed), pushed);
    const pushedInt = await find({ fileFullPath: 'src/shape.cpp', name: 'geo::Stack<int>::push' });
    check('and with template arguments in its scope', /push: instance-method in geo::Stack/.test(pushedInt) && /defined {4}src\/shape\.cpp:23/.test(pushedInt), pushedInt);
    // What a qualified name found from a use rests on: at a use, clangd names the scope of the member.
    const shapeUnit = path.join(root, 'src', 'shape.cpp');
    const useLine = FILES['src/shape.cpp'].findIndex((line) => line.includes('square.area()'));
    const atUse = await client.sendRequest('textDocument/symbolInfo', {
        textDocument: { uri: pathToFileURL(shapeUnit).href },
        position: { line: useLine, character: FILES['src/shape.cpp'][useLine].indexOf('area', FILES['src/shape.cpp'][useLine].indexOf('square.')) },
    });
    check('at a use of a member clangd names its scope', atUse?.[0]?.name === 'area' && atUse[0].containerName === 'geo::Square::', atUse);

    console.log('source_get');
    const definition = await get({ symbol: 'led_on', what: 'definition' });
    check('the definition is its source with line numbers', /led_on: defined at src\/led\.c:10-15 \(6 lines\)/.test(definition)
        && /10 {2}void led_on\(unsigned int index\)/.test(definition) && /13 {10}record\(index\);/.test(definition), definition);
    const macroText = await get({ symbol: 'LED_COUNT', what: 'definition' });
    check('the definition of a macro is its #define', /LED_COUNT: defined at src\/led\.h:4/.test(macroText) && /#define LED_COUNT 4U/.test(macroText), macroText);
    const references = await get({ symbol: 'led_on', what: 'references' });
    check('references are grouped by file with their lines', /3 references to led_on in 3 files/.test(references) && /src\/main\.c\n\s+6 {2}led_on\(i\);/.test(references)
        && /\(definition\)/.test(references) && /\(declaration\)/.test(references), references);
    const id = /id {9}(\S+)/.exec(ledOn)?.[1] ?? '';
    const byId = await get({ symbol: id, what: 'references' });
    check('an id of source_find is taken back', /3 references to led_on/.test(byId), byId);
    const callers = await get({ symbol: 'record', what: 'callers', depth: 3 });
    check('callers over three levels, each an id with its call lines', /led_on@src\/led\.c:10:6/.test(callers) && /blink_all@src\/main\.c:3:13/.test(callers)
        && /main@src\/main\.c:10:5/.test(callers) && /13 {2}record\(index\);/.test(callers), callers);
    const callees = await get({ symbol: 'main', what: 'callees' });
    check('callees, or the note that this clangd has none', (/blink_all@src\/main\.c/.test(callees) && /led_lit@src\/led\.c/.test(callees)) || /does not answer callees/.test(callees), callees);
    const subtypes = await get({ symbol: 'geo::Shape', what: 'subtypes' });
    check('the subtypes of a class', /2 subtypes of Shape \(each an id\)/.test(subtypes) && /Circle@src\/shape\.hpp:11:7/.test(subtypes) && /Square@src\/shape\.hpp:19:7/.test(subtypes), subtypes);
    const implementations = await get({ symbol: `area@${path.join(root, 'src', 'shape.hpp')}:8:20`, what: 'implementations' });
    // clangd names the definitions it has indexed, else the declarations in the classes.
    check('the implementations of a virtual function', /2 implementations of area/.test(implementations)
        && (/double Circle::area\(\) const/.test(implementations) || /double area\(\) const override;/.test(implementations)), implementations);
    const several = await get({ symbol: 'area', what: 'references' });
    check('a name several symbols have is answered with their ids', /symbols are named 'area'/.test(several) && /area@src\/shape\.(cpp|hpp):\d+:\d+ {2}\(method in geo::/.test(several), several);
    const noCallers = await get({ symbol: 'LED_COUNT', what: 'callers' });
    check('a relation that does not fit the symbol says so', /has no callers/.test(noCallers), noCallers);
    const badWhat = await get({ symbol: 'led_on', what: 'users' });
    check('an unknown relation names the ones there are', /is none of definition, references/.test(badWhat), badWhat);

    console.log('a file changed on disk');
    await sleep(1100);   // the modification time has to be later than the shard's
    fs.appendFileSync(path.join(root, 'src', 'main.c'), '\nvoid one_more(void)\n{\n    led_on(0U);\n}\n');
    const after = await get({ symbol: 'led_on', what: 'references' });
    check('a unit newer than its index is read again before the answer', /4 references to led_on in 3 files/.test(after) && /led_on\(0U\);/.test(after), after);

    console.log('a document the editor has open under another spelling of its path');
    // The editor has src/led.c open through a symbolic link, with two unsaved lines at its top; a clangd of its own,
    // as after a reload of the window, knows the file only as that document. The host finds it as the window does.
    const linked = path.join(root, 'linked');
    let hasLink = true;
    try { fs.symlinkSync(path.join(root, 'src'), linked, 'dir'); } catch { hasLink = false; }
    if (!hasLink) {
        console.log('  (skipped: this account cannot make a symbolic link)');
    } else {
        const editorClient = new StdioClient(clangd, [`--compile-commands-dir=${out}`, '--log=error'], root);
        await editorClient.start(root);
        const unsaved = `/* unsaved */\n/* unsaved */\n${fs.readFileSync(path.join(root, 'src', 'led.c'), 'utf8')}`;
        const editor = [{ path: path.join(linked, 'led.c'), ...editorClient.openWith(path.join(linked, 'led.c'), unsaved) }];
        const known = new Map();
        const documentOf = (file) => editor[openDocumentIndex(file, editor.map((document) => document.path), known)];
        const inEditor = new SourceBrowseHandler({
            ...host,
            clangdExtension: () => ({ isActive: true, version: 'stdio', exports: { getApi: () => ({ languageClient: editorClient }) }, activate: async () => undefined }),
            openDocument: async (file) => {
                const document = documentOf(file);
                return document ? { uri: document.uri, languageId: document.languageId, text: document.text } : editorClient.open(file);
            },
            readText: async (file) => documentOf(file)?.text ?? host.readText(file),
        }, { timeoutMs: 30_000 });
        const moved = text(await inEditor.handleSourceFind({ fileFullPath: 'src/led.c', line: 7, name: 'record' }));
        check('a symbol is where the editor\'s unsaved text has it, two lines further down', /record: function/.test(moved) && /defined {4}src\/led\.c:7/.test(moved), moved);
        const movedText = text(await inEditor.handleSourceGet({ symbol: 'record@src/led.c:7:13', what: 'definition' }));
        check('its definition is quoted from that text, under the line numbers clangd gives', /record: defined at src\/led\.c:7-10 \(4 lines\)/.test(movedText)
            && /7 {2}static void record\(unsigned int index\)/.test(movedText), movedText);
        const movedReferences = text(await inEditor.handleSourceGet({ symbol: 'record@src/led.c:7:13', what: 'references' }));
        // clangd answers from the document (lines 7 and 15) and, under the real path, from the index of the saved file (5 and 13).
        check('its references are the ones of that text, each once, without the ones of the saved file', /2 references to record in 1 file/.test(movedReferences)
            && /\n\s+7 {2}static void record\(unsigned int index\) {3}\(definition\)\n\s+15 {2}record\(index\);$/.test(movedReferences), movedReferences);
        // A hierarchy carries items with the path clangd gives them, which need not be the one the document is open under.
        /** The reply, or what the call was refused with. */
        const answerOf = async (args) => { try { return text(await inEditor.handleSourceGet(args)); } catch (caught) { return caught; } };
        const movedCallers = await answerOf({ symbol: 'record@src/led.c:7:13', what: 'callers', depth: 3 });
        check('callers over three levels from that document, with its line numbers', typeof movedCallers === 'string' && /led_on@src\/led\.c:12:6/.test(movedCallers)
            && /blink_all@src\/main\.c:3:13/.test(movedCallers) && /15 {2}record\(index\);/.test(movedCallers), String(movedCallers?.message ?? movedCallers));
        const movedCallees = await answerOf({ symbol: 'led_on', what: 'callees' });
        check('callees from that document, or the note that this clangd has none', typeof movedCallees === 'string'
            && (/record@src\/led\.c:7:13/.test(movedCallees) || /does not answer callees/.test(movedCallees)), String(movedCallees?.message ?? movedCallees));
        await editorClient.stop();
    }

    console.log('refusals');
    const refusal = async (change) => {
        const other = new SourceBrowseHandler({ ...host, ...change }, { timeoutMs: 5_000 });
        return failure(() => other.handleSourceFind({ name: 'led_on' }));
    };
    const noFolder = await refusal({ workspaceFolders: () => [] });
    check('no folder: NO_WORKSPACE', noFolder?.code === 'NO_WORKSPACE', String(noFolder?.message));
    const noExtension = await refusal({ clangdExtension: () => undefined });
    check('no clangd extension: TOOL_DISABLED, and nothing is installed', noExtension?.code === 'TOOL_DISABLED' && /Keil Studio Pack/.test(noExtension.hint ?? ''), String(noExtension?.message));
    const noServer = await refusal({ clangdExtension: () => ({ isActive: true, exports: { getApi: () => ({ languageClient: undefined }) }, activate: async () => undefined }) });
    check('no language server: TOOL_DISABLED with the download command, and no download', noServer?.code === 'TOOL_DISABLED' && /Download language server/.test(noServer.hint ?? ''), String(noServer?.message));
    const noDatabase = await refusal({ clangdSettings: () => ({ enable: true, path: clangd, arguments: [`--compile-commands-dir=${path.join(root, 'nowhere')}`] }) });
    check('no compile database: TOOL_DISABLED that names the folder and the next step', noDatabase?.code === 'TOOL_DISABLED' && /nowhere/.test(noDatabase.message) && /cmsis_action/.test(noDatabase.hint ?? ''), String(noDatabase?.message));

    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
}

// A run that ends without its summary has checked nothing it can vouch for: a promise that never settles lets Node
// end with exit code 0 once nothing else keeps it alive. Such an end is turned into a failure here.
process.on('exit', (code) => {
    if (!verdict && code === 0) {
        console.error(`\nsource-clangd.js ended before its summary, after ${passes + failures} check(s): no verdict, so this is a failure.`);
        process.exitCode = 1;
    }
});
// Nor does the run wait for ever; the timer alone does not keep the process alive.
setTimeout(() => {
    console.error(`\nsource-clangd.js did not finish within ${RUN_MS / 60_000} minutes, after ${passes + failures} check(s).`);
    process.exit(1);
}, RUN_MS).unref();

main().then((outcome) => {
    verdict = true;
    if (outcome === 'skipped') {
        process.exit(0);
    }
    if (failures === 0 && passes === 0) {
        console.log('\nNO CHECK RAN');
        process.exit(1);
    }
    console.log(failures === 0 ? `\nALL CHECKS PASSED (${passes})` : `\n${failures} CHECK(S) FAILED, ${passes} passed`);
    process.exit(failures === 0 ? 0 : 1);
}, (caught) => {
    verdict = true;
    console.error(caught instanceof Error ? `\nFAILED: ${caught.message}` : caught);
    process.exit(1);
});
