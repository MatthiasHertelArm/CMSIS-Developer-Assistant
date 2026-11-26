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
 * The part of the Language Server Protocol the source-browsing tools speak
 * with clangd, and the one seam they speak it through (`SourceIndex`). The
 * shapes are declared here from the LSP specification (3.17) and clangd's
 * protocol extensions (`textDocument/symbolInfo`); no language-client package
 * is a dependency. On the wire a line and a character are zero-based; what an
 * agent reads and passes is one-based, and only `symbolId.ts` converts.
 *
 * Pure: no `vscode`, no file access.
 */

/** A place in a document, zero-based; `character` counts UTF-16 code units. */
export interface Position {
    line: number;
    character: number;
}

/** From `start` up to, not including, `end`. */
export interface Range {
    start: Position;
    end: Position;
}

/** A range in the document a `file:` URI names. */
export interface Location {
    uri: string;
    range: Range;
}

/** What `textDocument/definition` may answer instead of a `Location`. */
export interface LocationLink {
    targetUri: string;
    targetRange: Range;
    targetSelectionRange: Range;
}

/** One hit of `workspace/symbol`. clangd names the definition when it knows one, else the declaration. */
export interface SymbolInformation {
    name: string;
    kind: number;
    location: Location;
    containerName?: string;
}

/** One node of `textDocument/documentSymbol`: `range` is the whole symbol, `selectionRange` its name. */
export interface DocumentSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: Range;
    selectionRange: Range;
    children?: DocumentSymbol[];
}

/** Text with its format, `markdown` or `plaintext`. */
export interface MarkupContent {
    kind: string;
    value: string;
}

/** A code block of the older hover format. */
export interface MarkedCode {
    language: string;
    value: string;
}

/** What `textDocument/hover` answers; null when there is nothing at the position. */
export interface Hover {
    contents: MarkupContent | string | MarkedCode | Array<string | MarkedCode>;
    range?: Range;
}

/** One entry of clangd's `textDocument/symbolInfo`: the symbol at a position, with where it is declared and defined. */
export interface SymbolDetails {
    name: string;
    containerName?: string;
    usr?: string;
    id?: string;
    declarationRange?: Location;
    definitionRange?: Location;
}

/** An item of the call or the type hierarchy; `data` goes back to the server unchanged. */
export interface HierarchyItem {
    name: string;
    kind: number;
    detail?: string;
    uri: string;
    range: Range;
    selectionRange: Range;
    data?: unknown;
}

/** A caller, with the ranges of its calls inside `from`. */
export interface IncomingCall {
    from: HierarchyItem;
    fromRanges: Range[];
}

/** A callee, with the ranges of the calls to it inside the item that was asked about. */
export interface OutgoingCall {
    to: HierarchyItem;
    fromRanges: Range[];
}

/** A document the server has been told about: the URI it knows it by, and its text as the server sees it. */
export interface OpenedDocument {
    uri: string;
    languageId: string;
    text: string;
}

/** What the server said about itself when it started. */
export interface ServerInfo {
    name?: string;
    version?: string;
    /** `callHierarchyProvider` of its capabilities. */
    callHierarchy: boolean;
    /** `typeHierarchyProvider` of its capabilities. */
    typeHierarchy: boolean;
}

/**
 * A running language server with the index of one compile database. The
 * editor's clangd behind the clangd extension's client is one; a scripted
 * peer in the tests is another.
 */
export interface SourceIndex {
    /** One request, answered or rejected by `deadline` (milliseconds of the epoch). A refusal of the server rejects with an `LspError`. */
    request<T>(method: string, params: unknown, deadline: number): Promise<T>;
    /**
     * Tells the server about the document of `file`, which a request at a
     * position needs. Rejects for a file that is no C or C++ document.
     */
    open(file: string): Promise<OpenedDocument>;
    readonly server: ServerInfo;
    /** The same object as long as the server is the same process: what was opened for one is not known to the next. */
    readonly generation: object;
}

/** A refusal of the language server, with its JSON-RPC code. */
export class LspError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}

/** JSON-RPC "invalid params": clangd answers it for a document it was never told about. */
export const INVALID_PARAMS = -32602;

/** True for clangd's refusal of a request on a document that is not open on the server. */
export function isUnknownDocument(caught: unknown): boolean {
    const code = (caught as { code?: unknown } | null | undefined)?.code;
    const message = caught instanceof Error ? caught.message : '';
    return code === INVALID_PARAMS && /non-added document/i.test(message);
}

/** The kinds of `SymbolKind` clangd uses, by their number. */
const KIND_NAMES: Readonly<Record<number, string>> = {
    1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property', 8: 'field',
    9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 15: 'string',
    16: 'number', 17: 'boolean', 18: 'array', 19: 'object', 20: 'key', 21: 'null', 22: 'enumerator', 23: 'struct',
    24: 'event', 25: 'operator', 26: 'type parameter',
};

/** A `SymbolKind` number as a word; `symbol` for one the table does not know. */
export function kindName(kind: number): string {
    return KIND_NAMES[kind] ?? 'symbol';
}

/** The `SymbolKind` numbers of what can be called. */
export const CALLABLE_KINDS: ReadonlySet<number> = new Set([6, 9, 12, 25]);
/** The `SymbolKind` numbers of what can have base and derived types. */
export const RECORD_KINDS: ReadonlySet<number> = new Set([5, 11, 23]);

/** The locations of a `definition`, `declaration` or `implementation` answer, whatever form it came in. */
export function locationsOf(answer: unknown): Location[] {
    const list = Array.isArray(answer) ? answer : answer === null || answer === undefined ? [] : [answer];
    const found: Location[] = [];
    for (const entry of list as Array<Partial<Location> & Partial<LocationLink>>) {
        if (typeof entry?.uri === 'string' && entry.range !== undefined) {
            found.push({ uri: entry.uri, range: entry.range });
        } else if (typeof entry?.targetUri === 'string' && entry.targetSelectionRange !== undefined) {
            found.push({ uri: entry.targetUri, range: entry.targetSelectionRange });
        }
    }
    return found;
}

/**
 * The last line (zero-based) a range covers. The end of a range is excluded,
 * so a range that ends at column 0 of a later line does not include that line.
 */
export function lastLineOf(range: Range): number {
    return range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
}

/** True when `position` lies inside `range`, its end excluded. */
export function contains(range: Range, position: Position): boolean {
    const after = position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character);
    const before = position.line < range.end.line || (position.line === range.end.line && position.character < range.end.character);
    return after && before;
}
