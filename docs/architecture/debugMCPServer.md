# DebugMCPServer and the session tool surface

The MCP endpoint of the extension lives in two files:

- `src/debugMCPServer.ts` is the HTTP side: the loopback listener, one MCP
  transport and one MCP server per client session, start and stop, and where
  the measurement of each tool call goes.
- `src/debugTools.ts` is what a client sees inside a session: the server name
  and instructions, the tools with their descriptions and input schemas, and
  the Markdown files served as resources.

## Why it is built this way

Agents outside VS Code (Claude Code, Codex, Cursor, Cline and others) and
Copilot inside it all reach the extension through one Streamable HTTP URL,
`http://localhost:<serverPort>/mcp`, port 3001 unless configured otherwise.
Three constraints shape the code:

- **Runs without VS Code.** `debugMCPServer.ts` does not import `vscode` and
  reads no settings. Port, timeouts, the handler factory and the options come
  in through the constructor, so the transport harness under
  `test/transport/` runs the real server in plain Node with a stubbed `vscode`
  module.
- **Sessions share nothing.** An early version kept one MCP server for all
  requests and closed it after each one; a concurrent call then lost its
  transport, and the third `get_threads` of a session never answered. Now a
  session owns its transport and its server from `initialize` until the
  transport closes, and nothing is closed while one of its requests runs.
- **The tool list holds for a session.** The switches that add or remove tool
  groups are fixed when the server instance is built and read when a session
  is built. A client that cached `tools/list` never finds a tool gone, or a
  new one, halfway through its session. Changing those settings takes a
  window reload.

## The HTTP endpoint

`buildApp()` puts together an Express app that listens on `127.0.0.1` only.

| Route | Answer |
| ----- | ------ |
| `POST /mcp` | An `initialize` request without a session id opens a session; every other request must name an open session in `mcp-session-id`. |
| `GET /mcp` | The server-sent event stream of the named session. |
| `DELETE /mcp` | Ends the named session. |
| `GET /sse` | 410 with a pointer to `POST /mcp`: the SSE transport of older releases is retired. |

- `loopbackOnly` answers 403 to a `Host` header that does not name this
  machine and to an `Origin` that is not local (`isLoopbackHostHeader()`,
  `isLoopbackOrigin()` from `src/utils/loopback.ts`, which the control
  server of each window uses too), before the body is read. Together they
  keep a web page that resolves its own host name to 127.0.0.1 (DNS
  rebinding) away from the tools.
- A body above 1 MB is refused with 413 before MCP code sees it.
- A request that names no open session gets a JSON-RPC error with `id: null`
  and status 400, for `GET` and `DELETE` too: a 404 on either makes Cursor
  mark the whole server as failed. A request whose handling throws gets 500.

## Session life cycle

1. `acceptPost()` receives an `initialize` request without a session id and
   calls `openSession()`: a `ToolMetrics` ring for the session, a server from
   `buildSessionServer()`, and a `StreamableHTTPServerTransport` that issues a
   random UUID as the session id.
2. When the SDK assigns that id, `adopt()` enters the pair in the session map.
   A session that fails before this point is closed at once (`discard()`).
3. Later requests carrying the id go straight to the session's transport
   (`acceptSessionRequest()` for `GET` and `DELETE`).
4. When the transport closes (client `DELETE`, or `stop()`), `release()`
   removes the entry.

The handlers a session talks to (`SessionHandlers`: `debug`, `serial` and the
optional `packDocs` dispatch) come from the factory given to the constructor,
which is called once while the session is built. In the extension the factory
belongs to the `WindowCoordinator` and returns a new `RoutingDebuggingHandler`
for every session (see [windowRouting.md](windowRouting.md)). Without a
factory, as in the transport tests, one `DebuggingHandler` with
`localSerialDispatch` serves all sessions (`singleWindowHandlers()`).

## Start and stop

- `initialize()` has nothing to do; it keeps the two-step start its callers
  follow.
- `start()` binds the configured port and has no fallback port.
  `listenOnLoopback()` waits for the `listening` event, because Express 5
  calls the listen callback on failure as well. `EADDRINUSE` becomes
  `PortInUseError`: another window serves MCP, and the caller becomes a worker.
- `stop()` closes every session, then the HTTP server through
  `closeHttpServer()` (idle connections at once, busy ones after a grace
  period). It is safe after a failed start. Serial ports are released by the
  window coordinator, not here.
- `getActualPort()` reports the port actually bound, which tests use with a
  configured port of 0.

## Measurement and telemetry

Every tool is registered through `MeasuredMcpServer`
(`src/core/measuredMcpServer.ts`). It wraps each tool callback and records a
`ToolSample` at the MCP boundary: tool name, argument and result bytes,
duration, outcome and session id. The outcome is `ok`, `timeout` or `error`.
`classifyOutcome()` in `src/core/toolMetrics.ts` reads it from the result's
status and `isError` first — an error with the code `TIMEOUT` or
`WORKER_TIMEOUT` counts as a timeout, a `running` reply as ok — and only a
result without either is judged by its wording, the way 2.3.10 texts were.
Because the sample is taken at the boundary, it measures what the client
experienced, forwarding to another window included.

The sample goes into the session's ring of 200 samples. The ring's callback,
`observe()`, adds it to the totals of the server instance (500 samples),
appends it as one JSON line to the file named by the `telemetry.jsonlPath`
setting (`jsonlSink()`: never awaited, and silent after the first failed
write, which logs one warning), and logs a one-line summary. The session
totals close every `get_session_status` reply; the
`cmsis-developer-assistant://stats` resource returns the session totals, the
instance totals and the last 50 samples as JSON.

## What a session offers

`buildSessionServer()` in `src/debugTools.ts` creates the server of one
session and registers its tools and resources.

### Identity and instructions

The server reports the name `cmsis-developer-assistant` and the version
`SERVER_VERSION` from `src/debuggingExecutor.ts`. `composeInstructions()`
assembles the `instructions` of the initialize result from fixed sentences:
what the tools are for, to invoke the `cmsis-debug-live` Agent Skill first and
what it brings, `get_debug_instructions` for harnesses that load no skills,
the 60 s cap on `timeoutMs` (600 s for `cmsis_action` and `flash`), how to read a result (`isError` and the
`[CODE]` prefix; `timeout` and `running` are not failures), and one sentence
each for the documentation and build-artefact groups. The sentence on
results lives here rather than in the tool descriptions, so `tools/list`,
which the client sends along every turn, does not grow. While the
documentation group is off, its sentence points to the setting instead; the
build-artefact sentence appears only while that group is on.
`src/test/debugSkillGuidance.test.ts` pins the phrases agents rely on.

### Tools

`registerTools()` registers each tool with a literal name
(`mcp.registerTool('read_memory', …)`), its description from the `ABOUT`
table, a zod input schema, and the annotations `LOOK_ONLY` or `ALTERS_TARGET`
where they apply. Every callback passes the parsed arguments to one handler
method and hands its outcome to `reply()`. Nothing is caught here: a
rejection reaches `MeasuredMcpServer`, which answers it as an error result
itself (see [Results](#results)). `src/packDocsTools.ts` and
`src/buildInfoTools.ts` reply the same way.

| Group | Registered when | Answered by |
| ----- | --------------- | ----------- |
| Session, run control, breakpoints, variables, Cortex-M state, SVD lookups, stack and threads, `cmsis_action`, `flash`, `get_session_status` | always | the session's debugging handler |
| `get_debug_instructions` | always | `ShippedDocs` and the topic slicer, no handler |
| The ten `serial_*` tools | `serialEnabled` is not `false` | the `serial` dispatch, by op name |
| Documentation (`registerPackDocsTools()`) | `packDocsEnabled`, and the session has a `packDocs` dispatch | `src/packDocsTools.ts`, then the dispatch |
| Build artefacts (`registerBuildInfoTools()`) | `buildInfoEnabled`, and the session has a `packDocs` dispatch | `src/buildInfoTools.ts`, then the dispatch |
| `list_debug_windows`, `select_debug_window` | the debugging handler is a window router | the router |

A router is recognised by its two extra methods (`windowRoutingOf()`), so this
module does not import the routing code. Tool names stay literal because
`src/test/skill.test.ts` collects them from the `registerTool('…'` calls and
compares them with the `allowed-tools` list of the `cmsis-debug-live` skill.

### Results

A handler resolves with a `ToolText` — a plain string, or a `ToolReply`
with a status — or rejects, normally with a `ToolError` that carries an
error code, a message and a hint (`src/core/toolResult.ts`, #11).
`toCallToolResult()` in `src/core/measuredMcpServer.ts` is the only place
that turns this into an MCP result:

| Outcome | Text | `isError` | `structuredContent` |
| ------- | ---- | --------- | ------------------- |
| string | the string | — | none |
| reply `ok` | its text | — | `{status: 'ok', ...data}`, only with data |
| reply `running` or `timeout` | its text | — | `{status, message, ...data}` |
| `ToolError` | `[CODE] message`, the hint on the next line | `true` | `{status: 'error', error_code, message, hint, ...data}` |

A plain `Error` gets a code from `classifyError()`, so the SDK's own error
result, which would carry the message alone, is never used for a handler's
failure; schema errors are raised by the SDK before the callback runs and
stay its own. No tool declares an `outputSchema`: the SDK passes
`structuredContent` through without one, and the tool list stays as it is.
A plain success carries no `structuredContent`, for clients that might read
it instead of the text. `get_session_status` appends its statistics to the
text of the handler's outcome.

### Resources and shipped documents

| URI | Content |
| --- | ------- |
| `cmsis-developer-assistant://stats` | Tool-call statistics, JSON |
| `cmsis-developer-assistant://docs/debug_instructions` | `docs/agent-resources/debug_instructions.md` |
| `cmsis-developer-assistant://docs/cmsis-embedded-guide` | `docs/agent-resources/cmsis-embedded-guide.md` |
| `cmsis-developer-assistant://docs/troubleshooting/embedded` | `docs/agent-resources/troubleshooting/embedded.md` |
| `cmsis-developer-assistant://docs/troubleshooting/<lang>` | `docs/agent-resources/troubleshooting/<lang>.md` for `python` and `cpp` (C and C++) |

`ShippedDocs` reads a file on first use and keeps its text for the life of
the server instance. It looks for `docs/` first next to the bundle's
directory (`dist/`), then two levels above the tsc output (`out/src/`), so
both layouts work. A file that cannot be read is answered with a note that
names the paths tried, and is tried again on the next request.

`get_debug_instructions` does not return the guide whole. `sliceTopic()` in
`src/core/instructionTopics.ts` cuts it at its
`<!-- topic: name | blurb -->` … `<!-- /topic -->` markers and returns either
the overview with the topic list or one topic. If the markers are broken, the
whole guide is served and a warning is logged.

## Where to look

- `src/debugMCPServer.ts`: `DebugMCPServer` (`start`, `stop`, `buildApp`,
  `acceptPost`, `acceptSessionRequest`, `openSession`, `observe`),
  `loopbackOnly`, `listenOnLoopback`, `jsonlSink`, `singleWindowHandlers`,
  `PortInUseError`, `SessionHandlers`, `DebugMCPServerOptions`,
  `localSerialDispatch`
- `src/debugTools.ts`: `buildSessionServer`, `composeInstructions`, `ABOUT`,
  `registerTools`, `registerResources`, `ShippedDocs`, `SHIPPED_RESOURCES`
- `src/core/measuredMcpServer.ts` (`toCallToolResult`) and
  `src/core/toolMetrics.ts`: the MCP result and measurement
- `src/core/toolResult.ts`: `ToolText`, `ToolReply`, `ToolError`, the error
  codes and their classification
- `src/core/instructionTopics.ts`: topic markers of the guide
- `src/windowCoordinator.ts`: builds the server in the window that wins the
  port

## Tests

- `src/test/loopback.test.ts`: the `Host` and `Origin` checks;
  `src/test/debugMCPServer.test.ts`: that the server still exports them
- `src/test/measuredMcpServer.test.ts`: every outcome as a client receives
  it, and the metrics outcome
- `src/test/toolResult.test.ts`: classification, wrapping, the reading of
  2.3.10 texts
- `src/test/debugSkillGuidance.test.ts`: instructions, tool descriptions and
  the guide send agents to the live debugger first
- `src/test/instructionTopics.test.ts`: marker grammar and the shipped
  guide's topics
- `test/transport/session-lifecycle.js`: sessions over real HTTP — session
  ids, the 400 answers, three consecutive `get_threads`, the 413 limit,
  topics, statistics, typed errors without a session, no `outputSchema`
- `test/transport/surface-snapshot.js` (`npm run test:surface`): initialize
  result, tool list, resources and every tool's reply without a session,
  compared with `test/transport/surface.snapshot.json`
- `test/transport/two-window-routing.js`: the server as router for two
  windows
