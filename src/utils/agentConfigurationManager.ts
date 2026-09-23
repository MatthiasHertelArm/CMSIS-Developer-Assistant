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
 * Onboarding of AI agents onto the CMSIS Developer Assistant.
 *
 * - Registers this extension's MCP server in the home-directory configuration
 *   files of eight agents (seven JSON files and Codex's TOML file), and
 *   migrates the entries earlier releases wrote there.
 * - Runs the two-step setup: which agents to register, then which AI Skills
 *   Pack skills to install, for this user or for one workspace folder.
 * - Applies the `installedSkills` and `aiSkills.enabled` settings to the skills
 *   directories, scope by scope, and shows the monthly "install the skills?"
 *   prompt.
 *
 * The files written here belong to other programs, so their locations, entry
 * shapes and layout are a contract. Every write is atomic (`atomicFile.ts`);
 * a JSON file that exists is re-read right before the write and everything
 * else in it is kept (`jsonFileRewrite.ts`). What to install and where comes
 * from the pure skill modules (`skillCatalog.ts`, `skillInstaller.ts`,
 * `skillPrompt.ts`).
 *
 * Loading this module calls no `vscode` API: the transport tests load it
 * under a minimal stub.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from './atomicFile';
import { rewriteJsonFile } from './jsonFileRewrite';
import { logger } from './logger';
import {
    AI_SKILLS_ENABLED_SETTING,
    AI_SKILLS_PROMPT_SETTING,
    DEFAULT_INSTALLED_SKILLS,
    INSTALLED_SKILLS_SETTING,
    SKILL_CATEGORY_LABELS,
    SkillCatalog,
    SkillCatalogEntry,
    bundledSkillNames,
    groupByCategory,
    hasPackSkillSelected,
    isBundledSkill,
    loadSkillCatalog,
    resolveDesiredSkills,
} from './skillCatalog';
import {
    SkillInstallRoots,
    SkillInstaller,
    SkillSyncReport,
    getProjectSkillInstallRoots,
    getSkillInstallRoots,
    summarizeSkillSync,
} from './skillInstaller';
import { SKILLS_PROMPT_SHOWN_KEY, SKILL_PROMPT_BUTTONS, decideSkillPrompt, skillPromptMessage } from './skillPrompt';

/** Name of this server's entry in every agent configuration. */
export const SERVER_KEY = 'cmsis-developer-assistant';

/** The name used before the 2.1.0 rename; entries under it are moved to `SERVER_KEY` on activation. */
export const LEGACY_SERVER_KEY = 'cmsis-debugmcp';

/** Fields every supported agent has. `name` is the same as `id`. */
export interface BaseAgentInfo { id: string; name: string; displayName: string; configPath: string; configFormat: 'json' | 'toml' }

/** An agent whose servers are an object under `mcpServerFieldName` of a JSON file. */
export interface JsonAgentInfo extends BaseAgentInfo { configFormat: 'json'; mcpServerFieldName: string }

/** Codex: one `[mcp_servers.<key>]` table per server in a TOML file. */
export interface TomlAgentInfo extends BaseAgentInfo { configFormat: 'toml' }

export type AgentInfo =
    | JsonAgentInfo
    | TomlAgentInfo;

/** Every field any of the JSON entry shapes uses; each agent gets a subset (see `ENTRY_SHAPES`). */
export interface MCPServerConfig {
    type?: string;
    url?: string;
    command?: string;
    args?: string[];
    autoApprove?: string[];
    disabled?: boolean;
    timeout?: number;
    tools?: string[];
}

// ---------------------------------------------------------------------------
// Settings, state and visible text
// ---------------------------------------------------------------------------

const SETTINGS_SECTION = 'cmsis-developer-assistant';

/** globalState: the first-run setup has been answered (accepted or dismissed). */
const SETUP_ANSWERED_KEY = 'cmsis-developer-assistant.popupShown.v3';

const PRODUCT = 'CMSIS Developer Assistant';
const SETUP_TITLE = `${PRODUCT} Setup`;
const AGENT_ITEM_NOTE = 'Write the MCP server entry into this agent\'s configuration';
const OPEN_FILE_BUTTON = 'View File';
const ENABLE_BUTTON = 'Enable and Select';
const PACK_DISABLED_NOTICE = `${PRODUCT}: the AI Skills Pack is disabled (setting cmsis-developer-assistant.aiSkills.enabled); only the extension's own skills are installed.`;

/** Longest skill detail line in the picker. */
const DETAIL_MAX = 140;

// ---------------------------------------------------------------------------
// The supported agents
// ---------------------------------------------------------------------------

/** `rel`, written with forward slashes, below `root`. */
function below(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'));
}

/**
 * Where per-user application data lives on this platform: `%APPDATA%`,
 * `~/Library/Application Support` or `$XDG_CONFIG_HOME`. An empty variable
 * counts as unset; an unknown platform is treated like Windows.
 */
function applicationDataDir(homeRoot: string): string {
    const system = os.platform();
    const known = system === 'darwin' || system === 'linux' || system === 'win32';
    if (!known) {
        logger.warn(`Unrecognised platform "${system}": agent configuration paths follow the Windows layout`);
    }
    const dataDir = system === 'darwin' ? below(homeRoot, 'Library/Application Support')
        : system === 'linux' ? process.env.XDG_CONFIG_HOME || below(homeRoot, '.config')
            : process.env.APPDATA || below(homeRoot, 'AppData/Roaming');
    logger.info(`Agent configuration base directory on ${system}: ${dataDir}`);
    return dataDir;
}

/**
 * Where releases before 2.5.1 wrote Cursor's entry. Cursor does not read this
 * file: it takes its user-level servers from `~/.cursor/mcp.json` on every
 * platform ("Create ~/.cursor/mcp.json in your home directory for tools
 * available everywhere", https://cursor.com/docs/context/mcp, checked
 * 2026-09-24). Activation moves an entry found here (`moveCursorEntry()`).
 */
function oldCursorConfigPath(homeRoot: string): string {
    return below(applicationDataDir(homeRoot), 'Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json');
}

/** The agents in picker order, with their configuration files as the environment says right now. */
function supportedAgents(): AgentInfo[] {
    const homeRoot = os.homedir();
    const appData = applicationDataDir(homeRoot);
    const vsCodeStorage = below(appData, 'Code/User/globalStorage');
    const viaJson = (id: string, displayName: string, configPath: string): JsonAgentInfo =>
        ({ id, name: id, displayName, configPath, configFormat: 'json', mcpServerFieldName: 'mcpServers' });
    const codex: TomlAgentInfo = {
        id: 'codex', name: 'codex', displayName: 'Codex', configFormat: 'toml',
        configPath: path.join(process.env.CODEX_HOME || below(homeRoot, '.codex'), 'config.toml'),
    };
    return [
        viaJson('roo', 'Roo Code', below(vsCodeStorage, 'rooveterinaryinc.roo-cline/settings/mcp_settings.json')),
        viaJson('antigravity', 'Antigravity', below(homeRoot, '.gemini/antigravity/mcp_config.json')),
        viaJson('cline', 'Cline', below(vsCodeStorage, 'saoudrizwan.claude-dev/settings/cline_mcp_settings.json')),
        viaJson('copilot-cli', 'GitHub Copilot CLI', path.join(process.env.COPILOT_HOME || below(homeRoot, '.copilot'), 'mcp-config.json')),
        viaJson('cursor', 'Cursor', below(homeRoot, '.cursor/mcp.json')),
        codex,
        viaJson('claude-code', 'Claude Code', path.join(homeRoot, '.claude.json')),
        viaJson('claude-desktop', 'Claude Desktop', below(appData, 'Claude/claude_desktop_config.json')),
    ];
}

/** The agents whose configuration file exists, in roster order. */
function agentsWithFiles(): AgentInfo[] {
    return supportedAgents().filter((candidate) => fs.existsSync(candidate.configPath));
}

/**
 * Entry shapes of the JSON agents that do not take the default one. The key
 * order is part of the bytes written.
 */
const ENTRY_SHAPES: Readonly<Record<string, (url: string) => MCPServerConfig>> = {
    'copilot-cli': (url) => ({ type: 'http', url, tools: ['*'] }),
    // Cursor documents a remote server as `url` (with optional `headers` and `auth`);
    // the fields of the default shape are not in its schema (https://cursor.com/docs/context/mcp).
    'cursor': (url) => ({ url }),
    'claude-code': (url) => ({ type: 'http', url }),
    // Claude Desktop starts stdio servers only; mcp-remote bridges to the HTTP endpoint.
    'claude-desktop': (url) => ({ command: 'npx', args: ['-y', 'mcp-remote', url] }),
};

/** The entry a JSON agent gets under `mcpServers.<SERVER_KEY>`: Roo Code, Antigravity and Cline share the default. */
function entryFor(agentId: string, url: string, timeout: number): MCPServerConfig {
    const shape = ENTRY_SHAPES[agentId];
    return shape ? shape(url) : { autoApprove: [], disabled: false, timeout, type: 'streamableHttp', url };
}

/**
 * Put `entry` under `<field>.<SERVER_KEY>`, replacing whatever was there; a
 * missing or null field becomes `{}` first. Any other non-object value is
 * not guarded: a string makes the assignment throw, an array loses the entry
 * when it is written back.
 */
function placeEntry(tree: Record<string, unknown>, field: string, entry: MCPServerConfig): boolean {
    if (tree[field] === null || tree[field] === undefined) {
        tree[field] = {};
    }
    (tree[field] as Record<string, unknown>)[SERVER_KEY] = entry;
    return true;
}

/** Antigravity and Gemini manage the MCP servers themselves; the setup and the prompt stay out of their way. */
function isHostManaged(): boolean {
    return process.env.ANTIGRAVITY_ENV === 'true' || Boolean(process.env.GEMINI_HOME);
}

/** Create the directory a file goes into, and its parents, when it is missing. */
async function ensureParentDir(file: string): Promise<void> {
    const parent = path.dirname(file);
    if (!fs.existsSync(parent)) {
        await fs.promises.mkdir(parent, { recursive: true });
    }
}

// ---------------------------------------------------------------------------
// Codex TOML (pure text operations; no TOML parser)
// ---------------------------------------------------------------------------

const LINE_BREAK = /\r?\n/;
const LF = '\n';
/** Any table or array-of-tables header, optionally indented and followed by a comment. */
const TABLE_HEADER = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
/** Our table exactly: no spaces inside the brackets, no quoted key. */
const SERVER_TABLE = /^\s*\[mcp_servers\.cmsis-developer-assistant\]\s*(?:#.*)?$/;
const LEGACY_TABLE = /^\s*\[mcp_servers\.cmsis-debugmcp\]\s*(?:#.*)?$/;
/** A `url` assignment; `urls =` and a commented-out line do not count. */
const URL_ASSIGNMENT = /^(\s*)url\s*=/;
/** A `url` assignment ending in `/sse`, optionally quoted and commented (a comment ending in `/sse` counts too). */
const SSE_URL_ASSIGNMENT = /^\s*url\s*=.*\/sse["']?\s*(?:#.*)?$/;

/** Index of the line that ends the table starting at `header`: the next header of any kind, or the end. */
function tableEnd(lines: readonly string[], header: number): number {
    const next = lines.findIndex((line, at) => at > header && TABLE_HEADER.test(line));
    return next < 0 ? lines.length : next;
}

/** A TOML basic string: only `\` and `"` are escaped. */
function tomlQuoted(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Point our Codex table at `serverUrl`, adding the table when it is missing.
 * The result has LF line breaks. Only the `url` line of our table is written;
 * every other line is kept as it was.
 */
export function upsertCodexDebugMCPConfig(toml: string, serverUrl: string): string {
    const urlLine = `url = ${tomlQuoted(serverUrl)}`;
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => SERVER_TABLE.test(line));
    if (header < 0) {
        const text = lines.join(LF);
        const gap = text.length === 0 ? '' : text.endsWith(LF) ? LF : LF + LF;
        return `${text}${gap}[mcp_servers.${SERVER_KEY}]${LF}${urlLine}${LF}`;
    }
    const end = tableEnd(lines, header);
    const urlAt = lines.findIndex((line, at) => at > header && at < end && URL_ASSIGNMENT.test(line));
    if (urlAt < 0) {
        lines.splice(header + 1, 0, urlLine);
    } else {
        // The indentation stays; a trailing comment on the old line does not.
        const indent = URL_ASSIGNMENT.exec(lines[urlAt])?.[1] ?? '';
        lines[urlAt] = indent + urlLine;
    }
    return lines.join(LF);
}

/**
 * Remove the first pre-rename table and its body. Without one the input
 * comes back untouched (line breaks included); with one the result has LF
 * line breaks. A legacy sub-table starts a table of its own and stays.
 */
export function stripLegacyCodexSection(toml: string): { content: string; removed: boolean } {
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => LEGACY_TABLE.test(line));
    if (header < 0) {
        return { content: toml, removed: false };
    }
    lines.splice(header, tableEnd(lines, header) - header);
    return { content: lines.join(LF), removed: true };
}

/** Our table's `url` still points at the retired SSE endpoint. */
function codexUrlIsSse(toml: string): boolean {
    const lines = toml.split(LINE_BREAK);
    const header = lines.findIndex((line) => SERVER_TABLE.test(line));
    return header >= 0 && lines.slice(header + 1, tableEnd(lines, header)).some((line) => SSE_URL_ASSIGNMENT.test(line));
}

/**
 * Whether an agent's configuration text registers this server under the
 * current key; the legacy key alone does not count. JSON is parsed
 * strictly, so comments or an empty file read as "no". Never throws.
 */
export function agentConfigHasServer(agent: AgentInfo, content: string): boolean {
    if (agent.configFormat !== 'json') {
        return content.split(LINE_BREAK).some((line) => SERVER_TABLE.test(line));
    }
    let tree: unknown;
    try {
        tree = JSON.parse(content);
    } catch {
        return false;
    }
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
        return false;
    }
    const servers = (tree as Record<string, unknown>)[agent.mcpServerFieldName];
    return servers !== null && typeof servers === 'object' && SERVER_KEY in servers;
}

// ---------------------------------------------------------------------------
// Migration of earlier entries
// ---------------------------------------------------------------------------

interface EntryMigration {
    /** Something in the object was changed. */
    changed: boolean;
    /** The change is one the user is told about; a pure endpoint refresh is not. */
    reported: boolean;
}

/**
 * Bring one servers object up to date, in place. The pre-rename key moves to
 * ours (an entry already under ours wins). An entry on the SSE transport, on
 * another transport than `wanted`, or at another endpoint is replaced by a
 * copy of `wanted` that keeps only its `autoApprove` list. Recomputed from the
 * parsed file on every attempt, so it has no effect outside `servers`.
 */
function migrateServers(servers: unknown, wanted: MCPServerConfig): EntryMigration {
    const table = servers as Record<string, unknown> | null | undefined;
    let renamed = false;
    if (table && table[LEGACY_SERVER_KEY]) {
        if (!table[SERVER_KEY]) {
            table[SERVER_KEY] = table[LEGACY_SERVER_KEY];
        }
        delete table[LEGACY_SERVER_KEY];
        renamed = true;
    }
    const present = (table ? table[SERVER_KEY] : undefined) as MCPServerConfig | undefined;
    if (!table || !present) {
        return { changed: renamed, reported: renamed };
    }
    const onSse = present.type === 'sse' || (typeof present.url === 'string' && present.url.endsWith('/sse'));
    const otherTransport = wanted.type !== undefined && present.type !== undefined && wanted.type !== present.type;
    const movedUrl = typeof present.url === 'string' && wanted.url !== undefined && present.url !== wanted.url;
    const movedArgs = Array.isArray(present.args) && wanted.args !== undefined
        && JSON.stringify(present.args) !== JSON.stringify(wanted.args);
    const replace = onSse || otherTransport || movedUrl || movedArgs;
    if (replace) {
        const fresh: MCPServerConfig = { ...wanted };
        if (Array.isArray(present.autoApprove)) {
            fresh.autoApprove = present.autoApprove;
        }
        table[SERVER_KEY] = fresh;
    }
    return { changed: replace || renamed, reported: onSse || otherTransport || renamed };
}

/** A JSON object, not an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Move the entry that releases before 2.5.1 wrote to Cursor's old, unread
 * location (`oldCursorConfigPath()`) to `cursor.configPath`, where Cursor
 * reads it: the user asked for Cursor to be set up then, so the file is
 * created when missing. An entry already there is kept. The old file loses
 * our keys; when nothing else is left in it, it is deleted together with the
 * `cursor.mcp/settings` directories that only this extension ever created.
 * True when the old file changed; one that cannot be parsed is left alone.
 */
async function moveCursorEntry(cursor: JsonAgentInfo, oldPath: string, entry: MCPServerConfig): Promise<boolean> {
    let tree: unknown;
    try {
        tree = JSON.parse(await fs.promises.readFile(oldPath, 'utf8'));
    } catch {
        return false;
    }
    const servers = isJsonObject(tree) ? tree.mcpServers : undefined;
    if (!isJsonObject(tree) || !isJsonObject(servers) || !(servers[SERVER_KEY] || servers[LEGACY_SERVER_KEY])) {
        return false;
    }
    const field = cursor.mcpServerFieldName;
    if (!fs.existsSync(cursor.configPath)) {
        await ensureParentDir(cursor.configPath);
        await writeFileAtomic(cursor.configPath, JSON.stringify({ [field]: { [SERVER_KEY]: entry } }, null, 2));
    } else {
        const added = await rewriteJsonFile(cursor.configPath, (config) => {
            const present = config[field];
            return isJsonObject(present) && present[SERVER_KEY] ? false : placeEntry(config, field, entry);
        });
        if (added === 'unparseable') {
            logger.warn(`Left the Cursor entry in ${oldPath}: ${cursor.configPath} is not a JSON object`);
            return false;
        }
    }
    delete servers[SERVER_KEY];
    delete servers[LEGACY_SERVER_KEY];
    const othersLeft = Object.keys(servers).length > 0 || Object.keys(tree).some((key) => key !== 'mcpServers');
    if (othersLeft) {
        await writeFileAtomic(oldPath, JSON.stringify(tree, null, 2));
    } else {
        await fs.promises.unlink(oldPath);
        // settings/, then cursor.mcp/; rmdir refuses a directory that is not empty.
        for (const dir of [path.dirname(oldPath), path.dirname(path.dirname(oldPath))]) {
            await fs.promises.rmdir(dir).catch(() => undefined);
        }
    }
    logger.info(`Moved the Cursor MCP server entry from ${oldPath}, which Cursor does not read, to ${cursor.configPath}`);
    return true;
}

/** Migrate one JSON agent file. True when it was written with a change worth reporting. */
async function migrateJsonAgent(agent: JsonAgentInfo, wanted: MCPServerConfig): Promise<boolean> {
    let reported = false;
    const outcome = await rewriteJsonFile(agent.configPath, (tree) => {
        const step = migrateServers(tree[agent.mcpServerFieldName], wanted);
        reported = step.reported;
        return step.changed;
    });
    return outcome === 'written' && reported;
}

/**
 * Migrate Codex's file: drop the pre-rename table and point ours at the
 * current endpoint when that table existed or ours still uses SSE. A
 * stale port on a non-SSE URL is left as it is. True when the file changed.
 */
async function migrateCodexAgent(agent: TomlAgentInfo, url: string): Promise<boolean> {
    const original = await fs.promises.readFile(agent.configPath, 'utf8');
    const stripped = stripLegacyCodexSection(original);
    const updated = stripped.removed || codexUrlIsSse(stripped.content)
        ? upsertCodexDebugMCPConfig(stripped.content, url)
        : stripped.content;
    if (updated === original) {
        return false;
    }
    await writeFileAtomic(agent.configPath, updated);
    return true;
}

// ---------------------------------------------------------------------------
// Skill scopes
// ---------------------------------------------------------------------------

/** Where a skill selection is stored and where its skills go: this user, or one local workspace folder. */
type SkillScope = { kind: 'user' } | { kind: 'folder'; folder: vscode.WorkspaceFolder };

const USER_SCOPE: SkillScope = { kind: 'user' };

/** The open workspace folders on the local file system; remote ones get no skills. */
function localFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

function scopesInOrder(): SkillScope[] {
    return [USER_SCOPE, ...localFolders().map((folder): SkillScope => ({ kind: 'folder', folder }))];
}

function scopeName(scope: SkillScope): string {
    return scope.kind === 'user' ? 'this user' : `the "${scope.folder.name}" workspace folder`;
}

function installRootsOf(scope: SkillScope): SkillInstallRoots {
    return scope.kind === 'user' ? getSkillInstallRoots() : getProjectSkillInstallRoots(scope.folder.uri.fsPath);
}

function skillNames(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * The scope's `installedSkills` picks. The user scope always has a value
 * (`[]` when unset); a folder has none unless the folder or the workspace
 * sets one.
 */
function readSelection(scope: SkillScope): string[] | undefined {
    if (scope.kind === 'user') {
        const seen = vscode.workspace.getConfiguration(SETTINGS_SECTION).inspect<unknown>(INSTALLED_SKILLS_SETTING);
        return skillNames(seen?.globalValue ?? [...DEFAULT_INSTALLED_SKILLS]);
    }
    const seen = vscode.workspace.getConfiguration(SETTINGS_SECTION, scope.folder.uri).inspect<unknown>(INSTALLED_SKILLS_SETTING);
    const stored = seen?.workspaceFolderValue ?? seen?.workspaceValue;
    return stored === undefined ? undefined : skillNames(stored);
}

/** Store the picks where the scope reads them: user settings, or the folder's (a `.code-workspace` file makes that the folder level). */
async function writeSelection(scope: SkillScope, names: string[]): Promise<void> {
    if (scope.kind === 'user') {
        await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(INSTALLED_SKILLS_SETTING, names, vscode.ConfigurationTarget.Global);
        return;
    }
    const level = vscode.workspace.workspaceFile !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
    await vscode.workspace.getConfiguration(SETTINGS_SECTION, scope.folder.uri).update(INSTALLED_SKILLS_SETTING, names, level);
}

/** A directory for display, with the home directory as `~` (a plain prefix test). */
function shortenHome(dir: string): string {
    const homePrefix = os.homedir();
    return dir.startsWith(homePrefix) ? `~${dir.slice(homePrefix.length)}` : dir;
}

/** One picker detail line: whitespace runs collapsed, cut at 140 characters with a `…`. */
function detailLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}…` : flat;
}

/** How many pack skills a scope has picked, for the scope picker. */
function selectionState(catalog: SkillCatalog, picks: string[] | undefined): string {
    if (picks === undefined) {
        return 'no selection yet';
    }
    const count = resolveDesiredSkills(catalog, picks, { includeBundled: false }).explicit.length;
    return count === 1 ? '1 pack skill selected' : `${count} pack skills selected`;
}

interface ScopePickItem extends vscode.QuickPickItem {
    scope: SkillScope;
}

interface SkillPickItem extends vscode.QuickPickItem {
    /** Absent on the category separators. */
    entry?: SkillCatalogEntry;
}

function skillPickItem(entry: SkillCatalogEntry, known: ReadonlySet<string>, picked: boolean): SkillPickItem {
    const members = entry.dependsOn.filter((name) => known.has(name));
    const title = entry.displayName || entry.name;
    const summary = detailLine(entry.shortDescription || entry.description);
    if (entry.kind === 'router') {
        return {
            label: `$(list-tree) ${title}`,
            description: `/${entry.name} — one command for the whole category, ${members.length} member skills installed hidden`,
            detail: summary,
            picked,
            entry,
        };
    }
    return {
        label: title,
        description: `/${entry.name}`,
        detail: members.length > 0 ? `${summary}  ·  also installs (hidden): ${members.join(', ')}` : summary,
        picked,
        entry,
    };
}

/** The pack skills offered to a scope, grouped under their category headings; the extension's own skills are not offered. */
function skillPickItems(catalog: SkillCatalog, preselected: ReadonlySet<string>): SkillPickItem[] {
    const known = new Set(catalog.skills.map((entry) => entry.name));
    const items: SkillPickItem[] = [];
    for (const [category, entries] of groupByCategory(catalog)) {
        const offered = entries.filter((entry) => !isBundledSkill(entry));
        if (offered.length === 0) {
            continue;
        }
        items.push({ label: SKILL_CATEGORY_LABELS[category], kind: vscode.QuickPickItemKind.Separator });
        for (const entry of offered) {
            items.push(skillPickItem(entry, known, preselected.has(entry.name)));
        }
    }
    return items;
}

function emptyReport(): SkillSyncReport {
    return { installed: [], removed: [], skippedForeign: [], failed: [] };
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class AgentConfigurationManager {
    private mcpPort: number;
    private readonly installer: SkillInstaller;
    /** `undefined` until first needed; `null` once loading failed, which is not retried. */
    private catalogCache: SkillCatalog | null | undefined;
    /** End of the `syncSkills` queue. It never rejects, so one failed run does not block the next. */
    private syncQueue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly ctx: vscode.ExtensionContext,
        private readonly entryTimeoutSeconds: number,
        serverPort: number,
    ) {
        this.mcpPort = serverPort;
        const manifest = ctx.extension?.packageJSON as { version?: string } | undefined;
        this.installer = new SkillInstaller(ctx.extensionPath, manifest?.version ?? 'unknown');
    }

    /** Use another server port for every later write. Nothing is rewritten now. */
    updatePort(nextPort: number): void {
        this.mcpPort = nextPort;
    }

    /** The first-run setup is due: not answered yet, and not in an environment that manages MCP servers itself. */
    shouldShowPopup(): Promise<boolean> {
        const due = !isHostManaged() && this.ctx.globalState.get<boolean>(SETUP_ANSWERED_KEY) !== true;
        return Promise.resolve(due);
    }

    /**
     * The first-run setup: the agent picker, then the skill picker when the AI
     * Skills Pack is enabled (after step 1 was accepted or dismissed alike).
     * Counts as answered afterwards, whatever happened.
     */
    runSetupFlow(): Promise<void> {
        return this.walkThroughSetup();
    }

    /** Make the first-run setup due again and forget when the skills prompt was last shown. */
    async resetPopupState(): Promise<void> {
        await this.ctx.globalState.update(SETUP_ANSWERED_KEY, false);
        await this.ctx.globalState.update(SKILLS_PROMPT_SHOWN_KEY, undefined);
    }

    /**
     * Update the entries of agents whose configuration file exists: rename
     * the pre-rename key, move SSE and wrong-transport entries to the current
     * shape, refresh a stale endpoint. No file is created, except Cursor's
     * when an entry is moved there from the location earlier releases used.
     * One agent failing does not stop the others.
     */
    migrateExistingConfigurations(): Promise<void> {
        return this.migrateAgentFiles();
    }

    /**
     * Install and remove skills so that every scope matches its selection:
     * this user first, then each local workspace folder. Runs one at a time,
     * in call order; resolves `null` when the catalog cannot be loaded.
     */
    syncSkills(reason: string): Promise<SkillSyncReport | null> {
        const run = this.syncQueue.then(() => this.syncAllScopes(reason));
        this.syncQueue = run.catch(() => undefined);
        return run;
    }

    /**
     * The skill picker: where to install (when a local folder is open), then
     * which pack skills. Accepting stores the selection in that scope's setting
     * and syncs. Resolves `false` when the user backs out.
     */
    async showSkillSelectionDialog(): Promise<boolean> {
        const catalog = this.catalog();
        if (!catalog) {
            void vscode.window.showErrorMessage(`${PRODUCT}: the bundled skill catalog could not be loaded.`);
            return false;
        }
        if (!this.packEnabled()) {
            const answer = await vscode.window.showInformationMessage(PACK_DISABLED_NOTICE, ENABLE_BUTTON);
            if (answer !== ENABLE_BUTTON) {
                return false;
            }
            await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(AI_SKILLS_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
        }
        const scope = await this.chooseScope(catalog);
        if (!scope) {
            return false;
        }
        const names = await this.chooseSkills(catalog, scope);
        if (!names) {
            return false;
        }
        await this.applySelection(catalog, scope, names);
        return true;
    }

    /**
     * The monthly "install the skills?" prompt, shown only when an agent has
     * this server registered and no pack skill is selected anywhere
     * (`decideSkillPrompt` has the full rule). The time is stored before the
     * prompt appears, so a dismissed prompt counts as shown.
     */
    async maybePromptForSkills(now: number = Date.now()): Promise<void> {
        const catalog = this.catalog();
        if (!catalog) {
            return;
        }
        const registeredWith: string[] = [];
        for (const agent of agentsWithFiles()) {
            try {
                if (agentConfigHasServer(agent, await fs.promises.readFile(agent.configPath, 'utf8'))) {
                    registeredWith.push(agent.displayName);
                }
            } catch (failure) {
                logger.warn(`Could not read ${agent.configPath} to look for the MCP server`, failure);
            }
        }
        const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION);
        const allPicks = scopesInOrder().flatMap((scope) => readSelection(scope) ?? []);
        const decision = decideSkillPrompt({
            promptEnabled: settings.get<boolean>(AI_SKILLS_PROMPT_SETTING, true),
            packEnabled: settings.get<boolean>(AI_SKILLS_ENABLED_SETTING, true),
            firstRunPending: this.ctx.globalState.get<boolean>(SETUP_ANSWERED_KEY) !== true,
            hostManaged: isHostManaged(),
            agentsWithServer: registeredWith,
            packSkillSelected: hasPackSkillSelected(catalog, allPicks),
            lastShownAt: this.ctx.globalState.get<number>(SKILLS_PROMPT_SHOWN_KEY),
            now,
        });
        if (!decision.show) {
            logger.info(`Skills prompt not shown: ${decision.reason}`);
            return;
        }
        await this.ctx.globalState.update(SKILLS_PROMPT_SHOWN_KEY, now);
        const { select, later, never } = SKILL_PROMPT_BUTTONS;
        const reply = await vscode.window.showInformationMessage(skillPromptMessage(registeredWith), select, later, never);
        if (reply === select) {
            await this.showSkillSelectionDialog();
        } else if (reply === never) {
            await settings.update(AI_SKILLS_PROMPT_SETTING, false, vscode.ConfigurationTarget.Global);
        }
    }

    // --- setup and agents --------------------------------------------------

    private endpointUrl(): string {
        return `http://localhost:${this.mcpPort}/mcp`;
    }

    private packEnabled(): boolean {
        return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>(AI_SKILLS_ENABLED_SETTING, true);
    }

    private async walkThroughSetup(): Promise<void> {
        try {
            const roster = supportedAgents();
            const skillsStepFollows = this.packEnabled();
            await this.pickAndConfigureAgents(roster, skillsStepFollows ? ' (1/2)' : '');
            if (skillsStepFollows) {
                await this.showSkillSelectionDialog();
            } else {
                logger.info('AI Skills Pack disabled: the setup skips the skills step');
            }
        } catch (failure) {
            logger.error('The setup flow failed', failure);
            void vscode.window.showErrorMessage(`Failed to show the ${PRODUCT} setup: ${String(failure)}`);
        } finally {
            await this.ctx.globalState.update(SETUP_ANSWERED_KEY, true);
        }
    }

    /**
     * Step 1: the agent picker. Accepting configures the chosen agents one
     * after the other and resolves `true` once all are done; closing it
     * resolves `false`.
     */
    private pickAndConfigureAgents(roster: AgentInfo[], stepMark: string): Promise<boolean> {
        return new Promise<boolean>((settle, fail) => {
            const agentList = vscode.window.createQuickPick<vscode.QuickPickItem>();
            agentList.title = `${SETUP_TITLE}${stepMark} - Connect AI Agents to the MCP Server`;
            agentList.placeholder = `Select the AI agents to register the ${PRODUCT} MCP server with (Esc to skip)`;
            agentList.canSelectMany = true;
            agentList.ignoreFocusOut = true;
            // The detail is the display name; it maps a chosen item back to its agent.
            agentList.items = roster.map(({ displayName }) =>
                ({ label: `$(add) Set up ${displayName}`, description: AGENT_ITEM_NOTE, detail: displayName, picked: false }));
            let accepted = false;
            agentList.onDidAccept(() => {
                accepted = true;
                const chosenNames = agentList.selectedItems.map((item) => item.detail);
                const chosen = chosenNames.flatMap((name) => roster.filter((agent) => agent.displayName === name));
                agentList.hide();
                this.configureAgents(chosen).then(() => settle(true), fail);
            });
            agentList.onDidHide(() => {
                agentList.dispose();
                if (!accepted) {
                    settle(false);
                }
            });
            agentList.show();
        });
    }

    /** Configure agents in turn; each success toast is answered before the next agent starts. */
    private async configureAgents(queue: AgentInfo[]): Promise<void> {
        for (const agent of queue) {
            try {
                if (!(await this.registerServer(agent))) {
                    continue;
                }
                const configured = `✅ Registered the ${PRODUCT} MCP server with ${agent.displayName}.`;
                if (await vscode.window.showInformationMessage(configured, OPEN_FILE_BUTTON) === OPEN_FILE_BUTTON) {
                    const written = vscode.Uri.file(agent.configPath);
                    await vscode.commands.executeCommand('vscode.open', written);
                }
            } catch (failure) {
                logger.error(`Setting up ${agent.displayName} failed`, failure);
                void vscode.window.showErrorMessage(`Could not set up ${agent.displayName}: ${String(failure)}`);
            }
        }
    }

    /**
     * Write this server's entry into one agent's file, creating the file and
     * its directory when needed. An existing entry is replaced whole. False
     * when it did not work out; the user has been told why.
     */
    private async registerServer(agent: AgentInfo): Promise<boolean> {
        const file = agent.configPath;
        const url = this.endpointUrl();
        try {
            await ensureParentDir(file);
            const fileExists = fs.existsSync(file);
            if (agent.configFormat !== 'json') {
                const toml = fileExists ? await fs.promises.readFile(file, 'utf8') : '';
                await writeFileAtomic(file, upsertCodexDebugMCPConfig(toml, url));
            } else {
                const field = agent.mcpServerFieldName;
                const entry = entryFor(agent.id, url, this.entryTimeoutSeconds);
                if (!fileExists) {
                    // Nothing to keep: 2-space JSON without a final newline, like the rewrite below.
                    await writeFileAtomic(file, JSON.stringify({ [field]: { [SERVER_KEY]: entry } }, null, 2));
                } else if (await rewriteJsonFile(file, (tree) => placeEntry(tree, field, entry)) === 'unparseable') {
                    logger.warn(`Left ${file} alone: it is not a JSON object`);
                    void vscode.window.showErrorMessage(
                        `Cannot configure ${agent.displayName}: ${file} exists but is not valid JSON. Please fix or remove the file and try again.`);
                    return false;
                }
            }
            logger.info(`Registered the MCP server with ${agent.displayName} in ${file}`);
            return true;
        } catch (failure) {
            logger.error(`Could not register the MCP server with ${agent.displayName}`, failure);
            void vscode.window.showErrorMessage(`The ${PRODUCT} MCP server could not be added to ${agent.displayName}: ${String(failure)}`);
            return false;
        }
    }

    private async migrateAgentFiles(): Promise<void> {
        const url = this.endpointUrl();
        let reported = 0;
        const cursor = supportedAgents().find((agent): agent is JsonAgentInfo => agent.id === 'cursor' && agent.configFormat === 'json');
        if (cursor) {
            const oldPath = oldCursorConfigPath(os.homedir());
            try {
                if (await moveCursorEntry(cursor, oldPath, entryFor(cursor.id, url, this.entryTimeoutSeconds))) {
                    reported++;
                }
            } catch (failure) {
                logger.warn(`Could not move the Cursor entry from ${oldPath} to ${cursor.configPath}`, failure);
            }
        }
        for (const agent of agentsWithFiles()) {
            try {
                const counted = agent.configFormat === 'json'
                    ? await migrateJsonAgent(agent, entryFor(agent.id, url, this.entryTimeoutSeconds))
                    : await migrateCodexAgent(agent, url);
                if (counted) {
                    reported++;
                    logger.info(`Migrated the ${agent.displayName} configuration at ${agent.configPath}`);
                }
            } catch (failure) {
                logger.warn(`Could not migrate the ${agent.displayName} configuration at ${agent.configPath}`, failure);
            }
        }
        if (reported > 0) {
            void vscode.window.showInformationMessage(`${PRODUCT}: brought the MCP server entry up to date in ${reported} agent configuration(s).`);
        }
    }

    // --- skills ------------------------------------------------------------

    /** The shipped skill catalog, loaded on first use. */
    private catalog(): SkillCatalog | null {
        if (this.catalogCache === undefined) {
            try {
                this.catalogCache = loadSkillCatalog(this.ctx.extensionPath);
            } catch (failure) {
                logger.error('Could not load the bundled skill catalog', failure);
                this.catalogCache = null;
            }
        }
        return this.catalogCache;
    }

    /** One `syncSkills` run over every scope; the reports are concatenated in scope order. */
    private async syncAllScopes(reason: string): Promise<SkillSyncReport | null> {
        const catalog = this.catalog();
        if (!catalog) {
            return null;
        }
        const packEnabled = this.packEnabled();
        const total = emptyReport();
        for (const scope of scopesInOrder()) {
            const picks = readSelection(scope);
            const wanted = resolveDesiredSkills(catalog, picks ?? [], { packEnabled, includeBundled: scope.kind === 'user' });
            if (wanted.unknown.length > 0) {
                logger.warn(`Skills unknown to this version, ignored for ${scopeName(scope)}: ${wanted.unknown.join(', ')}`);
            }
            if (wanted.suppressed.length > 0) {
                logger.info(`AI Skills Pack disabled; kept in the setting but not installed for ${scopeName(scope)}: ${wanted.suppressed.join(', ')}`);
            }
            const report = await this.installer.sync(installRootsOf(scope), catalog, wanted.explicit, wanted.implied);
            if (picks !== undefined || report.removed.length > 0 || report.failed.length > 0) {
                logger.info(`Skill sync (${reason}) for ${scopeName(scope)}, pack ${packEnabled ? 'enabled' : 'disabled'}: `
                    + `${summarizeSkillSync(report)}; visible [${wanted.explicit.join(', ')}], hidden [${wanted.implied.join(', ')}]`);
                for (const failed of report.failed) {
                    logger.warn(`Skill ${failed.name ?? '(root)'} in ${failed.root} failed: ${failed.error}`);
                }
                for (const foreign of report.skippedForeign) {
                    logger.warn(`Left ${foreign.name} in ${foreign.root} untouched: it was not installed by this extension`);
                }
            }
            total.installed.push(...report.installed);
            total.removed.push(...report.removed);
            total.skippedForeign.push(...report.skippedForeign);
            total.failed.push(...report.failed);
        }
        return total;
    }

    /** Where to install: asked only when a local workspace folder is open, the folders first. */
    private async chooseScope(catalog: SkillCatalog): Promise<SkillScope | undefined> {
        const folders = localFolders();
        const several = folders.length > 1;
        const scopeItems: ScopePickItem[] = folders.map((folder) => {
            const scope: SkillScope = { kind: 'folder', folder };
            const roots = getProjectSkillInstallRoots(folder.uri.fsPath).install
                .map((root) => `${folder.name}/${path.relative(folder.uri.fsPath, root).split(path.sep).join('/')}`);
            return {
                label: several ? `$(root-folder) This workspace only — ${folder.name}` : '$(root-folder) This workspace only',
                description: roots.join(', '),
                detail: `Recommended: the agent loads them only in this project, so other projects' context stays lean — ${selectionState(catalog, readSelection(scope))}`,
                scope,
            };
        });
        if (scopeItems.length === 0) {
            return USER_SCOPE;
        }
        scopeItems.push({
            label: '$(account) This user',
            description: getSkillInstallRoots().install.map((root) => shortenHome(root)).join(', '),
            detail: `Every workspace on this machine — every agent session carries them — ${selectionState(catalog, readSelection(USER_SCOPE))}`,
            scope: USER_SCOPE,
        });
        const where = await vscode.window.showQuickPick(scopeItems, {
            title: `${SETUP_TITLE} (2/2) - Where to Install Agent Skills`,
            placeHolder: 'Install the AI Skills Pack skills into this workspace only (default) or for this user, in every workspace',
            ignoreFocusOut: true,
        });
        return where?.scope;
    }

    /** Which pack skills: the scope's current picks are preselected. Resolves the chosen names, or `undefined` when closed. */
    private chooseSkills(catalog: SkillCatalog, scope: SkillScope): Promise<string[] | undefined> {
        const preselected = new Set(resolveDesiredSkills(catalog, readSelection(scope) ?? [], { includeBundled: false }).explicit);
        const items = skillPickItems(catalog, preselected);
        return new Promise<string[] | undefined>((settle) => {
            const skillList = vscode.window.createQuickPick<SkillPickItem>();
            skillList.title = `${SETUP_TITLE} (2/2) - Choose Agent Skills to Install for ${scopeName(scope)}`;
            skillList.placeholder = scope.kind === 'user'
                ? `Select the AI Skills Pack skills to install into your personal skills directories (always installed: ${bundledSkillNames(catalog).join(', ')}; Esc keeps the current selection)`
                : `Select the AI Skills Pack skills to install into ${scope.folder.name}/.agents/skills (the extension's own skills stay in your personal directories; Esc keeps the current selection)`;
            skillList.canSelectMany = true;
            skillList.ignoreFocusOut = true;
            skillList.matchOnDescription = true;
            skillList.matchOnDetail = true;
            skillList.items = items;
            skillList.selectedItems = items.filter((item) => item.picked);
            let accepted = false;
            skillList.onDidAccept(() => {
                accepted = true;
                const names = skillList.selectedItems.flatMap((item) => (item.entry ? [item.entry.name] : []));
                skillList.hide();
                settle(names);
            });
            skillList.onDidHide(() => {
                skillList.dispose();
                if (!accepted) {
                    settle(undefined);
                }
            });
            skillList.show();
        });
    }

    /** Store the picks, sync, and report what happened in the chosen scope. */
    private async applySelection(catalog: SkillCatalog, scope: SkillScope, names: string[]): Promise<void> {
        try {
            await writeSelection(scope, names);
            const report = await this.syncSkills('selection');
            const wanted = resolveDesiredSkills(catalog, names, { includeBundled: scope.kind === 'user' });
            if (report) {
                void vscode.window.showInformationMessage(this.selectionSummary(scope, wanted.explicit.length, wanted.implied.length, report));
            }
        } catch (failure) {
            logger.error('Could not save the skill selection', failure);
            void vscode.window.showErrorMessage(`Failed to save the skill selection: ${String(failure)}`);
        }
    }

    /** The result toast; only records under the scope's own install directories count. */
    private selectionSummary(scope: SkillScope, visible: number, hidden: number, report: SkillSyncReport): string {
        const ownRoots = new Set(installRootsOf(scope).install);
        const mine = <T extends { root: string }>(records: T[]): T[] => records.filter((record) => ownRoots.has(record.root));
        const into = [...new Set(mine(report.installed).map((record) => shortenHome(record.root)))];
        const failed = mine(report.failed).length;
        let text = `${PRODUCT}: ${visible} skill(s)`;
        if (hidden > 0) {
            text += ` (+${hidden} required, hidden)`;
        }
        text += ` installed for ${scopeName(scope)}`;
        if (into.length > 0) {
            text += ` into ${into.join(', ')}`;
        }
        text += `; ${mine(report.removed).length} removed.`;
        if (failed > 0) {
            text += ` ${failed} failed — see the output log.`;
        }
        return text;
    }
}
