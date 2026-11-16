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
 * CMSIS Solution's document inventory as a source of the documentation
 * tools (2.9.2, stage 1): `~/.cmsis/docs.yml`, which CMSIS Solution after
 * 1.72.0 fills after each conversion with the device and board books of the
 * converted targets and the Arm catalogue, and into which its view's *Add
 * Document*, *Download Document* and *Import Document* record what the user
 * adds or downloads, with the local copy under `~/.cmsis/docs/`.
 *
 * The file is read per call, never written and never watched. It is the
 * user's file as much as CMSIS Solution's, so it is parsed with `js-yaml`
 * and every field is checked; a file that does not parse is skipped with
 * one note. An entry is selected by the target's device (`Vendor::Name`,
 * the processor suffix dropped as CMSIS Solution drops it) and board
 * (`Vendor::Name[:Revision]`). Each document becomes a `DocRef` with this
 * extension's id, derived from `name` as the pdsc walk and `fetch_doc`
 * derive it, so ids, the page store and the listings do not change for
 * documents that were listed before; `inventory` carries what only the
 * inventory knows: the local copy, the reason of a failed download, and
 * whether the user added the document.
 *
 * `mergeInventory` folds these into the documents the pdsc walk and the Arm
 * catalogue found: the same file, URL or Arm id gains the inventory's
 * knowledge, and a document only the inventory lists is added. The `arm-docs`
 * commons only lend their local copies to the Arm documents already listed:
 * which of them belong to a target stays this extension's rule.
 *
 * Pure: file access only through the path given; no `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { load } from 'js-yaml';
import { armDocId, parseArmDocUrl } from './armDocs';
import { QualifiedName, defaultPackRoot } from './cbuildRun';
import { shortHash } from './pageStore';
import { DocRef, fileSlug, normalizeCategory, slug } from './pdscBooks';

/** One document of the inventory, as far as it is understood. */
export interface InventoryDoc {
    /** A URL or an absolute path: the document's identity in the inventory. */
    name: string;
    title?: string;
    category?: string;
    /** The local copy: a download, an import, or the file itself. */
    path?: string;
    /** `user` for documents the user added in the CMSIS view. */
    mode?: string;
    /** Why the download failed, as CMSIS Solution recorded it. */
    error?: string;
}

/** A device or board entry: its key, the pack it came from, its documents. */
export interface InventoryEntry {
    key: string;
    pack?: string;
    docs: InventoryDoc[];
}

/** The parts of `docs.yml` this extension reads. */
export interface Inventory {
    file: string;
    /** What `${CMSIS_PACK_ROOT}` in a name or path stands for. */
    packRoot: string;
    devices: InventoryEntry[];
    boards: InventoryEntry[];
    /** The `arm-docs` commons. */
    armDocs: InventoryDoc[];
}

/** What a read of the file gives: the inventory, nothing (no file), or why it could not be read. */
export type InventoryRead = { inventory: Inventory } | { absent: true } | { error: string };

/** A string field, trimmed; undefined when empty or not a string. */
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function docsOf(value: unknown): InventoryDoc[] {
    const docs: InventoryDoc[] = [];
    for (const item of list(value)) {
        const entry = record(item);
        const name = text(entry?.name);
        if (entry === undefined || name === undefined) {
            continue;
        }
        const doc: InventoryDoc = { name };
        const title = text(entry.title);
        const category = text(entry.category);
        const copy = text(entry.path);
        const mode = text(entry.mode);
        const error = text(entry.error);
        if (title !== undefined) { doc.title = title; }
        if (category !== undefined) { doc.category = category; }
        if (copy !== undefined) { doc.path = copy; }
        if (mode !== undefined) { doc.mode = mode; }
        if (error !== undefined) { doc.error = error; }
        docs.push(doc);
    }
    return docs;
}

function entriesOf(value: unknown, keyField: 'device' | 'board'): InventoryEntry[] {
    const entries: InventoryEntry[] = [];
    for (const item of list(value)) {
        const entry = record(item);
        const key = text(entry?.[keyField]);
        if (entry === undefined || key === undefined) {
            continue;
        }
        entries.push({ key, ...(text(entry.pack) !== undefined ? { pack: text(entry.pack) } : {}), docs: docsOf(entry.docs) });
    }
    return entries;
}

/**
 * A name or path of the inventory as a local path: `${CMSIS_PACK_ROOT}` and
 * a `file://` URL expanded as CMSIS Solution expands them; undefined for a
 * web URL.
 */
export function localPathOf(text: string, packRoot: string): string | undefined {
    if (isUrl(text)) {
        return undefined;
    }
    let local = text;
    if (/^file:\/\//i.test(local)) {
        try {
            local = fileURLToPath(local);
        } catch {
            return undefined;
        }
    }
    local = local.replace(/^\$\{CMSIS_PACK_ROOT\}(?=[/\\]|$)/, packRoot.replace(/[/\\]+$/, ''));
    return path.resolve(local);
}

/** The inventory in `text`, as CMSIS Solution writes it (`docs:` with `devices`, `boards`, `commons`). */
export function parseInventory(yaml: string, file: string, packRoot: string = defaultPackRoot()): Inventory {
    const root = record(record(load(yaml))?.docs);
    const armDocs = list(root?.commons)
        .map(record)
        .filter((common) => text(common?.common) === 'arm-docs')
        .flatMap((common) => docsOf(common?.docs));
    return { file, packRoot, devices: entriesOf(root?.devices, 'device'), boards: entriesOf(root?.boards, 'board'), armDocs };
}

/** Read and parse the inventory at `file`. Never throws. */
export function readInventory(file: string, packRoot?: string): InventoryRead {
    let yaml: string;
    try {
        yaml = fs.readFileSync(file, 'utf-8');
    } catch (caught) {
        const code = (caught as NodeJS.ErrnoException | undefined)?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? { absent: true } : { error: `cannot read ${file} (${String(caught)})` };
    }
    try {
        return { inventory: parseInventory(yaml, file, packRoot) };
    } catch (caught) {
        return { error: `${file} is not valid YAML (${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)})` };
    }
}

/** `Vendor::Name` and `Vendor::Name:Revision` as a key: vendor, name and revision in lower case. */
function keyParts(key: string): { vendor?: string; name: string; revision?: string } {
    const sep = key.indexOf('::');
    const vendor = sep >= 0 ? key.slice(0, sep).trim().toLowerCase() : undefined;
    const rest = sep >= 0 ? key.slice(sep + 2) : key;
    const colon = rest.indexOf(':');
    return colon >= 0
        ? { vendor, name: rest.slice(0, colon).trim().toLowerCase(), revision: rest.slice(colon + 1).trim().toLowerCase() || undefined }
        : { vendor, name: rest.trim().toLowerCase() };
}

/** Whether an inventory key names `wanted`; the vendor and the revision count only when both sides have one. */
function keyMatches(key: string, wanted: QualifiedName, withRevision: boolean): boolean {
    const have = keyParts(key);
    const vendor = wanted.vendor?.trim().toLowerCase();
    if (have.name !== wanted.name.trim().toLowerCase()) {
        return false;
    }
    if (vendor && have.vendor && vendor.replace(/\s+/g, '') !== have.vendor.replace(/\s+/g, '')) {
        return false;
    }
    const revision = wanted.revision?.trim().toLowerCase();
    return !withRevision || !revision || !have.revision || revision === have.revision;
}

function isUrl(name: string): boolean {
    return /^https?:\/\//i.test(name);
}

/** The pack name of `Vendor::Name@version`, for the id of a pack file. */
function packNameOf(pack: string | undefined): string | undefined {
    const match = /::([^@]+)/.exec(pack ?? '');
    return match ? match[1] : undefined;
}

/** One inventory document as a `DocRef` with this extension's id; `scope` is the parent's. */
export function inventoryDocRef(doc: InventoryDoc, scope: 'device' | 'board', parent: InventoryEntry, packRoot: string = defaultPackRoot()): DocRef {
    const name = doc.name;
    const category = normalizeCategory(doc.category);
    const copyPath = doc.path !== undefined ? localPathOf(doc.path, packRoot) : undefined;
    const inventory: NonNullable<DocRef['inventory']> = { name, parent: { tag: scope, key: parent.key } };
    if (copyPath !== undefined) { inventory.copy = copyPath; }
    if (doc.error !== undefined) { inventory.error = doc.error; }
    if (doc.mode === 'user') { inventory.user = true; }
    if (isUrl(name)) {
        const arm = parseArmDocUrl(name);
        let host = 'web';
        try {
            host = new URL(name).hostname;
        } catch {
            // Keep the generic host.
        }
        return {
            id: arm ? armDocId(arm) : `web/${slug(host)}/${shortHash(name)}`,
            title: doc.title ?? name,
            ...(category ? { category } : {}),
            scope: arm ? 'arm' : scope,
            source: 'web',
            url: name,
            ...(arm ? { arm } : {}),
            cached: false,
            indexed: false,
            inventory,
        };
    }
    const user = doc.mode === 'user';
    const file = copyPath ?? localPathOf(name, packRoot) ?? name;
    const ref: DocRef = {
        id: user ? `user/${slug(keyParts(parent.key).name)}/${fileSlug(file)}` : `${slug(packNameOf(parent.pack) ?? 'cmsis')}/${fileSlug(file)}`,
        title: doc.title ?? path.basename(file),
        ...(category ? { category } : {}),
        scope: user ? 'user' : scope,
        source: user ? 'user' : 'pack',
        ...(!user && parent.pack ? { pack: parent.pack } : {}),
        path: file,
        cached: false,
        indexed: false,
        inventory,
    };
    if (path.extname(file).toLowerCase() !== '.pdf') {
        ref.unsupported = true;
    }
    try {
        ref.sizeBytes = fs.statSync(file).size;
    } catch {
        ref.missing = true;
    }
    return ref;
}

/** The documents the inventory lists for a target's device and board. */
export function inventoryDocsFor(inventory: Inventory, target: { device?: QualifiedName; board?: QualifiedName }): DocRef[] {
    const docs: DocRef[] = [];
    const take = (entries: InventoryEntry[], wanted: QualifiedName | undefined, scope: 'device' | 'board'): void => {
        if (wanted === undefined) {
            return;
        }
        const exact = entries.filter((entry) => keyMatches(entry.key, wanted, true));
        for (const entry of exact.length > 0 ? exact : entries.filter((entry) => keyMatches(entry.key, wanted, false))) {
            docs.push(...entry.docs.map((doc) => inventoryDocRef(doc, scope, entry, inventory.packRoot)));
        }
    };
    take(inventory.devices, target.device, 'device');
    take(inventory.boards, target.board, 'board');
    return docs;
}

/** What `mergeInventory` did, for the log and the listing's note. */
export interface InventoryMerge {
    /** Documents only the inventory lists, added. */
    added: number;
    /** Documents already listed that gained a local copy, a failure or the user mark. */
    enriched: number;
}

function sameFile(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && path.resolve(a) === path.resolve(b);
}

/** The listed document an inventory document stands for: the same Arm id, URL or file. */
function counterpart(docs: readonly DocRef[], doc: DocRef): DocRef | undefined {
    return docs.find((listed) => (doc.arm !== undefined && listed.arm?.docId === doc.arm.docId)
        || (doc.url !== undefined && listed.url === doc.url)
        || sameFile(listed.path, doc.path));
}

/** Give `listed` what the inventory knows of it. */
function enrich(listed: DocRef, known: NonNullable<DocRef['inventory']>): boolean {
    listed.inventory = { ...listed.inventory, ...known };
    return known.copy !== undefined || known.error !== undefined || known.user === true;
}

/** Whether `file` lies inside `folder`. */
function inside(folder: string, file: string): boolean {
    const relative = path.relative(path.resolve(folder), path.resolve(file));
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Fold the inventory's documents for the target into `docs` (in place):
 * the same document gains the inventory's knowledge, a new one is added;
 * the Arm commons only lend their local copies to listed Arm documents.
 * A pack file under `packRoot` is never added: the pdsc walk lists the
 * target's pack versions, and the inventory keeps the books of every
 * version it ever converted.
 */
export function mergeInventory(docs: DocRef[], inventory: Inventory, target: { device?: QualifiedName; board?: QualifiedName },
    packRoot?: string): InventoryMerge {
    const merge: InventoryMerge = { added: 0, enriched: 0 };
    for (const doc of inventoryDocsFor(inventory, target)) {
        const listed = counterpart(docs, doc);
        if (listed === undefined) {
            const packFile = doc.source === 'pack' && doc.path !== undefined && packRoot !== undefined && inside(packRoot, doc.path);
            if (!packFile && !docs.some((other) => other.id === doc.id && sameFile(other.path, doc.path))) {
                docs.push(doc);
                merge.added++;
            }
        } else if (enrich(listed, doc.inventory ?? {})) {
            merge.enriched++;
        }
    }
    for (const common of inventory.armDocs) {
        const arm = isUrl(common.name) ? parseArmDocUrl(common.name) : undefined;
        const listed = arm ? docs.find((doc) => doc.arm?.docId === arm.docId) : undefined;
        const copy = common.path !== undefined ? localPathOf(common.path, inventory.packRoot) : undefined;
        if (listed !== undefined && enrich(listed, { name: common.name, parent: { tag: 'common', key: 'arm-docs' },
            ...(copy ? { copy } : {}), ...(common.error ? { error: common.error } : {}) })) {
            merge.enriched++;
        }
    }
    return merge;
}
