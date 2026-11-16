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
 * The move from the retired document path to the document service, once per
 * machine (user decision of 2026-11-16):
 *
 * - **Downloads** `fetch_doc` kept in this extension's store (`arm/`, `web/`)
 *   become service documents under "all targets", as they were listed for
 *   every target before, with their edition; the old copy and its fetch
 *   record are then deleted. Their extracted text and index stay, and stay
 *   current (the copy keeps its modification time). HTML-only records are
 *   not downloads and stay.
 * - **The user documents folder** is copied into the service with the
 *   attribution its sub-folders gave (`userDocs.legacyParent`); a pattern
 *   folder cannot be attributed and is reported. The folder is never changed,
 *   and no longer read afterwards.
 *
 * A marker file records that it ran and what it did; a failure of one
 * document is reported and costs no other.
 *
 * Pure: no `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocumentService } from '../../docService/contract';
import { PackDocsLog } from './host';
import { PageStore } from './pageStore';
import { legacyParent, listLegacyUserDocs } from './userDocs';

/** What the move did. */
export interface MigrationReport {
    version: 1;
    at: string;
    downloads: number;
    userDocuments: number;
    /** Documents not moved, with the reason. */
    left: string[];
}

/** The marker of the move in this extension's storage folder. */
export function migrationMarker(storageDir: string): string {
    return path.join(storageDir, 'docservice-migration.json');
}

/** The report of an earlier move; undefined when it has not run. */
export function migrationDone(storageDir: string): MigrationReport | undefined {
    try {
        return JSON.parse(fs.readFileSync(migrationMarker(storageDir), 'utf-8')) as MigrationReport;
    } catch {
        return undefined;
    }
}

/** Move the retired path's documents into `service`, once; undefined when it ran before. */
export async function migrateLegacyDocuments(service: DocumentService, store: PageStore, storageDir: string, userRoot: string,
    log: PackDocsLog): Promise<MigrationReport | undefined> {
    if (migrationDone(storageDir)) {
        return undefined;
    }
    const report: MigrationReport = { version: 1, at: new Date().toISOString(), downloads: 0, userDocuments: 0, left: [] };
    for (const doc of store.listFetched()) {
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
    for (const doc of listLegacyUserDocs(userRoot)) {
        const parent = legacyParent(doc.parts);
        if (!parent) {
            report.left.push(`${doc.path}: the folder ${doc.parts.join('/')} is a pattern; add the document again with Add Document`);
            continue;
        }
        try {
            await service.addDocument(parent, doc.path, {
                title: doc.title, ...(doc.category ? { category: doc.category } : {}), ...(doc.revision ? { versionLabel: doc.revision } : {}),
            });
            report.userDocuments++;
        } catch (caught) {
            report.left.push(`${doc.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
    }
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(migrationMarker(storageDir), `${JSON.stringify(report, null, 2)}\n`);
    if (report.downloads || report.userDocuments || report.left.length) {
        log.info(`documents moved to the document service: ${report.downloads} download(s), ${report.userDocuments} from ${userRoot}`
            + `${report.left.length ? `; not moved: ${report.left.join('; ')}` : ''}`);
    }
    return report;
}
