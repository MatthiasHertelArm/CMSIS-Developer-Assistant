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

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocRef } from '../core/packDocs/pdscBooks';
import { PageStore } from '../core/packDocs/pageStore';
import { PdfExtractor, PdfjsExtractor, PdftotextExtractor, itemsToPageText, selectExtractor, splitPages } from '../core/packDocs/pdfExtract';
import { defaultSettings, silentLog } from '../core/packDocs/host';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

class FakeExtractor implements PdfExtractor {
    readonly name = 'fake';
    calls = 0;
    constructor(private readonly pages: string[]) { }
    async available() { return { ok: true, detail: 'fake' }; }
    async extract() { this.calls++; return { pages: this.pages, extractor: this.name, ms: 1 }; }
}

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-test-'));
}

function docFor(file: string): DocRef {
    return { id: 'p/test-rm', title: 'Test RM', scope: 'device', pack: 'V::P@1.0.0', packId: { vendor: 'V', name: 'P', version: '1.0.0' }, source: 'pack', path: file, sizeBytes: fs.statSync(file).size, cached: false, indexed: false };
}

suite('pageStore', () => {
    test('extracts once, writes the three sidecars, and reuses them until the file changes', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        const fake = new FakeExtractor(['1 Intro\nHello RCC_AHB1ENR', '2 More\nGPIOAEN bit']);
        const doc = docFor(file);

        assert.strictEqual(store.isCurrent(doc), false);
        const first = await store.ensure(doc, fake);
        assert.strictEqual(fake.calls, 1);
        assert.strictEqual(first.meta.pageCount, 2);
        assert.strictEqual(first.pages()[1].heading, '2 More');
        assert.ok(first.index.postings['gpioaen']);
        assert.strictEqual(first.index.version, 2);
        assert.ok(first.index.headingPostings?.['intro'], 'the heading field is indexed');
        const p = store.paths(doc);
        assert.ok(fs.existsSync(p.pages) && fs.existsSync(p.meta) && fs.existsSync(p.index));

        // An index written before the heading field (version 1) is rebuilt from
        // the persisted pages on load — no re-extraction.
        const v1 = { version: 1, docId: doc.id, pageCount: 2, lengths: [3, 2], postings: { hello: [0, 1] } };
        fs.writeFileSync(p.index, JSON.stringify(v1));
        const again = new PageStore(path.join(dir, 'store')).load(doc);
        assert.ok(again, 'still current: the pages and meta are intact');
        assert.strictEqual(again!.index.version, 2);
        assert.ok(again!.index.headingPostings?.['more'] && again!.index.postings['gpioaen'], 'rebuilt from the pages');
        assert.strictEqual((JSON.parse(fs.readFileSync(p.index, 'utf-8')) as { version: number }).version, 2, 'and written back');
        assert.strictEqual(fake.calls, 1, 'no extraction happened');
        assert.strictEqual(p.dir, path.join(dir, 'store', 'v', 'p', '1.0.0'));
        assert.strictEqual(doc.indexed, true);
        assert.strictEqual(doc.pages, 2);

        const store2 = new PageStore(path.join(dir, 'store'));
        const second = await store2.ensure(doc, fake);
        assert.strictEqual(fake.calls, 1, 'cache hit');
        assert.strictEqual(second.pages().length, 2);
        assert.strictEqual(store2.annotate({ ...doc, cached: false, indexed: false, pages: undefined }).pages, 2);

        // Touch the file → re-extracted.
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(file, later, later);
        assert.strictEqual(store2.isCurrent(doc), false);
        await store2.ensure(doc, fake);
        assert.strictEqual(fake.calls, 2);
    });

    test('workspace documents are keyed by their folder; version-1 metadata from 0.1.x is still accepted', async () => {
        const dir = tmp();
        const a = path.join(dir, 'one', 'docs', 'um.pdf');
        const b = path.join(dir, 'two', 'docs', 'um.pdf');
        fs.mkdirSync(path.dirname(a), { recursive: true });
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), a);
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), b);
        const store = new PageStore(path.join(dir, 'store'));
        const wsDoc = (file: string): DocRef => ({ id: 'workspace/um', title: 'um', scope: 'workspace', source: 'workspace', path: file, cached: false, indexed: false });
        const pa = store.paths(wsDoc(a));
        const pb = store.paths(wsDoc(b));
        assert.match(pa.dir, /[\\/]store[\\/]workspace[\\/][0-9a-f]{12}$/);
        assert.notStrictEqual(pa.dir, pb.dir, 'same file name in two folders → two cache directories');
        assert.strictEqual(path.basename(pa.pages), 'um.pages.jsonl');

        const fake = new FakeExtractor(['page one', 'page two']);
        const doc = wsDoc(a);
        const loaded = await store.ensure(doc, fake);
        assert.strictEqual(loaded.meta.version, 2);
        assert.strictEqual(loaded.meta.source, 'workspace');
        assert.strictEqual(loaded.meta.unit, 'page');
        assert.strictEqual(doc.unit, 'page');

        // A sidecar written by 0.1.x (version 1, no source/unit) is still current.
        const meta = JSON.parse(fs.readFileSync(pa.meta, 'utf-8'));
        delete meta.source; delete meta.title; delete meta.unit;
        meta.version = 1;
        fs.writeFileSync(pa.meta, JSON.stringify(meta));
        const store2 = new PageStore(path.join(dir, 'store'));
        assert.strictEqual(store2.isCurrent(wsDoc(a)), true);
        assert.strictEqual(store2.annotate(wsDoc(a)).pages, 2);
        assert.strictEqual(store2.readMeta(wsDoc(b)), undefined, 'the other folder has no cache');
    });

    test('listCached enumerates every extracted document with its sidecars', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        assert.deepStrictEqual(store.listCached(), []);
        const doc = docFor(file);
        doc.revision = 'Rev 3';
        await store.ensure(doc, new FakeExtractor(['1 Intro\nHello', '2 More\nWorld']));
        const ws: DocRef = { id: 'workspace/um', title: 'um', scope: 'workspace', source: 'workspace', path: file, cached: false, indexed: false };
        await store.ensure(ws, new FakeExtractor(['only']));
        const list = store.listCached();
        assert.deepStrictEqual(list.map(e => e.id), ['p/test-rm', 'workspace/um']);
        const first = list[0];
        assert.strictEqual(first.source, 'pack');
        assert.strictEqual(first.title, 'Test RM');
        assert.strictEqual(first.revision, 'Rev 3');
        assert.strictEqual(first.pageCount, 2);
        assert.strictEqual(first.unit, 'page');
        assert.strictEqual(first.extractor, 'fake');
        assert.strictEqual(first.file, file);
        assert.strictEqual(first.fileExists, true);
        assert.strictEqual(first.sizeBytes, fs.statSync(file).size);
        assert.ok(first.storedBytes > 100);
        assert.strictEqual(first.dir, path.join(dir, 'store', 'v', 'p', '1.0.0'));
        assert.strictEqual(first.metaPath, path.join(first.dir, 'test-rm.meta.json'));
        assert.strictEqual(first.fetch, undefined);
        assert.deepStrictEqual(store.readCachedPages(first).map(p => p.heading), ['1 Intro', '2 More']);
        assert.ok(store.readCachedIndex(first).postings['hello']);
        assert.strictEqual(list[1].source, 'workspace');
        assert.strictEqual(store.dir, path.join(dir, 'store'));
    });

    test('listFetched rebuilds DocRefs from fetch.json records under arm/ and web/', () => {
        const dir = tmp();
        const store = new PageStore(dir);
        const write = (sub: string, record: object) => {
            fs.mkdirSync(path.join(dir, sub), { recursive: true });
            fs.writeFileSync(path.join(dir, sub, 'fetch.json'), JSON.stringify(record));
        };
        write('arm/ddi0553-latest', { version: 1, docId: 'arm/ddi0553-latest', sourceUrl: 'https://developer.arm.com/documentation/ddi0553/latest', resolver: 'arm.com', kind: 'pdf', title: 'Armv8-M ARM', resolvedVersion: 'bz', versionLabel: 'B.z', downloadUrl: 'x', bytes: 5, sha256: 'a', fetchedAt: 't', userAgent: 'u' });
        write('arm/ddi0489-latest', { version: 1, docId: 'arm/ddi0489-latest', sourceUrl: 'https://developer.arm.com/documentation/ddi0489/latest', resolver: 'arm.com', kind: 'html', title: 'Cortex-M7 TRM', versionLabel: 'r1p2', downloadUrl: '', bytes: 0, sha256: '', fetchedAt: 't', userAgent: 'u' });
        write('web/example-com/0123456789ab', { version: 1, docId: 'web/example-com/0123456789ab', sourceUrl: 'https://example.com/um.pdf', resolver: 'direct', kind: 'pdf', title: 'um.pdf', downloadUrl: 'https://example.com/um.pdf', bytes: 5, sha256: 'a', fetchedAt: 't', userAgent: 'u' });
        write('arm/broken', { nonsense: true });
        fs.mkdirSync(path.join(dir, 'keil', 'x', '1.0.0'), { recursive: true });

        const found = store.listFetched().sort((a, b) => a.id.localeCompare(b.id));
        assert.deepStrictEqual(found.map(d => d.id), ['arm/ddi0489-latest', 'arm/ddi0553-latest', 'web/example-com/0123456789ab']);
        const arm = found[1];
        assert.strictEqual(arm.scope, 'arm');
        assert.strictEqual(arm.source, 'web');
        assert.strictEqual(arm.title, 'Armv8-M ARM');
        assert.strictEqual(arm.revision, 'B.z');
        assert.strictEqual(arm.format, 'pdf');
        assert.deepStrictEqual(arm.arm, { docId: 'ddi0553', version: 'latest', resolvedVersion: 'bz', versionLabel: 'B.z' });
        assert.strictEqual(found[0].format, 'html');
        assert.strictEqual(found[2].scope, 'unlisted');
        assert.strictEqual(found[2].arm, undefined);
        assert.deepStrictEqual(new PageStore(path.join(dir, 'empty')).listFetched(), []);
    });

    test('clearExtracted removes the sidecars and keeps downloads; clearDownloads removes arm/ and web/', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        await store.ensure(docFor(file), new FakeExtractor(['1 Intro\nHello', '2 More\nWorld']));
        // A fetched Arm document as fetch_doc leaves it: download, fetch record, extraction.
        const armDir = path.join(dir, 'store', 'arm', 'ddi0553-latest');
        fs.mkdirSync(armDir, { recursive: true });
        fs.writeFileSync(path.join(armDir, 'doc.pdf'), 'pdf');
        fs.writeFileSync(path.join(armDir, 'fetch.json'), JSON.stringify({ version: 1, docId: 'arm/ddi0553-latest', sourceUrl: 'u', resolver: 'arm.com', kind: 'pdf', title: 'ARM', downloadUrl: 'x', bytes: 3, sha256: 'a', fetchedAt: 't', userAgent: 'u' }));
        const armDoc: DocRef = { id: 'arm/ddi0553-latest', title: 'ARM', scope: 'arm', source: 'web', path: path.join(armDir, 'doc.pdf'), cached: true, indexed: false };
        await store.ensure(armDoc, new FakeExtractor(['1 Debug\nDHCSR']));
        assert.strictEqual(store.listCached().length, 2);

        const usage = store.storeUsage();
        assert.strictEqual(usage.extracted.documents, 2);
        assert.strictEqual(usage.extracted.files, 6, 'three sidecars per extracted document');
        assert.strictEqual(usage.downloads.documents, 1);
        assert.strictEqual(usage.downloads.files, 5, 'download, fetch record and three sidecars');
        assert.ok(usage.downloads.bytes > 3);

        const cleared = store.clearExtracted();
        assert.deepStrictEqual([cleared.documents, cleared.files], [2, 6]);
        assert.ok(cleared.bytes > 0);
        assert.deepStrictEqual(store.listCached(), []);
        assert.ok(fs.existsSync(path.join(armDir, 'doc.pdf')), 'the download stays');
        assert.ok(fs.existsSync(path.join(armDir, 'fetch.json')), 'the fetch record stays');
        assert.deepStrictEqual(store.listFetched().map(d => d.id), ['arm/ddi0553-latest'], 'still fetched');
        assert.ok(!fs.existsSync(path.join(dir, 'store', 'v')), 'an emptied pack directory is pruned');
        assert.ok(fs.existsSync(path.join(dir, 'store')), 'the store root stays');
        assert.strictEqual(store.isCurrent(docFor(file)), false, 'extracted again on its next use');
        assert.deepStrictEqual(store.storeUsage().extracted, { documents: 0, files: 0, bytes: 0 });

        await store.ensure(docFor(file), new FakeExtractor(['1 Intro\nHello', '2 More\nWorld']));
        const deleted = store.clearDownloads();
        assert.deepStrictEqual([deleted.documents, deleted.files], [1, 2]);
        assert.ok(!fs.existsSync(path.join(dir, 'store', 'arm')));
        assert.deepStrictEqual(store.listFetched(), []);
        assert.deepStrictEqual(store.listCached().map(e => e.id), ['p/test-rm'], 'pack extraction survives a download clear');
        assert.deepStrictEqual(store.clearDownloads(), { documents: 0, files: 0, bytes: 0 }, 'idempotent');
        assert.deepStrictEqual(new PageStore(path.join(dir, 'nowhere')).clearExtracted(), { documents: 0, files: 0, bytes: 0 }, 'a missing store is fine');
    });

    test('a document the service keeps is extracted next to its copy and listed from the registered root', async () => {
        const dir = tmp();
        const copyDir = path.join(dir, 'docservice', 'files', 'abc');
        fs.mkdirSync(copyDir, { recursive: true });
        const copy = path.join(copyDir, 'Vendor_RM.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), copy);
        const store = new PageStore(path.join(dir, 'store'));
        const doc: DocRef = { id: 'web/vendor/1234', title: 'Vendor RM', scope: 'user', source: 'web', url: 'https://vendor.example/rm.pdf', path: copy, cached: true, indexed: false,
            service: { parent: { all: true }, name: 'https://vendor.example/rm.pdf', scope: 'user', copy, view: 'the Target Documents view' } };
        await store.ensure(doc, new FakeExtractor(['1 Intro\nHello']));
        for (const ext of ['meta.json', 'pages.jsonl', 'idx.json']) {
            assert.ok(fs.existsSync(path.join(copyDir, `Vendor_RM.${ext}`)), ext);
        }
        assert.ok(!fs.existsSync(path.join(dir, 'store', 'web')), 'nothing in the storage directory');
        assert.deepStrictEqual(store.listCached().map(e => e.id), [], 'an unregistered root is not walked');
        store.addRoot(path.join(dir, 'docservice'));
        assert.deepStrictEqual(store.listCached().map(e => e.id), ['web/vendor/1234']);
        assert.strictEqual(store.clearExtracted().documents, 1);
        assert.ok(fs.existsSync(copy), 'the copy stays');
        assert.ok(!fs.existsSync(path.join(copyDir, 'Vendor_RM.meta.json')));
    });

    test('roots that lie inside one another, or link to one another, count each document once', async () => {
        const dir = tmp();
        const copies = path.join(dir, 'cmsis', 'docs');
        const copyDir = path.join(copies, 'Vendor', 'Device', 'vendor-rm');
        fs.mkdirSync(copyDir, { recursive: true });
        const copy = path.join(copyDir, 'Vendor_RM.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), copy);
        const warnings: string[] = [];
        const store = new PageStore(path.join(dir, 'store'), { ...silentLog, warn: (message: string) => { warnings.push(message); } });
        const doc: DocRef = { id: 'web/vendor/1234', title: 'Vendor RM', scope: 'user', source: 'web', url: 'https://vendor.example/rm.pdf', path: copy, cached: true, indexed: false,
            service: { parent: { all: true }, name: 'https://vendor.example/rm.pdf', scope: 'user', copy, view: 'the Target Documents view' } };
        await store.ensure(doc, new FakeExtractor(['1 Intro\nHello']));
        const sidecars = ['meta.json', 'pages.jsonl', 'idx.json'].map((ext) => path.join(copyDir, `Vendor_RM.${ext}`));
        const bytes = sidecars.reduce((sum, file) => sum + fs.statSync(file).size, 0);
        // As the handler registers them: the folder of the copy for the target, the copy store for the panel.
        store.addRoot(copyDir);
        store.addRoot(copies);
        const alias = path.join(dir, 'alias');
        fs.symlinkSync(copies, alias, 'junction');
        store.addRoot(alias);
        assert.deepStrictEqual(store.listCached().map(e => e.id), ['web/vendor/1234']);
        assert.deepStrictEqual(store.storeUsage().extracted, { documents: 1, files: 3, bytes });
        assert.deepStrictEqual(store.clearExtracted(), { documents: 1, files: 3, bytes });
        assert.deepStrictEqual(warnings, [], 'no file is removed twice');
        assert.ok(fs.existsSync(copy), 'the copy stays');
    });

    test('an index in the storage directory moves next to the copy instead of being extracted again; project documents stay', async () => {
        const dir = tmp();
        const copyDir = path.join(dir, 'files', 'def');
        fs.mkdirSync(copyDir, { recursive: true });
        const copy = path.join(copyDir, 'ddi0439.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), copy);
        const store = new PageStore(path.join(dir, 'store'));
        const legacy: DocRef = { id: 'arm/ddi0439-b', title: 'TRM', scope: 'arm', source: 'web', url: 'https://developer.arm.com/documentation/ddi0439/b', path: copy, cached: true, indexed: false };
        const fake = new FakeExtractor(['1 Intro\nHello']);
        await store.ensure(legacy, fake);
        assert.ok(fs.existsSync(path.join(dir, 'store', 'arm', 'ddi0439-b', 'doc.meta.json')), 'written where it was before');
        const kept: DocRef = { ...legacy, cached: true, indexed: false, service: { parent: { all: true }, name: legacy.url!, scope: 'user', copy, view: 'v' } };
        const loaded = store.load(kept);
        assert.ok(loaded, 'still current after the move');
        assert.strictEqual(fake.calls, 1, 'not extracted again');
        assert.ok(fs.existsSync(path.join(copyDir, 'ddi0439.meta.json')));
        assert.ok(!fs.existsSync(path.join(dir, 'store', 'arm')), 'the emptied folder is pruned');

        const projectFile = path.join(dir, 'project', 'docs', 'notes.pdf');
        fs.mkdirSync(path.dirname(projectFile), { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), projectFile);
        const project: DocRef = { id: 'project/x/notes', title: 'Notes', scope: 'project', source: 'workspace', path: projectFile, cached: false, indexed: false,
            service: { parent: { all: true }, name: 'docs/notes.pdf', scope: 'project', copy: projectFile, view: 'v' } };
        await store.ensure(project, fake);
        assert.ok(!fs.existsSync(path.join(path.dirname(projectFile), 'notes.meta.json')), 'nothing written into the project');
    });

    /** A pack's book of the device `Vendor::Device`, as `collectTargetDocs` hands it to the store. */
    function bookOf(file: string): DocRef {
        return { ...docFor(file), listedFor: { device: 'Vendor::Device' } };
    }

    /** A copy of the fixture PDF at `file`. */
    function fixtureAt(file: string): string {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        return file;
    }

    test('with an index root a pack\'s book is indexed in the folder CMSIS Solution names for it, and listed from there', async () => {
        const dir = tmp();
        const file = fixtureAt(path.join(dir, 'packs', 'V', 'P', '1.0.0', 'Documents', 'Test_RM.pdf'));
        const docs = path.join(dir, 'cmsis', 'docs');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        const fake = new FakeExtractor(['1 Intro\nHello']);
        await store.ensure(bookOf(file), fake);
        const home = path.join(docs, 'Vendor', 'Device', 'Test_RM');
        assert.strictEqual(store.paths(bookOf(file)).dir, home);
        assert.deepStrictEqual(fs.readdirSync(home).sort(), ['Test_RM.idx.json', 'Test_RM.meta.json', 'Test_RM.pages.jsonl']);
        assert.ok(!fs.existsSync(path.join(dir, 'store')), 'nothing in the storage directory');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['Test_RM.pdf'], 'nothing written into the pack');
        assert.deepStrictEqual(store.listCached().map((e) => e.dir), [home], 'the index root is walked without being registered');

        const again = new PageStore(path.join(dir, 'store'), silentLog, docs);
        await again.ensure(bookOf(file), fake);
        assert.strictEqual(fake.calls, 1, 'cache hit');
        // A PDF no book names belongs to its pack; a store without an index root keeps the earlier layout.
        assert.strictEqual(again.paths({ ...docFor(file), scope: 'unlisted' }).dir, path.join(docs, 'packs', 'V', 'P', 'Test_RM'));
        assert.strictEqual(new PageStore(path.join(dir, 'store')).paths(bookOf(file)).dir, path.join(dir, 'store', 'v', 'p', '1.0.0'));
    });

    test('an index of the earlier layout moves into the index root on first use instead of being extracted again', async () => {
        const dir = tmp();
        const file = fixtureAt(path.join(dir, 'packs', 'Test_RM.pdf'));
        const fake = new FakeExtractor(['1 Intro\nHello']);
        await new PageStore(path.join(dir, 'store')).ensure(bookOf(file), fake);
        assert.ok(fs.existsSync(path.join(dir, 'store', 'v', 'p', '1.0.0', 'test-rm.meta.json')), 'written where it was before');

        const docs = path.join(dir, 'cmsis', 'docs');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        assert.ok(store.load(bookOf(file)), 'still current after the move');
        assert.strictEqual(fake.calls, 1, 'not extracted again');
        assert.ok(fs.existsSync(path.join(docs, 'Vendor', 'Device', 'Test_RM', 'Test_RM.meta.json')));
        assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'store')), [], 'the emptied folders are pruned');
    });

    test('two files of one name: the second gets a folder of its own, and an index is never taken for another file\'s', async () => {
        const dir = tmp();
        const first = fixtureAt(path.join(dir, 'packs', '1.0.0', 'Guide.pdf'));
        const second = fixtureAt(path.join(dir, 'packs', '2.0.0', 'Guide.pdf'));
        // The same size and time, as two pack versions with an unchanged PDF have.
        const { atime, mtime } = fs.statSync(first);
        fs.utimesSync(second, atime, mtime);
        const docs = path.join(dir, 'cmsis', 'docs');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        const fake = new FakeExtractor(['1 Intro\nHello']);
        const home = path.join(docs, 'Vendor', 'Device', 'Guide');

        await store.ensure(bookOf(first), fake);
        assert.strictEqual(store.isCurrent(bookOf(second)), false, 'the index of the first is not the second\'s');
        await store.ensure(bookOf(second), fake);
        assert.strictEqual(fake.calls, 2);
        assert.strictEqual(store.paths(bookOf(first)).dir, home);
        assert.match(store.paths(bookOf(second)).dir, /[\\/]Guide-[0-9a-f]{8}$/);
        await store.ensure(bookOf(first), fake);
        await store.ensure(bookOf(second), fake);
        assert.strictEqual(fake.calls, 2, 'both stay current: neither takes the other\'s place');

        // The first is uninstalled: the second keeps its folder, and a third file may take the first's.
        fs.rmSync(first);
        assert.match(store.paths(bookOf(second)).dir, /[\\/]Guide-[0-9a-f]{8}$/);
        const third = fixtureAt(path.join(dir, 'packs', '3.0.0', 'Guide.pdf'));
        fs.utimesSync(third, atime, mtime);
        assert.strictEqual(store.paths(bookOf(third)).dir, home);
        assert.strictEqual(store.isCurrent(bookOf(third)), false, 'same name, size and time, but another file');
        await store.ensure(bookOf(third), fake);
        assert.strictEqual(fake.calls, 3);
        assert.strictEqual(store.readMeta(bookOf(third))?.file, third);
    });

    test('in the index root: a copy has its index beside it whoever keeps it, a project\'s file has a folder under projects/', async () => {
        const dir = tmp();
        const docs = path.join(dir, 'cmsis', 'docs');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        const fake = new FakeExtractor(['1 Intro\nHello']);

        // A copy CMSIS Solution downloaded: the inventory names it, no document service does.
        const copy = fixtureAt(path.join(docs, 'Vendor', 'Device', 'rm0456', 'rm0456.pdf'));
        const web: DocRef = { id: 'web/vendor/1234', title: 'RM', scope: 'device', source: 'web', url: 'https://vendor.example/rm0456.pdf', path: copy, cached: true, indexed: false };
        await store.ensure(web, fake);
        assert.ok(fs.existsSync(path.join(path.dirname(copy), 'rm0456.meta.json')));

        // The copy of a project's document on this machine lies in the index root too.
        const projectCopy = fixtureAt(path.join(docs, 'projects', '0123456789abcdef', 'um.pdf'));
        const fetched: DocRef = { id: 'web/vendor/5678', title: 'UM', scope: 'project', source: 'web', url: 'https://vendor.example/um.pdf', path: projectCopy, cached: true, indexed: false,
            service: { parent: { all: true }, name: 'https://vendor.example/um.pdf', scope: 'project', copy: projectCopy, view: 'v' } };
        await store.ensure(fetched, fake);
        assert.ok(fs.existsSync(path.join(path.dirname(projectCopy), 'um.meta.json')));

        // A file of the project itself, listed by the project or dropped into its docs folder.
        const own = fixtureAt(path.join(dir, 'project', 'docs', 'notes.pdf'));
        const listed: DocRef = { id: 'project/x/notes', title: 'Notes', scope: 'project', source: 'workspace', path: own, cached: false, indexed: false,
            service: { parent: { all: true }, name: 'docs/notes.pdf', scope: 'project', copy: own, view: 'v' } };
        await store.ensure(listed, fake);
        const home = store.paths(listed).dir;
        assert.match(path.relative(docs, home).split(path.sep).join('/'), /^projects\/[0-9a-f]{12}\/notes$/);
        assert.ok(fs.existsSync(path.join(home, 'notes.meta.json')));
        assert.deepStrictEqual(fs.readdirSync(path.dirname(own)), ['notes.pdf'], 'nothing written into the project');
        assert.ok(!fs.existsSync(path.join(dir, 'store')), 'nothing in the storage directory');
        assert.strictEqual(store.listCached().length, 3);
    });

    test('clearing the index root removes the sidecars and a folder they leave empty, and nothing else', async () => {
        const dir = tmp();
        const docs = path.join(dir, 'cmsis', 'docs');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        const fake = new FakeExtractor(['1 Intro\nHello']);
        const file = fixtureAt(path.join(dir, 'packs', 'Test_RM.pdf'));
        await store.ensure(bookOf(file), fake);
        const copy = fixtureAt(path.join(docs, 'Vendor', 'Device', 'rm0456', 'rm0456.pdf'));
        await store.ensure({ id: 'web/vendor/1234', title: 'RM', scope: 'device', source: 'web', url: 'https://vendor.example/rm0456.pdf', path: copy, cached: true, indexed: false }, fake);
        // What is not the store's: a folder CMSIS Solution has just made, and a file beside a sidecar.
        const pending = path.join(docs, 'Vendor', 'Device', 'pending');
        fs.mkdirSync(pending);
        const note = path.join(docs, 'Vendor', 'Device', 'Test_RM', 'note.txt');

        assert.deepStrictEqual([store.clearExtracted().documents, fs.existsSync(path.join(docs, 'Vendor', 'Device', 'Test_RM'))], [2, false], 'the folder the index left empty goes');
        assert.ok(fs.existsSync(copy) && fs.existsSync(pending), 'the copy and the empty folder of another stay');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(copy)), ['rm0456.pdf']);

        await store.ensure(bookOf(file), fake);
        fs.writeFileSync(note, 'kept');
        assert.strictEqual(store.clearExtracted().documents, 1);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(note)), ['note.txt'], 'a folder that holds something else stays');
        assert.deepStrictEqual(store.clearDownloads(), { documents: 0, files: 0, bytes: 0 }, 'the downloads of the retired path are the storage directory\'s only');
        assert.ok(fs.existsSync(copy));
    });

    test('an index root that cannot be written leaves the index in the storage directory, where it stays in use', async () => {
        const dir = tmp();
        const docs = path.join(dir, 'cmsis', 'docs');
        const file = fixtureAt(path.join(dir, 'packs', 'Test_RM.pdf'));
        const fake = new FakeExtractor(['1 Intro\nHello']);
        const legacy = path.join(dir, 'store', 'v', 'p', '1.0.0');

        // A file where the hardware's folder would be: nothing can be made below it.
        fs.mkdirSync(path.join(docs, 'Vendor'), { recursive: true });
        fs.writeFileSync(path.join(docs, 'Vendor', 'Device'), 'not a folder');
        const store = new PageStore(path.join(dir, 'store'), silentLog, docs);
        assert.strictEqual(store.paths(bookOf(file)).dir, legacy);
        await store.ensure(bookOf(file), fake);
        assert.ok(fs.existsSync(path.join(legacy, 'test-rm.meta.json')));

        // The folder is there, but a sidecar's name is taken by a folder: found only when writing.
        const other = fixtureAt(path.join(dir, 'packs', 'Other_RM.pdf'));
        const blocked = path.join(docs, 'Vendor', 'Board', 'Other_RM');
        fs.mkdirSync(path.join(blocked, 'Other_RM.pages.jsonl'), { recursive: true });
        const onBoard: DocRef = { ...docFor(other), scope: 'board', listedFor: { board: 'Vendor::Board:Rev.A' } };
        assert.strictEqual(store.paths(onBoard).dir, blocked);
        await store.ensure(onBoard, fake);
        assert.strictEqual(store.paths(onBoard).dir, legacy, 'the storage directory took it');
        await new PageStore(path.join(dir, 'store'), silentLog, docs).ensure(onBoard, fake);
        assert.strictEqual(fake.calls, 2, 'and it is found there: not extracted again');
    });

    test('concurrent ensure calls share one extraction', async () => {
        const dir = tmp();
        const file = path.join(dir, 'test-rm.pdf');
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
        const store = new PageStore(path.join(dir, 'store'));
        const fake = new FakeExtractor(['only page']);
        const doc = docFor(file);
        const [a, b] = await Promise.all([store.ensure(doc, fake), store.ensure(doc, fake)]);
        assert.strictEqual(fake.calls, 1);
        assert.strictEqual(a.meta.sha256, b.meta.sha256);
    });

    test('splitPages drops the trailing empty segment only', () => {
        assert.deepStrictEqual(splitPages('a\fb\f'), ['a', 'b']);
        assert.deepStrictEqual(splitPages('a\f\fb\f'), ['a', '', 'b']);
        assert.deepStrictEqual(splitPages('single'), ['single']);
    });

    test('pdftotext extracts the fixture PDF page by page (skipped when poppler is absent)', async function () {
        const extractor = new PdftotextExtractor();
        const avail = await extractor.available();
        if (!avail.ok) { this.skip(); return; }
        const result = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
        assert.strictEqual(result.pages.length, 2);
        assert.match(result.pages[0], /RCC_AHB1ENR/);
        assert.match(result.pages[0], /GPIOAEN: IO port A clock enable/);
        assert.match(result.pages[1], /0x4002_3800/);
    });

    test('a missing executable is reported, not thrown', async () => {
        const extractor = new PdftotextExtractor('/definitely/not/here/pdftotext');
        const avail = await extractor.available();
        assert.strictEqual(avail.ok, false);
        assert.match(avail.detail, /pdftotext/);
    });

    test('pdf.js extracts the fixture PDF page by page with nothing installed', async () => {
        const extractor = new PdfjsExtractor();
        const avail = await extractor.available();
        assert.ok(avail.ok, avail.detail);
        assert.match(avail.detail, /pdf\.js \d/);
        const result = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
        assert.strictEqual(result.extractor, 'pdfjs');
        assert.strictEqual(result.pages.length, 2);
        assert.match(result.pages[0], /RCC_AHB1ENR/);
        assert.match(result.pages[0], /GPIOAEN: IO port A clock enable/);
        assert.match(result.pages[1], /0x4002_3800/);
        assert.match(result.pages[0].split('\n')[0], /^TEST-RM Reference manual/, 'the running header is the first line, as with pdftotext');
        await assert.rejects(() => extractor.extract(path.join(FIXTURES, 'test-rm.pdf'), { timeoutMs: -1 }), /timed out/);
        // The timeout terminated the worker thread; the next request starts a fresh one.
        const again = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
        assert.strictEqual(again.pages.length, 2);
        extractor.dispose();
    });

    const SLOW = path.join(FIXTURES, 'slowPdfWorker.js');
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    test('pdf.js: a positive timeout mid-extraction rejects, terminates the thread, and the next request gets a fresh one', async () => {
        const x = new PdfjsExtractor(60_000, SLOW);
        try {
            const warm = (await x.extract('warm.pdf')).pages[0];
            assert.ok(x.isRunning());
            const t0 = Date.now();
            await assert.rejects(() => x.extract('hang.pdf', { timeoutMs: 100 }), /timed out after 100 ms/);
            assert.ok(Date.now() - t0 < 1_000);
            assert.ok(!x.isRunning(), 'the thread is gone after the timeout');
            const a = (await x.extract('a.pdf')).pages[0];
            const b = (await x.extract('b.pdf')).pages[0];
            assert.notStrictEqual(a, warm, 'a fresh thread after the timeout');
            assert.strictEqual(a, b, 'the fresh thread is reused for the next document');
        } finally { x.dispose(); }
    });

    test('pdf.js: a timeout fails the other pending request with "terminated"', async () => {
        const x = new PdfjsExtractor(60_000, SLOW);
        try {
            const short = assert.rejects(() => x.extract('hang.pdf', { timeoutMs: 100 }), /timed out/);
            const long = assert.rejects(() => x.extract('hang.pdf', { timeoutMs: 10_000 }), /worker terminated/);
            await Promise.all([short, long]);
        } finally { x.dispose(); }
    });

    test('pdf.js: an idle thread is retired and restarted on demand', async () => {
        const x = new PdfjsExtractor(50, SLOW);
        try {
            const first = (await x.extract('a.pdf')).pages[0];
            await sleep(300);
            assert.ok(!x.isRunning(), 'retired after idleMs');
            const second = (await x.extract('a.pdf')).pages[0];
            assert.notStrictEqual(first, second, 'a new thread after retirement');
        } finally { x.dispose(); }
    });

    test('pdf.js: dispose while a request is pending rejects it, and the extractor stays usable', async () => {
        const x = new PdfjsExtractor(60_000, SLOW);
        const pending = assert.rejects(() => x.extract('hang.pdf', { timeoutMs: 10_000 }), /disposed/);
        await sleep(20);
        const t0 = Date.now();
        x.dispose();
        await pending;
        assert.ok(Date.now() - t0 < 200);
        assert.ok(!x.isRunning());
        assert.strictEqual((await x.extract('ok.pdf')).pages.length, 1);
        x.dispose();
    });

    test('pdf.js extracts when another extension has patched Array.prototype in the host', async () => {
        // The CMSIS csolution extension assigns `Array.prototype.groupedBy` in
        // the shared extension host; pdf.js refuses to start on a prototype
        // with an enumerable property ("The `Array.prototype` contains
        // unexpected enumerable property") — on the host's thread, that is.
        const proto = Array.prototype as unknown as Record<string, unknown>;
        proto.groupedBy = function () { return new Map(); };
        const extractor = new PdfjsExtractor();
        try {
            const seen: string[] = [];
            for (const key in []) { seen.push(key); }
            assert.deepStrictEqual(seen, ['groupedBy'], 'the patch is enumerable, as in the csolution extension');
            const result = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
            assert.strictEqual(result.pages.length, 2);
            assert.match(result.pages[0], /RCC_AHB1ENR/);
        } finally {
            delete proto.groupedBy;
            extractor.dispose();
        }
    });

    test('pdf.js reports a missing file from the worker and stays usable', async () => {
        const extractor = new PdfjsExtractor();
        try {
            await assert.rejects(() => extractor.extract(path.join(FIXTURES, 'not-here.pdf')), /pdf\.js: .*ENOENT/);
            const result = await extractor.extract(path.join(FIXTURES, 'test-rm.pdf'));
            assert.strictEqual(result.pages.length, 2);
        } finally {
            extractor.dispose();
        }
    });

    test('itemsToPageText rebuilds lines by baseline and keeps table columns apart', () => {
        const text = itemsToPageText([
            { str: 'Bit 0', transform: [1, 0, 0, 1, 40, 700], width: 20, height: 10 },
            { str: 'GPIOAEN', transform: [1, 0, 0, 1, 120, 700], width: 40, height: 10 },
            { str: 'IO port A clock enable', transform: [1, 0, 0, 1, 162, 700.5], width: 100, height: 10 },
            { str: 'Address offset: 0x30', transform: [1, 0, 0, 1, 40, 720], width: 90, height: 10 },
            { str: '', transform: [1, 0, 0, 1, 0, 0] },
        ]);
        assert.strictEqual(text, 'Address offset: 0x30\nBit 0  GPIOAEN IO port A clock enable\n');
    });

    test('selectExtractor: pdf.js unless pdftotext is asked for', () => {
        assert.strictEqual(selectExtractor(defaultSettings).name, 'pdfjs');
        assert.strictEqual(selectExtractor({ ...defaultSettings, extractor: 'pdfjs' }).name, 'pdfjs');
        assert.strictEqual(selectExtractor({ ...defaultSettings, extractor: 'pdftotext' }).name, 'pdftotext');
    });
});
