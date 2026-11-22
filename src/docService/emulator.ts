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
 * Storage: an injected root, which the extension sets to `~/.cmsis/`, the
 * folder of CMSIS Solution's document manager. The service shares that
 * inventory and its folder of copies instead of keeping a second store:
 *   <root>/docs.yml          the user inventory, in CMSIS Solution's layout
 *                            (`docs:` with `commons`, `devices`, `boards`,
 *                            and for G2 `cores`, `packs`, `vendors`; `all`
 *                            is the common `all`, an Arm document lies in
 *                            the common `arm-docs`). Only the fields CMSIS
 *                            Solution knows are written: `name`, `title`,
 *                            `category`, `path`, `mode: user`, and, while
 *                            a request is open, `error` as one line of
 *                            text. Everything else in the file is kept as
 *                            it was read.
 *   <root>/docs.xtra.yml     what `docs.yml` has no field for: the facts of
 *                            a copy (size, sha256, edition, source), the
 *                            typed failure, the request, and this machine's
 *                            state of project entries, which never goes
 *                            into a project. It survives when CMSIS Solution
 *                            renews a device's or board's entries for a new
 *                            pack version, and gives a copy back its `path`.
 *   <root>/docs/...          copies, where CMSIS Solution puts them:
 *                            `<Vendor>/<Name>/<document>/<file>` for a
 *                            device or board, `<id>-<version>/` for an Arm
 *                            document; `cores/`, `packs/`, `vendors/`, `all/`
 *                            and `projects/` for what it has no place for.
 * Of `docs.yml` the service's documents are those the user added
 * (`mode: user`), those it has state for, and those with a copy under
 * `<root>/docs/`; a pack's book that nobody fetched stays CMSIS Solution's.
 *
 * A project's entries live in `<csolution folder>/.cmsis/docs.yml`, in the
 * same layout, and hold only what can be shared: names (paths relative to
 * the csolution folder, or URLs), titles, categories. Keys the service does
 * not know are kept when it writes. A path that leaves the project is not
 * read; a file of another layout is never written.
 *
 * Several VS Code windows share the root: every change takes a lock file,
 * reads the inventory again, applies the change and writes a temporary file
 * renamed over the old one. CMSIS Solution takes no lock, so a change is
 * applied again, once, when `docs.yml` changed between the read and the
 * write or was overwritten right after it. The watcher reports changes by
 * other windows, by CMSIS Solution or by hand (G1a). Downloads go through an
 * injected engine, which brings the host's guards (private hosts, size cap)
 * and resolvers.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FAILSAFE_SCHEMA, dump, load, nullCoreTag } from 'js-yaml';
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
    /** `user`: the user, or this service, added the document; a pack's book has none (`docs.yml`). */
    mode?: string;
    /** The text this service put into the entry's `error` of `docs.yml`, to take back exactly that. */
    shown?: string;
    /** Keys of a project entry the service does not know, kept when it writes. */
    extra?: Record<string, unknown>;
}

/** This machine's state of one project entry. */
interface ProjectState extends Entry {
    project: string;
}

/** A YAML map as parsed. */
type Raw = Record<string, unknown>;

/** The lists of `docs.yml` and the key that names an item's parent. */
type MainKind = 'common' | 'device' | 'board' | 'core' | 'pack' | 'vendor';

/** Where a document lies in `docs.yml`: its parent item's kind and key, and its own map. */
interface MainPlace {
    kind: MainKind;
    key: string;
    raw: Raw;
}

interface UserInventory {
    version: string;
    /** The service's documents of `docs.yml`, each with its state of `docs.xtra.yml`. */
    docs: Entry[];
    projectState: ProjectState[];
    /** `docs.yml` as parsed; changed in place and written back, so what the service does not know stays. */
    main: Raw;
    /** Its text when read: a change by another writer shows as a difference. */
    mainText: string | undefined;
    /** Its content when read: a change by this service shows as a difference. */
    mainJson: string;
    /** State of documents `docs.yml` does not list now, kept while it names a copy or a request. */
    orphans: Entry[];
}

const MAIN_LISTS: readonly { list: string; kind: MainKind }[] = [
    { list: 'commons', kind: 'common' }, { list: 'devices', kind: 'device' }, { list: 'boards', kind: 'board' },
    { list: 'cores', kind: 'core' }, { list: 'packs', kind: 'pack' }, { list: 'vendors', kind: 'vendor' },
];
/** The common that holds CMSIS Solution's Arm catalogue, and the one for documents of every target. */
const ARM_COMMON = 'arm-docs';
const ALL_COMMON = 'all';
/** An Arm document's name in the inventory: its id and version. */
const ARM_DOC_URL = /^https?:\/\/developer\.arm\.com\/documentation\/([a-z]{3}\d{4}|\d{6,7})\/([a-z0-9._-]+)\/?$/i;
/** `docs.yml` is read with every scalar as text, as CMSIS Solution reads it: `version: 0100` stays `0100`. */
const MAIN_SCHEMA = FAILSAFE_SCHEMA.withTags(nullCoreTag);
/** What CMSIS Solution writes for a copy that is gone; the service reports that itself. */
const FILE_NOT_EXISTS = 'File not exists';
/** The facts of a copy, which hold only for the file they were taken from. */
const COPY_FACTS = ['format', 'bytes', 'sha256', 'filename', 'version', 'versionLabel', 'alternatives', 'resolver', 'sourceTitle', 'downloadedAt'] as const;

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

/** A non-empty text, else undefined. */
function textOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A folder or file name every file system takes: what CMSIS Solution refuses in a name is replaced. */
function component(value: string | undefined, fallback: string): string {
    const clean = [...(value ?? '')].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch)).join('').replace(/[. ]+$/, '');
    return clean.length > 0 && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? clean : fallback;
}

/** `Vendor::Name[:Revision]` as CMSIS Solution splits it for its folders: the revision does not count. */
function vendorAndName(key: string): { vendor?: string; name: string } {
    const match = /^(?:([^:]*)::)?([^:]*)(?::(.*))?$/.exec(key);
    return match ? { ...(match[1] ? { vendor: match[1] } : {}), name: match[2] } : { name: key };
}

/** The folder of a document's copy: the name of its URL or file without the extension, as CMSIS Solution derives it. */
function documentBase(name: string): string {
    if (isUrl(name)) {
        try {
            return component(path.posix.parse(new URL(name).pathname).name, 'index');
        } catch {
            return 'index';
        }
    }
    return component(path.parse(name).name, 'document');
}

/** The file name CMSIS Solution gives the copy of a web document whose URL names a file; undefined for a page or a local file. */
function webFileName(name: string): string | undefined {
    if (!isUrl(name)) {
        return undefined;
    }
    try {
        const pathname = new URL(name).pathname;
        const ext = path.posix.extname(pathname).toLowerCase();
        if (pathname.endsWith('/') || ext.length < 2 || ext === '.html' || ext === '.htm') {
            return undefined;
        }
        const file = decodeURIComponent(path.posix.basename(pathname));
        return component(file, '') === file ? file : undefined;
    } catch {
        return undefined;
    }
}

/** Every document of `docs.yml`, with the item it hangs off. */
function* mainRows(main: Raw): Generator<MainPlace> {
    const docs = main.docs;
    if (typeof docs !== 'object' || docs === null || Array.isArray(docs)) {
        return;
    }
    for (const { list, kind } of MAIN_LISTS) {
        const items = (docs as Raw)[list];
        for (const item of Array.isArray(items) ? items as unknown[] : []) {
            const owner = typeof item === 'object' && item !== null && !Array.isArray(item) ? item as Raw : undefined;
            const key = textOf(owner?.[kind]);
            if (owner === undefined || key === undefined) {
                continue;
            }
            for (const doc of Array.isArray(owner.docs) ? owner.docs as unknown[] : []) {
                if (typeof doc === 'object' && doc !== null && !Array.isArray(doc) && textOf((doc as Raw).name) !== undefined) {
                    yield { kind, key, raw: doc as Raw };
                }
            }
        }
    }
}

/** The contract's parent key of a place; undefined for a common the service does not use. */
function parentOfPlace(place: MainPlace): string | undefined {
    if (place.kind === 'common') {
        return place.key === ARM_COMMON || place.key === ALL_COMMON ? 'all' : undefined;
    }
    return `${place.kind}:${place.key}`;
}

/** The emulated service. */
export class EmulatedDocumentService implements DocumentService {
    readonly version = DOCUMENT_SERVICE_VERSION;
    private readonly listeners = new Set<() => void>();
    private readonly watchers = new Map<string, fs.FSWatcher>();
    /** Where each document read from `docs.yml` lies in it. */
    private readonly places = new WeakMap<Entry, MainPlace>();
    private changeTimer: NodeJS.Timeout | undefined;
    private readonly now: () => Date;

    constructor(private readonly options: EmulatorOptions) {
        this.now = options.now ?? (() => new Date());
        fs.mkdirSync(options.root, { recursive: true });
        this.watch(options.root);
    }

    /** The user inventory file: `docs.yml` of the root, which CMSIS Solution's document manager reads and writes too. */
    get inventoryFile(): string {
        return path.join(this.options.root, 'docs.yml');
    }

    /** The state `docs.yml` has no field for, beside it. */
    get stateFile(): string {
        return path.join(this.options.root, 'docs.xtra.yml');
    }

    /** The folder of the copies. */
    get copiesDir(): string {
        return path.join(this.options.root, 'docs');
    }

    /** Whether `file` lies under the folder of the copies. */
    private managed(file: string): boolean {
        const relative = path.relative(this.copiesDir, path.resolve(file));
        return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
    }

    // ── reading and writing ──

    private readText(file: string): string | undefined {
        try {
            return fs.readFileSync(file, 'utf-8');
        } catch {
            return undefined;
        }
    }

    /** `docs.yml` as a map; a file that is not an inventory is refused, never rewritten. */
    private parseMain(text: string | undefined): Raw {
        if (text === undefined || text.trim().length === 0) {
            return {};
        }
        let data: unknown;
        try {
            data = load(text, { schema: MAIN_SCHEMA });
        } catch (caught) {
            throw new Error(`${this.inventoryFile} is not valid YAML (${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)})`);
        }
        if (data === null || data === undefined) {
            return {};
        }
        const docs = (data as Raw).docs;
        if (typeof data !== 'object' || Array.isArray(data) || (docs !== undefined && docs !== null && (typeof docs !== 'object' || Array.isArray(docs)))) {
            throw new Error(`${this.inventoryFile} is not a document inventory (docs: must be a map of commons, devices, boards, ...)`);
        }
        return data as Raw;
    }

    /** Whether the file still has the size its facts were taken at; a file that cannot be read keeps them. */
    private sameSize(file: string, bytes: number | undefined): boolean {
        if (bytes === undefined) {
            return true;
        }
        try {
            return fs.statSync(file).size === bytes;
        } catch {
            return true;
        }
    }

    /** One document of `docs.yml` with the state kept for it. */
    private joined(place: MainPlace, parent: string, state: Entry | undefined): Entry {
        const raw = place.raw;
        const entry: Entry = { parent, name: String(raw.name) };
        const title = textOf(raw.title);
        const category = textOf(raw.category);
        const copy = textOf(raw.path);
        if (title) { entry.title = title; }
        if (category) { entry.category = category; }
        if (raw.mode === 'user') { entry.mode = 'user'; }
        // The copy the state describes: the one docs.yml names, or the one it lost when CMSIS Solution renewed the entry.
        let own = false;
        if (copy) {
            entry.path = copy;
            own = state?.path !== undefined && path.resolve(state.path) === path.resolve(copy);
        } else if (state?.path && fs.existsSync(state.path)) {
            entry.path = state.path;
            own = true;
        }
        if (state) {
            if (state.path === undefined || (own && this.sameSize(entry.path!, state.bytes))) {
                for (const key of COPY_FACTS) {
                    if (state[key] !== undefined) {
                        (entry as unknown as Raw)[key] = state[key];
                    }
                }
            }
            // A copy somebody else made (Download or Import in the CMSIS view) answers the request and the failure.
            const answered = !own && entry.path !== undefined && fs.existsSync(entry.path);
            if (!answered) {
                if (state.requested) { entry.requested = state.requested; }
                if (state.error) { entry.error = state.error; }
            }
            if (state.shown) { entry.shown = state.shown; }
        }
        this.places.set(entry, place);
        return entry;
    }

    private readUser(): UserInventory {
        const mainText = this.readText(this.inventoryFile);
        const main = this.parseMain(mainText);
        const state = this.readYaml(this.stateFile) as { docs?: unknown; projectState?: unknown } | undefined;
        const states = asEntries(state?.docs);
        const used = new Set<Entry>();
        const docs: Entry[] = [];
        for (const place of mainRows(main)) {
            const parent = parentOfPlace(place);
            if (parent === undefined) {
                continue;
            }
            const name = String(place.raw.name);
            const known = states.find((s) => !used.has(s) && s.name === name && s.parent.toLowerCase() === parent.toLowerCase());
            const copy = textOf(place.raw.path);
            // The service's documents: added by the user, known to its state, or with a copy in its folder.
            if (known === undefined && place.raw.mode !== 'user' && !(copy !== undefined && this.managed(copy))) {
                continue;
            }
            if (known) { used.add(known); }
            docs.push(this.joined(place, parent, known));
        }
        return {
            version: DOCUMENT_SERVICE_VERSION,
            docs,
            projectState: asEntries(state?.projectState).filter((entry) => typeof (entry as ProjectState).project === 'string') as ProjectState[],
            main,
            mainText,
            mainJson: JSON.stringify(main),
            orphans: states.filter((s) => !used.has(s)),
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

    private writeText(file: string, text: string): void {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(temporary, text, 'utf-8');
        fs.renameSync(temporary, file);
    }

    private writeYaml(file: string, data: unknown, header: string): void {
        this.writeText(file, `${header}\n${dump(data, { lineWidth: 160, noRefs: true })}`);
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

    /**
     * Read the user inventory, apply `change`, write it; under the lock.
     * CMSIS Solution writes `docs.yml` without the lock, so the change is
     * applied once more to what it wrote when it came in between.
     */
    private async changeUser<T>(change: (user: UserInventory) => T): Promise<T> {
        return this.locked(this.inventoryFile, () => {
            for (let attempt = 0; ; attempt++) {
                const user = this.readUser();
                const result = change(user);
                if (this.saveUser(user, attempt === 0)) {
                    return result;
                }
            }
        });
    }

    /** The place of a document in `docs.yml`: the entry that is there (a pack's book the service takes up), else a new one. */
    private placeFor(main: Raw, entry: Entry): MainPlace {
        const arm = entry.parent === 'all' ? ARM_DOC_URL.exec(entry.name) : null;
        const at = entry.parent.indexOf(':');
        const kind: MainKind = entry.parent === 'all' ? 'common' : entry.parent.slice(0, at) as MainKind;
        const key = entry.parent === 'all' ? (arm ? ARM_COMMON : ALL_COMMON) : entry.parent.slice(at + 1);
        const list = MAIN_LISTS.find((item) => item.kind === kind)?.list;
        if (list === undefined) {
            throw new Error(`unknown parent '${entry.parent}'`);
        }
        if (typeof main.docs !== 'object' || main.docs === null || Array.isArray(main.docs)) {
            main.docs = {};
        }
        const docs = main.docs as Raw;
        if (!Array.isArray(docs[list])) {
            docs[list] = [];
        }
        const items = docs[list] as Raw[];
        let owner = items.find((item) => typeof item === 'object' && item !== null && textOf(item[kind])?.toLowerCase() === key.toLowerCase());
        if (owner === undefined) {
            owner = { [kind]: key, docs: [] };
            items.push(owner);
        }
        if (!Array.isArray(owner.docs)) {
            owner.docs = [];
        }
        const rows = owner.docs as Raw[];
        let raw = rows.find((row) => typeof row === 'object' && row !== null && row.name === entry.name);
        if (raw === undefined) {
            raw = { name: entry.name };
            if (arm) {
                // As CMSIS Solution's catalogue entries: it downloads and lists by these.
                Object.assign(raw, { id: arm[1].toLowerCase(), version: arm[2].toLowerCase(), format: 'pdf' });
            } else {
                // Only a user document outlives the renewal of a device's or board's entries for a new pack version.
                raw.mode = 'user';
            }
            rows.push(raw);
        }
        if (raw.mode === 'user') {
            entry.mode = 'user';
        } else {
            delete entry.mode;
        }
        return { kind, key: textOf(owner[kind]) ?? key, raw };
    }

    /** Write what `docs.yml` has a field for into the entry's place. */
    private settle(main: Raw, entry: Entry): void {
        let place = this.places.get(entry);
        if (place === undefined) {
            place = this.placeFor(main, entry);
            this.places.set(entry, place);
        }
        const raw = place.raw;
        if (entry.title !== undefined && entry.title !== raw.title) { raw.title = entry.title; }
        if (entry.category !== undefined && entry.category !== raw.category) { raw.category = entry.category; }
        if (entry.path !== textOf(raw.path)) {
            if (entry.path) {
                raw.path = entry.path;
                // As CMSIS Solution does when it sets a path: a copy ends the failure it showed.
                delete raw.error;
            } else {
                delete raw.path;
            }
        }
        // An open request, as the one line CMSIS Solution shows on the document. A failure nobody has to act on (a cancel,
        // a limit, an HTML-only document) is no badge in its view: it stays in the state file.
        const line = (entry.requested?.reason ?? '').replace(/\s+/g, ' ').trim();
        if (line.length > 0) {
            if (raw.error !== line) { raw.error = line; }
            entry.shown = line;
        } else if (entry.shown !== undefined) {
            if (raw.error === entry.shown) { delete raw.error; }
            delete entry.shown;
        }
    }

    /** Take a removed document out of `docs.yml`: a user document goes, a pack's book only loses the service's copy and line. */
    private withdraw(main: Raw, entry: Entry): void {
        const place = this.places.get(entry);
        if (place === undefined) {
            return;
        }
        const raw = place.raw;
        if (raw.mode !== 'user') {
            const copy = textOf(raw.path);
            if (copy !== undefined && this.managed(copy)) { delete raw.path; }
            if (entry.shown !== undefined && raw.error === entry.shown) { delete raw.error; }
            return;
        }
        const docs = main.docs as Raw;
        const list = MAIN_LISTS.find((item) => item.kind === place.kind)!.list;
        const items = Array.isArray(docs?.[list]) ? docs[list] as Raw[] : [];
        for (const owner of items) {
            const rows = Array.isArray(owner?.docs) ? owner.docs as Raw[] : [];
            const at = rows.indexOf(raw);
            if (at < 0) {
                continue;
            }
            rows.splice(at, 1);
            // An item this service made for the document goes with its last one; CMSIS Solution's items carry more keys.
            if (rows.length === 0 && Object.keys(owner).every((key) => key === place.kind || key === 'docs')) {
                items.splice(items.indexOf(owner), 1);
            }
            return;
        }
    }

    /**
     * Write the inventory: `docs.yml` only when one of its fields changed,
     * then the state file. With `careful`, false when another writer changed
     * `docs.yml` since it was read, or right after the write: the caller
     * reads again and applies its change to that.
     */
    private saveUser(user: UserInventory, careful: boolean): boolean {
        for (const entry of user.docs) {
            this.settle(user.main, entry);
        }
        if (JSON.stringify(user.main) !== user.mainJson) {
            if (careful && this.readText(this.inventoryFile) !== user.mainText) {
                return false;
            }
            const text = dump(user.main, { schema: MAIN_SCHEMA, lineWidth: -1, noRefs: true });
            this.writeText(this.inventoryFile, text);
            if (careful && this.readText(this.inventoryFile) !== text) {
                return false;
            }
        }
        const rows: Raw[] = [];
        for (const entry of user.docs) {
            const row: Raw = {};
            if (entry.path && (entry.bytes !== undefined || entry.sha256 !== undefined || entry.downloadedAt !== undefined)) {
                row.path = entry.path;
            }
            for (const key of [...COPY_FACTS, 'requested', 'error', 'shown'] as const) {
                if (entry[key] !== undefined) {
                    row[key] = entry[key];
                }
            }
            // A pack's book the service took up has no mark in docs.yml: its row here is the mark, until it has a copy.
            if (Object.keys(row).length > 0 || (entry.mode !== 'user' && !(entry.path && this.managed(entry.path)))) {
                rows.push({ parent: entry.parent, name: entry.name, ...row });
            }
        }
        // State of documents docs.yml does not list now: worth keeping while it names a copy or a request.
        rows.push(...user.orphans.filter((orphan) => orphan.requested !== undefined || (orphan.path !== undefined && fs.existsSync(orphan.path))) as unknown as Raw[]);
        if (rows.length > 0 || user.projectState.length > 0 || fs.existsSync(this.stateFile)) {
            const text = '# What the CMSIS Developer Assistant knows of the documents in docs.yml beyond its fields: the facts of a copy,\n'
                + '# the agent\'s requests, the reason of a failed download. Written by the extension.\n'
                + dump({ version: DOCUMENT_SERVICE_VERSION, docs: rows, projectState: user.projectState }, { lineWidth: 160, noRefs: true });
            if (this.readText(this.stateFile) !== text) {
                this.writeText(this.stateFile, text);
            }
        }
        return true;
    }

    private saveProject(solution: string, inventory: ProjectInventory): void {
        const file = projectInventoryFile(solution);
        if (path.resolve(file) === path.join(os.homedir(), '.cmsis', 'docs.yml') || path.resolve(file) === path.resolve(this.inventoryFile)) {
            throw new Error(`${file} is the user's inventory; a csolution in the home folder cannot keep project documents`);
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
                if (file && /(^|[/\\])docs(\.xtra)?\.yml$/.test(String(file))) {
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

    /** The folder of a project document's copy on this machine. */
    private projectCopyDir(parent: DocParent, name: string, project: string): string {
        const hash = crypto.createHash('sha1').update(`${project}|${parentKey(parent)}|${name}`).digest('hex').slice(0, 16);
        return path.join(this.copiesDir, 'projects', hash);
    }

    /** The folder that holds only this document's copy, when `file` lies in one; a folder shared with other files is none. */
    private ownFolder(user: UserInventory, name: string, file: string): string | undefined {
        const dir = path.dirname(path.resolve(file));
        if (!this.managed(file) || dir === path.resolve(this.copiesDir)) {
            return undefined;
        }
        const arm = ARM_DOC_URL.exec(name);
        const folder = path.basename(dir);
        const base = documentBase(name);
        if (folder !== base && !folder.startsWith(`${base}-`) && !(arm && folder === `${arm[1]}-${arm[2]}`.toLowerCase())) {
            return undefined;
        }
        for (const place of mainRows(user.main)) {
            const other = textOf(place.raw.path);
            if (other !== undefined && place.raw.name !== name && path.dirname(path.resolve(other)) === dir) {
                return undefined;
            }
        }
        return dir;
    }

    /**
     * The folder of one document's copy under `<root>/docs/`, where CMSIS
     * Solution puts it for a device, a board and an Arm document, and beside
     * those for the parents it has no place for.
     */
    private copyDir(user: UserInventory, parent: DocParent, name: string): string {
        const present = user.docs.find((entry) => same(entry, parent, name))?.path;
        const kept = present !== undefined ? this.ownFolder(user, name, present) : undefined;
        if (kept !== undefined) {
            return kept;
        }
        const arm = 'all' in parent ? ARM_DOC_URL.exec(name) : null;
        if (arm) {
            return path.join(this.copiesDir, component(`${arm[1]}-${arm[2]}`.toLowerCase(), 'arm'));
        }
        const [kind, value] = 'all' in parent ? ['all', ''] : Object.entries(parent)[0] as [string, string];
        const { vendor, name: item } = vendorAndName(value);
        const folder = kind === 'device' || kind === 'board' ? [vendor, item]
            : kind === 'pack' ? ['packs', vendor, item]
                : kind === 'core' ? ['cores', value]
                    : kind === 'vendor' ? ['vendors', value]
                        : ['all'];
        const dir = path.join(this.copiesDir, ...folder.filter((part): part is string => part !== undefined && part.length > 0).map((part) => component(part, '_')),
            documentBase(name));
        // Two documents of one parent can end in the same file name: the second gets a folder of its own.
        const mine = parentKey(parent).toLowerCase();
        for (const place of mainRows(user.main)) {
            const other = textOf(place.raw.path);
            if (other !== undefined && path.dirname(path.resolve(other)) === path.resolve(dir)
                && !(place.raw.name === name && (parentOfPlace(place) ?? '').toLowerCase() === mine)) {
                return `${dir}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)}`;
            }
        }
        return dir;
    }

    /** The file name CMSIS Solution expects for the copy of this document, so that both find the same file; undefined: as it comes. */
    private fileNameFor(parent: DocParent, name: string, file: string): string | undefined {
        const arm = 'all' in parent ? ARM_DOC_URL.exec(name) : null;
        return arm ? `${arm[1]}-${arm[2]}`.toLowerCase() + (path.extname(file) || '.pdf') : webFileName(name);
    }

    /** Copy `file` into `dir`, replacing what was there; `as` names the copy. */
    private copyInto(file: string, dir: string, as?: string): { path: string; bytes: number; sha256: string; filename: string } {
        const st = fs.statSync(file);
        if (!st.isFile()) {
            throw new DocumentFailure({ kind: 'missing-file', detail: `${file} is not a file` });
        }
        const dest = path.join(dir, as ?? path.basename(file));
        // A file that already lies in the folder (the copy itself, imported again) must not go with the folder.
        if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
        }
        if (path.resolve(dest) !== path.resolve(file)) {
            fs.copyFileSync(file, dest);
            // The modification time travels with the copy, so an index built from the original stays current.
            fs.utimesSync(dest, st.atime, st.mtime);
        }
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
        await this.changeUser((user) => {
            let entry = user.docs.find((e) => same(e, parent, name));
            if (!entry) {
                entry = { parent: key, name };
                user.docs.push(entry);
            }
            if (meta.title) { entry.title = meta.title; }
            if (meta.category) { entry.category = meta.category; }
            if (meta.versionLabel) { entry.versionLabel = meta.versionLabel; }
            if (!isUrl(source)) {
                Object.assign(entry, this.copyInto(name, this.copyDir(user, parent, name)), { format: formatOf(name) });
            }
        });
        return (await this.getDocuments(parent)).find((doc) => doc.scope === 'user' && doc.name === name)!;
    }

    /** Change the user entry, or this machine's state of the project entry, of one document. */
    private async update(parent: DocParent, name: string, solution: string | undefined, change: (entry: Entry) => void): Promise<DocumentInfo> {
        const key = parentKey(parent);
        const inProject = solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name));
        await this.changeUser((user) => {
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
        });
        return (await this.getDocuments(parent, inProject ? solution : undefined)).find((doc) => doc.name === name && doc.scope === (inProject ? 'project' : 'user'))!;
    }

    async downloadDocument(parent: DocParent, name: string, options: DownloadOptions = {}, solution?: string): Promise<DocumentInfo> {
        if (!isUrl(name)) {
            throw new DocumentFailure({ kind: 'unknown', detail: `${name} is a local document; there is nothing to download` });
        }
        const project = solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name))
            ? projectInventoryFile(solution) : undefined;
        const dir = project !== undefined ? this.projectCopyDir(parent, name, project) : this.copyDir(this.readUser(), parent, name);
        let copy: DownloadedCopy;
        try {
            fs.mkdirSync(dir, { recursive: true });
            copy = await this.options.engine.download(name, dir, options);
            const wanted = project === undefined ? this.fileNameFor(parent, name, copy.path) : undefined;
            if (wanted !== undefined && wanted !== path.basename(copy.path)) {
                const renamed = path.join(path.dirname(copy.path), wanted);
                fs.renameSync(copy.path, renamed);
                copy = { ...copy, path: renamed, filename: copy.filename ?? path.basename(copy.path) };
            }
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
        const copy = project !== undefined ? this.copyInto(localPath, this.projectCopyDir(parent, name, project))
            : this.copyInto(localPath, this.copyDir(this.readUser(), parent, name), this.fileNameFor(parent, name, localPath));
        return this.update(parent, name, solution, (entry) => {
            Object.assign(entry, copy, { format: formatOf(localPath), downloadedAt: this.now().toISOString() },
                Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined)));
            delete entry.error;
            delete entry.requested;
        });
    }

    async removeDocument(parent: DocParent, name: string, solution?: string): Promise<boolean> {
        let removed = false;
        if (solution !== undefined && this.readProject(solution).docs.some((e) => same(e, parent, name))) {
            await this.locked(projectInventoryFile(solution), () => {
                const project = this.readProject(solution);
                project.docs = project.docs.filter((e) => !same(e, parent, name));
                this.saveProject(solution, project);
            });
            removed = true;
        }
        const inProject = removed;
        // What to delete once the inventory is written: a folder that held only this copy, else the copy alone.
        const copies = new Map<string, boolean>();
        const dropped = await this.changeUser((user) => {
            const project = solution ? projectInventoryFile(solution) : undefined;
            const before = user.docs.length + user.orphans.length + user.projectState.length;
            if (!inProject) {
                for (const entry of user.docs.filter((e) => same(e, parent, name))) {
                    if (entry.path !== undefined && this.managed(entry.path)) {
                        const folder = this.ownFolder(user, entry.name, entry.path);
                        copies.set(folder ?? entry.path, folder !== undefined);
                    }
                    this.withdraw(user.main, entry);
                }
                user.docs = user.docs.filter((e) => !same(e, parent, name));
                user.orphans = user.orphans.filter((e) => !same(e, parent, name));
            }
            user.projectState = user.projectState.filter((s) => !(s.project === project && same(s, parent, name)));
            return user.docs.length + user.orphans.length + user.projectState.length !== before;
        });
        removed = removed || dropped;
        // The copy goes too; the user's own file in the project is never deleted.
        for (const [target, folder] of copies) {
            fs.rmSync(target, { recursive: folder, force: true });
        }
        if (solution !== undefined) {
            fs.rmSync(this.projectCopyDir(parent, name, projectInventoryFile(solution)), { recursive: true, force: true });
        }
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
