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
 * The folder of a document's index in CMSIS Solution's document folder
 * (`~/.cmsis/docs`), for a document whose file lies elsewhere: a PDF inside
 * a pack, a file of a project.
 *
 * CMSIS Solution names one folder per document of a device or board, the
 * `indexDir` of its `IDocRef`: `<Vendor>/<Name>/<base>`, where `<base>` is
 * the document's file name without the extension, whether the document is a
 * pack's file, a local file or a URL. A copy it downloads or imports lies in
 * that folder, and so does the index of a document that has no copy there.
 * For what CMSIS Solution has no folder the document service's folders are
 * taken (`src/docService/emulator.ts`), and `projects/` for a project's own
 * files:
 *
 *   <root>/<Vendor>/<Name>/<base>/           a document of a device or board
 *   <root>/packs/<Vendor>/<Pack>/<base>/     a pack's PDF that no device or board lists
 *   <root>/cores/<core>/<base>/              a document of a core, of a vendor
 *   <root>/vendors/<vendor>/<base>/          or of every target, as the service
 *   <root>/all/<base>/                       places their copies
 *   <root>/projects/<folder hash>/<base>/    a file of a project or a workspace folder
 *
 * A component no file system takes is rewritten as the document service
 * rewrites it; CMSIS Solution rejects such a name, so for every name it
 * accepts the folder is the same.
 *
 * Pure: no `vscode`, no file access.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import type { DocParent } from '../../docService/contract';
import type { DocRef } from './pdscBooks';

const FORBIDDEN = '<>:"/\\|?*';

/** One folder name: control and reserved characters replaced, no trailing dot or space; `fallback` for what is left empty or reserved. */
function component(value: string | undefined, fallback: string): string {
    const clean = [...(value ?? '')].map((ch) => (ch.charCodeAt(0) < 32 || FORBIDDEN.includes(ch) ? '_' : ch)).join('').replace(/[. ]+$/, '');
    return clean.length > 0 && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? clean : fallback;
}

/** `<base>`: the name of a URL's last segment or of a file, without the extension. */
function baseOf(name: string): string {
    if (/^https?:\/\//i.test(name)) {
        try {
            return component(path.posix.parse(new URL(name).pathname).name, 'index');
        } catch {
            return 'index';
        }
    }
    return component(path.parse(name).name, 'document');
}

/** `Vendor::Name[:Revision]` as folders; the revision does not count, an empty part is left out. */
function hardwareFolders(key: string): string[] {
    const match = /^(?:([^:]*)::)?([^:]*)(?::(.*))?$/.exec(key);
    return [match?.[1], match ? match[2] : key].filter((part): part is string => part !== undefined && part.length > 0).map((part) => component(part, '_'));
}

/** The folders of a parent, below the root. */
function parentFolders(parent: DocParent): string[] {
    if ('device' in parent) { return hardwareFolders(parent.device); }
    if ('board' in parent) { return hardwareFolders(parent.board); }
    if ('pack' in parent) { return ['packs', ...hardwareFolders(parent.pack)]; }
    if ('core' in parent) { return ['cores', component(parent.core, '_')]; }
    if ('vendor' in parent) { return ['vendors', component(parent.vendor, '_')]; }
    return ['all'];
}

/** What the document belongs to, as far as it says: the service's parent, CMSIS Solution's, the target's hardware, its pack. */
function parentOf(doc: DocRef): DocParent | undefined {
    if (doc.service) {
        return doc.service.parent;
    }
    const listed = doc.inventory?.parent;
    if (listed && listed.tag !== 'common') {
        return listed.tag === 'device' ? { device: listed.key } : { board: listed.key };
    }
    if (doc.listedFor) {
        return doc.listedFor;
    }
    return doc.source === 'pack' && doc.packId ? { pack: `${doc.packId.vendor}::${doc.packId.name}` } : undefined;
}

/**
 * The folder below `root` (CMSIS Solution's document folder) for the index
 * of `doc`, a document with a local file outside that folder. Undefined for
 * a document without a file, for a web document (its copy has the index
 * beside it) and for one that names nothing it belongs to.
 */
export function indexDirOf(doc: DocRef, root: string): string | undefined {
    if (!doc.path || doc.source === 'web') {
        return undefined;
    }
    const base = baseOf(doc.service?.name ?? doc.inventory?.name ?? doc.path);
    if (doc.source === 'workspace' || doc.service?.scope === 'project') {
        const folder = crypto.createHash('sha1').update(path.dirname(doc.path)).digest('hex').slice(0, 12);
        return path.join(root, 'projects', folder, base);
    }
    const parent = parentOf(doc);
    return parent ? path.join(root, ...parentFolders(parent), base) : undefined;
}
