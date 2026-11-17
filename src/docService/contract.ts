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
 * The document service this extension asks CMSIS Solution to provide in its
 * API (2.9.2 proposal, gaps G1a, G1b, G2, G3, G5, G7, G8, G10): the
 * logistics of a target's documents — which documents belong to a device, a
 * board, a core, a pack, a vendor, every target or one project; where their
 * files are; downloads and imports; and the agent's requests that the user
 * resolves. Indexing, search and citations are not part of it: they stay in
 * the CMSIS Developer Assistant.
 *
 * This file is the hand-over. `src/docService/emulator.ts` implements it
 * inside this extension until CMSIS Solution does; the consumer
 * (`src/core/packDocs/documentApi.ts`) uses only these types, so the
 * emulator and CMSIS Solution's implementation are interchangeable.
 *
 * No imports: the contract stands on its own.
 */

/** The version of this contract. */
export const DOCUMENT_SERVICE_VERSION = '1.0.0';

/**
 * What a document belongs to. `device` and `board` are keys as CMSIS
 * Solution names them (`Vendor::Name`, `Vendor::Name[:Revision]`); `core`
 * is a Dcore (`Cortex-M33`); `pack` is `Vendor::Name` (any version);
 * `vendor` a pack vendor; `all` every target (G2).
 */
export type DocParent =
    | { device: string }
    | { board: string }
    | { core: string }
    | { pack: string }
    | { vendor: string }
    | { all: true };

/**
 * Where a document's entry is kept: `user`, for this user on this machine
 * (the home inventory); `project`, in the project, next to its csolution
 * (`.cmsis/docs.yml`), shared with everyone who has the project (G3).
 */
export type DocScope = 'user' | 'project';

/** Why a download failed, in a form that says what to do (G8). */
export type DocumentFailureKind =
    | 'login-required'
    | 'not-pdf'
    | 'html'
    | 'http'
    | 'network'
    | 'blocked'
    | 'too-large'
    | 'timeout'
    | 'cancelled'
    | 'missing-file'
    | 'unknown';

/** A failure, as a rejection carries it and a document records it. */
export interface DocumentError {
    kind: DocumentFailureKind;
    /** Words for the user, e.g. "HTTP 403 text/html". */
    detail?: string;
    /** The page the user opens to resolve it (a login wall). */
    url?: string;
    /** When it happened, ISO 8601. */
    at?: string;
}

/** The agent's (or a user's) open request for a document that has no local copy (G10). */
export interface DocumentRequest {
    by: 'agent' | 'user';
    reason: string;
    at: string;
}

/** One document of the service. */
export interface DocumentInfo {
    /** The identity within its parent: a URL, or a path (absolute, or relative to the project for `project` scope). */
    name: string;
    title: string;
    category?: string;
    parent: DocParent;
    scope: DocScope;
    /** `web`: a URL, `local`: a file the user added or imported. */
    location: 'web' | 'local';
    /** The local copy: a download, an import, or the added file itself. */
    path?: string;
    /** Facts of the copy, when there is one. */
    format?: 'pdf' | 'md' | 'txt' | 'other';
    bytes?: number;
    sha256?: string;
    filename?: string;
    /** An Arm document's resolved version and its label (`B.z`), for citations. */
    version?: string;
    versionLabel?: string;
    /** Other editions the source offers (an errata edition lists them). */
    alternatives?: { version: string; versionLabel: string }[];
    /** The title the source gave when it was downloaded (arm.com's title of an Arm document). */
    sourceTitle?: string;
    /** The source that resolved it (`arm.com`, `direct`). */
    resolver?: string;
    downloadedAt?: string;
    requested?: DocumentRequest;
    error?: DocumentError;
}

/** What a download may spend and report (G7). */
export interface DownloadOptions {
    timeoutMs?: number;
    maxBytes?: number;
    onProgress?: (bytes: number, total: number | undefined) => void;
    signal?: AbortSignal;
}

/** A rejection of the service that names its failure. */
export class DocumentFailure extends Error {
    constructor(readonly error: DocumentError) {
        super(error.detail ? `${error.kind}: ${error.detail}` : error.kind);
    }
}

/** A subscription; `dispose` ends it. */
export interface DocDisposable {
    dispose(): void;
}

/** The service. Every method is asynchronous and safe to call from several windows (G1b). */
export interface DocumentService {
    readonly version: string;
    /** The documents of one parent: its user entries, and the project's when `solution` is given. */
    getDocuments(parent: DocParent, solution?: string): Promise<DocumentInfo[]>;
    /**
     * Add a document: a URL (a reference, downloaded on demand) or a local
     * file (copied into the service's store for `user`; referenced by its
     * path for `project`, which must lie inside the project). Adding what is
     * there already updates its title and category and keeps its copy and
     * state: callers may add before every download.
     */
    addDocument(parent: DocParent, source: string, meta?: { title?: string; category?: string; scope?: DocScope; solution?: string; versionLabel?: string }): Promise<DocumentInfo>;
    /** Download a web document; resolves with its copy, rejects with a `DocumentFailure` (recorded on the document). */
    downloadDocument(parent: DocParent, name: string, options?: DownloadOptions, solution?: string): Promise<DocumentInfo>;
    /**
     * Give a document a copy from a file the user downloaded by hand; clears
     * its error and request. `facts` are what is known of that copy (an Arm
     * document's version and label, the source's title).
     */
    importDocument(parent: DocParent, name: string, localPath: string, solution?: string,
        facts?: { version?: string; versionLabel?: string; sourceTitle?: string; resolver?: string; filename?: string }): Promise<DocumentInfo>;
    /** Remove a document the user added, with the copy the service holds; documents of packs cannot be removed. */
    removeDocument(parent: DocParent, name: string, solution?: string): Promise<boolean>;
    /**
     * Record that the agent needs this document; the view shows it until a
     * copy exists or `clearRequest`. A document the service does not list
     * yet (a pack's web book) is added as a reference, with `title`.
     */
    requestDocument(parent: DocParent, name: string, request: { by: 'agent' | 'user'; reason: string; error?: DocumentError; title?: string }, solution?: string): Promise<void>;
    clearRequest(parent: DocParent, name: string, solution?: string): Promise<void>;
    /** Every document with an open request, for the badge (G10). */
    getRequests(solution?: string): Promise<DocumentInfo[]>;
    /** Fires after any change, also one made by another window or by hand (G1a). */
    onDidChangeDocuments(listener: () => void): DocDisposable;
}

/** The key of a parent as text: `device:ST::STM32U585AIIx`, `all`. */
export function parentKey(parent: DocParent): string {
    if ('all' in parent) {
        return 'all';
    }
    const [kind, value] = Object.entries(parent)[0] as [string, string];
    return `${kind}:${value}`;
}

/**
 * Whether two parents are the same. Keys compare without regard to case. A
 * device or board key counts without its vendor when one side has none, and
 * a board without its revision when one side has none, as CMSIS Solution
 * keys them (`Vendor::Name[:Revision]`).
 */
export function sameParent(a: DocParent, b: DocParent): boolean {
    const kindA = 'all' in a ? 'all' : Object.keys(a)[0];
    const kindB = 'all' in b ? 'all' : Object.keys(b)[0];
    if (kindA !== kindB) {
        return false;
    }
    if (kindA !== 'device' && kindA !== 'board') {
        return parentKey(a).toLowerCase() === parentKey(b).toLowerCase();
    }
    const split = (key: string): { vendor?: string; name: string; revision?: string } => {
        const at = key.indexOf('::');
        const vendor = at >= 0 ? key.slice(0, at).trim().toLowerCase() : undefined;
        const rest = at >= 0 ? key.slice(at + 2) : key;
        const colon = kindA === 'board' ? rest.indexOf(':') : -1;
        return colon >= 0 ? { vendor, name: rest.slice(0, colon).trim().toLowerCase(), revision: rest.slice(colon + 1).trim().toLowerCase() || undefined }
            : { vendor, name: rest.trim().toLowerCase() };
    };
    const x = split(parentKey(a).slice(kindA.length + 1));
    const y = split(parentKey(b).slice(kindB.length + 1));
    return x.name === y.name && (!x.vendor || !y.vendor || x.vendor === y.vendor) && (!x.revision || !y.revision || x.revision === y.revision);
}
