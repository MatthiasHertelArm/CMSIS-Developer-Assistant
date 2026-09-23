# AgentConfigurationManager

## Purpose

Onboards AI coding agents onto the CMSIS Developer Assistant: registers the
MCP server in each agent's own configuration file, installs the Agent Skills
the user selected into the personal skills directories those agents read —
or, per workspace folder, into the project's own — and writes the tool rules
into the agents' rule files the user confirms. Registration, the AI Skills
Pack and the rule files are opt-in through one three-step setup flow; the
extension's own skills are always installed.

## Motivation

For an agent to use the extension it needs things it cannot discover on its
own: the MCP endpoint (in its config file), the workflow knowledge (Agent
Skills), and the rule to use the tools rather than `pyocd`, `gdb` or `cbuild`
in a shell (#45, #50). The server instructions and the skills carry that rule,
but an agent may lose both when it compacts its context, while its rule file
is loaded in every session. Rather than sending users to edit JSON/TOML,
copy directories and write rule files by hand, the manager does all three —
but only for the agents, skills and files the user picked, because these
files live next to things the extension does not own.

## Responsibility

- Know the supported agents, their config file paths per platform, and the
  MCP entry shape each expects (`supportedAgents()`, `entryFor()` with
  `ENTRY_SHAPES`).
- Merge the server entry into an existing config without disturbing the rest
  of the file (`registerServer()`); migrate entries written by earlier
  versions (`migrateExistingConfigurations()`).
- Drive the first-run setup and its on-demand re-run (`runSetupFlow()`),
  remembering in `globalState` that it was shown; afterwards, the monthly
  install nudge for agents that have the server but no pack skill
  (`maybePromptForSkills()`, decision in `skillPrompt.ts`).
- Apply the `installedSkills` and `aiSkills.enabled` settings to disk
  (`syncSkills()`), scope by scope — the user value to the personal
  directories, each workspace folder's value to that project — using the
  pure helpers in `skillCatalog.ts` (what to install) and
  `skillInstaller.ts` (how to write it safely).
- Offer the agents' rule files for the tool rules in step 3 of the setup,
  preview and write each change the user confirms, and keep the blocks it
  wrote current at activation (`refreshAgentRules()`), using
  `core/agentRules.ts` (which file, what text) and `agentRuleFiles.ts` (the
  step and the refresh, over an injected file system).

## Key Concepts

### Supported agents

Home-directory config files only; the GitHub Copilot *extension* in VS Code
is served by the `McpServerDefinitionProvider` registered in `extension.ts`
and needs no file. The roster: Roo Code, Antigravity, Cline, GitHub Copilot
CLI, Cursor, Codex (TOML), Claude Code, Claude Desktop (stdio bridge via
`mcp-remote`). Paths under the platform's application-data directory follow
`%APPDATA%`, `~/Library/Application Support` or `$XDG_CONFIG_HOME`;
`CODEX_HOME` and `COPILOT_HOME` move those two agents' files. Cursor reads
`~/.cursor/mcp.json` on every platform. Roo Code, Antigravity and Cline share
one `streamableHttp` entry shape; Copilot CLI, Cursor (`url` only, as its
documentation shows a remote server), Claude Code and Claude Desktop have
their own (`ENTRY_SHAPES`). Each path carries the vendor source it was checked
against in a code comment.

### Migration of earlier entries

`migrateExistingConfigurations()` visits only agents whose file exists. In
JSON files it moves an entry from the pre-2.1.0 key `cmsis-debugmcp` to
`cmsis-developer-assistant` and replaces an entry that still uses SSE,
another transport or another endpoint by the current shape, keeping its
`autoApprove` list (`migrateServers()`). In Codex's TOML it drops the legacy
table and points ours at the current endpoint when that table existed or ours
still uses SSE (`migrateCodexAgent()`, with the text helpers
`stripLegacyCodexSection()` and `upsertCodexDebugMCPConfig()`).

Releases before 2.5.1 wrote Cursor's entry to
`…/Cursor/User/globalStorage/cursor.mcp/settings/mcp_settings.json`, a file
Cursor never reads. `moveCursorEntry()` moves such an entry to
`~/.cursor/mcp.json` first — the only migration that creates a file, because
the user asked for Cursor back then — keeps an entry the user already has
there, and deletes the old file when nothing but our entry was in it.

### Safety rules for config files

Atomic write (temp file + rename, per-process unique temp name —
`src/utils/atomicFile.ts`, for JSON and Codex TOML alike); JSON files are
re-read immediately before the write and the update retried when another
process changed the file in between (`src/utils/jsonFileRewrite.ts` —
`~/.claude.json` is rewritten by Claude Code all the time); never recreate an
unparseable file; merge only the `cmsis-developer-assistant` key; per-agent
try/catch so one failure does not abort the rest.

### The skill catalog

`skills/catalog.json` is generated by `npm run skills:sync`
(`scripts/sync-skills.ts`) and shipped in the VSIX. It lists the bundled
`cmsis-debug-live`, `add-board-layer`, `cmsis-pack-docs` and `cmsis-help`, the
Open-CMSIS-Pack/cmsis-skills skills vendored under `skills/cmsis-skills/` at
the commit pinned in `skills/cmsis-skills.lock.json`, and one generated
*router* skill per category that has skills there (`cmsis-project`,
`cmsis-bring-up`, `cmsis-pack`; `ethos-u` has none yet). Each entry records its `dependsOn` — the `$name` references in
its text; a router depends on all members of its category. The cmsis-skills
skills plus the routers are the *AI Skills Pack* (`isPackSkill()`); the
bundled skills are not part of it (`isBundledSkill()`).
`cmsis-help` is itself generated (`src/utils/skillHelp.ts`) from the catalog,
`package.json`, the `help` block of `scripts/skills.config.json` and the tool
contract. The contract (`docs/agent-resources/tool-contract.md`, #50) is also
copied between marker comments into the three hand-written bundled skills,
which the installer then copies out like any other file. See
`skills/README.md`.

### Explicit vs implied skills

The `installedSkills` setting stores only the pack skills the user picked;
the bundled skills are always desired, whatever it says (in the user scope —
a project selection is resolved with `includeBundled: false`, see below).
`resolveDesiredSkills(catalog, configured, { packEnabled, includeBundled })` adds the
transitive dependency closure: the explicit set is installed visible, the
closure is installed with `user-invocable: false` injected into the copied
frontmatter, so a user who picks `cmsis-pack` sees one slash command and the
seven members stay model-invocable but out of the menu. Harnesses that do not
know the field ignore it. With `aiSkills.enabled` off the picks come back as
`suppressed`, nothing from the pack is desired, and the installer's sweep
removes what it installed earlier — the setting keeps the picks for
re-enabling.

### Scopes: this user or this workspace

The target of the `installedSkills` setting (scope `resource`) *is* the
"where" choice — there is no second setting to keep in step with it. The
manager reads the setting with `inspect()` per `SkillScope`: the
`globalValue` (default `[]`) is the user's selection, and for every
workspace folder on disk `workspaceFolderValue ?? workspaceValue` is that
project's. Folders that are not on the local file system get no skills. A
folder without a value has not opted in: its roots are swept for leftovers
but never created. `syncAllScopes()` resolves and syncs each scope on its
own, the user first, then every folder; the report `syncSkills()` returns
covers all of them. Calls to `syncSkills()` are queued, so two runs never
overlap.

A project selection is resolved with `includeBundled: false`: it installs
the picked pack skills and their hidden pack dependencies, nothing else. The
extension's own skills are in the personal directories already, and a
project copy would show up twice in the slash menu. So a project can hold
"only `cmsis-pack`" while the user profile holds a different selection; the
agent sees the union.

The picker (`showSkillSelectionDialog()` → `chooseScope()` →
`chooseSkills()` → `applySelection()`) asks for the scope first — skipped
when no local folder is open — with the workspace as the first, pre-selected
item (a personal skill costs context in every project; a project skill only
where it applies) and each scope's current count, then reads and writes that
scope's own value (`readSelection()` / `writeSelection()`:
`ConfigurationTarget.Global` for the user; for a folder, `WorkspaceFolder`
when a `.code-workspace` file is open and `Workspace` otherwise, where the
folder's `.vscode/settings.json` is the workspace file). With the pack
disabled, the picker first offers to turn `aiSkills.enabled` back on.
The toast reports the chosen scope's roots only. `hasPackSkillSelected()`
for the install nudge sees the union of all scopes.

### Install roots and the marker file

`getSkillInstallRoots()` (user): `~/.agents/skills` always; `~/.claude/skills`
when a Claude home exists (`CLAUDE_CONFIG_DIR` is honoured; Claude Code does
not read `~/.agents`);
`$COPILOT_HOME/skills` only when that variable is set. `~/.copilot/skills`,
which earlier releases wrote, is only swept.
`getProjectSkillInstallRoots(folder)` (workspace): `<folder>/.agents/skills`
always; `<folder>/.claude/skills` when a Claude home exists or the folder
already has a `.claude` directory, otherwise only swept. The installer takes
the roots per `sync()` call and creates a root only when something is to be
installed into it. Every directory the installer writes carries
`.cmsis-developer-assistant.json`; only directories with that marker (or the
pre-marker `cmsis-debug-live` whose frontmatter name matches) are ever
replaced or removed. Anything else in those roots belongs to the user or
the project.

### Tool rules in agents' rule files

The rules section of the tool contract (`docs/agent-resources/tool-contract.md`,
read from the extension's `docs/` folder) goes between the
`<!-- cmsis-developer-assistant:rules:begin/end -->` markers of
`markerBlock.ts`, led by one comment line that says the extension manages
the block and how to take it out. Everything outside the block stays as it
was, byte for byte.

*Which file.* `ruleFileTargets()` maps each agent to the file it reads, from
the vendors' documentation (the sources sit next to the map in
`core/agentRules.ts`). Claude Code, Codex, Copilot CLI and Antigravity have a
user-level file, which is preselected: the MCP registration is per user too,
and a workspace file ends up in the repository for colleagues who may not have
the extension. VS Code Copilot Chat, Cursor, Cline and Roo Code get their
workspace file only. Most agents read the workspace `AGENTS.md`; a file several
agents read is offered and written once. Cursor, Cline and Roo Code get a file
of their own (`own` form) in their rule folder, which a removal deletes. The
map never picks a file whose creation would hide one the project uses: Claude
Code writes into the project's `CLAUDE.md` only when there is one (a new
`CLAUDE.md` would stop it reading `AGENTS.md`), Roo Code into `.roorules`
while that is the file it reads, Codex into a non-empty `AGENTS.override.md`.

*Which agents.* Step 3 covers the agents picked in step 1, the agents whose
configuration registers the server already, and Copilot Chat; files recorded
earlier are listed too, so that they can be unchecked.

*Consent.* A file that has the rules opens checked. Accepting the picker
plans one change per file (`planRuleChanges()`): create, add, update, or
remove. Each change opens `vscode.diff` between the file as it is — or an
empty document — and the proposed text, served by a content provider for the
`cmsis-developer-assistant-rules` scheme, then a modal dialog; only *Write* or
*Remove* changes the file. The file is read again right before the write,
which is atomic.

*Records.* `globalState` key `cmsis-developer-assistant.agentRules.files`
lists each file written, whether it was created for the rules and which
directories were made for it. A removal restores the file to its earlier
bytes, or deletes a file (and its empty directories) that was made for the
rules or is the extension's own. At activation `refreshAgentRules()`
updates every recorded block whose text differs from the current contract,
in place, and logs it; a recorded file that is gone, or whose block the user
deleted, is forgotten, never recreated. Activation under the extension test
runner skips it, like the skill sync and the migration.

*Setting.* `agentRules.install`: `ask` (default) or `never`, which skips
step 3 and the refresh.

### Popup state

Two `globalState` keys, both cleared by *Reset Popup State*:

- `cmsis-developer-assistant.popupShown.v4` — the first-run setup. Accepting
  or dismissing any step marks it shown. The version suffix is bumped when
  the flow gains a step so existing users see it once more (v4: the tool
  rules step).
- `cmsis-developer-assistant.skillsPrompt.lastShownAt` — epoch ms of the last
  install nudge. Written *before* the toast, so a dismissal (or a second
  window racing) counts; the next one is due 30 days later.

### The install nudge

`decideSkillPrompt()` (`skillPrompt.ts`, pure) shows the prompt only when
`aiSkills.promptOnDetect` and `aiSkills.enabled` are on, the first-run flow
has been answered, the host does not manage MCP itself (Antigravity/Gemini),
at least one supported agent's config registers the server
(`agentConfigHasServer()`), no pack skill is selected, and the last prompt is
older than 30 days — in that order, so the logged reason names the real
blocker. Buttons: *Select Skills* (opens the picker), *Later*, *Don't ask
again* (turns the setting off).

## Key Code Locations

- Class: `src/utils/agentConfigurationManager.ts`
  - agents: `supportedAgents()`, `entryFor()`, `registerServer()`, `migrateExistingConfigurations()` (`migrateServers()`, `migrateCodexAgent()`), `agentConfigHasServer()`, Codex TOML text: `upsertCodexDebugMCPConfig()`, `stripLegacyCodexSection()`
  - setup flow: `shouldShowPopup()`, `runSetupFlow()`, `pickAndConfigureAgents()`, `showSkillSelectionDialog()`, `offerAgentRules()`, `resetPopupState()`
  - rule files: `offerAgentRules()` (picker, `previewRuleChange()`), `refreshAgentRules()`
  - skills: `syncSkills()` / `syncAllScopes()`, `chooseScope()`, `chooseSkills()`, `readSelection()` / `writeSelection()`, `maybePromptForSkills()`
- Atomic and concurrent-safe writes: `src/utils/atomicFile.ts`, `src/utils/jsonFileRewrite.ts`
- Catalog model and selection logic: `src/utils/skillCatalog.ts`
- Install-prompt decision: `src/utils/skillPrompt.ts`
- Help skill renderer (generator + tests only): `src/utils/skillHelp.ts`
- Copying, hiding, marker-guarded removal: `src/utils/skillInstaller.ts`
- Rule files: `src/core/agentRules.ts` (the agent-to-file map with its vendor sources, the block text, `withRules()` / `withoutRules()`, the records), `src/utils/agentRuleFiles.ts` (`runRuleStep()`, `planRuleChanges()`, `applyRuleChange()`, `refreshRecordedRules()`, the node file system)
- Generator: `scripts/sync-skills.ts` (`--offline` without a fetch), hand-authored input `scripts/skills.config.json` and `docs/agent-resources/tool-contract.md`; marker blocks: `src/utils/markerBlock.ts`
- Tests: `src/test/skillCatalog.test.ts` (catalog ↔ disk ↔ lock ↔ help skill), `src/test/skillInstaller.test.ts` (temp-dir behaviour), `src/test/skillPrompt.test.ts` (prompt decision, server detection), `src/test/agentRules.test.ts` (the rule-file map and the step against an in-memory file system), `test/transport/config-scenarios.js` (the files written for each agent per platform, migration, popup state, the pickers, the rule-file step with its previews, `syncSkills()` and the nudge, against `config-scenarios.snapshot.json`)

## User Flow

1. Extension activates; `syncSkills('activation')` applies the setting —
   the user value and every workspace folder's own. After the migration,
   `refreshAgentRules()` brings recorded rule blocks up to date.
2. If the setup was never shown (for this version of the flow) and the host
   does not manage MCP itself, after 2 s: step 1 multi-select of agents →
   config files written; step 2 (skipped while `aiSkills.enabled` is off)
   "this user or this workspace?", then multi-select of skills → that
   scope's setting written, skills synced; step 3 (skipped while
   `agentRules.install` is `never`) multi-select of rule files → per file a
   diff and a dialog → the confirmed files written.
3. Any later change to `installedSkills` or `aiSkills.enabled` (picker,
   settings.json in either scope, Settings Sync, a checked-out
   `.vscode/settings.json`) triggers a sync through
   `onDidChangeConfiguration`; a folder added to or removed from the
   workspace triggers one through `onDidChangeWorkspaceFolders`.
4. Once the setup has been answered, the 2 s timer runs
   `maybePromptForSkills()` instead: the monthly nudge for agents that have
   the server registered but no pack skill selected.

## Commands

- `cmsis-developer-assistant.configure` — *Configure Agents and Skills*: the three-step flow
- `cmsis-developer-assistant.selectSkills` — *Select Agent Skills*: step 2 only
- `cmsis-developer-assistant.resetPopupState` — hidden from the palette; re-arms the first-run flow for testing
