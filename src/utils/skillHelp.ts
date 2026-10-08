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
 * The generated `cmsis-help` Agent Skill — one page an agent can answer
 * "what can the CMSIS Developer Assistant do, and which part fits my task?"
 * from: the tool rules, the CMSIS slash commands and the member skills behind
 * each, the VS Code commands, the MCP tool groups, the shell commands those
 * tools replace, and the settings.
 *
 * The skill is rendered twice, since what it must say depends on a setting
 * the agent cannot see. With the skills installed (`HelpSkillMode`
 * `skills`), it lists the slash commands and the member skills. With
 * `knowledge.replaceSkills` on (`knowledge`), no skill but this one is
 * installed and the procedures are units of the knowledge index: the same
 * lists name the units instead, and nothing reads like a command the agent
 * could invoke. One file for both, with a condition for the agent to work
 * out, did not hold: a model given a table of `/commands` repeats the table.
 * The sync writes the `knowledge` variant to `HELP_SKILL_KNOWLEDGE_PATH`,
 * and the installer copies it under the skill's name when the setting is on
 * (`catalogForInstall`).
 *
 * The renderers are pure and run in `scripts/sync-skills.ts` (which writes
 * the skill) and in the tests (which re-render it and compare byte for byte),
 * never in the extension; the runtime imports only the constants and
 * `catalogForInstall`. Everything in the output derives from the catalog,
 * package.json, scripts/skills.config.json and the tool contract, and nothing
 * is timestamped, so a re-sync at the same inputs is a no-op and a forgotten
 * re-sync fails the test instead of shipping a stale list.
 */

import { RULES_BLOCK, TABLE_BLOCK, ToolContract, renderContractBlock } from '../core/toolContract';
import { SKILL_CATEGORY_LABELS, SKILL_CATEGORY_ORDER, SkillCatalog, SkillCatalogEntry } from './skillCatalog';

export const HELP_SKILL_NAME = 'cmsis-help';

/** Where the sync writes the `knowledge` variant; installed under `HELP_SKILL_NAME` like the other. */
export const HELP_SKILL_KNOWLEDGE_PATH = `skills/${HELP_SKILL_NAME}-knowledge`;

/**
 * Which procedures the help names: the installed skills, or the units of the
 * knowledge index while `knowledge.replaceSkills` keeps the skills out.
 */
export type HelpSkillMode = 'skills' | 'knowledge';

/**
 * The catalog the installer works from: with the skills replaced, the help
 * entry points at the `knowledge` variant, so the copy under `cmsis-help`
 * names the knowledge units. Every other entry is unchanged.
 */
export function catalogForInstall(catalog: SkillCatalog, skillsReplaced: boolean): SkillCatalog {
    if (!skillsReplaced) {
        return catalog;
    }
    return {
        ...catalog,
        skills: catalog.skills.map(entry => entry.name === HELP_SKILL_NAME ? { ...entry, path: HELP_SKILL_KNOWLEDGE_PATH } : entry),
    };
}

/** Settings prefix, also the MCP server key and the command namespace. */
export const SETTINGS_PREFIX = 'cmsis-developer-assistant';

export interface HelpToolGroup {
    name: string;
    /** Hand-authored: the generator must not import the MCP server to list tools. */
    summary: string;
}

/** The `help` block of scripts/skills.config.json. */
export interface HelpSkillConfig {
    displayName: string;
    shortDescription: string;
    description: string;
    /** The frontmatter description of the `knowledge` variant: what it lists are units, not skills. */
    knowledgeDescription: string;
    /** One line per palette command id — every visible command needs one, and every key must exist. */
    commands: Record<string, string>;
    toolGroups: HelpToolGroup[];
    /** One line per setting id (without the prefix); each must exist in package.json. */
    settings: Record<string, string>;
}

export interface PackageCommand {
    command: string;
    title: string;
    category?: string;
}

export interface PackageSetting {
    default?: unknown;
    description?: string;
    markdownDescription?: string;
}

export interface PackageContributions {
    /** Palette-visible commands, in package.json order. */
    commands: PackageCommand[];
    /** Commands hidden from the palette (`menus.commandPalette` with `when: "false"`). */
    hiddenCommands: string[];
    settings: Record<string, PackageSetting>;
}

interface PackageJsonShape {
    contributes?: {
        commands?: PackageCommand[];
        menus?: { commandPalette?: { command: string; when?: string }[] };
        configuration?: { properties?: Record<string, PackageSetting> };
    };
}

export function readPackageContributions(packageJson: unknown): PackageContributions {
    const contributes = (packageJson as PackageJsonShape).contributes ?? {};
    const hidden = new Set((contributes.menus?.commandPalette ?? [])
        .filter(entry => entry.when === 'false')
        .map(entry => entry.command));
    return {
        commands: (contributes.commands ?? []).filter(command => !hidden.has(command.command)),
        hiddenCommands: [...hidden],
        settings: contributes.configuration?.properties ?? {},
    };
}

/** The catalog entry for the help skill — bundled, always installed, no dependencies. */
export function helpCatalogEntry(config: HelpSkillConfig): SkillCatalogEntry {
    return {
        name: HELP_SKILL_NAME,
        description: config.description,
        category: 'help',
        kind: 'skill',
        source: 'bundled',
        path: `skills/${HELP_SKILL_NAME}`,
        displayName: config.displayName,
        shortDescription: config.shortDescription,
        dependsOn: [],
        invocable: true,
    };
}

export function renderHelpOpenAiYaml(config: HelpSkillConfig): string {
    return [
        'interface:',
        `  display_name: "${config.displayName}"`,
        `  short_description: "${config.shortDescription}"`,
        `  default_prompt: "Use $${HELP_SKILL_NAME} to ${lowerFirst(config.shortDescription)}."`,
        '',
    ].join('\n');
}

/** The unit of the knowledge index that stands for a skill (`skill2ku.py` of the knowledge base). */
function procedureUnit(name: string): string {
    return `proc-${name}`;
}

/** The routing unit of a category (`routes2ku.py`): which procedure fits and in which order. */
function routeUnit(category: string): string {
    return `route-${category}`;
}

/**
 * The SKILL.md of cmsis-help in `mode`. The rules of `contract` come first,
 * below the title; its shell-to-tool table follows the MCP tool groups.
 */
export function renderHelpSkillMarkdown(
    catalog: SkillCatalog,
    contributions: PackageContributions,
    config: HelpSkillConfig,
    contract: ToolContract,
    mode: HelpSkillMode = 'skills',
): string {
    const knowledge = mode === 'knowledge';
    const byName = new Map(catalog.skills.map(entry => [entry.name, entry]));
    const routers = catalog.skills.filter(entry => entry.kind === 'router');
    const oneLiner = (entry: SkillCatalogEntry): string => cell(entry.shortDescription ?? firstSentence(entry.description));
    /** How a skill is named: its slash command or hand-over name, or its unit in the knowledge index. */
    const nameOf = (entry: SkillCatalogEntry): string => knowledge ? procedureUnit(entry.name) : `${entry.invocable ? '/' : '$'}${entry.name}`;

    // --- slash commands, or the units behind them: every invocable skill, the routers first ----
    const slashCommands = [
        ...routers,
        ...catalog.skills.filter(entry => entry.invocable && entry.kind !== 'router'),
    ];
    const commandRows = slashCommands
        .filter(entry => !(knowledge && entry.name === HELP_SKILL_NAME))
        .map(entry => {
            if (entry.kind === 'router') {
                return knowledge
                    ? `| \`${routeUnit(entry.category)}\` | ${oneLiner(entry)} — which of its ${entry.dependsOn.length} procedures (listed below) fits and in which order |`
                    : `| \`/${entry.name}\` | ${oneLiner(entry)} — one command for the whole category; its ${entry.dependsOn.length} member skills are listed below |`;
            }
            return `| \`${nameOf(entry)}\` | ${entry.name === HELP_SKILL_NAME ? 'This list.' : oneLiner(entry)} |`;
        });

    // --- member skills by category ------------------------------------------
    const memberSections: string[] = [];
    const sectioned: string[] = [];
    const memberLine = (name: string, member: SkillCatalogEntry | undefined): string =>
        `- \`${knowledge ? procedureUnit(name) : `$${name}`}\` — ${member ? oneLiner(member) : '(not in the catalog)'}`;
    for (const category of SKILL_CATEGORY_ORDER) {
        const router = routers.find(entry => entry.category === category);
        if (!router) {
            continue;
        }
        sectioned.push(category);
        memberSections.push(
            `### ${SKILL_CATEGORY_LABELS[category]} (\`${knowledge ? routeUnit(category) : `/${router.name}`}\`)`,
            '',
            ...router.dependsOn.map(name => memberLine(name, byName.get(name))),
            '',
        );
    }

    // Hidden skills that no entry point lists: reached by a `$name` hand-over from another skill.
    const listed = new Set(routers.flatMap(router => router.dependsOn));
    for (const category of SKILL_CATEGORY_ORDER) {
        const handedOver = catalog.skills.filter(entry => !entry.invocable && !listed.has(entry.name) && entry.category === category);
        if (handedOver.length === 0) {
            continue;
        }
        const callers = (name: string): string[] => catalog.skills
            .filter(entry => entry.dependsOn.includes(name))
            .map(entry => `\`${nameOf(entry)}\``);
        sectioned.push(category);
        memberSections.push(
            `### ${SKILL_CATEGORY_LABELS[category]} (${knowledge ? `\`${routeUnit(category)}\` where the index has it` : 'reached by hand-over'})`,
            '',
            ...handedOver.map(entry => {
                const from = callers(entry.name);
                return `${memberLine(entry.name, entry)}${from.length > 0 ? ` (from ${from.join(', ')})` : ''}`;
            }),
            '',
        );
    }

    // --- VS Code commands ----------------------------------------------------
    const visibleIds = new Set(contributions.commands.map(command => command.command));
    for (const id of Object.keys(config.commands)) {
        if (!visibleIds.has(id)) {
            throw new Error(`cmsis-help: help.commands names "${id}", which is not a palette command in package.json`);
        }
    }
    const commandLines = contributions.commands.map(command => {
        const summary = config.commands[command.command];
        if (!summary) {
            throw new Error(`cmsis-help: no one-liner for command "${command.command}" in scripts/skills.config.json (help.commands)`);
        }
        const title = command.category ? `${command.category}: ${command.title}` : command.title;
        return `- **${title}** (\`${command.command}\`) — ${summary}`;
    });

    // --- settings ------------------------------------------------------------
    const settingRows = Object.entries(config.settings).map(([id, summary]) => {
        const key = `${SETTINGS_PREFIX}.${id}`;
        const setting = contributions.settings[key];
        if (!setting) {
            throw new Error(`cmsis-help: help.settings names "${key}", which package.json does not contribute`);
        }
        return `| \`${key}\` | \`${JSON.stringify(setting.default)}\` | ${cell(summary)} |`;
    });

    // Every category a section below has: with a router, or reached by hand-over.
    const routeIds = sectioned.map(category => `\`${routeUnit(category)}\``);
    const howToUse = knowledge
        ? [
            '## How to use this list',
            '',
            `The setting \`${SETTINGS_PREFIX}.knowledge.replaceSkills\` is on: no CMSIS skill is installed`,
            'but this one, and the procedures behind the CMSIS tasks are units of the knowledge index,',
            'read with `knowledge_get`. Answer the user from the lists below: which procedures, VS Code',
            'commands, MCP tools and settings exist, and which one fits the task at hand. This skill does',
            'no work of its own and runs no tools — it points at the unit or tool that does. Name a',
            'procedure by its unit id; there is no `/` command behind it, so do not offer one, and do not',
            'tell the user to install a skill.',
            '',
            '## Working from the knowledge tools',
            '',
            'For every CMSIS task:',
            '',
            `1. Call \`knowledge_search\` with the task in a few words, or \`knowledge_get\` on ${listOf(routeIds)},`,
            '   which say which procedure fits and in which order, where the index has them.',
            '2. Read the procedure with `knowledge_get` and follow it. A file a procedure names by path is',
            '   listed by `knowledge_get` with its id.',
            '3. For an error message of csolution, packchk or svdconv, search with the exact text first.',
            '4. The documentation of the CMSIS components, tools and RTOSes comes the same way: the packs installed',
            '   on this machine carry it as knowledge indexes, searched together with the base index whatever the',
            '   target, and a hit says which pack it came from (`from Vendor::Pack@version`). Use `knowledge_search`',
            '   for a question about an API, a configuration or a tool option before the documentation tools or the web.',
            '',
            'Do not work a CMSIS task from memory.',
            '',
            '## Procedures',
            '',
            '| Unit | What it does |',
            '|---|---|',
            ...commandRows,
            '',
            `\`/${HELP_SKILL_NAME}\` is the one slash command in this mode; it shows this list.`,
            '',
            '## Procedures by category',
            '',
            'A routing unit names the procedures of its category and a typical order; each procedure',
            'is a unit of its own, read with `knowledge_get`.',
            '',
        ]
        : [
            '## How to use this list',
            '',
            'Answer the user from the lists below: which CMSIS slash commands, VS Code commands,',
            'MCP tools and settings exist, and which one fits the task at hand. This skill does no',
            'work of its own and runs no tools — it points at the skill or tool that does. Every',
            'skill below is installed into the user\'s personal skills directories by',
            '**CMSIS Developer Assistant: Configure Agent** and at each activation of the extension;',
            'a `/name` whose `../<name>/SKILL.md` is missing next to this file did not install — the',
            'extension\'s output channel says why, and running the command again repeats the install.',
            '',
            '## Slash commands',
            '',
            '| Command | What it does |',
            '|---|---|',
            ...commandRows,
            '',
            '## Member skills by category',
            '',
            'The members of an entry point are installed with `user-invocable: false`: they stay out',
            'of the `/` menu, and the model invokes them by description or through the entry point.',
            '',
        ];
    const commandsNote = knowledge
        ? [
            'Open the command palette (Ctrl/Cmd+Shift+P) and type the title. While',
            `\`${SETTINGS_PREFIX}.knowledge.replaceSkills\` is on, **Configure Agent** and each activation`,
            'install this skill alone and remove the other CMSIS skills the extension installed.',
        ]
        : ['Open the command palette (Ctrl/Cmd+Shift+P) and type the title.'];
    const debugFirst = knowledge
        ? `read \`${procedureUnit('cmsis-debug-live')}\` with \`knowledge_get\` first.`
        : 'invoke `/cmsis-debug-live` first.';

    return [
        '---',
        `name: ${HELP_SKILL_NAME}`,
        // Double-quoted so a ": " inside the prose cannot be read as a mapping.
        `description: ${JSON.stringify(knowledge ? config.knowledgeDescription : config.description)}`,
        '---',
        '',
        '# CMSIS Developer Assistant — what you can ask for',
        '',
        renderContractBlock(RULES_BLOCK, contract),
        '',
        ...howToUse,
        ...memberSections,
        '## VS Code commands',
        '',
        ...commandsNote,
        '',
        ...commandLines,
        '',
        '## MCP tools',
        '',
        'The CMSIS Developer Assistant MCP server (`http://localhost:3001/mcp`, registered with',
        'the agents the user selected in the setup) exposes these tool groups:',
        '',
        ...config.toolGroups.map(group => `- **${group.name}** — ${group.summary}`),
        '',
        'For the debugging workflow call `get_debug_instructions` (or read the',
        `\`${SETTINGS_PREFIX}://docs/debug_instructions\` resource); for a live target investigation`,
        `${debugFirst} The *Agent Tools* section of the extension\'s user`,
        'guide (`docs/user-guide.md` in the repository) lists every tool and parameter.',
        '',
        renderContractBlock(TABLE_BLOCK, contract),
        '',
        '## Settings',
        '',
        `VS Code settings under \`${SETTINGS_PREFIX}.*\` (Settings → Extensions → CMSIS Developer Assistant):`,
        '',
        '| Setting | Default | What it does |',
        '|---|---|---|',
        ...settingRows,
        '',
        '*Generated by `npm run skills:sync` from skills/catalog.json, package.json,',
        'scripts/skills.config.json and docs/agent-resources/tool-contract.md; edit those, not',
        'this file.*',
        '',
    ].join('\n');
}

/** "a, b or c" */
function listOf(items: readonly string[]): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function firstSentence(text: string): string {
    const match = /^(.*?[.!?])(?:\s|$)/.exec(text);
    return (match ? match[1] : text).trim();
}

/** One table cell: pipes escaped, whitespace collapsed. */
function cell(text: string): string {
    return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function lowerFirst(text: string): string {
    return text.charAt(0).toLowerCase() + text.slice(1);
}
