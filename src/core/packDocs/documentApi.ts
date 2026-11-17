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
 * The consumer side of the document service (`src/docService/contract.ts`):
 * which implementation answers, and the translations between the service's
 * types and this extension's `DocRef`. CMSIS Solution's implementation is
 * taken when its API offers `getDocumentService()` with a service of this
 * contract's major version; otherwise the emulator of `src/docService/`
 * answers. A method name alone is no proof: CMSIS Solution has internal
 * methods called `addDocument` and `downloadDocument` with other arguments.
 *
 * Pure: no `vscode`.
 */

import { DocParent, DocumentFailure, DocumentService, DOCUMENT_SERVICE_VERSION } from '../../docService/contract';

const SERVICE_METHODS: readonly (keyof DocumentService)[] = ['getDocuments', 'addDocument', 'downloadDocument', 'importDocument', 'removeDocument',
    'requestDocument', 'clearRequest', 'getRequests', 'onDidChangeDocuments'];

/** CMSIS Solution's document service, when its API object offers one of this contract's major version. */
export function solutionDocumentService(api: unknown): DocumentService | undefined {
    const getter = (api as { getDocumentService?: unknown } | null | undefined)?.getDocumentService;
    if (typeof getter !== 'function') {
        return undefined;
    }
    let service: unknown;
    try {
        service = getter.call(api);
    } catch {
        return undefined;
    }
    const candidate = service as Record<string, unknown> | undefined;
    const major = (version: unknown): string | undefined => (typeof version === 'string' ? version.split('.')[0] : undefined);
    if (!candidate || major(candidate.version) !== major(DOCUMENT_SERVICE_VERSION)
        || SERVICE_METHODS.some((method) => typeof candidate[method] !== 'function')) {
        return undefined;
    }
    return service as DocumentService;
}

/** The parent of a CMSIS Solution inventory entry as the service names it; undefined for the Arm commons. */
export function serviceParentOf(parent: { tag: 'device' | 'board' | 'common'; key: string } | undefined): DocParent | undefined {
    if (parent === undefined || parent.tag === 'common') {
        return undefined;
    }
    return parent.tag === 'device' ? { device: parent.key } : { board: parent.key };
}

/** A failure of the service as text: its kind and detail. */
export function documentFailureText(caught: unknown): string {
    if (caught instanceof DocumentFailure) {
        return caught.error.detail ? `${caught.error.kind}: ${caught.error.detail}` : caught.error.kind;
    }
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
