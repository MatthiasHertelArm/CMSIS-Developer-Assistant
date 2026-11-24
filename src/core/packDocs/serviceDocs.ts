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
 * The document service's documents (`src/docService/contract.ts`) as this
 * extension's `DocRef`s, merged into the target's documents: which parents
 * a target has, the ids (derived from the name as the pdsc walk and
 * `fetch_doc` derive them, so no id changes when a document moves into the
 * service), and the merge (the same file, URL or Arm id gains the service's
 * knowledge; a document only the service has is added; of several entries
 * for one document the one with the copy counts; two local documents of
 * the same file name are both listed). Arm documents only take the
 * service's copy: which of them belong to a target stays `armDocsFor`'s
 * rule.
 *
 * Pure: no `vscode`.
 */

import * as path from 'path';
import { DocParent, DocumentInfo, parentKey } from '../../docService/contract';
import { armDocId, lookupArmDoc, parseArmDocUrl } from './armDocs';
import { formatPackId, PackId, QualifiedName } from './cbuildRun';
import { shortHash } from './pageStore';
import { DocRef, fileSlug, normalizeCategory, slug } from './pdscBooks';

/** `Vendor::Name[:Revision]` of a qualified name. */
function keyOf(name: QualifiedName | undefined, withRevision: boolean): string | undefined {
    if (!name) {
        return undefined;
    }
    return `${name.vendor ? `${name.vendor}::` : ''}${name.name}${withRevision && name.revision ? `:${name.revision}` : ''}`;
}

/** The device and the board of a target as parents, keyed as CMSIS Solution keys them. */
export function hardwareParents(target: { device?: QualifiedName; board?: QualifiedName }): { device?: DocParent; board?: DocParent } {
    const device = keyOf(target.device, false);
    const board = keyOf(target.board, true);
    return { ...(device ? { device: { device } } : {}), ...(board ? { board: { board } } : {}) };
}

/** The parents a target's documents can hang off, most specific first. */
export function targetParents(target: { device?: QualifiedName; board?: QualifiedName; devicePack?: PackId; boardPack?: PackId; cores?: string[] }): DocParent[] {
    const parents: DocParent[] = [];
    const device = keyOf(target.device, false);
    const board = keyOf(target.board, true);
    if (device) { parents.push({ device }); }
    if (board) { parents.push({ board }); }
    for (const core of new Set(target.cores ?? [])) { parents.push({ core }); }
    for (const pack of [target.devicePack, target.boardPack]) {
        if (pack) { parents.push({ pack: formatPackId({ ...pack, version: undefined }) }); }
    }
    for (const vendor of new Set([target.devicePack?.vendor, target.boardPack?.vendor].filter((v): v is string => !!v))) {
        parents.push({ vendor });
    }
    parents.push({ all: true });
    const seen = new Set<string>();
    return parents.filter((parent) => {
        const key = parentKey(parent).toLowerCase();
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

const isUrl = (text: string): boolean => /^https?:\/\//i.test(text);

/** One service document as a `DocRef`; `view` names where the user resolves it. */
export function serviceDocRef(info: DocumentInfo, view: string): DocRef {
    const category = normalizeCategory(info.category);
    const service: NonNullable<DocRef['service']> = { parent: info.parent, name: info.name, scope: info.scope, view };
    if (info.path) { service.copy = info.path; }
    if (info.requested) { service.requested = { by: info.requested.by, reason: info.requested.reason }; }
    if (info.error && info.error.kind !== 'missing-file') { service.error = { ...info.error }; }
    const scope = info.scope === 'project' ? 'project' : 'user';
    if (info.location === 'web') {
        const arm = parseArmDocUrl(info.name);
        let host = 'web';
        try {
            host = new URL(info.name).hostname;
        } catch {
            // The generic host.
        }
        const entry = arm ? lookupArmDoc(arm.docId) : undefined;
        return {
            id: arm ? armDocId(arm) : `web/${slug(host)}/${shortHash(info.name)}`,
            title: (arm && info.sourceTitle) || info.title,
            ...(entry ? { kind: entry.kind } : {}),
            ...(category ? { category } : {}),
            scope: arm ? 'arm' : scope,
            source: 'web',
            url: info.name,
            ...(arm ? { arm } : {}),
            ...(info.versionLabel ? { revision: info.versionLabel } : {}),
            ...(htmlOnly(info) ? { format: 'html' as const } : {}),
            cached: false,
            indexed: false,
            service,
        };
    }
    // A local document without a path (outside the project) is listed as missing, never read by its name.
    const file = info.path ?? path.basename(info.name);
    const owner = slug(parentKey(info.parent).replace(/^[a-z]+:/, '').replace(/^.*::/, '')) || 'all';
    const ref: DocRef = {
        id: `${scope}/${owner}/${fileSlug(file)}`,
        title: info.title,
        ...(category ? { category } : {}),
        scope,
        source: info.scope === 'project' ? 'workspace' : 'user',
        path: file,
        cached: false,
        indexed: false,
        service,
    };
    if (path.extname(file).toLowerCase() !== '.pdf') { ref.unsupported = true; }
    if (info.bytes !== undefined) { ref.sizeBytes = info.bytes; }
    if (info.versionLabel) { ref.revision = info.versionLabel; }
    if (info.error?.kind === 'missing-file' || !info.path) { ref.missing = true; }
    return ref;
}

function samePath(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && path.resolve(a) === path.resolve(b);
}

/** Whether the service has a copy of the document that is there. */
function copyThere(info: DocumentInfo): boolean {
    return info.path !== undefined && info.error?.kind !== 'missing-file';
}

/** Whether the service found the document published as HTML only: the failure of its last download says so until a copy exists. */
function htmlOnly(info: DocumentInfo): boolean {
    return info.error?.kind === 'html' && info.path === undefined;
}

/**
 * Fold the service's documents into `docs` (in place): a listed document
 * with the same Arm id, URL or file gains `service`; Arm documents are only
 * enriched; the rest is added. Returns how many were added.
 *
 * Several entries can name one document (the user's and the project's entry
 * of a URL, an entry on the device and one on all targets). The first one
 * counts, in the order given (the most specific parent first, the user's
 * before the project's), unless only a later one has the copy: an entry
 * without a copy never takes the place of one that has it.
 *
 * Two local documents of one parent can have the same file name. Both are
 * listed: the first under the id of its name, the next under that id with a
 * hash of its own name, which does not depend on the order of the list.
 */
export function mergeServiceDocs(docs: DocRef[], infos: readonly DocumentInfo[], view: string): number {
    let added = 0;
    /** The documents whose `service` is an entry with a copy. */
    const withCopy = new Set<DocRef>();
    for (const info of infos) {
        const ref = serviceDocRef(info, view);
        const listed = docs.find((doc) => (ref.arm !== undefined && doc.arm?.docId === ref.arm.docId)
            || (ref.url !== undefined && doc.url === ref.url)
            // A local document without a path has only its file name here, which is no file to compare.
            || (isUrl(info.name) || !info.path ? false : samePath(doc.path, ref.path)));
        if (listed) {
            if (listed.service === undefined || (!withCopy.has(listed) && copyThere(info))) {
                listed.service = ref.service;
                // What the entry that counts knows of the format: HTML only, or nothing.
                if (ref.format === 'html') { listed.format = 'html'; } else if (listed.format === 'html') { delete listed.format; }
                if (copyThere(info)) { withCopy.add(listed); }
            }
            if (listed.arm && info.sourceTitle) { listed.title = info.sourceTitle; }
            if (ref.revision && !listed.revision) { listed.revision = ref.revision; }
            continue;
        }
        // An Arm document belongs to a target by armDocsFor's rule; one the target does not list joins only when it was
        // fetched, or found to be HTML only, so that the listing says so instead of the agent asking again.
        if (ref.arm !== undefined && !info.path && !htmlOnly(info)) {
            continue;
        }
        if (ref.source !== 'web' && docs.some((doc) => doc.id === ref.id)) {
            ref.id = `${ref.id}-${shortHash(info.name).slice(0, 6)}`;
        }
        if (!docs.some((doc) => doc.id === ref.id)) {
            docs.push(ref);
            added++;
            if (copyThere(info)) { withCopy.add(ref); }
        }
    }
    return added;
}
