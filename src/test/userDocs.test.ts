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

// The retired user documents folder (~/.cmsis-pack-docs/user): read once and moved into the document
// service with the attribution of its sub-folders, together with the downloads of the retired
// fetch_doc store; the folder is never changed, the old downloads are deleted after the move, the
// move runs once, and the moved documents keep their edition and index.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrationDone } from '../core/packDocs/legacyMigration';
import { PageStore } from '../core/packDocs/pageStore';
import { legacyParent, listLegacyUserDocs, resolveUserDocsDir } from '../core/packDocs/userDocs';
import { textOf } from '../core/toolResult';
import { PackDocsHandler } from '../packDocsHandler';
import { FakeExtractor, buildWorld } from './packDocsHandler.test';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs');

function touch(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), file);
}

/** A tree of the retired layout. */
function legacyTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packdocs-user-'));
    touch(path.join(root, 'everyone.pdf'));
    touch(path.join(root, 'Keil', 'STM32F7xx_DFP', 'nda-manual.pdf'));
    touch(path.join(root, 'Keil', 'vendor-wide.pdf'));
    touch(path.join(root, 'boards', 'NUCLEO-F756ZG', 'schematic.pdf'));
    touch(path.join(root, 'cores', 'Cortex-M7', 'trm-notes.pdf'));
    if (process.platform !== 'win32') {
        touch(path.join(root, 'devices', 'STM32F7*', 'errata-prelim.pdf'));
    }
    touch(path.join(root, '.hidden', 'ignored.pdf'));
    fs.writeFileSync(path.join(root, 'Keil', 'STM32F7xx_DFP', 'docs.json'), JSON.stringify({
        'nda-manual.pdf': { title: 'NDA manual', category: 'manual', revision: 'Rev 1' },
    }));
    return root;
}

/** Every file below `root` with its size and modification time, to show nothing changed. */
function snapshot(root: string): string[] {
    return (fs.readdirSync(root, { recursive: true }) as string[]).map((f) => {
        const st = fs.statSync(path.join(root, f));
        return `${f} ${st.isFile() ? st.size : 'dir'} ${st.mtimeMs}`;
    }).sort();
}

suite('the retired user documents folder and download store', () => {
    test('the folder\'s layout: every PDF with its sub-folders and docs.json metadata; hidden folders skipped; the attributions', () => {
        const root = legacyTree();
        const listed = listLegacyUserDocs(root).map((doc) => [doc.parts.join('/'), path.basename(doc.path), doc.title, doc.revision ?? ''].join(' | '));
        assert.deepStrictEqual(listed.filter((line) => !line.startsWith('devices')).sort(), [
            ' | everyone.pdf | everyone | ',
            'Keil | vendor-wide.pdf | vendor-wide | ',
            'Keil/STM32F7xx_DFP | nda-manual.pdf | NDA manual | Rev 1',
            'boards/NUCLEO-F756ZG | schematic.pdf | schematic | ',
            'cores/Cortex-M7 | trm-notes.pdf | trm-notes | ',
        ]);
        assert.deepStrictEqual(listLegacyUserDocs(path.join(root, 'missing')), []);
        assert.deepStrictEqual(legacyParent(['Keil', 'STM32F7xx_DFP']), { pack: 'Keil::STM32F7xx_DFP' });
        assert.deepStrictEqual(legacyParent(['devices', 'STM32F7*']), undefined);
        assert.strictEqual(resolveUserDocsDir(''), path.join(os.homedir(), '.cmsis-pack-docs', 'user'));
        assert.strictEqual(resolveUserDocsDir('~/docs', '/home/me'), path.resolve('/home/me/docs'));
    });

    test('the move: folder documents attributed, old downloads imported with their edition and deleted, the folder unchanged, once', async () => {
        const world = buildWorld();
        const root = legacyTree();
        const before = snapshot(root);
        // A download of the retired store: the Armv8-M ARM with its fetch record.
        const store = new PageStore(world.host.storageDir);
        const old = { id: 'arm/ddi0553-latest', title: 'Armv8-M Architecture Reference Manual', scope: 'arm', source: 'web', url: 'https://developer.arm.com/documentation/ddi0553/latest',
            arm: { docId: 'ddi0553', version: 'latest' }, cached: false, indexed: false } as const;
        const p = store.paths({ ...old });
        fs.mkdirSync(p.dir, { recursive: true });
        fs.copyFileSync(path.join(FIXTURES, 'test-rm.pdf'), p.download);
        fs.writeFileSync(p.fetchRecord, JSON.stringify({ version: 1, docId: old.id, sourceUrl: old.url, resolver: 'arm.com', kind: 'pdf', title: old.title,
            resolvedVersion: 'bz', versionLabel: 'B.z', downloadUrl: 'x', bytes: 1, sha256: 'x', fetchedAt: 'now', userAgent: 'test' }));

        const host = { ...world.host, settings: () => ({ ...world.host.settings(), userDocsDir: root }) };
        const handler = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace,
            extractor: new FakeExtractor(['1 Secret\nUSART_CR1 UE bit', '2 More']) });
        const listed = textOf(await handler.handleListTargetDocs({}));
        const report = migrationDone(world.host.storageDir);
        assert.ok(report, 'the marker is written');
        assert.strictEqual(report.downloads, 1);
        assert.strictEqual(report.userDocuments, 5);
        assert.strictEqual(report.left.length, process.platform !== 'win32' ? 1 : 0, 'the pattern folder is reported');
        assert.ok(!fs.existsSync(p.download) && !fs.existsSync(p.fetchRecord), 'the old download is gone');
        assert.deepStrictEqual(snapshot(root), before, 'the folder is unchanged');
        assert.match(listed, /arm\/ddi0553-latest · arch · Armv8-M Architecture Reference Manual · fetched B\.z, not indexed yet/);
        assert.match(listed, /Documents added by the user \(the document service\):/);
        assert.match(listed, /user\/stm32f7xx-dfp\/nda-manual · user \[manual\] · NDA manual · 1 kB \(added by the user\), not indexed yet/);
        assert.match(listed, /user\/nucleo-f756zg\/schematic · user · schematic/);
        assert.match(listed, /user\/cortex-m7\/trm-notes · user · trm-notes/);
        assert.ok(!listed.includes('errata-prelim'), 'a pattern folder is not moved, and the folder is no longer read');
        const search = textOf(await handler.handleSearchTargetDocs({ query: 'USART_CR1', doc: 'nda-manual' }));
        assert.match(search, /#1 user\/stm32f7xx-dfp\/nda-manual \[Rev 1\] p\.1 §1 Secret/);

        // Once: a new handler (a new window) does not move again, and a document added to the folder later stays out.
        touch(path.join(root, 'later.pdf'));
        const again = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        assert.ok(!textOf(await again.handleListTargetDocs({})).includes('later'));
        assert.strictEqual(migrationDone(world.host.storageDir)?.userDocuments, 5);
    });
});
