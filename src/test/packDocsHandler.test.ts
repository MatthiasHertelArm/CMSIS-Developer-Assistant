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
 * End to end through the handler: a synthetic pack root with the trimmed
 * pdsc fixtures and the two-page test PDF, a workspace with a cbuild-run
 * file, and the three tools. Real pdftotext when present; the search and
 * read tests skip otherwise.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PackDocsHost, PackDocsLog, defaultSettings } from '../core/packDocs/host';
import { PdfExtractor, PdftotextExtractor } from '../core/packDocs/pdfExtract';
import { collectTargetDocs, resolveSvd, resolveTarget } from '../core/packDocs/targetDocs';
import { textOf } from '../core/toolResult';
import { PackDocsHandler } from '../packDocsHandler';
import { SAMPLE_CBUILD_RUN } from './cbuildRun.test';
import { ARM_ROUTES, fakeFetch, json, pdf } from './webFetch.test';
import { parentKey } from '../docService/contract';
import { EmulatedDocumentService } from '../docService/emulator';
import { documentEngine } from '../core/packDocs/documentEngine';

export class FakeExtractor implements PdfExtractor {
    readonly name = 'fake';
    constructor(private readonly pages: string[]) { }
    async available() { return { ok: true, detail: 'fake' }; }
    async extract() { return { pages: this.pages, extractor: this.name, ms: 1 }; }
}

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

export interface World {
    root: string;
    packRoot: string;
    workspace: string;
    host: PackDocsHost;
    lines: string[];
    fetchCalls: { url: string; init?: RequestInit }[];
    /** The world runs the documentation tools through the document service. */
    serviceOn?: boolean;
}

export function buildWorld(options: { service?: boolean } = { service: true }): World {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-e2e-'));
    const packRoot = path.join(root, 'packs');
    const dfp = path.join(packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0');
    const bsp = path.join(packRoot, 'Keil', 'NUCLEO-F756ZG_BSP', '2.0.0');
    fs.mkdirSync(path.join(dfp, 'Documentation'), { recursive: true });
    fs.mkdirSync(path.join(dfp, 'CMSIS', 'SVD'), { recursive: true });
    fs.mkdirSync(path.join(bsp, 'Documents'), { recursive: true });
    // The DFP fixture lists web books only; add a local one, an unlisted PDF, and an SVD for the STM32F756ZG device.
    const pdsc = fs.readFileSync(path.join(FIXTURES, 'Keil.STM32F7xx_DFP.pdsc'), 'utf-8')
        .replace('<subFamily DsubFamily="STM32F756">', '<subFamily DsubFamily="STM32F756">\n        <book name="Documentation/test-rm.pdf" title="Test Reference Manual" category="manual"/>')
        .replace('<device Dname="STM32F756ZG">', '<device Dname="STM32F756ZG">\n          <debug svd="CMSIS/SVD/test.svd"/>');
    fs.writeFileSync(path.join(dfp, 'Keil.STM32F7xx_DFP.pdsc'), pdsc);
    fs.copyFileSync(path.join(FIXTURES, 'test.svd'), path.join(dfp, 'CMSIS', 'SVD', 'test.svd'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(dfp, 'Documentation', 'test-rm.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(dfp, 'Documentation', 'unlisted-errata.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'Keil.NUCLEO-F756ZG_BSP.pdsc'), path.join(bsp, 'Keil.NUCLEO-F756ZG_BSP.pdsc'));
    fs.writeFileSync(path.join(bsp, 'Documents', 'README.md'), '# guide');

    const workspace = path.join(root, 'ws');
    fs.mkdirSync(path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug', 'Blinky+STM32F756ZGTx.cbuild-run.yml'), SAMPLE_CBUILD_RUN);
    // Documents the user dropped into the workspace docs folders.
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.agent-artifacts', 'docs'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(workspace, 'docs', 'board-um.pdf'));
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), path.join(workspace, '.agent-artifacts', 'docs', 'vendor-rm.pdf'));

    const lines: string[] = [];
    const log: PackDocsLog = {
        debug: (m) => lines.push(`D ${m}`), info: (m) => lines.push(`I ${m}`), warn: (m) => lines.push(`W ${m}`),
        error: (m, e) => lines.push(`E ${m} ${e instanceof Error ? e.message : e ?? ''}`),
    };
    // arm.com as the fixtures saw it, plus the Cortex-M7 GUG the DFP links (served with the Armv8-M ARM's JSON, retitled).
    const gug = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'arm', 'ddi0553-latest.json'), 'utf-8'));
    gug.document = 'dui0646'; gug.title = 'Cortex-M7 Devices Generic User Guide'; gug.version = 'a'; gug.versionLabel = 'r1p2';
    gug._links.resources = [{ href: 'https://documentation-service.arm.com/static/000000000000000000000646?token=', name: 'DUI0646C_cortex_m7_dgug.pdf', extension: 'pdf', contentType: 'application/pdf' }];
    const fake = fakeFetch({
        ...ARM_ROUTES,
        'https://documentation-service.arm.com/documentation/dui0646/latest': () => new Response(JSON.stringify(gug), { status: 200, headers: { 'content-type': 'application/json' } }),
        'https://documentation-service.arm.com/static/000000000000000000000646': pdf(fs.readFileSync(path.join(FIXTURES, 'test-rm.pdf')), 'DUI0646C_cortex_m7_dgug.pdf'),
        'https://documentation-service.arm.com/documentation/ddi0000/latest': json('html-only.json'),
    });

    const host: PackDocsHost = {
        packRoot,
        storageDir: path.join(root, 'store'),
        assetsDir: path.join(__dirname, '..', '..', '..', 'assets'),
        // A private user documents folder: the default (~/.cmsis-pack-docs/user)
        // is the developer's real one and its contents would change the counts.
        settings: () => ({ ...defaultSettings, userDocsDir: path.join(root, 'user') }),
        log,
        userAgent: 'cmsis-pack-docs/test',
        fetchFn: fake.fn,
        workspaceFolders: () => [workspace],
        findCbuildRunFiles: async () => [path.join(workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug', 'Blinky+STM32F756ZGTx.cbuild-run.yml')],
    };
    const world: World = { root, packRoot, workspace, host, lines, fetchCalls: fake.calls };
    world.serviceOn = options.service === true;
    if (options.service) {
        // The same world with the document service (2.9.2): every download goes through the emulator.
        Object.assign(host, serviceWith(world, fake.fn));
    }
    return world;
}

/** A document service over the world's root whose engine fetches with `fetchFn`; empty without one in the world. */
export function serviceWith(world: World, fetchFn: (url: string, init?: RequestInit) => Promise<Response>): Partial<PackDocsHost> {
    if (world.host.documentService === undefined && !world.serviceOn) {
        return {};
    }
    const service = new EmulatedDocumentService({ root: path.join(world.root, `docservice-${Math.random().toString(16).slice(2, 8)}`),
        engine: documentEngine({ fetchFn, userAgent: 'cmsis-pack-docs/test', log: world.host.log, timeoutMs: 30_000, maxBytes: 150 * 1024 * 1024 }) });
    return { documentService: () => ({ service, view: 'the Target Documents view' }) };
}

suite('PackDocsHandler (end to end, through the document service)', () => {
    let world: World;
    let handler: PackDocsHandler;
    let havePdftotext = false;

    suiteSetup(async () => {
        world = buildWorld();
        handler = new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace });
        havePdftotext = (await new PdftotextExtractor().available()).ok;
    });

    test('resolveTarget reads the workspace cbuild-run and falls back to installed pack versions', async () => {
        const res = await resolveTarget(world.host, {});
        assert.ok(!('error' in res));
        assert.strictEqual(res.device?.name, 'STM32F756ZGTx');
        assert.strictEqual(res.devicePack?.version, '3.0.0');
        const byPack = await resolveTarget(world.host, { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756ZGTx' });
        assert.ok(!('error' in byPack));
        assert.match(byPack.notes[0], /using installed 3\.0\.0/);
        const none = await resolveTarget({ ...world.host, findCbuildRunFiles: async () => [] }, {});
        assert.ok('error' in none);
        assert.match(none.error, /No \*\.cbuild-run\.yml found in the workspace/);
        const missing = await resolveTarget(world.host, { target: 'nonexistent' });
        assert.ok('error' in missing && /No cbuild-run context matches target 'nonexistent'/.test(missing.error));
    });

    test('resolveTarget looks under the pack root the CMSIS Solution extension reports', async () => {
        // The host's own packRoot points nowhere; only the toolchain hook knows the real one.
        const viaHook = await resolveTarget({ ...world.host, packRoot: '/nowhere', packRootFromToolchain: async () => world.packRoot }, { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756ZGTx' });
        assert.ok(!('error' in viaHook), JSON.stringify(viaHook));
        assert.strictEqual(viaHook.devicePack?.version, '3.0.0');

        // An empty, undefined or failing answer keeps the host's packRoot.
        for (const hook of [async () => '', async () => '  ', async () => undefined, async () => { throw new Error('not active'); }]) {
            const kept = await resolveTarget({ ...world.host, packRootFromToolchain: hook }, { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756ZGTx' });
            assert.ok(!('error' in kept), JSON.stringify(kept));
            const nowhere = await resolveTarget({ ...world.host, packRoot: '/nowhere', packRootFromToolchain: hook }, { pack: 'Keil::STM32F7xx_DFP' });
            assert.ok('error' in nowhere && nowhere.error.includes('/nowhere'), JSON.stringify(nowhere));
        }
    });

    test('the document list, the SVD lookup and the core header follow the pack root the toolchain reports', async () => {
        // A plain object host, no getter: only the hook knows the real root, and the
        // resolution must carry it to every consumer.
        const host: PackDocsHost = { ...world.host, packRoot: '/nowhere', packRootFromToolchain: async () => world.packRoot };
        const res = await resolveTarget(host, { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756ZGTx' });
        assert.ok(!('error' in res), JSON.stringify(res));
        assert.strictEqual(res.packRoot, world.packRoot);

        const t = collectTargetDocs(host, res);
        assert.ok(t.docs.some(d => d.title === 'Test Reference Manual' && d.path?.startsWith(world.packRoot)), t.docs.map(d => d.id).join(', '));
        assert.ok(t.processors.length > 0, 'processors come from the pdsc under the reported root');
        assert.ok(!t.notes.some(n => n.includes('/nowhere')), t.notes.join('; '));
        const svd = resolveSvd(host, res);
        assert.ok(svd?.exists && svd.path.startsWith(world.packRoot), JSON.stringify(svd));

        const h = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace });
        const listing = textOf(await h.handleListTargetDocs({}));
        assert.ok(listing.includes('Test Reference Manual') && !listing.includes('/nowhere'), listing);
        const inspection = await h.inspectTarget({});
        assert.ok(inspection.svd?.exists, JSON.stringify(inspection.svd));

        // Without a hook the resolution records the host's own root.
        const own = await resolveTarget({ ...world.host, packRoot: '/nowhere' }, { pack: 'Keil::STM32F7xx_DFP@3.0.0', device: 'STM32F756ZGTx' });
        assert.ok(!('error' in own) && own.packRoot === '/nowhere', JSON.stringify(own));
    });

    test('resolveTarget prefers the active csolution context when the workspace holds several solutions', async () => {
        // A second solution (a fixture next to the real project) with another device.
        const other = SAMPLE_CBUILD_RUN
            .replace('solution: TFLiteRT_HelloWorld.csolution.yml', 'solution: ../Blinky.csolution.yml')
            .replace('target-type: STM32F756ZGTx', 'target-type: MPS3')
            .replace('device: STMicroelectronics::STM32F756ZGTx', 'device: ARM::SSE-300-MPS3');
        const otherFile = path.join(world.workspace, 'fixture', 'Blinky+MPS3.cbuild-run.yml');
        fs.mkdirSync(path.dirname(otherFile), { recursive: true });
        fs.writeFileSync(otherFile, other);
        const both = [...(await world.host.findCbuildRunFiles()), otherFile];

        const ambiguous = await resolveTarget({ ...world.host, findCbuildRunFiles: async () => both }, {});
        assert.ok('error' in ambiguous && /2 cbuild-run contexts with different targets — pass target/.test(ambiguous.error),
            'without a hint the ambiguity is reported as before');

        const hinted = await resolveTarget({
            ...world.host, findCbuildRunFiles: async () => both,
            activeContext: async () => ({ solution: 'TFLiteRT_HelloWorld', targetType: 'STM32F756ZGTx' }),
        }, {});
        assert.ok(!('error' in hinted));
        assert.strictEqual(hinted.device?.name, 'STM32F756ZGTx');
        assert.match(hinted.notes.join('\n'), /active csolution context TFLiteRT_HelloWorld \(STM32F756ZGTx\): using TFLiteRT_HelloWorld\+STM32F756ZGTx|using Blinky\+STM32F756ZGTx/);

        const bySolutionPath = await resolveTarget({
            ...world.host, findCbuildRunFiles: async () => both,
            activeContext: async () => ({ solution: 'Blinky' }),
        }, {});
        assert.ok(!('error' in bySolutionPath) && bySolutionPath.device?.name === 'SSE-300-MPS3',
            'a relative solution: path in the cbuild-run matches the bare csolution name');

        const stale = await resolveTarget({
            ...world.host, findCbuildRunFiles: async () => both,
            activeContext: async () => ({ solution: 'Elsewhere', targetType: 'HP' }),
        }, {});
        assert.ok('error' in stale && /Active csolution Elsewhere \(HP\) has no cbuild-run here/.test(stale.error)
            && /pass target/.test(stale.error), 'a hint that matches nothing still lists the contexts');

        const explicit = await resolveTarget({
            ...world.host, findCbuildRunFiles: async () => both,
            activeContext: async () => { throw new Error('extension gone'); },
        }, { target: 'MPS3' });
        assert.ok(!('error' in explicit) && explicit.device?.name === 'SSE-300-MPS3', 'target wins and a failing hint is ignored');
    });

    test('list_target_docs lists device, family, board, unlisted and workspace documents with states', async () => {
        const text = textOf(await handler.handleListTargetDocs({}));
        assert.match(text, /^Target: device STMicroelectronics::STM32F756ZGTx, device-pack Keil::STM32F7xx_DFP@3\.0\.0, board NUCLEO-F756ZG:Rev\.B, board-pack Keil::NUCLEO-F756ZG_BSP@2\.0\.0 — from out\/Blinky/);
        assert.match(text, /stm32f7xx-dfp\/test-rm · subFamily \[manual\] · Test Reference Manual · 1 kB, not indexed yet/);
        assert.match(text, /stm32f7xx-dfp\/stm32f756bg · subFamily · STM32F756 Data Sheet · web — not fetched \(fetch_doc \{ doc: 'stm32f7xx-dfp\/stm32f756bg' \}\)/);
        assert.match(text, /arm\/dui0646-latest · family · Cortex-M7 Generic User Guide · web — not fetched/);
        assert.match(text, /stm32f7xx-dfp\/unlisted-errata · unlisted · unlisted-errata/);
        assert.match(text, /nucleo-f756zg-bsp\/um1974[^\n]* · board \[manual\] · User Manual · web — not fetched/);
        assert.match(text, /nucleo-f756zg-bsp\/readme · board \[other\] · Guide · not a PDF/);
        assert.match(text, /\nCore: Cortex-M7 r0p1 \(Armv7-M\)\n/);
        assert.match(text, /Arm documents for Cortex-M7 r0p1 \(Armv7-M\) \(id · kind · title · state\)[^\n]*\n  arm\/ddi0403-latest · arch · ARMv7-M Architecture Reference Manual · web — not fetched \(fetch_doc \{ doc: 'arm\/ddi0403-latest' \}\)\n  arm\/ihi0031-latest · adi · /);
        assert.match(text, /\n  arm\/ddi0489-latest · trm · Cortex-M7 Processor Technical Reference Manual · web — not fetched/);
        assert.doesNotMatch(text, /arm\/ddi0553-latest/, 'Armv8-M documents are not offered for a Cortex-M7');
        assert.match(text, /Workspace documents \(ws\/\.agent-artifacts\/docs, ws\/docs\):\n  workspace\/board-um · workspace · board-um · 1 kB, not indexed yet\n  workspace\/vendor-rm · workspace · vendor-rm · 1 kB, not indexed yet/);
        assert.match(text, /4 searchable \(2 in packs, 2 in the workspace; 0 indexed\), \d+ on the web not fetched/);
        assert.ok(world.lines.some(l => /\[list_target_docs #1\] → \{\}/.test(l)), 'call trace');
        assert.ok(world.lines.some(l => /\[list_target_docs #1\] ← \d+ ms, \d+ bytes/.test(l)), 'result trace');
    });

    test('search_target_docs indexes on first use and cites page and section', async function () {
        if (!havePdftotext) { this.skip(); return; }
        const text = textOf(await handler.handleSearchTargetDocs({ query: 'GPIOAEN clock enable' }));
        assert.match(text, /Indexed now: stm32f7xx-dfp\/test-rm \(2 p, [\d.]+ s\), workspace\/board-um \(2 p, [\d.]+ s\), workspace\/vendor-rm \(2 p, [\d.]+ s\)\n/,
            'the attributed book and the workspace documents are indexed, the unlisted PDF is not');
        assert.match(text, /Searched 3 documents \(6 pages\)/);
        assert.match(text, /#1 (stm32f7xx-dfp\/test-rm|workspace\/[a-z-]+) p\.1 §6\.3\.10 RCC AHB1 peripheral clock enable register \(RCC_AHB1ENR\)/);
        assert.match(text, /«GPIOAEN»/);
        assert.match(text, /Not searched: \d+ web documents/);
        assert.match(text, /Not searched: 1 unlisted PDF in the pack/);
        assert.ok(world.lines.some(l => /extracting test-rm\.pdf/.test(l)), 'extraction trace');

        const withUnlisted = textOf(await handler.handleSearchTargetDocs({ query: 'GPIOAEN clock enable', includeUnlisted: true }));
        assert.match(withUnlisted, /Indexed now: stm32f7xx-dfp\/unlisted-errata/);
        assert.match(withUnlisted, /Searched 4 documents \(8 pages\)/);
        assert.doesNotMatch(withUnlisted, /unlisted PDF in the pack/);

        const again = textOf(await handler.handleSearchTargetDocs({ query: '0x40023800', doc: 'test-rm' }));
        assert.doesNotMatch(again, /Indexed now/);
        assert.match(again, /Searched 1 document \(2 pages\)/);
        assert.match(again, /#1 stm32f7xx-dfp\/test-rm p\.2/);

        const ws = textOf(await handler.handleSearchTargetDocs({ query: '0x40023800', doc: 'workspace/board-um' }));
        assert.match(ws, /Searched 1 document \(2 pages\)/);
        assert.match(ws, /#1 workspace\/board-um p\.2/);

        // An identifier is expanded from the device SVD; the manual is found through the expansion.
        const expanded = textOf(await handler.handleSearchTargetDocs({ query: 'GPIOAEN', doc: 'test-rm' }));
        assert.match(expanded, /Expanded from the SVD \(lower weight\): GPIOAEN \(field of RCC_AHB1ENR\): .*port/);
        assert.match(expanded, /#1 stm32f7xx-dfp\/test-rm p\.1/);
        const quoted = textOf(await handler.handleSearchTargetDocs({ query: '"IO port A clock"', doc: 'test-rm' }));
        assert.doesNotMatch(quoted, /Expanded from the SVD/);

        const listed = textOf(await handler.handleListTargetDocs({}));
        assert.match(listed, /Test Reference Manual · indexed, 2 p/);
        assert.match(listed, /workspace\/board-um · workspace · board-um · indexed, 2 p/);
        assert.match(listed, /4 searchable \(2 in packs, 2 in the workspace; 4 indexed\)/);
    });

    test('read_doc_pages returns the page text under the budget', async function () {
        if (!havePdftotext) { this.skip(); return; }
        const text = textOf(await handler.handleReadDocPages({ doc: 'stm32f7xx-dfp/test-rm', pages: '2' }));
        assert.match(text, /^— stm32f7xx-dfp\/test-rm p\.2 §6\.3\.11 RCC AHB2 peripheral clock enable register \(RCC_AHB2ENR\) \(of 2\) —/);
        assert.match(text, /OTGFSEN/);
        const short = textOf(await handler.handleReadDocPages({ doc: 'test-rm', pages: '1-2', maxChars: 500 }));
        assert.match(short, /p\.1 .*—\n/);
        const bad = textOf(await handler.handleReadDocPages({ doc: 'test-rm', pages: '9' }));
        assert.match(bad, /beyond the last page \(2\)/);
        const ws = textOf(await handler.handleReadDocPages({ doc: 'workspace/vendor-rm', pages: '1' }));
        assert.match(ws, /^— workspace\/vendor-rm p\.1 §6\.3\.10 RCC AHB1/);
        const web = textOf(await handler.handleReadDocPages({ doc: 'stm32f7xx-dfp/stm32f756bg', pages: '1' }));
        assert.match(web, /is not fetched yet — call fetch_doc \{ doc: 'stm32f7xx-dfp\/stm32f756bg' \}/);
    });

    test('fetch_doc downloads an arm.com document through the service API, indexes it, and makes it searchable and citable with its edition', async () => {
        const h = new PackDocsHandler(world.host, {
            timeoutMs: 30_000, workspaceRoot: () => world.workspace,
            extractor: new FakeExtractor(['1 Debug\nDHCSR C_DEBUGEN halting', '2 Reset\nSYSRESETREQ VECTRESET']),
        });
        assert.match(textOf(await h.handleFetchDoc({})), /Pass doc .* or url/);
        assert.match(textOf(await h.handleFetchDoc({ doc: 'no-such-doc' })), /No document with id 'no-such-doc'/);
        assert.match(textOf(await h.handleFetchDoc({ doc: 'stm32f7xx-dfp/test-rm' })), /is a local document/);
        assert.match(textOf(await h.handleFetchDoc({ url: 'ftp://x/y.pdf' })), /is not an http\(s\) URL/);

        // The pdsc-linked Cortex-M7 GUG, by its id.
        const fetched = textOf(await h.handleFetchDoc({ doc: 'arm/dui0646-latest' }));
        assert.match(fetched, /^Fetched arm\/dui0646-latest — Cortex-M7 Devices Generic User Guide, version a \(r1p2\), DUI0646C_cortex_m7_dgug\.pdf, 1 kB → indexed 2 p in [\d.]+ s\.\nFrom https:\/\/developer\.arm\.com\/documentation\/dui0646\/latest \(arm\.com\); kept by the document service/);
        assert.match(fetched, /Cite as arm\/dui0646-latest r1p2 p\.<n>\./);
        assert.match(textOf(await h.handleFetchDoc({ doc: 'dui0646' })), /^Already fetched arm\/dui0646-latest — Cortex-M7 Devices Generic User Guide, version a \(r1p2\), 1 kB; indexed 2 p/);

        const search = textOf(await h.handleSearchTargetDocs({ query: 'C_DEBUGEN', doc: 'dui0646' }));
        assert.match(search, /Searched 1 document \(2 pages\)/);
        assert.match(search, /#1 arm\/dui0646-latest \[r1p2\] p\.1 §1 Debug/);
        const all = textOf(await h.handleSearchTargetDocs({ query: 'VECTRESET' }));
        // Presence, not rank: VECTRESET is identifier-shaped, so the SVD expansion adds its
        // description words and the "1 Debug" heading page can outrank p.2 depending on what
        // else the store has indexed (IDF) — the ranking itself is covered by the search tests.
        assert.match(all, /arm\/dui0646-latest \[r1p2\] p\.2/, 'fetched documents are searched by default');
        assert.match(all, /Not searched: \d+ web documents not fetched yet \(stm32f7xx-dfp\/[^)]*\) — fetch_doc \{ doc \} makes one searchable\./);
        const page = textOf(await h.handleReadDocPages({ doc: 'arm/dui0646-latest', pages: '2' }));
        assert.match(page, /^— arm\/dui0646-latest \[r1p2\] p\.2 §2 Reset \(of 2\) —\n/);
        const listed = textOf(await h.handleListTargetDocs({}));
        assert.match(listed, /arm\/dui0646-latest · family · Cortex-M7 Devices Generic User Guide · indexed r1p2, 2 p/);

        // An Arm document outside the target's catalogue (Armv8-M for a Cortex-M7), by its bare id and by URL; an HTML-only one; a dead URL.
        const arm = textOf(await h.handleFetchDoc({ doc: 'ddi0553' }));
        assert.match(arm, /^Fetched arm\/ddi0553-latest — Armv8-M Architecture Reference Manual, version bz \(B\.z\), DDI0553B_z_armv8m_arm\.pdf/);
        assert.match(textOf(await h.handleFetchDoc({ url: 'https://developer.arm.com/documentation/ddi0553/latest' })), /^Already fetched arm\/ddi0553-latest/);
        assert.match(textOf(await h.handleReadDocPages({ doc: 'arm/ddi0553-latest', pages: '1' })), /^— arm\/ddi0553-latest \[B\.z\] p\.1/);
        // Fetched documents join the target's set from the store, so a new handler (a new session) searches and lists them.
        const h2 = new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const later = textOf(await h2.handleSearchTargetDocs({ query: 'C_DEBUGEN', doc: 'ddi0553' }));
        assert.match(later, /#1 arm\/ddi0553-latest \[B\.z\] p\.1 §1 Debug/);
        const relisted = textOf(await h2.handleListTargetDocs({}));
        assert.match(relisted, /\n  arm\/ddi0553-latest · arch · Armv8-M Architecture Reference Manual · indexed B\.z, 2 p\n/);
        assert.match(relisted, /searchable \(2 in packs, 2 in the workspace, 2 fetched; \d indexed\)/);
        // A bare id takes the catalogue's pinned version; 'latest' can still be asked for explicitly.
        assert.match(textOf(await h.handleFetchDoc({ doc: 'ddi0439' })), /^Fetched arm\/ddi0439-b — /);
        const errata = textOf(await h.handleFetchDoc({ doc: 'ddi0439-latest' }));
        assert.match(errata, /^Fetched arm\/ddi0439-latest — Cortex-M4 Technical Reference Manual - ARM DDI 0439B Errata 01/);
        assert.match(errata, /Note: this edition is an errata document; other editions: b \(r0p0\) — fetch_doc \{ doc: 'arm\/ddi0439-b' \}/);
        const html = textOf(await h.handleFetchDoc({ doc: 'ddi0000' }));
        assert.match(html, /^Could not fetch arm\/ddi0000-latest: arm\/ddi0000-latest is published as HTML on arm\.com \(HTMLPDF\); this version fetches PDFs only\.\nDocument: Example HTML-only Document, edition r1p2, version f\.\nURL: https:\/\/developer\.arm\.com\/documentation\/ddi0000\/latest\nAlternative: download the PDF yourself into \.agent-artifacts\/docs/);
        // What was found is the document service's to keep: the listing reads it from there, in this window and in the next,
        // with the title arm.com gave, and the extension's own store holds no record of it.
        for (const window of [h, new PackDocsHandler(world.host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) })]) {
            assert.match(textOf(await window.handleListTargetDocs({})), /\n  arm\/ddi0000-latest · [^\n]*Example HTML-only Document · web — HTML on arm\.com, not fetchable in this version\n/);
        }
        assert.match(textOf(await h.handleReadDocPages({ doc: 'arm/ddi0000-latest', pages: '1' })), /^arm\/ddi0000-latest is published as HTML on arm\.com and cannot be read in this version/);
        assert.ok(!fs.existsSync(path.join(world.host.storageDir, 'arm', 'ddi0000-latest')), 'no fetch record in the extension\'s own store');
        const dead = textOf(await h.handleFetchDoc({ url: 'https://developer.arm.com/documentation/??' }));
        assert.match(dead, /^Could not fetch web\/developer-arm-com\/[0-9a-f]{12}: .*HTTP 404/);
        assert.ok(world.fetchCalls.length >= 6, 'requests were made');
        assert.ok(world.fetchCalls.every(c => (c.init?.headers as Record<string, string>)['User-Agent'] === 'cmsis-pack-docs/test'), 'every request identifies the extension');
    });

    test('a per-call timeout turns into a timeout reply instead of a hang', async () => {
        const slowHost: PackDocsHost = { ...world.host, findCbuildRunFiles: () => new Promise(resolve => setTimeout(() => resolve([]), 400)) };
        const h = new PackDocsHandler(slowHost, { timeoutMs: 100 });
        const late = await h.handleListTargetDocs({});
        assert.strictEqual(typeof late === 'object' && late.status, 'timeout');
        assert.match(textOf(late), /list_target_docs timed out after 100 ms/);
    });

    test('fetch_doc: a download outlives the call that waited for it, later calls join it, and the one after it ends indexes it', async () => {
        const bytes = fs.readFileSync(path.join(FIXTURES, 'test-rm.pdf'));
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let downloads = 0;
        const url = 'https://slow.example/manual.pdf';
        const { fn } = fakeFetch({
            [url]: (init) => {
                const head = { 'content-type': 'application/pdf', 'content-length': String(bytes.length) };
                if (init?.method === 'HEAD') { return new Response(null, { status: 200, headers: head }); }
                downloads++;
                const half = Math.floor(bytes.length / 2);
                const body = new ReadableStream<Uint8Array>({
                    async start(controller) {
                        controller.enqueue(new Uint8Array(bytes.subarray(0, half)));
                        await gate;
                        controller.enqueue(new Uint8Array(bytes.subarray(half)));
                        controller.close();
                    },
                });
                return new Response(body, { status: 200, headers: head });
            },
        });
        const h = new PackDocsHandler({ ...world.host, storageDir: path.join(world.root, 'store-slow'), fetchFn: fn, ...serviceWith(world, fn) },
            { timeoutMs: 1_800, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Intro\nslow manual']) });

        const first = await h.handleFetchDoc({ url });
        assert.strictEqual(typeof first === 'object' && first.status, 'running', textOf(first));
        assert.match(textOf(first), /^Downloading web\/slow-example\/[0-9a-f]{12} from slow\.example: \d+ (B|kB) of \d+ (B|kB) after \d+ s\. The download goes on without this call; call fetch_doc \{ doc: 'web\/slow-example\/[0-9a-f]{12}' \} again/);
        const second = await h.handleFetchDoc({ url });
        assert.strictEqual(typeof second === 'object' && second.status, 'running');
        assert.strictEqual(downloads, 1, 'the second call joined the first download');

        release();
        const done = textOf(await h.handleFetchDoc({ url }));
        assert.match(done, /^Fetched web\/slow-example\/[0-9a-f]{12} — manual\.pdf/);
        assert.strictEqual(downloads, 1);
        assert.match(textOf(await h.handleFetchDoc({ url })), /^Already fetched /);
    });

    test('fetch_doc: a failed download is counted; from the second failure on the reply sends the user to Import a File', async () => {
        const url = 'https://broken.example/manual.pdf';
        const { fn } = fakeFetch({ [url]: () => new Response('nope', { status: 500 }) });
        const h = new PackDocsHandler({ ...world.host, storageDir: path.join(world.root, 'store-broken'), fetchFn: fn, ...serviceWith(world, fn) },
            { timeoutMs: 5_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const first = textOf(await h.handleFetchDoc({ url }));
        assert.match(first, /^Could not fetch web\/broken-example\/[0-9a-f]{12}: .*HTTP 500\.\n/);
        assert.match(first, /\nThe request is recorded in the Target Documents view: ask the user to use Download there/);
        assert.doesNotMatch(first, /Alternative:/, 'one way out: the view\'s');
        const second = textOf(await h.handleFetchDoc({ url }));
        assert.match(second, /^Could not fetch web\/broken-example\/[0-9a-f]{12} \(2 attempts failed\): .*HTTP 500\.\nDo not call fetch_doc for it again: ask the user to download the PDF and use Import a File on it in the Target Documents view/);
        assert.doesNotMatch(second, /Alternative:/);
    });

    test('fetch_doc: dispose stops a running download and leaves no part file', async () => {
        const bytes = fs.readFileSync(path.join(FIXTURES, 'test-rm.pdf'));
        const url = 'https://stalled.example/manual.pdf';
        const { fn } = fakeFetch({
            [url]: (init) => {
                const head = { 'content-type': 'application/pdf', 'content-length': String(bytes.length) };
                if (init?.method === 'HEAD') { return new Response(null, { status: 200, headers: head }); }
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(bytes.subarray(0, 64)));
                        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
                    },
                });
                return new Response(body, { status: 200, headers: head });
            },
        });
        const store = path.join(world.root, 'store-stalled');
        const h = new PackDocsHandler({ ...world.host, storageDir: store, fetchFn: fn, ...serviceWith(world, fn) },
            { timeoutMs: 1_700, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const first = await h.handleFetchDoc({ url });
        assert.strictEqual(typeof first === 'object' && first.status, 'running', textOf(first));
        h.dispose();
        await new Promise(resolve => setTimeout(resolve, 50));
        const parts: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
                if (entry.isDirectory()) { walk(path.join(dir, entry.name)); } else if (entry.name.endsWith('.part')) { parts.push(entry.name); }
            }
        };
        walk(store);
        assert.deepStrictEqual(parts, []);
        assert.match(textOf(await h.handleFetchDoc({ url })), /^Could not fetch web\/stalled-example\/[0-9a-f]{12}: download of .* failed: stopped/);
    });

    // Last: these extract a document the listing tests above expect unindexed.
    test('read_doc_pages and fetch_doc report an ambiguous short id instead of picking one', async () => {
        await handler.handleListTargetDocs({});
        const read = textOf(await handler.handleReadDocPages({ doc: 'rm', pages: '1' }));
        assert.match(read, /^Document id 'rm' is ambiguous — it matches .*stm32f7xx-dfp\/test-rm.*workspace\/vendor-rm.*\. Pass one of these ids\.$/);
        assert.match(textOf(await handler.handleFetchDoc({ doc: 'rm' })), /^Document id 'rm' is ambiguous/);
        // A unique trailing segment and a case difference still resolve.
        const byBoth = textOf(await handler.handleReadDocPages({ doc: 'TEST-RM', pages: '1' }));
        assert.doesNotMatch(byBoth, /ambiguous|No document with id/);
        assert.match(textOf(await handler.handleReadDocPages({ doc: 'nothing-like-this', pages: '1' })), /^No document with id 'nothing-like-this'/);
    });

    test('read_doc_pages honours maxPdfMb before extracting, like search and the index command', async () => {
        const tiny = new PackDocsHandler({
            ...world.host,
            storageDir: path.join(world.root, 'store-tiny'),
            settings: () => ({ ...world.host.settings(), maxPdfMb: 0.0001 }),
        }, { timeoutMs: 30_000, workspaceRoot: () => world.workspace });
        const text = textOf(await tiny.handleReadDocPages({ doc: 'stm32f7xx-dfp/test-rm', pages: '1' }));
        assert.match(text, /^stm32f7xx-dfp\/test-rm is not indexed and will not be extracted: \d+ MB exceeds maxPdfMb 0\.0001 \(cmsis-developer-assistant\.packDocs\.maxPdfMb\)\.$/);
        assert.ok(!fs.existsSync(path.join(world.root, 'store-tiny')) || !fs.readdirSync(path.join(world.root, 'store-tiny'), { recursive: true }).some(f => String(f).endsWith('.pages.jsonl')), 'nothing was extracted');
        const doc = { id: 'x', title: 'x', scope: 'unlisted', source: 'pack', path: path.join(world.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0', 'Documentation', 'test-rm.pdf'), sizeBytes: 5_000_000, cached: false, indexed: false } as const;
        await assert.rejects(() => tiny.indexDocument({ ...doc }), /exceeds maxPdfMb 0\.0001/);
    });
});

/** An extractor whose tool is not installed. */
class MissingExtractor implements PdfExtractor {
    readonly name = 'missing';
    async available() { return { ok: false, detail: 'pdftotext is not installed' }; }
    async extract(): Promise<never> { throw new Error('extract was called without the tool'); }
}

/** An extractor that is there and reads no PDF. */
class FailingExtractor implements PdfExtractor {
    readonly name = 'failing';
    async available() { return { ok: true, detail: 'failing' }; }
    async extract(): Promise<never> { throw new Error('the PDF is damaged'); }
}

/**
 * What the Pack Docs panel, the Target Documents view and the commands ask
 * the handler for, beside the tools: the contexts, one peripheral of a
 * register map, the index of a whole target, and the document service.
 */
suite('PackDocsHandler for the panel, the Target Documents view and the commands', () => {
    let world: World;
    let handler: PackDocsHandler;
    const options = (w: World) => ({ timeoutMs: 30_000, workspaceRoot: () => w.workspace, extractor: new FakeExtractor(['RCC clock control', 'USART1 baud rate']) });

    suiteSetup(() => {
        world = buildWorld();
        handler = new PackDocsHandler(world.host, options(world));
    });
    suiteTeardown(() => handler.dispose());

    test('the cbuild-run contexts of the workspace are listed; a file that cannot be read is logged and left out', async () => {
        const [blinky] = await world.host.findCbuildRunFiles();
        const gone = path.join(world.workspace, 'gone+X.cbuild-run.yml');
        const listing = new PackDocsHandler({ ...world.host, findCbuildRunFiles: async () => [gone, blinky] }, options(world));
        const contexts = await listing.listContexts();
        assert.deepStrictEqual(contexts.map((c) => [c.file, c.targetType, c.device?.name, c.board?.name]), [[blinky, 'STM32F756ZGTx', 'STM32F756ZGTx', 'NUCLEO-F756ZG']]);
        assert.ok(world.lines.some((line) => line.startsWith(`W cannot read ${gone}: `)), world.lines.filter((line) => line.startsWith('W ')).join('\n'));
        assert.deepStrictEqual(await new PackDocsHandler({ ...world.host, findCbuildRunFiles: async () => [] }, options(world)).listContexts(), []);
    });

    test('one peripheral is read from the device SVD, and from the core\'s description when the device has none on disk', async () => {
        const rcc = await handler.inspectPeripheral({}, 'rcc');
        assert.ok(!('error' in rcc), JSON.stringify(rcc));
        assert.strictEqual(rcc.peripheral.name, 'RCC');
        assert.strictEqual(rcc.peripheral.baseAddress, 0x40023800);
        assert.strictEqual(rcc.group, 'RCC');
        assert.deepStrictEqual(rcc.registers.slice(0, 3).map((r) => r.name), ['AHB1ENR', 'APB1ENR', 'APB2ENR']);
        assert.deepStrictEqual(await handler.inspectPeripheral({}, 'NOPE'), { error: 'no peripheral NOPE' });
        const noTarget = await handler.inspectPeripheral({ target: 'nonexistent' }, 'RCC');
        assert.ok('error' in noTarget && noTarget.error.startsWith('No cbuild-run context matches target \'nonexistent\''), JSON.stringify(noTarget));

        // The STM32F756VG takes the subfamily's SVD, which this pack root does not hold: the Cortex-M7 map the extension ships stands in.
        const sibling = { pack: 'Keil::STM32F7xx_DFP', device: 'STM32F756VGTx' };
        const scb = await handler.inspectPeripheral(sibling, 'SCB');
        assert.ok(!('error' in scb), JSON.stringify(scb));
        assert.strictEqual(scb.peripheral.baseAddress, 0xE000ED00);
        assert.deepStrictEqual(scb.registers.slice(0, 3).map((r) => r.name), ['CPUID', 'ICSR', 'VTOR']);
        // Without the shipped maps and without ARM::CMSIS in the pack root, the reason is the missing file.
        const bare = new PackDocsHandler({ ...world.host, assetsDir: undefined }, options(world));
        assert.deepStrictEqual(await bare.inspectPeripheral(sibling, 'SCB'), { error: 'device SVD CMSIS/SVD/STM32F756.svd is not on disk' });
    });

    test('one core peripheral is read from the map of the target\'s core', async () => {
        const scb = await handler.inspectCorePeripheral({}, 'scb');
        assert.ok(!('error' in scb), JSON.stringify(scb));
        assert.strictEqual(scb.peripheral.name, 'SCB');
        assert.strictEqual(scb.group, 'System');
        assert.ok(scb.registers.some((r) => r.name === 'CFSR') && scb.registers.length > 20, scb.registers.map((r) => r.name).join());
        // The device SVD is not asked: RCC is a peripheral of the device, not of the core.
        assert.deepStrictEqual(await handler.inspectCorePeripheral({}, 'RCC'), { error: 'no core peripheral RCC' });
        const noTarget = await handler.inspectCorePeripheral({ target: 'nonexistent' }, 'SCB');
        assert.ok('error' in noTarget && /No cbuild-run context matches target 'nonexistent'/.test(noTarget.error), JSON.stringify(noTarget));
        const bare = new PackDocsHandler({ ...world.host, assetsDir: undefined }, options(world));
        assert.deepStrictEqual(await bare.inspectCorePeripheral({}, 'SCB'),
            { error: 'no core peripherals for this target (unknown core, and the ARM::CMSIS pack is not installed)' });
    });

    test('an NPU the device pack declares is read from the driver header of the installed ARM::ethos-u-core-driver', async () => {
        const noNpu = 'no NPU driver header for this target (no NPU declared, or the ARM::ethos-u-core-driver pack is not installed)';
        assert.deepStrictEqual(await handler.inspectNpuPeripheral({}, 'Ethos-U55'), { error: noNpu }, 'the plain world declares none');
        assert.strictEqual((await handler.inspectTarget({})).npu, undefined);
        const noTarget = await handler.inspectNpuPeripheral({ target: 'nonexistent' }, 'Ethos-U55');
        assert.ok('error' in noTarget && /No cbuild-run context matches target 'nonexistent'/.test(noTarget.error), JSON.stringify(noTarget));

        // A world of its own: the device has an Ethos-U55.
        const npuWorld = buildWorld();
        const pdsc = path.join(npuWorld.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0', 'Keil.STM32F7xx_DFP.pdsc');
        const declared = fs.readFileSync(pdsc, 'utf-8').replace('<device Dname="STM32F756ZG">', '<device Dname="STM32F756ZG">\n          <feature type="NPU" n="Ethos-U55"/>');
        assert.ok(declared.includes('type="NPU"'));
        fs.writeFileSync(pdsc, declared);
        const withNpu = new PackDocsHandler(npuWorld.host, options(npuWorld));

        // Declared, the driver pack not installed: the panel shows where the header would come from.
        const missing = await withNpu.inspectTarget({});
        assert.deepStrictEqual(missing.npus, ['Ethos-U55']);
        assert.match(missing.processors ?? '', /Cortex-M7.* · NPU Ethos-U55$/);
        assert.ok(missing.npu && !missing.npu.exists && missing.npu.rel === 'ethosu55_interface.h' && missing.npu.peripherals.length === 0, JSON.stringify(missing.npu));
        assert.strictEqual(missing.npu.pack, 'ARM::ethos-u-core-driver (not installed)');
        assert.deepStrictEqual(await withNpu.inspectNpuPeripheral({}, 'Ethos-U55'), { error: noNpu });

        const driver = path.join(npuWorld.packRoot, 'ARM', 'ethos-u-core-driver', '1.1.0', 'src');
        fs.mkdirSync(driver, { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'ethosu_test_interface.h'), path.join(driver, 'ethosu55_interface.h'));
        const found = await withNpu.inspectTarget({});
        assert.ok(found.npu?.exists, JSON.stringify(found.npu));
        assert.strictEqual(found.npu.pack, 'ARM::ethos-u-core-driver@1.1.0');
        assert.strictEqual(found.npu.coreName, 'Ethos-U55');
        assert.strictEqual(found.npu.error, undefined);
        // The base address is not in the header, and this device's SVD names no NPU.
        assert.deepStrictEqual(found.npu.peripherals, [{ name: 'Ethos-U55', group: 'NPU', baseAddress: 0, registers: 6, interrupts: 0 }]);
        const npu = await withNpu.inspectNpuPeripheral({}, 'ethos-u55');
        assert.ok(!('error' in npu), JSON.stringify(npu));
        assert.strictEqual(npu.group, 'NPU');
        assert.deepStrictEqual(npu.registers.map((r) => r.name), ['ID', 'STATUS', 'CMD', 'QBASE', 'BASEP_BASE', 'PMCR']);
        assert.deepStrictEqual(await withNpu.inspectNpuPeripheral({}, 'Ethos-U85'), { error: 'no NPU Ethos-U85; the target has Ethos-U55' });
        withNpu.dispose();
    });

    test('Index Target Documents extracts every local document once, names each to the progress, and says why it cannot', async () => {
        const reported: string[] = [];
        const first = await handler.indexTarget({}, (message) => reported.push(message));
        const counts = /^Target: device STMicroelectronics::STM32F756ZGTx, [^\n]*\nIndexed (\d+), already cached (\d+), failed (\d+) of (\d+) documents\.$/.exec(first);
        assert.ok(counts, first);
        const [indexed, cached, failed, total] = counts.slice(1).map(Number);
        assert.ok(total >= 4, 'the pack\'s manual, the unlisted PDF and the two workspace documents at least');
        assert.deepStrictEqual([indexed, cached, failed], [total, 0, 0]);
        assert.strictEqual(reported.length, total);
        assert.strictEqual(reported[0], `stm32f7xx-dfp/test-rm (1/${total})`);
        assert.match(reported[total - 1], new RegExp(` \\(${total}/${total}\\)$`));
        const kept = handler.getStore().listCached();
        assert.deepStrictEqual(kept.map((doc) => doc.id).sort(), reported.map((message) => message.replace(/ \(.*$/, '')).sort());
        assert.ok(kept.every((doc) => doc.extractor === 'fake' && doc.pageCount === 2), JSON.stringify(kept));

        const second = await handler.indexTarget({});
        assert.ok(second.endsWith(`\nIndexed 0, already cached ${total}, failed 0 of ${total} documents.`), second);

        // The panel's Clear Extracted Text: the store is emptied, the handler forgets what it derived, and everything is extracted anew.
        assert.strictEqual(handler.getStore().clearExtracted().documents, total);
        handler.dropCaches();
        assert.deepStrictEqual(handler.getStore().listCached(), []);
        const third = await handler.indexTarget({});
        assert.ok(third.endsWith(`\nIndexed ${total}, already cached 0, failed 0 of ${total} documents.`), third);

        assert.match(await handler.indexTarget({ target: 'nonexistent' }), /^No cbuild-run context matches target 'nonexistent'/);
        const elsewhere = { ...world.host, storageDir: path.join(world.root, 'store-of-its-own') };
        const noTool = new PackDocsHandler(elsewhere, { ...options(world), extractor: new MissingExtractor() });
        assert.strictEqual(await noTool.indexTarget({}), 'Cannot extract: pdftotext is not installed');
        const damaged = new PackDocsHandler(elsewhere, { ...options(world), extractor: new FailingExtractor() });
        const logged = world.lines.length;
        const none = await damaged.indexTarget({});
        assert.ok(none.endsWith(`\nIndexed 0, already cached 0, failed ${total} of ${total} documents.`), none);
        assert.ok(world.lines.slice(logged).some((line) => line.startsWith('E indexing stm32f7xx-dfp/test-rm failed') && line.includes('the PDF is damaged')),
            world.lines.slice(logged).join('\n'));
    });

    test('with the host\'s index folder every index lies there: a book in its device\'s folder, the rest in its pack\'s or its project\'s', async () => {
        const docs = path.join(world.root, 'cmsis-docs');
        const own = path.join(world.root, 'store-beside-the-index');
        const indexing = new PackDocsHandler({ ...world.host, storageDir: own, indexDir: docs }, options(world));
        const text = await indexing.indexTarget({});
        assert.match(text, /\nIndexed (\d+), already cached 0, failed 0 of \1 documents\.$/);
        const kept = indexing.getStore().listCached();
        const folderOf = (id: string): string => path.relative(docs, kept.find((doc) => doc.id === id)?.dir ?? '').split(path.sep).join('/');
        assert.strictEqual(folderOf('stm32f7xx-dfp/test-rm'), 'STMicroelectronics/STM32F756ZGTx/test-rm');
        assert.strictEqual(folderOf('stm32f7xx-dfp/unlisted-errata'), 'packs/Keil/STM32F7xx_DFP/unlisted-errata');
        assert.match(folderOf('workspace/board-um'), /^projects\/[0-9a-f]{12}\/board-um$/);
        assert.match(folderOf('workspace/vendor-rm'), /^projects\/[0-9a-f]{12}\/vendor-rm$/);
        assert.ok(kept.length >= 4 && kept.every((doc) => !path.relative(docs, doc.dir).startsWith('..')), JSON.stringify(kept.map((doc) => doc.dir)));
        assert.ok(!fs.existsSync(own), 'nothing in the extension\'s own store');
        assert.ok((await indexing.indexTarget({})).endsWith(`\nIndexed 0, already cached ${kept.length}, failed 0 of ${kept.length} documents.`));
        indexing.dispose();
    });

    test('the view gets the document service with the target\'s parents, most specific first, and where the documents are kept', async () => {
        const chosen = world.host.documentService?.();
        assert.ok(chosen, 'the world runs the document service');
        const { service, view } = chosen;
        const context = await handler.serviceContext();
        assert.ok(context);
        assert.strictEqual(context.service, service);
        assert.strictEqual(context.view, view);
        assert.deepStrictEqual(context.parents.map(parentKey), [
            'device:STMicroelectronics::STM32F756ZGTx', 'board:STMicroelectronics::NUCLEO-F756ZG:Rev.B', 'core:Cortex-M7',
            'pack:Keil::STM32F7xx_DFP', 'pack:Keil::NUCLEO-F756ZG_BSP', 'vendor:Keil', 'all',
        ]);
        assert.strictEqual(path.basename(context.solution ?? ''), 'TFLiteRT_HelloWorld.csolution.yml', 'the csolution the cbuild-run names');
        assert.strictEqual(await new PackDocsHandler({ ...world.host, findCbuildRunFiles: async () => [] }, options(world)).serviceContext(), undefined,
            'no target, no context');

        // The emulated service says where its inventory is, and its copies when they have a folder of their own; the handler passes that on.
        const kept = service as { inventoryFile?: string; copiesDir?: string };
        assert.ok(typeof kept.inventoryFile === 'string', 'the emulator of the test world');
        assert.deepStrictEqual(handler.documentStore(), { view, inventory: kept.inventoryFile, dir: kept.copiesDir ?? path.dirname(kept.inventoryFile) });
        // A service that names no file of its own (CMSIS Solution's) is known by its view alone.
        const foreign = { ...world.host, documentService: () => ({ service: {} as typeof service, view: 'the CMSIS view' }) };
        assert.deepStrictEqual(new PackDocsHandler(foreign, options(world)).documentStore(), { view: 'the CMSIS view' });
    });

    test('a document is named to the service by its parent and name; a web document it does not list yet is added as a reference first', async () => {
        const service = world.host.documentService?.()?.service;
        assert.ok(service, 'the world runs the document service');
        const before = (await handler.inspectTarget({})).docs;
        const byId = (docs: typeof before, id: string) => docs.find((doc) => doc.id === id)!;
        const sheet = byId(before, 'stm32f7xx-dfp/stm32f756bg');
        const guide = byId(before, 'arm/dui0646-latest');
        assert.ok(sheet.url && !sheet.service && guide.url && guide.arm && !guide.service, 'the service lists neither yet');
        const device = { device: 'STMicroelectronics::STM32F756ZGTx' };

        // A book of the device pack goes to the device, an Arm document to every target.
        assert.deepStrictEqual(await handler.serviceEntry(sheet), { parent: device, name: sheet.url });
        assert.deepStrictEqual(await handler.serviceEntry(guide), { parent: { all: true }, name: guide.url });
        assert.ok((await service.getDocuments(device)).some((info) => info.name === sheet.url), 'the reference is in the service now');
        // Once listed, the entry is the service's own, and nothing is added a second time.
        const after = (await handler.inspectTarget({})).docs;
        const listed = byId(after, 'stm32f7xx-dfp/stm32f756bg');
        assert.ok(listed.service, JSON.stringify(listed));
        const count = (await service.getDocuments(device)).length;
        assert.deepStrictEqual(await handler.serviceEntry(listed), { parent: listed.service.parent, name: listed.service.name });
        assert.strictEqual((await service.getDocuments(device)).length, count);
        // A file of the pack has no address the service could fetch.
        assert.strictEqual(await handler.serviceEntry(byId(after, 'stm32f7xx-dfp/test-rm')), undefined);
    });

    test('without a document service there is no context, no entry and no place of its own', async () => {
        const off = buildWorld({ service: false });
        const plain = new PackDocsHandler(off.host, options(off));
        const sheet = (await plain.inspectTarget({})).docs.find((doc) => doc.id === 'stm32f7xx-dfp/stm32f756bg')!;
        assert.strictEqual(await plain.serviceContext(), undefined);
        assert.strictEqual(await plain.serviceEntry(sheet), undefined);
        assert.strictEqual(plain.documentStore(), undefined);
        plain.dispose();
    });
});
