# AgentConfigurationManager

## Purpose

Onboards AI coding agents onto the CMSIS Developer Assistant: registers the
MCP server in each agent's own configuration file, installs the CMSIS Agent
Skills into the personal skills directories those agents read, and writes
the tool rules into the agents' rule files the user confirms. Registration
and the rule files are opt-in through one two-step setup flow; the skills
are one fixed set, installed at activation and again when the agents are
configured — there is nothing to select.

## Motivation

For an agent to use the extension it needs things it cannot discover on its
own: the MCP endpoint (in its config file), the workflow knowledge (Agent
Skills), and the rule to use the tools rather than `pyocd`, `gdb` or `cbuild`
in a shell (#45, #50). The server instructions and the skills carry that rule,
but an agent may lose both when it compacts its context, while its rule file
is loaded in every session. Rather than sending users to edit JSON/TOML,
copy directories and write rule files by hand, the manager does all three —
but only for the agents and files the user picked, because these files live
next to things the extension does not own. The skills are the exception:
they go into directories made for skills, every one carries a marker file,
and a normal user needs the whole set, so there is no picker (2.5.15; earlier
releases had one, with three settings and a monthly prompt).

## Responsibility

- Know the supported agents, their config file paths per platform, and the
  MCP entry shape each expects (`supportedAgents()`, `entryFor()` with
  `ENTRY_SHAPES`).
- Merge the server entry into an existing config without disturbing the rest
  of the file (`registerServer()`); migrate entries written by earlier
  versions (`migrateExistingConfigurations()`).
- Drive the first-run setup and its on-demand re-run (`runSetupFlow()`),
  remembering in `globalState` that it was shown.
- Install the skill catalog into the personal skills directories
  (`syncSkills()`), at activation and after the agents step of the setup,
  using the pure helpers in `skillCatalog.ts` (what is visible, what is
  hidden) and `skillInstaller.ts` (how to write it safely).
- Offer the agents' rule files for the tool rules in step 2 of the setup,
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
(`scripts/sync-skills.ts`) and shipped in the VSIX. It lists the extension's
own entry points `cmsis-debug-live`, `add-board-layer`, `cmsis-bootstrap`,
`cmsis-pack-docs` and `cmsis-help` (source `bundled`), its hidden skills
`start-cmsis-project`, `cmsis-debugger-setup`, `fvp-debug-setup` and
`debugger-troubleshooting` (source `extension`), the Open-CMSIS-Pack/cmsis-skills skills of the
categories `scripts/skills.config.json` names in `upstreamCategories`
(`project` and `devops`; vendored under `skills/cmsis-skills/` at the commit
pinned in `skills/cmsis-skills.lock.json`), and one generated *router* skill
per configured category (`cmsis-project`). The bring-up, pack, Ethos-U and
stream skills stay upstream: they author CMSIS-Pack debug content and
knowledge records, which a normal user of the extension does not do.

Each entry records its `dependsOn` — the `$name` references in its text; a
router depends on all members of its category — and `invocable`: whether it
is installed as a slash command (the bundled skills, the routers, and a
skill of a category without a router) or with `user-invocable: false`
injected into the copied frontmatter (the members of a router, and the
extension's hidden skills, which another skill hands over to). Harnesses
that honour the field keep hidden skills out of the `/` menu while the model
still invokes them by description; the rest ignore it. `installSet()` splits
the catalog by that flag; the installer gets the whole catalog every time.

`cmsis-help` is itself generated (`src/utils/skillHelp.ts`) from the catalog,
`package.json`, the `help` block of `scripts/skills.config.json` and the tool
contract. The contract (`docs/agent-resources/tool-contract.md`, #50) is also
copied between marker comments into the hand-written skills of the extension,
which the installer then copies out like any other file. See
`skills/README.md`.

### A window without a folder

The extension activates in a VS Code window that has no folder open, and the
setup runs there as anywhere: the server is registered in the agents'
user-level configuration files, so an agent started in any directory finds
it, and the skills go to the personal skills directories, so `cmsis-bootstrap`,
the skill for exactly this window, is there. What depends on a folder is left
out: only the agents' user-level rule files can be offered in step 2; an agent
that reads a workspace file only (Copilot Chat, Cursor, Cline, Roo Code) gets
its rules once a folder is open.

### Install roots and the marker file

`getSkillInstallRoots()` (user): `~/.agents/skills` always; `~/.claude/skills`
when a Claude home exists (`CLAUDE_CONFIG_DIR` is honoured; Claude Code does
not read `~/.agents`);
`$COPILOT_HOME/skills` only when that variable is set. `~/.copilot/skills`,
which earlier releases wrote, is only swept.
Releases 2.5.1 to 2.5.10 could also install a selection into a workspace
folder (`getProjectSkillInstallRoots(folder)`: `<folder>/.agents/skills`,
`<folder>/.claude/skills`); `skillRoots()` now lists those roots of every
open local folder as sweep-only, so a copy a project selection left behind
goes away at the next activation, and nothing is written there. The
installer takes the roots per `sync()` call and creates a root only when
something is to be installed into it. Every directory the installer writes carries
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
step 2 and the refresh.

### Popup state

One `globalState` key, cleared by *Reset Popup State*:

- `cmsis-developer-assistant.popupShown.v5` — the first-run setup. Accepting
  or dismissing any step marks it shown. The version suffix is bumped when
  the flow changes so existing users see it once more (v4: the tool rules
  step; v5: the skills step gone, the catalog installed with the agents).

`cmsis-developer-assistant.skillsPrompt.lastShownAt`, the time of the monthly
skills prompt of earlier releases, is cleared by the same command and never
read.

## Key Code Locations

- Class: `src/utils/agentConfigurationManager.ts`
  - agents: `supportedAgents()`, `entryFor()`, `registerServer()`, `migrateExistingConfigurations()` (`migrateServers()`, `migrateCodexAgent()`), `agentConfigHasServer()`, Codex TOML text: `upsertCodexDebugMCPConfig()`, `stripLegacyCodexSection()`
  - setup flow: `shouldShowPopup()`, `runSetupFlow()`, `pickAndConfigureAgents()`, `installForAgents()`, `offerAgentRules()`, `resetPopupState()`
  - rule files: `offerAgentRules()` (picker, `previewRuleChange()`), `refreshAgentRules()`
  - skills: `syncSkills()` / `installCatalog()`, `skillRoots()`
- Atomic and concurrent-safe writes: `src/utils/atomicFile.ts`, `src/utils/jsonFileRewrite.ts`
- Catalog model and the install set: `src/utils/skillCatalog.ts` (`installSet()`)
- Help skill renderer (generator + tests only): `src/utils/skillHelp.ts`
- Copying, hiding, marker-guarded removal: `src/utils/skillInstaller.ts`
- Rule files: `src/core/agentRules.ts` (the agent-to-file map with its vendor sources, the block text, `withRules()` / `withoutRules()`, the records), `src/utils/agentRuleFiles.ts` (`runRuleStep()`, `planRuleChanges()`, `applyRuleChange()`, `refreshRecordedRules()`, the node file system)
- Generator: `scripts/sync-skills.ts` (`--offline` without a fetch), hand-authored input `scripts/skills.config.json` and `docs/agent-resources/tool-contract.md`; marker blocks: `src/utils/markerBlock.ts`
- Tests: `src/test/skillCatalog.test.ts` (catalog ↔ disk ↔ lock ↔ help skill, the install set), `src/test/skillInstaller.test.ts` (temp-dir behaviour, the sweep of 2.5.x project roots), `src/test/agentRules.test.ts` (the rule-file map and the step against an in-memory file system), `test/transport/config-scenarios.js` (the files written for each agent per platform, migration, popup state, the setup with its skill install, the rule-file step with its previews, `syncSkills()`, against `config-scenarios.snapshot.json`)

## User Flow

1. Extension activates; `syncSkills('activation')` installs the catalog into
   the personal skills directories and sweeps the project roots of 2.5.x.
   After the migration, `refreshAgentRules()` brings recorded rule blocks up
   to date.
2. If the setup was never shown (for this version of the flow) and the host
   does not manage MCP itself, after 2 s: step 1 multi-select of agents →
   config files written, then the skills installed again and a toast that
   says how many went where; step 2 (skipped while `agentRules.install` is
   `never`) multi-select of rule files → per file a diff and a dialog → the
   confirmed files written.
3. A later release with another catalog: the next activation installs the
   new set and removes the directories this extension wrote that are no
   longer in it (marker-guarded).

## Commands

- `cmsis-developer-assistant.configure` — *Configure Agent*: the two-step flow, skills installed with the agents
- `cmsis-developer-assistant.resetPopupState` — hidden from the palette; re-arms the first-run flow for testing
