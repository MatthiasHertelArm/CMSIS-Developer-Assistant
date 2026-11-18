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
 * `packDocs.userDocsDir`). Documents the user adds are kept by the document
 * service (`src/docService/`) since 2.9.x, and this folder is neither read
 * nor moved (decision of 2026-11-17): the extension only looks whether it
 * still holds PDFs, and tells the user once that it is no longer used, so
 * that they add what they still need to a target and delete the rest.
 *
 * Pure: no `vscode`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MAX_DEPTH = 3;
const MAX_FILES = 500;

/** The setting, with `~` expanded; empty → `~/.cmsis-pack-docs/user`. */
export function resolveUserDocsDir(setting: string | undefined, home: string = os.homedir()): string {
    const s = (setting ?? '').trim();
    if (!s) { return path.join(home, '.cmsis-pack-docs', 'user'); }
    return path.resolve(s.replace(/^~(?=$|[\\/])/, home));
}

/** How many PDFs the retired folder holds, at most three folders deep and 500 in all; 0 when it does not exist. */
export function countLegacyUserDocs(root: string): number {
    let count = 0;
    const walk = (dir: string, depth: number): void => {
        if (count >= MAX_FILES || depth > MAX_DEPTH) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (!e.name.startsWith('.')) { walk(path.join(dir, e.name), depth + 1); }
            } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf') && count < MAX_FILES) {
                count++;
            }
        }
    };
    walk(root, 0);
    return count;
}

/**
 * What the user is told once about a retired folder that still holds
 * `count` PDFs; undefined for an empty or missing one, which needs no word.
 */
export function legacyUserDocsNotice(root: string, count: number): string | undefined {
    if (count <= 0) {
        return undefined;
    }
    return `The user documents folder ${root} (${count} PDF${count === 1 ? '' : 's'}) is no longer used: the documentation tools do not read it. `
        + 'Add the documents you still need to a target with Add Document in the Target Documents view or Import Document for Current Target, '
        + 'then delete the folder.';
}
