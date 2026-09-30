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
 * The csolution files below a folder that is not (yet) a workspace folder,
 * for `cmsis_action open_solution`: a bounded walk of the directory tree,
 * since `vscode.workspace.findFiles` only sees the open workspace. No vscode.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSolutionFile } from '../core/bootstrapState';

/** Directories that hold build output or dependencies, never a project's csolution. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'out', 'tmp', 'build', 'RTE']);
/** How deep below the folder the walk goes; the folder itself is level 0. */
const MAX_DEPTH = 3;
/** Directory entries looked at before the walk stops, so a huge tree costs little. */
const MAX_ENTRIES = 5_000;
/** Files reported at most. */
const MAX_FOUND = 10;

/**
 * The `*.csolution.yml` files in `folder` and up to three levels below it,
 * nearest first, at most ten. Hidden directories and build output are
 * skipped; an unreadable directory is passed by.
 */
export function findSolutionFiles(folder: string): string[] {
    const found: string[] = [];
    let seen = 0;
    let level: string[] = [folder];
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const directory of level) {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                continue;
            }
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of entries) {
                seen++;
                if (seen > MAX_ENTRIES || found.length >= MAX_FOUND) {
                    return found;
                }
                if (entry.isFile() && isSolutionFile(entry.name)) {
                    found.push(path.join(directory, entry.name));
                } else if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
                    next.push(path.join(directory, entry.name));
                }
            }
        }
        level = next;
    }
    return found;
}
