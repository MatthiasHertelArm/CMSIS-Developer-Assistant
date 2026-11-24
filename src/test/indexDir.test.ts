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
 * `indexDirOf`: the folder of a document's index in CMSIS Solution's document
 * folder. The device and board cases are those of CMSIS Solution's own tests
 * of `IDocRef.indexDir` (`src/doc-manager/docs-yaml-file.test.ts`); the other
 * parents are checked against the folders the document service copies into.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { indexDirOf } from '../core/packDocs/indexDir';
import { DocRef } from '../core/packDocs/pdscBooks';
import type { DocParent } from '../docService/contract';
import { EmulatedDocumentService } from '../docService/emulator';

const ROOT = path.resolve('home', '.cmsis', 'docs');
const PACK_FILE = path.resolve('packs', 'Vendor', 'Pack', '1.0.0', 'Documents', 'reference.manual.pdf');

function book(over: Partial<DocRef> = {}): DocRef {
    return { id: 'pack/reference-manual', title: 'RM', scope: 'device', source: 'pack', pack: 'Vendor::Pack@1.0.0',
        packId: { vendor: 'Vendor', name: 'Pack', version: '1.0.0' }, path: PACK_FILE, cached: false, indexed: false, ...over };
}

suite('indexDir', () => {
    test('a book of a device or board: <Vendor>/<Name>/<file name without extension>, the revision left out', () => {
        const expected = path.join(ROOT, 'Vendor', 'Hardware', 'reference.manual');
        assert.strictEqual(indexDirOf(book({ listedFor: { device: 'Vendor::Hardware' } }), ROOT), expected);
        assert.strictEqual(indexDirOf(book({ scope: 'board', listedFor: { board: 'Vendor::Hardware:suffix' } }), ROOT), expected);
        // As CMSIS Solution's inventory lists it: its parent and its name decide, whatever the file is called here.
        const listed = book({ inventory: { name: '${CMSIS_PACK_ROOT}/Vendor/Pack/1.0.0/Documents/reference.manual.pdf', parent: { tag: 'board', key: 'Vendor::Hardware:suffix' } },
            listedFor: { device: 'Other::Device' } });
        assert.strictEqual(indexDirOf(listed, ROOT), expected);
    });

    test('empty parts of a hardware key are left out, as CMSIS Solution joins them', () => {
        for (const [key, folders] of [['Name', ['Name']], ['::Name', ['Name']], ['Vendor::', ['Vendor']], ['Vendor:::suffix', ['Vendor']], [':suffix', []]] as const) {
            assert.strictEqual(indexDirOf(book({ path: path.resolve('books', 'manual.pdf'), listedFor: { device: key } }), ROOT), path.join(ROOT, ...folders, 'manual'), key);
        }
    });

    test('a name no file system takes is rewritten, not rejected', () => {
        const doc = book({ path: path.resolve('books', 'manual..pdf'), listedFor: { board: 'CON::Board.' } });
        assert.strictEqual(indexDirOf(doc, ROOT), path.join(ROOT, '_', 'Board', 'manual'));
    });

    test('a pack\'s PDF that no device or board lists: packs/<Vendor>/<Pack>, without the version', () => {
        assert.strictEqual(indexDirOf(book({ scope: 'unlisted' }), ROOT), path.join(ROOT, 'packs', 'Vendor', 'Pack', 'reference.manual'));
        assert.strictEqual(indexDirOf(book({ scope: 'board' }), ROOT), path.join(ROOT, 'packs', 'Vendor', 'Pack', 'reference.manual'), 'a book of a target without that hardware');
    });

    test('a file of a project or a workspace folder: projects/<hash of its folder>', () => {
        const file = path.resolve('project', 'docs', 'notes.pdf');
        const dropIn: DocRef = { id: 'workspace/notes', title: 'Notes', scope: 'workspace', source: 'workspace', path: file, cached: false, indexed: false };
        const dir = indexDirOf(dropIn, ROOT)!;
        assert.match(path.relative(ROOT, dir).split(path.sep).join('/'), /^projects\/[0-9a-f]{12}\/notes$/);
        const listed: DocRef = { ...dropIn, id: 'project/x/notes', scope: 'project', service: { parent: { device: 'Vendor::Hardware' }, name: 'docs/notes.pdf', scope: 'project', copy: file, view: 'v' } };
        assert.strictEqual(indexDirOf(listed, ROOT), dir, 'the project\'s entry of the file names the same folder');
        assert.notStrictEqual(indexDirOf({ ...dropIn, path: path.resolve('other', 'docs', 'notes.pdf') }, ROOT), dir, 'another folder, another index');
    });

    test('a document without a file, a web document and one that belongs to nothing have no folder', () => {
        assert.strictEqual(indexDirOf(book({ path: undefined, listedFor: { device: 'Vendor::Hardware' } }), ROOT), undefined);
        assert.strictEqual(indexDirOf({ id: 'arm/ddi0553-latest', title: 'ARM', scope: 'arm', source: 'web', path: path.resolve('x', 'doc.pdf'), cached: true, indexed: false }, ROOT), undefined);
        assert.strictEqual(indexDirOf({ id: 'user/rm', title: 'RM', scope: 'user', source: 'user', path: path.resolve('x', 'rm.pdf'), cached: false, indexed: false }, ROOT), undefined);
    });

    test('the folder is the one the document service copies a document of the same parent and name into', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indexdir-test-'));
        const service = new EmulatedDocumentService({ root: path.join(root, 'cmsis'), engine: { download: async () => { throw new Error('no download in this test'); } } });
        try {
            const file = path.join(root, 'elsewhere', 'bmi270 datasheet.pdf');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '%PDF-1.4\n');
            const parents: DocParent[] = [{ device: 'Vendor::Device' }, { board: 'Vendor::Board:Rev.C' }, { pack: 'Vendor::Pack' }, { core: 'Cortex-M33' }, { vendor: 'Vendor' }, { all: true }];
            for (const parent of parents) {
                const added = await service.addDocument(parent, file, { title: 'BMI270' });
                assert.ok(added.path, JSON.stringify(parent));
                const elsewhere: DocRef = { id: 'user/x/bmi270', title: 'BMI270', scope: 'user', source: 'user', path: file, cached: false, indexed: false,
                    service: { parent, name: added.name, scope: 'user', view: 'v' } };
                assert.strictEqual(indexDirOf(elsewhere, service.copiesDir), path.dirname(added.path), JSON.stringify(parent));
            }
        } finally {
            service.dispose();
        }
    });
});
