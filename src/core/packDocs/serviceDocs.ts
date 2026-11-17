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
 * knowledge; a document only the service has is added). Arm documents only
 * take the service's copy: which of them belong to a target stays
 * `armDocsFor`'s rule.
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

/**
 * Fold the service's documents into `docs` (in place): a listed document
 * with the same Arm id, URL or file gains `service`; Arm documents are only
 * enriched; the rest is added. Returns how many were added.
 */
export function mergeServiceDocs(docs: DocRef[], infos: readonly DocumentInfo[], view: string): number {
    let added = 0;
    for (const info of infos) {
        const ref = serviceDocRef(info, view);
        const listed = docs.find((doc) => (ref.arm !== undefined && doc.arm?.docId === ref.arm.docId)
            || (ref.url !== undefined && doc.url === ref.url)
            || (isUrl(info.name) ? false : samePath(doc.path, ref.path)));
        if (listed) {
            listed.service = ref.service;
            if (listed.arm && info.sourceTitle) { listed.title = info.sourceTitle; }
            if (ref.revision && !listed.revision) { listed.revision = ref.revision; }
            continue;
        }
        // An Arm document belongs to a target by armDocsFor's rule; one the target does not list joins only when it was fetched.
        if (ref.arm !== undefined && !info.path) {
            continue;
        }
        if (!docs.some((doc) => doc.id === ref.id)) {
            docs.push(ref);
            added++;
        }
    }
    return added;
}
