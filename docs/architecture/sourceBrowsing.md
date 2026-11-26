# Source browsing (`source_find`, `source_get`, experimental)

Two tools that answer where a C or C++ symbol is declared, defined, used and
called. They are experimental, and so off unless the setting
`cmsis-developer-assistant.sourceBrowsing.enabled` is on.
[docs/proposals/2.9.5-source-browsing.md](../proposals/2.9.5-source-browsing.md)
has the reasons, the measurements and the decisions.

## Why it exists

An agent that works on a solution keeps asking the same three questions of
the source: where is this defined, who uses it, who calls it. A text search
finds text, not symbols: comments, the branches of other devices, statics of
the same name, across the workspace and the packs. It cannot say what a
register macro expands to for this device or who calls a function three
levels up. `lookup_symbol` answers for the linked image and `get_call_stack`
for a halted target; neither reads the source.

clangd answers these questions from an index built with the compile commands
of the active context, and a window with the Keil Studio Pack already runs it
for the editor.

## What it does, and what it leaves to others

The tools ask **the editor's clangd**: the language client of the clangd
extension, which that extension hands out as `exports.getApi(1).languageClient`.
No second clangd is started. The instance the editor runs is the only one
that is already configured for the active context, its index is built and in
memory, and a second process would cost between 150 MB and 1 GB in a window.

Everything that makes clangd answer belongs to someone else, and stays there:

| Needed | Whose it is |
| ------ | ----------- |
| The clangd extension | The Keil Studio Pack installs it |
| A clangd executable | The clangd extension finds one on the window's PATH or downloads one when the user confirms |
| The compile database of a context, `compile_commands.json` | cbuild writes it: in the setup CMSIS Solution runs for a loaded solution, and in every build |
| clangd pointed at it | CMSIS Solution writes `--compile-commands-dir=<out folder>` into the setting `clangd.arguments` and a `.clangd` file beside the project (`cmsis-csolution.generateClangSetup`), then restarts clangd |
| The index | clangd builds it in the background and keeps it beside the compile database |

The tools write nothing, install nothing and repair nothing. Where one of the
rows is missing, the call is refused with what is missing and whose step it
is (`TOOL_DISABLED`, or `TIMEOUT` for a client that is still starting). Two
things the tools do themselves, because nobody else does them for a caller
that is no editor:

- **The first document.** clangd loads a compile database, and with it the
  index, only when the first document is opened: before that it answers
  nothing by name. A client that has no document of the database yet is given
  one translation unit (`prime`).
- **A unit that changed on disk.** clangd does not read a file again that
  changed on disk while it is not open. A unit that is newer than its part of
  the index is opened before the call is answered (`refresh`), which makes
  clangd read it.

Opening means `vscode.workspace.openTextDocument`: the language client then
tells clangd, and no editor appears.

## Ideas needed to read the code

- **The client is asked for on every call.** `clangd.restart` makes a new
  client, and CMSIS Solution runs it whenever it rewrites the setup. So no
  client is kept: `acquireClangdClient` takes the current one, waits with a
  growing pause while it starts, and turns every way of not getting one into
  a typed refusal. A call that loses its client to a restart is made once
  more with the new one.
- **Requests go to the client, not through `vscode.execute…Provider`.** Those
  commands merge the answers of every provider of the window (the Microsoft
  C/C++ extension is often installed beside clangd) and pass the clangd
  extension's middleware.
- **A position needs an open document; a name does not.** Everything but
  `workspace/symbol` is asked at a position, and clangd refuses a position in
  a document it was not told about. `Lookup` opens each file it asks about,
  once per call, and repeats a request that was refused because the `didOpen`
  had not arrived yet.
- **The index has no macros and no locals by name.** The background index
  answers by name for functions, variables, types, fields and enumerators. A
  macro is in it only while an open document includes its header, a local
  variable never, an assembler file not at all. From a place where the name
  is used, clangd answers for all of them. So a name the index does not have
  is looked for in the translation units of the compile database, and the
  first use that clangd confirms answers (`searchUseSites`).
- **Three waits, each with its reason.** A name is asked again for a second
  while a new client loads its index from disk; then the use site is looked
  for, which is quick; only when clangd is still building the index (not
  every unit has a shard yet) is the name waited for longer.
- **The state of the index is read from disk.** The progress notifications of
  clangd belong to the clangd extension's status bar. The shards under
  `<compile database>/.cache/clangd/index` say which units are indexed and
  which are older than their file; the first line of every reply says how far
  the index is. A shard carries the file's name and a hash of its path that
  differs between clangd versions, so units of one file name are counted
  against the shards of that name: two `main.c` and one shard are one indexed
  unit, and the longer wait for an index that is still being built stays on.
- **An id is a place.** `name@path:line:column` is where the name stands, so
  the window keeps no table of ids and an id survives a reload. The name is
  in it so that it is found again nearby when the file changed, and so that
  the place answers only while the name stands there as a whole name: after
  a rename of `foo` to `foobar` the id of `foo` does not answer for
  `foobar`. Paths are shown relative to the solution folder and under
  `${CMSIS_PACK_ROOT}`, as `cbuild-run.yml` writes them.
- **`source_find` says what `source_get` returns.** A card lists the relations
  that exist for the symbol's kind, with their counts where a count costs
  milliseconds. Every list entry is `file:line` with the source line, and an
  entry that is a symbol is written as an id.
- **Routing.** The two ops ride the documentation dispatch. An absolute
  `fileFullPath` sends a call to the window that owns the file; a path
  relative to a solution names no window and follows the session.

## Limits

- clangd serves one project of a solution at a time, the one CMSIS Solution
  set up (the user chooses it in the CMSIS view); the first line of a reply
  names it, and says when it is not the active target's.
- The answers are as good as clangd's reading of the compile database. It
  reports some options of Arm Compiler 6 and GCC as errors, and that is why
  the tools do not offer clangd's diagnostics: the compiler's own are in
  `get_build_diagnostics`.
- Under a path that reaches the compile database through a symbolic link
  (CMake rewrites `/private/tmp` on macOS), clangd does not answer by name
  for symbols that exist in one source file only; the search for a use site
  covers them.
- A variable in a setting of the clangd extension that is a command
  (`${command:…}`) is not resolved.

## Where to look

| What | Where |
| ---- | ----- |
| The two tools, their arguments and descriptions | `src/sourceBrowseTools.ts` |
| One call from arguments to reply; the first document, the changed units, the waits, the retry after a restart | `src/sourceBrowseHandler.ts` |
| The window: the gate, the clangd extension, its settings, documents | `src/sourceBrowseHost.ts`, `src/core/sourceBrowse/host.ts` |
| The seam to the clangd extension and its refusals | `src/core/sourceBrowse/clangdApi.ts` |
| The wire shapes, declared here from the LSP specification | `src/core/sourceBrowse/protocol.ts` |
| Name, use site and id to a position; what clangd says there | `src/core/sourceBrowse/symbolQuery.ts`, `symbolId.ts`, `hoverText.ts` |
| References, call and type hierarchies with their limits | `src/core/sourceBrowse/relations.ts` |
| The compile database, the context's name, the shards | `src/core/sourceBrowse/context.ts` |
| The texts | `src/core/sourceBrowse/render.ts` |
| Tests against a scripted clangd | `src/test/sourceBrowse*.test.ts`, `src/test/sourceBrowseScript.ts` |
| The same questions against a real clangd (local, not CI) | `test/transport/source-clangd.js` |
