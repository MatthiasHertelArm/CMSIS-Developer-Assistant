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
import { dump, load } from 'js-yaml';
import { DocumentFailure, DocumentInfo, DocumentService } from '../docService/contract';
import { DownloadEngine, EmulatedDocumentService, projectInventoryFile } from '../docService/emulator';
import { documentEngine } from '../core/packDocs/documentEngine';
import { solutionDocumentService } from '../core/packDocs/documentApi';
import { shortHash } from '../core/packDocs/pageStore';
import type { DocRef } from '../core/packDocs/pdscBooks';
import { mergeServiceDocs, targetParents } from '../core/packDocs/serviceDocs';
import { defaultSettings, PackDocsHost } from '../core/packDocs/host';
import { textOf } from '../core/toolResult';
import { PackDocsHandler } from '../packDocsHandler';
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

        test('an import never takes the file it is given: the copy itself, the copy through a linked folder, a file below its folder', async () => {
            const { service, solution } = made;
            await service.addDocument(DEVICE, RM, { title: 'Reference manual' });
            const copy = (await service.downloadDocument(DEVICE, RM)).path!;
            // The copy itself, picked in the import dialog.
            const again = await service.importDocument(DEVICE, RM, copy);
            assert.ok(fs.existsSync(copy) && again.path !== undefined && fs.readFileSync(again.path).equals(PDF), 'the copy imported as itself is still there');
            // The same file through a link to its folder: another spelling of the same place.
            const link = path.join(path.dirname(solution), 'linked-copies');
            fs.symlinkSync(path.dirname(again.path), link, 'junction');
            const linked = await service.importDocument(DEVICE, RM, path.join(link, path.basename(again.path)));
            assert.ok(linked.path !== undefined && fs.readFileSync(linked.path).equals(PDF), 'reached through a link, it is still there');
            // A newer edition the user put below the copy's folder.
            const newer = Buffer.concat([PDF, Buffer.from('% revision 7\n')]);
            const below = path.join(path.dirname(linked.path), 'by-hand', 'rm0456-rev7.pdf');
            fs.mkdirSync(path.dirname(below), { recursive: true });
            fs.writeFileSync(below, newer);
            const imported = await service.importDocument(DEVICE, RM, below);
            assert.ok(fs.existsSync(below) && fs.readFileSync(below).equals(newer), 'the selected file stays where it is');
            assert.ok(imported.path !== undefined && fs.readFileSync(imported.path).equals(newer), 'and the document\'s copy has its bytes');
            assert.strictEqual(imported.error, undefined);
        });

        test('a URL the user and the project both list: removing it for the project leaves the user\'s entry and copy, also when repeated', async () => {
            const { service, solution } = made;
            await service.addDocument(DEVICE, RM, { title: 'Mine' });
            const mine = await service.downloadDocument(DEVICE, RM);
            await service.addDocument(DEVICE, RM, { title: 'The project\'s', scope: 'project', solution });
            const shared = await service.downloadDocument(DEVICE, RM, {}, solution);
            assert.ok(mine.path && shared.path && shared.path !== mine.path, 'each entry has a copy of its own');
            assert.ok(await service.removeDocument(DEVICE, RM, solution));
            assert.ok(!fs.existsSync(shared.path), 'the project entry\'s copy goes');
            assert.strictEqual(await service.removeDocument(DEVICE, RM, solution), false, 'nothing of the project is left to remove');
            assert.deepStrictEqual((await service.getDocuments(DEVICE, solution)).map((doc) => [doc.scope, doc.title, doc.path]), [['user', 'Mine', mine.path]]);
            assert.ok(fs.existsSync(mine.path), 'the user\'s copy stays');
            assert.ok(await service.removeDocument(DEVICE, RM), 'without the csolution it is the user\'s that goes');
            assert.ok(!fs.existsSync(mine.path));
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

    test('two local documents of one parent with the same file name are both listed, the first under the id it had', () => {
        const core = { core: 'Cortex-M7' };
        const local = (file: string, title: string, scope: 'user' | 'project' = 'user'): DocumentInfo =>
            ({ name: file, title, parent: core, scope, location: 'local', path: file, format: 'pdf' });
        const docs: DocRef[] = [];
        assert.strictEqual(mergeServiceDocs(docs, [local('/a/datasheet.pdf', 'Sheet A'), local('/b/datasheet.pdf', 'Sheet B'), local('/a/datasheet.pdf', 'Sheet A')], 'the view'), 2);
        assert.deepStrictEqual(docs.map((doc) => [doc.title, doc.path]), [['Sheet A', '/a/datasheet.pdf'], ['Sheet B', '/b/datasheet.pdf']]);
        assert.strictEqual(docs[0].id, 'user/cortex-m7/datasheet');
        assert.match(docs[1].id, /^user\/cortex-m7\/datasheet-[0-9a-f]{6}$/);
        const other: DocRef[] = [];
        mergeServiceDocs(other, [local('/c/other.pdf', 'Other'), local('/b/datasheet.pdf', 'Sheet B'), local('/a/datasheet.pdf', 'Sheet A')], 'the view');
        assert.deepStrictEqual(other.map((doc) => doc.id), ['user/cortex-m7/other', 'user/cortex-m7/datasheet', `user/cortex-m7/datasheet-${shortHash('/a/datasheet.pdf').slice(0, 6)}`],
            'the hash is of the document\'s own name, not of its place in the list');
        assert.strictEqual(docs[1].id, `user/cortex-m7/datasheet-${shortHash('/b/datasheet.pdf').slice(0, 6)}`);
        // Two project files outside the project have no path: the bare file name is no file to tell them by.
        const outside = (name: string, title: string): DocumentInfo => ({ name, title, parent: core, scope: 'project', location: 'local' });
        const missing: DocRef[] = [];
        assert.strictEqual(mergeServiceDocs(missing, [outside('../a/spec.pdf', 'Spec A'), outside('../b/spec.pdf', 'Spec B')], 'the view'), 2);
        assert.deepStrictEqual(missing.map((doc) => [doc.title, doc.service?.name, doc.missing]), [['Spec A', '../a/spec.pdf', true], ['Spec B', '../b/spec.pdf', true]]);
    });

    test('a URL with two entries keeps the one that has the copy; without a copy the first entry counts', () => {
        const entry = (scope: 'user' | 'project', parent: DocumentInfo['parent'], copy?: string): DocumentInfo =>
            ({ name: RM, title: `${scope} entry`, parent, scope, location: 'web', ...(copy ? { path: copy, format: 'pdf' as const } : {}) });
        const serviceOf = (infos: DocumentInfo[]): [number, string | undefined, string | undefined] => {
            const docs: DocRef[] = [];
            const added = mergeServiceDocs(docs, infos, 'the view');
            return [added, docs[0].service?.scope, docs[0].service?.copy];
        };
        const core = { core: 'Cortex-M7' };
        assert.deepStrictEqual(serviceOf([entry('user', core, '/copies/rm0456.pdf'), entry('project', core)]), [1, 'user', '/copies/rm0456.pdf'],
            'the project\'s reference does not take the user\'s copy away');
        assert.deepStrictEqual(serviceOf([entry('user', DEVICE, '/copies/rm0456.pdf'), entry('user', { all: true })]), [1, 'user', '/copies/rm0456.pdf']);
        assert.deepStrictEqual(serviceOf([entry('user', core), entry('project', core, '/copies/projects/1/rm0456.pdf')]), [1, 'project', '/copies/projects/1/rm0456.pdf'],
            'only the later entry has the copy');
        assert.deepStrictEqual(serviceOf([entry('user', core, '/copies/rm0456.pdf'), entry('project', core, '/copies/projects/1/rm0456.pdf')]), [1, 'user', '/copies/rm0456.pdf'],
            'both have one: the first');
        assert.deepStrictEqual(serviceOf([entry('user', core), entry('project', core)]), [1, 'user', undefined]);
        const gone: DocumentInfo = { ...entry('user', core, '/copies/rm0456.pdf'), error: { kind: 'missing-file', detail: 'not there' } };
        assert.deepStrictEqual(serviceOf([gone, entry('project', core, '/copies/projects/1/rm0456.pdf')]), [1, 'project', '/copies/projects/1/rm0456.pdf'],
            'a copy that is gone is none');
    });
});

/** `docs.yml` as CMSIS Solution writes it: its catalogue, a device with a pack's web book and a pack file. */
const SOLUTION_INVENTORY = [
    'docs:',
    '  commons:',
    '    - common: arm-docs',
    '      docs:',
    '        - name: https://developer.arm.com/documentation/ddi0553/latest',
    '          title: Armv8-M Architecture Reference Manual',
    '          category: arch',
    '          id: ddi0553',
    '          version: latest',
    '          format: pdf',
    '          metadataUrl: https://documentation-service.arm.com/documentation/ddi0553/latest',
    '        - name: https://developer.arm.com/documentation/100806/0100',
    '          title: CoreSight SoC-600 Technical Reference Manual',
    '          id: 100806',
    '          version: 0100',
    '          format: pdf',
    '  devices:',
    '    - device: STMicroelectronics::STM32U585AIIx',
    '      pack: Keil::STM32U5xx_DFP@3.1.0',
    '      docs:',
    `        - name: ${RM}`,
    '          title: STM32U5 reference manual',
    '          category: manual',
    '        - name: /packs/Keil/STM32U5xx_DFP/3.1.0/Documents/errata.pdf',
    '          title: Errata',
    '          path: /packs/Keil/STM32U5xx_DFP/3.1.0/Documents/errata.pdf',
    '',
].join('\n');

interface InventoryFile {
    docs: Record<string, { docs?: Record<string, unknown>[]; [key: string]: unknown }[]>;
}

suite('the emulator in CMSIS Solution\'s folder: docs.yml shared, docs.xtra.yml beside it, copies in docs/', () => {
    let root: string;
    let service: EmulatedDocumentService;
    let inventory: string;
    const read = (): InventoryFile => load(fs.readFileSync(inventory, 'utf-8')) as InventoryFile;
    const state = (): { docs: Record<string, unknown>[] } => load(fs.readFileSync(path.join(root, 'docs.xtra.yml'), 'utf-8')) as { docs: Record<string, unknown>[] };
    const local = (name: string): string => {
        const file = path.join(root, '..', `${path.basename(root)}-files`, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, PDF);
        return file;
    };

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-dot-cmsis-'));
        inventory = path.join(root, 'docs.yml');
        fs.writeFileSync(inventory, SOLUTION_INVENTORY);
        service = new EmulatedDocumentService({ root, engine: fakeEngine([]) });
    });
    teardown(() => {
        service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(`${root}-files`, { recursive: true, force: true });
    });

    test('a pack\'s book nobody fetched is CMSIS Solution\'s; a fetch keeps its entry, puts the copy where CMSIS Solution looks, the facts beside docs.yml', async () => {
        assert.deepStrictEqual(await service.getDocuments(DEVICE), [], 'neither the web book nor the pack file is the service\'s');
        const added = await service.addDocument(DEVICE, RM, { title: 'STM32U5 reference manual' });
        assert.deepStrictEqual([added.scope, added.path, added.category], ['user', undefined, 'manual']);
        assert.strictEqual(fs.readFileSync(inventory, 'utf-8'), SOLUTION_INVENTORY, 'taking a book up changes no byte of docs.yml');
        const done = await service.downloadDocument(DEVICE, RM);
        const copy = path.join(root, 'docs', 'STMicroelectronics', 'STM32U585AIIx', 'rm0456', 'rm0456.pdf');
        assert.deepStrictEqual([done.path, done.versionLabel, done.bytes], [copy, 'Rev 6', PDF.length]);
        const [device] = read().docs.devices;
        assert.deepStrictEqual(device.docs![0], { name: RM, title: 'STM32U5 reference manual', category: 'manual', path: copy },
            'only the fields CMSIS Solution knows; no mode, so the book stays the pack\'s');
        assert.deepStrictEqual([device.pack, device.docs![1].title, device.docs!.length], ['Keil::STM32U5xx_DFP@3.1.0', 'Errata', 2]);
        const text = fs.readFileSync(inventory, 'utf-8');
        assert.match(text, /^ {10}version: 0100$/m, 'a scalar stays the text it was');
        assert.match(text, /metadataUrl: https:\/\/documentation-service\.arm\.com\/documentation\/ddi0553\/latest/);
        assert.deepStrictEqual(state().docs.map((row) => [row.parent, row.name, row.path, row.bytes, row.versionLabel]),
            [['device:STMicroelectronics::STM32U585AIIx', RM, copy, PDF.length, 'Rev 6']]);
    });

    test('CMSIS Solution renews a device\'s entries for a new pack version: the copy and its facts come back, and docs.yml gets its path again', async () => {
        await service.addDocument(DEVICE, RM);
        const { path: copy } = await service.downloadDocument(DEVICE, RM);
        fs.writeFileSync(inventory, SOLUTION_INVENTORY.replace('@3.1.0', '@3.2.0'));
        const [kept] = await service.getDocuments(DEVICE);
        assert.deepStrictEqual([kept.path, kept.versionLabel, kept.error], [copy, 'Rev 6', undefined]);
        await service.addDocument(DEVICE, RM, { category: 'reference' });
        assert.deepStrictEqual(read().docs.devices[0].docs![0], { name: RM, title: 'STM32U5 reference manual', category: 'reference', path: copy });
    });

    test('a request shows as the entry\'s error; a copy made in the CMSIS view answers it', async () => {
        const board = (): Record<string, unknown> => read().docs.boards[0].docs![0];
        await service.addDocument(BOARD, WALL, { title: 'Schematic' });
        await assert.rejects(service.downloadDocument(BOARD, WALL));
        assert.deepStrictEqual([board().error, (await service.getDocuments(BOARD))[0].error?.kind], [undefined, 'login-required'],
            'a failure alone is no badge in the CMSIS view: it is kept beside docs.yml');
        await service.requestDocument(BOARD, WALL, { by: 'agent', reason: 'Requested by the agent: J3 pinout\n(login at www.vendor.com)' });
        assert.deepStrictEqual(board(), { name: WALL, mode: 'user', title: 'Schematic', error: 'Requested by the agent: J3 pinout (login at www.vendor.com)' },
            'a document the service adds is a user document, and the request one line');
        assert.deepStrictEqual((await service.getRequests()).map((doc) => [doc.name, doc.error?.kind]), [[WALL, 'login-required']]);
        // The user downloads it by hand and uses Import Document in the CMSIS view: a path, and the error gone.
        const imported = path.join(root, 'docs', 'STMicroelectronics', 'B-U585I-IOT02A', 'schematic', 'schematic.pdf');
        fs.mkdirSync(path.dirname(imported), { recursive: true });
        fs.writeFileSync(imported, PDF);
        const changed = read();
        changed.docs.boards[0].docs![0] = { name: WALL, mode: 'user', title: 'Schematic', path: imported };
        fs.writeFileSync(inventory, dump(changed));
        const [answered] = await service.getDocuments(BOARD);
        assert.deepStrictEqual([answered.path, answered.requested, answered.error], [imported, undefined, undefined]);
        assert.deepStrictEqual(await service.getRequests(), []);
    });

    test('a document added in the CMSIS view is the service\'s: listed, and removed with its folder', async () => {
        const copy = path.join(root, 'docs', 'STMicroelectronics', 'STM32U585AIIx', 'bmi270', 'bmi270.pdf');
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.writeFileSync(copy, PDF);
        fs.writeFileSync(path.join(path.dirname(copy), 'bmi270.idx.json'), '{}');
        const changed = read();
        changed.docs.devices[0].docs!.push({ name: '/home/me/Downloads/bmi270.pdf', title: 'bmi270.pdf', path: copy, mode: 'user' });
        fs.writeFileSync(inventory, dump(changed));
        const [listed] = await service.getDocuments(DEVICE);
        assert.deepStrictEqual([listed.name, listed.location, listed.path, listed.scope], ['/home/me/Downloads/bmi270.pdf', 'local', copy, 'user']);
        assert.ok(await service.removeDocument(DEVICE, listed.name));
        assert.ok(!fs.existsSync(path.dirname(copy)), 'the folder goes, with the index beside the copy');
        assert.deepStrictEqual(read().docs.devices[0].docs!.map((doc) => doc.title), ['STM32U5 reference manual', 'Errata']);
    });

    test('a download whose file another window moved to the copy\'s name first still resolves, without an error on the document', async () => {
        const arm = 'https://developer.arm.com/documentation/ddi0553/latest';
        const racing = new EmulatedDocumentService({ root, engine: {
            async download(_url, destDir) {
                const file = path.join(destDir, 'DDI0553B_z_armv8m_arm.pdf');
                fs.writeFileSync(file, PDF);
                // The other window ended the same download a moment earlier and gave the file the name both look for.
                fs.renameSync(file, path.join(destDir, 'ddi0553-latest.pdf'));
                return { path: file, bytes: PDF.length, sha256: 'x', filename: 'DDI0553B_z_armv8m_arm.pdf', resolver: 'arm.com' };
            },
        } });
        try {
            await racing.addDocument({ all: true }, arm, { title: 'Armv8-M Architecture Reference Manual' });
            const done = await racing.downloadDocument({ all: true }, arm);
            assert.deepStrictEqual([done.path, done.error], [path.join(root, 'docs', 'ddi0553-latest', 'ddi0553-latest.pdf'), undefined]);
            assert.ok(fs.readFileSync(done.path!).equals(PDF));
        } finally {
            racing.dispose();
        }
    });

    test('an Arm document lies in CMSIS Solution\'s catalogue and folder; core, pack, vendor and all have lists and folders of their own', async () => {
        const arm = 'https://developer.arm.com/documentation/ddi0553/latest';
        await service.addDocument({ all: true }, arm, { title: 'Armv8-M Architecture Reference Manual' });
        const manual = await service.importDocument({ all: true }, arm, local('DDI0553B_y_armv8m_arm.pdf'), undefined, { versionLabel: 'B.y' });
        const armCopy = path.join(root, 'docs', 'ddi0553-latest', 'ddi0553-latest.pdf');
        assert.deepStrictEqual([manual.path, manual.versionLabel, manual.filename], [armCopy, 'B.y', 'DDI0553B_y_armv8m_arm.pdf']);
        assert.deepStrictEqual(read().docs.commons[0].docs![0], { name: arm, title: 'Armv8-M Architecture Reference Manual', category: 'arch', id: 'ddi0553',
            version: 'latest', format: 'pdf', metadataUrl: 'https://documentation-service.arm.com/documentation/ddi0553/latest', path: armCopy });

        const everywhere = await service.addDocument({ all: true }, local('bmi270.pdf'), { title: 'BMI270' });
        const core = await service.addDocument({ core: 'Cortex-M33' }, local('mpu.pdf'));
        await service.addDocument({ pack: 'Keil::STM32U5xx_DFP' }, RM, { title: 'RM' });
        const pack = await service.downloadDocument({ pack: 'Keil::STM32U5xx_DFP' }, RM);
        const vendor = await service.addDocument({ vendor: 'Keil' }, local('notes.pdf'));
        assert.deepStrictEqual([everywhere.path, core.path, pack.path, vendor.path].map((file) => path.relative(path.join(root, 'docs'), file!).split(path.sep).join('/')),
            ['all/bmi270/bmi270.pdf', 'cores/Cortex-M33/mpu/mpu.pdf', 'packs/Keil/STM32U5xx_DFP/rm0456/rm0456.pdf', 'vendors/Keil/notes/notes.pdf']);
        const file = read().docs;
        assert.deepStrictEqual(file.commons.map((common) => common.common), ['arm-docs', 'all']);
        assert.deepStrictEqual([file.cores[0].core, file.packs[0].pack, file.vendors[0].vendor], ['Cortex-M33', 'Keil::STM32U5xx_DFP', 'Keil']);
        assert.deepStrictEqual(file.commons[1].docs![0], { name: everywhere.name, mode: 'user', title: 'BMI270', path: everywhere.path });
        assert.strictEqual((await service.getDocuments({ all: true })).length, 2, 'the Arm document it has a copy of, and the user\'s; not the rest of the catalogue');

        // Removing an Arm document removes the copy; the catalogue entry is CMSIS Solution's and stays.
        assert.ok(await service.removeDocument({ all: true }, arm));
        assert.ok(!fs.existsSync(path.dirname(armCopy)));
        assert.deepStrictEqual(read().docs.commons[0].docs![0].path, undefined);
        assert.strictEqual(read().docs.commons[0].docs!.length, 2);
        assert.ok(await service.removeDocument({ core: 'Cortex-M33' }, core.name));
        assert.strictEqual(read().docs.cores.length, 0, 'an item the service made goes with its last document');
    });

    test('two documents of one device that end in the same file name get a folder each', async () => {
        const first = 'https://a.example.com/files/datasheet.pdf';
        const second = 'https://b.example.com/other/datasheet.pdf';
        await service.addDocument(DEVICE, first);
        await service.addDocument(DEVICE, second);
        const one = await service.downloadDocument(DEVICE, first);
        const two = await service.downloadDocument(DEVICE, second);
        assert.strictEqual(path.relative(path.join(root, 'docs'), one.path!).split(path.sep).join('/'), 'STMicroelectronics/STM32U585AIIx/datasheet/datasheet.pdf');
        assert.match(path.relative(path.join(root, 'docs'), two.path!).split(path.sep).join('/'), /^STMicroelectronics\/STM32U585AIIx\/datasheet-[0-9a-f]{8}\/datasheet\.pdf$/);
        assert.ok(fs.existsSync(one.path!) && fs.existsSync(two.path!));
        assert.strictEqual((await service.downloadDocument(DEVICE, second)).path, two.path, 'a second download goes into the same folder');
    });

    test('CMSIS Solution writes docs.yml between the read and the write: the change is applied to what it wrote', async () => {
        await service.addDocument(DEVICE, RM);
        service.dispose();
        let written = false;
        const theirs = SOLUTION_INVENTORY + ['  boards:', '    - board: STMicroelectronics::B-U585I-IOT02A:C', '      pack: Keil::B-U585I-IOT02A_BSP@2.0.0', ''].join('\n');
        service = new EmulatedDocumentService({
            root, engine: fakeEngine([]), now: () => {
                if (!written) {
                    written = true;
                    fs.writeFileSync(inventory, theirs);
                }
                return new Date(0);
            },
        });
        const done = await service.downloadDocument(DEVICE, RM);
        const file = read().docs;
        assert.ok(written);
        assert.deepStrictEqual([file.boards[0].board, file.devices[0].docs![0].path], ['STMicroelectronics::B-U585I-IOT02A:C', done.path]);
    });

    test('a file that is not an inventory is refused and left as it is', async () => {
        fs.writeFileSync(inventory, '- just: a list\n');
        await assert.rejects(service.getDocuments(DEVICE), /is not a document inventory/);
        await assert.rejects(service.addDocument(DEVICE, RM), /is not a document inventory/);
        assert.strictEqual(fs.readFileSync(inventory, 'utf-8'), '- just: a list\n');
        assert.ok(!fs.existsSync(path.join(root, 'docs.xtra.yml')));
    });
});

/** A project inventory with more than the service knows: commons, an item's pack, a list and a key of others, text that looks like a number. */
const PROJECT_INVENTORY = [
    'generator: by hand',
    'docs:',
    '  commons:',
    '    - common: arm-docs',
    '      docs:',
    '        - name: https://developer.arm.com/documentation/ddi0553/latest',
    '          id: ddi0553',
    '  devices:',
    `    - device: ${DEVICE.device}`,
    '      pack: Keil::STM32U5xx_DFP@3.1.0',
    '      docs:',
    `        - name: ${RM}`,
    '          title: STM32U5 reference manual',
    '          revision: 0100',
    '  boards:',
    `    - board: ${BOARD.board}`,
    '      pack: Keil::B-U585I-IOT02A_BSP@2.0.0',
    '  sensors:',
    '    - sensor: Bosch::BMI270',
    '      docs:',
    '        - name: docs/bmi270.pdf',
    '',
].join('\n');

suite('the emulator and a project\'s .cmsis/docs.yml: changed in place, watched before it is there', () => {
    let base: string;
    let solution: string;
    const windows: EmulatedDocumentService[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    /** A window's service on the shared root, with what its listener heard. */
    const aWindow = (watch = true): { service: EmulatedDocumentService; heard: { count: number } } => {
        const service = new EmulatedDocumentService({ root: path.join(base, 'home', '.cmsis'), engine: fakeEngine([]), watch });
        const heard = { count: 0 };
        service.onDidChangeDocuments(() => { heard.count++; });
        windows.push(service);
        return { service, heard };
    };
    /** Whether the listener hears of a change within 3 s of `act`. */
    const hears = async (heard: { count: number }, act: () => unknown): Promise<boolean> => {
        const before = heard.count;
        await act();
        for (let round = 0; round < 150 && heard.count === before; round++) {
            await sleep(20);
        }
        return heard.count > before;
    };
    /** A new watcher is handed what happened just before it on some platforms: let that pass. */
    const settle = (): Promise<void> => sleep(300);

    setup(() => {
        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-project-docs-')));
        solution = path.join(base, 'project', 'Blinky.csolution.yml');
        fs.mkdirSync(path.dirname(solution), { recursive: true });
        fs.writeFileSync(solution, 'solution:\n');
    });
    teardown(() => {
        windows.splice(0).forEach((service) => service.dispose());
        fs.rmSync(base, { recursive: true, force: true });
    });

    test('a write of the project file keeps what the service does not know: commons, an item\'s pack, lists and keys of others, a scalar as its text', async () => {
        const { service } = aWindow(false);
        const file = projectInventoryFile(solution);
        const read = (): InventoryFile => load(fs.readFileSync(file, 'utf-8')) as InventoryFile;
        const local = path.join(path.dirname(solution), 'docs', 'errata.pdf');
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, PDF);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, PROJECT_INVENTORY);
        const before = read().docs;

        await service.addDocument(DEVICE, local, { title: 'Errata', scope: 'project', solution });
        const added = read().docs;
        assert.deepStrictEqual(added.devices[0].docs!.pop(), { name: 'docs/errata.pdf', title: 'Errata' });
        assert.deepStrictEqual(added, before, 'but for the new entry, docs: says what it said');
        const text = fs.readFileSync(file, 'utf-8');
        assert.match(text, /^generator: by hand$/m, 'a key beside docs: stays');
        assert.match(text, /^ {10}revision: 0100$/m, 'a scalar stays the text it was');
        assert.doesNotMatch(text, /^version:/m, 'a file that has no version gets none');

        assert.ok(await service.removeDocument(DEVICE, 'docs/errata.pdf', solution));
        assert.ok(await service.removeDocument(DEVICE, RM, solution));
        const removed = read().docs;
        assert.deepStrictEqual(removed.devices, [{ device: DEVICE.device, pack: 'Keil::STM32U5xx_DFP@3.1.0', docs: [] }],
            'an item that carries more than its key stays when its last document goes');
        assert.deepStrictEqual([removed.commons, removed.boards, removed.sensors], [before.commons, before.boards, before.sensors]);
        assert.ok(fs.existsSync(local), 'the project\'s file is never deleted');
    });

    test('the first project document, added by another window into a .cmsis folder that was not there, is announced', async function () {
        this.timeout(15_000);
        const first = aWindow();
        assert.deepStrictEqual(await first.service.getDocuments(DEVICE, solution), []);
        assert.ok(!fs.existsSync(path.dirname(projectInventoryFile(solution))), 'the folder is not there when the first window reads');
        const other = aWindow();
        await settle();
        assert.ok(await hears(first.heard, () => other.service.addDocument(DEVICE, RM, { scope: 'project', solution })), 'the first document');
        assert.strictEqual((await first.service.getDocuments(DEVICE, solution)).length, 1);
        await settle();
        assert.ok(await hears(first.heard, () => other.service.addDocument(BOARD, WALL, { scope: 'project', solution })), 'the next one, from the folder itself');
    });

    test('a .cmsis folder that goes is announced, and so is the inventory written into it again', async function () {
        if (process.platform === 'win32') {
            // Not measured there: Windows reports the removal of a watched folder as an error of the watcher.
            this.skip();
        }
        this.timeout(15_000);
        const first = aWindow();
        const other = aWindow();
        await other.service.addDocument(DEVICE, RM, { scope: 'project', solution });
        assert.strictEqual((await first.service.getDocuments(DEVICE, solution)).length, 1);
        await settle();
        assert.ok(await hears(first.heard, () => fs.rmSync(path.dirname(projectInventoryFile(solution)), { recursive: true, force: true })), 'the folder went');
        assert.deepStrictEqual(await first.service.getDocuments(DEVICE, solution), []);
        await settle();
        assert.ok(await hears(first.heard, () => other.service.addDocument(DEVICE, RM, { scope: 'project', solution })), 'written again');
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

    test('one inventory for the CMSIS view and the agent: its book is fetched into its folder and indexed beside the copy; its user document is listed once', async () => {
        const dotCmsis = path.join(world.root, 'docservice');
        const url = 'https://www.st.com/resource/en/datasheet/stm32f756bg.pdf';
        const added = path.join(dotCmsis, 'docs', 'STMicroelectronics', 'STM32F756ZGTx', 'bmi270', 'bmi270.pdf');
        fs.mkdirSync(path.dirname(added), { recursive: true });
        fs.copyFileSync(path.join(world.workspace, 'docs', 'board-um.pdf'), added);
        const inventory = path.join(dotCmsis, 'docs.yml');
        fs.writeFileSync(inventory, ['docs:', '  devices:', '    - device: STMicroelectronics::STM32F756ZGTx', '      pack: Keil::STM32F7xx_DFP@3.0.0', '      docs:',
            `        - name: ${url}`, '          title: STM32F756 Data Sheet', '          category: datasheet',
            '        - name: /home/me/Downloads/bmi270.pdf', '          title: BMI270', `          path: ${added}`, '          mode: user', ''].join('\n'));
        const fetchFn = async (target: string): Promise<Response> => (target === url
            ? new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }) : world.host.fetchFn!(target));
        service.dispose();
        service = new EmulatedDocumentService({ root: dotCmsis,
            engine: documentEngine({ fetchFn, userAgent: 'test', log: world.host.log, timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024 }) });
        const handler = new PackDocsHandler({ ...host, inventoryFile: inventory }, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Data\nVDD']) });
        const listed = textOf(await handler.handleListTargetDocs({}));
        assert.deepStrictEqual(listed.split('\n').filter((line) => line.includes('BMI270')).map((line) => line.trim().replace(/\d+ kB/, 'n kB')),
            ['user/stm32f756zgtx/bmi270 · user · BMI270 · n kB (added by the user), not indexed yet']);
        const id = (await handler.inspectTarget({})).docs.find((doc) => doc.url === url)!.id;
        const fetched = textOf(await handler.handleFetchDoc({ doc: id }));
        assert.match(fetched, /^Fetched .*; kept by the document service \(the Target Documents view\)/s);
        const copy = path.join(dotCmsis, 'docs', 'STMicroelectronics', 'STM32F756ZGTx', 'stm32f756bg', 'stm32f756bg.pdf');
        assert.deepStrictEqual(['.pdf', '.pages.jsonl', '.meta.json', '.idx.json'].map((ext) => fs.existsSync(copy.replace(/\.pdf$/, ext))), [true, true, true, true],
            'the copy where CMSIS Solution looks for it, the extracted text and the index beside it');
        const [book] = (load(fs.readFileSync(inventory, 'utf-8')) as { docs: { devices: { docs: Record<string, unknown>[] }[] } }).docs.devices[0].docs;
        assert.deepStrictEqual(book, { name: url, title: 'STM32F756 Data Sheet', category: 'datasheet', path: copy });
        const after = textOf(await handler.handleListTargetDocs({})).split('\n').filter((line) => line.includes('STM32F756 Data Sheet'));
        assert.strictEqual(after.length, 1, after.join('\n'));
        assert.match(after[0], /· indexed, 1 p$/);
        assert.ok(!fs.existsSync(path.join(world.host.storageDir, 'web')), 'nothing of it in the extension\'s own store');
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
