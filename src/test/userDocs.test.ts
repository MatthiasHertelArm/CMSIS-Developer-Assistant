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
import { countLegacyUserDocs, legacyUserDocsNotice, resolveUserDocsDir } from '../core/packDocs/userDocs';
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
    test('the folder is only counted: its PDFs up to three folders deep, hidden folders skipped; and the notice that it is no longer used', () => {
        const root = legacyTree();
        const expected = process.platform !== 'win32' ? 6 : 5;
        assert.strictEqual(countLegacyUserDocs(root), expected, 'docs.json and the hidden folder do not count');
        assert.strictEqual(countLegacyUserDocs(path.join(root, 'missing')), 0);
        assert.strictEqual(legacyUserDocsNotice(root, expected),
            `The user documents folder ${root} (${expected} PDFs) is no longer used: the documentation tools do not read it. `
            + 'Add the documents you still need to a target with Add Document in the Target Documents view or Import Document for Current Target, '
            + 'then delete the folder.');
        assert.match(legacyUserDocsNotice('/u', 1) ?? '', /^The user documents folder \/u \(1 PDF\) is no longer used/);
        assert.strictEqual(legacyUserDocsNotice(root, 0), undefined, 'an empty or missing folder needs no word');
        assert.strictEqual(resolveUserDocsDir(''), path.join(os.homedir(), '.cmsis-pack-docs', 'user'));
        assert.strictEqual(resolveUserDocsDir('~/docs', '/home/me'), path.resolve('/home/me/docs'));
    });

    test('the move: old downloads imported with their edition and deleted, once; the user documents folder is neither read nor copied', async () => {
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
        assert.strictEqual(report.userDocuments, undefined, 'nothing of the folder is moved');
        assert.deepStrictEqual(report.left, []);
        assert.ok(!fs.existsSync(p.download) && !fs.existsSync(p.fetchRecord), 'the old download is gone');
        assert.deepStrictEqual(snapshot(root), before, 'the folder is unchanged');
        assert.match(listed, /arm\/ddi0553-latest · arch · Armv8-M Architecture Reference Manual · fetched B\.z, not indexed yet/);
        assert.ok(!listed.includes('Documents added by the user'), listed);
        for (const name of ['nda-manual', 'NDA manual', 'user/nucleo-f756zg', 'trm-notes', 'vendor-wide', 'everyone', 'errata-prelim']) {
            assert.ok(!listed.includes(name), `${name}: no document of the folder is listed`);
        }

        // Once: a new handler (a new window) does not move again, and a document added to the folder later stays out.
        touch(path.join(root, 'later.pdf'));
        const again = new PackDocsHandler(host, { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        assert.ok(!textOf(await again.handleListTargetDocs({})).includes('later'));
        assert.strictEqual(migrationDone(world.host.storageDir)?.downloads, 1);
    });
});
