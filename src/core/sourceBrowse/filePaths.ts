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
 * One file, several spellings of its path.
 *
 * clangd names a file by its real path, and so do the roots a path is shown
 * relative to. The editor names a document by the path it was opened with:
 * through a symbolic link when the workspace folder is one, and on Windows
 * with the drive letter in lower case. The tools therefore compare files by
 * their canonical paths, and look for the editor's document of a file under
 * every spelling: its text is the one the user sees, unsaved changes
 * included, and it is the document the language server already knows.
 *
 * No `vscode`; reads the file system.
 */

import * as fs from 'fs';
import { samePath } from '../bootstrapState';

/** Canonical paths remembered at most, before the memory starts again. */
const KNOWN_PATHS = 2_000;

/**
 * A path with its symbolic links resolved; the path itself when it does not exist.
 * Not `realpathSync.native`: on Windows that also turns a short name (`RUNNER~1`)
 * into the long one, so a file clangd names in the spelling of the compile database
 * would no longer lie inside the folder, and a URI built from it would name a
 * document clangd does not know.
 */
export function canonicalPath(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

/**
 * Which of the documents the editor has open is the one of `file`: the index
 * in `open` (their paths) of the document with that path, else of the first
 * whose canonical path is the file's, compared without regard to case where
 * the platform's file names have none. -1 when the editor has none.
 *
 * `known` keeps canonical paths between calls: one tool call asks for
 * hundreds of files, and each open document would be resolved every time.
 */
export function openDocumentIndex(file: string, open: readonly string[], known: Map<string, string>, platform: NodeJS.Platform = process.platform): number {
    const exact = open.indexOf(file);
    if (exact >= 0) {
        return exact;
    }
    const canonicalOf = (given: string): string => {
        let resolved = known.get(given);
        if (resolved === undefined) {
            resolved = canonicalPath(given);
            if (known.size >= KNOWN_PATHS) {
                known.clear();
            }
            known.set(given, resolved);
        }
        return resolved;
    };
    const wanted = canonicalOf(file);
    return open.findIndex((candidate) => samePath(canonicalOf(candidate), wanted, platform));
}
