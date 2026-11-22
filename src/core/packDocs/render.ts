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
 * Tool-result text. Compact, line-oriented, and always telling the agent
 * what to call next — the same shape as the CMSIS Developer Assistant's SVD
 * lookups.
 */

import { DocRef, isReadable } from './pdscBooks';
import { LoadedDoc, PageRecord } from './pageStore';
import { SearchHit } from './search';
import { clipValue, formatBytes, truncateList } from './textBudget';
import { FetchOutcome } from './webFetch';

function unitLabel(d: DocRef): string {
    return d.unit === 'section' ? '§' : 'p';
}

/** ` at <host>` of a URL, or nothing. */
function hostOf(url: string | undefined): string {
    try {
        return url ? ` at ${new URL(url).hostname}` : '';
    } catch {
        return '';
    }
}

/** Whether `d` is read from the copy CMSIS Solution downloaded or imported. */
function fromSolutionCopy(d: DocRef): boolean {
    return d.inventory?.copy !== undefined && d.path === d.inventory.copy;
}

export function docState(d: DocRef): string {
    // The document service and CMSIS Solution's inventory are one file with the emulator: what the service says of a document counts.
    const view = d.service ? (d.source === 'web' ? '' : d.service.scope === 'project' ? ' (project document)' : ' (added by the user)')
        : d.inventory?.user ? ' (added in the CMSIS view)' : fromSolutionCopy(d) && d.source === 'web' ? ' (CMSIS Solution\'s copy)' : '';
    if (d.source === 'web' && !d.cached) {
        if (d.format === 'html') { return 'web — HTML on arm.com, not fetchable in this version'; }
        // The document service's state first (2.9.2): its request and failure, in the words of its view.
        if (d.service?.requested !== undefined) {
            const kind = d.service.error?.kind;
            if (kind === 'login-required' || kind === 'not-pdf') {
                return `web — requested, needs the user: login or manual download${hostOf(d.url)}; they open it from ${d.service.view}, `
                    + 'download it in a browser and use Import a File there';
            }
            return `web — requested in ${d.service.view}${d.service.error ? ` (${d.service.error.kind}${d.service.error.detail ? `: ${d.service.error.detail.slice(0, 80)}` : ''})` : ''}; `
                + `Download there or fetch_doc { doc: '${d.id}' } tries again`;
        }
        if (d.inventory?.copy !== undefined) {
            return 'web — CMSIS Solution\'s copy is gone (Remove Document in the CMSIS view); Download Document there, or fetch_doc, gets it again';
        }
        if (d.fetchFailure !== undefined && /\b(401|403)\b|not a pdf|text\/html|login|forbidden|unauthori[sz]ed/i.test(d.fetchFailure)) {
            return `web — needs the user: login or manual download${hostOf(d.url)}; they download it in a browser and use Import Document on it `
                + `in the CMSIS view${d.inventory?.parent ? '' : ', or drop it into the workspace docs/ folder'}`;
        }
        if (d.inventory?.error?.startsWith('Requested by the agent:')) {
            return `web — requested in the CMSIS view (${d.inventory.error.slice('Requested by the agent:'.length).trim()})`;
        }
        if (d.inventory?.error) {
            return `web — download failed in the CMSIS view (${d.inventory.error}); fetch_doc { doc: '${d.id}' } tries again, `
                + 'or the user downloads it and uses Import Document on it in the CMSIS view';
        }
        if (d.fetchFailure !== undefined) {
            return `web — fetch_doc failed (${d.fetchFailure.replace(/\s+/g, ' ').slice(0, 100)}); it can be tried again`;
        }
        return `web — not fetched (fetch_doc { doc: '${d.id}' })`;
    }
    if (d.source === 'web' && !d.indexed) { return `fetched${d.revision ? ` ${d.revision}` : ''}${view}, not indexed yet`; }
    if (d.missing) { return d.inventory?.user ? 'file not found: removed or moved since it was added in the CMSIS view' : 'missing on disk'; }
    if (d.unsupported) { return `not a PDF${view}`; }
    if (d.indexed) { return `indexed${d.revision ? ` ${d.revision}` : ''}, ${d.pages ?? '?'} ${unitLabel(d)}${view}`; }
    return `${formatBytes(d.sizeBytes)}${view}, not indexed yet`;
}

function docRow(d: DocRef): string {
    const cat = d.category ? ` [${d.category}]` : '';
    return `  ${d.id} · ${d.scope}${cat} · ${d.title} · ${docState(d)}`;
}

export interface DocListInfo {
    /** Workspace docs folders that exist, for the group header. */
    workspaceDirs?: string[];
    /** `Cortex-M33 r0p0 (Armv8-M)` — for the Arm documents group header. */
    processors?: string;
}

function armRow(d: DocRef): string {
    return `  ${d.id} · ${d.kind ?? 'arm'} · ${d.title} · ${docState(d)}`;
}

/**
 * Offered when the target's documents do not answer. The web is for finding
 * a PDF to fetch, never for the answer itself, and the user is asked first.
 */
export const INTERNET_HINT = 'If the target\'s documents do not cover it, the missing manual or datasheet may be on the vendor\'s site: ' +
    'with the user\'s consent, find its PDF URL on the web and fetch_doc { url } to make it searchable here. Do not take register meanings from web snippets.';

export function renderDocList(resolution: string, docs: DocRef[], notes: string[], info: DocListInfo = {}): string {
    const lines: string[] = [resolution];
    if (info.processors) { lines.push(`Core: ${info.processors}`); }
    for (const n of notes) { lines.push(`Note: ${n}`); }
    if (!docs.length) {
        lines.push('No documents: the packs declare no <book> elements and contain no PDFs' +
            (info.workspaceDirs?.length ? `, and ${info.workspaceDirs.join(', ')} holds none.` : '.'));
        lines.push(INTERNET_HINT);
        return lines.join('\n');
    }
    const packDocs = docs.filter(d => d.scope !== 'workspace' && d.scope !== 'arm' && d.scope !== 'user' && d.scope !== 'project');
    const projectDocs = docs.filter(d => d.scope === 'project');
    const armDocs = docs.filter(d => d.scope === 'arm');
    const userDocs = docs.filter(d => d.scope === 'user');
    const wsDocs = docs.filter(d => d.scope === 'workspace');
    lines.push(`${docs.length} documents (id · scope · title · state):`);
    const { shown, hidden } = truncateList(packDocs, 60);
    for (const d of shown) { lines.push(docRow(d)); }
    if (hidden) { lines.push(`  … ${hidden} more`); }
    if (armDocs.length) {
        lines.push(`Arm documents${info.processors ? ` for ${info.processors}` : ''} (id · kind · title · state) — architecture, debug interface, CoreSight, trace, core TRM, NPU; fetch_doc { doc } downloads one:`);
        const arm = truncateList(armDocs, 40);
        for (const d of arm.shown) { lines.push(armRow(d)); }
        if (arm.hidden) { lines.push(`  … ${arm.hidden} more`); }
    }
    if (projectDocs.length) {
        lines.push('Project documents (.cmsis/docs.yml of the csolution, shared with the project):');
        const p = truncateList(projectDocs, 30);
        for (const d of p.shown) { lines.push(docRow(d)); }
        if (p.hidden) { lines.push(`  … ${p.hidden} more`); }
    }
    if (userDocs.length) {
        lines.push('Documents added by the user (the document service):');
        const u = truncateList(userDocs, 30);
        for (const d of u.shown) { lines.push(docRow(d)); }
        if (u.hidden) { lines.push(`  … ${u.hidden} more`); }
    }
    if (wsDocs.length) {
        lines.push(`Workspace documents (${(info.workspaceDirs ?? []).join(', ') || 'workspace docs folders'}):`);
        const ws = truncateList(wsDocs, 30);
        for (const d of ws.shown) { lines.push(docRow(d)); }
        if (ws.hidden) { lines.push(`  … ${ws.hidden} more`); }
    }
    const readable = docs.filter(isReadable);
    const inPacks = readable.filter(d => d.source === 'pack').length;
    const inWorkspace = readable.filter(d => d.source === 'workspace').length;
    const inUser = readable.filter(d => d.source === 'user').length;
    const fetched = readable.filter(d => d.source === 'web').length;
    const web = docs.filter(d => d.source === 'web' && !isReadable(d));
    lines.push(`${readable.length} searchable (${inPacks} in packs${inUser ? `, ${inUser} user` : ''}${inWorkspace ? `, ${inWorkspace} in the workspace` : ''}${fetched ? `, ${fetched} fetched` : ''}; ` +
        `${readable.filter(d => d.indexed).length} indexed)` +
        `${web.length ? `, ${web.length} on the web not fetched (fetch_doc { doc })` : ''}.`);
    lines.push('Next: search_target_docs { query } searches the documents; read_doc_pages { doc, pages } reads pages.');
    return lines.join('\n');
}

export interface SearchInfo {
    resolution: string;
    indexedNow: { doc: DocRef; ms: number }[];
    skipped: { doc: DocRef; reason: string }[];
    searched: DocRef[];
    web: DocRef[];
    /** Unlisted pack PDFs left out of this search. */
    unlistedSkipped?: DocRef[];
    /** Identifiers expanded from the SVD, one note each (`USART1 (peripheral): universal …`). */
    expandedWith?: string[];
    ms: number;
}

export function renderSearch(query: string, hits: SearchHit[], info: SearchInfo): string {
    const lines: string[] = [info.resolution];
    if (info.indexedNow.length) {
        lines.push(`Indexed now: ${info.indexedNow.map(x => `${x.doc.id} (${x.doc.pages ?? '?'} p, ${(x.ms / 1000).toFixed(1)} s)`).join(', ')}`);
    }
    for (const s of info.skipped) { lines.push(`Skipped ${s.doc.id}: ${s.reason}`); }
    if (!info.searched.length) {
        lines.push(`Nothing to search for "${query}": no indexed documents.` +
            (info.web.length ? ` ${info.web.length} web documents are listed by list_target_docs.` : ''));
        return lines.join('\n');
    }
    lines.push(`Searched ${info.searched.length} document${info.searched.length === 1 ? '' : 's'} ` +
        `(${info.searched.reduce((n, d) => n + (d.pages ?? 0), 0)} pages) for "${query}" in ${info.ms} ms — ${hits.length} hit${hits.length === 1 ? '' : 's'}:`);
    if (info.expandedWith?.length) {
        lines.push(`Expanded from the SVD (lower weight): ${info.expandedWith.join('; ')}`);
    }
    hits.forEach((h, i) => {
        const rev = h.doc.revision ? ` [${h.doc.revision}]` : '';
        lines.push(`#${i + 1} ${h.doc.id}${rev} ${unitLabel(h.doc)}.${h.page}${h.heading ? ` §${h.heading}` : ''}  (score ${h.score.toFixed(1)})`);
        lines.push(`   ${h.snippet}`);
    });
    if (!hits.length) {
        lines.push('No page contains the query terms. Try the register or peripheral name as written in the manual, or fewer words.');
    } else {
        const top = hits[0];
        lines.push(`Next: read_doc_pages { doc: '${top.doc.id}', pages: '${top.page}' } for the full page; add a doc argument to narrow the search.`);
    }
    if (info.web.length) {
        lines.push(`Not searched: ${info.web.length} web document${info.web.length === 1 ? '' : 's'} not fetched yet ` +
            `(${info.web.slice(0, 3).map(d => d.id).join(', ')}${info.web.length > 3 ? ', …' : ''}) — fetch_doc { doc } makes one searchable.`);
    }
    const unlisted = info.unlistedSkipped ?? [];
    if (unlisted.length) {
        lines.push(`Not searched: ${unlisted.length} unlisted PDF${unlisted.length === 1 ? '' : 's'} in the pack not attributed to this device/board ` +
            `(includeUnlisted: true or a doc filter searches them).`);
    }
    if (!hits.length) { lines.push(INTERNET_HINT); }
    return lines.join('\n');
}

function citeHint(doc: DocRef): string {
    return `Cite as ${doc.id}${doc.revision ? ` ${doc.revision}` : ''} ${unitLabel(doc)}.<n>.`;
}

/** The result of a successful fetch_doc: what was fetched, which edition, and what to call next. */
export function renderFetch(doc: DocRef, outcome: FetchOutcome | undefined, loaded: LoadedDoc, ms: number): string {
    const lines: string[] = [];
    const edition = doc.arm?.resolvedVersion
        ? `version ${doc.arm.resolvedVersion}${doc.revision ? ` (${doc.revision})` : ''}`
        : (doc.revision ? `edition ${doc.revision}` : undefined);
    const size = formatBytes(doc.sizeBytes);
    if (outcome?.ok) {
        const what = [doc.title, edition, outcome.record.filename, size].filter(Boolean).join(', ');
        lines.push(`Fetched ${doc.id} — ${what} → indexed ${loaded.meta.pageCount} ${unitLabel(doc)} in ${(ms / 1000).toFixed(1)} s.`);
        lines.push(`From ${doc.url} (${outcome.resolver}); ${doc.service ? `kept by the document service (${doc.service.view}), not in the workspace` : 'cached in the extension storage, not in the workspace'}.`);
    } else if (fromSolutionCopy(doc)) {
        lines.push(`Downloaded by CMSIS Solution (${doc.path}): ${doc.id} — ${[doc.title, edition, size].filter(Boolean).join(', ')}; `
            + `indexed ${loaded.meta.pageCount} ${unitLabel(doc)}, nothing downloaded again.`);
    } else {
        lines.push(`Already fetched ${doc.id} — ${[doc.title, edition, size].filter(Boolean).join(', ')}; indexed ${loaded.meta.pageCount} ${unitLabel(doc)}. Pass refresh: true to download again.`);
    }
    const alternatives = outcome?.ok ? outcome.resolved.alternatives : undefined;
    if (alternatives?.length) {
        lines.push(`Note: this edition is an errata document; other editions: ${alternatives.map(a => `${a.version} (${a.versionLabel})`).join(', ')}` +
            (doc.arm ? ` — fetch_doc { doc: 'arm/${doc.arm.docId}-${alternatives[0].version}' }.` : '.'));
    }
    lines.push(`Next: search_target_docs { query, doc: '${doc.id}' } or read_doc_pages { doc: '${doc.id}', pages }. ${citeHint(doc)}`);
    return lines.join('\n');
}

/**
 * A failed fetch_doc: the reason, what is known about the document, and the
 * manual way out. `attempts`, the failed downloads of the document since the
 * window started; from the second on, the manual way comes first.
 */
export function renderFetchFailure(
    doc: DocRef, outcome: Extract<FetchOutcome, { ok: false }>, dropFolder: string | undefined, attempts = 1,
): string {
    const tries = attempts > 1 ? ` (${attempts} attempts failed)` : '';
    const lines: string[] = [`Could not fetch ${doc.id}${tries}: ${outcome.error}.`];
    if (attempts > 1 && doc.service !== undefined) {
        lines.push(`Do not call fetch_doc for it again: ask the user to download the PDF and use Import a File on it in ${doc.service.view}; `
            + 'the next fetch_doc or search reads that copy.');
    } else if (attempts > 1 && dropFolder) {
        lines.push(`Do not call fetch_doc for it again: ask the user to download the PDF into ${dropFolder} in the workspace; `
            + 'list_target_docs then lists it as a workspace document.');
    }
    const r = outcome.resolved;
    if (r) {
        const known = [r.title, r.versionLabel ? `edition ${r.versionLabel}` : undefined, r.version ? `version ${r.version}` : undefined].filter(Boolean).join(', ');
        if (known) { lines.push(`Document: ${known}.`); }
    }
    if (doc.url) { lines.push(`URL: ${doc.url}`); }
    if (doc.service !== undefined) {
        lines.push(`The request is recorded in ${doc.service.view}: ask the user to use Download there, or, when the site needs a login, `
            + 'to open the page, download the PDF and use Import a File on the document; the next fetch_doc reads that copy.');
    } else if (doc.inventory?.parent !== undefined && doc.inventory.parent.tag !== 'common') {
        lines.push('The CMSIS view lists this document for the target: ask the user to use Download Document on it there, or, when the site '
            + 'needs a login, to open the URL, download the PDF and use Import Document on it; the next fetch_doc reads that copy.');
    }
    if (dropFolder && attempts <= 1 && doc.service === undefined) {
        lines.push(`Alternative: download the PDF yourself into ${dropFolder} in the workspace; list_target_docs then lists it as a workspace document.`);
    }
    return lines.join('\n');
}

/** A download that outlived the call that waited for it: how far it got, and that the next call picks it up. */
export function renderDownloadRunning(doc: DocRef, bytes: number, total: number | undefined, elapsedMs: number): string {
    let host = '';
    try {
        host = doc.url ? ` from ${new URL(doc.url).hostname}` : '';
    } catch {
        host = '';
    }
    const got = bytes === 0 ? 'no bytes yet' : `${formatBytes(bytes)}${total ? ` of ${formatBytes(total)}` : ''}`;
    return `Downloading ${doc.id}${host}: ${got} after ${Math.round(elapsedMs / 1000)} s. The download goes on without this call; `
        + `call fetch_doc { doc: '${doc.id}' } again to wait for it and index it. Calls meanwhile join the same download.`;
}

/** "519", "519-521", "519,523" → 1-based page numbers within [1, max]. */
export function parsePageRange(spec: string, max: number): { pages: number[] } | { error: string } {
    const pages: number[] = [];
    for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) { return { error: `pages '${spec}' is not a page number, range (519-521) or list (519,523)` }; }
        const a = parseInt(m[1], 10);
        const b = m[2] ? parseInt(m[2], 10) : a;
        if (a < 1 || b < a) { return { error: `pages '${part}': invalid range` }; }
        for (let p = a; p <= b && pages.length < 50; p++) { pages.push(p); }
    }
    if (!pages.length) { return { error: 'pages is empty' }; }
    const outside = pages.filter(p => p > max);
    if (outside.length === pages.length) { return { error: `page ${pages[0]} is beyond the last page (${max})` }; }
    return { pages: pages.filter(p => p <= max) };
}

export function renderPages(doc: DocRef, records: PageRecord[], maxChars: number): string {
    const lines: string[] = [];
    let budget = maxChars;
    for (const r of records) {
        const rev = doc.revision ? ` [${doc.revision}]` : '';
        const header = `— ${doc.id}${rev} ${unitLabel(doc)}.${r.p}${r.heading ? ` §${r.heading}` : ''} (of ${doc.pages ?? '?'}) —`;
        if (budget <= 0) {
            lines.push(`${header} omitted: maxChars reached (pass a smaller range or a larger maxChars)`);
            continue;
        }
        const text = r.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const body = clipValue(text, budget);
        budget -= Math.min(text.length, budget);
        lines.push(header, body, '');
    }
    return lines.join('\n').trimEnd();
}
