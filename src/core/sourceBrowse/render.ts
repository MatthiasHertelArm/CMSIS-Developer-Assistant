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
 * The texts of the source-browsing tools.
 *
 * Every reply opens with what the index covers and where its paths start,
 * so that an agent can open any file it names. A symbol is shown as a card:
 * what it is, where it is declared and defined, its id, and what
 * `source_get` returns for it. A list entry is `file:line` with the source
 * line, so the agent sees the use without opening the file; where the entry
 * is itself a symbol it is written as an id that can be passed back. Lists
 * end at their limit and texts at their budget, and both say what they left
 * out.
 *
 * Pure: no `vscode`, no file access; the caller hands in the lines it read.
 */

import { clipValue } from '../textBudget';
import type { IndexCoverage } from './context';
import { isCallable, isOverridable, isRecord } from './hoverText';
import { DocumentSymbol, Range, SymbolInformation, kindName, lastLineOf } from './protocol';
import type { Hierarchy, HierarchyNode, References } from './relations';
import { PACK_ROOT_VARIABLE, PathRoots, displayPath, formatSymbolId } from './symbolId';
import type { FilePlace, ResolvedSymbol } from './symbolQuery';

/** Characters of a source line shown at most. */
const LINE_CHARS = 160;
/** Lines of a hover's declaration and of its details shown on a card. */
const CODE_LINES = 6;
const DETAIL_LINES = 8;
/** The text budget of a reply when the call names none. */
export const DEFAULT_MAX_CHARS = 8_000;

/** The lines of the files a reply quotes: zero-based line to text. */
export type LineReader = (file: string, line: number) => string | undefined;

/** What the first lines of a reply say about the index. */
export interface IndexState {
    /** The context the compile database belongs to, `Blinky.Debug+MPS3`, when it has a name. */
    context?: string;
    /** The folder of the compile database. */
    folder: string;
    coverage?: IndexCoverage;
    /** The server's version line. */
    server?: string;
    /** Set when the index is not the active target's: the folders that hold its images. */
    otherThanActive?: string[];
}

/** How often each relation of a symbol occurs, as far as it was counted. */
export interface RelationCounts {
    references?: { count: number; files: number };
    callers?: number;
    callees?: number;
    supertypes?: number;
    subtypes?: number;
}

/** `n thing` or `n things`. */
function counted(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** `clangd 21.0.0` of a version line such as `Apple clangd version 21.0.0 (clang-2100.4.1.1) …`. */
function serverText(version: string | undefined): string | undefined {
    const match = /clangd version ([^\s(]+)/i.exec(version ?? '');
    return match ? `clangd ${match[1]}` : undefined;
}

/** `path:line`, the line counted from 1. */
function placeText(place: FilePlace, roots: PathRoots): string {
    return `${displayPath(place.file, roots)}:${place.position.line + 1}`;
}

/** A source line for a list: trimmed and clipped. */
function quoted(text: string | undefined): string {
    return text === undefined ? '' : clipValue(text.trim(), LINE_CHARS);
}

/** The opening lines of every reply: what the index covers, how far it is, and where the paths start. */
export function renderIndexState(state: IndexState, roots: PathRoots): string {
    const name = state.context ?? displayPath(state.folder, roots);
    const facts: string[] = [];
    const coverage = state.coverage;
    if (coverage === undefined) {
        facts.push('clangd has written no index yet, so answers by name can be incomplete');
    } else if (coverage.total > 0) {
        facts.push(coverage.indexed >= coverage.total
            ? `${counted(coverage.total, 'translation unit')} indexed`
            : `${coverage.indexed} of ${counted(coverage.total, 'translation unit')} indexed, so answers can be incomplete`);
    }
    const server = serverText(state.server);
    if (server !== undefined) {
        facts.push(server);
    }
    const lines = [`Source index: ${name}${facts.length > 0 ? ` (${facts.join('; ')})` : ''}.`];
    if (state.otherThanActive !== undefined && state.otherThanActive.length > 0) {
        lines.push(`Note: this is the project CMSIS Solution set up for clangd, not the active target's (${state.otherThanActive.map((folder) => displayPath(folder, roots)).join(', ')}); `
            + 'the user chooses it in the CMSIS view (Activate Clangd Information).');
    }
    const starts: string[] = [];
    if (roots.solution !== undefined) {
        starts.push(`relative paths start at ${roots.solution}`);
    }
    if (roots.packRoot !== undefined) {
        starts.push(`${PACK_ROOT_VARIABLE} is ${roots.packRoot}`);
    }
    if (starts.length > 0) {
        lines.push(`Paths: ${starts.join('; ')}.`);
    }
    return lines.join('\n');
}

/** The place an id of the symbol names: its definition when it has one. */
export function idPlace(symbol: ResolvedSymbol): FilePlace {
    return symbol.definition ?? symbol.declaration ?? symbol.at;
}

/** The id of a symbol. */
export function idOf(symbol: ResolvedSymbol, roots: PathRoots): string {
    const place = idPlace(symbol);
    return formatSymbolId({ name: symbol.name, file: place.file, line: place.position.line + 1, column: place.position.character + 1 }, roots);
}

/** What `source_get` returns for a symbol of this kind, with the counts that were taken. */
function relationsText(symbol: ResolvedSymbol, counts: RelationCounts): string {
    const kind = symbol.kind;
    const offered: string[] = [];
    if (symbol.definition !== undefined || symbol.declaration !== undefined) {
        offered.push('definition');
    }
    offered.push(counts.references !== undefined
        ? `references (${counts.references.count} in ${counted(counts.references.files, 'file')})`
        : 'references');
    const withCount = (name: string, count: number | undefined): string => (count === undefined ? name : `${name} (${count})`);
    if (isCallable(kind) || counts.callers !== undefined || counts.callees !== undefined) {
        offered.push(withCount('callers', counts.callers), withCount('callees', counts.callees));
    }
    if (isRecord(kind) || counts.supertypes !== undefined || counts.subtypes !== undefined) {
        offered.push(withCount('supertypes', counts.supertypes), withCount('subtypes', counts.subtypes));
    }
    if (isRecord(kind) || isOverridable(kind)) {
        offered.push('implementations');
    }
    return offered.join(', ');
}

/** The card of one symbol. */
export function renderCard(symbol: ResolvedSymbol, roots: PathRoots, counts: RelationCounts = {}): string {
    const lines: string[] = [`${symbol.name}: ${symbol.kind ?? 'symbol'}${symbol.container ? ` in ${symbol.container}` : ''}`];
    const code = symbol.hover?.code?.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0) ?? [];
    for (const line of code.slice(0, CODE_LINES)) {
        lines.push(`  ${clipValue(line, 200)}`);
    }
    if (code.length > CODE_LINES) {
        lines.push(`  … (+${code.length - CODE_LINES} lines: source_get {what:'definition'})`);
    }
    for (const line of (symbol.hover?.details ?? []).slice(0, DETAIL_LINES)) {
        lines.push(`  ${clipValue(line, 200)}`);
    }
    if (symbol.definition !== undefined) {
        lines.push(`  defined    ${placeText(symbol.definition, roots)}`);
    }
    const declared = symbol.declaration;
    if (declared !== undefined && (symbol.definition === undefined || declared.file !== symbol.definition.file || declared.position.line !== symbol.definition.position.line)) {
        lines.push(`  declared   ${placeText(declared, roots)}`);
    }
    if (symbol.foundBy !== undefined) {
        lines.push(`  found      ${symbol.foundBy}`);
    }
    lines.push(`  id         ${idOf(symbol, roots)}`);
    lines.push(`  available  ${relationsText(symbol, counts)}`);
    return lines.join('\n');
}

/** Several symbols of one name: their ids, for a second call. */
export function renderCandidates(name: string, hits: ReadonlyArray<{ hit: SymbolInformation; place: FilePlace }>, roots: PathRoots, limit: number, caseInsensitive: boolean): string {
    const lines = [`${hits.length} symbols are named '${name}'${caseInsensitive ? ' when case is ignored' : ''}. Pass the id of one to source_get, or the name with fileFullPath to source_find:`];
    for (const { hit, place } of hits.slice(0, limit)) {
        const id = formatSymbolId({ name: hit.name, file: place.file, line: place.position.line + 1, column: place.position.character + 1 }, roots);
        const scope = hit.containerName?.replace(/::$/, '');
        lines.push(`  ${id}  (${kindName(hit.kind)}${scope ? ` in ${scope}` : ''})`);
    }
    if (hits.length > limit) {
        lines.push(`  … and ${hits.length - limit} more (raise limit)`);
    }
    return lines.join('\n');
}

/** A name the index does not have, with what is near it and how else to ask. */
export function renderNotFound(name: string, near: readonly SymbolInformation[], state: IndexState, roots: PathRoots): string {
    const lines = [`No symbol named '${name}' in the index of ${state.context ?? displayPath(state.folder, roots)}, and no use of it in its translation units.`];
    const names = [...new Set(near.map((hit) => hit.name))].slice(0, 8);
    if (names.length > 0) {
        lines.push(`Nearest names: ${names.join(', ')}.`);
    }
    lines.push('A macro or a local variable used only in a header is found from a place that uses it: pass fileFullPath and line. '
        + 'A symbol of an assembler file is not indexed: lookup_symbol reads it from the image.');
    return lines.join('\n');
}

/** `35` or `35-60`, lines counted from 1. */
function linesText(range: Range): string {
    const first = range.start.line + 1;
    const last = lastLineOf(range) + 1;
    return last > first ? `${first}-${last}` : `${first}`;
}

/** The outline of a file: every symbol with its lines, children indented, at most `limit` entries. */
export function renderOutline(shown: string, symbols: readonly DocumentSymbol[], limit: number): string {
    const lines: string[] = [];
    let total = 0;
    const walk = (list: readonly DocumentSymbol[], depth: number): void => {
        for (const symbol of list) {
            total++;
            if (lines.length < limit) {
                lines.push(`  ${'  '.repeat(depth)}${linesText(symbol.range).padEnd(9)} ${symbol.name}: ${kindName(symbol.kind)}${symbol.detail ? ` ${clipValue(symbol.detail, 80)}` : ''}`);
            }
            walk(symbol.children ?? [], depth + 1);
        }
    };
    walk(symbols, 0);
    if (total === 0) {
        return `${shown} has no symbols clangd lists.`;
    }
    const head = `Outline of ${shown} (${counted(total, 'symbol')}; lines, name, kind). Ask about one with source_find {fileFullPath, line} or {name, fileFullPath}:`;
    return [head, ...lines, ...(total > limit ? [`  … and ${total - limit} more (raise limit)`] : [])].join('\n');
}

/** The source of a definition with its line numbers. */
export function renderDefinition(symbol: ResolvedSymbol, place: FilePlace, extent: Range | undefined, lines: readonly string[] | undefined, roots: PathRoots, what: string): string {
    const shown = displayPath(place.file, roots);
    if (lines === undefined) {
        return `${symbol.name}: ${what} at ${shown}:${place.position.line + 1}; the file could not be read.`;
    }
    let first = extent?.start.line ?? place.position.line;
    let last = extent !== undefined ? (extent.end.character === 0 && extent.end.line > extent.start.line ? extent.end.line - 1 : extent.end.line) : place.position.line;
    if (extent === undefined) {
        // A macro: its #define and the lines a backslash continues it onto.
        while (last < lines.length - 1 && /\\\s*$/.test(lines[last])) {
            last++;
        }
    }
    first = Math.max(0, first);
    last = Math.min(lines.length - 1, Math.max(first, last));
    const count = last - first + 1;
    const width = String(last + 1).length;
    const body = lines.slice(first, last + 1).map((line, offset) => `  ${String(first + offset + 1).padStart(width)}  ${line.trimEnd()}`);
    return [`${symbol.name}: ${what} at ${shown}:${first + 1}${count > 1 ? `-${last + 1} (${count} lines)` : ''}`, ...body].join('\n');
}

/** Solution files before pack files before the rest, each group by path. */
function fileOrder(a: string, b: string): number {
    const rank = (shown: string): number => (shown.startsWith(PACK_ROOT_VARIABLE) ? 1 : shown.startsWith('/') || /^[A-Za-z]:[\\/]/.test(shown) ? 2 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
}

/** Places grouped by file, each with its source line; at most `limit` places. */
function groupedPlaces(places: readonly FilePlace[], roots: PathRoots, read: LineReader, limit: number, mark: (place: FilePlace) => string | undefined): string[] {
    const byFile = new Map<string, FilePlace[]>();
    for (const place of places) {
        const list = byFile.get(place.file) ?? [];
        list.push(place);
        byFile.set(place.file, list);
    }
    const files = [...byFile.keys()].map((file) => ({ file, shown: displayPath(file, roots) })).sort((a, b) => fileOrder(a.shown, b.shown));
    const lines: string[] = [];
    let shownPlaces = 0;
    for (const { file, shown } of files) {
        if (shownPlaces >= limit) {
            break;
        }
        lines.push(shown);
        const seen = new Set<number>();
        for (const place of (byFile.get(file) ?? []).sort((a, b) => a.position.line - b.position.line)) {
            if (shownPlaces >= limit) {
                break;
            }
            shownPlaces++;
            if (seen.has(place.position.line)) {
                continue;
            }
            seen.add(place.position.line);
            const note = mark(place);
            lines.push(`  ${String(place.position.line + 1).padStart(6)}  ${quoted(read(file, place.position.line))}${note ? `   (${note})` : ''}`);
        }
    }
    if (places.length > shownPlaces) {
        lines.push(`… and ${places.length - shownPlaces} more (raise limit)`);
    }
    return lines;
}

/** True when two places are the same line of the same file. */
function sameLine(a: FilePlace | undefined, b: FilePlace): boolean {
    return a !== undefined && a.file === b.file && a.position.line === b.position.line;
}

/** Every reference to a symbol, by file. */
export function renderReferences(symbol: ResolvedSymbol, references: References, roots: PathRoots, read: LineReader, limit: number): string {
    if (references.places.length === 0) {
        return `No reference to ${symbol.name} in the index.`;
    }
    const head = `${counted(references.places.length, 'reference')} to ${symbol.name} in ${counted(references.files, 'file')}:`;
    const mark = (place: FilePlace): string | undefined =>
        (sameLine(symbol.definition, place) ? 'definition' : sameLine(symbol.declaration, place) ? 'declaration' : undefined);
    return [head, ...groupedPlaces(references.places, roots, read, limit, mark)].join('\n');
}

/** Where a virtual function or a type is implemented. */
export function renderImplementations(symbol: ResolvedSymbol, places: readonly FilePlace[], roots: PathRoots, read: LineReader, limit: number): string {
    if (places.length === 0) {
        return `clangd knows no implementation of ${symbol.name}: it is no virtual function and no type with derived types, or none is in the index.`;
    }
    return [`${counted(places.length, 'implementation')} of ${symbol.name}:`, ...groupedPlaces(places, roots, read, limit, () => undefined)].join('\n');
}

/** Why a node's children are not listed, as words. */
const CUT_TEXT: Readonly<Record<string, string>> = {
    seen: 'listed above',
    limit: 'not expanded: the limit of entries is reached',
    deadline: 'not expanded: the call ran out of time',
    failed: 'not expanded: clangd refused the request',
};

/** One node of a hierarchy and what is below it. */
function nodeLines(node: HierarchyNode, direction: string, roots: PathRoots, read: LineReader, depth: number): string[] {
    const indent = '  '.repeat(depth + 1);
    const id = formatSymbolId({ name: node.name, file: node.place.file, line: node.place.position.line + 1, column: node.place.position.character + 1 }, roots);
    const lines = [`${indent}${id}  (${kindName(node.kind)}${node.cut ? `; ${direction} ${CUT_TEXT[node.cut]}` : ''})`];
    const seen = new Set<string>();
    for (const site of node.sites) {
        const key = `${site.file}:${site.position.line}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        // A caller's calls are in its own file; a callee is called from the file of the function above it.
        const where = site.file === node.place.file ? '' : `${displayPath(site.file, roots)}:`;
        lines.push(`${indent}  ${`${where}${site.position.line + 1}`.padStart(6)}  ${quoted(read(site.file, site.position.line))}`);
    }
    for (const child of node.children) {
        lines.push(...nodeLines(child, direction, roots, read, depth + 1));
    }
    return lines;
}

/** The callers, callees, supertypes or subtypes of a symbol, as a tree of ids. */
export function renderHierarchy(symbol: ResolvedSymbol, direction: string, hierarchy: Hierarchy, roots: PathRoots, read: LineReader, depth: number): string {
    const calls = direction === 'callers' || direction === 'callees';
    if (!hierarchy.applies) {
        return `${symbol.name} has no ${direction}: clangd knows no ${calls ? 'function' : 'class or struct'} at ${placeText(symbol.at, roots)}.`;
    }
    if (hierarchy.nodes.length === 0) {
        return `${symbol.name} has no ${direction} in the index.${direction === 'callers' ? ' A call from an assembler file, or through a function pointer, is not one.' : ''}`;
    }
    const lines = [`${hierarchy.count} ${direction} of ${symbol.name}${depth > 1 ? `, ${depth} levels deep` : ''} (each an id${calls ? ', with the lines of the calls' : ''}):`];
    for (const node of hierarchy.nodes) {
        lines.push(...nodeLines(node, direction, roots, read, 0));
    }
    if (hierarchy.limited) {
        lines.push('… the limit of entries ended the list (raise limit)');
    }
    if (hierarchy.timedOut) {
        lines.push('… the call ran out of time before every level was read (ask about a deeper function directly)');
    }
    return lines.join('\n');
}

/** `text` within `maxChars`: whole lines, and a last line that says how many were left out. */
export function fitBudget(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    const lines = text.split('\n');
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
        if (used + line.length + 1 > maxChars - 80) {
            break;
        }
        kept.push(line);
        used += line.length + 1;
    }
    kept.push(`… (+${lines.length - kept.length} lines not shown: raise maxChars, or lower limit or depth)`);
    return kept.join('\n');
}
