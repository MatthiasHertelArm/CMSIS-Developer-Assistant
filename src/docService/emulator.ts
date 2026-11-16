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
 * The document service of `contract.ts`, emulated inside this extension
 * until CMSIS Solution provides it. Self-contained on purpose: it imports
 * only Node built-ins, `js-yaml` and the contract (a test enforces it), so it
 * can be handed to the CMSIS Solution team as it is, and the consumer can
 * swap it for CMSIS Solution's implementation without a change.
 *
 * Storage (an injected root, never `~/.cmsis/`):
 *   <root>/docs.yml          the user inventory: every user entry, and this
 *                            machine's state of project entries (copies,
 *                            errors, requests), which never goes into a project
 *   <root>/files/<hash>/...  copies: downloads and imports
 * A project's entries live in `<csolution folder>/.cmsis/docs.yml`, in the
 * layout of CMSIS Solution's own `~/.cmsis/docs.yml` (`docs:` with
 * `devices`, `boards`, and for G2 `cores`, `packs`, `vendors`, `all`), and
 * hold only what can be shared: names (paths relative to the csolution
 * folder, or URLs), titles, categories. Keys the service does not know are
 * kept when it writes. A path that leaves the project is not read; a file
 * of another layout, or CMSIS Solution's own inventory, is never written.
 *
 * Several VS Code windows share the root: every change takes a lock file,
 * reads the inventory again, applies the change and writes a temporary file
 * renamed over the old one. The watcher reports changes by other windows or
 * by hand (G1a). Downloads go through an injected engine, which brings the
 * host's guards (private hosts, size cap) and resolvers.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dump, load } from 'js-yaml';
import {
    DocDisposable,
    DocParent,
    DocScope,
    DOCUMENT_SERVICE_VERSION,
    DocumentError,
    DocumentFailure,
    DocumentFailureKind,
    DocumentInfo,
    DocumentRequest,
    DocumentService,
    DownloadOptions,
    parentKey,
    sameParent,
} from './contract';

/** What a download engine delivers: the copy and what the source said about it. */
export interface DownloadedCopy {
    path: string;
    bytes: number;
    sha256: string;
    filename?: string;
    title?: string;
    version?: string;
    versionLabel?: string;
    alternatives?: { version: string; versionLabel: string }[];
    resolver: string;
}

/** Downloads `url` into `destDir`; rejects with a `DocumentFailure`, or any error (classified from its message). */
export interface DownloadEngine {
    download(url: string, destDir: string, options: DownloadOptions): Promise<DownloadedCopy>;
}

export interface EmulatorOptions {
    /** The folder the service owns. */
    root: string;
    engine: DownloadEngine;
    /** Watch the inventories for changes by others (off in tests). */
    watch?: boolean;
    now?: () => Date;
}

/** One entry as stored. */
interface Entry {
    parent: string;
    name: string;
    title?: string;
    category?: string;
    location?: 'web' | 'local';
    path?: string;
    format?: DocumentInfo['format'];
    bytes?: number;
    sha256?: string;
    filename?: string;
    version?: string;
    versionLabel?: string;
    alternatives?: { version: string; versionLabel: string }[];
    resolver?: string;
    sourceTitle?: string;
    downloadedAt?: string;
    requested?: DocumentRequest;
    error?: DocumentError;
    /** Keys of a project entry the service does not know, kept when it writes. */
    extra?: Record<string, unknown>;
}

/** This machine's state of one project entry. */
interface ProjectState extends Entry {
    project: string;
}

interface UserInventory {
    version: string;
    docs: Entry[];
    projectState: ProjectState[];
}

interface ProjectInventory {
    version: string;
    docs: Entry[];
    /** Top-level keys besides `version` and `docs`, kept when it writes. */
    rest: Record<string, unknown>;
}

/** The lists of a project inventory: the YAML key, the parent kind, the entry's key. */
const PROJECT_LISTS: readonly { list: string; kind: 'device' | 'board' | 'core' | 'pack' | 'vendor' }[] = [
    { list: 'devices', kind: 'device' }, { list: 'boards', kind: 'board' }, { list: 'cores', kind: 'core' },
    { list: 'packs', kind: 'pack' }, { list: 'vendors', kind: 'vendor' },
];
const PROJECT_DOC_KEYS = new Set(['name', 'title', 'category']);

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const isUrl = (text: string): boolean => /^https?:\/\//i.test(text);

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parentOf(key: string): DocParent {
    if (key === 'all') {
        return { all: true };
    }
    const at = key.indexOf(':');
    const kind = key.slice(0, at);
    const value = key.slice(at + 1);
    switch (kind) {
        case 'device': return { device: value };
        case 'board': return { board: value };
        case 'core': return { core: value };
        case 'pack': return { pack: value };
        case 'vendor': return { vendor: value };
        default: throw new Error(`unknown parent '${key}'`);
    }
}

/** The project inventory of a csolution: `<its folder>/.cmsis/docs.yml`. */
export function projectInventoryFile(solution: string): string {
    return path.join(path.dirname(solution), '.cmsis', 'docs.yml');
}

/** A failure's kind from an error message, for engines that throw plain errors. */
export function classifyFailure(message: string): DocumentFailureKind {
    if (/\b(401|403)\b|login|sign[- ]?in|forbidden|unauthori[sz]ed/i.test(message)) { return 'login-required'; }
    if (/not a pdf|text\/html/i.test(message)) { return 'not-pdf'; }
    if (/published as html|\bhtml\b/i.test(message)) { return 'html'; }
    if (/private|loopback|blocked/i.test(message)) { return 'blocked'; }
    if (/too large|maxPdfMb|exceeds/i.test(message)) { return 'too-large'; }
    if (/abort|cancel|stopped/i.test(message)) { return 'cancelled'; }
    if (/time(d)? ?out/i.test(message)) { return 'timeout'; }
    if (/\bHTTP \d{3}\b|\b[45]\d\d\b/.test(message)) { return 'http'; }
    if (/ENOTFOUND|ECONN|network|fetch failed|EAI_AGAIN/i.test(message)) { return 'network'; }
    return 'unknown';
}

/** Whether a stored entry is the document `name` of `parent` (the contract's parent rule). */
function same(entry: { parent: string; name: string }, parent: DocParent, name: string): boolean {
    return entry.name === name && sameParent(parentOf(entry.parent), parent);
}

function formatOf(file: string): DocumentInfo['format'] {
    const ext = path.extname(file).toLowerCase();
    return ext === '.pdf' ? 'pdf' : ext === '.md' ? 'md' : ext === '.txt' ? 'txt' : 'other';
}

function asEntries(value: unknown): Entry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is Entry => typeof item === 'object' && item !== null
        && typeof (item as Entry).parent === 'string' && typeof (item as Entry).name === 'string');
}

/** The emulated service. */
export class EmulatedDocumentService implements DocumentService {
    readonly version = DOCUMENT_SERVICE_VERSION;
    private readonly listeners = new Set<() => void>();
    private readonly watchers = new Map<string, fs.FSWatcher>();
    private changeTimer: NodeJS.Timeout | undefined;
    private readonly now: () => Date;

    constructor(private readonly options: EmulatorOptions) {
        this.now = options.now ?? (() => new Date());
        fs.mkdirSync(options.root, { recursive: true });
        this.watch(options.root);
    }

    /** The user inventory file. */
    get inventoryFile(): string {
        return path.join(this.options.root, 'docs.yml');
    }

    // ── reading and writing ──

    private readUser(): UserInventory {
        const data = this.readYaml(this.inventoryFile) as Partial<UserInventory> | undefined;
        return {
            version: DOCUMENT_SERVICE_VERSION,
            docs: asEntries(data?.docs),
            projectState: asEntries(data?.projectState).filter((entry) => typeof (entry as ProjectState).project === 'string') as ProjectState[],
        };
    }

    /** The project inventory of `solution`; a file of another layout is refused (`foreign`). */
    private readProjectFile(solution: string): ProjectInventory & { foreign?: string } {
        const file = projectInventoryFile(solution);
        const data = this.readYaml(file);
        const empty: ProjectInventory = { version: DOCUMENT_SERVICE_VERSION, docs: [], rest: {} };
        if (data === undefined || data === null) {
            return empty;
        }
        const root = data as Record<string, unknown>;
        const docs = root.docs as Record<string, unknown> | undefined;
        if (typeof root !== 'object' || Array.isArray(root) || (docs !== undefined && (typeof docs !== 'object' || docs === null || Array.isArray(docs)))) {
            return { ...empty, foreign: `${file} is not a document inventory (docs: must be a map of devices, boards, cores, packs, vendors, all)` };
        }
        const entries: Entry[] = [];
        const take = (items: unknown, parent: string): void => {
            for (const item of Array.isArray(items) ? items : []) {
                const raw = item as Record<string, unknown> | null;
                if (raw && typeof raw.name === 'string' && raw.name.trim()) {
                    const extra = Object.fromEntries(Object.entries(raw).filter(([key]) => !PROJECT_DOC_KEYS.has(key)));
                    entries.push({
                        parent, name: raw.name.trim(),
                        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
                        ...(typeof raw.category === 'string' ? { category: raw.category } : {}),
                        ...(Object.keys(extra).length ? { extra } : {}),
                    });
                }
            }
        };
        for (const { list, kind } of PROJECT_LISTS) {
            for (const owner of Array.isArray(docs?.[list]) ? docs![list] as unknown[] : []) {
                const raw = owner as Record<string, unknown> | null;
                if (raw && typeof raw[kind] === 'string') {
                    take(raw.docs, `${kind}:${raw[kind] as string}`);
                }
            }
        }
        take(docs?.all, 'all');
        const rest = Object.fromEntries(Object.entries(root).filter(([key]) => key !== 'docs' && key !== 'version'));
        return { version: DOCUMENT_SERVICE_VERSION, docs: entries, rest };
    }

    private readProject(solution: string): ProjectInventory {
        return this.readProjectFile(solution);
    }

    private readYaml(file: string): unknown {
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf-8');
        } catch {
            return undefined;
        }
        try {
            return load(text);
        } catch (caught) {
            throw new Error(`${file} is not valid YAML (${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)})`);
        }
    }

    private writeYaml(file: string, data: unknown, header: string): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, `${header}\n${dump(data, { lineWidth: 160, noRefs: true })}`, 'utf-8');
        fs.renameSync(temporary, file);
    }

    /** Run `change` under the lock of `file`'s folder; the caller reads inside it. */
    private async locked<T>(file: string, change: () => T): Promise<T> {
        const lock = `${file}.lock`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const started = Date.now();
        for (;;) {
            try {
                fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
                break;
            } catch {
                try {
                    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
                        fs.rmSync(lock, { force: true });
                        continue;
                    }
                } catch {
                    continue;
                }
                if (Date.now() - started > LOCK_WAIT_MS) {
                    throw new Error(`${lock} is held by another window`);
                }
                await sleep(25);
            }
        }
        try {
            return change();
        } finally {
            fs.rmSync(lock, { force: true });
            this.changed();
        }
    }

    private saveUser(inventory: UserInventory): void {
        this.writeYaml(this.inventoryFile, inventory,
            '# Documents of the CMSIS Developer Assistant (emulation of the CMSIS Solution document service). Written by the extension.');
    }

    private saveProject(solution: string, inventory: ProjectInventory): void {
        const file = projectInventoryFile(solution);
        if (path.resolve(file) === path.join(os.homedir(), '.cmsis', 'docs.yml')) {
            throw new Error(`${file} is CMSIS Solution's own inventory; a csolution in the home folder cannot keep project documents`);
        }
        const foreign = this.readProjectFile(solution).foreign;
        if (foreign) {
            throw new Error(`${foreign}; it is not changed`);
        }
        const docs: Record<string, unknown> = {};
        const row = (entry: Entry): Record<string, unknown> => ({ name: entry.name, ...(entry.title ? { title: entry.title } : {}),
            ...(entry.category ? { category: entry.category } : {}), ...(entry.extra ?? {}) });
        for (const { list, kind } of PROJECT_LISTS) {
            const owners = new Map<string, Record<string, unknown>[]>();
            for (const entry of inventory.docs.filter((e) => e.parent.startsWith(`${kind}:`))) {
                const key = entry.parent.slice(kind.length + 1);
                owners.set(key, [...(owners.get(key) ?? []), row(entry)]);
            }
            if (owners.size) {
                docs[list] = [...owners].map(([key, rows]) => ({ [kind]: key, docs: rows }));
            }
        }
        const all = inventory.docs.filter((e) => e.parent === 'all').map(row);
        if (all.length) {
            docs.all = all;
        }
        this.writeYaml(file, { version: DOCUMENT_SERVICE_VERSION, ...inventory.rest, docs },
            '# Documents of this project, in the layout of ~/.cmsis/docs.yml: names relative to the csolution folder, or URLs.\n'
            + '# Shared with the project; local copies, errors and requests stay on each machine.');
    }

    // ── events ──

    private watch(dir: string): void {
        if (this.options.watch !== true || this.watchers.has(dir)) {
            return;
        }
        try {
            const watcher = fs.watch(dir, (_event, file) => {
                if (file && String(file).endsWith('docs.yml')) {
                    this.changed();
                }
            });
            watcher.on('error', () => undefined);
            this.watchers.set(dir, watcher);
        } catch {
            // A folder that cannot be watched: changes by others show at the next read.
        }
    }

    private changed(): void {
        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
        }
        this.changeTimer = setTimeout(() => {
            this.changeTimer = undefined;
            for (const listener of [...this.listeners]) {
                try {
                    listener();
                } catch {
                    // A failing listener costs no other.
                }
            }
        }, 50);
    }

    onDidChangeDocuments(listener: () => void): DocDisposable {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }

    dispose(): void {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
        this.listeners.clear();
        if (this.changeTimer) {
            clearTimeout(this.changeTimer);
        }
    }

    // ── the contract ──

    private info(entry: Entry, scope: DocScope, solution?: string, state?: Entry): DocumentInfo {
        const merged: Entry = { ...entry, ...(state ?? {}), parent: entry.parent, name: entry.name, title: entry.title, category: entry.category };
        const local = !isUrl(entry.name);
        let file = merged.path;
        let outside = false;
        if (local && scope === 'project' && solution) {
            const base = path.dirname(solution);
            const resolved = path.resolve(base, entry.name);
            const relative = path.relative(base, resolved);
            // A cloned project names only its own files: a path that leaves it is not read.
            outside = path.isAbsolute(entry.name) || relative.startsWith('..') || path.isAbsolute(relative);
            file = outside ? undefined : resolved;
        }
        const info: DocumentInfo = {
            name: entry.name,
            title: entry.title ?? (isUrl(entry.name) ? entry.name : path.basename(entry.name)),
            parent: parentOf(entry.parent),
            scope,
            location: local ? 'local' : 'web',
        };
        if (entry.category) { info.category = entry.category; }
        if (file) {
            info.path = file;
            info.format = merged.format ?? formatOf(file);
            if (!fs.existsSync(file)) {
                info.error = { kind: 'missing-file', detail: `${file} is not there`, at: this.now().toISOString() };
            }
        }
        if (file && merged.bytes === undefined && local) {
            try { info.bytes = fs.statSync(file).size; } catch { /* missing: said below */ }
        }
        for (const key of ['bytes', 'sha256', 'filename', 'version', 'versionLabel', 'alternatives', 'resolver', 'sourceTitle', 'downloadedAt', 'requested'] as const) {
            if (merged[key] !== undefined) {
                (info as unknown as Record<string, unknown>)[key] = merged[key];
            }
        }
        if (outside) {
            info.error = { kind: 'blocked', detail: `${entry.name} lies outside the project; it is not read` };
        }
        if (merged.error && !info.error) { info.error = merged.error; }
        return info;
    }

    async getDocuments(parent: DocParent, solution?: string): Promise<DocumentInfo[]> {
        const user = this.readUser();
        const found = user.docs.filter((entry) => sameParent(parentOf(entry.parent), parent)).map((entry) => this.info(entry, 'user'));
        if (solution) {
            this.watch(path.dirname(projectInventoryFile(solution)));
            const project = projectInventoryFile(solution);
            for (const entry of this.readProject(solution).docs.filter((e) => sameParent(parentOf(e.parent), parent))) {
                const state = user.projectState.find((s) => s.project === project && s.parent === entry.parent && s.name === entry.name);
                found.push(this.info(entry, 'project', solution, state));
            }
        }
        return found;
    }

    async getRequests(solution?: string): Promise<DocumentInfo[]> {
        const user = this.readUser();
        const open = user.docs.filter((entry) => entry.requested).map((entry) => this.info(entry, 'user'));
        if (solution) {
            const project = projectInventoryFile(solution);
            for (const entry of this.readProject(solution).docs) {
                const state = user.projectState.find((s) => s.project === project && s.parent === entry.parent && s.name === entry.name);
                if (state?.requested) {
                    open.push(this.info(entry, 'project', solution, state));
                }
            }
        }
        return open;
    }

    /** A folder of the store for one document's copy. */
    private copyDir(parent: DocParent, name: string, project?: string): string {
        const hash = crypto.createHash('sha1').update(`${project ?? ''}|${parentKey(parent)}|${name}`).digest('hex').slice(0, 16);
        return path.join(this.options.root, 'files', hash);
    }

    /** Copy `file` into `dir`, replacing what was there. */
    private copyInto(file: string, dir: string): { path: string; bytes: number; sha256: string; filename: string } {
        const st = fs.statSync(file);
        if (!st.isFile()) {
            throw new DocumentFailure({ kind: 'missing-file', detail: `${file} is not a file` });
        }
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, path.basename(file));
        fs.copyFileSync(file, dest);
        // The modification time travels with the copy, so an index built from the original stays current.
        fs.utimesSync(dest, st.atime, st.mtime);
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
        return { path: dest, bytes: st.size, sha256, filename: path.basename(file) };
    }

    async addDocument(parent: DocParent, source: string, meta: { title?: string; category?: string; scope?: DocScope; solution?: string; versionLabel?: string } = {}): Promise<DocumentInfo> {
        const scope = meta.scope ?? 'user';
        const key = parentKey(parent);
        if (scope === 'project') {
            if (!meta.solution) {
                throw new Error('a project document needs the csolution');
            }
            const solution = meta.solution;
            const base = path.dirname(solution);
            let name = source;
            if (!isUrl(source)) {
                const relative = path.relative(base, path.resolve(source));
                if (relative.startsWith('..') || path.isAbsolute(relative)) {
                    throw new Error(`${source} lies outside the project ${base}; copy it into the project first, or add it for this user`);
                }
                name = relative.split(path.sep).join('/');
            }
            await this.locked(projectInventoryFile(solution), () => {
                const project = this.readProject(solution);
                const existing = project.docs.find((entry) => same(entry, parent, name));
                if (existing) {
                    existing.title = meta.title ?? existing.title;
                    existing.category = meta.category ?? existing.category;
                } else {
                    project.docs.push({ parent: key, name, ...(meta.title ? { title: meta.title } : {}), ...(meta.category ? { category: meta.category } : {}) });
                }
                this.saveProject(solution, project);
            });
            return (await this.getDocuments(parent, solution)).find((doc) => doc.scope === 'project' && doc.name === name)!;
        }
        const name = isUrl(source) ? source : path.resolve(source);
        await this.locked(this.inventoryFile, () => {
            const user = this.readUser();
            let entry = user.docs.find((e) => same(e, parent, name));
            if (!entry) {
                entry = { parent: key, name, location: isUrl(source) ? 'web' : 'local' };
                user.docs.push(entry);
            }
            if (meta.title) { entry.title = meta.title; }
            if (meta.category) { entry.category = meta.category; }
            if (meta.versionLabel) { entry.versionLabel = meta.versionLabel; }
            if (!isUrl(source)) {
                Object.assign(entry, this.copyInto(name, this.copyDir(parent, name)), { format: formatOf(name) });
            }
            this.saveUser(user);
        });
        return (await this.getDocuments(parent)).find((doc) => doc.scope === 'user' && doc.name === name)!;
    }

    /** Change the user entry, or this machine's state of the project entry, of one document. */
    private async update(parent: DocParent, name: string, solution: string | undefined, change: (entry: Entry) => void): Promise<DocumentInfo> {
        const key = parentKey(parent);
        const inProject = solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name));
        await this.locked(this.inventoryFile, () => {
            const user = this.readUser();
            let entry: Entry | undefined;
            if (inProject) {
                const project = projectInventoryFile(solution!);
                entry = user.projectState.find((s) => s.project === project && same(s, parent, name));
                if (!entry) {
                    const state: ProjectState = { project, parent: key, name };
                    user.projectState.push(state);
                    entry = state;
                }
            } else {
                entry = user.docs.find((e) => same(e, parent, name));
                if (!entry) {
                    throw new Error(`no document ${name} for ${key}`);
                }
            }
            change(entry);
            this.saveUser(user);
        });
        return (await this.getDocuments(parent, inProject ? solution : undefined)).find((doc) => doc.name === name && doc.scope === (inProject ? 'project' : 'user'))!;
    }

    async downloadDocument(parent: DocParent, name: string, options: DownloadOptions = {}, solution?: string): Promise<DocumentInfo> {
        if (!isUrl(name)) {
            throw new DocumentFailure({ kind: 'unknown', detail: `${name} is a local document; there is nothing to download` });
        }
        const project = solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name))
            ? projectInventoryFile(solution) : undefined;
        const dir = this.copyDir(parent, name, project);
        let copy: DownloadedCopy;
        try {
            fs.mkdirSync(dir, { recursive: true });
            copy = await this.options.engine.download(name, dir, options);
        } catch (caught) {
            const error: DocumentError = caught instanceof DocumentFailure
                ? { ...caught.error, at: caught.error.at ?? this.now().toISOString() }
                : { kind: classifyFailure(caught instanceof Error ? caught.message : String(caught)), detail: caught instanceof Error ? caught.message : String(caught), at: this.now().toISOString() };
            if (error.kind === 'login-required' && !error.url) { error.url = name; }
            await this.update(parent, name, solution, (entry) => { entry.error = error; });
            throw new DocumentFailure(error);
        }
        return this.update(parent, name, solution, (entry) => {
            Object.assign(entry, {
                path: copy.path, bytes: copy.bytes, sha256: copy.sha256, format: 'pdf', resolver: copy.resolver, downloadedAt: this.now().toISOString(),
                ...(copy.filename ? { filename: copy.filename } : {}),
                ...(copy.version ? { version: copy.version } : {}),
                ...(copy.versionLabel ? { versionLabel: copy.versionLabel } : {}),
                ...(copy.alternatives?.length ? { alternatives: copy.alternatives } : {}),
            });
            if (copy.title) {
                entry.sourceTitle = copy.title;
                if (!entry.title) { entry.title = copy.title; }
            }
            delete entry.error;
            delete entry.requested;
        });
    }

    async importDocument(parent: DocParent, name: string, localPath: string, solution?: string,
        facts: { version?: string; versionLabel?: string; sourceTitle?: string; resolver?: string; filename?: string } = {}): Promise<DocumentInfo> {
        const project = solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name))
            ? projectInventoryFile(solution) : undefined;
        const copy = this.copyInto(localPath, this.copyDir(parent, name, project));
        return this.update(parent, name, solution, (entry) => {
            Object.assign(entry, copy, { format: formatOf(localPath), downloadedAt: this.now().toISOString() },
                Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)));
            delete entry.error;
            delete entry.requested;
        });
    }

    async removeDocument(parent: DocParent, name: string, solution?: string): Promise<boolean> {
        const key = parentKey(parent);
        let removed = false;
        if (solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name))) {
            await this.locked(projectInventoryFile(solution), () => {
                const project = this.readProject(solution);
                project.docs = project.docs.filter((e) => !same(e, parent, name));
                this.saveProject(solution, project);
            });
            removed = true;
        }
        await this.locked(this.inventoryFile, () => {
            const user = this.readUser();
            const before = user.docs.length + user.projectState.length;
            const project = solution ? projectInventoryFile(solution) : undefined;
            user.docs = user.docs.filter((e) => removed || !same(e, parent, name));
            user.projectState = user.projectState.filter((s) => !(s.project === project && same(s, parent, name)));
            if (user.docs.length + user.projectState.length !== before) {
                removed = true;
            }
            this.saveUser(user);
        });
        // The copy goes too; the user's own file in the project is never deleted.
        fs.rmSync(this.copyDir(parent, name, solution && removed ? projectInventoryFile(solution) : undefined), { recursive: true, force: true });
        fs.rmSync(this.copyDir(parent, name), { recursive: true, force: true });
        return removed;
    }

    async requestDocument(parent: DocParent, name: string, request: { by: 'agent' | 'user'; reason: string; error?: DocumentError; title?: string }, solution?: string): Promise<void> {
        const key = parentKey(parent);
        const known = (solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name)))
            || this.readUser().docs.some((e) => same(e, parent, name));
        if (!known) {
            // A document the service did not list yet (a pack's web book the agent wanted): it becomes a reference.
            await this.addDocument(parent, name, { ...(request.title ? { title: request.title } : {}) });
        }
        await this.update(parent, name, solution, (entry) => {
            entry.requested = { by: request.by, reason: request.reason, at: this.now().toISOString() };
            if (request.error) { entry.error = request.error; }
        });
    }

    async clearRequest(parent: DocParent, name: string, solution?: string): Promise<void> {
        try {
            await this.update(parent, name, solution, (entry) => { delete entry.requested; });
        } catch {
            // Nothing to clear.
        }
    }
}
