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
 * The retired user documents folder (`~/.cmsis-pack-docs/user`, setting
 * `packDocs.userDocsDir`), read once to copy its documents into the
 * document service (`src/docService/`), which keeps the documents the user
 * adds since 2.9.x. The folder attributed a document by sub-folder:
 *
 *   <root>/<Vendor>/<Pack>/*.pdf     the pack (any version)
 *   <root>/<Vendor>/*.pdf            the vendor
 *   <root>/devices/<name>/*.pdf      the device
 *   <root>/boards/<name>/*.pdf       the board
 *   <root>/cores/<core>/*.pdf        the core
 *   <root>/*.pdf                     every target
 *
 * with title, category and edition from a `docs.json` beside the PDFs. A
 * pattern folder (`devices/STM32U5*`) has no attribution in the service and
 * is reported, not copied. The folder is only read, never changed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DocParent } from '../../docService/contract';
import { BookCategory } from './pdscBooks';

export interface UserDocMeta {
    title?: string;
    category?: BookCategory;
    revision?: string;
}

export type UserDocsManifest = Record<string, UserDocMeta>;

export const USER_DOCS_MANIFEST = 'docs.json';

/** One PDF of the retired folder: where it is, its metadata, its folder below the root. */
export interface LegacyUserDoc {
    path: string;
    title: string;
    category?: BookCategory;
    revision?: string;
    /** The folders between the root and the file, e.g. `['devices', 'STM32U585AIIx']`. */
    parts: string[];
}

const MAX_DEPTH = 3;
const MAX_FILES = 500;

/** The setting, with `~` expanded; empty → `~/.cmsis-pack-docs/user`. */
export function resolveUserDocsDir(setting: string | undefined, home: string = os.homedir()): string {
    const s = (setting ?? '').trim();
    if (!s) { return path.join(home, '.cmsis-pack-docs', 'user'); }
    return path.resolve(s.replace(/^~(?=$|[\\/])/, home));
}

export function readManifest(dir: string): UserDocsManifest {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, USER_DOCS_MANIFEST), 'utf-8')) as UserDocsManifest;
        return m && typeof m === 'object' ? m : {};
    } catch {
        return {};
    }
}

/** Every PDF of the retired folder, at most three folders deep; none when it does not exist. */
export function listLegacyUserDocs(root: string): LegacyUserDoc[] {
    const out: LegacyUserDoc[] = [];
    const walk = (dir: string, depth: number): void => {
        if (out.length >= MAX_FILES || depth > MAX_DEPTH) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const manifest = readManifest(dir);
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!e.name.startsWith('.')) { walk(full, depth + 1); }
                continue;
            }
            if (!e.isFile() || !e.name.toLowerCase().endsWith('.pdf')) { continue; }
            const meta = manifest[e.name] ?? {};
            out.push({
                path: full,
                title: meta.title?.trim() || e.name.replace(/\.pdf$/i, ''),
                ...(meta.category ? { category: meta.category } : {}),
                ...(meta.revision ? { revision: meta.revision } : {}),
                parts: path.relative(root, dir).split(path.sep).filter((part) => part.length > 0),
            });
        }
    };
    walk(root, 0);
    return out;
}

/** The service parent of a folder of the retired layout; undefined for a pattern, which the service cannot attribute. */
export function legacyParent(parts: readonly string[]): DocParent | undefined {
    const glob = (text: string): boolean => /[*?[\]]/.test(text);
    if (parts.length === 0) { return { all: true }; }
    const [first, second] = parts;
    if (first === 'devices' || first === 'boards') {
        if (!second || glob(second)) { return undefined; }
        return first === 'devices' ? { device: second } : { board: second };
    }
    if (first === 'cores') { return second ? { core: second } : undefined; }
    if (glob(first) || (second !== undefined && glob(second))) { return undefined; }
    return second ? { pack: `${first}::${second}` } : { vendor: first };
}
