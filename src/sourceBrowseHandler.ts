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
 * The two source-browsing tools (experimental): `source_find` says what a
 * symbol is and what can be asked about it, `source_get` returns one of
 * those things. Both answer from the editor's clangd, through the clangd
 * extension's language client: the index CMSIS Solution set up for the
 * active context, and no second clangd.
 *
 * One call: read which compile database clangd runs with, take the running
 * client (a restart of clangd makes a new one, so it is asked for every
 * time), open a translation unit when this client has none yet (clangd loads
 * the compile database and its index with the first document), open the
 * units that changed on disk since they were indexed, then ask. Nothing is
 * written and nothing is repaired: a missing extension, language server or
 * compile database is a refusal that says what is missing.
 *
 * No `vscode` import: the window arrives as a `SourceBrowseHost`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { noWorkspaceRefusal } from './core/bootstrapState';
import type { PackDocsLog } from './core/packDocs/host';
import { settleWithin } from './core/solutionApi';
import { LanguageClientLike, acquireClangdClient, isRunning } from './core/sourceBrowse/clangdApi';
import { CompileDatabase, compileCommandsDirOf, contextNameOf, indexCoverage, readCompileDatabase, substituteVariables } from './core/sourceBrowse/context';
import type { SourceBrowseHost } from './core/sourceBrowse/host';
import { isCallable, isRecord } from './core/sourceBrowse/hoverText';
import { LspError, OpenedDocument, ServerInfo, SourceIndex } from './core/sourceBrowse/protocol';
import {
    CallDirection, TypeDirection, callHierarchy, definitionExtent, implementationsOf, referencesOf, typeHierarchy,
} from './core/sourceBrowse/relations';
import type { HierarchyNode } from './core/sourceBrowse/relations';
import {
    DEFAULT_MAX_CHARS, IndexState, LineReader, RelationCounts, fitBudget, renderCandidates, renderCard, renderDefinition,
    renderHierarchy, renderImplementations, renderIndexState, renderNotFound, renderOutline, renderReferences,
} from './core/sourceBrowse/render';
import { PACK_ROOT_VARIABLE, PathRoots, displayPath, findNear, parseSymbolId, positionOf, resolvePath, unqualified } from './core/sourceBrowse/symbolId';
import {
    Lookup, RankedHits, ResolvedSymbol, describeAt, outlineOf, placeInFile, placeOfHit, placeOfUseSite, rankHits, searchUseSites,
} from './core/sourceBrowse/symbolQuery';
import { ToolError, ToolText } from './core/toolResult';
import { runTool } from './core/toolRun';
import { secondsText } from './core/windowHealth';

export interface SourceBrowseHandlerOptions {
    /** The deadline of a call. */
    timeoutMs: number;
}

export interface SourceFindArgs {
    /** A symbol name, plain or qualified. */
    name?: string;
    /** A source file: with `line` a use site, alone the file to outline. */
    fileFullPath?: string;
    /** A line of that file, counted from 1. */
    line?: number;
    limit?: number;
}

export interface SourceGetArgs {
    /** An id of `source_find`, or a name that is unique. */
    symbol?: string;
    what?: string;
    depth?: number;
    limit?: number;
    maxChars?: number;
}

/** What `source_get` returns. */
export const SOURCE_RELATIONS = ['definition', 'references', 'callers', 'callees', 'supertypes', 'subtypes', 'implementations'] as const;
export type SourceRelation = typeof SOURCE_RELATIONS[number];

const TIMEOUT_NOTE = 'clangd may be starting, indexing or parsing a large file; repeat the call.';
/** The languages the clangd extension serves. */
const C_FAMILY: ReadonlySet<string> = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp']);
/** Source files a translation unit can be primed with. */
const SOURCE_UNIT = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;
/** How long a name is asked again while a new client loads its index from the shards on disk. */
const INDEX_LOAD_MS = 1_000;
/** How long a name is asked again while clangd builds an index it does not have yet. */
const INDEX_BUILD_MS = 8_000;
/** A client is young this long after its first document: its index may still be loading. */
const YOUNG_MS = 5_000;
/** Changed units opened before a call at most. */
const REFRESH_UNITS = 8;
/** Files whose lines one reply quotes at most. */
const QUOTED_FILES = 80;
/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;

/** What one call works with. */
interface Session {
    client: LanguageClientLike;
    lookup: Lookup;
    roots: PathRoots;
    database: CompileDatabase;
    state: IndexState;
    /** The database's source files, the solution's own first. */
    units: string[];
    /** True while the index of this client may still be loading from disk. */
    young: boolean;
    /** True while clangd has not written a shard for every unit: it is still building the index. */
    building: boolean;
    deadline: number;
}

/** A trimmed string argument; undefined when it is empty or no string. */
function textOf(value: unknown): string | undefined {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : undefined;
}

/** A whole number within bounds, or the default. */
function bounded(value: unknown, fallback: number, least: number, most: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), least), most) : fallback;
}

/** A caught value's message. */
function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/**
 * A path with its symbolic links resolved; the path itself when it does not exist.
 * Not `realpathSync.native`: on Windows that also turns a short name (`RUNNER~1`)
 * into the long one, so a file clangd names in the spelling of the compile database
 * would no longer lie inside the folder, and a URI built from it would name a
 * document clangd does not know.
 */
function canonical(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

/** The language client of the clangd extension as a `SourceIndex`. */
class ClientIndex implements SourceIndex {
    constructor(private readonly client: LanguageClientLike, private readonly host: SourceBrowseHost) { }

    get generation(): object {
        return this.client;
    }

    get server(): ServerInfo {
        const result = this.client.initializeResult;
        return {
            name: result?.serverInfo?.name,
            version: result?.serverInfo?.version,
            callHierarchy: Boolean(result?.capabilities?.callHierarchyProvider),
            typeHierarchy: Boolean(result?.capabilities?.typeHierarchyProvider),
        };
    }

    async request<T>(method: string, params: unknown, deadline: number): Promise<T> {
        const remaining = deadline - this.host.clock.now();
        if (remaining <= 0) {
            throw new ToolError('TIMEOUT', `clangd was not asked (${method}): the call's time is up.`, TIMEOUT_NOTE);
        }
        const cancellation = this.host.cancellation?.();
        try {
            const answered = await settleWithin(this.client.sendRequest(method, params, cancellation?.token), remaining, this.host.clock);
            if (answered === undefined) {
                cancellation?.cancel();
                throw new ToolError('TIMEOUT', `clangd did not answer ${method} within ${secondsText(remaining)}.`, TIMEOUT_NOTE);
            }
            return answered.value as T;
        } catch (caught) {
            const code = (caught as { code?: unknown } | null | undefined)?.code;
            if (!(caught instanceof ToolError) && typeof code === 'number') {
                throw new LspError(code, messageOf(caught));
            }
            throw caught;
        } finally {
            cancellation?.dispose();
        }
    }

    async open(file: string): Promise<OpenedDocument> {
        const document = await this.host.openDocument(file);
        if (!C_FAMILY.has(document.languageId)) {
            throw new ToolError('INVALID_ARGUMENT',
                `${file} is no C or C++ document for VS Code (language '${document.languageId}'), so clangd does not serve it.`,
                'A symbol of an assembler file is not in the source index: lookup_symbol reads it from the image.');
        }
        return document;
    }
}

export class SourceBrowseHandler {
    private callCounter = 0;
    private database: { key: string; value: CompileDatabase } | undefined;
    /** Per client: the compile database folders a document was opened for, and when the first one was. */
    private readonly primed = new WeakMap<object, { folders: Set<string>; at: number }>();

    constructor(private readonly host: SourceBrowseHost, private readonly options: SourceBrowseHandlerOptions) { }

    // ------------------------------------------------------------------ tools

    public handleSourceFind(args: SourceFindArgs = {}): Promise<ToolText> {
        return this.run('source_find', args, async (log, deadline) => {
            const name = textOf(args.name);
            const given = textOf(args.fileFullPath);
            const line = typeof args.line === 'number' ? Math.round(args.line) : undefined;
            if (line !== undefined && given === undefined) {
                return 'line needs fileFullPath: the file the line is in.';
            }
            if (name === undefined && given === undefined) {
                return 'Pass name (a symbol, e.g. osThreadNew), or fileFullPath with line (and name) for a symbol used there, or fileFullPath alone for the outline of the file.';
            }
            if (line !== undefined && line < 1) {
                return 'line counts from 1.';
            }
            const limit = bounded(args.limit, 20, 1, 100);
            const session = await this.connect('source_find', deadline, log);
            const { lookup, roots } = session;
            let body: string;
            if (given !== undefined) {
                const file = this.fileArgument(given, roots);
                const shown = displayPath(file, roots);
                if (line === undefined && name === undefined) {
                    body = renderOutline(shown, await outlineOf(lookup, file), limit);
                } else {
                    const place = line !== undefined ? await placeOfUseSite(lookup, file, line - 1, name, shown) : await placeInFile(lookup, file, name ?? '', shown);
                    const symbol = await describeAt(lookup, place);
                    body = symbol === undefined
                        ? `clangd knows nothing at ${shown}:${place.position.line + 1}: the place may lie in a comment, a string, or a region the preprocessor leaves out for this target.`
                        : renderCard(symbol, roots, await this.counts(lookup, symbol));
                }
            } else {
                const found = await this.byName(session, name ?? '', limit);
                body = typeof found === 'string' ? found : renderCard(found, roots, await this.counts(lookup, found));
            }
            return this.reply(session, body, DEFAULT_MAX_CHARS);
        });
    }

    public handleSourceGet(args: SourceGetArgs = {}): Promise<ToolText> {
        return this.run('source_get', args, async (log, deadline) => {
            const given = textOf(args.symbol);
            const what = textOf(args.what);
            if (given === undefined || what === undefined) {
                return `Pass symbol (an id of source_find, or a name that is unique) and what (${SOURCE_RELATIONS.join(', ')}).`;
            }
            if (!(SOURCE_RELATIONS as readonly string[]).includes(what)) {
                return `what '${what}' is none of ${SOURCE_RELATIONS.join(', ')}.`;
            }
            const limit = bounded(args.limit, 30, 1, 200);
            const depth = bounded(args.depth, 1, 1, 3);
            const maxChars = bounded(args.maxChars, DEFAULT_MAX_CHARS, 500, 60_000);
            const session = await this.connect('source_get', deadline, log);
            const symbol = await this.symbolOf(session, given, limit);
            const body = typeof symbol === 'string' ? symbol : await this.relation(session, symbol, what as SourceRelation, depth, limit);
            return this.reply(session, body, maxChars);
        });
    }

    // --------------------------------------------------------------- one call

    /** The reply: the state of the index as it is now, after the call's own requests, then the answer, within the budget. */
    private reply(session: Session, body: string, maxChars: number): string {
        const state: IndexState = { ...session.state, coverage: indexCoverage(session.database) ?? session.state.coverage };
        return fitBudget(`${renderIndexState(state, session.roots)}\n\n${body}`, maxChars);
    }

    /** The absolute, existing file a path argument names. */
    private fileArgument(given: string, roots: PathRoots): string {
        const file = resolvePath(given, roots);
        if (file === undefined || !fs.existsSync(file)) {
            throw new ToolError('INVALID_ARGUMENT', `fileFullPath '${given}' is not a file${file !== undefined && file !== given ? ` (${file})` : ''}.`,
                `Pass an absolute path, a path relative to the solution folder, or ${PACK_ROOT_VARIABLE}/… as the replies write it.`);
        }
        return canonical(file);
    }

    /** The folder clangd reads its compile database from, as far as the window's settings and folders say. */
    private databaseFolder(what: string, folder: string): string {
        const written = compileCommandsDirOf(this.host.clangdSettings().arguments);
        if (written !== undefined) {
            const substituted = substituteVariables(written, (name) => this.host.variable(name));
            return path.resolve(folder, substituted);
        }
        // What clangd finds by itself for a file in the folder: the folder, then its build folder.
        for (const candidate of [folder, path.join(folder, 'build')]) {
            if (fs.existsSync(path.join(candidate, 'compile_commands.json'))) {
                return candidate;
            }
        }
        throw new ToolError('TOOL_DISABLED',
            `${what} not attempted: clangd is not pointed at a compile database (no --compile-commands-dir in the setting clangd.arguments, `
            + 'and no compile_commands.json in the workspace folder).',
            'CMSIS Solution writes the setting for a loaded solution when cmsis-csolution.generateClangSetup is on (the default). '
            + 'If the solution is not converted yet, cmsis_action {action:\'convert\'} shows why; '
            + 'the Arm Environment Manager may be waiting for the user to allow the activation of the tools.');
    }

    /** The compile database of `folder`, read again when its file changed. */
    private databaseOf(what: string, folder: string, roots: PathRoots): CompileDatabase {
        const file = path.join(folder, 'compile_commands.json');
        let key: string | undefined;
        try {
            const stat = fs.statSync(file);
            key = `${file}:${stat.size}:${stat.mtimeMs}`;
        } catch {
            key = undefined;
        }
        if (key !== undefined && this.database?.key === key) {
            return this.database.value;
        }
        const value = key === undefined ? undefined : readCompileDatabase(folder);
        if (key === undefined || value === undefined) {
            throw new ToolError('TOOL_DISABLED',
                `${what} not attempted: the folder clangd is pointed at, ${displayPath(folder, roots)}, has no compile_commands.json.`,
                'cbuild writes it without a build (the setup CMSIS Solution runs for a loaded solution) and with every build: '
                + 'cmsis_action {action:\'convert\'} shows why the setup failed, cmsis_action {action:\'build\'} writes it too. '
                + 'The Arm Environment Manager may be waiting for the user to allow the activation of the tools.');
        }
        this.database = { key, value };
        return value;
    }

    /** Everything a call needs, or the refusal that says what is missing. */
    private async connect(what: string, deadline: number, log: PackDocsLog): Promise<Session> {
        const folders = this.host.workspaceFolders();
        if (folders.length === 0) {
            throw noWorkspaceRefusal(what);
        }
        const solution = canonical(folders[0]);
        const packRoot = await this.host.packRoot().catch(() => undefined);
        const roots: PathRoots = { solution, packRoot: packRoot === undefined ? undefined : canonical(packRoot) };
        const folder = this.databaseFolder(what, folders[0]);
        const database = this.databaseOf(what, folder, roots);
        const settings = this.host.clangdSettings();
        const client = await acquireClangdClient(this.host.clangdExtension(), settings, what, this.host.clock, deadline);
        const index = new ClientIndex(client, this.host);
        const lookup = new Lookup(index, this.host.clock, deadline, (file) => this.host.readText(file), canonical);

        const sources = database.units.filter((unit) => SOURCE_UNIT.test(unit));
        const own = sources.filter((unit) => canonical(unit).startsWith(solution + path.sep));
        const units = [...own, ...sources.filter((unit) => !own.includes(unit))];
        const youngSince = await this.prime(lookup, client, folder, units, log);
        let coverage = indexCoverage(database);
        if (coverage !== undefined && coverage.stale.length > 0) {
            await this.refresh(lookup, coverage.stale, log);
            coverage = indexCoverage(database);
        }
        const state: IndexState = { context: contextNameOf(folder), folder: canonical(folder), coverage, server: index.server.version };
        const images = await this.host.activeImageFolders?.().catch(() => undefined);
        if (images !== undefined && images.length > 0 && !images.some((image) => canonical(image) === state.folder)) {
            state.otherThanActive = images.map(canonical);
        }
        const building = coverage === undefined || coverage.indexed < coverage.total;
        const young = this.host.clock.now() - youngSince < YOUNG_MS;
        return { client, lookup, roots, database, state, units, young, building, deadline };
    }

    /**
     * clangd loads a compile database and its index with the first document
     * it is told about, so a client that has none yet is given one unit.
     * Returns when this client got its first document.
     */
    private async prime(lookup: Lookup, client: LanguageClientLike, folder: string, units: readonly string[], log: PackDocsLog): Promise<number> {
        let state = this.primed.get(client);
        if (state === undefined) {
            state = { folders: new Set(), at: this.host.clock.now() };
            this.primed.set(client, state);
        }
        if (state.folders.has(folder)) {
            return state.at;
        }
        for (const unit of units.filter((candidate) => fs.existsSync(candidate)).slice(0, 3)) {
            try {
                await lookup.document(unit);
                state.folders.add(folder);
                log.debug(`opened ${unit}: clangd loads ${folder} and its index with it`);
                break;
            } catch (caught) {
                log.debug(`${unit} could not be opened for clangd: ${messageOf(caught)}`);
            }
        }
        return state.at;
    }

    /** Units that changed on disk after clangd indexed them are opened, so that it reads them again. */
    private async refresh(lookup: Lookup, stale: readonly string[], log: PackDocsLog): Promise<void> {
        for (const unit of stale.slice(0, REFRESH_UNITS)) {
            if (!lookup.hasTime(3_000)) {
                return;
            }
            try {
                // The outline is answered when the file is parsed, and with that its part of the index is new.
                await outlineOf(lookup, unit);
                log.debug(`${unit} is newer than its index: opened for clangd`);
            } catch (caught) {
                log.debug(`${unit} is newer than its index and could not be opened: ${messageOf(caught)}`);
            }
        }
    }

    /**
     * The index's hits for a name, asked again with a growing pause for at
     * most `forMs` while none is the name. With `untilBuilt` the asking also
     * ends once every unit has its shard: then the index has nothing more to
     * bring.
     */
    private async awaited(session: Session, name: string, first: RankedHits, forMs: number, untilBuilt: boolean): Promise<RankedHits> {
        const clock = this.host.clock;
        const until = Math.min(session.deadline - 2_000, clock.now() + forMs);
        let ranked = first;
        let wait = 100;
        while (ranked.exact.length === 0 && clock.now() + wait < until) {
            await new Promise<void>((resolve) => {
                clock.startTimer(wait, resolve);
            });
            wait = Math.min(wait * 2, 1_000);
            ranked = rankHits(await session.lookup.symbols(name), name);
            const coverage = untilBuilt ? indexCoverage(session.database) : undefined;
            if (coverage !== undefined && coverage.indexed >= coverage.total) {
                break;
            }
        }
        return ranked;
    }

    /** What the hits that are the name answer: a symbol for one, a list for several, nothing for none. */
    private async fromHits(session: Session, name: string, ranked: RankedHits, limit: number): Promise<ResolvedSymbol | string | undefined> {
        const { lookup, roots } = session;
        if (ranked.exact.length === 1) {
            const hit = ranked.exact[0];
            return describeAt(lookup, placeOfHit(lookup, hit), hit);
        }
        if (ranked.exact.length > 1) {
            return renderCandidates(name, ranked.exact.map((hit) => ({ hit, place: placeOfHit(lookup, hit) })), roots, limit, ranked.caseInsensitive);
        }
        return undefined;
    }

    /**
     * The symbol a name means: the one the index has, else the one a use in
     * the translation units leads to. A text when there are several, or none.
     *
     * The index of a client that just got its first document loads within a
     * second from the shards on disk, so the name is asked again that long.
     * A use site is looked for next, since it answers at once for a macro,
     * which the index never has by name. Only when clangd is still building
     * its index is the name then waited for longer.
     */
    private async byName(session: Session, name: string, limit: number): Promise<ResolvedSymbol | string> {
        const { lookup, roots } = session;
        let ranked = rankHits(await lookup.symbols(name), name);
        if (ranked.exact.length === 0 && session.young) {
            ranked = await this.awaited(session, name, ranked, INDEX_LOAD_MS, false);
        }
        const indexed = await this.fromHits(session, name, ranked, limit);
        if (indexed !== undefined) {
            return indexed;
        }
        // A macro, a local, or a symbol the index does not have: any place that uses the name leads to it.
        const word = unqualified(name);
        for (const site of await searchUseSites(lookup, session.units, name)) {
            const symbol = await describeAt(lookup, site).catch(() => undefined);
            if (symbol !== undefined && unqualified(symbol.name) === word) {
                symbol.foundBy = `from its use at ${displayPath(site.file, roots)}:${site.position.line + 1} (not in the index by name)`;
                return symbol;
            }
        }
        if (session.building) {
            ranked = await this.awaited(session, name, ranked, INDEX_BUILD_MS, true);
            const late = await this.fromHits(session, name, ranked, limit);
            if (late !== undefined) {
                return late;
            }
        }
        return renderNotFound(name, ranked.near, session.state, roots);
    }

    /** The symbol an id or a name means; a text when it cannot be told. */
    private async symbolOf(session: Session, given: string, limit: number): Promise<ResolvedSymbol | string> {
        const { lookup, roots } = session;
        const id = parseSymbolId(given, roots);
        if (id === undefined) {
            return this.byName(session, given, limit);
        }
        if (fs.existsSync(id.file)) {
            const file = canonical(id.file);
            const lines = (await lookup.document(file)).text.split(/\r?\n/);
            const stated = positionOf(id);
            const word = unqualified(id.name);
            // The id is the place of the name; when the file changed since, the name is looked for nearby.
            const position = lines[stated.line]?.startsWith(word, stated.character) ? stated : findNear(lines, stated.line, word, 30);
            if (position !== undefined) {
                const symbol = await describeAt(lookup, { file, position });
                if (symbol !== undefined) {
                    return symbol;
                }
            }
        }
        const found = await this.byName(session, id.name, limit);
        return typeof found === 'string' ? `The id ${given} no longer names a place where '${id.name}' stands.\n${found}` : found;
    }

    /** How often each relation of the symbol occurs; a count that fails or would take too long is left out. */
    private async counts(lookup: Lookup, symbol: ResolvedSymbol): Promise<RelationCounts> {
        const counts: RelationCounts = {};
        if (!lookup.hasTime(2_000)) {
            return counts;
        }
        const server = lookup.index.server;
        const total = (direction: CallDirection | TypeDirection, calls: boolean): Promise<number | undefined> =>
            (calls ? callHierarchy(lookup, symbol.at, direction as CallDirection, 1, 1_000) : typeHierarchy(lookup, symbol.at, direction as TypeDirection, 1, 1_000))
                .then((hierarchy) => (hierarchy.applies ? hierarchy.count : undefined), () => undefined);
        const callable = isCallable(symbol.kind) && server.callHierarchy;
        const record = isRecord(symbol.kind) && server.typeHierarchy;
        const [references, callers, callees, supertypes, subtypes] = await Promise.all([
            referencesOf(lookup, symbol.at).then((found) => ({ count: found.places.length, files: found.files }), () => undefined),
            callable ? total('callers', true) : undefined,
            callable ? total('callees', true) : undefined,
            record ? total('supertypes', false) : undefined,
            record ? total('subtypes', false) : undefined,
        ]);
        return { references, callers, callees, supertypes, subtypes };
    }

    /** The lines of the files a reply quotes. */
    private async reader(lookup: Lookup, files: Iterable<string>): Promise<LineReader> {
        const texts = new Map<string, string[] | undefined>();
        for (const file of new Set(files)) {
            if (texts.size >= QUOTED_FILES || !lookup.hasTime(500)) {
                break;
            }
            texts.set(file, await lookup.lines(file));
        }
        return (file, line) => texts.get(file)?.[line];
    }

    /** One relation of a symbol, as text. */
    private async relation(session: Session, symbol: ResolvedSymbol, what: SourceRelation, depth: number, limit: number): Promise<string> {
        const { lookup, roots } = session;
        const server = lookup.index.server;
        switch (what) {
            case 'definition': {
                const place = symbol.definition ?? symbol.declaration;
                if (place === undefined) {
                    return `clangd knows no definition and no declaration of ${symbol.name}.`;
                }
                const extent = await definitionExtent(lookup, place).catch(() => undefined);
                const defined = symbol.definition !== undefined ? 'defined' : 'declared (the index has no definition)';
                return renderDefinition(symbol, place, extent, await lookup.lines(place.file), roots, defined);
            }
            case 'references': {
                const references = await referencesOf(lookup, symbol.at);
                return renderReferences(symbol, references, roots, await this.reader(lookup, references.places.map((place) => place.file)), limit);
            }
            case 'callers':
            case 'callees': {
                if (!server.callHierarchy) {
                    return `This clangd (${server.version ?? 'unknown version'}) offers no call hierarchy.`;
                }
                try {
                    const hierarchy = await callHierarchy(lookup, symbol.at, what, depth, limit);
                    return renderHierarchy(symbol, what, hierarchy, roots, await this.reader(lookup, siteFiles(hierarchy.nodes)), depth);
                } catch (caught) {
                    if (caught instanceof LspError && caught.code === METHOD_NOT_FOUND) {
                        return `This clangd (${server.version ?? 'unknown version'}) does not answer ${what}; callees came with clangd 20.`;
                    }
                    throw caught;
                }
            }
            case 'supertypes':
            case 'subtypes': {
                if (!server.typeHierarchy) {
                    return `This clangd (${server.version ?? 'unknown version'}) offers no type hierarchy.`;
                }
                const hierarchy = await typeHierarchy(lookup, symbol.at, what, depth, limit);
                return renderHierarchy(symbol, what, hierarchy, roots, () => undefined, depth);
            }
            case 'implementations': {
                const places = await implementationsOf(lookup, symbol.at);
                return renderImplementations(symbol, places, roots, await this.reader(lookup, places.map((place) => place.file)), limit);
            }
        }
    }

    /**
     * The timeout fence and trace of one call, as for the build-artefact
     * tools. A call that lost its client to a restart of clangd is made once
     * more with the new one; a refusal of clangd becomes a `ToolError`.
     */
    private run(tool: string, args: object, body: (log: PackDocsLog, deadline: number) => Promise<string>): Promise<ToolText> {
        return runTool(tool, ++this.callCounter, args, this.host.log, { defaultTimeoutMs: this.options.timeoutMs, timeoutNote: TIMEOUT_NOTE }, async (log, deadline) => {
            for (let attempt = 1; ; attempt++) {
                const before = this.currentClient();
                try {
                    return await body(log, deadline);
                } catch (caught) {
                    if (caught instanceof ToolError) {
                        throw caught;
                    }
                    const restarted = before !== undefined && (!isRunning(before) || this.currentClient() !== before);
                    if (attempt === 1 && restarted && this.host.clock.now() + 1_000 < deadline) {
                        log.info(`clangd restarted during the call (${messageOf(caught)}): asking the new client`);
                        continue;
                    }
                    if (caught instanceof LspError) {
                        throw new ToolError('TASK_FAILED', `clangd refused the request: ${caught.message} (${caught.code}).`,
                            'The Output channel "clangd" has its log; if it persists, "clangd: Restart language server" starts it again.');
                    }
                    throw caught;
                }
            }
        });
    }

    /** The client the clangd extension has now, without activating it or waiting. */
    private currentClient(): LanguageClientLike | undefined {
        try {
            const extension = this.host.clangdExtension();
            const surface = extension?.isActive ? extension.exports as { getApi?: (version: number) => { languageClient?: LanguageClientLike } } : undefined;
            return surface?.getApi?.(1)?.languageClient ?? undefined;
        } catch {
            return undefined;
        }
    }
}

/** The files the call sites of a hierarchy lie in. */
function siteFiles(nodes: readonly HierarchyNode[]): string[] {
    const files: string[] = [];
    for (const node of nodes) {
        files.push(...node.sites.map((site) => site.file), ...siteFiles(node.children));
    }
    return files;
}
