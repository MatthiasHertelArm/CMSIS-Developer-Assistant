# Spec: src/debugMCPServer.ts

`src/debugMCPServer.ts` is the MCP front door of the extension. It runs an express HTTP server on the IPv4 loopback interface, speaks MCP over Streamable HTTP with one `McpServer` per MCP session, registers the debugging, serial and multi-window tools, the documentation resources and the server `instructions`, delegates every tool call to the session's handlers, and records per-call telemetry. This spec also covers `src/test/debugSkillGuidance.test.ts`. Both files descend from microsoft/DebugMCP (MIT) and are reimplemented without the old source (issue #53, phase 3). The rewrite is behaviour-neutral: `test/transport/surface.snapshot.json` stays byte-identical except where a string is marked [REWORD], and every existing test passes. Internal structure is free; the plan is to move tool registration into `src/debugTools.ts` and keep transport and lifecycle here.

Conventions used below:

- **exact** means the text must be reproduced character for character. Where a long, Arm-authored description is not quoted, it is exact as in the snapshot: `S(shape, tool)` means `test/transport/surface.snapshot.json` → `shapes[label=shape].tools[name=tool].description`, JSON-decoded (`\"` is a double quote, `\\n` is a backslash followed by `n`).
- **[REWORD]** marks text that is identical or near-identical to DebugMCP. Only its meaning is given. Write new wording with that meaning; do not look the old text up. The snapshot then changes in exactly those strings and nowhere else.
- Identifiers are never reworded: tool names, field names, enum values, URIs, the server name, setting ids, skill names, HTTP routes, JSON keys, JSON-RPC codes.
- `T` is the shared timeout field and `TIMEOUT_DESC` its description; `SCOPE` is the shared variable-scope field (both defined under Behaviour → Tools).

## External contract

The compiled module must stay at `out/src/debugMCPServer.js` (tsc) and inside the esbuild bundle `dist/extension.js`; the transport harness `require`s the compiled path directly. It must export the following names with these exact types.

| Export | Exact signature or type | Used by |
|---|---|---|
| `DebugMCPServer` | class, see below | `src/windowCoordinator.ts` (constructs with all five arguments, then `initialize`, `start`, `stop`); `test/transport/session-lifecycle.js` and `test/transport/surface-snapshot.js` (construct, `initialize`, `start`, `getActualPort`, `getOptions`, `getMetrics`, `stop`); `test/transport/two-window-routing.js` through `WindowCoordinator` |
| `DebugMCPServerOptions` | `interface { serialEnabled?: boolean; packDocsEnabled?: boolean; buildInfoEnabled?: boolean; telemetry?: { jsonlPath?: string } }` | `src/windowCoordinator.ts` (`CoordinatorOptions.serverOptions`), filled by `src/extension.ts` from settings |
| `SessionHandlers` | `interface { debug: IDebuggingHandler; serial: SerialDispatch; packDocs?: PackDocsDispatch }` | `src/windowCoordinator.ts` (`sessionHandlers()` return type) |
| `SerialDispatch` | `type SerialDispatch = (op: SerialOpName, args?: unknown) => Promise<string>` | type only; named in a comment in `src/packDocsDispatch.ts` |
| `localSerialDispatch` | `const localSerialDispatch: SerialDispatch` | the single-window default factory; `test/transport/surface-snapshot.js`, `test/transport/session-lifecycle.js` |
| `PortInUseError` | `class PortInUseError extends Error { readonly port: number; constructor(port: number) }` | `src/windowCoordinator.ts` (`instanceof` to become a worker) |
| `isLoopbackHostHeader` | `function isLoopbackHostHeader(host: unknown): boolean` | `src/test/debugMCPServer.test.ts` |
| `isLoopbackOrigin` | `function isLoopbackOrigin(origin: string): boolean` | `src/test/debugMCPServer.test.ts` |

`DebugMCPServer` members:

| Member | Signature | Callers |
|---|---|---|
| constructor | `(port: number, timeoutInSeconds: number, hardwareTimeouts?: Partial<HardwareTimeouts>, handlerFactory?: () => SessionHandlers, options: DebugMCPServerOptions = {})` | see above |
| `getOptions` | `(): Readonly<DebugMCPServerOptions>` | session-lifecycle.js |
| `getMetrics` | `(): ToolMetrics` | session-lifecycle.js |
| `initialize` | `(): Promise<void>` | windowCoordinator.ts, transport tests |
| `start` | `(): Promise<void>` | windowCoordinator.ts, transport tests |
| `stop` | `(): Promise<void>` | windowCoordinator.ts, transport tests |
| `getActualPort` | `(): number` | transport tests |
| `getEndpoint` | `(): string` | no caller (optional, see Constraints) |
| `getDebuggingHandler` | `(): IDebuggingHandler` | no caller (optional) |
| `isInitialized` | `(): boolean` | no caller (optional) |

Types come from: `HardwareTimeouts` and `SERVER_VERSION` (`src/debuggingExecutor.ts`), `IDebuggingHandler` (`src/index.ts`), `SerialOpName` (`src/core/opTable.ts`), `PackDocsDispatch` (`src/packDocsDispatch.ts`), `ToolMetrics`, `ToolSample`, `formatBytes` (`src/core/toolMetrics.ts`).

Consumers that read this file as text or by path, not by import:

- `src/test/debugSkillGuidance.test.ts` greps the source of `src/debugMCPServer.ts` for instruction and description phrases (rewritten with this file, see Agent-visible text).
- `src/test/skill.test.ts` collects tool names with the regex `registerTool\('([a-z0-9_]+)'` from `src/debugMCPServer.ts`, `src/packDocsTools.ts` and `src/buildInfoTools.ts`, and requires that set to equal the `allowed-tools` of `skills/cmsis-debug-live/SKILL.md`. Moving registration to another file means adding that file to its list.
- `src/test/provenance.test.ts` lists `src/debugMCPServer.ts` and `src/test/debugSkillGuidance.test.ts` in `DERIVED_FILES`; both entries go in the rewrite PR, or its second test fails.
- `test/realboard/run.ts` reads the `cmsis-developer-assistant://stats` resource and uses `session.calls` and `session.bytesOut`.

Downstream contract, what the server calls:

- `IDebuggingHandler` (`src/debuggingHandler.ts`): `handleStartDebugging`, `handleStopDebugging`, `handleStepOver`, `handleStepInto`, `handleStepOut`, `handleContinue`, `handlePause`, `handleWaitForStop`, `handleRestart`, `handleReset`, `handleAddBreakpoint`, `handleAddLogpoint`, `handleRemoveBreakpoint`, `handleClearAllBreakpoints`, `handleListBreakpoints`, `handleListVariableNames`, `handleGetVariables`, `handleEvaluateExpression`, `handleReadMemory`, `handleReadCoreRegisters`, `handleReadCycleCounter`, `handleReadPeripheralRegister`, `handleGetFaultInfo`, `handleDiagnoseFault`, `handleLookupPeripheral`, `handleLookupRegister`, `handleGetDeviceInfo`, `handleCheckTargetConnection`, `handleGetSessionStatus`, `handleGetCallStack`, `handleGetThreads`, `handleGetFrameVariables`, `handleCmsisCommand`, `handleFlash`. Each returns `Promise<string>`.
- Routing handler, detected structurally: a handler that has both `listDebugWindows(): string` and `selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string` as functions (`RoutingDebuggingHandler` in `src/routingDebuggingHandler.ts`). The module must not import the routing module.
- `SerialDispatch` op names: `handleListPorts`, `handleOpen`, `handleClose`, `handleStatus`, `handleWrite`, `handleRead`, `handleClearBuffer`, `handleSubscribeMonitor`, `handleUnsubscribeMonitor`, `handleOpenInUi`.
- `registerPackDocsTools(mcpServer, dispatch)` (`src/packDocsTools.ts`) and `registerBuildInfoTools(mcpServer, dispatch)` (`src/buildInfoTools.ts`), both `(McpServer, PackDocsDispatch) => void`.
- `TOPICS`, `Topic`, `sliceTopic(doc, topic?)` (`src/core/instructionTopics.ts`).
- `MeasuredMcpServer` (`src/core/measuredMcpServer.ts`), `closeHttpServer(server, graceMs = 2000)` (`src/utils/closeHttpServer.ts`), `serialHandler` singleton (`src/serialHandler.ts`), `logger` (`src/utils/logger.ts`).

## Behaviour

### Construction and options

- The options object is copied shallowly and frozen; `getOptions()` returns that frozen copy. With no options it is `{}`, so `getOptions()` of an instance built with `{ serialEnabled: false }` serializes to `{"serialEnabled":false}`.
- Options are fixed for the instance and read when each session's `McpServer` is built. Nothing may toggle behaviour per call: the tool list a client sees must stay stable between turns.
- With a `handlerFactory`, the factory is called once per MCP session, when that session is initialized; the session keeps the returned handlers for its lifetime.
- Without a `handlerFactory` (single-window default and most tests), the constructor builds one `DebuggingExecutor(hardwareTimeouts)`, one `ConfigurationManager()` and one `DebuggingHandler(executor, configManager, timeoutInSeconds)`, eagerly, and every session gets `{ debug: <that handler>, serial: localSerialDispatch }` with no `packDocs`. `timeoutInSeconds` and `hardwareTimeouts` have no other use.
- `localSerialDispatch(op, args)` calls the method named `op` on the `serialHandler` singleton with `args` as its only argument, bound to the singleton, and returns its promise. If no such method exists it returns a rejected promise with `Error("Serial op <op> is not implemented")` (exact).
- `initialize()` only marks the instance initialized; no `McpServer` exists until a session opens.

### Sessions

- Each MCP session gets its own `StreamableHTTPServerTransport` in stateful mode (session ids from `crypto.randomUUID()`) and its own `MeasuredMcpServer`, created when an `initialize` request arrives without a session id. The pair lives until the transport closes; it is never shared and never closed mid-flight. A shared or per-request server is the cause of the historical "`get_threads` hangs on the third call" bug.
- The session is added to the instance's session map (keyed by session id) when the SDK reports the session initialized, and removed when its transport closes (DELETE, `stop()`, or the SDK closing it).
- Building a session: create a per-session `ToolMetrics` ring, construct `MeasuredMcpServer` with server info, `instructions` and that ring, obtain the session's handlers from the factory, register tools, then register resources.

### Server identity, capabilities, instructions

- Server info: `name` `cmsis-developer-assistant` (exact), `version` `SERVER_VERSION`.
- Server options passed to the SDK: `instructions` only. Capabilities come from the SDK's registration bookkeeping and are exactly `{"tools":{"listChanged":true},"resources":{"listChanged":true}}`. No prompts, no resource templates, no logging capability.
- `instructions` is one string: base sentences B1 B2 B3 B4 joined by single spaces, then the pack-docs tail, then the build-info tail.
  - B1 [REWORD]: see Agent-visible text.
  - B2 [REWORD]: see Agent-visible text.
  - B3 exact: `Harnesses that do not load skills (GitHub Copilot Chat) should call get_debug_instructions instead.`
  - B4 exact: `Tools that accept timeoutMs use it as a one-call override of the default, capped at 60 s; set it when you can estimate the work.`
  - Pack-docs tail, always present, one of two, each prefixed by one space. When `packDocsEnabled` is true, exact: `The documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) answer from the manuals the target's packs ship or link, page-cited; they accept timeoutMs up to 600 s because indexing a manual on first use can take minutes. Use them before asking the user for a datasheet or reference manual (list_target_docs, then fetch_doc for a web-linked one) and instead of reading a PDF into your context: a document the user provides belongs in the workspace docs/ folder or the "Import Document for Current Target" command, then search it. Third-party parts on the board (sensors, ADCs, codecs, radios) are documented the same way: for any part number call list_target_docs first, then search_target_docs; if the datasheet is not listed, find its PDF URL on the web and fetch_doc { url } — never read the PDF yourself.`
  - Otherwise, exact: `Page-cited documentation tools (search over the target's pack manuals, datasheets, errata and third-party part datasheets) are available behind the setting cmsis-developer-assistant.packDocs.enabled; suggest enabling it rather than asking the user for a document or reading a PDF yourself.`
  - Build-info tail, only when `buildInfoEnabled` is true, prefixed by one space, exact: `The build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, get_section_layout, get_build_diagnostics) read the ELF, linker map and build log of the current target.` When false, nothing (known bug 2).
  - The tails depend on the options only, not on whether the session has a pack-docs dispatch (known bug 5).
- The current length is about 1.1 k characters with the default options and 1.8 k with both groups on.

### Tools

Common rules for every tool:

- Register with `registerTool(name, config, callback)` on the `MeasuredMcpServer`, in the order below; the order is visible in `tools/list`.
- A tool with no parameters is registered without an `inputSchema` key; its callback calls the handler with no argument. `inputSchema: {}` is not equivalent: it adds `"$schema"` to the published schema and changes the callback arguments `MeasuredMcpServer` sees.
- A tool with parameters passes the SDK-parsed argument object unchanged to its handler (defaults applied, unknown keys stripped by zod).
- No `title`, no `outputSchema`, no `_meta`, no `execution` in any config (the SDK adds `"execution":{"taskSupport":"forbidden"}` itself).
- Annotations, where present, are one of two objects with this key order: RO = `{ readOnlyHint: true, destructiveHint: false }`, DESTR = `{ readOnlyHint: false, destructiveHint: true }`.
- The result is exactly `{ content: [ { type: 'text', text: <string> } ] }`: no `isError`, no other keys. Result bytes feed the telemetry that the snapshot pins through the `get_session_status` trailer.
- Handler errors are not caught: they propagate, `MeasuredMcpServer` records them as `error`, and the SDK turns them into an `isError` result carrying the error message. Input-validation failures never reach the callback (the SDK answers them, and they are not measured).
- There is no server-level timeout or backstop around tool calls; timeouts belong to the handlers.
- Zod chains are exact, including the order of `.optional()`, `.default()` and `.describe()`: the order decides the key order of the published JSON Schema (`z.string().optional().describe(d)` emits `description` before `type`; `z.string().describe(d).optional()` emits it after). Field order is also exact; it sets the property order and the order of validation issues.
- `TIMEOUT_DESC` is exact: `Per-call timeout in ms, max 60000 (see server instructions).`
- `T` is `z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC)`.
- `SCOPE` is `z.enum(['local', 'global', 'all']).optional().describe(<[REWORD] R-scope>)`.

Registration order, gates, annotations and delegation (description sources are in Agent-visible text):

| # | Tool | Gate | Annotations | Calls |
|---:|---|---|---|---|
| 1 | `get_debug_instructions` | always | RO | loads `agent-resources/debug_instructions.md`, returns `sliceTopic(doc, args.topic)`; if slicing throws, logs a warning and returns the whole document |
| 2 | `start_debugging` | always | none | `debug.handleStartDebugging(args)` |
| 3 | `stop_debugging` | always | none | `debug.handleStopDebugging()` |
| 4 | `step_over` | always | none | `debug.handleStepOver(args)` |
| 5 | `step_into` | always | none | `debug.handleStepInto(args)` |
| 6 | `step_out` | always | none | `debug.handleStepOut(args)` |
| 7 | `pause_execution` | always | none | `debug.handlePause(args)` |
| 8 | `continue_execution` | always | none | `debug.handleContinue(args)` |
| 9 | `wait_for_stop` | always | RO | `debug.handleWaitForStop(args)` |
| 10 | `restart_debugging` | always | none | `debug.handleRestart(args)` |
| 11 | `reset` | always | DESTR | `debug.handleReset(args)` |
| 12 | `add_breakpoint` | always | none | `debug.handleAddBreakpoint(args)` |
| 13 | `add_logpoint` | always | none | `debug.handleAddLogpoint(args)` |
| 14 | `remove_breakpoint` | always | none | `debug.handleRemoveBreakpoint(args)` |
| 15 | `clear_all_breakpoints` | always | none | `debug.handleClearAllBreakpoints()` |
| 16 | `list_breakpoints` | always | none | `debug.handleListBreakpoints()` |
| 17 | `list_variable_names` | always | RO | `debug.handleListVariableNames(args)` |
| 18 | `get_variables_values` | always | none | `debug.handleGetVariables(args)` |
| 19 | `evaluate_expression` | always | none | `debug.handleEvaluateExpression(args)` |
| 20 | `read_memory` | always | RO | `debug.handleReadMemory(args)` |
| 21 | `read_core_registers` | always | RO | `debug.handleReadCoreRegisters(args)` |
| 22 | `read_cycle_counter` | always | RO (known bug 4) | `debug.handleReadCycleCounter(args)` |
| 23 | `read_peripheral_register` | always | RO | `debug.handleReadPeripheralRegister(args)` |
| 24 | `get_fault_info` | always | RO | `debug.handleGetFaultInfo(args)` |
| 25 | `diagnose_fault` | always | RO | `debug.handleDiagnoseFault(args)` |
| 26 | `lookup_peripheral` | always | RO | `debug.handleLookupPeripheral(args)` |
| 27 | `lookup_register` | always | RO | `debug.handleLookupRegister(args)` |
| 28 | `get_device_info` | always | RO | `debug.handleGetDeviceInfo()` |
| 29 | `check_target_connection` | always | RO | `debug.handleCheckTargetConnection()` |
| 30 | `get_call_stack` | always | RO | `debug.handleGetCallStack(args)` |
| 31 | `get_threads` | always | RO | `debug.handleGetThreads(args)` |
| 32 | `get_frame_variables` | always | RO | `debug.handleGetFrameVariables(args)` |
| 33 | `serial_list_ports` | serial | RO | `serial('handleListPorts')` |
| 34 | `serial_open` | serial | none | `serial('handleOpen', args)` |
| 35 | `serial_close` | serial | none | `serial('handleClose')` |
| 36 | `serial_status` | serial | RO | `serial('handleStatus')` |
| 37 | `serial_write` | serial | none | `serial('handleWrite', args)` |
| 38 | `serial_read` | serial | RO | `serial('handleRead', args)` |
| 39 | `serial_clear_buffer` | serial | none | `serial('handleClearBuffer', args)` |
| 40 | `serial_subscribe_monitor` | serial | none | `serial('handleSubscribeMonitor')` |
| 41 | `serial_unsubscribe_monitor` | serial | none | `serial('handleUnsubscribeMonitor')` |
| 42 | `serial_open_monitor` | serial | none | `serial('handleOpenInUi')` |
| — | five documentation tools | packDocs | (own file) | `registerPackDocsTools(mcpServer, packDocs)` |
| — | five build-artefact tools | buildInfo | (own file) | `registerBuildInfoTools(mcpServer, packDocs)` |
| 43 | `cmsis_action` | always | none | `debug.handleCmsisCommand(args)` |
| 44 | `flash` | always | DESTR | `debug.handleFlash(args)` |
| 45 | `get_session_status` | always | RO | `debug.handleGetSessionStatus()`, then appends the trailer (below) |
| 46 | `list_debug_windows` | routing | RO | `debug.listDebugWindows()` (synchronous) |
| 47 | `select_debug_window` | routing | none | `debug.selectDebugWindow(args)` (synchronous) |

Gates:

- serial: `options.serialEnabled !== false` (default on).
- packDocs: the session has a `packDocs` dispatch and `options.packDocsEnabled` is true.
- buildInfo: the session has a `packDocs` dispatch and `options.buildInfoEnabled` is true.
- routing: the session's `debug` handler passes the structural routing check.

Resulting shapes (as in the snapshot): default 45 tools (1–45); serial off 35; all groups on 55, with the ten group tools between `serial_open_monitor` and `cmsis_action`; routed 47 (1–47).

`get_session_status` trailer: on success the text is the handler's string, two newlines, then `metrics.formatTotals()` of the session's ring. The trailer is computed inside the callback, so it counts the calls before this one, not this call. If the handler throws, the error propagates and there is no trailer.

Input schemas:

- Only `timeoutMs` = `T`: `step_over`, `step_into`, `step_out`, `pause_execution`, `continue_execution`, `wait_for_stop`, `restart_debugging`, `read_core_registers`, `read_cycle_counter`, `get_fault_info`, `get_threads`.
- No input schema: `stop_debugging`, `clear_all_breakpoints`, `list_breakpoints`, `get_device_info`, `check_target_connection`, `get_session_status`, `serial_list_ports`, `serial_close`, `serial_status`, `serial_subscribe_monitor`, `serial_unsubscribe_monitor`, `serial_open_monitor`, `list_debug_windows`.

All other fields, in declaration order per tool (`d` is the description in the last column):

| Tool | Field | Zod chain | Description `d` |
|---|---|---|---|
| `get_debug_instructions` | `topic` | `z.enum(TOPICS).optional().describe(d)` | `Section to return. Default: overview (~2 KB) with the topic list.` |
| `start_debugging` | `fileFullPath` | `z.string().optional().describe(d)` | `Source file to debug; optional when configurationName is given.` |
| `start_debugging` | `workingDirectory` | `z.string().describe(d)` | [REWORD] R-workdir |
| `start_debugging` | `testName` | `z.string().optional().describe(d)` | [REWORD] R-testname |
| `start_debugging` | `configurationName` | `z.string().optional().describe(d)` | `launch.json configuration name, e.g. "CMSIS Debugger: pyOCD"; empty prompts the user.` |
| `start_debugging` | `timeoutMs` | `T` | |
| `reset` | `method` | `z.enum(['auto', 'system', 'core', 'hardware']).optional().describe(d)` | `'auto' (default) escalates system (SYSRESETREQ) → core (VECTRESET) → hardware (nSRST, needs the reset line wired) until one verifies.` |
| `reset` | `halt` | `z.boolean().optional().describe(d)` | `Leave the target halted at the reset vector (default true). false resumes after verification.` |
| `reset` | `timeoutMs` | `T` | |
| `add_breakpoint` | `fileFullPath` | `z.string().describe(d)` | [REWORD] R-path |
| `add_breakpoint` | `line` | `z.number().int().min(1).optional().describe(d)` | [REWORD] R-line-preferred |
| `add_breakpoint` | `condition` | `z.string().optional().describe(d)` | `Optional condition, e.g. "i == 100" — GDB-native, so the core halts only when it holds.` |
| `add_breakpoint` | `lineContent` | `z.string().optional().describe(d)` | `DEPRECATED: substring match that breaks on EVERY line containing the text; pass line instead.` |
| `add_logpoint` | `fileFullPath` | `z.string().describe(d)` | [REWORD] R-path |
| `add_logpoint` | `line` | `z.number().int().min(1).describe(d)` | [REWORD] R-line |
| `add_logpoint` | `logMessage` | `z.string().describe(d)` | `Message; {expr} interpolates runtime values.` |
| `add_logpoint` | `condition` | `z.string().optional().describe(d)` | `Optional condition; logs only when true.` |
| `remove_breakpoint` | `fileFullPath` | `z.string().describe(d)` | [REWORD] R-path |
| `remove_breakpoint` | `line` | `z.number().describe(d)` | [REWORD] R-line |
| `list_variable_names` | `scope` | `SCOPE` | [REWORD] R-scope |
| `list_variable_names` | `timeoutMs` | `T` | |
| `get_variables_values` | `scope` | `SCOPE` | [REWORD] R-scope |
| `get_variables_values` | `variableNames` | `z.array(z.string()).min(1).max(50).optional().describe(d)` | `Optional filter: read only these variables, e.g. ["adc_raw", "state"]. Names that match nothing are reported back. Omit to return everything in scope.` |
| `get_variables_values` | `timeoutMs` | `T` | |
| `evaluate_expression` | `expression` | `z.string().describe(d)` | [REWORD] R-expression |
| `evaluate_expression` | `timeoutMs` | `T` | |
| `read_memory` | `address` | `z.string().describe(d)` | `Memory address as hex string, e.g. '0x20000000'` |
| `read_memory` | `length` | `z.number().int().min(1).max(4096).describe(d)` | `Number of bytes to read (1-4096)` |
| `read_memory` | `format` | `z.enum(['hex', 'ascii', 'both']).default('hex').describe(d)` | `'hex' (default), 'ascii', or 'both'` |
| `read_memory` | `timeoutMs` | `T` | |
| `read_peripheral_register` | `peripheral` | `z.string().describe(d)` | `Peripheral name, e.g. 'GPIOA', 'UART0', 'RCC'` |
| `read_peripheral_register` | `register` | `z.string().optional().describe(d)` | `Register name, e.g. 'ODR', 'CR1'. If omitted, lists all registers in the peripheral.` |
| `read_peripheral_register` | `timeoutMs` | `T` | |
| `diagnose_fault` | `levels` | `z.number().int().min(1).max(20).optional().describe(d)` | `Call-stack frames to include (default 3)` |
| `diagnose_fault` | `timeoutMs` | `T` | |
| `lookup_peripheral` | `name` | `z.string().optional().describe(d)` | `Peripheral name, e.g. RCC (case-insensitive)` |
| `lookup_peripheral` | `address` | `z.string().optional().describe(d)` | `Address to resolve, e.g. 0x40005400` |
| `lookup_peripheral` | `filter` | `z.string().optional().describe(d)` | `Name prefix to narrow the list or the register map` |
| `lookup_peripheral` | `svdFile` | `z.string().optional().describe(d)` | `Explicit .svd path; default: session, cbuild-run.yml, workspace` |
| `lookup_peripheral` | `pname` | `z.string().optional().describe(d)` | `Processor name selecting the SVD in a multi-core cbuild-run` |
| `lookup_peripheral` | `timeoutMs` | `T` | |
| `lookup_register` | `peripheral` | `z.string().describe(d)` | `Peripheral name, e.g. RCC` |
| `lookup_register` | `register` | `z.string().describe(d)` | `Register name, e.g. APB1ENR` |
| `lookup_register` | `svdFile` | `z.string().optional().describe(d)` | same text as `lookup_peripheral.svdFile` |
| `lookup_register` | `pname` | `z.string().optional().describe(d)` | same text as `lookup_peripheral.pname` |
| `lookup_register` | `timeoutMs` | `T` | |
| `get_call_stack` | `threadId` | `z.number().int().optional().describe(d)` | `Optional DAP thread id (from get_threads). Defaults to the active thread.` |
| `get_call_stack` | `levels` | `z.number().int().min(1).max(200).optional().describe(d)` | `Maximum frames to return (default 50).` |
| `get_call_stack` | `timeoutMs` | `T` | |
| `get_frame_variables` | `frameId` | `z.number().int().describe(d)` | `DAP frame id, as returned by get_call_stack.` |
| `get_frame_variables` | `scope` | `SCOPE` | [REWORD] R-scope |
| `get_frame_variables` | `variableNames` | `z.array(z.string()).min(1).max(50).optional().describe(d)` | `Optional filter: read only these variables. Omit to return everything in the frame.` |
| `get_frame_variables` | `timeoutMs` | `T` | |
| `serial_open` | `path` | `z.string().describe(d)` | `Device path, e.g. '/dev/tty.usbmodemABCD' on macOS or 'COM3' on Windows` |
| `serial_open` | `baudRate` | `z.number().int().optional().describe(d)` | `Baud rate (default 115200)` |
| `serial_open` | `dataBits` | `z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional()` | none |
| `serial_open` | `parity` | `z.enum(['none', 'even', 'odd', 'mark', 'space']).optional()` | none |
| `serial_open` | `stopBits` | `z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional()` | none |
| `serial_open` | `rtscts` | `z.boolean().optional().describe(d)` | `RTS/CTS hardware flow control (default false)` |
| `serial_write` | `data` | `z.string().describe(d)` | `Payload. For encoding='hex' use a hex string like '0a 1b 2c'.` |
| `serial_write` | `encoding` | `z.enum(['utf8', 'hex']).optional()` | none |
| `serial_write` | `appendNewline` | `z.boolean().optional().describe(d)` | `Append '\n' to utf8 payloads (default false)` (a literal backslash and `n`, not a newline) |
| `serial_read` | `maxBytes` | `z.number().int().min(1).optional()` | none |
| `serial_read` | `waitMs` | `z.number().int().min(0).max(60000).optional()` | none |
| `serial_read` | `consume` | `z.boolean().optional()` | none |
| `serial_read` | `format` | `z.enum(['utf8', 'hex', 'both']).optional()` | none |
| `serial_read` | `from` | `z.enum(['owned', 'monitor']).optional().describe(d)` | `Backend to read from (default 'owned')` |
| `serial_clear_buffer` | `from` | `z.enum(['owned', 'monitor']).optional()` | none |
| `cmsis_action` | `action` | `z.enum(['build', 'load', 'erase', 'load_and_run', 'load_and_debug', 'attach', 'detach', 'stop_run']).describe(d)` | `Which CMSIS Solution action to invoke` |
| `cmsis_action` | `target` | `z.string().optional().describe(d)` | `Target-type or type@set from the csolution (e.g. "MPS3", "HP@debug"). Switched and verified when it differs from the active one; omit to use the panel selection.` |
| `cmsis_action` | `timeoutMs` | `z.number().int().min(100).max(60_000).optional().describe(d)` | `TIMEOUT_DESC`, one space, then `For load_and_debug / attach: the session-readiness wait.` |
| `flash` | `cbuildRunFile` | `z.string().optional().describe(d)` | `Path to the .cbuild-run.yml to program. Omit to auto-resolve from launch.json / out/.` |
| `flash` | `timeoutMs` | `z.number().int().min(1_000).max(60_000).optional().describe(d)` | `TIMEOUT_DESC`, one space, then `Flash defaults to 60 s.` |
| `select_debug_window` | `pid` | `z.number().int().optional().describe(d)` | `Process id of the window, as reported by list_debug_windows.` |
| `select_debug_window` | `workspaceFolder` | `z.string().optional().describe(d)` | `Any path inside the target window's workspace folder.` |

### Resources

Registered with `registerResource(name, uri, { description, mimeType }, readCallback)` in this order, after the tools. Each read returns `{ contents: [ { uri: <requested uri.href>, mimeType, text } ] }`.

| # | URI (exact) | Name | Description | mimeType | Content |
|---:|---|---|---|---|---|
| 1 | `cmsis-developer-assistant://stats` | `Tool call statistics` (exact) | `Per-tool call counts, bytes in/out, durations and outcomes for this MCP session and for the whole server instance, plus the most recent samples` (exact) | `application/json` | `JSON.stringify({ session, server, recent }, null, 2)`: `session` = the session ring's `totals()`, `server` = the instance aggregate's `totals()`, `recent` = the last 50 of the session ring's `samples()` |
| 2 | `cmsis-developer-assistant://docs/debug_instructions` | [REWORD] R-guide-name | [REWORD] R-guide-desc | `text/markdown` | `agent-resources/debug_instructions.md` |
| 3 | `cmsis-developer-assistant://docs/troubleshooting/python` | [REWORD] R-lang-name (Python) | [REWORD] R-lang-desc (`python`) | `text/markdown` | `agent-resources/troubleshooting/python.md` |
| 4 | `cmsis-developer-assistant://docs/troubleshooting/javascript` | [REWORD] R-lang-name (JavaScript) | [REWORD] R-lang-desc (`javascript`) | `text/markdown` | `agent-resources/troubleshooting/javascript.md` |
| 5 | `cmsis-developer-assistant://docs/troubleshooting/java` | [REWORD] R-lang-name (Java) | [REWORD] R-lang-desc (`java`) | `text/markdown` | `agent-resources/troubleshooting/java.md` |
| 6 | `cmsis-developer-assistant://docs/troubleshooting/csharp` | [REWORD] R-lang-name (C#) | [REWORD] R-lang-desc (`csharp`) | `text/markdown` | `agent-resources/troubleshooting/csharp.md` |
| 7 | `cmsis-developer-assistant://docs/cmsis-embedded-guide` | `CMSIS Embedded Debugging Guide` (exact) | `Comprehensive guide for debugging Cortex-M embedded targets using CMSIS tools, including fault analysis, peripheral inspection, and memory layout.` (exact) | `text/markdown` | `agent-resources/cmsis-embedded-guide.md` |
| 8 | `cmsis-developer-assistant://docs/troubleshooting/embedded` | `Embedded Debugging Tips` (exact) | `Troubleshooting tips for embedded Cortex-M debugging, HardFault analysis, and peripheral issues.` (exact) | `text/markdown` | `agent-resources/troubleshooting/embedded.md` |

Resource reads are not tool calls and are not measured. `cpp.md` and `go.md` exist in `docs/agent-resources/troubleshooting/` but are not registered (known bug 10).

### Documentation loading

- Paths above are relative to the repository's `docs/` directory. With `<dir>` the directory of the compiled module, the loader tries `<dir>/../docs/<path>` first (packaged bundle: `dist/` → `<extension>/docs/`), then `<dir>/../../docs/<path>` (tsc output: `out/src/` → `<repo>/docs/`). If registration moves into a file at a different directory depth, the candidates must still resolve to the same two locations.
- A successful read is cached per server instance by relative path (shipped docs do not change per install). Failures are not cached.
- If no candidate can be read, the loader logs an error and returns, as normal text content (not an error result), a message [REWORD] R-docload that names the relative path and includes the underlying error, which lists the paths tried. Both `get_debug_instructions` and the resource reads then serve that text.

### HTTP transport

- express app, middleware in this order:
  1. Loopback guard. If `isLoopbackHostHeader(req.headers.host)` is false: 403 with JSON `{"error":"Forbidden: non-local Host header"}` (exact). Else if an `Origin` header is present (any string, including empty) and `isLoopbackOrigin(origin)` is false: 403 with JSON `{"error":"Forbidden: non-local Origin"}` (exact). The guard is port-agnostic and runs before body parsing.
  2. `express.json({ limit: '1mb' })`.
  3. Routes below. No custom error-handling middleware: an oversize body gets 413 and malformed JSON gets 400 from express's default error handler, with its HTML body (known bug 9).
- `isLoopbackHostHeader(host)`: false unless `host` is a non-empty string. Removes the port (for a value starting with `[`, keeps everything up to and including the first `]`; otherwise removes a trailing `:<digits>`), lower-cases, and accepts only `localhost`, `127.0.0.1`, `::1`, `[::1]`.
- `isLoopbackOrigin(origin)`: parses with `new URL`; true only if the lower-cased `hostname` is in the same set; false for anything that does not parse (`null`, empty, free text).
- `POST /mcp`:
  - header `mcp-session-id` names a live session: hand the request (with the parsed body) to that session's transport;
  - no session header and the body is an initialize request (`isInitializeRequest`): create the transport and session server (see Sessions), connect, then hand the request over;
  - otherwise (unknown session id, or no id and not initialize): 400 with JSON `{"jsonrpc":"2.0","error":{"code":-32000,"message":<[REWORD] R-400-post>},"id":null}` (known bug 1);
  - any exception: log it; if a transport and server were created for this request and the session never got registered, close both (ignore close errors) and log a warning; then, if no headers were sent, 500 with `{"jsonrpc":"2.0","error":{"code":-32603,"message":<[REWORD] R-500>},"id":null}`.
- `GET /mcp` and `DELETE /mcp` (one shared behaviour): missing or unknown `mcp-session-id` gives 400 with `{"jsonrpc":"2.0","error":{"code":-32000,"message":<[REWORD] R-400-session>},"id":null}` (known bug 1); otherwise the session's transport handles it (GET opens the SSE stream, DELETE closes the session). Both routes are registered at start-up; a 404 here makes Cursor mark the server as errored.
- `GET /sse`: 410 with JSON `{"error":<[REWORD] R-sse-error>,"message":<[REWORD] R-sse-message>,"newEndpoint":"/mcp"}`. No `SSEServerTransport` is used anywhere.
- Every other route: express's default 404.

### Lifecycle

- `start()`:
  - builds the app and binds `port` on `127.0.0.1` only, with no fallback port: losing the bind means another window is the router;
  - success is the server's `listening` event, never the `app.listen` callback (Express 5 calls that callback on failure too); on an `error` event the half-open handle is closed and the error is returned;
  - reads the actual port back from the bound socket (`port` 0 gives an OS-assigned port) and stores it; fails with an error [REWORD] R-start-failed if the socket reports no address;
  - attaches a permanent `error` listener that only logs, so a late socket error cannot crash the extension host;
  - `EADDRINUSE` logs at info level and throws `new PortInUseError(port)` (configured port); `PortInUseError` has `name` `PortInUseError` and message `Port <port> is already in use by another CMSIS Developer Assistant window` (exact);
  - any other failure logs an error and throws `new Error(<[REWORD] R-start-failed>)` with the underlying error appended.
- `stop()`: closes every session transport one after another, logging a warning for each failure; empties the session map; if an HTTP server exists, clears the stored server and actual port, then awaits `closeHttpServer(server)` (idle sockets at once, all connections after 2 s); logs that the server stopped. Safe to call when `start()` failed or never ran. It does not touch serial ports; `WindowCoordinator` owns that teardown.
- `getActualPort()`: the bound port after a successful `start()`, else the configured port (also after `stop()`).
- `getEndpoint()`: `http://localhost:<getActualPort()>`.
- `getDebuggingHandler()`: the `debug` handler of a fresh factory call. `isInitialized()`: whether `initialize()` ran.

### Telemetry

- One instance-wide aggregate: `new ToolMetrics(500)` with no callback; `getMetrics()` returns it.
- One ring per session: `new ToolMetrics(200, onSample)`. For every sample, `onSample` records it into the aggregate, passes it to the JSONL sink if configured, and logs one info line, format exact: `tool=<tool> ms=<ms> in=<formatBytes(argBytes)> out=<formatBytes(resultBytes)> outcome=<outcome>`, followed by a space and `session=<first 8 characters of sessionId>` when the sample has a session id.
- JSONL sink: active when `options.telemetry.jsonlPath` is a non-empty string. Each sample is appended asynchronously as `JSON.stringify(sample)` plus `\n`. On the first append error the sink mutes itself for the rest of the instance and logs one warning; it never throws and never logs per call. Samples carry names, sizes, times and outcomes only, never arguments or results.
- Measuring is done by `MeasuredMcpServer` at the MCP boundary; this module only wires the rings.

### Logging

Through `logger` only. Wording is free and must not reuse DebugMCP's; only the telemetry line above is fixed. Events: start attempt with the preferred port (info); started with the bound address (info); port in use (info); start failure (error); HTTP server error (error); session initialized and closed with its id (info); request-handling failure (error); abandoned session setup released (warn); session close failure during stop (warn); stopped (info); document loaded, with size and path (debug); document load failure (error); topic slicing failure (warn); JSONL sink muted (warn).

## Agent-visible text

### Instructions sentences

| Id | Status | Meaning to keep |
|---|---|---|
| B1 | [REWORD] | These tools run a live Arm Cortex-M debug session through the CMSIS Debugger. They exist to investigate runtime problems on the board. Name the problem kinds an agent should recognise: defects that only show at run time, faults, crashes, hangs, failing tests, variables holding wrong or null values, output that is not what was expected, and general reports that the board does not behave. These kinds are what makes an agent pick the tools; word choice and order are free. |
| B2 | [REWORD] | For a runtime investigation, invoke the Agent Skill named `cmsis-debug-live` (identifier, exact) before anything else. Say what the skill supplies: the target-awareness checklist, the session-status gate, how to place breakpoints, the step-then-inspect loop, fault decoding, and guidance for getting to the root cause. Say why: with it the agent uses the tools deliberately, rather than guessing or sprinkling temporary printf/UART logging over the firmware. The Arm-authored terms "target-awareness checklist", "session-status gate" and "fault decode" may stay verbatim. |
| B3 | exact | see Behaviour |
| B4 | exact | see Behaviour |
| tails | exact | see Behaviour |

### Tool descriptions

Shared with DebugMCP, [REWORD]:

| Tool | Meaning to keep |
|---|---|
| `stop_debugging` | ends the active debug session |
| `step_over` | runs the current source line; calls on that line are not entered |
| `step_into` | enters the function called on the current line |
| `step_out` | runs until the current function returns to its caller |
| `continue_execution` | lets the target run again; it stops at the next breakpoint hit or when the program finishes |
| `restart_debugging` | starts the session over, reusing its launch configuration |
| `remove_breakpoint` | deletes a single breakpoint (file and line) |
| `clear_all_breakpoints` | deletes every breakpoint in one call; meant as the clean-up step once the cause of the bug is confirmed, before other work starts |
| `list_breakpoints` | lists the breakpoints that are set, in every file |
| `list_variable_names` | lists which variables exist at the stop location, with their types but no values; a discovery step before `get_variables_values`. The Arm clause `pull only what you need with get_variables_values — on a slow probe that is the difference between one round trip and thirty.` may stay verbatim |
| `get_variables_values` | reads variable values at the stop location, so the agent can compare the actual runtime data with what it expects. The last sentence is Arm and stays exact: `Omit variableNames to dump the whole scope (capped at 40 variables per scope and 200 chars per value); pass variableNames to read exactly what you need, uncapped.` |
| `evaluate_expression` | evaluates an arbitrary expression of the debugged program's language against the running target (check a hypothesis, compute a value, call a function, read a member); goes further than reading a variable |
| `start_debugging` | only the second sentence: tells the agent to invoke the `cmsis-debug-live` skill before using this tool. The rest is exact: first sentence `Start a debug session through the VS Code debug pipeline (launch.json).`, then after the reworded sentence `For CMSIS / Cortex-M projects prefer cmsis_action load_and_debug (builds, flashes, attaches); start_debugging skips the flash step and suits non-CMSIS projects or attaching to an already-flashed target. Refuses while a session is active.` |

Arm-authored, exact as `S(default, tool)`: `get_debug_instructions`, `pause_execution`, `wait_for_stop`, `reset`, `add_breakpoint`, `add_logpoint`, `read_memory`, `read_core_registers`, `read_cycle_counter`, `read_peripheral_register`, `get_fault_info`, `diagnose_fault`, `lookup_peripheral`, `lookup_register`, `get_device_info`, `check_target_connection`, `get_call_stack`, `get_threads`, `get_frame_variables`, all ten `serial_*` tools, `cmsis_action`, `flash` (see known bug 3), `get_session_status` (see known bug 6). Exact as `S(routed-no-window, tool)`: `list_debug_windows`, `select_debug_window`.

### Field descriptions

All [REWORD]; the meaning ids are used in the field table above.

| Id | Used by | Meaning to keep |
|---|---|---|
| R-workdir | `start_debugging.workingDirectory` | the directory the debug session runs in |
| R-testname | `start_debugging.testName` | only for a run of one individual test; omit it to run the file as a whole |
| R-path | `fileFullPath` of `add_breakpoint`, `add_logpoint`, `remove_breakpoint` | absolute path of the source file |
| R-line | `add_logpoint.line`, `remove_breakpoint.line` | line number, counting from 1 |
| R-line-preferred | `add_breakpoint.line` | line number, counting from 1; the preferred way to place it (over `lineContent`). Keep consistent with R-line |
| R-scope | `scope` of `list_variable_names`, `get_variables_values`, `get_frame_variables` | which variables: `local`, `global` or `all` (name the three values) |
| R-expression | `evaluate_expression.expression` | what to evaluate, written in the debugged program's language |

All other field descriptions are Arm-authored and exact as given in the field table.

### Resource names and descriptions

| Id | Meaning to keep |
|---|---|
| R-guide-name | title of the full debugging guide |
| R-guide-desc | the full, ordered procedure for debugging with CMSIS Developer Assistant |
| R-lang-name | per language, a short title that names the language (display names Python, JavaScript, Java, C#) and says the resource holds troubleshooting notes for it |
| R-lang-desc | per language, one sentence template saying the resource holds advice for debugging programs in that language, naming it by its lower-case id (`python`, `javascript`, `java`, `csharp`) as today |

The stats resource and the two CMSIS resources are Arm-authored and exact.

### HTTP and error texts

| Id | Where | Meaning to keep |
|---|---|---|
| R-400-post | `POST /mcp` 400 `error.message` | the request carries no session id this server knows, and is not an initialize request |
| R-400-session | `GET`/`DELETE /mcp` 400 `error.message` | the request needs the id of an open session; it is absent or unknown |
| R-500 | `POST /mcp` 500 `error.message` | handling the request failed on the server side |
| R-sse-error | `GET /sse` 410 `error` | this legacy SSE route is retired |
| R-sse-message | `GET /sse` 410 `message` | clients should switch to the Streamable HTTP endpoint, `POST /mcp` |
| R-docload | document loader fallback text | the documentation file (relative path) could not be loaded, plus the underlying error |
| R-start-failed | `start()` error message | the MCP server could not be started, followed by the cause |

Exact and Arm-authored: the two 403 bodies, the `PortInUseError` message, `Serial op <op> is not implemented`, the JSON-RPC codes, `newEndpoint`.

None of these HTTP texts is in the snapshot or asserted by a test; only the status codes are.

### Phrases pinned by the skill-guidance test

| # | Current test | Phrase pinned | Lives in | DebugMCP-shared | After the rewrite |
|---:|---|---|---|---|---|
| 1 | skill metadata covers the common runtime investigation triggers | `runtime bugs`, `faults`, `crashes`, `hangs`, `failing tests`, `wrong/null values`, `unexpected output` in the SKILL.md `description` | `skills/cmsis-debug-live/SKILL.md` | the vocabulary, except `faults` | keep the check while SKILL.md is unchanged; restructure the code |
| 2 | skill metadata prefers live inspection over temporary firmware logging | `whenever live inspection is practical`; `instead of adding temporary printf/UART logging, LED toggles, or console output`; description must not contain `MUST use first` | SKILL.md | near-shared: DebugMCP pinned "when live inspection is practical", a "…or console output" clause and the same negative check | keep while SKILL.md is unchanged |
| 3 | the skill body carries the debugger-first rule | a heading `## Debugger first`; `add_logpoint` … `still stops the core` | SKILL.md | no | keep |
| 4 | MCP instructions say to invoke the skill first and explain why | `invoke the "cmsis-debug-live" Agent Skill first`, `breakpoint strategy`, `step-and-inspect`, `root-cause guidance` (case-insensitive) | B2 | yes, all four | may change: pin the reworded B2 (skill name, "first", the reasons) |
| 5 | MCP instructions keep a path for harnesses without skills | `get_debug_instructions instead` | B3 | no | keep |
| 6 | start_debugging points agents to the skill | `Invoke the "cmsis-debug-live" skill first.` | `start_debugging` sentence 2 | yes | may change: pin the reworded sentence (skill name) |
| 7 | the get_debug_instructions document carries the same debugger-first rule | a `## … DEBUGGER FIRST` heading and `printf`, in the document and in its topic-less overview | `docs/agent-resources/debug_instructions.md` | no | keep |
| 8 | the guide speaks Cortex-M, not web apps | none of getUserById, processOrder, parseFloat, `"def" in python`; contains `BFAR` | debug_instructions.md | the forbidden names are DebugMCP's examples, on purpose | keep |

`test/transport/session-lifecycle.js` also pins instruction text, all Arm-authored: `packDocs.enabled` and `rather than asking the user for a document` (default tail); `documentation tools` and `build-artefact tools` (both groups on).

### Size budget

Rewording must stay within the budgets asserted by `session-lifecycle.js`: serialized default `tools/list` ≤ 30 000 bytes (now 28 799), all groups on ≤ 42 000 (now 40 527), each description ≤ 700 characters (longest now `cmsis_action`, 506).

## Known bugs to preserve

Preserve all of these; they are fixed separately later.

1. An unknown `mcp-session-id` gets 400, not the 404 the MCP Streamable HTTP spec requires (the SDK's own transport answers 404, -32001). This holds for POST, GET and DELETE, and also for an `initialize` sent with a stale id, so a client cannot re-initialize after router failover. `session-lifecycle.js` pins the 400. Fix: #14.
2. The instructions say nothing about the build-artefact tools when `buildInfoEnabled` is off (no "available behind a setting" sentence, unlike the documentation tools), so a default install never learns they exist. Fix: #50.
3. The `flash` description says it "needs pyocd on PATH"; the CMSIS Debugger's bundled pyOCD is on PATH only for terminals and tasks. Fix: #45/#46.
4. `read_cycle_counter` is annotated read-only, but it writes DEMCR and DWT_CTRL (it enables DWT/CYCCNT on first use). Fix: #51.
5. The instructions tails follow `packDocsEnabled` and `buildInfoEnabled` alone. A session without a pack-docs dispatch (default constructor with gates on) is told about tools it does not have. Not reachable from the extension, whose factory always supplies a dispatch.
6. `get_session_status` claims "Never hangs, never throws", but a handler that throws (the routing handler with no registered window) yields an `isError` result without the stats trailer (snapshot shape `routed-no-window`).
7. `get_debug_instructions` and its `topic` field promise a "~2 KB" overview; the overview is about 3.1 kB.
8. A missing shipped document is reported as normal content (not `isError`), is retried on every call, and was logged through `console.error` (the rewrite logs through `logger`).
9. An oversize body (413) and malformed JSON (400) are answered by express's default error handler with HTML, not a JSON-RPC error. `session-lifecycle.js` pins the 413 status.
10. The python, javascript, java and csharp troubleshooting resources are registered in a Cortex-M product, while `cpp.md` and `go.md` sit unregistered next to them (codebase review 3.3, #53 Decision 4).
11. `serial_read` is annotated read-only although `consume` defaults to draining the RX buffer.
12. `remove_breakpoint.line` is `z.number()` without `.int().min(1)`, unlike the other two `line` fields.
13. Closing an MCP session does not notify its per-session routing handler (#49).
14. The server binds IPv4 loopback only, while endpoints advertise `localhost`.

## Test cases

`src/test/debugMCPServer.test.ts` (Arm, unchanged):

1. Given the Host values `localhost`, `localhost:3001`, `LOCALHOST:3001`, `127.0.0.1`, `127.0.0.1:3001`, `[::1]`, `[::1]:3001`, when `isLoopbackHostHeader` checks each, then it returns true.
2. Given `undefined`, `null`, `''`, `42`, `attacker.com`, `attacker.com:3001`, `127.0.0.1.attacker.com`, `localhost.attacker.com`, `10.0.0.1:3001`, when `isLoopbackHostHeader` checks each, then it returns false.
3. Given the origins `http://localhost:5173`, `https://127.0.0.1`, `http://[::1]:3001`, `http://localhost`, when `isLoopbackOrigin` checks each, then true; given `null`, `http://attacker.com`, `http://localhost.attacker.com`, `http://127.0.0.1.attacker.com`, `not a url`, `''`, then false.

`src/test/debugSkillGuidance.test.ts` (rewritten with this file; Mocha TDD `suite`/`test`, runs in the vscode-test host from `out/src/test`). It may read source files as today, or call an exported pure instructions builder (proposal #50 suggests one); the served text is what matters.

1. Given the `description` line of `skills/cmsis-debug-live/SKILL.md`, when it is checked, then it contains each of the seven trigger terms of row 1 above.
2. Given that description, then it contains the two live-inspection phrases of row 2 and not `MUST use first`.
3. Given the SKILL.md body, then it has a line starting `## Debugger first` and mentions `add_logpoint` before `still stops the core`.
4. Given the server instructions, then they tell the agent to invoke the `cmsis-debug-live` Agent Skill first and name what it provides (the reworded B2 phrases).
5. Given the server instructions, then they contain `get_debug_instructions instead`.
6. Given the `start_debugging` description, then it tells the agent to invoke the `cmsis-debug-live` skill first (the reworded sentence).
7. Given `docs/agent-resources/debug_instructions.md`, when it and `sliceTopic(doc)` (the overview) are checked, then both have a `## … DEBUGGER FIRST` heading and mention `printf`.
8. Given that document, then it contains none of getUserById, processOrder, parseFloat, `"def" in python`, and it contains `BFAR`.

`test/transport/session-lifecycle.js` (Arm), server built as `new DebugMCPServer(0, 30)` unless stated:

1. Given a started server, when `initialize` is POSTed without a session id, then 200 and an `mcp-session-id` header.
2. Given that response, then its `instructions` match `packDocs\.enabled` and `rather than asking the user for a document`.
3. Given the session, when `GET /mcp` carries its id, then 200 with `content-type` `text/event-stream`.
4. Given no session id, or `not-a-real-session`, when `GET /mcp`, then 400.
5. Given the session, when `tools/list`, then more than 30 tools including `add_logpoint`, `list_variable_names`, `add_breakpoint`, `get_variables_values`, `diagnose_fault`, `lookup_register`; serialized size ≤ 30 000 bytes; no description over 700 characters; exactly 10 tools starting `serial_`.
6. Given the session, when a `tools/call` body of about 1.1 MB is POSTed, then 413.
7. Given `get_debug_instructions` with `topic: 'breakpoints'`, then the text contains `FPB` and not `CFSR`; without a topic, then it contains `## Topics`, is shorter than 3 500 characters and shorter than twice the breakpoints text.
8. Given no workspace, when `lookup_peripheral {}`, then a non-error result matching `No SVD file found` … `Tried:`.
9. Given stubbed CMSIS commands, when `cmsis_action` is called with `detach` and various `target` values, then the handler's results come back verbatim (the server passes `action`, `target`, `timeoutMs` through unchanged).
10. Given the session, when `get_threads` is called three times in a row, then each call returns a JSON-RPC result or error within 10 s (the per-session-server regression).
11. Given those calls, when `resources/read` of `cmsis-developer-assistant://stats`, then valid JSON with `session.calls` ≥ 6, `session.perTool.get_threads.calls` = 3, `session.perTool.get_debug_instructions.calls` = 2.
12. Given the same session, when `get_session_status`, then a line starts `Tool stats (this session): 11 calls` (the call itself is not counted; the 413 request is not either); and `server.getMetrics().totals().calls` ≥ 7.
13. Given the session, when `DELETE /mcp`, then 200 or 204; a later `GET /mcp` with that id gives 400.
14. Given `new DebugMCPServer(0, 30, undefined, undefined, { serialEnabled: false })`, then `getOptions().serialEnabled === false` and `tools/list` has no `serial_` tool and is 10 shorter than the default.
15. Given a factory with a pack-docs dispatch and `{ packDocsEnabled: true, buildInfoEnabled: true }`, then the instructions contain `documentation tools` and `build-artefact tools`; `tools/list` is the default plus exactly the ten documentation and build-artefact tools (which the default lacks); ≤ 42 000 bytes; no description over 700 characters; `list_target_docs` and `list_build_artifacts` return guidance, not errors.

`test/transport/surface-snapshot.js` (Arm):

1. Given the five shapes `default` (`new DebugMCPServer(0, 30)`), `serial-off`, `all-groups` (factory with pack-docs dispatch, both gates on), `routed-no-window` and `routed-one-worker` (routing handler factory), when each is started and inspected (initialize result with version masked, `tools/list`, `resources/list`, `resources/templates/list`, digests of every resource except stats, and every tool called once with fixed arguments and no debug session), then the JSON equals `test/transport/surface.snapshot.json` byte for byte. After the rewrite it may differ only in [REWORD] strings, regenerated with `--update` in the same commit.

`test/transport/two-window-routing.js` (Arm, through `WindowCoordinator`):

1. Given two coordinators on one port, when both start, then exactly one binds it (the other got `PortInUseError` and became a worker) and both advertise the same endpoint.
2. Given a session on the router, when `list_debug_windows` and `select_debug_window { workspaceFolder }` are called, then they return the routing handler's text (both tools exist because the handler is a router).
3. Given the router disposed (its `stop()` frees the port), when the worker retries, then it binds the port and serves MCP.

`src/test/skill.test.ts` and `src/test/provenance.test.ts` (Arm):

1. Given the `registerTool('<name>'` literals in the listed source files, then that set equals the skill's `allowed-tools`.
2. Given the rewritten files, then neither contains the Microsoft copyright line and neither is in `DERIVED_FILES`.

## Constraints

- `@modelcontextprotocol/sdk` 1.26:
  - `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`), used only through `MeasuredMcpServer`, constructed as `new MeasuredMcpServer(serverInfo, { instructions }, sessionRing)`;
  - `registerTool(name, config, callback)` with a literal string name (the skill test greps `registerTool('`), never the deprecated `tool()`, which `MeasuredMcpServer` does not measure;
  - `registerResource(name, uri, metadata, callback)`;
  - `connect(transport)` and `close()`;
  - `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/streamableHttp.js`) with `sessionIdGenerator`, `onsessioninitialized`, `handleRequest(req, res, body?)`, `sessionId`, `onclose`, `close()`. Assign `onclose` before `connect`: the SDK chains its own close handling onto the handler present at connect time, and assigning afterwards would replace it;
  - `isInitializeRequest` (`@modelcontextprotocol/sdk/types.js`);
  - `SSEServerTransport` is not used and must not be introduced.
- express 5.2: default import; `express.json`; `app.listen` returns the `http.Server`; do not treat the listen callback as success. Handler types may use `import type { Request, Response, NextFunction } from 'express'` instead of `any`.
- zod 4.5, `import { z } from 'zod'`; chain order as specified.
- Node built-ins: `fs` (async append, async read), `path`, `http` (types), `node:crypto` `randomUUID`.
- Logging through `logger` from `src/utils/logger.ts` (`debug`, `info`, `warn`, `error`); no `console.*`.
- No direct `import 'vscode'` in this file or in a new `src/debugTools.ts`, and no settings reads: everything configurable arrives through the constructor. Verified: the current file imports no `vscode`. It loads `vscode` only transitively (through `src/index.ts`, `src/utils/logger.ts`, `src/serialHandler.ts`), which `test/transport/vscode-stub.js` satisfies; keep it that way.
- File header for both rewritten files and any new file: the Arm Apache-2.0 block exactly as in `src/core/toolRun.ts` lines 1–15, no Microsoft line. Remove both entries from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same PR.
- If registration moves to `src/debugTools.ts` (or per-area modules), add each file to the list in `src/test/skill.test.ts`, keep the docs loader's two locations correct (see Documentation loading), and keep the exports above on `src/debugMCPServer.ts` (re-export if moved; `isLoopbackHostHeader` and `isLoopbackOrigin` may later move to `src/utils/loopback.ts` under #19, but must stay importable from `../debugMCPServer`).
- Keep the structural routing check; do not import `src/routingDebuggingHandler.ts`.
- Optional: `getEndpoint`, `getDebuggingHandler`, `isInitialized` and the initialized flag have no callers (codebase review item D). Drop them or keep them with the semantics above; `initialize()` must stay.
- Do not add: a server-level tool timeout, an express error handler, prompts, resource templates, `outputSchema` or `structuredContent` (#11), serial teardown in `stop()`, or a fallback port.
- Style: TypeScript strict, 4-space indentation as in the surrounding code, semicolons, braces on every block, no `any` where a type exists.
- Acceptance: `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport`, `npm run test:surface` (snapshot diff limited to [REWORD] strings), `node test/transport/packaged-vsix.js <vsix>`, and `npm run provenance:check` with no identical non-trivial lines beyond unavoidable import boilerplate. Update `docs/architecture/debugMCPServer.md` code locations if registration moves.
