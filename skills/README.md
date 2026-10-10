# Agent skills shipped with the extension

Everything in this directory ships in the VSIX. On activation, and again
when **CMSIS Developer Assistant: Configure Agent** registers the agents, the
extension copies every skill of `catalog.json` into the user's personal
skills directories: the entry points as slash commands, the members of a
router and the hand-over targets with `user-invocable: false` — see the
*Agent Skills* section of `docs/user-guide.md`. There is no selection; the
catalog is the set.

| Path | What | Maintained how |
|------|------|----------------|
| `cmsis-debug-live/` | The extension's own live Cortex-M debugging workflow; hands over to `$debugger-troubleshooting` when a session will not start. Slash command. | Authored here, except the tool-contract blocks (below). |
| `add-board-layer/` | Add a board layer to an existing csolution by interview. Slash command. | Authored here, except the tool-contract block. |
| `cmsis-bootstrap/` | From an empty VS Code window to a CMSIS solution that builds and debugs: finds what is missing, asks for the board, folder, compiler and probe, hands over to the project skills and to `cmsis_action open_solution`. Carries the starter `vcpkg-configuration.json`. Slash command. | Authored here, except the tool-contract block. |
| `cmsis-pack-docs/` | Page-cited lookups in the target's pack documentation through the documentation tools. Slash command. | Authored here (moved from the experimental CMSIS Pack Docs extension), except the tool-contract block. |
| `cmsis-help/` | The extension's own "what can I ask for?" skill: the tool rules, slash commands, member skills per category, VS Code commands, MCP tool groups, the shell commands they replace, settings. Slash command. | **Generated** from `catalog.json`, `package.json`, the `help` block of `scripts/skills.config.json` (`src/utils/skillHelp.ts`) and the tool contract; the test re-renders it. |
| `start-cmsis-project/`, `cmsis-debugger-setup/`, `fvp-debug-setup/`, `debugger-troubleshooting/` | The extension's own hidden skills (catalog source `extension`, `hidden` in `scripts/skills.config.json`): write the first solution for a board or device (the minimal project assets, or an example or template of the pack) and build it through `cmsis_action`; wire the debug adapter of a target and verify Load & Debug; make Run and Debug work against an Arm FVP (with the model shim and Dockerfile templates); find out why a debug or flash session fails. Installed with `user-invocable: false`; `start-cmsis-project` and `cmsis-debugger-setup` are members of `cmsis-project`, the other two are reached by `$name` hand-overs from `cmsis-bootstrap`, `cmsis-debugger-setup` and `cmsis-debug-live`. | Authored here, except the tool-contract block. |
| `cmsis-skills/<name>/` | The [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills) skills of the categories `upstreamCategories` names in `scripts/skills.config.json` (`project`, `devops`), verbatim, flattened by name. `LICENSE` is upstream's Apache-2.0. The bring-up, pack, Ethos-U and stream skills stay upstream. | **Generated** — never edit; re-sync. |
| `cmsis-project/` | The router skill of the project category: a dispatch table to the member skills (the upstream ones and `cmsis-debugger-setup`) plus a typical workflow; the members are installed hidden. A category without a router (`devops`) installs its skills as slash commands. | **Generated** from `scripts/skills.config.json`. |
| `catalog.json` | Name, description, category, kind, source, path, `dependsOn` and `invocable` of every skill. The runtime and the tests read only this. | **Generated.** |
| `cmsis-skills.lock.json` | Upstream repository, the pinned commit SHA, and a content hash of `cmsis-skills/`. | **Generated.** |

## Re-syncing upstream

```sh
npm run skills:sync -- --offline  # regenerate from the vendored skills; no network, lock untouched
npm run skills:sync               # re-vendor at the pinned SHA
npm run skills:sync -- --update   # move the pin to the current upstream main, then re-vendor
```

`--offline` is the one to run after editing `scripts/skills.config.json`,
`package.json` or the tool contract: it rebuilds the routers, the catalog,
`cmsis-help` and the contract blocks from the committed catalog and
`cmsis-skills/`, and neither fetches nor touches the lock.

Without `--offline` the script does a shallow `git fetch` of the pinned commit, copies
`generic-mcu-skills/skills/<category>/<name>/` of every category in
`upstreamCategories` into `cmsis-skills/<name>/` (the other upstream
directories are named and left out), reads each skill's frontmatter and
`agents/openai.yaml`, records the `$name` cross-references as dependencies,
regenerates the routers, the catalog and the `cmsis-help` skill, and
rewrites the lock. It fails loudly on duplicate names, a name that collides
with a bundled or router skill, a category that is not in `SkillCategory`, a
`$name` reference that no longer resolves (one to a skill of a left-out
category is a warning), or a palette command or listed setting without a
one-liner in the `help` block.

`src/test/skillCatalog.test.ts` pins the catalog to the directories on disk
and the lock's content hash, so a hand edit under `cmsis-skills/` or a
forgotten re-sync fails `npm test`. Upstream has no tags or releases; the
commit SHA is the version.

A new upstream category needs its id in `SkillCategory`, a label and a place
in `SKILL_CATEGORY_ORDER` (`src/utils/skillCatalog.ts`), and a place in
`upstreamCategories` before the sync vendors it; a router for it is an entry
under `categories` in `scripts/skills.config.json`, and without one its
skills are slash commands of their own. A category that is not vendored
(bring-up, pack, ethos-u today) gets no router and no `cmsis-help` section,
so it changes none of the generated files.

Router descriptions are the text skills-aware harnesses use to decide when
to invoke the entry point. Keep them trigger-rich and under 1024 characters
(the Agent Skills limit — the test checks).

## The tool contract

`docs/agent-resources/tool-contract.md` holds the rules that keep agents on
the MCP tools rather than pyOCD, GDB, cbuild or a serial terminal in the
shell, and a table of shell commands with the tool that replaces each (#50).
Every sync copies them, each between its pair of marker comments
(`<!-- cmsis-developer-assistant:rules:begin -->` … `:end -->`, and the same
with `shell-to-tool`), into these files; the text outside the markers is left
as it is:

| File | Blocks |
|------|--------|
| `cmsis-debug-live/SKILL.md` | rules and table, right below the title |
| `cmsis-pack-docs/SKILL.md`, `add-board-layer/SKILL.md` | rules, right below the title |
| `docs/agent-resources/debug_instructions.md` | rules below the title (the overview of `get_debug_instructions`), table at the end of the `build` topic |
| `cmsis-help/SKILL.md` | rules first, table after the MCP tools (rendered by `src/utils/skillHelp.ts`) |

Edit the contract, never a copy: `src/test/toolContract.test.ts` fails when a
copy differs, and the next sync would overwrite it. The MCP server leads its
`instructions` with the same rules at run time.

## Installed layout

Each installed directory additionally contains `.cmsis-developer-assistant.json`
(`name`, `source`, `sha`, `extensionVersion`, `installedAt`, `hidden`). Skills
whose catalog entry is not `invocable` get `user-invocable: false` added to
their frontmatter, which hides them from the `/` menu in harnesses that
honour the field while keeping them model-invocable.
