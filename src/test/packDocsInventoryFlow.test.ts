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

// CMSIS Solution's document inventory through the documentation tools (2.9.2 stages 1–3): the
// listing and fetch_doc of a target whose inventory file the test writes (never the real
// ~/.cmsis/docs.yml); the agent's request written into the inventory's error (stage 2, behind its
// setting), with every other byte kept; and the proposed document API (stage 3), scripted, since
// no CMSIS Solution ships it.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { defaultSettings, PackDocsHost } from '../core/packDocs/host';
import { requestErrorText, setInventoryError, withInventoryError } from '../core/packDocs/inventoryWriter';
import { textOf } from '../core/toolResult';
import { PackDocsHandler } from '../packDocsHandler';
import { buildWorld, FakeExtractor, serviceWith, World } from './packDocsHandler.test';

const RM = 'https://www.st.com/resource/en/reference_manual/rm0385-stm32f75xxx-and-stm32f74xxx-advanced-armbased-32bit-mcus-stmicroelectronics.pdf';
const SHEET = 'https://www.st.com/resource/en/datasheet/stm32f756bg.pdf';
const DEVICE = 'STMicroelectronics::STM32F756ZGTx';

/** An inventory as CMSIS Solution 1.72.1 writes it, with a quoted title, a user document, the Arm commons and a second device. */
function inventoryText(userCopy: string, armCopy: string): string {
    return [
        'docs:',
        '  commons:',
        '    - common: arm-docs',
        '      docs:',
        '        - name: https://developer.arm.com/documentation/dui0646/latest',
        '          title: Cortex-M7 Devices Generic User Guide',
        `          path: ${armCopy}`,
        '  devices:',
        `    - device: ${DEVICE}`,
        '      pack: Keil::STM32F7xx_DFP@3.0.0',
        '      docs:',
        `        - name: ${RM}`,
        '          title: "STM32F74xx/5xx Reference Manual: Rev 9"',
        `        - name: ${SHEET}`,
        '          title: STM32F756 Data Sheet',
        '        - name: /Users/me/Downloads/sensor.pdf',
        '          title: sensor.pdf',
        '          mode: user',
        `          path: ${userCopy}`,
        '    - device: STMicroelectronics::STM32H723ZGTx',
        '      docs:',
        `        - name: ${SHEET}`,
        '          title: Same URL, other device',
        '',
    ].join('\n');
}

suite('CMSIS Solution document inventory through the documentation tools (2.9.2)', () => {
    let world: World;
    let inventoryFile: string;
    let userCopy: string;
    let armCopy: string;
    let original: string;

    function host(extra: Partial<PackDocsHost> = {}, requests = false): PackDocsHost {
        return {
            ...world.host,
            inventoryFile,
            settings: () => ({ ...defaultSettings, userDocsDir: path.join(world.root, 'user'), inventoryRequests: requests }),
            // A swapped fetch function reaches the document service's downloads too.
            ...(extra.fetchFn ? serviceWith(world, extra.fetchFn) : {}),
            ...extra,
        };
    }

    setup(() => {
        world = buildWorld();
        const home = path.join(world.root, 'home', '.cmsis');
        userCopy = path.join(home, 'docs', 'STMicroelectronics', 'STM32F756ZGTx', 'sensor', 'sensor.pdf');
        armCopy = path.join(home, 'docs', 'dui0646-latest', 'dui0646-latest.pdf');
        const pdf = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'packdocs', 'test-rm.pdf'));
        for (const file of [userCopy, armCopy]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, pdf);
        }
        inventoryFile = path.join(home, 'docs.yml');
        original = inventoryText(userCopy, armCopy);
        fs.writeFileSync(inventoryFile, original);
    });

    teardown(() => {
        fs.rmSync(world.root, { recursive: true, force: true });
    });

    test('list_target_docs: the user\'s document of the CMSIS view is listed and searchable; the Arm copy is CMSIS Solution\'s', async () => {
        const handler = new PackDocsHandler(host(), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Sensor\nWHO_AM_I register']) });
        const listed = textOf(await handler.handleListTargetDocs({}));
        assert.match(listed, /user\/stm32f756zgtx\/sensor · user · sensor\.pdf · 1 kB \(added in the CMSIS view\), not indexed yet/);
        assert.match(listed, /arm\/dui0646-latest · family · Cortex-M7 Generic User Guide · fetched \(CMSIS Solution's copy\), not indexed yet/);
        const found = textOf(await handler.handleSearchTargetDocs({ query: 'WHO_AM_I', doc: 'user/stm32f756zgtx/sensor' }));
        assert.match(found, /#1 user\/stm32f756zgtx\/sensor p\.1/);
        assert.strictEqual(fs.readFileSync(inventoryFile, 'utf-8'), original, 'reading never writes');
    });

    test('fetch_doc of a document CMSIS Solution downloaded indexes its copy and downloads nothing', async () => {
        const handler = new PackDocsHandler(host(), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['1 Debug\nDHCSR', '2 Reset']) });
        const calls = world.fetchCalls.length;
        const fetched = textOf(await handler.handleFetchDoc({ doc: 'arm/dui0646-latest' }));
        assert.match(fetched, /^Downloaded by CMSIS Solution \(.*dui0646-latest\.pdf\): arm\/dui0646-latest — .*; indexed 2 p, nothing downloaded again\./);
        assert.strictEqual(world.fetchCalls.length, calls, 'no request went out');
    });

    test('stage 2: with the setting on, a login wall is written into that one entry\'s error, every other byte kept; a later success clears it', async () => {
        let wall = true;
        const fetchFn = async (url: string): Promise<Response> => (url !== SHEET ? world.host.fetchFn!(url) : wall
            ? new Response('<html>Sign in</html>', { status: 403, headers: { 'content-type': 'text/html' } })
            : new Response(fs.readFileSync(userCopy), { status: 200, headers: { 'content-type': 'application/pdf' } }));
        const off = new PackDocsHandler(host({ fetchFn }), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        await off.handleListTargetDocs({});
        const sheetId = (await off.inspectTarget({})).docs.find((doc) => doc.url === SHEET)!.id;
        assert.match(textOf(await off.handleFetchDoc({ doc: sheetId })), /The request is recorded in the Target Documents view/);
        assert.strictEqual(fs.readFileSync(inventoryFile, 'utf-8'), original, 'off by default: nothing written');

        const on = new PackDocsHandler(host({ fetchFn }, true), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        await on.handleListTargetDocs({});
        await on.handleFetchDoc({ doc: sheetId });
        const written = fs.readFileSync(inventoryFile, 'utf-8');
        const expected = requestErrorText('HTTP 403 text/html', SHEET);
        assert.match(expected, /^Requested by the agent: login or manual download needed at www\.st\.com/);
        const lines = written.split('\n');
        const at = lines.indexOf(`          error: ${JSON.stringify(expected)}`);
        assert.ok(at > 0, written);
        assert.strictEqual(lines[at - 1], '          title: STM32F756 Data Sheet', 'under the data sheet of this device, not the other one');
        assert.strictEqual([...lines.slice(0, at), ...lines.slice(at + 1)].join('\n'), original, 'every other byte kept');

        wall = false;
        await on.handleFetchDoc({ doc: sheetId, refresh: true });
        assert.strictEqual(fs.readFileSync(inventoryFile, 'utf-8'), original, 'its own error cleared after the download succeeded');
    });

    test('stage 2 after a reload: a new handler clears an error with this extension\'s mark, lists it as a request, and leaves CMSIS Solution\'s own', async () => {
        const parent = { tag: 'device' as const, key: DEVICE };
        const mark = requestErrorText('HTTP 403', SHEET);
        assert.ok(setInventoryError(inventoryFile, parent, SHEET, mark).written);
        assert.ok(setInventoryError(inventoryFile, parent, RM, 'Download failed').written);
        const fetchFn = async (url: string): Promise<Response> => new Response(fs.readFileSync(userCopy), { status: 200, headers: { 'content-type': 'application/pdf' } });
        const fresh = new PackDocsHandler(host({ fetchFn }, true), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const listed = textOf(await fresh.handleListTargetDocs({}));
        assert.match(listed, /STM32F756 Data Sheet · web — requested in the CMSIS view \(login or manual download needed at www\.st\.com;/);
        assert.match(listed, /STM32F74xx\/5xx Reference Manual · web — download failed in the CMSIS view \(Download failed\)/);
        const docs = (await fresh.inspectTarget({})).docs;
        await fresh.handleFetchDoc({ doc: docs.find((doc) => doc.url === SHEET)!.id });
        await fresh.handleFetchDoc({ doc: docs.find((doc) => doc.url === RM)!.id });
        const after = fs.readFileSync(inventoryFile, 'utf-8');
        assert.ok(!after.includes(mark), 'its own mark cleared after the download succeeded');
        assert.ok(after.includes('error: "Download failed"'), 'CMSIS Solution\'s error left alone');
    });

    test('the inventory is selected by the names CMSIS Solution\'s API gives the active target, the cbuild-run\'s otherwise', async () => {
        const run = (await world.host.findCbuildRunFiles())[0];
        fs.writeFileSync(inventoryFile, original.replace(`- device: ${DEVICE}`, '- device: STMicroelectronics::STM32F756ZG'));
        const plain = new PackDocsHandler(host(), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        assert.ok(!textOf(await plain.handleListTargetDocs({})).includes('(added in the CMSIS view)'), 'STM32F756ZGTx is not the inventory\'s key');
        const named = new PackDocsHandler(host({ activeCbuildRunFile: async () => run, solutionHardware: async () => ({ device: 'STMicroelectronics::STM32F756ZG' }) }),
            { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        assert.match(textOf(await named.handleListTargetDocs({})), /user\/stm32f756zg\/sensor · user · sensor\.pdf · 1 kB \(added in the CMSIS view\)/);
    });

    test('the states of goal 3: CMSIS Solution\'s copy removed; this window\'s fetch behind a login; a plain failure', async () => {
        fs.rmSync(armCopy);
        const fetchFn = async (url: string): Promise<Response> => (url === SHEET
            ? new Response('<html>Sign in</html>', { status: 403, headers: { 'content-type': 'text/html' } })
            : new Response('', { status: 500 }));
        const handler = new PackDocsHandler(host({ fetchFn }), { timeoutMs: 30_000, workspaceRoot: () => world.workspace, extractor: new FakeExtractor(['x']) });
        const before = textOf(await handler.handleListTargetDocs({}));
        assert.match(before, /arm\/dui0646-latest · family · Cortex-M7 Generic User Guide · web — CMSIS Solution's copy is gone \(Remove Document in the CMSIS view\)/);
        const docs = (await handler.inspectTarget({})).docs;
        await handler.handleFetchDoc({ doc: docs.find((doc) => doc.url === SHEET)!.id });
        await handler.handleFetchDoc({ doc: docs.find((doc) => doc.url === RM)!.id });
        const after = textOf(await handler.handleListTargetDocs({}));
        assert.match(after, /STM32F756 Data Sheet · web — requested, needs the user: login or manual download at www\.st\.com; they open it from the Target Documents view/);
        assert.match(after, /STM32F74xx\/5xx Reference Manual · web — requested in the Target Documents view \(http: .*\); Download there or fetch_doc \{ doc: '.*' \} tries again/);
    });

    test('the edit itself: a quoted title is found by value; a missing entry or a multi-line error is refused; onlyIf guards the clearing', () => {
        const parent = { tag: 'device' as const, key: DEVICE };
        const set = withInventoryError(original, parent, RM, 'needs the user');
        assert.ok('text' in set);
        assert.deepStrictEqual((load(set.text) as { docs: { devices: { docs: { error?: string }[] }[] } }).docs.devices[0].docs[0].error, 'needs the user');
        assert.deepStrictEqual(withInventoryError(original, parent, 'https://nowhere/x.pdf', 'x'), { reason: `no document https://nowhere/x.pdf under ${DEVICE}` });
        assert.deepStrictEqual(withInventoryError(original, { tag: 'board', key: 'X::Y' }, RM, 'x'), { reason: 'no board X::Y in the inventory' });
        const multi = original.replace('          title: STM32F756 Data Sheet', '          title: STM32F756 Data Sheet\n          error: |\n            two\n            lines');
        assert.deepStrictEqual(withInventoryError(multi, parent, SHEET, 'x'), { reason: 'the entry\'s error field is not a one-line scalar' });
        assert.ok(setInventoryError(inventoryFile, parent, RM, 'mine').written);
        assert.deepStrictEqual(setInventoryError(inventoryFile, parent, RM, undefined, 'not mine'), { written: false, reason: 'the error is no longer the one written' });
        assert.ok(setInventoryError(inventoryFile, parent, RM, undefined, 'mine').written);
        assert.strictEqual(fs.readFileSync(inventoryFile, 'utf-8'), original);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(inventoryFile)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left');
    });
});
