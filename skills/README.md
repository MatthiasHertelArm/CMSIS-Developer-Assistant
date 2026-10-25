# The extension's skills

Only `cmsis-help` and `catalog.json` ship in the VSIX (`.vscodeignore`), and
only `cmsis-help` is installed. On activation, and again when **CMSIS Developer Assistant:
Configure Agent** registers the agents, the extension copies `cmsis-help` —
the `installed` list of `scripts/skills.config.json`, the `installed` flag
of `catalog.json` — into the user's personal skills directories and removes,
marker-guarded, the skills earlier releases installed there; see the *Agent
Skills* section of `docs/user-guide.md`. Every other catalog entry is the
source of a unit of the knowledge index (`proc-<name>` in the core index
`resources/knowledge/core.db`, built in the knowledge-base repository, which
reads them through `catalog.json`); the directories stay here as those
sources. The Open-CMSIS-Pack/cmsis-skills procedures are not vendored here:
the knowledge base fetches and converts them itself.

| Path | What | Maintained how |
|------|------|----------------|
| `cmsis-debug-live/` | The extension's own live Cortex-M debugging workflow; hands over to `$debugger-troubleshooting` when a session will not start. Unit source (`proc-cmsis-debug-live`), not installed. | Authored here, except the tool-contract blocks (below). |
| `add-board-layer/` | Add a board layer to an existing csolution by interview. Unit source (`proc-add-board-layer`), not installed. | Authored here, except the tool-contract block. |
| `cmsis-bootstrap/` | From an empty VS Code window to a CMSIS solution that builds and debugs: finds what is missing, asks for the board, folder, compiler and probe, hands over to the project skills and to `cmsis_action open_solution`. Carries the starter `vcpkg-configuration.json`, an asset of its unit. Unit source (`proc-cmsis-bootstrap`), not installed. | Authored here, except the tool-contract block. |
| `cmsis-pack-docs/` | Page-cited lookups in the target's pack documentation through the documentation tools. Unit source (`proc-cmsis-pack-docs`), not installed. | Authored here (moved from the experimental CMSIS Pack Docs extension), except the tool-contract block. |
| `cmsis-help/` | The one installed skill: a health check of the session, the debug windows and the recent problems, then the debug topic (`get_debug_instructions`) or the knowledge procedure (`knowledge_search`) that fits the task. **Installed**, as a slash command; the only entry with `installed: true`. | Authored here; the tool-contract blocks are copied in. |
| `start-cmsis-project/`, `cmsis-debugger-setup/`, `fvp-debug-setup/`, `debugger-troubleshooting/` | The extension's own hidden skills (catalog source `extension`, `hidden` in `scripts/skills.config.json`): write the first solution for a board or device (the minimal project assets, or an example or template of the pack) and build it through `cmsis_action`; wire the debug adapter of a target and verify Load & Debug; make Run and Debug work against an Arm FVP (with the model shim and Dockerfile templates); find out why a debug or flash session fails. Unit sources (`proc-start-cmsis-project`, `proc-cmsis-debugger-setup`, `proc-fvp-debug-setup`, `proc-debugger-troubleshooting`), not installed; all four are reached by `$name` hand-overs from `cmsis-bootstrap`, `start-cmsis-project`, `cmsis-debugger-setup` and `cmsis-debug-live`. | Authored here, except the tool-contract block. |
| `catalog.json` | Name, description, category, kind, source, path, `dependsOn`, `installed` and `invocable` of every skill. The runtime installs its `installed` entries; the knowledge base reads the others as unit sources. | **Generated.** |

## Regenerating the catalog

```sh
npm run skills:sync   # no network: the catalog and the tool-contract blocks
```

Run it after editing a skill's frontmatter or `agents/openai.yaml`,
`scripts/skills.config.json` or the tool contract. It reads each skill the
config lists under `bundled`, records the `$name` hand-overs to other skills
of the extension as `dependsOn`, writes the catalog and copies the contract
blocks. It fails loudly on a skill without valid frontmatter, an installed
skill whose description is over the 1024-character Agent Skills limit, a
config without `cmsis-help` installed, and a `$name` hand-over, in a skill
or in a category's workflow, that names neither a skill of the extension nor
a procedure `proc-<name>` of the pinned core index. That check needs
`resources/knowledge/core.db`: run `npm run knowledge:fetch` first.

`src/test/skillCatalog.test.ts` pins the catalog to the directories on disk
and to the config, and repeats the hand-over check when the core index is
present, so a forgotten re-sync fails `npm test`.

The `categories` of the config are not skills any more. Their label, short
description, description and workflow are the text of the routing unit
`route-<id>` the knowledge base builds (`tools/routes2ku.py`).

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
| `docs/agent-resources/debug_instructions.md` | rules below the title (the overview of `get_debug_instructions`), table at the end of the `flash` topic |
| `cmsis-help/SKILL.md` | rules first, the table after them, then the health check (authored; `scripts/sync-skills.ts` copies the blocks in) |

Edit the contract, never a copy: `src/test/toolContract.test.ts` fails when a
copy differs, and the next sync would overwrite it. The MCP server leads its
`instructions` with the same rules at run time.

## Installed layout

Each installed directory additionally contains `.cmsis-developer-assistant.json`
(`name`, `source`, `sha`, `extensionVersion`, `installedAt`, `hidden`); the
marker is what lets a later sync replace or remove the directory. Today that
is `cmsis-help` alone. The installer still hides a skill whose catalog entry
is not `invocable` by adding `user-invocable: false` to its frontmatter, which
keeps it out of the `/` menu in harnesses that honour the field while keeping
it model-invocable; no installed entry needs it at present.
