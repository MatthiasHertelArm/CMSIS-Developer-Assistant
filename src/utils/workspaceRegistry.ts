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
 * The machine-wide list of CMSIS Developer Assistant windows. Each window
 * keeps one small JSON file in a shared temp directory that says how to reach
 * its control server, which folders it has open and whether it is debugging;
 * the router window reads them all to decide where a tool call runs.
 *
 * The file format is shared by every installed version of the extension, so
 * windows of different versions can find each other: keep it stable. Readers
 * tidy up as they go, dropping entries of processes that are gone and entries
 * that stopped being refreshed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTempPath, writeFileAtomicSync } from './atomicFile';
import { logger } from './logger';

/** One window's registry file, as written by its owner. */
export interface WindowRegistration {
    /** Extension-host process of the window; the identity of the entry. */
    pid: number;
    /** Loopback port of the window's control server. */
    controlPort: number;
    /** Sent back in the control request's token header. */
    controlToken: string;
    /** Absolute file-system paths; empty when no folder is open. */
    workspaceFolders: string[];
    name: string;
    /** Last write, milliseconds since the epoch. */
    updatedAt: number;
    hasActiveSession?: boolean;
    activeConfigurationName?: string;
    cmsisProject?: string;
}

/** Why the router picked a window; it shows up in the routing log line. */
export type ResolutionReason = 'path' | 'pinned' | 'cached' | 'active-session' | 'only-window';

/** Answers whether a process with this pid still exists. */
export type LivenessCheck = (pid: number) => boolean;

/** Refreshed every 20 s by the owner, so a minute of silence means it stopped. */
const STALE_AFTER_MS = 60_000;
const FILE_PREFIX = 'window-';
const FILE_SUFFIX = '.json';
/** Signal 0 delivers nothing; it only asks the kernel whether the pid exists. */
const EXISTENCE_PROBE = 0;

function defaultRegistryDir(): string {
    return path.join(os.tmpdir(), 'cmsis-developer-assistant-registry');
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * True while `pid` names a running process. A process of another user
 * answers the probe with EPERM, which still proves it exists.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, EXISTENCE_PROBE);
        return true;
    } catch (probeError) {
        return errnoCode(probeError) === 'EPERM';
    }
}

/** Remove a file; one that a peer already removed, or that cannot go, is left be. */
function discard(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch {
        // Gone already, or not ours to remove: either way nothing to do.
    }
}

/** Milliseconds since the file was last modified, or undefined when that cannot be read. */
function ageOf(file: string): number | undefined {
    try {
        return Date.now() - fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
}

/** Remove a file only once it is old enough that no writer can still be busy with it. */
function discardIfAbandoned(file: string): void {
    const age = ageOf(file);
    if (age !== undefined && age > STALE_AFTER_MS) {
        discard(file);
    }
}

/** A folder list that is safe to iterate, whatever the file held. */
function foldersOf(entry: WindowRegistration): string[] {
    return Array.isArray(entry.workspaceFolders) ? entry.workspaceFolders : [];
}

/**
 * The form in which paths are compared: absolute, lower-case on Windows,
 * without trailing separators (so the root becomes the empty string).
 */
function comparable(p: string): string {
    const absolute = path.resolve(p);
    const folded = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    return folded.replace(/[\\/]+$/, '');
}

/** Whether `target` is `folder` itself or lies below it; both in comparable form. */
function liesWithin(target: string, folder: string): boolean {
    if (target === folder) {
        return true;
    }
    return target.startsWith(`${folder}${path.sep}`) || target.startsWith(`${folder}/`);
}

export class WorkspaceRegistry {
    private readonly ownFile: string;
    /** What this window last published; the heartbeat rewrites it. */
    private published: WindowRegistration | undefined;

    constructor(
        private readonly pid: number = process.pid,
        private readonly registryDir: string = defaultRegistryDir(),
        private readonly isAlive: LivenessCheck = isProcessAlive,
    ) {
        this.ownFile = path.join(registryDir, `${FILE_PREFIX}${pid}${FILE_SUFFIX}`);
    }

    /** Publish (or republish) this window. Logs instead of throwing. */
    register(reg: Omit<WindowRegistration, 'pid' | 'updatedAt'>): void {
        const next: WindowRegistration = { ...reg, pid: this.pid, updatedAt: Date.now() };
        try {
            this.writeOwnFile(next);
            this.published = next;
        } catch (error) {
            logger.error('Could not write this window into the CMSIS Developer Assistant window registry', error);
        }
    }

    /**
     * Rewrite the last registration with a new timestamp. It never reads the
     * file first, so an entry a peer removed by mistake comes back.
     */
    heartbeat(): void {
        const current = this.published;
        if (!current) {
            return;
        }
        try {
            fs.mkdirSync(this.registryDir, { recursive: true });
            current.updatedAt = Date.now();
            writeFileAtomicSync(this.ownFile, JSON.stringify(current));
        } catch (error) {
            logger.error('Failed to refresh CMSIS Developer Assistant registry entry', error);
        }
    }

    /** Withdraw this window. Never throws. */
    unregister(): void {
        this.published = undefined;
        discard(this.ownFile);
    }

    /**
     * Every live registration, in directory order, pruning dead, stale and
     * broken files on the way.
     */
    list(): WindowRegistration[] {
        let names: string[];
        try {
            names = fs.readdirSync(this.registryDir);
        } catch {
            return [];
        }
        const found: WindowRegistration[] = [];
        for (const name of names) {
            const entry = this.admit(name);
            if (entry) {
                found.push(entry);
            }
        }
        return found;
    }

    /** The window whose folder most deeply contains `targetPath`. */
    findByPath(targetPath: string): WindowRegistration | undefined {
        const windows = this.list();
        const target = comparable(targetPath);
        let owner: WindowRegistration | undefined;
        let ownerDepth = -1;
        for (const candidate of windows) {
            for (const folder of foldersOf(candidate)) {
                const key = comparable(folder);
                // Strictly longer only: on a tie the window listed first keeps it.
                if (key.length > ownerDepth && liesWithin(target, key)) {
                    owner = candidate;
                    ownerDepth = key.length;
                }
            }
        }
        if (owner) {
            return owner;
        }
        // A lone window without folders may take any path; nobody else can claim it.
        const lone = windows.length === 1 ? windows[0] : undefined;
        return lone && foldersOf(lone).length === 0 ? lone : undefined;
    }

    /** The one window with a debug session; none when there are zero or several. */
    findSoleActiveSession(): WindowRegistration | undefined {
        const debugging = this.list().filter((candidate) => candidate.hasActiveSession);
        return debugging.length === 1 ? debugging[0] : undefined;
    }

    /** The one registered window; none when there are zero or several. */
    findSoleWindow(): WindowRegistration | undefined {
        const windows = this.list();
        return windows.length === 1 ? windows[0] : undefined;
    }

    findByPid(pid: number): WindowRegistration | undefined {
        return this.list().find((candidate) => candidate.pid === pid);
    }

    /** The folder itself or any path inside it, with the same folderless fallback. */
    findByWorkspaceFolder(folder: string): WindowRegistration | undefined {
        return this.findByPath(folder);
    }

    /** Still registered under the same pid and the same control port. */
    isLive(entry: WindowRegistration): boolean {
        const current = this.findByPid(entry.pid);
        return current !== undefined && current.controlPort === entry.controlPort;
    }

    private writeOwnFile(entry: WindowRegistration): void {
        fs.mkdirSync(this.registryDir, { recursive: true });
        writeFileAtomicSync(this.ownFile, JSON.stringify(entry));
    }

    /** One directory entry through the pruning rules: the registration, or undefined. */
    private admit(name: string): WindowRegistration | undefined {
        const file = path.join(this.registryDir, name);
        // Checked before the name filter: `window-7.json.7.0badc0de.tmp` ends in `.tmp`.
        if (isTempPath(name)) {
            discardIfAbandoned(file);
            return undefined;
        }
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
            return undefined;
        }
        let entry: WindowRegistration;
        let owner: number;
        try {
            entry = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowRegistration;
            owner = entry.pid;
        } catch {
            // A fresh unreadable file may be a peer's write in flight.
            discardIfAbandoned(file);
            return undefined;
        }
        if (!this.isAlive(owner)) {
            discard(file);
            return undefined;
        }
        // The reader's own entry is never pruned for age, only other windows' ones.
        if (owner !== this.pid && Date.now() - entry.updatedAt > STALE_AFTER_MS) {
            discard(file);
            return undefined;
        }
        return entry;
    }
}

/**
 * One line naming a window for agents: pid, folders, the debug session and
 * the CMSIS solution, joined by ` | `. Port and token never appear.
 */
export function describeWindow(entry: WindowRegistration): string {
    const folders = foldersOf(entry);
    const parts: string[] = [
        `pid=${entry.pid}`,
        folders.length > 0 ? folders.join(', ') : '(no folder open)',
    ];
    if (entry.hasActiveSession) {
        parts.push(entry.activeConfigurationName ? `debugging: ${entry.activeConfigurationName}` : 'debugging');
    }
    if (entry.cmsisProject) {
        parts.push(`cmsis=${entry.cmsisProject}`);
    }
    return parts.join(' | ');
}
