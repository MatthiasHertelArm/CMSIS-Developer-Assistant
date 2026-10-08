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
 * Where knowledge indexes come from besides the setting: every installed
 * pack that carries one, and the workspace. A pack ships its knowledge as
 * `knowledge.db` (or `knowledge/knowledge.db`) next to its PDSC, built by
 * the knowledge-base tooling; a project keeps its own under
 * `.cmsis/knowledge.db`. All of them are read whatever the active target:
 * the `applies_to` filter of the units keeps a pack's knowledge to its
 * devices.
 *
 * Found by reading the pack root (`<root>/<Vendor>/<Pack>/<version>/`) and
 * the local repository index cpackget keeps (`.Local/local_repository.pidx`,
 * packs registered from a folder). No `vscode` import.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The file names a pack or a workspace may carry. */
const INDEX_NAMES = ['knowledge.db', path.join('knowledge', 'knowledge.db')];

export interface FoundIndex {
    /** `Vendor::Pack@version` for a pack, `workspace` or `workspace:<name>` for a folder. */
    label: string;
    file: string;
}

function indexIn(dir: string): string | undefined {
    for (const name of INDEX_NAMES) {
        const candidate = path.join(dir, name);
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // not there
        }
    }
    return undefined;
}

function subdirs(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name).sort();
    } catch {
        return [];
    }
}

/** The packs of the pack root that carry an index: `<root>/<Vendor>/<Pack>/<version>/`. */
export function installedPackIndexes(packRoot: string): FoundIndex[] {
    const found: FoundIndex[] = [];
    for (const vendor of subdirs(packRoot)) {
        for (const pack of subdirs(path.join(packRoot, vendor))) {
            for (const version of subdirs(path.join(packRoot, vendor, pack))) {
                const file = indexIn(path.join(packRoot, vendor, pack, version));
                if (file !== undefined) {
                    found.push({ label: `${vendor}::${pack}@${version}`, file });
                }
            }
        }
    }
    return found;
}

/**
 * The packs of `.Local/local_repository.pidx` that carry an index. Each
 * `<pdsc url="file:///dir/" vendor="V" name="N" version="x"/>` names the
 * folder the pack lives in.
 */
export function localRepositoryIndexes(packRoot: string): FoundIndex[] {
    const pidx = path.join(packRoot, '.Local', 'local_repository.pidx');
    let text: string;
    try {
        text = fs.readFileSync(pidx, 'utf-8');
    } catch {
        return [];
    }
    const found: FoundIndex[] = [];
    for (const match of text.matchAll(/<pdsc\b([^>]*)\/?>/g)) {
        const attribute = (name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(match[1])?.[1];
        const url = attribute('url');
        if (url === undefined) {
            continue;
        }
        let dir = url.replace(/^file:\/\//, '');
        try {
            dir = decodeURIComponent(dir);
        } catch {
            // keep as is
        }
        if (/^\/[A-Za-z]:/.test(dir)) {
            dir = dir.slice(1); // file:///C:/… on Windows
        }
        const file = indexIn(dir);
        if (file !== undefined) {
            const version = attribute('version');
            found.push({ label: `${attribute('vendor') ?? '?'}::${attribute('name') ?? '?'}${version ? `@${version}` : ''} (local)`, file });
        }
    }
    return found;
}

/** The index a workspace folder carries under `.cmsis/`. */
export function workspaceIndexes(folders: readonly string[]): FoundIndex[] {
    const found: FoundIndex[] = [];
    for (const folder of folders) {
        const file = indexIn(path.join(folder, '.cmsis'));
        if (file !== undefined) {
            found.push({ label: folders.length === 1 ? 'workspace' : `workspace:${path.basename(folder)}`, file });
        }
    }
    return found;
}

/** Every index besides the base one, packs first, without a file twice. */
export function discoverIndexes(packRoot: string | undefined, folders: readonly string[]): FoundIndex[] {
    const all = [
        ...(packRoot ? installedPackIndexes(packRoot) : []),
        ...(packRoot ? localRepositoryIndexes(packRoot) : []),
        ...workspaceIndexes(folders),
    ];
    const seen = new Set<string>();
    return all.filter((entry) => !seen.has(entry.file) && seen.add(entry.file));
}
