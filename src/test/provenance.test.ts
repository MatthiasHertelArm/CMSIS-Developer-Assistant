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
import * as path from 'path';

/**
 * Files still derived from microsoft/DebugMCP and therefore still carrying its
 * copyright line (issue #53). The list only shrinks: a rewrite removes the line
 * and its entry in the same change, and no other file may pick the line up.
 */
const DERIVED_FILES = [
    'LICENSE-MIT',
    'NOTICE',
    'src/debugMCPServer.ts',
    'src/test/debugSkillGuidance.test.ts',
];

const MARKER = ['Copyright (c)', 'Microsoft', 'Corporation'].join(' ');
// .claude holds local agent worktrees (full checkouts of other revisions).
const SKIP_DIRS = new Set(['.git', '.claude', 'node_modules', 'out', 'dist', 'coverage', '.vscode-test', 'cmsis-skills', '.work']);
// Code and licence files. Prose may quote the line (docs about this very rule).
const TEXT_FILE = /\.(ts|js|mjs|cjs|json|jsonc)$|^(NOTICE|LICENSE[-\w]*)$/;

function textFiles(root: string, dir = ''): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) { out.push(...textFiles(root, rel)); }
        } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
            out.push(rel);
        }
    }
    return out;
}

suite('Provenance (issue #53)', () => {

    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const carrying = textFiles(repoRoot)
        .filter((rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').includes(MARKER))
        .sort();

    test('no file outside the derived list carries the Microsoft copyright line', () => {
        const unexpected = carrying.filter((rel) => !DERIVED_FILES.includes(rel));
        assert.deepStrictEqual(unexpected, [],
            'new and rewritten files take the Arm Apache header only (AGENTS.md, "File Header")');
    });

    test('every file on the derived list still carries it, so the list shrinks with each rewrite', () => {
        const rewritten = DERIVED_FILES.filter((rel) => !carrying.includes(rel));
        assert.deepStrictEqual(rewritten, [],
            'remove rewritten files from DERIVED_FILES in src/test/provenance.test.ts');
    });
});
