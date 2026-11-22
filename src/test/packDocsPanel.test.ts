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
import { packDocsPanelHtml, panelCommand } from '../packDocsPanel';

/**
 * The Pack Docs webview may ask the extension to run a VS Code command; only
 * the ones its own script posts are run. The webview shows text taken from
 * PDFs and pdsc files, so an id smuggled into a message must go nowhere.
 */
suite('Pack Docs panel commands', () => {
    test('the import command of the Documents tab is run', () => {
        assert.strictEqual(panelCommand('cmsis-developer-assistant.importUserDoc'), 'cmsis-developer-assistant.importUserDoc');
    });

    test('the Store tab\'s link to the Target Documents view is run', () => {
        assert.strictEqual(panelCommand('cmsisDeveloperAssistant.targetDocuments.focus'), 'cmsisDeveloperAssistant.targetDocuments.focus');
    });

    test('any other id, or a value that is not a string, is refused', () => {
        const refused: unknown[] = [
            'workbench.action.terminal.new', 'cmsis-developer-assistant.configure', 'CMSIS-DEVELOPER-ASSISTANT.IMPORTUSERDOC',
            ' cmsis-developer-assistant.importUserDoc', '', undefined, null, 42, ['cmsis-developer-assistant.importUserDoc'],
        ];
        for (const requested of refused) {
            assert.strictEqual(panelCommand(requested), undefined, String(requested));
        }
    });
});

/**
 * The page is one template string, so the compiler never reads its script: a
 * backslash the template swallows or a brace that is missing shows only when
 * the panel opens. Here the page is rendered and its script compiled, not run.
 */
suite('Pack Docs panel page', () => {
    const NONCE = 'n0nce42';
    const page = packDocsPanelHtml(NONCE);
    const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];

    test('the page admits one script, by its nonce, and nothing from elsewhere', () => {
        assert.ok(page.startsWith('<!DOCTYPE html>'), page.slice(0, 40));
        assert.ok(page.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';">`));
        assert.strictEqual(page.match(/<script/g)?.length, 1);
        assert.strictEqual(scripts.length, 1, 'the one script is closed');
        assert.strictEqual(scripts[0][1], ` nonce="${NONCE}"`);
        const markup = page.replace(scripts[0][0], '');
        assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(markup), 'an inline handler would be refused by the policy');
        assert.ok(!/\bsrc\s*=/i.test(markup), 'the policy loads nothing: no image, frame or script by address');
        assert.notStrictEqual(packDocsPanelHtml('other'), page, 'the nonce is the caller\'s');
    });

    test('the script of the page is JavaScript as it arrives in the webview', () => {
        const script = scripts[0][2];
        assert.doesNotThrow(() => new Function('acquireVsCodeApi', 'document', 'window', script));
        assert.ok(script.includes('acquireVsCodeApi()') && script.includes("vscode.postMessage({ type: 'tools.list' })"), 'it talks to the panel, and asks for the tools');
    });

    test('every command the script posts is one the panel runs', () => {
        const posted = [...scripts[0][2].matchAll(/command:\s*'([^']+)'/g)].map((found) => found[1]);
        assert.deepStrictEqual([...new Set(posted)].sort(), ['cmsis-developer-assistant.importUserDoc', 'cmsisDeveloperAssistant.targetDocuments.focus']);
        for (const id of posted) {
            assert.strictEqual(panelCommand(id), id);
        }
    });
});
