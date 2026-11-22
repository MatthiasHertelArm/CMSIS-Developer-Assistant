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
 * Which compile database the editor's clangd runs with, and how far its
 * index is.
 *
 * CMSIS Solution points clangd at one context of the solution by writing
 * `--compile-commands-dir=<out folder>` into the setting `clangd.arguments`,
 * with `${workspaceFolder}` in it; the clangd extension substitutes such
 * variables when it starts the server, and so does `substituteVariables`.
 * That folder holds `compile_commands.json`, which `cbuild setup` writes
 * without a build, and clangd keeps its index beside it, one shard per
 * indexed file under `.cache/clangd/index`. The shards on disk are the only
 * sign of the index's progress that can be read without the server's
 * progress notifications, which belong to the clangd extension.
 *
 * No `vscode`; reads the file system.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The clangd option that names the folder of the compile database. */
const DIR_OPTION = 'compile-commands-dir';
/** Source files clangd indexes; an assembler file has a compile command and no shard. */
const INDEXED_UNIT = /\.(c|cc|cpp|cxx|c\+\+|m|mm)$/i;
/** `<file name>.<16 hex digits>.idx`, as clangd names a shard. */
const SHARD_NAME = /^(.+)\.[0-9A-Fa-f]{16}\.idx$/;

/**
 * The folder `--compile-commands-dir` names in clangd's arguments, as it is
 * written there (variables not substituted). Both spellings clangd takes are
 * read: `--option=value` and `--option value`, with one dash or two.
 */
export function compileCommandsDirOf(args: readonly unknown[]): string | undefined {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (typeof arg !== 'string') {
            continue;
        }
        const option = /^--?([a-z-]+)(?:=(.*))?$/.exec(arg.trim());
        if (!option || option[1] !== DIR_OPTION) {
            continue;
        }
        const value = option[2] ?? args[index + 1];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}

/**
 * `text` with every `${name}` replaced by what `lookup` answers for the
 * name; a placeholder it has no answer for stays as it is.
 */
export function substituteVariables(text: string, lookup: (name: string) => string | undefined): string {
    return text.replace(/\$\{(.*?)\}/g, (placeholder, name: string) => lookup(name) ?? placeholder);
}

/** The compile database of one context. */
export interface CompileDatabase {
    /** The folder `--compile-commands-dir` names. */
    dir: string;
    /** `compile_commands.json` in it. */
    file: string;
    /** The source files it has a command for, absolute, in the file's order, each once. */
    units: string[];
}

/**
 * The compile database in `dir`; undefined when the folder has no
 * `compile_commands.json` or the file is no list of commands.
 */
export function readCompileDatabase(dir: string): CompileDatabase | undefined {
    const file = path.join(dir, 'compile_commands.json');
    let entries: unknown;
    try {
        entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
    if (!Array.isArray(entries)) {
        return undefined;
    }
    const units = new Set<string>();
    for (const entry of entries as Array<{ file?: unknown; directory?: unknown }>) {
        if (typeof entry?.file !== 'string' || entry.file.length === 0) {
            continue;
        }
        const base = typeof entry.directory === 'string' ? entry.directory : dir;
        units.add(path.normalize(path.isAbsolute(entry.file) ? entry.file : path.resolve(base, entry.file)));
    }
    return { dir, file, units: [...units] };
}

/**
 * The context a compile database belongs to, `Blinky.Debug+MPS3`, read from
 * the name of the `*.cbuild.yml` csolution writes into the same folder or the
 * one above it. Undefined when there is none, or more than one.
 */
export function contextNameOf(dir: string): string | undefined {
    for (const folder of [dir, path.dirname(dir)]) {
        let names: string[];
        try {
            names = fs.readdirSync(folder).filter((name) => name.endsWith('.cbuild.yml'));
        } catch {
            continue;
        }
        if (names.length === 1) {
            return names[0].slice(0, -'.cbuild.yml'.length);
        }
        if (names.length > 1) {
            return undefined;
        }
    }
    return undefined;
}

/** How many of a compile database's source files clangd has indexed, as far as its shards on disk say. */
export interface IndexCoverage {
    /** Units with a shard. */
    indexed: number;
    /** Units clangd indexes: the C and C++ files of the database. */
    total: number;
    /** Units of the database without a shard, at most ten. */
    missing: string[];
    /** Units whose file is newer than its shard, at most ten. */
    stale: string[];
}

/**
 * The coverage of `database` by the shards under its folder. A shard is
 * found by the file's name, so two units of the same name in different
 * folders count as one: the figure is a hint, not a proof. Undefined when
 * clangd has written no index there yet.
 */
export function indexCoverage(database: CompileDatabase): IndexCoverage | undefined {
    const folder = path.join(database.dir, '.cache', 'clangd', 'index');
    let names: string[];
    try {
        names = fs.readdirSync(folder);
    } catch {
        return undefined;
    }
    const newest = new Map<string, number>();
    for (const name of names) {
        const shard = SHARD_NAME.exec(name);
        if (!shard) {
            continue;
        }
        let written = 0;
        try {
            written = fs.statSync(path.join(folder, name)).mtimeMs;
        } catch {
            // Removed since the listing: counts as present, of unknown age.
        }
        newest.set(shard[1], Math.max(newest.get(shard[1]) ?? 0, written));
    }
    const units = database.units.filter((unit) => INDEXED_UNIT.test(unit));
    const missing: string[] = [];
    const stale: string[] = [];
    let indexed = 0;
    for (const unit of units) {
        const written = newest.get(path.basename(unit));
        if (written === undefined) {
            if (missing.length < 10) {
                missing.push(unit);
            }
            continue;
        }
        indexed++;
        let changed = 0;
        try {
            changed = fs.statSync(unit).mtimeMs;
        } catch {
            // A unit that is gone cannot be newer than its shard.
        }
        if (changed > written && stale.length < 10) {
            stale.push(unit);
        }
    }
    return { indexed, total: units.length, missing, stale };
}
