# Spec: src/utils/agentConfigurationManager.ts

Onboards AI agents onto the CMSIS Developer Assistant. The module does five things:

- Registers the MCP server entry in the home-directory configuration files of eight agents.
- Migrates entries that earlier versions wrote there.
- Runs the two-step setup flow: agents, then skills.
- Applies the `installedSkills` / `aiSkills.enabled` settings to the skills directories, per scope.
- Shows the monthly "install the skills?" nudge.

It owns no file format of its own. It writes other programs' configuration files, so the paths, the entry shapes, the merge rules and the write discipline below are contract. The skill logic is delegated to Arm-authored pure modules (`skillCatalog.ts`, `skillInstaller.ts`, `skillPrompt.ts`). File safety is delegated to `atomicFile.ts` and `jsonFileRewrite.ts`. Background: `docs/architecture/agentConfigurationManager.md`.

## External contract

Keep every export with exactly these names and types. Additional pure helpers may be exported for tests; nothing may be removed.

```ts
export interface BaseAgentInfo { id: string; name: string; displayName: string; configPath: string; configFormat: 'json' | 'toml'; }
export interface JsonAgentInfo extends BaseAgentInfo { configFormat: 'json'; mcpServerFieldName: string; }
export interface TomlAgentInfo extends BaseAgentInfo { configFormat: 'toml'; }
export type AgentInfo = JsonAgentInfo | TomlAgentInfo;
export interface MCPServerConfig {
    type?: string; url?: string; command?: string; args?: string[];
    autoApprove?: string[]; disabled?: boolean; timeout?: number; tools?: string[];
}
export const SERVER_KEY = 'cmsis-developer-assistant';
export const LEGACY_SERVER_KEY = 'cmsis-debugmcp';
export function upsertCodexDebugMCPConfig(configContent: string, mcpServerUrl: string): string;
export function stripLegacyCodexSection(configContent: string): { content: string; removed: boolean };
export function agentConfigHasServer(agent: AgentInfo, content: string): boolean;
export class AgentConfigurationManager {
    constructor(context: vscode.ExtensionContext, timeoutInSeconds: number, serverPort: number);
    updatePort(port: number): void;
    shouldShowPopup(): Promise<boolean>;
    runSetupFlow(): Promise<void>;
    resetPopupState(): Promise<void>;
    migrateExistingConfigurations(): Promise<void>;
    syncSkills(reason: string): Promise<SkillSyncReport | null>;   // SkillSyncReport from ./skillInstaller
    showSkillSelectionDialog(): Promise<boolean>;
    maybePromptForSkills(now?: number): Promise<void>;             // now defaults to Date.now()
}
```

| Export | Used by |
|---|---|
| `AgentConfigurationManager` | `src/extension.ts`: constructs it once per activation and calls every public method (see `extension.md`); `src/index.ts` re-exports it |
| `AgentInfo`, `MCPServerConfig` | `src/index.ts` re-exports them as types; `src/test/skillPrompt.test.ts` builds `AgentInfo` literals |
| `agentConfigHasServer` | `src/test/skillPrompt.test.ts` (pinned cases) |
| `SERVER_KEY`, `LEGACY_SERVER_KEY`, `upsertCodexDebugMCPConfig`, `stripLegacyCodexSection` | internal today; exported for tests (codebase review 4.1) |

Loading the module must not call `vscode`. `test/transport/*.js` loads `out/src/index.js`, which imports it under a minimal stub.

Collaborators to use unchanged:

- `writeFileAtomic` (`src/utils/atomicFile.ts`)
- `rewriteJsonFile` and its outcomes `'written' | 'unchanged' | 'unparseable'` (`src/utils/jsonFileRewrite.ts`)
- From `src/utils/skillCatalog.ts`: `loadSkillCatalog`, `resolveDesiredSkills`, `groupByCategory`, `isBundledSkill`, `bundledSkillNames`, `hasPackSkillSelected`, `SKILL_CATEGORY_LABELS`, `INSTALLED_SKILLS_SETTING`, `AI_SKILLS_ENABLED_SETTING`, `AI_SKILLS_PROMPT_SETTING`, `DEFAULT_INSTALLED_SKILLS`
- From `src/utils/skillInstaller.ts`: `SkillInstaller`, `getSkillInstallRoots`, `getProjectSkillInstallRoots`, `summarizeSkillSync`
- From `src/utils/skillPrompt.ts`: `decideSkillPrompt`, `skillPromptMessage`, `SKILL_PROMPT_BUTTONS`, `SKILLS_PROMPT_SHOWN_KEY`

## Behaviour

### Constants and state

- **Settings section** `cmsis-developer-assistant`, with these keys:
  - `installedSkills` (string array, resource scope)
  - `aiSkills.enabled` (default `true` when read)
  - `aiSkills.promptOnDetect` (default `true` when read)
- **globalState keys:**
  - `cmsis-developer-assistant.popupShown.v3` (boolean): the first-run setup has been answered.
  - `cmsis-developer-assistant.skillsPrompt.lastShownAt` (`SKILLS_PROMPT_SHOWN_KEY`, epoch ms): the last nudge.
- **MCP URL:** `http://localhost:<port>/mcp`. `<port>` starts as the constructor's `serverPort`; `updatePort(port)` replaces it for every later write, and nothing else happens.
- **Host-managed environment:** `process.env.ANTIGRAVITY_ENV === 'true'`, or `GEMINI_HOME` set to a non-empty value.
- **Picker detail length:** 140 characters. Truncation first collapses every whitespace run to one space and trims. Text longer than 140 characters is cut to its first 139, trailing whitespace is removed, and `…` is appended.
- **Home shortening:** a directory whose string starts with `os.homedir()` is shown as `~` plus the rest. This is a plain prefix test with no separator check.
- **Skill installer:** constructed once, with `context.extensionPath` and the extension version from `context.extension.packageJSON.version` (`'unknown'` if absent).

### Supported agents

The roster is rebuilt on every use, reading the environment at that moment, in this order. For every agent `name` equals `id`, and every JSON agent's `mcpServerFieldName` is `mcpServers`.

| `id` | `displayName` | Format | `configPath` |
|---|---|---|---|
| `roo` | `Roo Code` | json | `<base>/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` |
| `antigravity` | `Antigravity` | json | `~/.gemini/antigravity/mcp_config.json` |
| `cline` | `Cline` | json | `<base>/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| `copilot-cli` | `GitHub Copilot CLI` | json | `$COPILOT_HOME/mcp-config.json`, or `~/.copilot/mcp-config.json` when unset or empty |
| `cursor` | `Cursor` | json | `<base>/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json` |
| `codex` | `Codex` | toml | `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when unset or empty |
| `claude-code` | `Claude Code` | json | `~/.claude.json` (no environment override) |
| `claude-desktop` | `Claude Desktop` | json | `<base>/Claude/claude_desktop_config.json` |

`~` is `os.homedir()`. `<base>` comes from `os.platform()`:

- `win32`: `%APPDATA%`, else `~/AppData/Roaming`.
- `darwin`: `~/Library/Application Support`.
- `linux`: `$XDG_CONFIG_HOME`, else `~/.config`.
- Any other platform: as `win32`, with a warning logged.

Empty environment values count as unset. Paths are joined with `path.join`.

### Server entry per agent

`<url>` is the MCP URL and `<t>` the constructor's `timeoutInSeconds`. Key order is part of the written bytes.

| Agents | Entry under `mcpServers.cmsis-developer-assistant` |
|---|---|
| `copilot-cli` | `{ "type": "http", "url": <url>, "tools": ["*"] }` |
| `claude-code` | `{ "type": "http", "url": <url> }` |
| `claude-desktop` | `{ "command": "npx", "args": ["-y", "mcp-remote", <url>] }` |
| `roo`, `antigravity`, `cline`, `cursor` | `{ "autoApprove": [], "disabled": false, "timeout": <t>, "type": "streamableHttp", "url": <url> }` |

Codex gets a TOML table with the single key `url` (next section).

### Codex TOML helpers (pure)

- **TOML table header:** a line that, after optional leading whitespace, opens with `[` or `[[`, has at least one character other than `]`, closes with `]` or `]]`, and is followed only by optional whitespace and an optional `#` comment. Sub-tables and arrays of tables count.
- **Our header:** optional leading whitespace, then exactly `[mcp_servers.cmsis-developer-assistant]`, with no inner spaces and no quotes, then optional whitespace and an optional `#` comment. The legacy header is the same with `cmsis-debugmcp`. A quoted key such as `[mcp_servers."cmsis-developer-assistant"]` is not recognized.
- **Section extent:** from the line after the header up to, not including, the next TOML table header of any kind, or the end of the file. Blank lines before the next header belong to the section.
- **String escaping:** `\` becomes `\\` and `"` becomes `\"`. Nothing else is escaped.

`upsertCodexDebugMCPConfig(content, url)`:

1. Normalize CRLF to LF. The result is always LF.
2. If our header is absent, append to the normalized content a separator, then `[mcp_servers.cmsis-developer-assistant]\nurl = "<escaped url>"\n`. The separator is `''` when the content is empty, `\n` when it ends with `\n`, and `\n\n` otherwise.
3. If our header is present, find the first line in its section that, after optional whitespace, starts with `url`, optional whitespace and `=`. `urls =` does not match; `# url =` does not match. Replace that line with its original leading whitespace plus `url = "<escaped url>"`; any trailing comment on it is dropped. Every other line is unchanged, and the result is the lines joined with `\n` (no newline added or removed at the end).
4. If the section has no such line, insert the line `url = "<escaped url>"`, without indentation, directly after the header, and join as in step 3.

`stripLegacyCodexSection(content)`:

- **Legacy header absent:** returns `{ content, removed: false }`, with `content` being the input unchanged (CRLF kept).
- **Legacy header present:** removes the first legacy header and its section from the LF-normalized text and returns `{ content: <LF text>, removed: true }`. Only the first occurrence is removed. A legacy sub-table such as `[mcp_servers.cmsis-debugmcp.env]` starts a new section and survives.

### `agentConfigHasServer(agent, content)`

- **toml:** `true` if any line (split on CRLF or LF) is our header. The legacy header alone does not count.
- **json:** `JSON.parse` the content. `true` only if the result is a non-null, non-array object whose `agent.mcpServerFieldName` property is a non-null object having the own-or-inherited key `cmsis-developer-assistant`; any value counts, `null` included. Everything else is `false`: parse errors, empty text, `null`, arrays, a wrong field. It never throws.

### Configuring one agent (step 1 of the setup)

For each agent, in selection order:

1. If the config file's directory does not exist, create it recursively.
2. **toml:** read the file (or use `''` if it does not exist), apply `upsertCodexDebugMCPConfig` with the current URL, and write it with `writeFileAtomic`. There is no re-read retry and no legacy strip.
3. **json, file exists:** `rewriteJsonFile(path, mutate)`. `mutate` ensures `config.mcpServers` exists, creating `{}` only when the value is `null` or `undefined`. It then sets `config.mcpServers["cmsis-developer-assistant"]` to the agent's entry and reports a change.
   - The whole previous value of that key is replaced; nothing is merged into it.
   - An existing key keeps its position; a new key is appended last.
   - All other content is preserved as `rewriteJsonFile` round-trips it: 2-space JSON, no trailing newline.
   - If the outcome is `unparseable` (invalid JSON, or valid JSON that is not an object), the file is left untouched, an error toast is shown (see "Agent- or user-visible text") and the step fails.
4. **json, file does not exist:** write `{ "mcpServers": { "cmsis-developer-assistant": <entry> } }` with `writeFileAtomic`, serialized with 2-space indentation and no trailing newline.
5. On success, show the success toast with one button ("open the config file", reworded; see the visible-text section) and wait for it to be answered or dismissed. The button opens the file with the `vscode.open` command on `vscode.Uri.file(configPath)`. Only then does the next agent start.
6. Any other exception is caught and shows the per-agent failure toast; the step fails. This includes the three-times-changed error from `rewriteJsonFile`, `mkdir` and write errors, and assigning into a non-object `mcpServers`. A failure never stops the remaining agents.

Example: a new Cline file for port 3001 and timeout 180 is exactly the following, with no final newline.

```json
{
  "mcpServers": {
    "cmsis-developer-assistant": {
      "autoApprove": [],
      "disabled": false,
      "timeout": 180,
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

A new Codex file is exactly this TOML, with a final newline:

```toml
[mcp_servers.cmsis-developer-assistant]
url = "http://localhost:3001/mcp"
```

### `migrateExistingConfigurations()`

Called on every activation. For each agent in roster order whose config file exists (a missing file is never created), failures are logged per agent and the loop continues:

- **toml:**
  1. Apply `stripLegacyCodexSection`.
  2. If a legacy section was removed, or the remaining text has our section with a `url` line matching the SSE pattern, apply `upsertCodexDebugMCPConfig` with the current URL. The SSE pattern: after `url` optional whitespace `=`, the line ends with `/sse`, optionally followed by one `"` or `'`, optional whitespace and an optional `#` comment. A trailing comment ending in `/sse` also matches.
  3. If anything changed, write with `writeFileAtomic` and count one migration.

  A stale port in a non-SSE URL is not refreshed. A legacy section carries over only its URL: its other keys are dropped, and the URL is the current one, not the legacy value.
- **json:** `rewriteJsonFile` with a mutation that is recomputed from scratch on every retry:
  1. If `mcpServers` is truthy and its `cmsis-debugmcp` value is truthy:
     - if `cmsis-developer-assistant` is falsy, set it to the legacy value (appended last);
     - in both cases delete `cmsis-debugmcp`;
     - `renamed = true`.
  2. Let `e` be the `cmsis-developer-assistant` value and `d` the agent's desired entry. If `e` is falsy, report `renamed` as the change. Otherwise compute three flags:
     - `legacySse`: `e.type === 'sse'`, or `e.url` is a string ending in `/sse`.
     - `wrongTransport`: `d.type` and `e.type` are both defined and differ.
     - `staleEndpoint`: `e.url` is a string, `d.url` is defined and they differ; or `e.args` is an array, `d.args` is defined and their JSON serializations differ.
  3. If any flag is set, replace the entry with a fresh copy of `d`. If `e.autoApprove` is an array, set `autoApprove` on the new entry to it: in place for the four `streamableHttp` agents, appended last for the others. All other custom fields of `e` are dropped.
  4. Report a change if any flag is set or `renamed`. The migration counts toward the toast only if `legacySse`, `wrongTransport` or `renamed`; a pure endpoint refresh is silent.
  5. Only a `written` outcome counts. `unparseable` and `unchanged` are skipped silently.

After the loop, if the count is above 0, show the migration toast, without awaiting it.

### Popup state and the setup flow

- **`shouldShowPopup()`:** `false` in a host-managed environment. Otherwise `true` unless the popup key is `true` (unset reads as `false`).
- **`resetPopupState()`:** sets the popup key to `false`, then sets the prompt timestamp key to `undefined`.
- **`runSetupFlow()`:**
  1. Build the roster and read `aiSkills.enabled`.
  2. Show the agent picker. Its title suffix is `" (1/2)"` when the skills step will follow and empty otherwise.
  3. When it is resolved, show the skill picker if `aiSkills.enabled` is on, whether step 1 was accepted or dismissed. Otherwise log that the skills step is skipped.
  4. An exception is logged and shown as the setup error toast.
  5. Finally, whatever happened, set the popup key to `true`.
- **Agent picker:**
  - `createQuickPick`, with `canSelectMany = true`, `ignoreFocusOut = true` and the exact title and placeholder under "Agent- or user-visible text".
  - One item per agent in roster order: the label, the description, `detail` equal to the agent's `displayName` (used to map the choice back), and `picked: false`.
  - Accepting hides it, then configures the selected agents one after another as described under "Configuring one agent". Only after that does the promise resolve `true`.
  - Hiding without accepting resolves `false`. The picker is disposed on hide.

### Skill scopes and settings

A scope is "this user" or one workspace folder whose `uri.scheme` is `file` (other folders are ignored everywhere).

- **Reading a selection:** `inspect('installedSkills')`.
  - User scope: the `globalValue`, else `[]`. Never "no value".
  - Folder scope, read through `getConfiguration('cmsis-developer-assistant', folder.uri)`: `workspaceFolderValue`, else `workspaceValue`, else "no value" (`undefined`).
  - A non-array value reads as `[]`. Non-string elements are dropped.
- **Writing a selection:**
  - User scope: `ConfigurationTarget.Global`.
  - Folder scope: on the folder-scoped configuration, `ConfigurationTarget.WorkspaceFolder` when `vscode.workspace.workspaceFile` is defined, otherwise `ConfigurationTarget.Workspace`.
- **Install roots:** `getSkillInstallRoots()` for the user, `getProjectSkillInstallRoots(folder.uri.fsPath)` for a folder. Both are evaluated at each use.
- **Scope names in text:** `this user`, or `the "<folder name>" workspace folder`.

### `syncSkills(reason)`

Calls are serialized: each run starts after the previous one settles, whether it resolved or rejected, and a rejection reaches only its own caller. A run:

1. Loads the catalog lazily from `context.extensionPath`, once per manager. A load failure is logged and remembered as "no catalog" for the manager's lifetime; with no catalog, resolve `null`.
2. Reads `aiSkills.enabled`.
3. Syncs the user scope, then each file-scheme folder in workspace order. Per scope:
   1. Resolve the scope's selection (or `[]`) with `resolveDesiredSkills(catalog, picks, { packEnabled, includeBundled: <user scope> })`.
   2. Log a warning naming any `unknown` picks, and an info line naming any `suppressed` picks.
   3. Call `skillInstaller.sync(roots, catalog, explicit, implied)`.
   4. If the scope had no value and nothing was removed or failed, stay silent. Otherwise log an info summary containing the reason, the pack state, `summarizeSkillSync(report)` and the visible and hidden lists. Then log one warning per failure and one per foreign skill left untouched.
4. Resolves a report concatenating every scope's `installed`, `removed`, `skippedForeign` and `failed`, in scope order.

### `showSkillSelectionDialog()`

1. With no catalog, show the catalog error toast and resolve `false`.
2. If `aiSkills.enabled` is off, show the pack-disabled message with the button `Enable and Select` and await it.
   - Any other answer resolves `false`.
   - The button sets `aiSkills.enabled` to `true` (`Global`) and continues.
3. **Scope choice:**
   - With no file-scheme folder open, the scope is the user; no picker is shown.
   - Otherwise `showQuickPick(items, { title, placeHolder, ignoreFocusOut: true })`. The items are one per folder, then the user item; the first item is the default.
   - Dismissing resolves `false`.
   - Each item's detail ends with the scope's state: `no selection yet` when the scope has no value, else `1 pack skill selected` or `<n> pack skills selected`. `<n>` is the length of `resolveDesiredSkills(catalog, picks, { includeBundled: false }).explicit`.
   - A folder item's description lists that folder's install roots as `<folder name>/<path relative to the folder with forward slashes>`, joined with `", "`.
   - The user item's description lists the user install roots, home-shortened and joined with `", "`.
4. **Skill items:** the preselection is the explicit set of the scope's selection resolved with `includeBundled: false`. For each `[category, entries]` of `groupByCategory(catalog)`, skip the bundled entries, and skip the category if none remain. Otherwise emit a separator item labelled `SKILL_CATEGORY_LABELS[category]`, then one item per entry, carrying the entry:
   - `label`: `$(list-tree)` plus a space for routers, then `displayName`, else `name`.
   - `description`, router: `/<name> — one command for the whole category, <k> member skills installed hidden`. `<k>` is the number of `dependsOn` names that exist in the catalog.
   - `description`, other skills: `/<name>`.
   - `detail`: the truncated `shortDescription`, else `description`. A non-router with `k > 0` gets the suffix `"  ·  also installs (hidden): "` followed by the names joined with `", "` (two spaces on each side of the dot).
   - `picked`: the entry is in the preselection.
5. **Skill picker:**
   - `createQuickPick`, with `selectedItems` = the picked items, `canSelectMany`, `ignoreFocusOut`, `matchOnDescription` and `matchOnDetail`.
   - The title and the placeholder depend on the scope; exact texts below.
   - Hiding without accepting resolves `false` (dispose on hide).
6. **Accept:**
   1. Take the selected entries' names in selection order and hide the picker.
   2. Write them to the scope's setting and await `syncSkills('selection')`.
   3. Resolve `resolveDesiredSkills(catalog, names, { includeBundled: <user scope> })`. For the user scope, its explicit count includes the bundled skills.
   4. If the report is not `null`, show the result toast. It counts only records whose `root` is one of the scope's install roots: installed roots (unique, home-shortened), removed and failed.
   5. A save or sync exception is logged and shown as the save error toast.
   6. Then resolve `true`.

### `maybePromptForSkills(now = Date.now())`

1. With no catalog, return.
2. Gather all inputs first:
   - Read every existing agent config file and apply `agentConfigHasServer`. A read error logs a warning and counts as "no".
   - Read `aiSkills.promptOnDetect` and `aiSkills.enabled`.
   - `firstRunPending` is "the popup key is not `true`".
   - Check for a host-managed environment.
   - `hasPackSkillSelected` over the union of the user selection and every folder selection.
   - Read the stored timestamp.
3. Call `decideSkillPrompt`. When it declines, log the reason and return.
4. Store `now` under `SKILLS_PROMPT_SHOWN_KEY` before showing anything.
5. Show `skillPromptMessage(<display names of agents with the server>)` with the buttons `SKILL_PROMPT_BUTTONS.select`, `.later` and `.never`.
   - `select` opens `showSkillSelectionDialog()`.
   - `never` sets `aiSkills.promptOnDetect` to `false` (`Global`).
   - Anything else does nothing.

## Agent- or user-visible text

`[REWORD]` strings: **3**. They are the lines `npm run provenance:check -- --lines` reports, in order or anywhere in DebugMCP's history. Everything else is quoted exactly. Strings marked *(near-shared)* are DebugMCP sentences with the product name swapped; the line check does not flag them, so they stay verbatim here, but a reviewer may reword them in a separate behaviour-changing PR.

- **Agent picker:**
  - title: `CMSIS Developer Assistant Setup${suffix} - Choose AI Agents to Configure`, where the suffix is `" (1/2)"` or empty *(near-shared)*
  - placeholder: `Select the AI agents to register the CMSIS Developer Assistant MCP server with (Esc to skip)`
  - item label: `[REWORD]` the action "add / configure this agent", followed by the agent's display name. Keep the `$(add)` codicon prefix.
  - item description: `Add CMSIS Developer Assistant server to this agent` *(near-shared)*
  - item detail: the display name
- **Agent toasts:**
  - success: `✅ CMSIS Developer Assistant successfully configured for ${displayName}` *(near-shared)*, with one button: `[REWORD]` "open the configuration file". Choosing it opens the file in an editor.
  - invalid JSON: `Cannot configure ${displayName}: ${configPath} exists but is not valid JSON. Please fix or remove the file and try again.`
  - write failure: `Failed to configure CMSIS Developer Assistant for ${displayName}: ${error}` *(near-shared)*
  - outer failure: `[REWORD]` "configuring <display name> failed: <error>"
  - migration: `CMSIS Developer Assistant: Migrated ${count} agent configuration(s).` *(near-shared)*
  - setup error: `Failed to show the CMSIS Developer Assistant setup: ${error}`

  `${error}` is `String(error)`, for example `Error: message`.
- **Skills, errors and gate:**
  - catalog: `CMSIS Developer Assistant: the bundled skill catalog could not be loaded.`
  - pack disabled: `CMSIS Developer Assistant: the AI Skills Pack is disabled (setting cmsis-developer-assistant.aiSkills.enabled); only the extension's own skills are installed.`, with the button `Enable and Select`
  - save error: `Failed to save the skill selection: ${error}`
- **Scope picker:**
  - title: `CMSIS Developer Assistant Setup (2/2) - Where to Install Agent Skills`
  - placeholder: `Install the AI Skills Pack skills into this workspace only (default) or for this user, in every workspace`
  - folder label: `$(root-folder) This workspace only`, or with several folders `$(root-folder) This workspace only — ${folder.name}`
  - folder detail: `Recommended: the agent loads them only in this project, so other projects' context stays lean — ${state}`
  - user label: `$(account) This user`
  - user detail: `Every workspace on this machine — every agent session carries them — ${state}`
  - states: `no selection yet`, `1 pack skill selected`, `${n} pack skills selected`
- **Skill picker:**
  - title: `CMSIS Developer Assistant Setup (2/2) - Choose Agent Skills to Install for ${scopeName}`
  - user placeholder: `Select the AI Skills Pack skills to install into your personal skills directories (always installed: ${bundledNames joined ", "}; Esc keeps the current selection)`
  - folder placeholder: `Select the AI Skills Pack skills to install into ${folder.name}/.agents/skills (the extension's own skills stay in your personal directories; Esc keeps the current selection)`
  - router description: `/${name} — one command for the whole category, ${k} member skills installed hidden`
  - skill description: `/${name}`
  - detail suffix: `"  ·  also installs (hidden): ${names}"`
  - truncation mark: `…`
  - scope names: `this user`, `the "${folder.name}" workspace folder`
- **Result toast:** the concatenation of these JavaScript string pieces:
  - `"CMSIS Developer Assistant: ${explicit} skill(s)"`
  - `" (+${implied} required, hidden)"`, only when `implied > 0`
  - `" installed for ${scopeName}"`
  - `" into ${roots}"`, only when any roots, which are joined with `", "`
  - `"; ${removed} removed."`
  - `" ${failed} failed — see the output log."`, only when `failed > 0`
- **Nudge:** the texts come from `skillPrompt.ts` (`skillPromptMessage`, `SKILL_PROMPT_BUTTONS`) and are not defined here.
- **Written files** (format constants, identifiers, never reworded):
  - the entry shapes and file layouts above
  - the keys `mcpServers`, `cmsis-developer-assistant`, `cmsis-debugmcp`
  - the TOML header and `url = "…"` line
  - the transport values `http`, `streamableHttp` and the `npx` / `-y` / `mcp-remote` bridge
- **Agent display names** (`Roo Code`, `Antigravity`, `Cline`, `GitHub Copilot CLI`, `Cursor`, `Codex`, `Claude Code`, `Claude Desktop`): product names, kept as is.
- **Log events** (wording free, through `logger`, not contract):
  - platform and base path
  - unknown platform
  - per-agent migrated / migration error / configured / configure error / refused unparseable
  - setup-flow error; skills step skipped
  - catalog load failure
  - unknown and suppressed picks; per-scope sync summary; per-failure; per-foreign skill
  - selection save error
  - prompt not shown with reason
  - agent config unreadable during detection

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. **Cursor path.** The Cursor entry is written to the `globalStorage/cursor.mcp/settings/mcp_settings.json` path under `<base>/Cursor`. Cursor documents `~/.cursor/mcp.json`, so this registration probably has no effect (#50 verification item).
2. Roo Code and Cline paths assume VS Code stable (`<base>/Code`). Insiders, VSCodium and other hosts are not covered. Claude Code ignores `CLAUDE_CONFIG_DIR`.
3. **Codex asymmetries:**
   - Codex migration refreshes only `/sse` URLs, never a stale port.
   - Configuring Codex does not strip a legacy section.
   - Renaming the legacy section drops its other keys, and legacy sub-tables survive.
   - A quoted-key header is not recognized, so a second table is appended.
4. Re-configuring an agent replaces the whole JSON entry, so custom fields are lost. Migration keeps only `autoApprove`. A changed `timeoutInSeconds` never reaches existing entries.
5. JSON config files are parsed strictly, so a JSONC or empty agent file is refused by configure (with a "not valid JSON" toast, also for valid non-object JSON), skipped silently by migration, and read as "no server" by detection. An array-valued `mcpServers` loses the entry on write, yet success is reported.
6. **Serialized toasts.** Configuration of several agents is serialized on each success toast, and the skills step waits until all of them are dismissed.
7. The skill picker says `(2/2)` also when opened alone (command, nudge). The user-scope result toast counts the bundled skills.
8. The popup key is set even when the setup flow failed. The skills step follows even a dismissed step 1 (by design: dismissing counts as an answer).
9. A catalog load failure is cached for the manager's lifetime.
10. `shortenHome` has no separator check: `/home/ann2` shows as `~2` for home `/home/ann`.
11. Detection reads every agent file even when the nudge is disabled, so the "unreadable" warnings can appear.
12. A new JSON file is created after an existence check without re-checking, so a file created in between is overwritten.

## Test cases

Characterization tests for a new `src/test/agentConfigurationManager.test.ts`. The pure helpers are tested directly. The file operations are tested with `HOME`/`USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, `CODEX_HOME` and `COPILOT_HOME` pointed into a temp directory, a fake `ExtensionContext` with an in-memory `globalState`, and `vscode.window` message functions replaced per test.

1. `upsertCodexDebugMCPConfig('', U)` gives `[mcp_servers.cmsis-developer-assistant]\nurl = "U"\n`.
2. `upsert('model = "x"', U)` gives `model = "x"\n\n[mcp_servers.cmsis-developer-assistant]\nurl = "U"\n`. `upsert('model = "x"\n', U)` gives the same.
3. Given CRLF input with our section, the output has only LF line breaks.
4. Given `[mcp_servers.cmsis-developer-assistant]\n  url = "old" # c\ntimeout = 5\n`, the url line becomes `url = "U"` indented by the same two spaces, and the other lines stay unchanged.
5. Given our section without `url`, followed by `[other]\nurl = "keep"`, a line `url = "U"` is inserted after our header and `[other]` is untouched.
6. Given a sub-table `[mcp_servers.cmsis-developer-assistant.env]` after the header, it ends the section: `url` is inserted after the header, not inside `.env`.
7. Given the header indented by two spaces and followed by two spaces and the comment `# ours`, the header is recognized. Given `[mcp_servers."cmsis-developer-assistant"]`, a new table is appended.
8. Given `U = http://h/a"b\c`, the written value is `http://h/a\"b\\c`.
9. `stripLegacyCodexSection` on text without the legacy header returns the identical string (CRLF kept) and `removed: false`.
10. Given `a = 1\n\n[mcp_servers.cmsis-debugmcp]\nurl = "x"\n\n[other]\nk = 1\n`, the strip gives `a = 1\n\n[other]\nk = 1\n`. A file consisting only of the legacy section gives `''`.
11. `agentConfigHasServer`: every case in `skillPrompt.test.ts` holds. In addition `{"mcpServers":{"cmsis-developer-assistant":null}}` gives `true`.
12. Roster paths: for `win32`, `darwin` and `linux` (platform stubbed), with and without `APPDATA`, `XDG_CONFIG_HOME`, `CODEX_HOME` and `COPILOT_HOME`, the eight paths match the table, in that order.
13. Configure, missing file and directory (each JSON agent): the directory is created and the file bytes equal the entry shapes above, 2-space indented, no final newline.
14. Configure into an existing `~/.claude.json` with `{"numStartups":3,"projects":{…},"mcpServers":{"other":{…},"cmsis-developer-assistant":{"x":1}}}`: only our entry changes; it keeps its position and is fully replaced; `numStartups`, `projects` and `other` are unchanged.
15. Configure into an invalid-JSON file: the file is unchanged, the "not valid JSON" toast appears with the exact text, and the success toast does not.
16. Configure Codex into a file with other tables: an upsert with the current URL, written atomically (no `*.tmp` left behind).
17. Migrate a Codex file with the legacy section `url = ".../sse"`: the legacy section is gone, our section is appended with the current URL, and the toast reads `CMSIS Developer Assistant: Migrated 1 agent configuration(s).`
18. Migrate a Codex file with our section and `url = "http://localhost:9999/mcp"`: no write (mtime unchanged) and no toast.
19. Migrate Cline `{"mcpServers":{"cmsis-debugmcp":{"type":"streamableHttp","url":<current>,"autoApprove":["a"]}}}`: the key is renamed, the value is kept, and the migration is counted.
20. Migrate Cline with both keys: the legacy key is removed and ours is kept.
21. Migrate Cline `{"type":"sse","url":"http://localhost:3001/sse","autoApprove":["x"],"custom":1}`: the entry becomes the `streamableHttp` shape with `autoApprove` `["x"]` and without `custom`; counted.
22. Migrate the Copilot CLI entry `{"type":"streamableHttp","url":<current>}`: it becomes `{type:'http',url,tools:['*']}`; counted.
23. Migrate an entry that differs only in port (Claude Code `url`, Claude Desktop `args`): refreshed and written, but not counted, so no toast when it is the only change.
24. Migrate an unparseable or JSONC file, or a file without our key: the bytes are unchanged, with no toast and no error toast.
25. Two agents migrated in one run: a single toast with count 2.
26. `shouldShowPopup` is `false` with `ANTIGRAVITY_ENV=true` or `GEMINI_HOME=/x`, `true` on a fresh state, and `false` after `runSetupFlow` even when both pickers are dismissed or the roster throws.
27. `resetPopupState` sets the popup key to `false` and the timestamp to `undefined`.
28. Selection reading: the user value unset gives `[]`; a folder value unset gives `undefined`; `"x"` gives `[]`; `["a",1]` gives `["a"]`; a `.code-workspace` value applies to a folder without its own value.
29. Selection writing: the targets are `Global`, then `WorkspaceFolder` with `workspaceFile` set, then `Workspace` without it.
30. Two `syncSkills` calls started together run one after the other. A run that rejects does not block the next, and the rejection reaches only its caller.
31. With `catalog.json` unreadable, `syncSkills` resolves `null` and the picker shows the catalog error toast.
32. Skill picker items for a fixture catalog: bundled skills are absent; there is one separator per category with a non-bundled entry; the router comes first with `$(list-tree)`; the description and detail formats are as above; a 200-character description is cut to 140 characters ending in `…`.
33. Accept in user scope with the fixture catalog: the setting is written `Global`, and the toast text is exact for 0 and more than 0 implied skills, with and without failures.
34. `maybePromptForSkills`:
    - When the decision declines, no timestamp is written.
    - When it shows, the timestamp equals `now` and is written before the message.
    - `Don't ask again` sets `aiSkills.promptOnDetect` to `false` (`Global`).
    - `Select Skills` opens the picker.

## Constraints

- **VS Code APIs:**
  - `ExtensionContext`: `globalState`, `extensionPath`, `extension.packageJSON`.
  - `workspace`: `getConfiguration` (with and without a folder URI), `inspect` / `update`, `ConfigurationTarget`, `workspaceFolders`, `workspaceFile`.
  - `window`: `createQuickPick`, `showQuickPick`, `QuickPickItemKind.Separator`, `showInformationMessage`, `showErrorMessage`.
  - `commands.executeCommand('vscode.open', …)`, `Uri.file`.
- **Node APIs:** `fs`, `path` and `os` (`platform`, `homedir`) and `process.env`, read at call time.
- **Write discipline:** every write goes through `writeFileAtomic`. Every JSON read-modify-write of an existing file goes through `rewriteJsonFile`. A mutation passed to it must be free of side effects, because it may run up to three times; count migrations only from the final outcome.
- **Logging:** `logger` from `src/utils/logger`, never `console.*`. Log text is not contract.
- **File header:** the Arm Apache-2.0 block as in `src/core/toolRun.ts`, with no Microsoft line. Remove the file from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Provenance gate:** at most 3 identical trimmed non-trivial lines against DebugMCP (`npm run provenance:check -- --gate`). The roster, entry shapes and TOML format are fixed data, but their representation is free, as are internal names (`getDebugMCPConfig`, `addDebugMCPToAgent`, …) and the module layout.
- **Scope:** do not change `skillCatalog.ts`, `skillInstaller.ts`, `skillPrompt.ts`, `atomicFile.ts` or `jsonFileRewrite.ts`. They are Arm-authored and tested.
