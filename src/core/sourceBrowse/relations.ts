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
 * What can be asked about a symbol once its place is known: the extent of
 * its definition, its references, the functions that call it and that it
 * calls, the types above and below it, and its implementations.
 *
 * The call and type hierarchies are walked level by level up to a depth, and
 * every walk has three ends that are told apart in what it returns: the
 * limit of entries, the call's deadline, and a symbol met a second time. A
 * walk never fails because one branch did: that branch is marked and the
 * others go on.
 *
 * No `vscode`, no file access.
 */

import { HierarchyItem, IncomingCall, Location, OutgoingCall, Range, locationsOf } from './protocol';
import { FilePlace, Lookup, fileOfUri, outlineOf, symbolAtName } from './symbolQuery';

/** Which way a hierarchy is walked. */
export type CallDirection = 'callers' | 'callees';
export type TypeDirection = 'supertypes' | 'subtypes';

/** Why a node of a hierarchy has no children listed. */
export type Cut = 'seen' | 'limit' | 'deadline' | 'failed';

/** One function or type of a hierarchy. */
export interface HierarchyNode {
    name: string;
    /** The `SymbolKind` number of the item. */
    kind: number;
    /** What the server adds to the name: a signature or a scope. */
    detail?: string;
    /** Where its name stands. */
    place: FilePlace;
    /**
     * The calls that make the relation, zero-based lines: for a caller, in
     * the caller's own file; for a callee, in the file of the function that
     * calls it. Empty for a type.
     */
    sites: FilePlace[];
    children: HierarchyNode[];
    /** Set when the walk did not go below this node although the depth allowed it. */
    cut?: Cut;
}

/** A hierarchy below one symbol. */
export interface Hierarchy {
    /** False when the server has no item for the place: it is no function, or no type. */
    applies: boolean;
    nodes: HierarchyNode[];
    /** Nodes in the tree. */
    count: number;
    /** True when the limit of entries ended the walk somewhere. */
    limited: boolean;
    /** True when the deadline ended the walk somewhere. */
    timedOut: boolean;
}

/** The references to a symbol. */
export interface References {
    places: FilePlace[];
    /** Distinct files among them. */
    files: number;
}

/** A place as a key. */
function keyOf(item: HierarchyItem): string {
    return `${item.uri}#${item.selectionRange.start.line}:${item.selectionRange.start.character}#${item.name}`;
}

/** The place of an item's name. */
function placeOfItem(lookup: Lookup, item: HierarchyItem): FilePlace {
    return { file: lookup.canonical(fileOfUri(item.uri)), position: item.selectionRange.start };
}

/** Ranges of one file as places. */
function sitesIn(file: string, ranges: readonly Range[] | undefined): FilePlace[] {
    return (ranges ?? []).map((range) => ({ file, position: range.start }));
}

/**
 * The lines the definition at `place` covers, from the outline of its file:
 * the range of the symbol whose name stands there. Undefined when the
 * outline has no such symbol, as for a macro.
 */
export async function definitionExtent(lookup: Lookup, place: FilePlace): Promise<Range | undefined> {
    return symbolAtName(await outlineOf(lookup, place.file), place.position)?.range;
}

/**
 * Places, each once, in their order. clangd answers a place twice for a
 * document that is open under another spelling of its path (through a
 * symbolic link): from the document, and from the index under the real path.
 */
export function distinctPlaces(places: readonly FilePlace[]): FilePlace[] {
    const seen = new Set<string>();
    return places.filter((place) => {
        const key = `${place.file}:${place.position.line}:${place.position.character}`;
        return seen.has(key) ? false : Boolean(seen.add(key));
    });
}

/**
 * Every reference to the symbol at `at`, its declaration and definition included.
 *
 * For the document asked at, clangd answers from the document itself and
 * leaves the index out, which it tells by the path. A document the editor
 * has open under another spelling of its path (through a symbolic link) is
 * therefore answered twice: under its own path from its text, and under the
 * real path from the index, which holds the saved file. Where both are
 * there, the document's own places count, as clangd means it.
 */
export async function referencesOf(lookup: Lookup, at: FilePlace): Promise<References> {
    const answer = (await lookup.at<Location[] | null>('textDocument/references', at, { context: { includeDeclaration: true } })) ?? [];
    const asked = fileOfUri((await lookup.document(at.file)).uri);
    const file = lookup.canonical(at.file);
    const own = answer.some((location) => fileOfUri(location.uri) === asked);
    const kept = own ? answer.filter((location) => fileOfUri(location.uri) === asked || lookup.place(location).file !== file) : answer;
    const places = distinctPlaces(kept.map((location) => lookup.place(location)));
    return { places, files: new Set(places.map((place) => place.file)).size };
}

/** State of one walk. */
interface Walk {
    lookup: Lookup;
    limit: number;
    count: number;
    limited: boolean;
    timedOut: boolean;
    seen: Set<string>;
}

/** The neighbours of an item one level away, as nodes without children. */
type Step = (lookup: Lookup, item: HierarchyItem) => Promise<Array<{ item: HierarchyItem; node: HierarchyNode }>>;

async function callStep(direction: CallDirection, lookup: Lookup, item: HierarchyItem): Promise<Array<{ item: HierarchyItem; node: HierarchyNode }>> {
    if (direction === 'callers') {
        const calls = (await lookup.withItem<IncomingCall[] | null>('callHierarchy/incomingCalls', item)) ?? [];
        return calls.map((call) => {
            const place = placeOfItem(lookup, call.from);
            return { item: call.from, node: { name: call.from.name, kind: call.from.kind, detail: call.from.detail, place, sites: sitesIn(place.file, call.fromRanges), children: [] } };
        });
    }
    const asked = lookup.canonical(fileOfUri(item.uri));
    const calls = (await lookup.withItem<OutgoingCall[] | null>('callHierarchy/outgoingCalls', item)) ?? [];
    return calls.map((call) => ({
        item: call.to,
        node: { name: call.to.name, kind: call.to.kind, detail: call.to.detail, place: placeOfItem(lookup, call.to), sites: sitesIn(asked, call.fromRanges), children: [] },
    }));
}

async function typeStep(direction: TypeDirection, lookup: Lookup, item: HierarchyItem): Promise<Array<{ item: HierarchyItem; node: HierarchyNode }>> {
    const items = (await lookup.withItem<HierarchyItem[] | null>(`typeHierarchy/${direction}`, item)) ?? [];
    return items.map((entry) => ({ item: entry, node: { name: entry.name, kind: entry.kind, detail: entry.detail, place: placeOfItem(lookup, entry), sites: [], children: [] } }));
}

/** The nodes below `item`, `depth` levels deep, within the walk's limit and time. */
async function below(walk: Walk, step: Step, item: HierarchyItem, depth: number): Promise<HierarchyNode[]> {
    const next = await step(walk.lookup, item);
    const nodes: HierarchyNode[] = [];
    const expand: Array<{ item: HierarchyItem; node: HierarchyNode }> = [];
    for (const entry of next) {
        if (walk.count >= walk.limit) {
            walk.limited = true;
            break;
        }
        walk.count++;
        nodes.push(entry.node);
        const key = keyOf(entry.item);
        if (depth > 1) {
            if (walk.seen.has(key)) {
                entry.node.cut = 'seen';
            } else {
                walk.seen.add(key);
                expand.push(entry);
            }
        }
    }
    for (const entry of expand) {
        if (walk.count >= walk.limit) {
            walk.limited = true;
            entry.node.cut = 'limit';
            continue;
        }
        if (!walk.lookup.hasTime(500)) {
            walk.timedOut = true;
            entry.node.cut = 'deadline';
            continue;
        }
        try {
            entry.node.children = await below(walk, step, entry.item, depth - 1);
        } catch {
            entry.node.cut = 'failed';
        }
    }
    return nodes;
}

/** A walk from the item the server prepares for `at`. */
async function hierarchy(lookup: Lookup, at: FilePlace, prepare: string, step: Step, depth: number, limit: number): Promise<Hierarchy> {
    const items = (await lookup.at<HierarchyItem[] | null>(prepare, at)) ?? [];
    if (items.length === 0) {
        return { applies: false, nodes: [], count: 0, limited: false, timedOut: false };
    }
    const walk: Walk = { lookup, limit: Math.max(1, limit), count: 0, limited: false, timedOut: false, seen: new Set([keyOf(items[0])]) };
    const nodes = await below(walk, step, items[0], Math.max(1, depth));
    return { applies: true, nodes, count: walk.count, limited: walk.limited, timedOut: walk.timedOut };
}

/** The functions that call the function at `at`, or that it calls, `depth` levels deep and at most `limit` in all. */
export function callHierarchy(lookup: Lookup, at: FilePlace, direction: CallDirection, depth: number, limit: number): Promise<Hierarchy> {
    return hierarchy(lookup, at, 'textDocument/prepareCallHierarchy', (inner, item) => callStep(direction, inner, item), depth, limit);
}

/** The types the type at `at` derives from, or that derive from it. */
export function typeHierarchy(lookup: Lookup, at: FilePlace, direction: TypeDirection, depth: number, limit: number): Promise<Hierarchy> {
    return hierarchy(lookup, at, 'textDocument/prepareTypeHierarchy', (inner, item) => typeStep(direction, inner, item), depth, limit);
}

/** Where the virtual function or the type at `at` is implemented. */
export async function implementationsOf(lookup: Lookup, at: FilePlace): Promise<FilePlace[]> {
    return distinctPlaces(locationsOf(await lookup.at<unknown>('textDocument/implementation', at)).map((location) => lookup.place(location)));
}
