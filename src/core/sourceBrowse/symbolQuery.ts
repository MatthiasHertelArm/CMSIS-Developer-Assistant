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
 * From what an agent has, a name, a use site or an id, to a position clangd
 * can be asked about, and from there to what clangd says about the symbol.
 *
 * Three facts of clangd shape this module, all measured:
 * - A request at a position needs the document opened on the server, so
 *   `Lookup` opens every file it asks about, once per call, and repeats a
 *   request the server refused because the `didOpen` had not arrived yet.
 * - The index answers by name for functions, variables, types, fields and
 *   enumerators only. A macro and a local variable are found from a place
 *   where they are used, and so is a symbol of a source file whose path
 *   reaches the compile database through a symbolic link; `searchUseSites`
 *   finds such a place in the translation units.
 * - `textDocument/symbolInfo` gives the declaration and the definition in one
 *   answer; `textDocument/definition` on a definition answers the declaration.
 *
 * No `vscode`; file access only through the functions handed in.
 */

import { fileURLToPath } from 'url';
import type { Clock } from '../solutionApi';
import { ToolError } from '../toolResult';
import { HoverParts, parseHover } from './hoverText';
import {
    DocumentSymbol, Hover, Location, OpenedDocument, Position, SourceIndex, SymbolDetails, SymbolInformation, contains, isUnknownDocument,
    kindName, lastLineOf, locationsOf,
} from './protocol';
import { findNear, occurrences, unqualified } from './symbolId';

/** How often a request is repeated for a document the server does not know yet. */
const UNKNOWN_DOCUMENT_TRIES = 6;
/** Lines above and below a given line on which a name is still found. */
const NEAR_LINES = 5;
/** Places in one file clangd is asked about at most, to find the one a qualified name means. */
const QUALIFIED_TRIES = 12;
/** Lines of one file scanned between two looks at the clock. */
const LINES_PER_TIME_CHECK = 1_000;
/** A search in the text leaves the call this much time for the questions that follow it. */
const TIME_LEFT_MS = 1_500;

/** A place in a file: the position of a name, zero-based. */
export interface FilePlace {
    file: string;
    position: Position;
}

/** What is known about one symbol. */
export interface ResolvedSymbol {
    name: string;
    /** The scope the symbol is in: a namespace or a class, without the trailing `::`. */
    container?: string;
    /** True when clangd named the scope: then no `container` means the global scope, not an unknown one. */
    scoped?: boolean;
    /** The kind word: clangd's on hover, else the word for the index entry's kind. */
    kind?: string;
    /** The place the requests about the symbol are sent with. */
    at: FilePlace;
    definition?: FilePlace;
    declaration?: FilePlace;
    hover?: HoverParts;
    /** A note on how the symbol was found, when not by the plain way. */
    foundBy?: string;
}

/** Resolves after `ms` on `clock`. */
function pause(ms: number, clock: Pick<Clock, 'startTimer'>): Promise<void> {
    return new Promise((resolve) => {
        clock.startTimer(ms, resolve);
    });
}

/** The file a `file:` URI of the server names; the URI itself when it is no file URI. */
export function fileOfUri(uri: string): string {
    try {
        return fileURLToPath(uri);
    } catch {
        return uri;
    }
}

/**
 * One tool call's conversation with the language server: the documents it
 * opened, the texts it read, and its deadline.
 */
export class Lookup {
    private readonly documents = new Map<string, Promise<OpenedDocument>>();
    private readonly texts = new Map<string, Promise<string[] | undefined>>();

    constructor(
        readonly index: SourceIndex,
        private readonly clock: Clock,
        readonly deadline: number,
        private readonly readText: (file: string) => Promise<string | undefined>,
        /** A path as the roots spell it: symbolic links resolved. */
        readonly canonical: (file: string) => string = (file) => file,
    ) { }

    /** True while the call has time left. */
    hasTime(marginMs = 0): boolean {
        return this.clock.now() + marginMs < this.deadline;
    }

    /** The document of `file`, opened on the server once per call. */
    document(file: string): Promise<OpenedDocument> {
        let opened = this.documents.get(file);
        if (opened === undefined) {
            opened = this.index.open(file);
            this.documents.set(file, opened);
            opened.catch(() => this.documents.delete(file));
        }
        return opened;
    }

    /** The lines of `file`: of the opened document when this call opened it, else as the window reads the file. */
    lines(file: string): Promise<string[] | undefined> {
        let read = this.texts.get(file);
        if (read === undefined) {
            const opened = this.documents.get(file);
            read = (opened !== undefined ? opened.then((document) => document.text, () => this.readText(file)) : this.readText(file))
                .then((text) => text?.split(/\r?\n/), () => undefined);
            this.texts.set(file, read);
        }
        return read;
    }

    /** A request the server may refuse because it has not heard of the document yet: repeated with a growing pause. */
    private async asked<T>(method: string, params: unknown): Promise<T> {
        let wait = 40;
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.index.request<T>(method, params, this.deadline);
            } catch (caught) {
                if (!isUnknownDocument(caught) || attempt >= UNKNOWN_DOCUMENT_TRIES || !this.hasTime(wait)) {
                    throw caught;
                }
                await pause(wait, this.clock);
                wait *= 2;
            }
        }
    }

    /** A request at a position of `file`. */
    async at<T>(method: string, place: FilePlace, more: object = {}): Promise<T> {
        const document = await this.document(place.file);
        return this.asked<T>(method, { textDocument: { uri: document.uri }, position: place.position, ...more });
    }

    /** A request about the whole document of `file`. */
    async about<T>(method: string, file: string): Promise<T> {
        const document = await this.document(file);
        return this.asked<T>(method, { textDocument: { uri: document.uri } });
    }

    /** A request that carries an item of a hierarchy, whose document the server may want opened. */
    async withItem<T>(method: string, item: { uri: string }): Promise<T> {
        try {
            return await this.index.request<T>(method, { item }, this.deadline);
        } catch (caught) {
            if (!isUnknownDocument(caught)) {
                throw caught;
            }
            await this.document(fileOfUri(item.uri));
            return this.asked<T>(method, { item });
        }
    }

    /** The index's answers for a name; clangd matches it fuzzily and puts a qualifier to use as a scope. */
    async symbols(query: string): Promise<SymbolInformation[]> {
        return (await this.index.request<SymbolInformation[] | null>('workspace/symbol', { query }, this.deadline)) ?? [];
    }

    /** A location of the server as a place, its path spelled as the roots are. */
    place(location: Location): FilePlace {
        return { file: this.canonical(fileOfUri(location.uri)), position: location.range.start };
    }
}

/** A container without the trailing `::` clangd sometimes writes. */
function scopeOf(container: string | undefined): string | undefined {
    const scope = container?.replace(/::$/, '').trim();
    return scope ? scope : undefined;
}

/** True for a name with a scope in it: `Task::run`, not `run` and not `::run`. */
export function isQualified(name: string): boolean {
    return name.trim().replace(/^::/, '').includes('::');
}

/**
 * Whether the symbol `name` in `scope` is the one `query` names. A plain
 * query names it by its name, a qualified one by the qualified name or by
 * its tail: `Task::run` is `app::Task::run`, and is not `app::MyTask::run`.
 * The name may carry a part of the scope itself, as an outline writes a
 * member that is defined outside its class (`Task::run` in `app`). `fold` is
 * applied to both sides, to compare without regard to case.
 */
export function isNamed(name: string, scope: string | undefined, query: string, fold: (text: string) => string = (text) => text): boolean {
    const wanted = fold(query.trim().replace(/^::/, ''));
    if (!wanted.includes('::')) {
        return fold(name) === wanted || fold(unqualified(name)) === wanted;
    }
    const full = fold(scope ? `${scope}::${name}` : name);
    return full === wanted || full.endsWith(`::${wanted}`);
}

/**
 * Whether a symbol clangd described at a place is the one `query` names. A
 * qualified query is held against the symbol's scope only when clangd named
 * one: a place whose scope is not known counts by its name, as it does for a
 * plain query.
 */
export function isSymbolNamed(symbol: Pick<ResolvedSymbol, 'name' | 'container' | 'scoped'>, query: string): boolean {
    if (unqualified(symbol.name) !== unqualified(query.trim())) {
        return false;
    }
    return !isQualified(query) || symbol.scoped !== true || isNamed(symbol.name, symbol.container, query);
}

/** The index's hits for a name, sorted into the ones that are the name and the rest. */
export interface RankedHits {
    exact: SymbolInformation[];
    /** True when `exact` matched only without regard to case. */
    caseInsensitive: boolean;
    near: SymbolInformation[];
}

/**
 * Which hits are the symbol `query` names: its name, or for a qualified query
 * the qualified name or its tail. Case decides first; when no hit matches
 * with it, the hits that match without it are taken.
 */
export function rankHits(hits: readonly SymbolInformation[], query: string): RankedHits {
    const matches = (hit: SymbolInformation, fold: (text: string) => string): boolean => isNamed(hit.name, scopeOf(hit.containerName), query, fold);
    let exact = hits.filter((hit) => matches(hit, (text) => text));
    let caseInsensitive = false;
    if (exact.length === 0) {
        exact = hits.filter((hit) => matches(hit, (text) => text.toLowerCase()));
        caseInsensitive = exact.length > 0;
    }
    const taken = new Set(exact);
    return { exact, caseInsensitive, near: hits.filter((hit) => !taken.has(hit)) };
}

/** The place of an index hit. */
export function placeOfHit(lookup: Lookup, hit: SymbolInformation): FilePlace {
    return lookup.place(hit.location);
}

/**
 * What clangd says about the symbol at `at`: undefined when nothing stands
 * there. `hit` is the index entry the place came from, when it came from one.
 */
export async function describeAt(lookup: Lookup, at: FilePlace, hit?: SymbolInformation): Promise<ResolvedSymbol | undefined> {
    const [hover, details] = await Promise.all([
        lookup.at<Hover | null>('textDocument/hover', at).then(parseHover),
        lookup.at<SymbolDetails[] | null>('textDocument/symbolInfo', at).then((list) => list ?? [], () => [] as SymbolDetails[]),
    ]);
    if (hover === undefined && details.length === 0 && hit === undefined) {
        return undefined;
    }
    const wanted = hover?.name !== undefined ? unqualified(hover.name) : hit?.name;
    // On a macro argument clangd answers the call and the macro; the hover says which one is meant.
    const detail = details.find((entry) => entry.name === wanted) ?? (wanted === undefined || details.length === 1 ? details[0] : undefined);
    const resolved: ResolvedSymbol = {
        name: wanted ?? detail?.name ?? '?',
        container: scopeOf(detail?.containerName ?? hit?.containerName),
        scoped: detail !== undefined || hit !== undefined,
        kind: hover?.kind ?? (hit !== undefined ? kindName(hit.kind) : undefined),
        at,
        hover,
    };
    if (detail?.definitionRange) {
        resolved.definition = lookup.place(detail.definitionRange);
    }
    if (detail?.declarationRange) {
        resolved.declaration = lookup.place(detail.declarationRange);
    }
    if (resolved.definition === undefined && resolved.declaration === undefined) {
        // A macro has no ranges in symbolInfo; go-to-definition answers its #define.
        const found = locationsOf(await lookup.at<unknown>('textDocument/definition', at).catch(() => undefined));
        if (found.length > 0) {
            resolved.definition = lookup.place(found[0]);
        } else if (hit !== undefined) {
            resolved.definition = placeOfHit(lookup, hit);
        }
    }
    return resolved;
}

/** The innermost symbol of an outline whose lines include `line`. */
export function enclosingSymbol(symbols: readonly DocumentSymbol[], line: number): DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (line >= symbol.range.start.line && line <= lastLineOf(symbol.range)) {
            return enclosingSymbol(symbol.children ?? [], line) ?? symbol;
        }
    }
    return undefined;
}

/** The symbol of an outline whose name stands at `position`, at any depth. */
export function symbolAtName(symbols: readonly DocumentSymbol[], position: Position): DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (contains(symbol.selectionRange, position)
            || (symbol.selectionRange.start.line === position.line && symbol.selectionRange.start.character === position.character)) {
            return symbol;
        }
        const inner = symbolAtName(symbol.children ?? [], position);
        if (inner !== undefined) {
            return inner;
        }
    }
    return undefined;
}

/**
 * The first symbol of an outline that `query` names, at any depth. `scope` is
 * the chain of the entries around `symbols`: a qualified query is held
 * against it, so `B::run` is not the `run` of `A` that stands before it.
 */
function symbolNamed(symbols: readonly DocumentSymbol[], query: string, scope?: string): DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (isNamed(symbol.name, scope, query)) {
            return symbol;
        }
        const inner = symbolNamed(symbol.children ?? [], query, scope ? `${scope}::${symbol.name}` : symbol.name);
        if (inner !== undefined) {
            return inner;
        }
    }
    return undefined;
}

/** The outline of `file`; empty when the server has none. */
export async function outlineOf(lookup: Lookup, file: string): Promise<DocumentSymbol[]> {
    const answer = await lookup.about<Array<DocumentSymbol | SymbolInformation> | null>('textDocument/documentSymbol', file);
    // A flat answer (no ranges of their own) is what a client without the hierarchical capability gets.
    return (answer ?? []).filter((entry): entry is DocumentSymbol => (entry as DocumentSymbol).selectionRange !== undefined);
}

/**
 * The place a use site names. `line` is zero-based. With a name: where it
 * stands on that line, or on the nearest line within five; without one: the
 * name of the function or type the line lies in. `shown` is the path as the
 * caller gave it, for the refusals.
 */
export async function placeOfUseSite(lookup: Lookup, file: string, line: number, name: string | undefined, shown: string): Promise<FilePlace> {
    if (name !== undefined) {
        const lines = (await lookup.document(file)).text.split(/\r?\n/);
        if (line >= lines.length) {
            throw new ToolError('INVALID_ARGUMENT', `${shown} has ${lines.length} lines; line ${line + 1} is past its end.`);
        }
        const found = findNear(lines, line, name, NEAR_LINES);
        if (found === undefined) {
            throw new ToolError('INVALID_ARGUMENT', `'${unqualified(name)}' does not stand on line ${line + 1} of ${shown}, nor within ${NEAR_LINES} lines of it.`,
                'Pass the line of a use of the name, or the name alone.');
        }
        return { file, position: found };
    }
    const enclosing = enclosingSymbol(await outlineOf(lookup, file), line);
    if (enclosing === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `Line ${line + 1} of ${shown} lies in no function or type.`,
            'Pass name with the line to ask about a symbol used there, or fileFullPath alone for the outline of the file.');
    }
    return { file, position: enclosing.selectionRange.start };
}

/**
 * The place of `name` in `file`: a symbol of its outline, else the first
 * place the name stands. For a qualified name the outline is matched with
 * its scopes, and a place in the text counts only when clangd says the symbol
 * there is the one of that scope: the first `run` of a file need not be the
 * `run` of `B`.
 */
export async function placeInFile(lookup: Lookup, file: string, name: string, shown: string): Promise<FilePlace> {
    const word = unqualified(name);
    const qualified = isQualified(name);
    const symbol = symbolNamed(await outlineOf(lookup, file), qualified ? name : word);
    if (symbol !== undefined) {
        return { file, position: symbol.selectionRange.start };
    }
    const lines = (await lookup.document(file)).text.split(/\r?\n/);
    let tried = 0;
    for (let line = 0; line < lines.length; line++) {
        const columns = occurrences(lines[line], word);
        if (!qualified) {
            if (columns.length > 0 && !isComment(lines[line], columns[0])) {
                return { file, position: { line, character: columns[0] } };
            }
            continue;
        }
        for (const character of columns.filter((column) => !isComment(lines[line], column))) {
            if (tried >= QUALIFIED_TRIES || !lookup.hasTime(TIME_LEFT_MS)) {
                break;
            }
            tried++;
            const place = { file, position: { line, character } };
            const found = await describeAt(lookup, place).catch(() => undefined);
            if (found !== undefined && isSymbolNamed(found, name)) {
                return place;
            }
        }
    }
    if (tried > 0) {
        throw new ToolError('INVALID_ARGUMENT', `'${name}' does not stand in ${shown}: where '${word}' stands there, it is the name of another scope.`,
            `Pass ${word} alone with fileFullPath for the first one in the file, or the qualified name alone to look it up in the index.`);
    }
    throw new ToolError('INVALID_ARGUMENT', `'${word}' does not stand in ${shown}.`, 'Pass the name alone to look it up in the index.');
}

/** A rough test for a column that lies in a comment or a string: enough to skip most false use sites. */
function isComment(line: string, column: number): boolean {
    const before = line.slice(0, column);
    if (before.includes('//') || /^\s*(\*|\/\*)/.test(line)) {
        return true;
    }
    return (before.match(/"/g) ?? []).length % 2 === 1;
}

/** How far the search for a use site goes. */
export interface UseSiteLimits {
    /** Files read at most. */
    files: number;
    /** Characters read at most, over all files. */
    characters: number;
    /** Places returned at most. */
    places: number;
    /** Places returned of one file at most. */
    perFile: number;
}

/** The limits the tools search a plain name with: the first place of a file is the name. */
export const USE_SITE_LIMITS: Readonly<UseSiteLimits> = Object.freeze({ files: 600, characters: 48 * 1024 * 1024, places: 4, perFile: 1 });
/**
 * The limits for a qualified name: more places, and several of one file,
 * because the first place the last part of the name stands may be the symbol
 * of another scope.
 */
export const QUALIFIED_USE_SITE_LIMITS: Readonly<UseSiteLimits> = Object.freeze({ ...USE_SITE_LIMITS, places: 8, perFile: 4 });

/**
 * Places in `units` where `name` stands as an identifier outside comments
 * and strings, in the order of `units`: one per file for a plain name,
 * several for a qualified one (`QUALIFIED_USE_SITE_LIMITS`). The search ends
 * at the limits and when the call's time is nearly up, between two files and
 * inside one: a single translation unit can be larger than the character
 * limit.
 */
export async function searchUseSites(lookup: Lookup, units: readonly string[], name: string,
    limits: UseSiteLimits = isQualified(name) ? QUALIFIED_USE_SITE_LIMITS : USE_SITE_LIMITS): Promise<FilePlace[]> {
    const word = unqualified(name);
    const found: FilePlace[] = [];
    let characters = 0;
    let files = 0;
    for (const unit of units) {
        if (found.length >= limits.places || files >= limits.files || characters >= limits.characters || !lookup.hasTime(TIME_LEFT_MS)) {
            break;
        }
        const lines = await lookup.lines(unit);
        files++;
        if (lines === undefined) {
            continue;
        }
        let inFile = 0;
        for (let line = 0; line < lines.length && inFile < limits.perFile && found.length < limits.places; line++) {
            if (characters >= limits.characters || (line > 0 && line % LINES_PER_TIME_CHECK === 0 && !lookup.hasTime(TIME_LEFT_MS))) {
                break;
            }
            characters += lines[line].length + 1;
            if (!lines[line].includes(word)) {
                continue;
            }
            for (const column of occurrences(lines[line], word).filter((candidate) => !isComment(lines[line], candidate))) {
                found.push({ file: unit, position: { line, character: column } });
                inFile++;
                // A plain name is asked about once per line; a qualified one at each place, since two scopes can stand on one line.
                if (limits.perFile === 1 || inFile >= limits.perFile || found.length >= limits.places) {
                    break;
                }
            }
        }
    }
    return found;
}
