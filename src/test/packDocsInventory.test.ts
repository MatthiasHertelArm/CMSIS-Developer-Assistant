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

// CMSIS Solution's document inventory (~/.cmsis/docs.yml) as a source of the documentation tools
// (2.9.2, stage 1): the file as CMSIS Solution 1.72.1 writes it, selected by device and board,
// mapped to this extension's ids, merged with the pdsc walk and the Arm catalogue, its local
// copies read instead of a download, and its states in the listing and in fetch_doc's replies.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inventoryDocsFor, mergeInventory, parseInventory, readInventory } from '../core/packDocs/inventory';
import { PageStore } from '../core/packDocs/pageStore';
import { armDocRef, DocRef } from '../core/packDocs/pdscBooks';
import { docState, renderFetchFailure } from '../core/packDocs/render';
import { lookupArmDoc } from '../core/packDocs/armDocs';

const MINIMAL_PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

suite('CMSIS Solution document inventory (2.9.2 stage 1)', () => {
    let tmp: string;
    let packRoot: string;
    let docsYml: string;
    let userCopy: string;
    let armCopy: string;
    let packBook: string;

    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-inventory-'));
        packRoot = path.join(tmp, 'packs');
        packBook = path.join(packRoot, 'ARM', 'SSE_320_BSP', '2.0.0', 'Documents', 'SSE_320_BSP_Pack_User_Guide.pdf');
        const staleBook = path.join(packRoot, 'ARM', 'SSE_320_BSP', '1.1.0', 'Documents', 'SSE_320_BSP_Pack_User_Guide.pdf');
        userCopy = path.join(tmp, '.cmsis', 'docs', 'Renesas', 'FPB-RA6E2', 'REN_DA14531', 'REN_DA14531.pdf');
        armCopy = path.join(tmp, '.cmsis', 'docs', 'ddi0553-latest', 'ddi0553-latest.pdf');
        for (const file of [packBook, staleBook, userCopy, armCopy]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, MINIMAL_PDF);
        }
        docsYml = path.join(tmp, '.cmsis', 'docs.yml');
        fs.writeFileSync(docsYml, [
            'docs:',
            '  commons:',
            '    - common: arm-docs',
            '      docs:',
            '        - name: https://developer.arm.com/documentation/ddi0553/latest',
            '          title: Armv8-M Architecture Reference Manual',
            '          category: arch',
            '          id: ddi0553',
            '          version: latest',
            `          path: ${armCopy}`,
            '  devices:',
            '    - device: ARM::SSE-320-FVP',
            '      pack: ARM::SSE_320_BSP@2.0.0',
            '      docs:',
            `        - name: ${packBook}`,
            '          title: Arm SSE-320 FVP BSP Pack User Guide',
            `          path: ${packBook}`,
            `        - name: ${staleBook}`,
            '          title: Arm SSE-320 FVP BSP Pack User Guide',
            `          path: ${staleBook}`,
            '    - device: STMicroelectronics::STM32H723ZGTx',
            '      pack: Keil::STM32H7xx_DFP@4.1.3',
            '      docs:',
            '        - name: https://www.st.com/resource/en/datasheet/stm32h723zg.pdf',
            '          title: STM32H723ZG Data Sheet',
            '          error: Download failed',
            '  boards:',
            '    - board: Renesas::FPB-RA6E2',
            '      pack: Renesas::FPB-RA6E2_BSP@0.1.0',
            '      docs:',
            '        - name: https://www.renesas.com/en/document/mat/fpb-ra6e2-v1-users-manual',
            '          title: FPB-RA6E2 v1 User\'s Manual',
            '          category: manual',
            '        - name: /Users/me/Downloads/REN_DA14531.pdf',
            '          title: REN_DA14531.pdf',
            '          mode: user',
            `          path: ${userCopy}`,
            '    - board: MicroBit::microbit-v2:V2.2',
            '      docs:',
            '        - name: https://tech.microbit.org/hardware/',
            '          title: Hardware',
        ].join('\n'));
    });

    teardown(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('the file as CMSIS Solution writes it: devices, boards and the Arm commons; a broken file is an error, none is absent', () => {
        const read = readInventory(docsYml);
        assert.ok('inventory' in read, JSON.stringify(read));
        assert.deepStrictEqual(read.inventory.devices.map((entry) => entry.key), ['ARM::SSE-320-FVP', 'STMicroelectronics::STM32H723ZGTx']);
        assert.deepStrictEqual(read.inventory.boards.map((entry) => entry.key), ['Renesas::FPB-RA6E2', 'MicroBit::microbit-v2:V2.2']);
        assert.strictEqual(read.inventory.armDocs[0].path, armCopy);
        assert.deepStrictEqual(readInventory(path.join(tmp, 'nothing.yml')), { absent: true });
        fs.writeFileSync(docsYml, 'docs:\n  devices: [\n');
        const broken = readInventory(docsYml);
        assert.ok('error' in broken && /is not valid YAML/.test(broken.error), JSON.stringify(broken));
        assert.deepStrictEqual(parseInventory('42', 'x').devices, [], 'anything but a map is an empty inventory');
    });

    test('selected by device (vendor optional, processor suffix ignored) and by board (revision when both have one)', () => {
        const inventory = parseInventory(fs.readFileSync(docsYml, 'utf-8'), docsYml);
        const h7 = inventoryDocsFor(inventory, { device: { name: 'STM32H723ZGTx', revision: 'cm7' } });
        assert.deepStrictEqual(h7.map((doc) => doc.title), ['STM32H723ZG Data Sheet']);
        assert.deepStrictEqual(inventoryDocsFor(inventory, { board: { vendor: 'MicroBit', name: 'microbit-v2', revision: 'V2.2' } }).length, 1);
        assert.deepStrictEqual(inventoryDocsFor(inventory, { board: { name: 'microbit-v2', revision: 'V1.5' } }).length, 1,
            'no entry with that revision: the board without it');
        assert.deepStrictEqual(inventoryDocsFor(inventory, { device: { vendor: 'NXP', name: 'STM32H723ZGTx' } }), [], 'another vendor is another device');
    });

    test('ids: a web book as fetch_doc names a URL, a user document under user/, its copy and its failure carried along', () => {
        const inventory = parseInventory(fs.readFileSync(docsYml, 'utf-8'), docsYml);
        const docs = inventoryDocsFor(inventory, { device: { name: 'STM32H723ZGTx' }, board: { vendor: 'Renesas', name: 'FPB-RA6E2' } });
        const sheet = docs.find((doc) => doc.title === 'STM32H723ZG Data Sheet');
        assert.ok(sheet);
        assert.match(sheet.id, /^web\/www-st-com\/[0-9a-f]{12}$/);
        assert.deepStrictEqual([sheet.source, sheet.scope, sheet.inventory], ['web', 'device', {
            name: 'https://www.st.com/resource/en/datasheet/stm32h723zg.pdf', parent: { tag: 'device', key: 'STMicroelectronics::STM32H723ZGTx' },
            error: 'Download failed',
        }]);
        const added = docs.find((doc) => doc.inventory?.user === true);
        assert.ok(added);
        assert.deepStrictEqual([added.id, added.source, added.scope, added.path], ['user/fpb-ra6e2/ren-da14531', 'user', 'user', userCopy]);
        assert.strictEqual(added.missing, undefined);
        const manual = docs.find((doc) => doc.category === 'manual');
        assert.strictEqual(manual?.scope, 'board');
    });

    test('merged: the same Arm document gains CMSIS Solution\'s copy, a pack book of another version is not added, new ones are', () => {
        const inventory = parseInventory(fs.readFileSync(docsYml, 'utf-8'), docsYml);
        const entry = lookupArmDoc('ddi0553');
        assert.ok(entry);
        const docs: DocRef[] = [
            armDocRef(entry),
            { id: 'sse-320-bsp/sse-320-bsp-pack-user-guide', title: 'User Guide', scope: 'device', source: 'pack', path: packBook, cached: false, indexed: false },
        ];
        const merged = mergeInventory(docs, inventory, { device: { vendor: 'ARM', name: 'SSE-320-FVP' }, board: { name: 'FPB-RA6E2' } }, packRoot);
        assert.deepStrictEqual(merged, { added: 2, enriched: 2 });
        assert.deepStrictEqual(docs[0].inventory, { name: 'https://developer.arm.com/documentation/ddi0553/latest', parent: { tag: 'common', key: 'arm-docs' }, copy: armCopy });
        assert.strictEqual(docs[1].inventory?.copy, packBook);
        assert.deepStrictEqual(docs.slice(2).map((doc) => doc.title), ['FPB-RA6E2 v1 User\'s Manual', 'REN_DA14531.pdf']);
    });

    test('a web document is read from CMSIS Solution\'s copy: cached without a download, and the listing says whose copy it is', () => {
        const store = new PageStore(path.join(tmp, 'store'));
        const entry = lookupArmDoc('ddi0553');
        assert.ok(entry);
        const doc = armDocRef(entry);
        doc.inventory = { copy: armCopy };
        store.annotate(doc);
        assert.deepStrictEqual([doc.cached, doc.path, doc.format], [true, armCopy, 'pdf']);
        assert.match(docState(doc), /\(CMSIS Solution's copy\), not indexed yet$/);
        const gone = armDocRef(entry);
        gone.inventory = { copy: path.join(tmp, 'removed.pdf') };
        store.annotate(gone);
        assert.strictEqual(gone.cached, false, 'a copy that is gone is no copy');
    });

    test('${CMSIS_PACK_ROOT} and file:// URLs are local paths, as CMSIS Solution expands them', () => {
        const yaml = [
            'docs:',
            '  devices:',
            '    - device: ARM::SSE-320-FVP',
            '      pack: ARM::SSE_320_BSP@2.0.0',
            '      docs:',
            '        - name: ${CMSIS_PACK_ROOT}/ARM/SSE_320_BSP/2.0.0/Documents/SSE_320_BSP_Pack_User_Guide.pdf',
            '          title: Guide',
            `        - name: ${new URL(`file://${userCopy}`).href}`,
            '          title: Local',
        ].join('\n');
        const inventory = parseInventory(yaml, 'x', packRoot);
        const docs = inventoryDocsFor(inventory, { device: { name: 'SSE-320-FVP' } });
        assert.deepStrictEqual(docs.map((doc) => [doc.path, doc.missing === true]), [[packBook, false], [userCopy, false]]);
        const merged: DocRef[] = [];
        mergeInventory(merged, inventory, { device: { name: 'SSE-320-FVP' } }, packRoot);
        assert.deepStrictEqual(merged.map((doc) => doc.path), [userCopy], 'the expanded pack file is a pack file: not added');
    });

    test('the states: a download that failed in the CMSIS view, a user document, one removed since; fetch_doc\'s failure names the view\'s actions', () => {
        const failed: DocRef = { id: 'web/www-st-com/abc', title: 'Data Sheet', scope: 'device', source: 'web', url: 'https://www.st.com/x.pdf',
            cached: false, indexed: false, inventory: { error: 'Download failed' } };
        assert.strictEqual(docState(failed), 'web — download failed in the CMSIS view (Download failed); fetch_doc { doc: \'web/www-st-com/abc\' } tries again, '
            + 'or the user downloads it and uses Import Document on it in the CMSIS view');
        const added: DocRef = { id: 'user/b/x', title: 'x', scope: 'user', source: 'user', path: userCopy, sizeBytes: 80, cached: false, indexed: false, inventory: { user: true } };
        assert.match(docState(added), /\(added in the CMSIS view\), not indexed yet$/);
        assert.strictEqual(docState({ ...added, missing: true }), 'file not found: removed or moved since it was added in the CMSIS view');
        const text = renderFetchFailure({ ...failed, inventory: { ...failed.inventory, parent: { tag: 'device', key: 'ST::X' } } },
            { ok: false, error: 'not a PDF (text/html)' }, 'docs');
        assert.ok(!renderFetchFailure({ ...failed, inventory: { parent: { tag: 'common', key: 'arm-docs' } } }, { ok: false, error: 'x' }, 'docs').includes('CMSIS view'),
            'an Arm catalogue document is not the target\'s list');
        assert.match(text, /The CMSIS view lists this document for the target: ask the user to use Download Document on it there/);
        assert.ok(!renderFetchFailure({ ...failed, inventory: undefined }, { ok: false, error: 'x' }, 'docs').includes('CMSIS view'));
    });
});
