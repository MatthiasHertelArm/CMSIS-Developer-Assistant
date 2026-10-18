# Knowledge tools (`knowledge`, experimental)

Three tools over a knowledge index: how-to knowledge next to the *what* of
the documentation tools. Procedures, rules, concepts, and the causes and
fixes of csolution, packchk and svdconv messages are knowledge units in
Markdown; the knowledge-base tooling builds them into one SQLite file,
`knowledge.db`, with the entities they apply to and the relations between
them. [docs/proposals/knowledge-base.md](../proposals/knowledge-base.md) has
the reasons and the open decisions.

The knowledge index is mandatory. The extension ships the core index
(`resources/knowledge/core.db`, copied in from the knowledge-base repository
before packaging, git-ignored) and the knowledge tools are always on.
`knowledge.indexPath` replaces the core index, for testing a rebuilt one.
Packs and the workspace add their own indexes to it.


- **Knowledge first.** A skill is loaded because its description matches
  the task; a knowledge unit is not. So with the gate on, the instructions
  open with one sentence that says it: before a CMSIS task, look the
  procedure up with `knowledge_search` and follow it (`KNOWLEDGE_FIRST`), and
  the first `get_session_status` repeats it in a line (`KNOWLEDGE_REMINDER`).
- **One installed skill.** `cmsis-help` is the only skill the extension
  installs. It is the health check and the router: the session state, the
  debug windows and the recent problems, then the debug topic or the knowledge
  procedure for the task. Every other procedure is a unit of the index. The
  skills of the upstream categories and the extension's own skills stay in
  `skills/` as the sources of those units (`skill2ku.py` reads the catalog,
  and its `installed` flag is what the installer obeys).
  The installer's sweep removes every other skill this extension installed.

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
| `src/core/knowledge/packIndexes.ts` | Where pack and workspace indexes are found (`PACK_INDEX`, `WORKSPACE_INDEX`) |
| `src/core/knowledge/search.ts` | `searchKnowledge`, `contextEntities`, `inScope`, `appliesIn`, `isIncomplete`, `knownMessages` |
| `src/core/knowledge/projectFacts.ts` | The facts of the active target |
| `src/knowledgeHandler.ts` | `handleKnowledgeSearch`, `handleKnowledgeGet`, `handleKnowledgeExpand`, the reply texts |
| `src/knowledgeTools.ts` | Tool names and schemas |
| `src/core/knowledge/browse.ts` | The browser's data: list, overview, one node, the neighbourhood, Markdown as HTML |
| `src/knowledgePanel.ts`, `src/knowledgePanelPage.ts` | The knowledge browser: messages and guards; the page's style and script |
| `src/packDocsHost.ts` | The gate, the settings and the host |
| `src/test/knowledge.test.ts` | An index written in the test, the retrieval cases of the prototype, the handler and the dispatch; a pack built by `cmsis-knowledge` in `src/test/fixtures/knowledge/packs` |
