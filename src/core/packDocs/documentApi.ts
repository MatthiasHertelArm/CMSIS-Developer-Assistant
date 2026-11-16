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
 * The document methods this extension asks CMSIS Solution to add to its API
 * version 3 (2.9.2, stage 3; gap G1b of the proposal). **Proposed, not
 * shipped**: no CMSIS Solution build has them (checked against the nightly
 * 1.72.1-86 and `main` of 2026-11-16), so everything here is inert until
 * one does, and only scripted APIs have exercised it. The types follow the
 * sketch of `docs/proposals/2.9.2-documentation-inventory.md`, kept apart
 * from the shipped methods of `SolutionApiV3Methods`, and each method is
 * detected by name on its own.
 *
 * With them, the logistics move to CMSIS Solution: `fetch_doc` has the
 * document downloaded there (`downloadDocument`), records the agent's
 * request when it cannot be downloaded (`requestDocument`), and adds a URL
 * the inventory does not know (`addDocument`); the migration command adds
 * the legacy user folder's documents. This extension keeps extraction,
 * index, search and citations.
 *
 * Pure: no `vscode`; the API object comes from the host.
 */

/** A parent of the inventory: a device (`Vendor::Name`) or a board (`Vendor::Name[:Revision]`), or the Arm commons. */
export type ProposedDocParent = { device: string } | { board: string } | { common: 'arm-docs' };

/** What the proposed API says about one document. */
export interface ProposedDocumentInfo {
    name: string;
    title?: string;
    category?: string;
    location?: 'pack' | 'web' | 'link' | 'local' | 'user' | string;
    path?: string;
    requested?: { by: 'agent' | 'user' | string; at?: string; reason?: string };
    error?: { kind?: string; detail?: string; url?: string };
}

/** The proposed document methods; each one optional. */
export interface ProposedDocumentMethods {
    getDocuments(parent: ProposedDocParent): PromiseLike<ProposedDocumentInfo[]>;
    addDocument(parent: ProposedDocParent, source: string, meta?: { title?: string; category?: string }): PromiseLike<ProposedDocumentInfo>;
    downloadDocument(parent: ProposedDocParent, name: string, options?: {
        timeoutMs?: number; maxBytes?: number; onProgress?: (bytes: number, total?: number) => void;
    }): PromiseLike<ProposedDocumentInfo>;
    importDocument(parent: ProposedDocParent, name: string, localPath: string): PromiseLike<ProposedDocumentInfo>;
    removeDocument(parent: ProposedDocParent, name: string): PromiseLike<boolean>;
    requestDocument(parent: ProposedDocParent, name: string, request: { by: 'agent'; reason: string }): PromiseLike<void>;
}

/** The methods an API object offers, bound; empty for today's CMSIS Solution. */
export type DocumentApi = Partial<ProposedDocumentMethods>;

const METHODS: readonly (keyof ProposedDocumentMethods)[] = ['getDocuments', 'addDocument', 'downloadDocument', 'importDocument', 'removeDocument', 'requestDocument'];

/** The proposed document methods `api` offers, each found by name and bound to it. */
export function documentApiOf(api: unknown): DocumentApi {
    const found: Record<string, unknown> = {};
    if (typeof api !== 'object' || api === null) {
        return {};
    }
    for (const method of METHODS) {
        const value = (api as Record<string, unknown>)[method];
        if (typeof value === 'function') {
            found[method] = value.bind(api);
        }
    }
    return found as DocumentApi;
}

/** The parent of an inventory document as the proposed API names it. */
export function proposedParentOf(parent: { tag: 'device' | 'board' | 'common'; key: string } | undefined): ProposedDocParent | undefined {
    if (parent === undefined) {
        return undefined;
    }
    if (parent.tag === 'common') {
        return { common: 'arm-docs' };
    }
    return parent.tag === 'device' ? { device: parent.key } : { board: parent.key };
}

/** A failure of the proposed API as text: its `error.kind` and detail when it rejects with one. */
export function documentFailureText(caught: unknown): string {
    const error = (caught as { error?: { kind?: unknown; detail?: unknown } } | undefined)?.error;
    if (error !== undefined && typeof error.kind === 'string') {
        return typeof error.detail === 'string' ? `${error.kind}: ${error.detail}` : error.kind;
    }
    return caught instanceof Error ? caught.message : String(caught);
}

/** Whether a failure needs the user (a login wall, an HTML page where a PDF was expected). */
export function needsUser(failure: string): boolean {
    return /login-required|not-pdf|\b(401|403)\b|not a pdf|text\/html|login|forbidden|unauthori[sz]ed/i.test(failure);
}
