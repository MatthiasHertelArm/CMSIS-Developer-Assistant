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
 * The knowledge tools against a small index written here with `node:sqlite`,
 * in the layout `build_index.py` of the knowledge-base prototype produces:
 * the retrieval cases of its `tests/test_kb.py`, the handler's replies and
 * failures, and the dispatch.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { componentsOf } from '../core/knowledge/projectFacts';
import { appliesIn, contextEntities, isIncomplete, knownMessages, messageLines, ProjectFacts, searchKnowledge, sectionOf } from '../core/knowledge/search';
import { detailOf, graphAround, overviewOf, renderMarkdown, TYPE_ORDER, unitRows } from '../core/knowledge/browse';
import { discoverIndexes, installedPackIndexes, localRepositoryIndexes, workspaceIndexes } from '../core/knowledge/packIndexes';
import { interleaveByRank, KnowledgeIndex, KnowledgeSet } from '../core/knowledge/store';
import { isKnowledgeOp, isKnownOp, isPackDocsDocOp, isPackDocsOp, KNOWLEDGE_OPS } from '../core/opTable';
import { composeInstructions } from '../core/serverInstructions';
import { silentLog } from '../core/packDocs/host';
import { isToolReply, ToolError, textOf } from '../core/toolResult';
import { KnowledgeHandler } from '../knowledgeHandler';
import { externalUrl, graphDepth, knowledgePanelHtml } from '../knowledgePanel';
import { KNOWLEDGE_PANEL_SCRIPT } from '../knowledgePanelPage';
import { localPackDocsDispatch, PackDocsHandlers } from '../packDocsDispatch';

interface Unit {
    id: string;
    type: string;
    title: string;
    summary?: string;
    body: string;
    domain?: string;
    meta?: Record<string, unknown>;
    appliesTo?: string[];
    edges?: [relation: string, to: string][];
}

const CAUSE = '## Symptom\n\n`x`\n\n## Cause\n\nThe device pack is not installed.\n\n## Fix\n\nAdd the DFP to packs:.';
const NO_CAUSE = '## Symptom\n\n`x`\n\n## Cause\n\n_offen, im Review ergänzen_\n\n## Fix\n\n_offen, im Review ergänzen_';

const UNITS: Unit[] = [
    { id: 'fx-generic', type: 'pattern', title: 'Stack sizing pattern', summary: 'Size the stack from the call depth.', body: 'stack sizing fixture body generic' },
    {
        id: 'fx-m55', type: 'pattern', title: 'Stack sizing pattern for Cortex-M55', summary: 'Stack sizing with Helium.',
        body: 'stack sizing fixture body m55', appliesTo: ['core:Cortex-M55', 'toolchain:AC6'], edges: [['refines', 'fx-generic']],
    },
    {
        id: 'ts-csolution-board-mounted-device', type: 'troubleshooting', title: 'csolution: board mounted device not found', body: CAUSE,
        domain: 'error-catalog', appliesTo: ['tool:csolution'],
        meta: { tool: 'csolution', symptoms: ['board mounted device not found'], symptom_regex: "^board mounted device '?.+?'? not found$" },
    },
    {
        id: 'ts-csolution-processing-context', type: 'troubleshooting', title: "csolution: processing context '…' failed",
        body: '## Symptom\n\n`x`\n\n## Cause\n\nAn earlier error stopped the context.\n\n## Fix\n\nFix that error first.',
        domain: 'error-catalog', appliesTo: ['tool:csolution'],
        meta: { tool: 'csolution', symptoms: ["processing context '<…>' failed"], symptom_regex: "^processing context '.+?' failed$" },
    },
    {
        id: 'ts-csolution-no-board', type: 'troubleshooting', title: 'csolution: no installed board was found', body: NO_CAUSE,
        domain: 'error-catalog', appliesTo: ['tool:csolution'],
        meta: { tool: 'csolution', symptoms: ['no installed board was found'], symptom_regex: '^no installed board was found$' },
    },
    {
        id: 'ts-packchk-m302', type: 'troubleshooting', title: 'packchk M302: No vendor tag found', body: CAUSE, appliesTo: ['tool:packchk'],
        meta: { tool: 'packchk', code: 'M302', symptoms: ['M302', 'No vendor tag found in the PDSC file'], symptom_regex: '^No vendor tag found' },
    },
    {
        id: 'ts-svdconv-m302', type: 'troubleshooting', title: 'svdconv M302: Name not C conformant', body: CAUSE, appliesTo: ['tool:svdconv'],
        meta: { tool: 'svdconv', code: 'M302', symptoms: ['M302', 'Name not C conformant'], symptom_regex: '(unclosed' },
    },
    {
        id: 'proc-long', type: 'procedure', title: 'generate-debug-sequences', summary: 'Adds debug sequences to a PDSC.',
        body: `# Generate Debug Sequences\n\n${'Step text. '.repeat(600)}END`, domain: 'pack', edges: [['requires', 'fx-generic']],
        meta: { status: 'reviewed', stop_conditions: ['Stop when confirmation is absent.'] },
    },
    { id: 'rule-empty', type: 'rule', title: 'No installation', body: '_Kanonischer Text: wird von Hand geschrieben._' },
];

const ENTITIES: [id: string, type: string, title: string][] = [
    ['device:AE722F80F55D5LS', 'device', 'AE722F80F55D5LS'], ['core:Cortex-M55', 'core', 'Cortex-M55'], ['core:Cortex-M33', 'core', 'Cortex-M33'],
    ['device:STM32U585AIIx', 'device', 'STM32U585AIIx'], ['family:STMicroelectronics::STM32U5 Series', 'family', 'STM32U5 Series'],
    ['toolchain:AC6', 'toolchain', 'AC6'], ['toolchain:GCC', 'toolchain', 'GCC'], ['pack:Big::Pack', 'pack', 'Big::Pack'],
    ['component:ARM::CMSIS:CORE', 'component', 'CMSIS:CORE'],
    ['tool:csolution', 'tool', 'csolution'], ['tool:packchk', 'tool', 'packchk'], ['tool:svdconv', 'tool', 'svdconv'],
];

/** Write an index file the way the prototype's build does; `info` rows are optional. */
function writeIndex(file: string, info: Record<string, string> = {}): void {
    const db = new DatabaseSync(file);
    db.exec(`
        CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, type TEXT, domain TEXT, title TEXT, summary TEXT, body TEXT, meta JSON);
        CREATE TABLE edges(src TEXT, rel TEXT, dst TEXT, qual JSON, PRIMARY KEY(src, rel, dst));
        CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, summary, body, symptoms, triggers, tokenize='porter unicode61');
        CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT);
    `);
    const node = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)');
    const fts = db.prepare('INSERT INTO nodes_fts VALUES(?,?,?,?,?,?)');
    const edge = db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?,NULL)');
    for (const [id, type, title] of ENTITIES) {
        node.run(id, 'entity', type, null, title, null, null, '{}');
    }
    for (const unit of UNITS) {
        const meta: Record<string, unknown> = { status: 'draft', ...unit.meta };
        node.run(unit.id, 'knowledge', unit.type, unit.domain ?? null, unit.title, unit.summary ?? '', unit.body, JSON.stringify(meta));
        const symptoms = Array.isArray(meta.symptoms) ? (meta.symptoms as string[]).join(' ') : '';
        fts.run(unit.id, unit.title, unit.summary ?? '', unit.body, symptoms, '');
        for (const target of unit.appliesTo ?? []) {
            edge.run(unit.id, 'applies_to', target);
        }
        for (const [relation, to] of unit.edges ?? []) {
            edge.run(unit.id, relation, to);
        }
    }
    edge.run('device:AE722F80F55D5LS', 'has_core', 'core:Cortex-M55');
    edge.run('device:STM32U585AIIx', 'has_core', 'core:Cortex-M33');
    edge.run('device:STM32U585AIIx', 'part_of', 'family:STMicroelectronics::STM32U5 Series');
    for (let i = 0; i < 60; i++) {
        node.run(`device:BIG${i}`, 'entity', 'device', null, `BIG${i}`, null, null, '{}');
        edge.run(`device:BIG${i}`, 'part_of', 'pack:Big::Pack');
    }
    edge.run('proc-long', 'references', 'pack:Big::Pack');
    // A file the procedure ships: an entity with the content as body, outside the search index.
    node.run('asset-long-assets-template-yml', 'entity', 'asset', null, 'assets/template.yml', null, 'solution:\n  compiler: __COMPILER__\n',
        JSON.stringify({ of: 'proc-long', source: 'pack/long/assets/template.yml' }));
    edge.run('proc-long', 'references', 'asset-long-assets-template-yml');
    const infoRow = db.prepare('INSERT INTO info VALUES(?,?)');
    for (const [key, value] of Object.entries(info)) {
        infoRow.run(key, value);
    }
    db.close();
}

suite('knowledge tools', () => {
    let dir: string;
    let file: string;
    let index: KnowledgeIndex;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-knowledge-'));
        file = path.join(dir, 'knowledge.db');
        writeIndex(file);
        index = new KnowledgeIndex(file);
    });

    suiteTeardown(() => {
        index.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const ids = (query: string, facts?: ProjectFacts, options: { includeIncomplete?: boolean; k?: number; budgetTokens?: number } = {}): string[] =>
        searchKnowledge(index, query, { ...options, context: facts ? contextEntities(index, facts) : undefined }).results.map((hit) => hit.id);

    suite('search', () => {
        test('an exact error text stands first, also as tool output with a prefix and a second line', () => {
            const plain = searchKnowledge(index, "board mounted device 'XYZ123' not found").results[0];
            assert.strictEqual(plain.id, 'ts-csolution-board-mounted-device');
            assert.strictEqual(plain.exactSymptom, true);
            const output = 'error csolution: board mounted device STM32U585AIIx not found\nerror csolution: processing context \'app+U5\' failed';
            assert.deepStrictEqual(messageLines(output), ['board mounted device STM32U585AIIx not found', "processing context 'app+U5' failed"]);
            const fromOutput = searchKnowledge(index, output).results[0];
            assert.strictEqual(fromOutput.id, 'ts-csolution-board-mounted-device');
            assert.strictEqual(fromOutput.exactSymptom, true);
        });

        test('of two known messages in tool output, the first line leads: it is the cause, the later one follows from it', () => {
            const cause = 'error csolution: board mounted device STM32U585AIIx not found';
            const consequence = "error csolution: processing context 'app+U5' failed";
            const both = searchKnowledge(index, `${cause}\n${consequence}`).results;
            assert.deepStrictEqual(both.slice(0, 2).map((hit) => [hit.id, hit.exactSymptom]),
                [['ts-csolution-board-mounted-device', true], ['ts-csolution-processing-context', true]]);
            assert.strictEqual(searchKnowledge(index, `${consequence}\n${cause}`).results[0].id, 'ts-csolution-processing-context');
            assert.deepStrictEqual(index.exactSymptoms(messageLines(`${consequence}\n${cause}`)),
                ['ts-csolution-processing-context', 'ts-csolution-board-mounted-device']);
        });

        test('the function words of a question match nothing on their own', () => {
            assert.deepStrictEqual(ids('how do I do this with my'), []);
            assert.ok(['fx-generic', 'fx-m55'].includes(ids('how do I size the stack')[0]));
        });

        test('a message code that two tools share is resolved by the tool', () => {
            assert.deepStrictEqual(new Set(ids('M302').slice(0, 2)), new Set(['ts-packchk-m302', 'ts-svdconv-m302']));
            assert.deepStrictEqual(ids('M302', { tools: ['packchk'] }), ['ts-packchk-m302']);
        });

        test('a symptom pattern that is no JavaScript expression is skipped and counted', () => {
            assert.strictEqual(index.skippedSymptoms, 1);
        });

        test('without a context the specific unit replaces the general one it refines', () => {
            const found = ids('stack sizing pattern');
            assert.ok(found.includes('fx-m55') && !found.includes('fx-generic'), found.join());
        });

        test('the context filters: AND across dimensions, with the cores the index knows for a device', () => {
            const m55 = contextEntities(index, { device: 'Alif Semiconductor::AE722F80F55D5LS:M55_HE', compiler: 'AC6@>=6.20' });
            assert.ok(m55.has('core:Cortex-M55') && m55.has('toolchain:AC6'), [...m55].join());
            assert.strictEqual(ids('stack sizing pattern', { device: 'AE722F80F55D5LS:M55_HE', compiler: 'AC6' })[0], 'fx-m55');
            assert.deepStrictEqual(ids('stack sizing pattern', { device: 'STM32U585AIIx', compiler: 'GCC' }), ['fx-generic']);
            assert.deepStrictEqual(ids('stack sizing pattern', { device: 'STM32U585AIIx', compiler: 'AC6' }), ['fx-generic']);
        });

        test('cores from the pack on disk stand in for a device the index does not know', () => {
            assert.strictEqual(ids('stack sizing pattern', { device: 'MYNEWCHIP', cores: ['Cortex-M55'], compiler: 'AC6' })[0], 'fx-m55');
        });

        test('a dimension the context says nothing about leaves the unit in, unverified, next to the general one', () => {
            const result = searchKnowledge(index, 'stack sizing pattern', { context: contextEntities(index, { device: 'MYNEWCHIP', compiler: 'AC6' }) });
            const specific = result.results.find((hit) => hit.id === 'fx-m55');
            assert.strictEqual(specific?.applies, 'unverified');
            assert.ok(result.results.some((hit) => hit.id === 'fx-generic'));
            assert.deepStrictEqual(appliesIn(['core:Cortex-M55'], new Set(['toolchain:AC6'])), { applies: true, unverified: true });
            assert.deepStrictEqual(appliesIn(['core:Cortex-M55'], new Set(['core:Cortex-M33'])), { applies: false, unverified: false });
            assert.deepStrictEqual(appliesIn([], new Set(['core:Cortex-M33'])), { applies: true, unverified: false });
            // The tool is a matter of the question, not of the project: unnamed, it neither excludes nor marks.
            assert.deepStrictEqual(appliesIn(['tool:csolution'], new Set(['core:Cortex-M33'])), { applies: true, unverified: false });
            assert.deepStrictEqual(appliesIn(['tool:csolution'], new Set(['tool:packchk'])), { applies: false, unverified: false });
        });

        test('components resolve by their name without the vendor, boards and packs by their id', () => {
            const context = contextEntities(index, { components: ['CMSIS:CORE@6.1.0'], board: 'STMicroelectronics::B-U585I-IOT02A:Rev.C', packs: ['Keil::STM32U5xx_DFP'] });
            assert.ok(context.has('component:ARM::CMSIS:CORE'));
            assert.ok(context.has('board:STMicroelectronics::B-U585I-IOT02A') && context.has('pack:Keil::STM32U5xx_DFP'));
        });

        test('units without a cause or text are left out and counted, unless asked for', () => {
            const hidden = searchKnowledge(index, 'no installed board was found');
            assert.ok(!hidden.results.some((hit) => hit.id === 'ts-csolution-no-board'));
            assert.strictEqual(hidden.incompleteHidden, 2);
            assert.deepStrictEqual(hidden.incompleteExact, ['ts-csolution-no-board']);
            const shown = searchKnowledge(index, 'no installed board was found', { includeIncomplete: true }).results[0];
            assert.strictEqual(shown.id, 'ts-csolution-no-board');
            assert.strictEqual(shown.incomplete, true);
            assert.ok(!ids('No installation').includes('rule-empty'));
            assert.strictEqual(isIncomplete(index.node('rule-empty')!), true);
            assert.strictEqual(isIncomplete(index.node('ts-packchk-m302')!), false);
            assert.strictEqual(sectionOf(CAUSE, 'cause'), 'The device pack is not installed.');
        });

        test('the budget and k bound the answer; the first hit always fits', () => {
            const all = searchKnowledge(index, 'stack sizing pattern debug sequences M302 board', { includeIncomplete: true });
            assert.ok(all.results.length > 2);
            const tight = searchKnowledge(index, 'stack sizing pattern debug sequences M302 board', { budgetTokens: 1 });
            assert.strictEqual(tight.results.length, 1);
            assert.strictEqual(searchKnowledge(index, 'stack sizing pattern debug sequences M302 board', { k: 2 }).results.length, 2);
            assert.ok(all.budgetUsed <= 800);
        });

        test('types and domain narrow the answer; the status comes from the unit', () => {
            const procedures = searchKnowledge(index, 'debug sequences stack', { types: ['procedure'] }).results;
            assert.deepStrictEqual(procedures.map((hit) => [hit.id, hit.status]), [['proc-long', 'reviewed']]);
            assert.deepStrictEqual(searchKnowledge(index, 'board device', { domain: 'error-catalog' }).results.map((hit) => hit.id),
                ['ts-csolution-board-mounted-device']);
        });

        test('a failed build is pointed only to complete units', () => {
            assert.deepStrictEqual(knownMessages(index, ['board mounted device STM32U585AIIx not found', 'no installed board was found', 'something else']),
                [{ message: 'board mounted device STM32U585AIIx not found', id: 'ts-csolution-board-mounted-device' }]);
        });
    });

    suite('handler', () => {
        const facts: ProjectFacts = { device: 'STM32U585AIIx', cores: ['Cortex-M33'], compiler: 'GCC' };
        const handlerFor = (settings: { indexPath?: string; includeIncomplete?: boolean; facts?: ProjectFacts; note?: string; packRoot?: string; folders?: string[] }): KnowledgeHandler =>
            new KnowledgeHandler({
                indexPath: () => settings.indexPath,
                includeIncomplete: () => settings.includeIncomplete === true,
                packRoot: async () => settings.packRoot,
                workspaceFolders: () => settings.folders ?? [],
                projectFacts: async () => ({ ...(settings.facts ? { facts: settings.facts } : {}), ...(settings.note ? { note: settings.note } : {}) }),
                log: silentLog,
            }, { timeoutMs: 5_000 });
        let handler: KnowledgeHandler;

        setup(() => { handler = handlerFor({ indexPath: file, facts }); });
        teardown(() => { handler.dispose(); });

        const refusedAs = (code: string, work: Promise<unknown>, message: RegExp): Promise<void> =>
            assert.rejects(work, (failure: unknown) => failure instanceof ToolError && failure.code === code && message.test(failure.message));

        test('knowledge_search names the context, the hits with their marks and the next step', async () => {
            const reply = await handler.handleKnowledgeSearch({ query: 'error csolution: board mounted device STM32U585AIIx not found' });
            assert.ok(isToolReply(reply));
            const text = textOf(reply);
            assert.match(text, /^Knowledge search: \d+ of \d+ matching units, about \d+ tokens\.\nContext: STM32U585AIIx, Cortex-M33, GCC \(active target\)\./);
            assert.match(text, /\n1\. ts-csolution-board-mounted-device · troubleshooting · draft · exact symptom · full text about \d+ tokens\n/);
            assert.match(text, /Next: knowledge_get \{ id \}/);
            assert.strictEqual(reply.data?.contextFilter, true);
        });

        test('knowledge_search without a project says why, and tools still filter', async () => {
            const bare = handlerFor({ indexPath: file, note: 'no folder is open' });
            const text = textOf(await bare.handleKnowledgeSearch({ query: 'M302', tools: ['svdconv'] }));
            assert.match(text, /Context: tools svdconv\./);
            assert.match(text, /1\. ts-svdconv-m302/);
            assert.doesNotMatch(text, /ts-packchk-m302/);
            assert.match(textOf(await bare.handleKnowledgeSearch({ query: 'M302' })), /No project context: no folder is open\./);
            assert.match(textOf(await bare.handleKnowledgeSearch({ query: 'zzzz' })), /Nothing matched/);
            bare.dispose();
        });

        test('knowledge_search counts what it leaves out, and shows it when the setting says so', async () => {
            const hidden = textOf(await handler.handleKnowledgeSearch({ query: 'no installed board was found' }));
            assert.match(hidden, /The index knows this message as ts-csolution-no-board, but no cause or fix is recorded for it yet; /);
            assert.match(hidden, /2 matching units have no cause or text yet and are left out\./);
            const all = handlerFor({ indexPath: file, includeIncomplete: true });
            assert.match(textOf(await all.handleKnowledgeSearch({ query: 'no installed board was found' })), /ts-csolution-no-board · troubleshooting · draft · exact symptom · no cause recorded/);
            all.dispose();
        });

        test('knowledge_get returns the whole body, however long', async () => {
            const reply = await handler.handleKnowledgeGet({ id: 'proc-long' });
            const text = textOf(reply);
            assert.ok(text.startsWith('proc-long · procedure · reviewed · pack\ngenerate-debug-sequences\n'));
            assert.match(text, /stop_conditions: Stop when confirmation is absent\./);
            assert.ok(text.endsWith('END') && text.length > 6_000, `${text.length} chars`);
            assert.match(textOf(await handler.handleKnowledgeGet({ id: 'rule-empty' })), /has no cause or text yet/);
            assert.match(textOf(await handler.handleKnowledgeGet({ id: 'core:Cortex-M55' })), /^core:Cortex-M55 · core\nCortex-M55$/);
        });

        test('knowledge_get lists the files a procedure ships, and returns one by its id; search never finds a file', async () => {
            const reply = await handler.handleKnowledgeGet({ id: 'proc-long' });
            assert.match(textOf(reply), /\nfiles \(the text names them by path; knowledge_get with the id returns the file\):\n {2}assets\/template\.yml → asset-long-assets-template-yml\n/);
            assert.ok(isToolReply(reply));
            assert.deepStrictEqual(reply.data?.files, [{ id: 'asset-long-assets-template-yml', path: 'assets/template.yml' }]);
            const file = textOf(await handler.handleKnowledgeGet({ id: 'asset-long-assets-template-yml' }));
            assert.ok(file.startsWith('asset-long-assets-template-yml · asset\nassets/template.yml\n'), file);
            assert.ok(file.endsWith('\n\nsolution:\n  compiler: __COMPILER__\n') || file.endsWith('\n\nsolution:\n  compiler: __COMPILER__'), file);
            assert.doesNotMatch(textOf(await handler.handleKnowledgeGet({ id: 'fx-generic' })), /\nfiles \(/);
            assert.doesNotMatch(textOf(await handler.handleKnowledgeSearch({ query: '__COMPILER__ template' })), /asset-long/);
        });

        test('knowledge_expand lists one hop, units first, and caps a large neighbourhood', async () => {
            const text = textOf(await handler.handleKnowledgeExpand({ id: 'fx-generic' }));
            assert.match(text, /2 relations:\n {2}← refines fx-m55 · pattern · Stack sizing pattern for Cortex-M55\n {6}Stack sizing with Helium\.\n {2}← requires proc-long/);
            assert.match(textOf(await handler.handleKnowledgeExpand({ id: 'fx-generic', relation: 'requires' })), /1 relation of kind requires:/);
            const big = await handler.handleKnowledgeExpand({ id: 'pack:Big::Pack' });
            assert.match(textOf(big), /61 relations, the first 40 shown, knowledge units first:\n {2}← references proc-long/);
            assert.match(textOf(big), /21 more are not shown; pass relation to narrow\./);
            assert.ok(isToolReply(big) && big.data?.total === 61);
            assert.match(textOf(await handler.handleKnowledgeExpand({ id: 'rule-empty' })), /No relations\./);
        });

        test('missing arguments, unknown ids and a missing index are typed failures', async () => {
            await refusedAs('INVALID_ARGUMENT', handler.handleKnowledgeSearch({ query: '  ' }), /needs a query/);
            await refusedAs('INVALID_ARGUMENT', handler.handleKnowledgeGet({}), /needs an id/);
            await refusedAs('INVALID_ARGUMENT', handler.handleKnowledgeGet({ id: 'nope' }), /has no "nope"/);
            await refusedAs('TOOL_DISABLED', handlerFor({}).handleKnowledgeSearch({ query: 'x' }), /No knowledge index is set/);
            await refusedAs('INVALID_ARGUMENT', handlerFor({ indexPath: path.join(dir, 'absent.db') }).handleKnowledgeGet({ id: 'x' }), /does not exist/);
        });

        test('a file that is no index, and an index of another schema version, are refused', async () => {
            const text = path.join(dir, 'notes.db');
            fs.writeFileSync(text, 'not a database');
            await refusedAs('INVALID_ARGUMENT', handlerFor({ indexPath: text }).handleKnowledgeGet({ id: 'x' }), /is not a knowledge index/);
            const later = path.join(dir, 'later.db');
            writeIndex(later, { schema_version: '2' });
            await refusedAs('INVALID_ARGUMENT', handlerFor({ indexPath: later }).handleKnowledgeGet({ id: 'x' }), /schema version 2; this extension reads version 1/);
            const stated = path.join(dir, 'stated.db');
            writeIndex(stated, { schema_version: '1.2' });
            const fine = handlerFor({ indexPath: stated });
            assert.match(textOf(await fine.handleKnowledgeGet({ id: 'fx-generic' })), /^fx-generic/);
            fine.dispose();
        });

        test('a rebuilt index file is picked up on the next call', async () => {
            const own = path.join(dir, 'rebuilt.db');
            writeIndex(own);
            const live = handlerFor({ indexPath: own });
            await live.handleKnowledgeGet({ id: 'fx-generic' });
            const db = new DatabaseSync(own);
            db.prepare("INSERT INTO nodes VALUES('fx-new', 'knowledge', 'concept', NULL, 'New', '', 'new body', '{}')").run();
            db.close();
            fs.utimesSync(own, new Date(), new Date(Date.now() + 5_000));
            assert.match(textOf(await live.handleKnowledgeGet({ id: 'fx-new' })), /new body$/);
            live.dispose();
        });

        test('the lines for a failed build name complete units, and never throw', () => {
            assert.deepStrictEqual(handler.knownMessageLines(['board mounted device X not found', 'no installed board was found']),
                ['Known message: knowledge_get { id: "ts-csolution-board-mounted-device" } has its cause and fix.']);
            assert.deepStrictEqual(handlerFor({}).knownMessageLines(['board mounted device X not found']), []);
            assert.deepStrictEqual(handlerFor({ indexPath: path.join(dir, 'absent.db') }).knownMessageLines(['x']), []);
        });
    });

    suite('browser', () => {
        let index: KnowledgeIndex;
        suiteSetup(() => {
            index = new KnowledgeIndex(file);
        });
        suiteTeardown(() => index.close());

        test('the list holds every unit, procedures first, with state and file count', () => {
            const rows = unitRows(index);
            assert.strictEqual(rows.length, index.unitCount());
            assert.strictEqual(rows[0].type, 'procedure');
            const long = rows.find((row) => row.id === 'proc-long');
            assert.ok(long && long.files === 1 && long.status === 'reviewed' && !long.incomplete && long.tokens > 1_000, JSON.stringify(long));
            assert.strictEqual(rows.find((row) => row.id === 'rule-empty')?.incomplete, true);
            const order = rows.map((row) => TYPE_ORDER.indexOf(row.type));
            assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'types in the listed order');
        });

        test('the overview counts by type, domain, tool and state, and the graph by entity and relation', () => {
            const rows = unitRows(index);
            const overview = overviewOf(index, rows);
            assert.strictEqual(overview.units, rows.length);
            assert.strictEqual(overview.byType.reduce((sum, entry) => sum + entry.count, 0), rows.length);
            assert.strictEqual(overview.incomplete, rows.filter((row) => row.incomplete).length);
            assert.ok(overview.entities.some((entry) => entry.name === 'asset' && entry.count === 1));
            assert.ok(overview.entities.some((entry) => entry.name === 'device' && entry.count >= 60));
            assert.ok(overview.relations.some((entry) => entry.name === 'part_of'));
            assert.deepStrictEqual(overview.routes, [], 'this index has no routing unit');
            assert.strictEqual(overview.byCollection.reduce((sum, entry) => sum + entry.count, 0), rows.length);
            assert.strictEqual(rows.find((row) => row.id === 'ts-packchk-m302')?.collection, 'error-catalog', 'a catalog message names no collection');
            assert.strictEqual(rows.find((row) => row.id === 'proc-long')?.collection, 'skills');
        });

        test('a node in full: text as HTML, files, relations, frontmatter; a file as a code block; an entity without text', () => {
            const detail = detailOf(index, 'proc-long');
            assert.ok(detail);
            assert.deepStrictEqual(detail.files, [{ id: 'asset-long-assets-template-yml', path: 'assets/template.yml' }]);
            assert.ok(detail.html.length > 0 && detail.status === 'reviewed' && detail.relationTotal >= 2);
            assert.ok(detail.relations.every((relation) => relation.known));
            assert.ok(detail.meta.some((entry) => entry.key === 'stop_conditions'));
            assert.ok(!detail.meta.some((entry) => entry.key === 'status'), 'the status has its own place');
            const fileDetail = detailOf(index, 'asset-long-assets-template-yml');
            assert.strictEqual(fileDetail?.html, '<pre class="file"><code>solution:\n  compiler: __COMPILER__\n</code></pre>');
            const entity = detailOf(index, 'core:Cortex-M55');
            assert.ok(entity && entity.html === '' && entity.kind === 'entity' && entity.relationTotal > 0);
            assert.strictEqual(detailOf(index, 'no-such-node'), undefined);
        });

        test('the neighbourhood: the centre, one hop, then two, capped, each edge in the index direction', () => {
            const one = graphAround(index, 'fx-generic', 1);
            assert.ok(one);
            assert.strictEqual(one.nodes.filter((node) => node.ring === 0).length, 1);
            assert.deepStrictEqual(one.nodes.filter((node) => node.ring === 1).map((node) => node.id).sort(), ['fx-m55', 'proc-long']);
            assert.ok(one.edges.some((edge) => edge.from === 'fx-m55' && edge.relation === 'refines' && edge.to === 'fx-generic'));
            assert.strictEqual(one.hidden, 0);
            const two = graphAround(index, 'fx-generic', 2);
            assert.ok(two && two.nodes.some((node) => node.ring === 2 && node.parent !== undefined) && two.nodes.length > one.nodes.length);
            const big = graphAround(index, 'pack:Big::Pack', 1);
            assert.ok(big && big.nodes.length <= 70 && big.hidden > 0, `${big?.nodes.length} nodes, ${big?.hidden} hidden`);
            assert.strictEqual(graphAround(index, 'no-such-node', 1), undefined);
        });

        test('Markdown becomes HTML of its own tags only: the source is escaped, references become links', () => {
            const known = new Set(['proc-other', 'asset-x']);
            const resolve = (reference: string): string | undefined =>
                known.has(reference) ? reference : known.has(`proc-${reference}`) ? `proc-${reference}` : reference === 'assets/x.yml' ? 'asset-x' : undefined;
            const html = renderMarkdown([
                '# Title <script>alert(1)</script>', '', 'Run `$other` then **stop**. See [the doc](https://example.com/a?b=1&c=2) and',
                '[assets/x.yml](assets/x.yml), not [bad](javascript:alert(1)).', '', '- one', '  - nested `code <b>`', '1. first', '',
                '| a | b |', '|---|---|', '| 1 | `proc-other` |', '', '```yaml', 'k: <v> & "q"', '```', '', '> quoted', '<img src=x onerror=alert(1)>', '<!-- hidden -->',
            ].join('\n'), resolve);
            assert.ok(!/<script|<img|onerror=|javascript:alert\(1\)"/.test(html.replace(/&lt;[^&]*&gt;/g, '')), html);
            assert.match(html, /<h2>Title &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h2>/);
            assert.match(html, /<a class="ref" data-id="proc-other"><code>\$other<\/code><\/a> then <strong>stop<\/strong>/);
            assert.match(html, /<a class="ext" data-url="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
            assert.match(html, /<a class="ref" data-id="asset-x">assets\/x\.yml<\/a>/);
            assert.match(html, /bad <span class="muted">\(javascript:alert\(1\)<\/span>/);
            assert.match(html, /<div class="li d0"><span class="mark">•<\/span><span>one<\/span><\/div>\n<div class="li d1">.*<code>code &lt;b&gt;<\/code>/);
            assert.match(html, /<div class="li d0"><span class="mark">1\.<\/span>/);
            assert.match(html, /<table class="md"><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td><a class="ref" data-id="proc-other">/);
            assert.match(html, /<pre data-lang="yaml"><code>k: &lt;v&gt; &amp; &quot;q&quot;<\/code><\/pre>/);
            assert.match(html, /<blockquote>quoted<\/blockquote>/);
            assert.ok(!html.includes('hidden'), 'an HTML comment of the source is dropped');
        });

        test('the page admits one script by its nonce, and the panel opens only http links and asks for depth 1 or 2', () => {
            const page = knowledgePanelHtml('abc123');
            assert.match(page, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc123';"/);
            assert.strictEqual(page.match(/<script/g)?.length, 1);
            assert.match(page, /<script nonce="abc123">/);
            assert.ok(!KNOWLEDGE_PANEL_SCRIPT.includes('`') && !KNOWLEDGE_PANEL_SCRIPT.includes('${'), 'the script is a raw string');
            assert.doesNotThrow(() => new Function('acquireVsCodeApi', 'document', 'window', KNOWLEDGE_PANEL_SCRIPT.replace(/^\s*\(function/, 'return (function').replace(/\)\(\);\s*$/, ');')));
            assert.strictEqual(externalUrl('https://example.com/x'), 'https://example.com/x');
            for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'command:workbench.action.reloadWindow', '', 42, undefined]) {
                assert.strictEqual(externalUrl(bad), undefined, String(bad));
            }
            assert.deepStrictEqual([graphDepth(2), graphDepth(1), graphDepth(9), graphDepth('2')], [2, 1, 1, 1]);
        });
    });

    suite('index set: packs and the workspace', () => {
        const handlerFor = (settings: { indexPath: string; packRoot?: string; folders?: string[] }): KnowledgeHandler =>
            new KnowledgeHandler({
                indexPath: () => settings.indexPath, includeIncomplete: () => false, packRoot: async () => settings.packRoot,
                workspaceFolders: () => settings.folders ?? [], projectFacts: async () => ({ note: 'no folder is open' }), log: silentLog,
            }, { timeoutMs: 5_000 });
        const refusedAs = (code: string, work: Promise<unknown>, message: RegExp): Promise<void> =>
            assert.rejects(work, (failure: unknown) => failure instanceof ToolError && failure.code === code && message.test(failure.message));
        let root: string;
        let packFile: string;
        let wsFile: string;

        /** A second index with units of its own, as a pack would ship it. */
        function writePackIndex(file: string): void {
            const db = new DatabaseSync(file);
            db.exec(`
                CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, type TEXT, domain TEXT, title TEXT, summary TEXT, body TEXT, meta JSON);
                CREATE TABLE edges(src TEXT, rel TEXT, dst TEXT, qual JSON, PRIMARY KEY(src, rel, dst));
                CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, title, summary, body, symptoms, triggers, tokenize='porter unicode61');
                CREATE TABLE info(key TEXT PRIMARY KEY, value TEXT);
            `);
            const node = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)');
            const fts = db.prepare('INSERT INTO nodes_fts VALUES(?,?,?,?,?,?)');
            const edge = db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?,?,NULL)');
            node.run('pk-errata-dma', 'knowledge', 'concept', 'device', 'MYCHIP DMA errata', 'The DMA stalls on a stack sizing pattern.', 'pack body about stack sizing', JSON.stringify({ status: 'reviewed' }));
            fts.run('pk-errata-dma', 'MYCHIP DMA errata', 'The DMA stalls on a stack sizing pattern.', 'pack body about stack sizing', '', '');
            node.run('ts-pack-boot', 'knowledge', 'troubleshooting', 'error-catalog', 'boot ROM: image not signed', '', CAUSE, JSON.stringify({ status: 'draft', tool: 'bootrom', symptoms: ['image not signed'], symptom_regex: '^image not signed$' }));
            fts.run('ts-pack-boot', 'boot ROM: image not signed', '', CAUSE, 'image not signed', '');
            node.run('device:MYCHIP', 'entity', 'device', null, 'MYCHIP', null, null, '{}');
            edge.run('device:MYCHIP', 'has_core', 'core:Cortex-M55');
            edge.run('pk-errata-dma', 'applies_to', 'device:MYCHIP');
            edge.run('pk-errata-dma', 'refines', 'fx-generic');
            db.close();
        }

        suiteSetup(() => {
            root = path.join(dir, 'packs');
            const packDir = path.join(root, 'MyVendor', 'MYCHIP_DFP', '1.2.0');
            fs.mkdirSync(path.join(packDir, 'knowledge'), { recursive: true });
            packFile = path.join(packDir, 'knowledge', 'knowledge.db');
            writePackIndex(packFile);
            fs.mkdirSync(path.join(root, 'Other', 'NoKnowledge_DFP', '1.0.0'), { recursive: true });
            fs.mkdirSync(path.join(root, '.Web'), { recursive: true });
            const localPack = path.join(dir, 'local-pack');
            fs.mkdirSync(localPack, { recursive: true });
            writePackIndex(path.join(localPack, 'knowledge.db'));
            fs.mkdirSync(path.join(root, '.Local'), { recursive: true });
            fs.writeFileSync(path.join(root, '.Local', 'local_repository.pidx'),
                `<?xml version="1.0"?><index><pindex><pdsc url="file://${localPack}/" vendor="Local" name="Knowledge" version="0.1.0"/></pindex></index>`);
            const ws = path.join(dir, 'ws');
            fs.mkdirSync(path.join(ws, '.cmsis'), { recursive: true });
            wsFile = path.join(ws, '.cmsis', 'knowledge.db');
            writePackIndex(wsFile);
        });

        test('indexes are found in installed packs, the local repository and the workspace, each once', () => {
            assert.deepStrictEqual(installedPackIndexes(root), [{ label: 'MyVendor::MYCHIP_DFP@1.2.0', file: packFile }]);
            assert.deepStrictEqual(localRepositoryIndexes(root).map((f) => f.label), ['Local::Knowledge@0.1.0 (local)']);
            assert.deepStrictEqual(workspaceIndexes([path.join(dir, 'ws')]), [{ label: 'workspace', file: wsFile }]);
            assert.deepStrictEqual(discoverIndexes(root, [path.join(dir, 'ws'), path.join(dir, 'nowhere')]).map((f) => f.label),
                ['MyVendor::MYCHIP_DFP@1.2.0', 'Local::Knowledge@0.1.0 (local)', 'workspace:ws']);
            assert.deepStrictEqual(discoverIndexes(undefined, []), []);
            assert.deepStrictEqual(discoverIndexes(path.join(dir, 'absent'), []), []);
        });

        test('ranked lists are merged by rank, the base first within a rank', () => {
            assert.deepStrictEqual(interleaveByRank([['a', 'b', 'c'], ['x', 'b', 'y', 'z']], 10), ['a', 'x', 'b', 'c', 'y', 'z']);
            assert.deepStrictEqual(interleaveByRank([['a', 'b'], ['x']], 2), ['a', 'x']);
            assert.deepStrictEqual(interleaveByRank([], 5), []);
        });

        test('a set reads the base and a pack as one: lookups, symptoms, ancestors, refines and the source of a hit', () => {
            const set = new KnowledgeSet([{ label: 'base', file }, { label: 'MyVendor::MYCHIP_DFP@1.2.0', file: packFile }]);
            try {
                assert.strictEqual(set.sources().length, 2);
                assert.strictEqual(set.unitCount(), index.unitCount() + 2);
                assert.strictEqual(set.node('pk-errata-dma')?.title, 'MYCHIP DMA errata');
                assert.strictEqual(set.sourceOf('pk-errata-dma'), 'MyVendor::MYCHIP_DFP@1.2.0');
                assert.strictEqual(set.sourceOf('fx-generic'), undefined);
                assert.deepStrictEqual(set.exactSymptoms(['image not signed']), ['ts-pack-boot']);
                assert.ok(set.ancestors('device:MYCHIP').has('core:Cortex-M55'));
                assert.ok(set.refinements().some(([s, g]) => s === 'pk-errata-dma' && g === 'fx-generic'));
                // The pack's unit applies to its device and replaces the general pattern there; elsewhere it is filtered out.
                const onChip = searchKnowledge(set, 'stack sizing pattern', { context: contextEntities(set, { device: 'MYCHIP', compiler: 'GCC' }) });
                assert.ok(onChip.results.some((hit) => hit.id === 'pk-errata-dma' && hit.source === 'MyVendor::MYCHIP_DFP@1.2.0'), JSON.stringify(onChip.results));
                assert.ok(!onChip.results.some((hit) => hit.id === 'fx-generic'));
                const elsewhere = searchKnowledge(set, 'stack sizing pattern', { context: contextEntities(set, { device: 'STM32U585AIIx', compiler: 'GCC' }) });
                assert.ok(!elsewhere.results.some((hit) => hit.id === 'pk-errata-dma'));
                assert.ok(set.nodeCounts().some((entry) => entry.type === 'device' && entry.count >= 2));
                assert.strictEqual(set.info.indexes, 'base, MyVendor::MYCHIP_DFP@1.2.0');
            } finally {
                set.close();
            }
        });

        test('the handler opens the packs of the pack root and the workspace with the base, and reopens when one appears', async () => {
            const own = path.join(dir, 'set-root');
            fs.mkdirSync(own, { recursive: true });
            const live = handlerFor({ indexPath: file, packRoot: own, folders: [path.join(dir, 'ws')] });
            let text = textOf(await live.handleKnowledgeSearch({ query: 'image not signed' }));
            assert.match(text, /Indexes: base and workspace \(2 units\)\./);
            assert.match(text, /1\. ts-pack-boot · troubleshooting · draft · exact symptom · from workspace/);
            const late = path.join(own, 'V', 'P', '2.0.0');
            fs.mkdirSync(late, { recursive: true });
            fs.copyFileSync(packFile, path.join(late, 'knowledge.db'));
            text = textOf(await live.handleKnowledgeSearch({ query: 'image not signed' }));
            assert.match(text, /Indexes: base and V::P@2\.0\.0 \(2 units\), workspace \(2 units\)\./);
            assert.match(textOf(await live.handleKnowledgeGet({ id: 'ts-pack-boot' })), /^ts-pack-boot · troubleshooting · draft · error-catalog · from V::P@2\.0\.0\n/);
            live.dispose();
        });

        test('an unreadable pack index fails the call with its file named', async () => {
            const bad = path.join(dir, 'bad-root', 'V', 'P', '1.0.0');
            fs.mkdirSync(bad, { recursive: true });
            fs.writeFileSync(path.join(bad, 'knowledge.db'), 'not a database');
            const live = handlerFor({ indexPath: file, packRoot: path.join(dir, 'bad-root') });
            await refusedAs('INVALID_ARGUMENT', live.handleKnowledgeGet({ id: 'fx-generic' }), /bad-root.*is not a knowledge index/);
            live.dispose();
        });
    });

    suite('wiring', () => {
        test('the knowledge ops are known ops of the pack-docs dispatch, and no documentation ops', () => {
            assert.deepStrictEqual([...KNOWLEDGE_OPS], ['handleKnowledgeSearch', 'handleKnowledgeGet', 'handleKnowledgeExpand']);
            for (const op of KNOWLEDGE_OPS) {
                assert.ok(isKnownOp(op) && isPackDocsOp(op) && isKnowledgeOp(op) && !isPackDocsDocOp(op), op);
            }
            assert.strictEqual(isKnowledgeOp('handleListTargetDocs'), false);
        });

        test('the dispatch reaches the knowledge handler, and refuses without one', async () => {
            const knowledge = new KnowledgeHandler(
                { indexPath: () => file, includeIncomplete: () => false, packRoot: async () => undefined, workspaceFolders: () => [], projectFacts: async () => ({}), log: silentLog }, { timeoutMs: 5_000 });
            const others = {} as unknown as Pick<PackDocsHandlers, 'docs' | 'build'>;
            const dispatch = localPackDocsDispatch({ ...others, knowledge });
            assert.match(textOf(await dispatch('handleKnowledgeGet', { id: 'fx-generic' })), /^fx-generic · pattern · draft/);
            knowledge.dispose();
            await assert.rejects(localPackDocsDispatch({ ...others })('handleKnowledgeGet', { id: 'fx-generic' }),
                (failure: unknown) => failure instanceof ToolError && failure.code === 'TOOL_DISABLED');
        });

        test('the instructions name the knowledge tools only when they are on', () => {
            assert.doesNotMatch(composeInstructions({ packDocsEnabled: true, buildInfoEnabled: true }), /knowledge_search/);
            assert.match(composeInstructions({ knowledgeEnabled: true }), /knowledge_search, knowledge_get, knowledge_expand/);
            assert.match(composeInstructions({ knowledgeEnabled: true }), /invoke the Agent Skill "cmsis-debug-live"/);
            const withoutSkills = composeInstructions({ knowledgeEnabled: true, skillsReplaced: true });
            assert.match(withoutSkills, /invoke the Agent Skill "cmsis-debug-live"/);
            assert.match(withoutSkills, /Only the core Agent Skills are installed: cmsis-debug-live, cmsis-pack-docs and cmsis-help\. There is no skill for the other CMSIS tasks: their procedures come from knowledge_search and knowledge_get\./);
            assert.doesNotMatch(composeInstructions({ knowledgeEnabled: true }), /Only the core Agent Skills/);
            // What a skill's description did by itself has to be said: look the procedure up before the work, and first of all.
            for (const text of [withoutSkills, composeInstructions({ knowledgeEnabled: true })]) {
                assert.ok(text.startsWith('Knowledge first: before you start a CMSIS task'), text.slice(0, 80));
                assert.match(text, /call knowledge_search with the task in a few words, read the procedure it finds with knowledge_get and follow it; do not work such a task from memory/);
                assert.match(text, /route-project, route-bring-up, route-pack and route-debug/);
            }
            assert.doesNotMatch(composeInstructions({ packDocsEnabled: true }), /Knowledge first/);
        });

        test('the components of a cbuild.yml are read from its component lines', () => {
            const yml = 'build:\n  components:\n    - component: ARM::CMSIS:CORE@6.1.0\n      condition: x\n    - component: "Keil::Device:Startup@1.0.0"\n';
            assert.deepStrictEqual(componentsOf(yml), ['ARM::CMSIS:CORE@6.1.0', 'Keil::Device:Startup@1.0.0']);
        });
    });
});
