# Agent skills shipped with the extension

Everything in this directory ships in the VSIX. On activation the extension
copies the skills the user selected (setting
`cmsis-developer-assistant.installedSkills`, command **Select Agent Skills**)
into their personal skills directories — or, when the selection is a
workspace setting, into that project's `.agents/skills` — see the *Agent
Skills* section of the top-level README.

| Path | What | Maintained how |
|------|------|----------------|
| `cmsis-debug-live/` | The extension's own live Cortex-M debugging workflow. Always installed. | Authored here, except the tool-contract blocks (below). |
| `add-board-layer/` | Add a board layer to an existing csolution by interview. Always installed. | Authored here, except the tool-contract block. |
| `cmsis-pack-docs/` | Page-cited lookups in the target's pack documentation through the documentation tools. Always installed. | Authored here (moved from the experimental CMSIS Pack Docs extension), except the tool-contract block. |
| `cmsis-help/` | The extension's own "what can I ask for?" skill: the tool rules, slash commands, member skills per category, VS Code commands, MCP tool groups, the shell commands they replace, settings. Always installed. | **Generated** from `catalog.json`, `package.json`, the `help` block of `scripts/skills.config.json` (`src/utils/skillHelp.ts`) and the tool contract; the test re-renders it. |
| `cmsis-skills/<name>/` | The [Open-CMSIS-Pack/cmsis-skills](https://github.com/Open-CMSIS-Pack/cmsis-skills) skills, verbatim, flattened by name. `LICENSE` is upstream's Apache-2.0. | **Generated** — never edit; re-sync. |
| `cmsis-project/`, `cmsis-bring-up/`, `cmsis-pack/` | One router skill per upstream category: a dispatch table to the member skills plus a typical workflow. Gives agents one slash command per category. | **Generated** from `scripts/skills.config.json`. |
| `catalog.json` | Name, description, category, kind, source, path and `dependsOn` of every skill. The runtime and the tests read only this. | **Generated.** |
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
`generic-mcu-skills/skills/<category>/<name>/` into `cmsis-skills/<name>/`,
reads each skill's frontmatter and `agents/openai.yaml`, records the `$name`
cross-references as dependencies, regenerates the routers, the catalog and
the `cmsis-help` skill, and rewrites the lock. It fails loudly on duplicate
names, a name that collides with a bundled or router skill, an unknown
category, a `$name` reference that no longer resolves, or a palette command
or listed setting without a one-liner in the `help` block.

`src/test/skillCatalog.test.ts` pins the catalog to the directories on disk
and the lock's content hash, so a hand edit under `cmsis-skills/` or a
forgotten re-sync fails `npm test`. Upstream has no tags or releases; the
commit SHA is the version.

A new upstream category needs its id in `SkillCategory`, a label and a place
in `SKILL_CATEGORY_ORDER` (`src/utils/skillCatalog.ts`) before the sync
accepts it; its router needs an entry under `categories` in
`scripts/skills.config.json`, and the sync warns about a category that has
skills but no router. A category without skills at the pinned commit (such
as `ethos-u` today) gets no router, no picker heading and no `cmsis-help`
section, so it changes none of the generated files.

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
installed only as dependencies of a pick get `user-invocable: false` added to
their frontmatter, which hides them from the `/` menu in harnesses that
honour the field while keeping them model-invocable.
