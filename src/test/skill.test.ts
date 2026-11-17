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
import { load } from 'js-yaml';
import { cmsisActions, registeredTools } from './registeredTools';

/** Kimi Code lists only the first 250 characters of a skill's description (2.7.0, #103). */
const KIMI_LISTED_CHARS = 250;
/** Claude Code cuts `description` and `when_to_use` together at 1 536 characters in its skill listing. */
const CLAUDE_LISTING_CHARS = 1536;
/** The section of the skill that keeps host-side CMSIS work in the VS Code window (#119). */
const BUILD_SECTION = '## Builds, the compiler and the tools environment';

/** The lines of `markdown` from `heading` up to the next heading of the same level. */
function sectionOf(markdown: string, heading: string): string {
    const lines = markdown.split('\n');
    const start = lines.indexOf(heading);
    assert.ok(start >= 0, `no "${heading}" section`);
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/**
 * The installed health-check skill may invoke only tools the extension
 * actually registers, and it is the entry point for every CMSIS task, the
 * builds and the tools environment on the host included (#119).
 */
suite('Installed agent skill', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const skillFile = path.join(repoRoot, 'skills', 'cmsis-help', 'SKILL.md');

    test('the only authored skill directory is cmsis-help', () => {
        const directories = fs.readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
            .filter(entry => entry.isDirectory()).map(entry => entry.name);
        assert.deepStrictEqual(directories, ['cmsis-help']);
        assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: cmsis-help\n/);
    });

    test('the health check names only registered tools, including knowledge tools', () => {
        const markdown = fs.readFileSync(skillFile, 'utf8');
        const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown);
        assert.ok(frontmatter);
        const allowed = [...frontmatter[1].matchAll(/^\s*-\s*([a-z0-9_]+)\s*$/gm)].map(match => match[1]);
        assert.ok(allowed.length > 0);
        const registered = new Set(registeredTools(repoRoot));
        assert.deepStrictEqual(allowed.filter(name => !registered.has(name)), []);
        for (const name of ['get_session_status', 'knowledge_search', 'knowledge_get']) {
            assert.ok(allowed.includes(name), name);
        }
    });

    test('the frontmatter names host-side builds where every harness lists it, not debugging alone (#119)', () => {
        const fenced = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(skillFile, 'utf8'));
        assert.ok(fenced, 'SKILL.md opens with YAML frontmatter');
        // A harness that cannot parse the frontmatter loads the skill without metadata, and no task matches it.
        const frontmatter = load(fenced[1]) as Record<string, unknown>;
        const description = String(frontmatter.description ?? '');
        const whenToUse = String(frontmatter.when_to_use ?? '');
        const listed = description.slice(0, KIMI_LISTED_CHARS);
        for (const term of ['build', 'refresh', 'compiler', 'tools environment']) {
            assert.ok(listed.includes(term), `the first ${KIMI_LISTED_CHARS} characters of the description lack "${term}": ${listed}`);
        }
        assert.ok(description.length + whenToUse.length <= CLAUDE_LISTING_CHARS,
            `description and when_to_use are ${description.length + whenToUse.length} characters; Claude Code lists ${CLAUDE_LISTING_CHARS}`);
        for (const command of ['cbuild', 'csolution', 'vcpkg']) {
            assert.ok(whenToUse.includes(command), `when_to_use does not name ${command}`);
        }
        assert.ok(whenToUse.includes('in a shell'), whenToUse);
        assert.ok(!/[<>]/.test(`${description}${whenToUse}`), 'Claude Code shows angle brackets in the listing as &lt; and &gt;');
    });

    test('builds, refreshes and the tools environment stay on cmsis_action in the window, and the skill says why (#119)', () => {
        const section = sectionOf(fs.readFileSync(skillFile, 'utf8'), BUILD_SECTION);
        const actions = new Set(cmsisActions(repoRoot));
        for (const action of ['build', 'refresh', 'activate_environment']) {
            assert.ok(actions.has(action), `cmsis_action has no action ${action}`);
            assert.ok(section.includes(`\`${action}\``), `the section does not name \`${action}\``);
        }
        assert.ok(section.includes('`cmsis_action`'));
        // Why: the window's selected target and tools environment, and diagnostics the user sees.
        for (const reason of ['CMSIS Solution panel', '`.cmsis/tools-environment.yml`', 'diagnostics', 'PATH']) {
            assert.ok(section.includes(reason), `the section does not say why: no "${reason}"`);
        }
        for (const command of ['`cbuild`', '`csolution`', '`vcpkg`']) {
            assert.ok(section.includes(command), `the section does not name ${command}`);
        }
        assert.ok(section.includes('only when the user asks for that command or a procedure from `knowledge_get` names it'),
            'the section does not say when a shell command is allowed');
    });
});
