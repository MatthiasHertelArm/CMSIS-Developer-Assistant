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

// The document service (src/docService): a conformance suite of the contract, run against the
// emulator (and, once CMSIS Solution provides the service, against its implementation with the
// same suite); the isolation of the emulator; the folder attributions of the legacy migration;
// and the documentation tools through the service end to end, with the same replies as before.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { load } from 'js-yaml';
import { DocumentFailure, DocumentService } from '../docService/contract';
import { DownloadEngine, EmulatedDocumentService, projectInventoryFile } from '../docService/emulator';
import { documentEngine } from '../core/packDocs/documentEngine';
import { solutionDocumentService } from '../core/packDocs/documentApi';
import { targetParents } from '../core/packDocs/serviceDocs';
import { defaultSettings, PackDocsHost } from '../core/packDocs/host';
import { textOf } from '../core/toolResult';
import { PackDocsHandler } from '../packDocsHandler';
import { legacyParent } from '../core/packDocs/userDocs';
import { buildWorld, FakeExtractor, World } from './packDocsHandler.test';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const DEVICE = { device: 'STMicroelectronics::STM32U585AIIx' };
const BOARD = { board: 'STMicroelectronics::B-U585I-IOT02A:C' };
const RM = 'https://www.st.com/resource/en/reference_manual/rm0456.pdf';
const WALL = 'https://www.vendor.com/protected/schematic.pdf';

/** An engine that "downloads" a PDF, or fails as a login wall for WALL. */
function fakeEngine(calls: string[]): DownloadEngine {
    return {
        async download(url, destDir, options) {
            calls.push(url);
            if (url === WALL) {
                throw new DocumentFailure({ kind: 'login-required', detail: 'HTTP 403 text/html', url });
            }
            options.onProgress?.(PDF.length, PDF.length);
            const file = path.join(destDir, 'rm0456.pdf');
            fs.writeFileSync(file, PDF);
            return { path: file, bytes: PDF.length, sha256: 'x', filename: 'rm0456.pdf', resolver: 'direct', versionLabel: 'Rev 6' };
        },
    };
}

/**
 * The contract's behaviour, for any implementation. `make` gives a fresh
 * service, a csolution path of a project folder it may write `.cmsis/docs.yml`
 * into, and the download calls its engine saw.
 */
export function conformance(name: string, make: () => { service: DocumentService; solution: string; calls: string[]; dispose(): void }): void {
    suite(`document service contract: ${name}`, () => {
        let made: ReturnType<typeof make>;
        setup(() => { made = make(); });
        teardown(() => made.dispose());

        test('a URL is a reference until downloaded; the download keeps the copy and its facts, and clears a request', async () => {
            const { service } = made;
            const added = await service.addDocument(DEVICE, RM, { title: 'Reference manual', category: 'manual' });
            assert.deepStrictEqual([added.location, added.scope, added.path, added.title], ['web', 'user', undefined, 'Reference manual']);
            await service.requestDocument(DEVICE, RM, { by: 'agent', reason: 'needed for RCC' });
            assert.strictEqual((await service.getRequests()).length, 1);
            const progress: number[] = [];
            const done = await service.downloadDocument(DEVICE, RM, { onProgress: (bytes) => progress.push(bytes) });
            assert.ok(done.path && fs.existsSync(done.path));
            assert.deepStrictEqual([done.bytes, done.versionLabel, done.requested, done.error], [PDF.length, 'Rev 6', undefined, undefined]);
            assert.deepStrictEqual(progress, [PDF.length]);
            assert.deepStrictEqual(await service.getRequests(), []);
            assert.deepStrictEqual((await service.getDocuments(BOARD)).length, 0, 'another parent does not see it');
        });

        test('a login wall is a typed failure, recorded on the document with the page to open; the import of a hand download resolves it', async () => {
            const { service } = made;
            await service.addDocument(BOARD, WALL, { title: 'Schematic' });
            await assert.rejects(service.downloadDocument(BOARD, WALL), (caught: unknown) =>
                caught instanceof DocumentFailure && caught.error.kind === 'login-required' && caught.error.url === WALL);
            await service.requestDocument(BOARD, WALL, { by: 'agent', reason: 'J3 pinout' });
            const [failed] = await service.getDocuments(BOARD);
            assert.deepStrictEqual([failed.error?.kind, failed.requested?.reason], ['login-required', 'J3 pinout']);
            const download = path.join(path.dirname(made.solution), 'downloaded-by-hand.pdf');
            fs.writeFileSync(download, PDF);
            const imported = await service.importDocument(BOARD, WALL, download);
            assert.ok(imported.path && imported.path !== download, 'the service keeps its own copy');
            assert.deepStrictEqual([imported.error, imported.requested], [undefined, undefined]);
        });

        test('a request for a document it does not list adds it as a reference', async () => {
            const { service } = made;
            await service.requestDocument({ all: true }, RM, { by: 'agent', reason: 'x', title: 'From a pack' });
            const [doc] = await service.getDocuments({ all: true });
            assert.deepStrictEqual([doc.title, doc.requested?.by], ['From a pack', 'agent']);
        });

        test('a local file for the user is copied; removing it removes the copy and never the file', async () => {
            const { service, solution } = made;
            const file = path.join(path.dirname(solution), 'outside', 'bmi270.pdf');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, PDF);
            const added = await service.addDocument({ core: 'Cortex-M33' }, file, { title: 'BMI270' });
            assert.ok(added.path && added.path !== file && fs.existsSync(added.path));
            assert.ok(await service.removeDocument({ core: 'Cortex-M33' }, added.name));
            assert.ok(!fs.existsSync(added.path), 'the copy is gone');
            assert.ok(fs.existsSync(file), 'the user\'s file stays');
            assert.deepStrictEqual(await service.getDocuments({ core: 'Cortex-M33' }), []);
        });

        test('project scope: names relative to the csolution in .cmsis/docs.yml; machine state never goes into it', async () => {
            const { service, solution } = made;
            const local = path.join(path.dirname(solution), 'docs', 'board-schematic.pdf');
            fs.mkdirSync(path.dirname(local), { recursive: true });
            fs.writeFileSync(local, PDF);
            await service.addDocument(BOARD, local, { title: 'Board schematic', category: 'schematic', scope: 'project', solution });
            await service.addDocument(DEVICE, RM, { title: 'Reference manual', scope: 'project', solution });
            await service.downloadDocument(DEVICE, RM, {}, solution);
            const shared = load(fs.readFileSync(projectInventoryFile(solution), 'utf-8')) as { docs: Record<string, unknown> };
            assert.deepStrictEqual(shared.docs, {
                devices: [{ device: DEVICE.device, docs: [{ name: RM, title: 'Reference manual' }] }],
                boards: [{ board: BOARD.board, docs: [{ name: 'docs/board-schematic.pdf', title: 'Board schematic', category: 'schematic' }] }],
            }, 'the layout of ~/.cmsis/docs.yml, without paths, errors or requests');
            const [schematic] = await service.getDocuments(BOARD, solution);
            assert.deepStrictEqual([schematic.scope, schematic.path], ['project', local]);
            const [manual] = await service.getDocuments(DEVICE, solution);
            assert.ok(manual.path && !manual.path.startsWith(path.dirname(solution)), 'the download stays in the service\'s store');
            assert.deepStrictEqual(await service.getDocuments(DEVICE), [], 'without the csolution, project documents are not listed');
            await assert.rejects(service.addDocument(BOARD, path.join(os.tmpdir(), 'elsewhere.pdf'), { scope: 'project', solution }), /lies outside the project/);
            assert.ok(await service.removeDocument(BOARD, 'docs/board-schematic.pdf', solution));
            assert.ok(fs.existsSync(local), 'removing a project entry never deletes the project\'s file');
        });

        test('adding again updates title and category and keeps the copy (callers add before each download)', async () => {
            const { service } = made;
            await service.addDocument(DEVICE, RM, { title: 'First' });
            await service.downloadDocument(DEVICE, RM);
            const again = await service.addDocument(DEVICE, RM, { title: 'Second', category: 'manual' });
            assert.deepStrictEqual([again.title, again.category, again.path !== undefined], ['Second', 'manual', true]);
            assert.strictEqual((await service.getDocuments(DEVICE)).length, 1);
        });

        test('the parent rule: a device without its vendor, a board without its revision, are the same; another vendor is not', async () => {
            const { service } = made;
            await service.addDocument({ device: 'STM32U585AIIx' }, RM, { title: 'RM' });
            assert.strictEqual((await service.getDocuments(DEVICE)).length, 1);
            assert.strictEqual((await service.getDocuments({ device: 'NXP::STM32U585AIIx' })).length, 1, 'no vendor on one side: the name decides');
            await service.addDocument({ board: 'STMicroelectronics::B-U585I-IOT02A' }, WALL, { title: 'S' });
            assert.strictEqual((await service.getDocuments(BOARD)).length, 1);
            assert.strictEqual((await service.getDocuments({ board: 'STMicroelectronics::B-U585I-IOT02A:D' })).length, 1);
            assert.strictEqual((await service.getDocuments({ board: 'Other::B-U585I-IOT02A' })).length, 0);
        });

        test('a project file names only its own files; a file of another layout is never overwritten', async () => {
            const { service, solution } = made;
            const file = projectInventoryFile(solution);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'docs:\n  boards:\n    - board: X::Y\n      docs:\n        - name: ../../etc/secret.pdf\n          title: Escape\n');
            const [escape] = await service.getDocuments({ board: 'X::Y' }, solution);
            assert.deepStrictEqual([escape.path, escape.error?.kind], [undefined, 'blocked']);
            fs.writeFileSync(file, 'docs:\n  - not: this layout\n');
            await assert.rejects(service.addDocument(DEVICE, RM, { scope: 'project', solution }), /is not a document inventory/);
            assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'docs:\n  - not: this layout\n');
        });

        test('every change is announced', async () => {
            const { service } = made;
            let changes = 0;
            const listening = service.onDidChangeDocuments(() => { changes++; });
            await service.addDocument(DEVICE, RM);
            await new Promise((resolve) => setTimeout(resolve, 120));
            listening.dispose();
            assert.ok(changes >= 1);
        });
    });
}

conformance('emulator', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-docservice-'));
    const calls: string[] = [];
    const service = new EmulatedDocumentService({ root: path.join(root, 'store'), engine: fakeEngine(calls) });
    const solution = path.join(root, 'project', 'Blinky.csolution.yml');
    fs.mkdirSync(path.dirname(solution), { recursive: true });
    fs.writeFileSync(solution, 'solution:\n');
    return { service, solution, calls, dispose: () => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
});

suite('document service: the seams', () => {
    test('the emulator imports only Node built-ins, js-yaml and the contract, so it can be handed over as it is', () => {
        const dir = path.join(__dirname, '..', '..', '..', 'src', 'docService');
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
            const text = fs.readFileSync(path.join(dir, file), 'utf-8');
            const imports = [...text.matchAll(/\bfrom\s+'([^']+)'/g), ...text.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g), ...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)]
                .map((m) => m[1]);
            assert.ok(file !== 'emulator.ts' || imports.includes('./contract'), 'the scan sees the emulator\'s multi-line import');
            for (const source of imports) {
                assert.ok(['crypto', 'fs', 'os', 'path', 'js-yaml', './contract'].includes(source), `${file} imports ${source}`);
            }
        }
    });

    test('CMSIS Solution\'s service is taken only through getDocumentService with this contract\'s major version and every method', () => {
        const service = new EmulatedDocumentService({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'cda-docservice-')), engine: fakeEngine([]) });
        assert.strictEqual(solutionDocumentService({ getDocumentService: () => service }), service);
        assert.strictEqual(solutionDocumentService({ addDocument: () => undefined, downloadDocument: () => undefined }), undefined, 'internal methods of the same name are not the service');
        assert.strictEqual(solutionDocumentService({ getDocumentService: () => ({ ...service, version: '2.0.0' }) }), undefined);
        assert.strictEqual(solutionDocumentService(undefined), undefined);
        service.dispose();
    });

    test('a target\'s parents: device, board, cores, packs without version, vendors, all; no duplicates', () => {
        assert.deepStrictEqual(targetParents({
            device: { vendor: 'ST', name: 'STM32U585AIIx' }, board: { vendor: 'ST', name: 'B-U585I-IOT02A', revision: 'C' },
            devicePack: { vendor: 'Keil', name: 'STM32U5xx_DFP', version: '3.1.0' }, boardPack: { vendor: 'Keil', name: 'B-U585I-IOT02A_BSP', version: '2.0.0' },
            cores: ['Cortex-M33', 'Cortex-M33'],
        }), [
            { device: 'ST::STM32U585AIIx' }, { board: 'ST::B-U585I-IOT02A:C' }, { core: 'Cortex-M33' },
            { pack: 'Keil::STM32U5xx_DFP' }, { pack: 'Keil::B-U585I-IOT02A_BSP' }, { vendor: 'Keil' }, { all: true },
        ]);
    });

    test('the legacy folder\'s attributions: pack, vendor, device, board, core, all; a pattern has none', () => {
        assert.deepStrictEqual(legacyParent([]), { all: true });
        assert.deepStrictEqual(legacyParent(['Keil', 'STM32U5xx_DFP']), { pack: 'Keil::STM32U5xx_DFP' });
        assert.deepStrictEqual(legacyParent(['Keil']), { vendor: 'Keil' });
        assert.deepStrictEqual(legacyParent(['devices', 'STM32U585AIIx']), { device: 'STM32U585AIIx' });
        assert.deepStrictEqual(legacyParent(['boards', 'B-U585I-IOT02A']), { board: 'B-U585I-IOT02A' });
        assert.deepStrictEqual(legacyParent(['cores', 'Cortex-M33']), { core: 'Cortex-M33' });
        assert.strictEqual(legacyParent(['devices', 'STM32U5*']), undefined);
    });
});

suite('the documentation tools through the emulated document service (2.9.2)', () => {
    let world: World;
    let service: EmulatedDocumentService;
    let host: PackDocsHost;

    setup(() => {
        world = buildWorld();
        service = new EmulatedDocumentService({
            root: path.join(world.root, 'docservice'),
            engine: documentEngine({ fetchFn: world.host.fetchFn!, userAgent: 'test', log: world.host.log, timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024 }),
        });
        host = { ...world.host, documentService: () => ({ service, view: 'the Target Documents view' }) };
    });
    teardown(() => {
        service.dispose();
        fs.rmSync(world.root, { recursive: true, force: true });
    });

    test('fetch_doc of an Arm document: the same reply, edition and citation as before; the copy is the service\'s', async () => {
        const handler = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace,
            extractor: new FakeExtractor(['1 Debug\nDHCSR C_DEBUGEN halting', '2 Reset\nSYSRESETREQ VECTRESET']) });
        const fetched = textOf(await handler.handleFetchDoc({ doc: 'arm/dui0646-latest' }));
        assert.match(fetched, /^Fetched arm\/dui0646-latest — Cortex-M7 Devices Generic User Guide, version a \(r1p2\), DUI0646C_cortex_m7_dgug\.pdf, 1 kB → indexed 2 p in [\d.]+ s\.\nFrom https:\/\/developer\.arm\.com\/documentation\/dui0646\/latest \(arm\.com\); kept by the document service \(the Target Documents view\)/);
        assert.match(fetched, /Cite as arm\/dui0646-latest r1p2 p\.<n>\./);
        const [kept] = await service.getDocuments({ all: true });
        assert.ok(kept.path?.startsWith(path.join(world.root, 'docservice')), kept.path);
        // A new handler (a new window) finds the copy through the service, with its edition and index, without a download.
        const calls = world.fetchCalls.length;
        const fresh = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Debug\nDHCSR C_DEBUGEN halting', '2 Reset']) });
        assert.match(textOf(await fresh.handleListTargetDocs({})), /arm\/dui0646-latest · family · Cortex-M7 Devices Generic User Guide · indexed r1p2, 2 p/);
        assert.match(textOf(await fresh.handleSearchTargetDocs({ query: 'C_DEBUGEN', doc: 'dui0646' })), /#1 arm\/dui0646-latest \[r1p2\] p\.1/);
        assert.strictEqual(world.fetchCalls.length, calls);
    });

    test('a failed fetch_doc becomes the service\'s request: the listing and the reply name the view; the request clears with a later copy', async () => {
        const url = 'https://www.st.com/resource/en/datasheet/stm32f756bg.pdf';
        let wall = true;
        const fetchFn = async (target: string): Promise<Response> => (target !== url ? world.host.fetchFn!(target) : wall
            ? new Response('<html>Sign in</html>', { status: 403, headers: { 'content-type': 'text/html' } })
            : new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }));
        service.dispose();
        service = new EmulatedDocumentService({ root: path.join(world.root, 'docservice'),
            engine: documentEngine({ fetchFn, userAgent: 'test', log: world.host.log, timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024 }) });
        const handler = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Data\nVDD']) });
        await handler.handleListTargetDocs({});
        const id = (await handler.inspectTarget({})).docs.find((doc) => doc.url === url)!.id;
        const refused = textOf(await handler.handleFetchDoc({ doc: id }));
        assert.match(refused, /^Could not fetch .*: login-required: /);
        assert.match(refused, /The request is recorded in the Target Documents view: ask the user to use Download there, or, when the site needs a login/);
        const requests = await service.getRequests();
        assert.deepStrictEqual(requests.map((doc) => [doc.name, doc.error?.kind, doc.parent]), [[url, 'login-required', { device: 'STMicroelectronics::STM32F756ZGTx' }]]);
        assert.match(textOf(await handler.handleListTargetDocs({})), /STM32F756 Data Sheet · web — requested, needs the user: login or manual download at www\.st\.com; they open it from the Target Documents view/);
        wall = false;
        assert.match(textOf(await handler.handleFetchDoc({ doc: id })), /^Fetched /);
        assert.deepStrictEqual(await service.getRequests(), []);
    });

    test('documents the user added for a core and for the project are listed and searched with the target\'s', async () => {
        const solution = path.join(world.workspace, 'Blinky.csolution.yml');
        fs.writeFileSync(solution, 'solution:\n');
        const projectDoc = path.join(world.workspace, 'docs', 'board-um.pdf');
        await service.addDocument({ core: 'Cortex-M7' }, projectDoc, { title: 'Core notes' });
        await service.addDocument({ board: 'STMicroelectronics::NUCLEO-F756ZG:Rev.B' }, projectDoc, { title: 'Board manual', scope: 'project', solution });
        const run = (await world.host.findCbuildRunFiles())[0];
        const text = fs.readFileSync(run, 'utf-8');
        fs.writeFileSync(run, text.replace(/^(\s*)solution: .*$/m, `$1solution: ${path.relative(path.dirname(run), solution)}`).replace(/^cbuild-run:\n/m, `cbuild-run:\n  solution: ${path.relative(path.dirname(run), solution)}\n`));
        const handler = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Notes\nMPU regions']) });
        const listed = textOf(await handler.handleListTargetDocs({}));
        assert.match(listed, /user\/cortex-m7\/board-um · user · Core notes · 1 kB \(added by the user\), not indexed yet/);
        assert.match(listed, /Project documents \(\.cmsis\/docs\.yml of the csolution, shared with the project\):\n  project\/nucleo-f756zg-rev-b\/board-um · project · Board manual · 1 kB \(project document\), not indexed yet/);
        assert.match(textOf(await handler.handleSearchTargetDocs({ query: 'MPU', doc: 'user/cortex-m7/board-um' })), /#1 user\/cortex-m7\/board-um p\.1/);
    });
});
