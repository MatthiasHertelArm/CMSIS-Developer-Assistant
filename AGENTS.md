# CMSIS Developer Assistant: notes for coding agents

Read this before changing the repository. It says what the extension does,
where each part lives, how to build and test it, and the house rules for
code and documentation.

## What the extension does

The CMSIS Developer Assistant is a VS Code extension with an MCP (Model
Context Protocol) server built in. Through that server an AI coding agent
drives VS Code's debugger, which in turn talks to the debug adapter over DAP.
The focus is Arm Cortex-M firmware on sessions of the CMSIS Debugger
extension (launch configurations of type `gdbtarget`): memory, core
registers, peripheral registers described by the device SVD, decoded
Cortex-M fault status, the build, flash and debug actions of the CMSIS
Solution extension, and serial consoles. Other debug types, such as Python,
Node.js or C/C++ on the host, are still served by the generic tools. The
extension also ships a knowledge index of the CMSIS procedures and reads it
through the knowledge tools, installs one Agent Skill (`cmsis-help`, the entry
point and health check), writes its tool rules into the agents' rule files
when the user confirms it, and offers tools over the target's documentation
and build artefacts. An experimental pair of tools, off by default, answers
where a symbol is defined, used and called, from the clangd the editor runs.

The project started as a fork of microsoft/DebugMCP. The code that still
came from there has since been replaced by independently written code
(issue #53); `docs/provenance/README.md` describes how.

## From agent to target

```txt
AI agent: Claude Code, Codex, Cursor, Cline, Copilot, ...
   |  MCP over Streamable HTTP, POST http://localhost:3001/mcp
   v
DebugMCPServer + debugTools.ts          one MCP server per session (router window)
   |
RoutingDebuggingHandler                 picks the VS Code window that owns the target
   |  HTTP POST /op with that window's token
   v
ControlServer -> DebuggingHandler -> DebuggingExecutor -> VS Code debug API, DAP
                                                                |
                               gdbtarget: CDT GDB debug adapter -> arm-none-eabi-gdb
                                                                |
                                       pyOCD or J-Link GDB server -> SWD/JTAG -> Cortex-M
```

Every window of VS Code runs its own extension host. The window that binds
the MCP port serves all agents and forwards each call to the window whose
workspace or debug session it concerns; with a single window, the router
simply forwards to itself.

## Components

| Component | Code | Job | Design notes |
| --------- | ---- | --- | ------------ |
| `DebugMCPServer` | `src/debugMCPServer.ts`, `src/debugTools.ts`, `src/core/serverInstructions.ts` | The loopback MCP endpoint: sessions, transport, measurement; the instructions (tool rules first), tools and resources each session offers | [docs/architecture/debugMCPServer.md](docs/architecture/debugMCPServer.md) |
| `DebuggingHandler` | `src/debuggingHandler.ts`, `src/handler/` | One `handle*` method per debugging tool: state gates, waits for the stop, the texts agents read, `cmsis_action`, `flash` | [docs/architecture/debuggingHandler.md](docs/architecture/debuggingHandler.md) |
| `DebuggingExecutor` | `src/debuggingExecutor.ts`, `src/executor/` | The one caller of VS Code's debug API and of DAP requests, each under a deadline | [docs/architecture/debuggingExecutor.md](docs/architecture/debuggingExecutor.md) |
| `DebugState` | `src/debugState.ts` | Value object for location, stack and breakpoints, rendered in a full and a compact form | [docs/architecture/debugState.md](docs/architecture/debugState.md) |
| `DebugConfigurationManager` | `src/utils/debugConfigurationManager.ts` | The `launch.json` picker and configurations synthesized from the file type for `start_debugging` | [docs/architecture/debugConfigurationManager.md](docs/architecture/debugConfigurationManager.md) |
| Window routing | `src/windowCoordinator.ts`, `src/routingDebuggingHandler.ts`, `src/controlServer.ts`, `src/utils/workspaceRegistry.ts`, `src/core/opTable.ts`, `src/core/windowHealth.ts`, `src/windowStatus.ts`, `src/core/windowStatus.ts` | Router and worker windows, the window registry and the default target, forwarding of every op, fences and health checks on the control channel, the status-bar item and Select Target Window | [docs/architecture/windowRouting.md](docs/architecture/windowRouting.md) |
| `AgentConfigurationManager` | `src/utils/agentConfigurationManager.ts`, `src/core/agentRules.ts`, `src/utils/agentRuleFiles.ts` | Registers the server in AI agents' configuration files, installs the `cmsis-help` skill (and removes, marker-guarded, the skills earlier releases installed), and writes the tool rules into the agents' rule files the user confirms | [docs/architecture/agentConfigurationManager.md](docs/architecture/agentConfigurationManager.md) |
| `PackDocsHandler` / `BuildInfoHandler` | `src/packDocsHandler.ts`, `src/buildInfoHandler.ts`, `src/core/packDocs/`, `src/core/buildInfo/`, `src/docService/` (the document service: contract and emulator, isolated), `src/targetDocsView.ts` | Documentation tools (pack PDFs, Arm documents, user and workspace documents, core SVDs) and build-artefact tools (ELF, map file, build log); both on by default and routed like every other op | [docs/architecture/packDocs.md](docs/architecture/packDocs.md) |
| `KnowledgeHandler` | `src/knowledgeHandler.ts`, `src/knowledgeTools.ts`, `src/core/knowledge/`, `src/knowledgePanel.ts`, `src/knowledgePanelPage.ts` | Knowledge tools over the knowledge index — the core index the extension ships (`resources/knowledge/core.db`), the `.knowledge/knowledge.db` of the installed packs, a workspace folder's `.cmsis/knowledge.db`: search by summaries scoped to the active target, the whole unit, one hop in the graph; always on, routed with the documentation ops. The knowledge browser, a read-only panel over the same index | [docs/architecture/knowledge.md](docs/architecture/knowledge.md) |
| `SourceBrowseHandler` | `src/sourceBrowseHandler.ts`, `src/sourceBrowseTools.ts`, `src/sourceBrowseHost.ts`, `src/core/sourceBrowse/` | Experimental source-browsing tools, off unless `sourceBrowsing.enabled`: `source_find` (what a C or C++ symbol is, where it is declared and defined, what can be asked about it) and `source_get` (its definition, references, callers, callees, type hierarchy), asked of the editor's clangd through the clangd extension's language client. Nothing is installed or configured: a missing clangd or compile database is a refusal that says so | [docs/architecture/sourceBrowsing.md](docs/architecture/sourceBrowsing.md) |
| `skills/` | `skills/cmsis-help/`, `skills/catalog.json` | The one installed skill and its generated installer catalog. Knowledge procedure sources, assets and routing definitions are authored in `cmsis-knowledge-base/sources/cda-procedures`; the extension consumes their pinned index | [skills/README.md](skills/README.md) |

Smaller parts: `src/serialHandler.ts` with `src/core/serialController.ts`,
`src/core/serialMonitorBridge.ts` and `src/core/serialLease.ts` (the
`serial_*` tools and when a held port is released;
[docs/architecture/serial.md](docs/architecture/serial.md));
`src/utils/sessionStateTracker.ts` (which session is active, stop events);
`src/solutionNotice.ts` (the warning at activation for a CMSIS Solution
without API version 3);
`src/cmsisJobTracker.ts` (the window's CMSIS tasks, the `cmsis_action` jobs
and what holds the probe); `src/runOutputCapture.ts` with
`src/core/runOutput.ts` (what the CMSIS Run task printed, as VS Code reports
its terminal); `src/cmsisBuildDiagnosis.ts` with
`src/core/buildFailure.ts` and `src/core/buildResult.ts` (the error lines
of a failed build, the warnings of a successful one);
`src/core/problemJournal.ts`, `src/core/problemFeed.ts` and
`src/windowProblems.ts` (the window's problem journal behind
`get_recent_problems`; sources append through `problemJournal()`);
`src/core/` in general (SVD parsing, fault decoding and triage, CMSIS
target selection and task classification, tool metrics, topic slicing of
the agent guide), where most modules do not import `vscode` at all.

## Entry points

- **Activation:** `activate()` in `src/extension.ts`. esbuild bundles it into
  `dist/extension.js`, the `main` of `package.json`; the extension activates
  on `onStartupFinished` and `onDebug`, and earlier, during start-up, in a
  workspace with a `*.csolution.yml`. It binds the MCP endpoint before it
  installs the skill or migrates agent files: Kimi Code's VS Code extension
  connects once, at its own activation, and never retries.
- **Extension dependency:** the manifest names CMSIS Solution
  (`Arm.cmsis-csolution`) in `extensionDependencies`. VS Code installs it
  with the extension and activates it first, in every window, so
  `activate()` starts when CMSIS Solution's has resolved (0.06 to 0.1 s
  later in a window that has started before, 2.6 s at the first start after
  CMSIS Solution was installed; 1.72.0 on macOS, 2026-11-23) and not at all
  where CMSIS Solution is missing, disabled or fails to activate. A manifest
  cannot ask for a version: `src/solutionNotice.ts` warns at activation when
  the extension offers no API version 3.
- **MCP endpoint:** `http://localhost:{serverPort}/mcp` (port 3001 by
  default), Streamable HTTP, bound to 127.0.0.1. The legacy `/sse` route
  answers 410.
- **Copilot in VS Code** finds the server through the MCP server definition
  provider `cmsis-developer-assistant`; no configuration file is needed.

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm run compile` | Type-check and compile `src/` with `tsc` into `out/` (what the tests run) |
| `npm run check-types` | Type-check only, no output files |
| `npm run watch` | `tsc` in watch mode |
| `npm run build` | `check-types`, then the production esbuild bundle in `dist/` |
| `npm run package` | `build`, then a platform-specific VSIX (`scripts/package.ts`) |
| `npm run lint` | ESLint over `src/` |
| `npm run lint:md` | markdownlint over the repository's Markdown with `.github/markdownlint.jsonc` (`docs/architecture/`, `CHANGELOG.md` and build folders are skipped) |
| `npm test` | Compile and lint first (`pretest`), then run `src/test/*.test.ts` inside VS Code with `vscode-test`, coverage into `coverage/`. The test window opens its Output view on the extension's log (`src/test/revealLog.ts`). The run does not install the manifest's extension dependency (`skipExtensionDependencies` in `.vscode-test.mjs`): the suites serve stand-ins of CMSIS Solution and expect a VS Code without it. VS Code therefore does not activate the extension in this run, the suites call the modules directly, and `config-scenarios.js` is the check of `activate()` |
| `npm run test:transport` | Compile, then `test/transport/session-lifecycle.js` and `test/transport/two-window-routing.js` over real sockets |
| `npm run test:surface` | Compile, then compare everything an agent can see without hardware — the initialize result, `tools/list`, the resources and each tool's reply without a session — with `test/transport/surface.snapshot.json`. Pass `-- --update` only for an intended change. The snapshot depends on the host, so this is a local check, not a CI job |
| `npm run test:mutation` | Compile, then mutation testing with Stryker (`stryker.config.mjs`): copies the checkout into `.stryker-tmp/`, inserts mutants into the files of `src/core/`, compiles the copy with `compile` and runs the unit tests headlessly, in Node with `test/transport/vscode-stub.js`, against each mutant. A mutant no test fails on has survived and marks behaviour no test pins down; `reports/mutation/mutation.html` shows them by line, `mutation.json` beside it is for a script or an agent. Six suites are left out (`mochaOptions.ignore`): they need more of VS Code than the stub offers. A test that fails for a reason of its own would count as a kill, so one with a wall-clock limit skips itself under instrumentation (`'__stryker__' in globalThis`), as the stress test of `symptomPattern.test.ts` and the two watcher tests of `docService.test.ts` do; their suites stay in the run, and `docService.test.ts` has the only tests of `src/core/packDocs/documentApi.ts`. Run it for one module, `-- --mutate src/core/<file>.ts` (about two minutes for 200 mutants); the whole of `src/core/` has about 31 000 mutants (31 299 in 112 files on 2026-11-25), about five hours at that rate. Incremental: a second run tests only the mutants whose code or tests changed, `-- --force` tests all again. Needs Node 22. A local check, not a CI job |
| `npm run provenance:check` | Per file, the lines shared with microsoft/DebugMCP (clones it once, so it needs network the first time). With `-- --gate` it fails when a gated file — any path DebugMCP ever had, or any file added since the rewrite began, unless it still carries the Microsoft line or is on the script's exemption list — contains more than five lines found anywhere in DebugMCP's history. `-- --lines <file>` prints DebugMCP text; do not use it while writing independent code |
| `npm run skills:sync` | Regenerate `skills/catalog.json` from the skills `scripts/skills.config.json` lists and copy the tool-contract blocks into their files; no network. Each `$name` hand-over must name a skill of the extension or a procedure of the pinned core index, so `core.db` must be fetched. Run it after editing a skill's frontmatter, `scripts/skills.config.json` or `docs/agent-resources/tool-contract.md` |
| `npm run knowledge:fetch` | Download the core knowledge index `resources/knowledge/core.lock.json` pins (a release in the public repository `MatthiasHertelArm/cmsis-knowledge-index`, where the knowledge base publishes its index) into `resources/knowledge/core.db` when the file is missing or its sha256 differs; hash and size checked; the same for `resources/knowledge/SOURCES.md`, the attribution of the index's sources, which is committed (`sources`, `sourcesSha256` of the lock). The CI package job runs it before packaging |
| `npm run knowledge:check` | Verify only that `core.db` is the pinned index and `SOURCES.md` the release's; exit 1 when either is missing or differs. `npm run package` runs the same check and refuses a VSIX without the pinned index (`--index-unpinned` lets a present, rebuilt index through with a warning) |
| `npm run knowledge:update -- <version>` | Pin the release `core-<version>` of the index repository: reads its `knowledge-core-<version>.json` and rewrites the lock; then `knowledge:fetch` |

Behaviour oracles, run with `node` after `npm run compile`:
`test/transport/dap-scenarios.js` (tool replies and adapter traffic over
scripted `gdbtarget` sessions), `test/transport/config-scenarios.js` (agent
configuration files, launch configurations, activation) and
`test/transport/executor-cases.js` (the executor alone). The first two take
`--update` for an intended change. `test/transport/packaged-vsix.js <vsix>`
checks a built package. `test/transport/source-clangd.js` asks the source
tools' questions of a clangd of the machine (from the `PATH`, or `CLANGD`)
over a small project it writes; its answers depend on that clangd, so it is a
local check. Without a clangd on the `PATH` it says so and passes; a `CLANGD`
that is no clangd, a clangd that exits or stays silent, and a run that ends
before its summary fail.

## Settings

| Setting | Default | Effect |
| ------- | ------- | ------ |
| `cmsis-developer-assistant.serverPort` | 3001 | Port of the MCP server |
| `cmsis-developer-assistant.timeoutInSeconds` | 180 | Time limit of debugging operations; waits for a stop or a session never exceed 60 s |
| `cmsis-developer-assistant.dapRequestTimeoutMs` | 10000 | Deadline of one DAP request |
| `cmsis-developer-assistant.memoryReadTimeoutMs` | 30000 | Deadline of a read that takes several requests (memory, registers, peripherals) |
| `cmsis-developer-assistant.redactSecrets` | `true` | Withhold variable and expression values that look like credentials; raw target reads are never redacted |
| `cmsis-developer-assistant.build.diagnosticRerun` | `true` | After a failed build, and after one that exited 0 without rewriting its image (CMSIS Solution reports 0 for failed builds too), re-run cbuild once with `--log` (no pack download, RTE update or clean; 30 min cap, also stopped by `cmsis_action stop_build`, and a stopped re-run reports only what it printed before the stop) so the `cmsis_action` result shows the error lines; off leaves only the csolution messages of `cbuild-idx.yml`. Not used where CMSIS Solution hands out the result it captured for the build task (`getBuildResult` of its API version 3): the exit code and the lines are then the build's own. Scope `window` |
| `cmsis-developer-assistant.serial.enabled` | `true` | Offer the eleven `serial_*` tools |
| `cmsis-developer-assistant.serial.idleCloseSeconds` | 300 | Release a serial port an agent opened after this many seconds without a serial tool call; 0 is off. Scope `window` |
| `cmsis-developer-assistant.telemetry.jsonlPath` | `""` | Append one JSON line per tool call to this file; empty is off |
| `cmsis-developer-assistant.agentRules.install` | `"ask"` | `ask`: step 2 of the setup offers to add the tool rules to the agents' rule files, each change shown as a diff and written only when confirmed, and activation offers to update the blocks it wrote when the rules change; `never`: no rule file is touched. Scope `application` |
| `cmsis-developer-assistant.packDocs.enabled` | `true` | Offer the five documentation tools; off drops them from the tool list. PDF text comes from the bundled pdf.js, or from `pdftotext` when `packDocs.extractor` says so; `packDocs.*` also set the size limit, unlisted pack PDFs, the workspace and user document folders, whether a failed `fetch_doc` is written into CMSIS Solution's `~/.cmsis/docs.yml` (`packDocs.inventoryRequests`, off), and who keeps the documents (`packDocs.documentService`: `auto` = CMSIS Solution's service or the emulator, `emulated`; the emulator keeps them in CMSIS Solution's folder `~/.cmsis/`: `docs.yml`, `docs.xtra.yml` for what that file has no field for, copies and their search index under `docs/`); `packDocs.userDocsDir` names the retired user folder, which is no longer read: a notice says so once when it still holds PDFs |
| `cmsis-developer-assistant.buildInfo.enabled` | `true` | Offer the five build-artefact tools; off drops them from the tool list; `buildInfo.maxSymbols` (20) and `buildInfo.logGlobs` tune them |
| `cmsis-developer-assistant.sourceBrowsing.enabled` | `false` | Offer the two source-browsing tools (experimental, and therefore off by default); they answer from the editor's clangd and install or configure nothing |
| `cmsis-developer-assistant.knowledge.indexPath` | (empty) | The knowledge index the knowledge tools read, always on. Empty uses the core index the extension ships (`resources/knowledge/core.db`); a path replaces it, for testing a rebuilt index. Packs and the workspace add their own indexes. Read on every call. |
| `cmsis-developer-assistant.knowledge.includeIncomplete` | `false` | Include placeholder knowledge units in searches. Off leaves them out; failed-build hints never name them. Read on every call. |

`agentRules.install` takes effect at once, `redactSecrets` is read on every call, `build.diagnosticRerun` for
every failed build and `serial.idleCloseSeconds` at each `serial_open`. The
port, the timeouts, the tool-group switches and the telemetry file are read
at activation; after a change the window has to be reloaded, and the
extension offers to do it when the port, `packDocs.enabled`,
`buildInfo.enabled` or `sourceBrowsing.enabled` changes.

## Documents served to agents

The MCP server offers these resources (`registerResources()` in
`src/debugTools.ts`), so that agents can learn the workflow at run time:

| Resource URI | Source | Content |
| ------------ | ------ | ------- |
| `cmsis-developer-assistant://docs/debug_instructions` | `docs/agent-resources/debug_instructions.md` | The debugging workflow; `get_debug_instructions` serves it by topic |
| `cmsis-developer-assistant://docs/cmsis-embedded-guide` | `docs/agent-resources/cmsis-embedded-guide.md` | Cortex-M debugging knowledge |
| `cmsis-developer-assistant://docs/troubleshooting/embedded` | `docs/agent-resources/troubleshooting/embedded.md` | Embedded troubleshooting tips |
| `cmsis-developer-assistant://docs/troubleshooting/<lang>` | `docs/agent-resources/troubleshooting/<lang>.md` | Tips per language, for `python` and `cpp` (C and C++) |
| `cmsis-developer-assistant://stats` | — | Tool-call statistics of the session and the server, JSON |

`docs/agent-resources/tool-contract.md` is not a resource of its own. It
holds the tool rules (#50), which keep agents on the MCP tools instead of
pyOCD, GDB, cbuild or a serial terminal in the shell, and a table of shell
commands with the tools that replace them. The server starts its
`instructions` with the rules, and the first `get_session_status` of a session
repeats them in one line, or whole for a client that never shows the model the
instructions (Kimi Code). `npm run skills:sync` copies both
blocks between `<!-- cmsis-developer-assistant:<block>:begin -->` and `…:end -->`
markers into `cmsis-help` and `debug_instructions.md`
(`src/core/toolContract.ts`). Edit the contract, never a copy;
`src/test/toolContract.test.ts` compares them and holds the rules to at most
ten non-empty lines after the heading and under 1 600 bytes in total. Tool
descriptions never repeat the contract: `tools/list` rides along on every
turn, and `test/transport/session-lifecycle.js` pins its size.

`debug_instructions.md` is split into topics by
`<!-- topic: name | blurb -->` … `<!-- /topic -->` comments, which
`src/core/instructionTopics.ts` parses. Keep the markers and the topic names;
`src/test/instructionTopics.test.ts` and `src/test/debugSkillGuidance.test.ts`
also pin the overview to at most 3 700 bytes without the tool rules, each
served topic to at most 7 000 bytes, and a few phrases.

## Dependencies

- `@modelcontextprotocol/sdk`: `McpServer` and `StreamableHTTPServerTransport`
- `zod`: the input schema of every tool
- `express`: the HTTP app behind `/mcp`
- `jsonc-parser`: reads `launch.json`, comments and trailing commas included
- `js-yaml`: reads the csolution's target-types and the YAML the CMSIS tools
  write (`cbuild-idx.yml`, `tools-environment.yml`), scalars kept as strings
- `serialport`: the serial tools; left out of the esbuild bundle because of
  its native binary, and shipped in `node_modules` (see
  `docs/packaging-esbuild.md`)
- `pdfjs-dist`: PDF text for the documentation tools, on a worker thread
- `fast-check` (dev): property-based tests inside the mocha suites, with a
  fixed seed so that a mutation run judges the same values every time

## Writing code

These rules follow from `tsconfig.json`, `eslint.config.mjs` and the code as
it is:

- **Language:** TypeScript with `strict` on, target and library ES2022,
  `module` Node16 (CommonJS output). Unit tests are `src/test/*.test.ts` and
  compile with the sources.
- **Layout:** four spaces per indent level, no tabs; semicolons; single
  quotes; braces around every `if`, `else`, `for` and `while` body (ESLint
  `curly`).
- **Comparisons and errors:** `===` and `!==` (`eqeqeq`). Throw `Error`
  objects, never literals (`no-throw-literal`), with a message that says what
  failed. A caught value is `unknown` until checked.
- **Imports:** `import * as vscode from 'vscode'` first, then Node built-ins
  and packages, then this repository's modules; `import type` for type-only
  imports, which keep the place of their module. `src/test/importOrder.test.ts`
  checks the order. Import names are camelCase or PascalCase (ESLint naming
  rule).
- **Names:** camelCase for functions, methods and variables; PascalCase for
  classes, interfaces and types; UPPER_SNAKE_CASE for module constants such as
  limits and fixed texts. Only the three layer contracts carry an `I` prefix:
  `IDebuggingHandler`, `IDebuggingExecutor`, `IDebugConfigurationManager`.
- **Types:** give parameters and return values explicit types. Avoid `any`;
  use `unknown` for values of unknown shape.
- **Time:** async/await throughout. Every call that reaches the hardware has
  a deadline (`withTimeout()`, `customRequestWithTimeout()` in
  `src/utils/timeout.ts`); a wait that polls backs off exponentially, as
  `awaitLiveSession()` in the handler does.
- **Logging:** `logger` from `src/utils/logger.ts` (`debug`, `info`, `warn`,
  `error`, each with an optional detail), which writes to the *CMSIS
  Developer Assistant* output channel. No `console.log` in extension code.
  `warn` and `error` are for what the user can act on; a routine outcome
  (an expected refusal, a fallback taken, a wait answered, a line per tool
  call) is `info` or `debug`. The channel shows Info and above unless the
  user sets its level to Debug.
- **Without VS Code:** no module calls the `vscode` API at load time; the
  transport harness and `test/transport/packaged-vsix.js` load the code under
  a minimal stub. Logic that needs no editor goes into modules without a
  `vscode` import (most of `src/core/`, `src/debugState.ts`,
  `src/debugMCPServer.ts`), where tests reach it directly.
- **Comments:** each module opens with a comment that says what it is for;
  exported classes and functions carry `/** … */` comments.
- **Agent-visible text:** tool names, descriptions, instructions and replies
  are recorded in `test/transport/surface.snapshot.json` and
  `test/transport/dap-scenarios.snapshot.json`. Change them on purpose,
  update the snapshot in the same commit and say in the message what
  changed. `registerTool('…'` calls keep literal tool names:
  `src/test/skill.test.ts` checks the installed help skill's `allowed-tools`; the knowledge base checks its procedure sources against the debugger tool contract.

ESLint reports every rule as a warning, so `npm run lint` does not fail on
them; keep its output clean anyway.

## File header

New source files carry the Arm Apache-2.0 header, as in `src/core/toolRun.ts`:

```typescript
/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * ...
 */
```

The source rewrite is complete (issue #53). Only `LICENSE-MIT` and `NOTICE`
retain the original project's copyright line pending the licence review
(issue #54); `src/test/provenance.test.ts` lists them and fails if another
file gains that line. Never copy it into a new file. Keep the provenance
check in place: `npm run provenance:check -- --gate`.

## Keeping the documentation current

When a component changes, update the documentation that describes it in the
same change: its page under `docs/architecture/`, and the files under
`docs/agent-resources/` when agents will see different behaviour. The
architecture pages stay at the level of design:

- why the component exists and what problem it solves;
- what it is responsible for, and what it leaves to others;
- the ideas and patterns needed to read its code;
- where to look: files, classes and functions.

Leave the details to the code. A page that restates implementation goes
stale with the next change and then misleads.
