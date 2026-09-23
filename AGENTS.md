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
extension also installs Agent Skills for CMSIS work and, behind settings,
offers tools over the target's documentation and build artefacts.

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
| Window routing | `src/windowCoordinator.ts`, `src/routingDebuggingHandler.ts`, `src/controlServer.ts`, `src/utils/workspaceRegistry.ts`, `src/core/opTable.ts` | Router and worker windows, the window registry, forwarding of every op | [docs/architecture/windowRouting.md](docs/architecture/windowRouting.md) |
| `AgentConfigurationManager` | `src/utils/agentConfigurationManager.ts` | Registers the server in AI agents' configuration files and installs Agent Skills | [docs/architecture/agentConfigurationManager.md](docs/architecture/agentConfigurationManager.md) |
| `PackDocsHandler` / `BuildInfoHandler` | `src/packDocsHandler.ts`, `src/buildInfoHandler.ts`, `src/core/packDocs/`, `src/core/buildInfo/` | Documentation tools (pack PDFs, Arm documents, user and workspace documents, core SVDs) and build-artefact tools (ELF, map file, build log); off by default, routed like every other op | [docs/architecture/packDocs.md](docs/architecture/packDocs.md) |
| `skills/` | `skills/` | Bundled Agent Skills `cmsis-debug-live`, `add-board-layer`, `cmsis-pack-docs` and the generated `cmsis-help`; the vendored Open-CMSIS-Pack/cmsis-skills skills; one router skill per category; `catalog.json` | [skills/README.md](skills/README.md) |

Smaller parts: `src/serialHandler.ts` with `src/core/serialController.ts` and
`src/core/serialMonitorBridge.ts` (the `serial_*` tools);
`src/utils/sessionStateTracker.ts` (which session is active, stop events);
`src/cmsisJobTracker.ts` (the window's CMSIS tasks, the `cmsis_action` jobs
and what holds the probe); `src/cmsisBuildDiagnosis.ts` with
`src/core/buildFailure.ts` (the error lines of a failed build);
`src/core/` in general (SVD parsing, fault decoding and triage, CMSIS
target selection and task classification, tool metrics, topic slicing of
the agent guide), where most modules do not import `vscode` at all.

## Entry points

- **Activation:** `activate()` in `src/extension.ts`. esbuild bundles it into
  `dist/extension.js`, the `main` of `package.json`; the extension activates
  on `onStartupFinished` and `onDebug`.
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
| `npm run lint:md` | markdownlint over the repository's Markdown with `.github/markdownlint.jsonc` (`docs/architecture/`, `skills/cmsis-skills/`, `CHANGELOG.md` and build folders are skipped) |
| `npm test` | Compile and lint first (`pretest`), then run `src/test/*.test.ts` inside VS Code with `vscode-test`, coverage into `coverage/` |
| `npm run test:transport` | Compile, then `test/transport/session-lifecycle.js` and `test/transport/two-window-routing.js` over real sockets |
| `npm run test:surface` | Compile, then compare everything an agent can see without hardware — the initialize result, `tools/list`, the resources and each tool's reply without a session — with `test/transport/surface.snapshot.json`. Pass `-- --update` only for an intended change. The snapshot depends on the host, so this is a local check, not a CI job |
| `npm run provenance:check` | Per file, the lines shared with microsoft/DebugMCP (clones it once, so it needs network the first time). With `-- --gate` it fails when a gated file — any path DebugMCP ever had, or any file added since the rewrite began, unless it still carries the Microsoft line or is on the script's exemption list — contains more than five lines found anywhere in DebugMCP's history. `-- --lines <file>` prints DebugMCP text; do not use it while writing independent code |
| `npm run skills:sync` | Vendor the cmsis-skills skills again at the pinned commit and regenerate `skills/catalog.json`, the router skills, `skills/cmsis-help` and the tool-contract blocks; `-- --update` moves the pin to upstream `main` |
| `npm run skills:sync -- --offline` | The same regeneration without a fetch: from the vendored skills and the committed catalog, lock untouched. Run it after editing `scripts/skills.config.json`, the commands or settings in `package.json`, or `docs/agent-resources/tool-contract.md` |

Behaviour oracles, run with `node` after `npm run compile`:
`test/transport/dap-scenarios.js` (tool replies and adapter traffic over
scripted `gdbtarget` sessions), `test/transport/config-scenarios.js` (agent
configuration files, launch configurations, activation) and
`test/transport/executor-cases.js` (the executor alone). The first two take
`--update` for an intended change. `test/transport/packaged-vsix.js <vsix>`
checks a built package.

## Settings

| Setting | Default | Effect |
| ------- | ------- | ------ |
| `cmsis-developer-assistant.serverPort` | 3001 | Port of the MCP server |
| `cmsis-developer-assistant.timeoutInSeconds` | 180 | Time limit of debugging operations; waits for a stop or a session never exceed 60 s |
| `cmsis-developer-assistant.dapRequestTimeoutMs` | 10000 | Deadline of one DAP request |
| `cmsis-developer-assistant.memoryReadTimeoutMs` | 30000 | Deadline of a read that takes several requests (memory, registers, peripherals) |
| `cmsis-developer-assistant.redactSecrets` | `true` | Withhold variable and expression values that look like credentials; raw target reads are never redacted |
| `cmsis-developer-assistant.build.diagnosticRerun` | `true` | After a failed build, re-run cbuild once with `--log` (no pack download, RTE update or clean; 120 s cap) so the `cmsis_action` result shows the error lines; off leaves only the csolution messages of `cbuild-idx.yml`. Scope `window` |
| `cmsis-developer-assistant.serial.enabled` | `true` | Offer the ten `serial_*` tools |
| `cmsis-developer-assistant.telemetry.jsonlPath` | `""` | Append one JSON line per tool call to this file; empty is off |
| `cmsis-developer-assistant.installedSkills` | `[]` | The AI Skills Pack skills from `skills/catalog.json` to install. Where the value is set decides where they go: the User value into the personal skills directories, a Workspace or Folder value into that folder's `.agents/skills` (plus `.claude/skills` when Claude Code is installed or the folder has a `.claude` directory), pack skills only. `cmsis-debug-live`, `add-board-layer`, `cmsis-pack-docs` and `cmsis-help` are always installed for the user. Scope `resource` |
| `cmsis-developer-assistant.aiSkills.enabled` | `true` | Install the AI Skills Pack at all; off removes the pack skills this extension installed and skips the skills step of the setup and the prompt. Scope `application` |
| `cmsis-developer-assistant.aiSkills.promptOnDetect` | `true` | At most once a month, offer the pack when an agent has the server registered but no pack skill is selected. Scope `application` |
| `cmsis-developer-assistant.packDocs.enabled` | `false` | Register the five documentation tools. PDF text comes from the bundled pdf.js, or from `pdftotext` when `packDocs.extractor` says so; `packDocs.*` also set the size limit, unlisted pack PDFs and the workspace and user document folders |
| `cmsis-developer-assistant.buildInfo.enabled` | `false` | Register the five build-artefact tools; `buildInfo.maxSymbols` (20) and `buildInfo.logGlobs` tune them |

`installedSkills` and `aiSkills.enabled` take effect at once,
`redactSecrets` is read on every call and `build.diagnosticRerun` for every
failed build. The port, the timeouts, the tool-group switches and the
telemetry file are read at activation; after a change the window has to be
reloaded, and the extension offers to do it when the port,
`packDocs.enabled` or `buildInfo.enabled` changes.

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
repeats them in one line. `npm run skills:sync -- --offline` copies both
blocks between `<!-- cmsis-developer-assistant:<block>:begin -->` and `…:end -->`
markers into the bundled skills, `cmsis-help` and `debug_instructions.md`
(`src/core/toolContract.ts`). Edit the contract, never a copy;
`src/test/toolContract.test.ts` compares them and holds the rules to ten lines
and 1 600 bytes. Tool descriptions never repeat the contract: `tools/list`
rides along on every turn, and `test/transport/session-lifecycle.js` pins its
size.

`debug_instructions.md` is split into topics by
`<!-- topic: name | blurb -->` … `<!-- /topic -->` comments, which
`src/core/instructionTopics.ts` parses. Keep the markers and the topic names;
`src/test/instructionTopics.test.ts` and `src/test/debugSkillGuidance.test.ts`
also pin the size of the overview and a few phrases.

## Dependencies

- `@modelcontextprotocol/sdk`: `McpServer` and `StreamableHTTPServerTransport`
- `zod`: the input schema of every tool
- `express`: the HTTP app behind `/mcp`
- `jsonc-parser`: reads `launch.json`, comments and trailing commas included
- `serialport`: the serial tools; left out of the esbuild bundle because of
  its native binary, and shipped in `node_modules` (see
  `docs/packaging-esbuild.md`)
- `pdfjs-dist`: PDF text for the documentation tools, on a worker thread

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
  imports. Import names are camelCase or PascalCase (ESLint naming rule).
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
  `src/test/skill.test.ts` compares them with the skill's `allowed-tools`.

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

A few files still derive from microsoft/DebugMCP and keep its copyright line
until they are rewritten (issue #53). They are listed in
`src/test/provenance.test.ts`, and that test fails if any other file gains
the line. Never copy that line into a new file. When a file is rewritten,
remove the line and its list entry in the same change, and run
`npm run provenance:check -- --gate`.

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
