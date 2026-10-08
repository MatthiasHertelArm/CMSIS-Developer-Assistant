# Knowledge tools (`knowledge`, experimental)

Three tools over a knowledge index: how-to knowledge next to the *what* of
the documentation tools. Procedures, rules, concepts, and the causes and
fixes of csolution, packchk and svdconv messages are knowledge units in
Markdown; the knowledge-base tooling builds them into one SQLite file,
`knowledge.db`, with the entities they apply to and the relations between
them. [docs/proposals/knowledge-base.md](../proposals/knowledge-base.md) has
the reasons and the open decisions.

This is a local experiment. No index ships with the extension, the gate
`knowledge.enabled` is off by default, and the user names the base file in
`knowledge.indexPath`. Packs and the workspace add their own indexes to it.

## What it is responsible for

- Reading the index as it is, read-only, and refusing a file that is not one
  or has another schema version.
- Search that returns summaries within a token budget, with the exact error
  message first, filtered by the project the window has active.
- The whole unit on request, never clipped, and one hop in the graph.
- Naming, in the result of a failed build, the unit of an error message the
  index knows.

It leaves to the knowledge base: the units, their review status, the index
build and its checks. It does not read the vector table of the index;
search is BM25 and exact symptoms.

## Ideas needed to read the code

- **A set of indexes, not one file.** `KnowledgeReader` is what search, the
  tools and the browser read; `KnowledgeIndex` is one file, `KnowledgeSet`
  several read as one: the base file of the setting, then every
  `knowledge.db` an installed pack carries (`<root>/<Vendor>/<Pack>/<version>/`,
  or a pack registered from a folder in `.Local/local_repository.pidx`) and
  `.cmsis/knowledge.db` of the workspace (`packIndexes.ts`). All are read
  whatever the active target: the `applies_to` filter keeps a pack's units
  to its devices, and an entity a pack names (its family) continues in the
  base graph. Ids are looked up in order, so the base wins a clash; BM25
  lists are merged by rank, since scores of different files are not
  comparable; everything else is the union. A hit and `knowledge_get` say
  which index a unit came from. The set is reopened when any file changes,
  appears or goes.
- **`node:sqlite`.** The index is opened with the SQLite that Node brings,
  loaded through `process.getBuiltinModule` on first use, so nothing native
  ships and a VS Code without the module gets a typed refusal.
- **The project is resolved, not passed.** The tools take no device,
  compiler or file. `projectFacts` asks the documentation and build-artefact
  cores for the active `*.cbuild-run.yml`, the cores in the device pack's
  PDSC on disk, the compiler and the components. `contextEntities` turns
  them into entity ids and adds what the index knows above a device or
  board. So an index without the pack entities works, and so does a device
  whose pack exists only locally.
- **Applies-to filter.** A unit without targets holds everywhere. Otherwise
  each dimension it targets (core, toolchain, family, …) needs one target in
  the context; a dimension the context does not mention leaves the unit in,
  marked `unverified`. The tool dimension is different: it belongs to the
  question, so only the `tools` argument filters by it. A unit that
  `refines` another replaces it.
- **Ranking.** BM25 ranks are fused as in the prototype; the function
  words of a question (*how*, *my*, *the*) do not take part. An exact
  message outranks everything, and of several the one on the earliest line
  leads: in tool output the first error is the cause, later ones follow
  from it. A procedure gets a small prior, so that a task question finds
  the procedure before reference text converted from the documentation,
  while an API question still finds the API. Routing units get none; the
  agent reads them by id. The knowledge base's golden set
  (`tests/golden.json`, run by `tests/eval_search.js` against this code)
  measures the effect of such changes.
- **Incomplete units.** A unit whose cause or body is a placeholder is left
  out of search and counted; `knowledge.includeIncomplete` shows it. A build
  result never names one.
- **Routing.** The three ops ride on the pack-docs dispatch
  (`PackDocsHandlers.knowledge`), so the router forwards them to the window
  that owns the workspace like a documentation op.
- **Known messages.** The window sets a lookup in
  `core/knowledge/knownMessageLookup.ts` when the gate is on; the build
  diagnosis appends at most three lines to its text.

- **Knowledge first.** A skill is loaded because its description matches
  the task; a knowledge unit is not. So with the gate on, the instructions
  open with one sentence that says it: before a CMSIS task, look the
  procedure up with `knowledge_search` and follow it (`KNOWLEDGE_FIRST`), and
  the first `get_session_status` repeats it in a line (`KNOWLEDGE_REMINDER`).
- **Without skills.** `knowledge.replaceSkills` makes the skill sync want
  `cmsis-help` alone, so `/cmsis-help` stays as the one slash command — in
  its `knowledge` variant (`skills/cmsis-help-knowledge/`, rendered by the
  same generator in the other mode and put under the skill's name by
  `catalogForInstall()`), which lists the units of the index (`proc-<name>`,
  `route-<category>`) where the other lists slash commands and member
  skills, and says how to work from the knowledge tools. One file for both
  modes, with a condition for the agent to evaluate, did not hold: given a
  table of `/commands`, a model repeats the table. The installer's sweep
  removes every other skill it installed, and
  the instructions and the two tool descriptions that name
  `cmsis-debug-live` name `get_debug_instructions` instead. The extension's
  own skills are procedures of the index too: the knowledge-base tooling
  reads them from this repository's `skills/` through `catalog.json`
  (`skill2ku.py`), and writes one routing unit per category, `route-<domain>`,
  from `scripts/skills.config.json` (`routes2ku.py`). The skills stay
  authored here; the index is a build of them.
- **Files of a unit.** A skill's templates and scripts are `asset` entities
  with the file as body, referenced by their procedure. `knowledge_get` on a
  procedure lists them by the path its text uses, and returns one by its id
  (`KnowledgeIndex.assetsOf`). They are not in the search index.

## The knowledge browser

The command **Open Knowledge Browser** shows the index to the people who
write and review it: a list of all units with filters and the tools' search,
one node in full, its relations as a graph that can be walked, and the
figures of the index. It reads the same open index as the tools and changes
nothing; it works with the gate off, since it serves a person, not an agent.

- **Data and page are apart.** `core/knowledge/browse.ts` turns the index
  into plain data (`unitRows`, `overviewOf`, `detailOf`, `graphAround`) and
  is tested without an editor. `knowledgePanel.ts` passes messages;
  `knowledgePanelPage.ts` is the page's stylesheet and script.
- **Collections.** Filters by type, domain and collection: the source a
  unit came from (`zephyr`, `issues-pyocd`, …), so a reviewer can take one
  source at a time. Units the knowledge base builds without a collection
  are grouped by kind (`skills`, `error-catalog`, `routing`, `extracted`).
- **Text from anyone.** A unit's Markdown is rendered by `renderMarkdown`,
  which escapes the source and then adds its own tags, so the page never
  gets a tag or attribute of the source. The page's script runs under a
  nonce and builds everything else with `textContent`.
- **What the page may ask for.** Open an `http`/`https` link, open the
  Markdown file the index names for a unit, copy an id, open the knowledge
  settings. Each is checked in `knowledgePanel.ts`.
- **The graph is laid out in the page**: the node in the centre, its
  relations on a ring, theirs on a second one, at most 70 nodes.

## Where to look

| Path | What |
| ---- | ---- |
| `src/core/knowledge/store.ts` | `KnowledgeReader`, `KnowledgeIndex` (one file: the SQL over `nodes`, `edges`, `nodes_fts`), `KnowledgeSet` (several, merged) |
| `src/core/knowledge/packIndexes.ts` | Where pack and workspace indexes are found |
| `src/core/knowledge/search.ts` | `searchKnowledge`, `contextEntities`, `appliesIn`, `isIncomplete`, `knownMessages` |
| `src/core/knowledge/projectFacts.ts` | The facts of the active target |
| `src/knowledgeHandler.ts` | `handleKnowledgeSearch`, `handleKnowledgeGet`, `handleKnowledgeExpand`, the reply texts |
| `src/knowledgeTools.ts` | Tool names and schemas |
| `src/core/knowledge/browse.ts` | The browser's data: list, overview, one node, the neighbourhood, Markdown as HTML |
| `src/knowledgePanel.ts`, `src/knowledgePanelPage.ts` | The knowledge browser: messages and guards; the page's style and script |
| `src/packDocsHost.ts` | The gate, the settings and the host |
| `src/test/knowledge.test.ts` | An index written in the test, the retrieval cases of the prototype, the handler and the dispatch |
