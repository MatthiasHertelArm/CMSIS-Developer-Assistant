/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import { survivesWindowReload } from '../core/clientHosting';

suite('Which MCP clients survive a window reload', () => {
    test('the CLIs do: Claude Code, Codex, Gemini CLI, by name prefix, case-insensitively', () => {
        for (const name of ['claude-code', 'Claude-Code', 'codex-mcp-client', 'gemini-cli-mcp-client']) {
            assert.strictEqual(survivesWindowReload(name), true, name);
        }
    });

    test('a chat inside the window does not, nor an unknown or absent client', () => {
        for (const name of ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cline', 'Roo Code', 'cursor-vscode', 'windsurf', '', undefined]) {
            assert.strictEqual(survivesWindowReload(name), false, String(name));
        }
    });
});
