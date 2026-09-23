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
 * Write a file through a temp file and a rename, so a reader never sees a
 * half-written file and a crash mid-write leaves the previous content in
 * place. The temp name carries the pid and a random suffix: every VS Code
 * window is its own extension-host process, and several of them write the
 * same agent configurations and registry files at activation.
 *
 * The temp file is always created new (`wx`), so a `mode` given here is the
 * mode of the result: the rename keeps the temp file's inode. The window
 * registry writes 0600 this way; on Windows the mode is ignored and the
 * folder's ACL applies.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

/** How the atomic writers create the file. */
export interface AtomicWriteOptions {
    /** Permission bits of the written file, less the umask; the default is 0666 less the umask. */
    mode?: number;
}

/** `<file>.<pid>.<random>.tmp` — unique per process and per call. */
export function tempPathFor(filePath: string): string {
    return `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/** True for a name `tempPathFor` produced (any pid). */
export function isTempPath(name: string): boolean {
    return /\.\d+\.[0-9a-f]{8}\.tmp$/.test(name);
}

/** `writeFile` options for the temp file: UTF-8, created exclusively, with the requested mode. */
function tempFileOptions(options: AtomicWriteOptions): fs.WriteFileOptions {
    return { encoding: 'utf8', flag: 'wx', mode: options.mode };
}

/** The exclusive create found the temp name taken: that file is not this call's to remove. */
function takenBefore(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

export function writeFileAtomicSync(filePath: string, content: string, options: AtomicWriteOptions = {}): void {
    const tmp = tempPathFor(filePath);
    try {
        fs.writeFileSync(tmp, content, tempFileOptions(options));
        fs.renameSync(tmp, filePath);
    } catch (error) {
        if (!takenBefore(error)) {
            try { fs.unlinkSync(tmp); } catch { /* never written, or already renamed */ }
        }
        throw error;
    }
}

export async function writeFileAtomic(filePath: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
    const tmp = tempPathFor(filePath);
    try {
        await fs.promises.writeFile(tmp, content, tempFileOptions(options));
        await fs.promises.rename(tmp, filePath);
    } catch (error) {
        if (!takenBefore(error)) {
            await fs.promises.unlink(tmp).catch(() => undefined);
        }
        throw error;
    }
}
