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
 * The move from the retired document path to the document service (user
 * decision of 2026-11-16): the downloads `fetch_doc` kept in this
 * extension's store (`arm/`, `web/`) become service documents under "all
 * targets", as they were listed for every target before, with their
 * edition; the old copy and its fetch record are then deleted. Their
 * extracted text and index stay current (the copy keeps its modification
 * time) and follow the copy on first use.
 *
 * The move keeps no record of itself: it runs when a window first resolves a
 * target, and finds nothing once the store holds no download. A document
 * that could not be moved stays where it is, usable from there, and is tried
 * again by the next window. What the store kept beside the downloads goes:
 * the records of documents found to be HTML only, which the document
 * service keeps on its entries now, and the marker file of earlier builds.
 *
 * The user documents folder is not part of the move (decision of
 * 2026-11-17): it is neither read nor copied, and the user is told once
 * that it is no longer used (`userDocs.legacyUserDocsNotice`).
 *
 * Pure: no `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocumentService } from '../../docService/contract';
import { PackDocsLog } from './host';
import { PageStore } from './pageStore';

/** What one run of the move did. */
export interface MigrationReport {
    /** Downloads that became documents of the service. */
    downloads: number;
    /** Records of HTML-only documents and marker files removed. */
    dropped: number;
    /** Documents not moved, with the reason. */
    left: string[];
}

/** The marker earlier builds wrote into the storage folder after their one move. */
function oldMarker(storageDir: string): string {
    return path.join(storageDir, 'docservice-migration.json');
}

/** Move what the retired path left in `store` into `service`. A failure of one document is reported and costs no other. */
export async function migrateLegacyDocuments(service: DocumentService, store: PageStore, log: PackDocsLog): Promise<MigrationReport> {
    const report: MigrationReport = { downloads: 0, dropped: 0, left: [] };
    for (const doc of store.listFetched()) {
        if (doc.format === 'html') {
            // A fact, not a document: the service records it on the entry at the next fetch_doc.
            store.removeDownload(doc);
            report.dropped++;
            continue;
        }
        const file = store.paths(doc).download;
        if (!doc.url || doc.format !== 'pdf' || !fs.existsSync(file)) {
            continue;
        }
        try {
            const parent = { all: true } as const;
            await service.addDocument(parent, doc.url, { title: doc.title });
            await service.importDocument(parent, doc.url, file, undefined, {
                ...(doc.arm?.resolvedVersion ? { version: doc.arm.resolvedVersion } : {}),
                ...(doc.revision ? { versionLabel: doc.revision } : {}),
                ...(doc.arm ? { sourceTitle: doc.title } : {}),
            });
            store.removeDownload(doc);
            report.downloads++;
        } catch (caught) {
            report.left.push(`${doc.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
    }
    if (fs.existsSync(oldMarker(store.dir))) {
        fs.rmSync(oldMarker(store.dir), { force: true });
        report.dropped++;
    }
    if (report.downloads || report.left.length) {
        log.info(`documents moved to the document service: ${report.downloads} download(s)`
            + `${report.left.length ? `; not moved: ${report.left.join('; ')}` : ''}`);
    }
    return report;
}
