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
 * A scripted clangd for the source-browsing tests: a small C and C++ project
 * written into a temporary folder, a language client that answers the
 * requests of the tools from the project's text and a table of its symbols,
 * and the host object around both. It behaves as the real server was
 * measured to: no answer by name before a document is open, a refusal for a
 * position in a document it was not told about, macros and locals absent
 * from the index, hover in Markdown.
 *
 * `test/transport/source-clangd.js` asks the same questions of a real clangd.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { Clock } from '../core/solutionApi';
import type { ClangdExtensionHandle, LanguageClientLike } from '../core/sourceBrowse/clangdApi';
import type { SourceBrowseHost } from '../core/sourceBrowse/host';
import type { Position, Range } from '../core/sourceBrowse/protocol';

/** The files of the project, by path under its folder. */
export const PROJECT_FILES: Readonly<Record<string, readonly string[]>> = {
    'src/led.h': [
        '#ifndef LED_H',
        '#define LED_H',
        '',
        '#define LED_COUNT 4U',
        '',
        '/** Switch one LED on. */',
        'void led_on(unsigned int index);',
        '',
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
        '',
        'static void helper(void)',
        '{',
        '    helper();',
        '}',
    ],
    'src/main.c': [
        '#include "led.h"',
        '',
        'static void helper(void)',
        '{',
        '}',
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
        'class Shape {',
        '};',
        '',
        'class Circle : public Shape {',
        '};',
    ],
    'src/shape.cpp': [
        '#include "shape.hpp"',
        '',
        'Circle unit;',
    ],
    'src/startup.s': [
        'Reset_Handler:',
        '    bl main',
    ],
};

/** What the scripted server knows about one symbol. */
interface Entry {
    name: string;
    /** The kind word of the hover and the `SymbolKind` number of the index. */
    word: string;
    kind: number;
    /** The code block of the hover. */
    code: string;
    /** Lines of the hover between heading and code. */
    notes?: string[];
    /** `file:line` (from 1) of the definition and of the declaration; the name is looked for on that line. */
    def?: string;
    decl?: string;
    /** In the index by name. */
    indexed: boolean;
    callers?: string[];
    callees?: string[];
    subtypes?: string[];
    supertypes?: string[];
}

const ENTRIES: readonly Entry[] = [
    { name: 'led_on', word: 'function', kind: 12, code: 'void led_on(unsigned int index)', notes: ['→ `void`  ', 'Parameters:  ', '- `unsigned int index`', '', 'Switch one LED on.  '],
        def: 'src/led.c:10', decl: 'src/led.h:7', indexed: true, callers: ['blink_all'], callees: ['record'] },
    { name: 'led_lit', word: 'function', kind: 12, code: 'unsigned int led_lit(void)', def: 'src/led.c:17', decl: 'src/led.h:9', indexed: true, callers: ['main'], callees: [] },
    { name: 'record', word: 'function', kind: 12, code: 'static void record(unsigned int index)', def: 'src/led.c:5', indexed: true, callers: ['led_on'], callees: [] },
    { name: 'blink_all', word: 'function', kind: 12, code: 'static void blink_all(void)', def: 'src/main.c:7', indexed: true, callers: ['main'], callees: ['led_on'] },
    { name: 'main', word: 'function', kind: 12, code: 'int main(void)', notes: ['→ `int`  '], def: 'src/main.c:14', indexed: true, callers: [], callees: ['blink_all', 'led_lit'] },
    { name: 'lit', word: 'variable', kind: 13, code: 'static unsigned int lit', notes: ['Type: `unsigned int`  '], def: 'src/led.c:3', indexed: true },
    { name: 'LED_COUNT', word: 'macro', kind: 15, code: '#define LED_COUNT 4U', def: 'src/led.h:4', indexed: false },
    { name: 'i', word: 'variable', kind: 13, code: 'unsigned int i = 0U', notes: ['Type: `unsigned int`  '], def: 'src/main.c:9', indexed: false },
    { name: 'Shape', word: 'class', kind: 5, code: 'class Shape {}', notes: ['Size: 1 bytes, alignment 1 bytes  '], def: 'src/shape.hpp:3', indexed: true, subtypes: ['Circle'], supertypes: [] },
    { name: 'Circle', word: 'class', kind: 5, code: 'class Circle : public Shape {}', def: 'src/shape.hpp:6', indexed: true, subtypes: [], supertypes: ['Shape'] },
];

/** The two functions named `helper`: one per file, so the table above cannot key them by name. */
const HELPERS: readonly Entry[] = [
    { name: 'helper', word: 'function', kind: 12, code: 'static void helper(void)', def: 'src/led.c:22', indexed: true, callers: ['helper'], callees: ['helper'] },
    { name: 'helper', word: 'function', kind: 12, code: 'static void helper(void)', def: 'src/main.c:3', indexed: true, callers: [], callees: [] },
];

/** A refusal as a language client rejects with. */
export function serverError(code: number, message: string): Error {
    return Object.assign(new Error(message), { code });
}

/** A clock whose timers fire at once and move its time on, so a wait costs no real time. */
export class SkippingClock implements Clock {
    private skipped = 0;

    now(): number {
        return Date.now() + this.skipped;
    }

    /** Lets `ms` pass. */
    advance(ms: number): void {
        this.skipped += ms;
    }

    startTimer(ms: number, fire: () => void): () => void {
        const handle = setImmediate(() => {
            this.skipped += ms;
            fire();
        });
        return () => clearImmediate(handle);
    }
}

/** The scripted server and its project. */
export class ScriptedClangd implements LanguageClientLike {
    readonly root: string;
    /** URIs the client told the server about. */
    readonly opened = new Set<string>();
    /** Every method asked, in order. */
    readonly asked: string[] = [];
    running = true;
    /** Answers by name stay empty for this many requests after the first document was opened: the index loads. */
    loadingAnswers = 0;
    /** The next request at a position is refused once as for a document that is not open yet. */
    refuseNextPosition = false;
    /** Methods the server does not have. */
    readonly missingMethods = new Set<string>();
    /** Called for every request before it is answered; may throw. */
    onRequest: ((method: string) => void) | undefined;
    initializeResult = {
        serverInfo: { name: 'clangd', version: 'clangd version 21.0.0 (scripted)' },
        capabilities: { callHierarchyProvider: true, typeHierarchyProvider: true } as Record<string, unknown>,
    };

    constructor() {
        this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-source-test-')));
        for (const [name, lines] of Object.entries(PROJECT_FILES)) {
            fs.mkdirSync(path.dirname(this.file(name)), { recursive: true });
            fs.writeFileSync(this.file(name), `${lines.join('\n')}\n`);
        }
        const out = path.join(this.root, 'out');
        fs.mkdirSync(path.join(out, '.cache', 'clangd', 'index'), { recursive: true });
        const units = Object.keys(PROJECT_FILES).filter((name) => /\.(c|cpp|s)$/.test(name));
        fs.writeFileSync(path.join(out, 'compile_commands.json'), JSON.stringify(units.map((name) => ({ directory: this.root, file: this.file(name), command: `cc -c ${name}` }))));
        fs.writeFileSync(path.join(out, 'Demo.Debug+Sim.cbuild.yml'), 'build:\n');
        for (const name of units.filter((unit) => !unit.endsWith('.s'))) {
            fs.writeFileSync(path.join(out, '.cache', 'clangd', 'index', `${path.basename(name)}.0123456789ABCDEF.idx`), 'shard');
        }
    }

    /** Removes the project. */
    dispose(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }

    /** The absolute path of a project file. */
    file(name: string): string {
        return path.join(this.root, ...name.split('/'));
    }

    isRunning(): boolean {
        return this.running;
    }

    // ── What the server knows ──────────────────────────────────────────────

    private lines(file: string): string[] {
        return fs.readFileSync(file, 'utf8').split('\n');
    }

    /**
     * The range of `name` on the line a `file:line` names, or on the first of
     * the five lines below that has it: a test that adds lines above a
     * definition moves it, as an edit moves it for the real server.
     */
    private nameRange(place: string, name: string): { uri: string; range: Range } {
        const at = place.lastIndexOf(':');
        const file = this.file(place.slice(0, at));
        const lines = this.lines(file);
        const pattern = new RegExp(`\\b${name}\\b`);
        let line = Number(place.slice(at + 1)) - 1;
        for (let below = 0; below <= 5 && !pattern.test(lines[line] ?? ''); below++) {
            line++;
        }
        const character = pattern.exec(lines[line] ?? '')?.index ?? 0;
        return { uri: pathToFileURL(file).href, range: { start: { line, character }, end: { line, character: character + name.length } } };
    }

    /** The entry a name means at a file: the `helper` of that file, else the one entry of the name. */
    private entry(name: string, uri?: string): Entry | undefined {
        if (name === 'helper') {
            return HELPERS.find((entry) => uri !== undefined && this.nameRange(entry.def ?? '', name).uri === uri) ?? HELPERS[0];
        }
        return ENTRIES.find((entry) => entry.name === name);
    }

    /** The identifier at a position of an opened document. */
    private wordAt(uri: string, position: Position): string | undefined {
        const line = this.lines(fileURLToPath(uri))[position.line] ?? '';
        const before = /[A-Za-z0-9_]*$/.exec(line.slice(0, position.character))?.[0] ?? '';
        const after = /^[A-Za-z0-9_]*/.exec(line.slice(position.character))?.[0] ?? '';
        const word = before + after;
        return word.length > 0 && /^[A-Za-z_]/.test(word) ? word : undefined;
    }

    /** Every place the identifier stands in the project's sources. */
    private occurrences(name: string, only?: string): Array<{ uri: string; range: Range }> {
        const found: Array<{ uri: string; range: Range }> = [];
        for (const file of Object.keys(PROJECT_FILES).filter((candidate) => !candidate.endsWith('.s'))) {
            const uri = pathToFileURL(this.file(file)).href;
            if (only !== undefined && uri !== only) {
                continue;
            }
            this.lines(this.file(file)).forEach((text, line) => {
                for (const match of text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
                    found.push({ uri, range: { start: { line, character: match.index }, end: { line, character: match.index + name.length } } });
                }
            });
        }
        return found;
    }

    /** The lines a definition covers: to the next line that is a closing brace, or the line itself. */
    private extent(entry: Entry): Range {
        const name = this.nameRange(entry.def ?? '', entry.name);
        const lines = this.lines(fileURLToPath(name.uri));
        let end = name.range.start.line;
        if (entry.word === 'function' || entry.word === 'class') {
            while (end < lines.length - 1 && !/^\}/.test(lines[end])) {
                end++;
            }
        }
        return { start: { line: name.range.start.line, character: 0 }, end: { line: end, character: lines[end].length } };
    }

    private item(entry: Entry): object {
        const name = this.nameRange(entry.def ?? '', entry.name);
        return { name: entry.name, kind: entry.kind, uri: name.uri, range: this.extent(entry), selectionRange: name.range, data: entry.name };
    }

    // ── The requests ───────────────────────────────────────────────────────

    sendRequest(method: string, params: unknown): Promise<unknown> {
        this.asked.push(method);
        try {
            this.onRequest?.(method);
            if (!this.running) {
                throw serverError(-32097, 'Client is not running');
            }
            if (this.missingMethods.has(method)) {
                throw serverError(-32601, 'method not found');
            }
            return Promise.resolve(this.answer(method, params as Record<string, never>));
        } catch (caught) {
            return Promise.reject(caught);
        }
    }

    private answer(method: string, params: { query?: string; textDocument?: { uri: string }; position?: Position; item?: { name: string; uri: string } }): unknown {
        if (method === 'workspace/symbol') {
            if (this.opened.size === 0) {
                return [];
            }
            if (this.loadingAnswers > 0) {
                this.loadingAnswers--;
                return [];
            }
            const query = (params.query ?? '').toLowerCase();
            return [...ENTRIES, ...HELPERS].filter((entry) => entry.indexed && entry.name.toLowerCase().includes(query))
                .map((entry) => ({ name: entry.name, kind: entry.kind, location: this.nameRange(entry.def ?? '', entry.name) }));
        }
        if (params.item !== undefined) {
            const entry = this.entry(params.item.name, params.item.uri);
            const calls = (names: readonly string[] | undefined, incoming: boolean): object[] => (names ?? []).map((name) => {
                const other = this.entry(name, params.item?.uri) ?? ENTRIES[0];
                const caller = incoming ? other : entry ?? other;
                const callee = incoming ? entry ?? other : other;
                const inFile = this.nameRange(caller.def ?? '', caller.name).uri;
                const body = this.extent(caller);
                const ranges = this.occurrences(callee.name, inFile).map((found) => found.range)
                    .filter((range) => range.start.line > body.start.line && range.start.line <= body.end.line);
                return incoming ? { from: this.item(other), fromRanges: ranges } : { to: this.item(other), fromRanges: ranges };
            });
            switch (method) {
                case 'callHierarchy/incomingCalls': return calls(entry?.callers, true);
                case 'callHierarchy/outgoingCalls': return calls(entry?.callees, false);
                case 'typeHierarchy/subtypes': return (entry?.subtypes ?? []).map((name) => this.item(this.entry(name) ?? ENTRIES[0]));
                case 'typeHierarchy/supertypes': return (entry?.supertypes ?? []).map((name) => this.item(this.entry(name) ?? ENTRIES[0]));
                default: throw serverError(-32601, 'method not found');
            }
        }
        const uri = params.textDocument?.uri ?? '';
        if (!this.opened.has(uri) || this.refuseNextPosition) {
            this.refuseNextPosition = false;
            throw serverError(-32602, 'trying to get AST for non-added document');
        }
        if (method === 'textDocument/documentSymbol') {
            return [...ENTRIES, ...HELPERS]
                .filter((entry) => entry.def !== undefined && entry.name !== 'i' && entry.word !== 'macro' && this.nameRange(entry.def, entry.name).uri === uri)
                .map((entry) => ({ name: entry.name, kind: entry.kind, range: this.extent(entry), selectionRange: this.nameRange(entry.def ?? '', entry.name).range, children: [] }))
                .sort((a, b) => a.range.start.line - b.range.start.line);
        }
        const word = params.position === undefined ? undefined : this.wordAt(uri, params.position);
        const entry = word === undefined ? undefined : this.entry(word, uri);
        switch (method) {
            case 'textDocument/hover':
                return entry === undefined ? null : {
                    contents: { kind: 'markdown', value: `### ${entry.word} \`${entry.name}\`  \n\n---\n${(entry.notes ?? []).join('\n')}\n\n---\n\`\`\`cpp\n${entry.code}\n\`\`\`` },
                };
            case 'textDocument/symbolInfo':
                if (entry === undefined) {
                    return [];
                }
                return [{
                    name: entry.name, containerName: '', usr: `c:@${entry.name}`,
                    ...(entry.word === 'macro' ? {} : {
                        definitionRange: entry.def === undefined ? undefined : this.nameRange(entry.def, entry.name),
                        declarationRange: this.nameRange(entry.decl ?? entry.def ?? '', entry.name),
                    }),
                }];
            case 'textDocument/definition':
                return entry?.def === undefined ? [] : [this.nameRange(entry.def, entry.name)];
            case 'textDocument/references':
                return entry === undefined ? [] : this.occurrences(entry.name, entry.name === 'helper' || entry.name === 'i' ? uri : undefined);
            case 'textDocument/prepareCallHierarchy':
                return entry?.word === 'function' ? [this.item(entry)] : [];
            case 'textDocument/prepareTypeHierarchy':
                return entry?.word === 'class' ? [this.item(entry)] : [];
            case 'textDocument/implementation':
                return entry?.word === 'class' ? (entry.subtypes ?? []).map((name) => this.nameRange(this.entry(name)?.def ?? '', name)) : [];
            default:
                throw serverError(-32601, 'method not found');
        }
    }
}

/** What a test changes about the window. */
export interface WindowScript {
    folders?: string[];
    /** `clangd.arguments`; the project's compile database by default, written with `${workspaceFolder}`. */
    arguments?: unknown[];
    enable?: boolean;
    /** The extension the window has; the scripted one by default, `null` for none. */
    extension?: ClangdExtensionHandle | null;
    imageFolders?: string[];
}

/** The window around a scripted clangd: an active clangd extension whose client it is. */
export function scriptedHost(server: ScriptedClangd, clock: Clock, script: WindowScript = {}): SourceBrowseHost {
    const extension: ClangdExtensionHandle = { isActive: true, version: '0.6.0', exports: { getApi: () => ({ languageClient: server }) }, activate: () => Promise.resolve(undefined) };
    return {
        workspaceFolders: () => script.folders ?? [server.root],
        packRoot: () => Promise.resolve(undefined),
        clangdExtension: () => (script.extension === null ? undefined : script.extension ?? extension),
        clangdSettings: () => ({ enable: script.enable ?? true, path: 'clangd', arguments: script.arguments ?? ['--compile-commands-dir=${workspaceFolder}/out'] }),
        variable: (name) => (name === 'workspaceFolder' ? (script.folders ?? [server.root])[0] : undefined),
        openDocument: (file) => {
            const uri = pathToFileURL(file).href;
            server.opened.add(uri);
            const languageId = file.endsWith('.s') ? 'arm' : /\.(cpp|hpp)$/.test(file) ? 'cpp' : 'c';
            return Promise.resolve({ uri, languageId, text: fs.readFileSync(file, 'utf8') });
        },
        readText: (file) => Promise.resolve(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
        activeImageFolders: script.imageFolders === undefined ? undefined : () => Promise.resolve(script.imageFolders),
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        clock,
    };
}
