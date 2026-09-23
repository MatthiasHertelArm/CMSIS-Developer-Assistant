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
 * windows of different versions can find each other: keep it stable, and
 * ignore fields you do not know. Readers tidy up as they go, dropping entries
 * of processes that are gone and entries that stopped being refreshed.
 *
 * The files carry each window's control token, so only this user may read
 * them (#19): the directory is 0700 and the files 0600. Where the temp
 * directory is shared by all users (Linux /tmp) the directory name carries
 * the uid (`resolveRegistryDir`); a directory that is a symbolic link or
 * belongs to someone else is not used at all (`ensureRegistryDir`), and the
 * window then works on its own.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTempPath, writeFileAtomicSync } from './atomicFile';
import { logger } from './logger';

/** What a window does: serve MCP and forward every call (router), or run what is forwarded to it (worker). */
export type WindowRole = 'router' | 'worker';

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
    /** Written since 2.5.1; the entries of older windows have none. */
    role?: WindowRole;
    /** First in the file, for whoever opens it: it says the file is internal. Readers ignore it. */
    _note?: string;
}

/**
 * Why the router picked a window, strongest first: the call's `window`
 * argument, its file path, the session's pin, the window it reached before,
 * the one debugging window, the one window. It shows up in the routing log
 * line.
 */
export type ResolutionReason = 'window-arg' | 'path' | 'pinned' | 'cached' | 'active-session' | 'only-window';

/** Answers whether a process with this pid still exists. */
export type LivenessCheck = (pid: number) => boolean;

/** Refreshed every 20 s by the owner, so a minute of silence means it stopped. */
const STALE_AFTER_MS = 60_000;
const FILE_PREFIX = 'window-';
const FILE_SUFFIX = '.json';
/** Signal 0 delivers nothing; it only asks the kernel whether the pid exists. */
const EXISTENCE_PROBE = 0;
/** The directory name of every version so far; kept wherever the temp directory is private to the user. */
const REGISTRY_DIR_NAME = 'cmsis-developer-assistant-registry';
/** Only this user may list, enter or change the directory, and read or write the files. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Any permission for group or others. */
const GROUP_OTHER_BITS = 0o077;
/** Write permission for others: a temp directory every user shares. */
const OTHERS_WRITE = 0o002;
/** For whoever opens a window file, a person or an agent reading the disk. */
const ENTRY_NOTE = 'Internal to the CMSIS Developer Assistant. Agents: use the MCP tools list_debug_windows and select_debug_window.';

/** What `resolveRegistryDir` looks at, injected so every case can be tested on any machine. */
export interface RegistryDirContext {
    platform: NodeJS.Platform;
    /** `os.tmpdir()`. */
    tmpdir: string;
    /** `process.getuid()`; undefined on Windows. */
    uid: number | undefined;
    /** `fs.statSync`, which follows links: macOS /tmp is a link to /private/tmp. */
    stat: (target: string) => { mode: number };
}

/** Who judges a registry directory; a test poses as another user with another uid. */
export interface RegistryOwner {
    platform: NodeJS.Platform;
    uid: number | undefined;
}

/** What a `WorkspaceRegistry` needs beyond pid, directory and liveness check. */
export interface RegistryOptions extends Partial<RegistryOwner> {
    /**
     * Called once with the message when the directory is refused, so the
     * window can show it; the refusal is logged as an error either way.
     */
    onRefused?: (message: string) => void;
}

/**
 * The registry directory for this user. In a temp directory that every user
 * may write to (Linux /tmp, or macOS with TMPDIR unset) the name carries the
 * uid, so another user cannot take the one name all windows of this user look
 * for. Everywhere else — the per-user temp directories of macOS and Windows,
 * a folder in the home directory — it keeps the name 2.5.0 and earlier use,
 * so windows of those versions and of this one still find each other.
 */
export function resolveRegistryDir(context: RegistryDirContext): string {
    const shared = path.join(context.tmpdir, REGISTRY_DIR_NAME);
    if (context.platform === 'win32' || context.uid === undefined) {
        return shared;
    }
    let mode: number;
    try {
        mode = context.stat(context.tmpdir).mode;
    } catch {
        return shared;
    }
    return (mode & OTHERS_WRITE) !== 0 ? `${shared}-${context.uid}` : shared;
}

function defaultRegistryDir(): string {
    return resolveRegistryDir({ platform: process.platform, tmpdir: os.tmpdir(), uid: process.getuid?.(), stat: fs.statSync });
}

function errnoCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Why a directory entry must not hold the registry, worded to follow its
 * path; undefined when it may. Ownership is not checked on Windows, where
 * the ACL of %TEMP% keeps other users out.
 */
function unfitReason(stats: fs.Stats, owner: RegistryOwner): string | undefined {
    if (stats.isSymbolicLink()) {
        return 'is a symbolic link';
    }
    if (!stats.isDirectory()) {
        return 'is not a directory';
    }
    if (owner.platform !== 'win32' && owner.uid !== undefined && stats.uid !== owner.uid) {
        return 'belongs to another user';
    }
    return undefined;
}

/** `lstat` of the path, or undefined when nothing is there. */
function lstatIfPresent(target: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (errnoCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/**
 * Make `dir` ready for this user's registry, or say why it cannot be. A
 * missing directory is created 0700. An existing one must be a directory,
 * not a symbolic link, and on POSIX belong to this user; one that others may
 * still enter (2.5.0 left it 0755) is narrowed to 0700.
 * @returns undefined when the directory is fit, else the reason it is not.
 */
export function ensureRegistryDir(dir: string, owner: RegistryOwner): string | undefined {
    if (lstatIfPresent(dir) === undefined) {
        fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
    }
    // Looked at again after the mkdir: whatever stands there now is what gets judged.
    const stats = fs.lstatSync(dir);
    const reason = unfitReason(stats, owner);
    if (reason === undefined && owner.platform !== 'win32' && (stats.mode & GROUP_OTHER_BITS) !== 0) {
        try {
            fs.chmodSync(dir, DIRECTORY_MODE);
        } catch (error) {
            logger.warn(`Could not narrow ${dir} to mode 0700; the window files in it stay 0600`, error);
        }
    }
    return reason;
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
    private readonly owner: RegistryOwner;
    private readonly onRefused: ((message: string) => void) | undefined;
    /** What this window last asked to publish; the heartbeat rewrites it. */
    private published: WindowRegistration | undefined;
    /** The refusal last reported, so a heartbeat does not repeat it every 20 s. */
    private reportedRefusal: string | undefined;

    constructor(
        private readonly pid: number = process.pid,
        private readonly registryDir: string = defaultRegistryDir(),
        private readonly isAlive: LivenessCheck = isProcessAlive,
        options: RegistryOptions = {},
    ) {
        this.ownFile = path.join(registryDir, `${FILE_PREFIX}${pid}${FILE_SUFFIX}`);
        this.owner = { platform: options.platform ?? process.platform, uid: options.uid ?? process.getuid?.() };
        this.onRefused = options.onRefused;
    }

    /** Publish (or republish) this window. Logs instead of throwing. */
    register(reg: Omit<WindowRegistration, 'pid' | 'updatedAt' | '_note'>): void {
        this.published = { _note: ENTRY_NOTE, ...reg, pid: this.pid, updatedAt: Date.now() };
        this.writeOwnFile(this.published, 'Could not write this window into the CMSIS Developer Assistant window registry');
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
        current.updatedAt = Date.now();
        this.writeOwnFile(current, 'Failed to refresh CMSIS Developer Assistant registry entry');
    }

    /** Withdraw this window. Never throws. */
    unregister(): void {
        this.published = undefined;
        if (this.readRefusal() === undefined) {
            discard(this.ownFile);
        }
    }

    /**
     * Every live registration, in directory order, pruning dead, stale and
     * broken files on the way. A directory this user must not trust is not
     * read at all: the window then sees only itself, so its own tool calls
     * still run while the other windows stay out of reach.
     */
    list(): WindowRegistration[] {
        if (this.readRefusal() !== undefined) {
            return this.published ? [this.published] : [];
        }
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

    /** Write this window's file, 0600, into a directory fit for it; logs instead of throwing. */
    private writeOwnFile(entry: WindowRegistration, failure: string): void {
        try {
            const refusal = ensureRegistryDir(this.registryDir, this.owner);
            if (refusal !== undefined) {
                this.refuse(refusal);
                return;
            }
            this.reportedRefusal = undefined;
            writeFileAtomicSync(this.ownFile, JSON.stringify(entry), { mode: FILE_MODE });
        } catch (error) {
            logger.error(failure, error);
        }
    }

    /** Log a refused directory as an error and hand it to `onRefused`, once per distinct refusal. */
    private refuse(reason: string): void {
        const message = `Multi-window routing is off in this window: ${this.registryDir} ${reason}. `
            + 'Remove it, or ask its owner to; the window registers again at its next refresh.';
        if (message === this.reportedRefusal) {
            return;
        }
        this.reportedRefusal = message;
        logger.error(message);
        try {
            this.onRefused?.(message);
        } catch (error) {
            logger.warn('Could not show the registry warning', error);
        }
    }

    /** Why the directory must not be read, or undefined when it may (a missing one included). */
    private readRefusal(): string | undefined {
        try {
            const stats = lstatIfPresent(this.registryDir);
            return stats === undefined ? undefined : unfitReason(stats, this.owner);
        } catch {
            // Not even lstat works here; the readdir that follows fails the same way and finds nothing.
            return undefined;
        }
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
 * One line naming a window for agents: pid, folders, `router` for the window
 * that serves MCP, the debug session and the CMSIS solution, joined by
 * ` | `. Port and token never appear.
 */
export function describeWindow(entry: WindowRegistration): string {
    const folders = foldersOf(entry);
    const parts: string[] = [
        `pid=${entry.pid}`,
        folders.length > 0 ? folders.join(', ') : '(no folder open)',
    ];
    if (entry.role === 'router') {
        parts.push('router');
    }
    if (entry.hasActiveSession) {
        parts.push(entry.activeConfigurationName ? `debugging: ${entry.activeConfigurationName}` : 'debugging');
    }
    if (entry.cmsisProject) {
        parts.push(`cmsis=${entry.cmsisProject}`);
    }
    return parts.join(' | ');
}
