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
import { panelCommand } from '../packDocsPanel';

/**
 * The Pack Docs webview may ask the extension to run a VS Code command; only
 * the ones its own script posts are run. The webview shows text taken from
 * PDFs and pdsc files, so an id smuggled into a message must go nowhere.
 */
suite('Pack Docs panel commands', () => {
    test('the import command of the Documents tab is run', () => {
        assert.strictEqual(panelCommand('cmsis-developer-assistant.importUserDoc'), 'cmsis-developer-assistant.importUserDoc');
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
