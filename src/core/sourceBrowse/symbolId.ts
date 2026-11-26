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
 * How the source-browsing tools name a file and a symbol to an agent, and
 * read both back.
 *
 * A path inside the solution folder is shown relative to it, a path inside
 * the pack root as `${CMSIS_PACK_ROOT}/…` (the notation of `cbuild-run.yml`),
 * anything else absolute. A symbol id is `name@path:line:column`, line and
 * column counted from 1: it is the place of the name in the source, so the
 * server keeps no table of ids and an id survives a reload of the window.
 * The name is in the id so that it can be found again when the file changed.
 *
 * Pure: no `vscode`, no file access.
 */

import * as path from 'path';
import type { Position } from './protocol';

/** The variable csolution writes for the pack root. */
export const PACK_ROOT_VARIABLE = '${CMSIS_PACK_ROOT}';

/** The folders a path is shown relative to. */
export interface PathRoots {
    /** The folder of the solution: the window's first workspace folder. */
    solution?: string;
    /** The CMSIS pack root. */
    packRoot?: string;
}

/** The place of a symbol's name: an absolute file, and a line and column counted from 1. */
export interface SymbolId {
    name: string;
    file: string;
    line: number;
    column: number;
}

/** `child` relative to `parent` with forward slashes, or undefined when it is not inside. */
function inside(parent: string | undefined, child: string): string | undefined {
    if (parent === undefined || parent.length === 0) {
        return undefined;
    }
    const relative = path.relative(parent, child);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        return undefined;
    }
    return relative.split(path.sep).join('/');
}

/** A file as an agent reads it: relative to the solution folder, under `${CMSIS_PACK_ROOT}`, or absolute. */
export function displayPath(file: string, roots: PathRoots): string {
    const local = inside(roots.solution, file);
    if (local !== undefined) {
        return local;
    }
    const packed = inside(roots.packRoot, file);
    return packed !== undefined ? `${PACK_ROOT_VARIABLE}/${packed}` : file;
}

/**
 * The absolute file a shown path names: `${CMSIS_PACK_ROOT}` and
 * `$CMSIS_PACK_ROOT` are the pack root, a relative path lies in the solution
 * folder. Undefined when the root it needs is not known.
 */
export function resolvePath(shown: string, roots: PathRoots): string | undefined {
    const text = shown.trim();
    const packed = /^\$(?:\{CMSIS_PACK_ROOT\}|CMSIS_PACK_ROOT)[\\/]+(.*)$/.exec(text);
    if (packed) {
        return roots.packRoot === undefined ? undefined : path.join(roots.packRoot, packed[1]);
    }
    if (path.isAbsolute(text)) {
        return path.normalize(text);
    }
    return roots.solution === undefined ? undefined : path.join(roots.solution, text);
}

/** `name@path:line:column`. */
export function formatSymbolId(id: SymbolId, roots: PathRoots): string {
    return `${id.name}@${displayPath(id.file, roots)}:${id.line}:${id.column}`;
}

/**
 * The parts of a text of the shape `name@path:line:column`, the path as it
 * is written. The name ends at the first `@`, since no C or C++ name
 * contains one; line and column are the last two numbers, so a drive letter
 * in the path does no harm. Undefined for a text of another shape.
 */
function idParts(text: string): { name: string; path: string; line: number; column: number } | undefined {
    const trimmed = text.trim();
    const at = trimmed.indexOf('@');
    if (at <= 0) {
        return undefined;
    }
    const place = /^(.+):(\d+):(\d+)$/.exec(trimmed.slice(at + 1));
    if (!place) {
        return undefined;
    }
    const line = Number(place[2]);
    const column = Number(place[3]);
    return line < 1 || column < 1 ? undefined : { name: trimmed.slice(0, at), path: place[1], line, column };
}

/**
 * True for a text that has the shape of an id, whatever its path. The router
 * tells an id from a name with it: an id is a place in the project of the
 * window that wrote it, and the router has no roots to resolve its path with.
 */
export function isSymbolId(text: unknown): boolean {
    return typeof text === 'string' && idParts(text) !== undefined;
}

/**
 * An id as `formatSymbolId` writes it. Undefined for a text that is no id
 * (`idParts`), or whose path cannot be resolved.
 */
export function parseSymbolId(text: string, roots: PathRoots): SymbolId | undefined {
    const parts = idParts(text);
    const file = parts === undefined ? undefined : resolvePath(parts.path, roots);
    return parts === undefined || file === undefined ? undefined : { name: parts.name, file, line: parts.line, column: parts.column };
}

/** The zero-based position of an id on the wire. */
export function positionOf(id: Pick<SymbolId, 'line' | 'column'>): Position {
    return { line: id.line - 1, character: id.column - 1 };
}

/** The last component of a qualified name: `run` of `app::Task::run`, `~Task` of `Task::~Task`. */
export function unqualified(name: string): string {
    const at = name.lastIndexOf('::');
    return at >= 0 ? name.slice(at + 2) : name;
}

/** `text` with every character a regular expression gives a meaning to escaped. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The columns (zero-based) at which `name` stands in `line` as a whole
 * identifier: not inside a longer one. A qualified name is looked for by its
 * last component.
 */
export function occurrences(line: string, name: string): number[] {
    const word = unqualified(name.trim());
    if (word.length === 0) {
        return [];
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`, 'g');
    const found: number[] = [];
    for (const match of line.matchAll(pattern)) {
        found.push(match.index);
    }
    return found;
}

/**
 * Where `name` stands at or near `line` (zero-based) of `lines`: on the line
 * itself, else on the nearest line within `reach` lines, the lines above
 * before the lines below at the same distance. Undefined when it stands on
 * none of them.
 */
export function findNear(lines: readonly string[], line: number, name: string, reach: number): Position | undefined {
    for (let distance = 0; distance <= reach; distance++) {
        for (const candidate of distance === 0 ? [line] : [line - distance, line + distance]) {
            if (candidate < 0 || candidate >= lines.length) {
                continue;
            }
            const columns = occurrences(lines[candidate], name);
            if (columns.length > 0) {
                return { line: candidate, character: columns[0] };
            }
        }
    }
    return undefined;
}
