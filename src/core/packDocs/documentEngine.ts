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
 * The download engine the emulated document service (`src/docService/`) is
 * given: this extension's resolvers (arm.com's documentation service, direct
 * PDF links) and its guarded downloader (private hosts refused, redirects
 * checked hop by hop, `%PDF-` signature, size cap, progress, cancel). The
 * engine downloads into the folder the service names and classifies a
 * failure into the contract's kinds, so the service records why and the user
 * learns what to do.
 */

import * as path from 'path';
import { DocumentFailure, DocumentFailureKind } from '../../docService/contract';
import type { DownloadEngine, DownloadedCopy } from '../../docService/emulator';
import { classifyFailure } from '../../docService/emulator';
import { armDocId, parseArmDocUrl } from './armDocs';
import { PackDocsLog } from './host';
import { DocRef } from './pdscBooks';
import { downloadPdf, FetchFn, ResolveContext, resolvers } from './webFetch';

export interface EngineContext {
    fetchFn: FetchFn;
    userAgent: string;
    log: PackDocsLog;
    /** Defaults for a download that names none. */
    timeoutMs: number;
    maxBytes: number;
    allowPrivateHosts?: boolean;
}

/** The PDF's file name: the source's, else the URL's last segment, else `document.pdf`. */
function fileNameOf(filename: string | undefined, url: string): string {
    const pick = filename ?? path.basename(new URL(url).pathname);
    const safe = pick.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
    return /\.pdf$/i.test(safe) ? safe : `${safe || 'document'}.pdf`;
}

/** This extension's resolvers and downloader as the service's engine. */
export function documentEngine(engine: EngineContext): DownloadEngine {
    return {
        async download(url, destDir, options): Promise<DownloadedCopy> {
            const ctx: ResolveContext = {
                fetchFn: engine.fetchFn,
                userAgent: engine.userAgent,
                log: engine.log,
                timeoutMs: options.timeoutMs ?? engine.timeoutMs,
                maxBytes: options.maxBytes ?? engine.maxBytes,
                ...(engine.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.onProgress ? { onProgress: options.onProgress } : {}),
            };
            const arm = parseArmDocUrl(url);
            const doc: DocRef = { id: arm ? armDocId(arm) : url, title: url, scope: 'unlisted', source: 'web', url, cached: false, indexed: false, ...(arm ? { arm } : {}) };
            const resolver = resolvers.find((r) => r.matches(doc));
            if (!resolver) {
                throw new DocumentFailure({ kind: 'unknown', detail: `no way to fetch ${url}` });
            }
            const resolved = await resolver.resolve(doc, ctx);
            if ('error' in resolved) {
                throw failure(resolved.error, url);
            }
            if (resolved.kind === 'html') {
                throw new DocumentFailure({ kind: 'html', detail: `${url} is published as HTML (${resolved.contentFormat ?? 'HTML'}); only PDFs are downloaded`, url });
            }
            const dest = path.join(destDir, fileNameOf(resolved.filename, resolved.downloadUrl ?? url));
            let downloaded;
            try {
                downloaded = await downloadPdf(resolved.downloadUrl!, dest, ctx);
            } catch (caught) {
                throw failure(caught instanceof Error ? caught.message : String(caught), url);
            }
            return {
                path: dest,
                bytes: downloaded.bytes,
                sha256: downloaded.sha256,
                resolver: resolver.name,
                ...(resolved.filename ? { filename: resolved.filename } : {}),
                ...(resolved.title ? { title: resolved.title } : {}),
                ...(resolved.version ? { version: resolved.version } : {}),
                ...(resolved.versionLabel ? { versionLabel: resolved.versionLabel } : {}),
                ...(resolved.alternatives?.length ? { alternatives: resolved.alternatives } : {}),
            };
        },
    };
}

/** A resolver's or the downloader's message as the contract's failure. */
function failure(message: string, url: string): DocumentFailure {
    const kind: DocumentFailureKind = classifyFailure(message);
    return new DocumentFailure({ kind, detail: message, ...(kind === 'login-required' || kind === 'not-pdf' ? { url } : {}) });
}
