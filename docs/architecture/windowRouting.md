# Multi-window routing

Each VS Code window runs its own extension host, with its own debug sessions,
its own probe connection and its own CMSIS solution. A debug session in one
window is invisible to the extension in another. Agents, however, are given
one URL, `http://localhost:<serverPort>/mcp` (port 3001 by default). The
routing layer connects the two:
exactly one window serves MCP, and every tool call runs in the window that
owns the workspace or the board the call is about.

## Roles

- **Router.** The window that bound the MCP port. Its `DebugMCPServer`
  accepts the MCP sessions and forwards every tool call.
- **Worker.** Every other window. It executes calls forwarded to it and
  retries the port every 10 s, so that one of the workers takes over when the
  router window closes and the agents' URL keeps working.
- Every window, the router included, runs a `ControlServer` and executes its
  own calls through it. Routing to itself costs one loopback hop and keeps a
  single code path; a local shortcut would be a second path that only the
  router exercises.
- Every window advertises the router's URL, also to Copilot in the editor
  (the MCP server definition in `src/extension.ts`), so in-editor and
  external agents agree on which window owns a board.

## The pieces

| File | Responsibility |
| ---- | -------------- |
| `src/windowCoordinator.ts` | `WindowCoordinator`: starts the control server, publishes the window, tries to become router (`tryBecomeRouter()`), polls for promotion, and gives each MCP session a new `RoutingDebuggingHandler` (`sessionHandlers()`) |
| `src/utils/workspaceRegistry.ts` | `WorkspaceRegistry`: the machine-wide list of windows, one JSON file per window |
| `src/routingDebuggingHandler.ts` | `RoutingDebuggingHandler`: picks the target window for a call and forwards it; answers `list_debug_windows` and `select_debug_window` |
| `src/controlServer.ts` | `ControlServer`: receives a forwarded call and runs it against this window's handlers |
| `src/core/opTable.ts` | the names of every op that may cross a window boundary, shared by both ends |

## The registry

Each window keeps `window-<pid>.json` in
`<os.tmpdir()>/cmsis-developer-assistant-registry`: the control port and
token, the workspace folders, the window name, whether a debug session is
active and with which configuration, and the CMSIS solution path when the
CMSIS Solution extension reports one. The file is written atomically,
refreshed every 20 s, and rewritten at once when a debug session starts or
ends or the folders change — the session state is what routes every call that
names no file. Readers drop the files of processes that no longer exist and
of other windows not refreshed for 60 s; unreadable files and leftover
temporary files go once they are a minute old, since a peer may still be
writing a younger one. Windows of different extension versions read each
other's files, so the format stays stable.

## Choosing the target window

`RoutingDebuggingHandler.resolveTarget()` walks a fixed ladder; the first rung
that applies decides:

1. **Path.** A call that carries `fileFullPath` or `workingDirectory`
   (`pathHintOf()`) goes to the window whose workspace folder contains it most
   deeply. A pin never overrides a path: a named file must not be opened in
   another window.
2. **Pin.** The window chosen with `select_debug_window`, by process id or by a
   path inside its workspace, for the rest of the MCP session.
3. **Cache.** The window this MCP session reached last, while it is still
   registered on the same control port.
4. **The only debugging window.** The one window with an active debug
   session.
5. **The only window.** The one registered window.

Otherwise the call is refused with the list of windows and the tools to pick
one — when two windows are debugging, reading memory from the wrong board
would look exactly like a firmware bug, so the router never guesses.
`list_debug_windows` shows every registered window and marks the current
target and the pin.

## Forwarding

The router POSTs `{op, args}` to `/op` on the target window's control port,
with the window's token in the `x-cmsis-developer-assistant-token` header,
and returns the `result` as the tool's answer. Both ends take the op names
from `src/core/opTable.ts`: the debugging ops (the `IDebuggingHandler`
method names), the serial ops and the documentation and build-artefact ops.
The table is checked at compile time against the handler interfaces, and the
router's forwarding methods are generated from it, so a new tool is routable
without further code.

- The router waits for socket activity for the tool's timeout plus 15 s, so
  the worker's own, more specific timeout text arrives first. `cmsis_action`,
  `flash` and the documentation ops, which can take minutes, get at least ten
  minutes (`forwardTimeoutMs()`).
- Requests above 1 MiB and responses above 16 MiB are cut off; they only
  guard against runaways.
- When a window cannot be reached, the session forgets it as its cached
  target and the error suggests `list_debug_windows`.

## The control server

`ControlServer` listens on an ephemeral port on `127.0.0.1` and accepts only
`POST /op` with the right token (404 and 403 otherwise). It checks the op
name against the op table before looking up any method, then dispatches it
to the debugging handler, the serial handler, or the documentation or
build-artefact handler, and answers `{result}` with 200 or `{error}` with
500. The request and response shapes are shared by every installed version
of the extension. The token is the only gate, and the ops include flashing
and erasing the target, so agents never see it: `describeWindow()` leaves
port and token out of every listing.

## Shutdown

`WindowCoordinator.dispose()` first removes the window from the registry, so
no other window forwards into a closing extension host, then stops the MCP
server and the control server, then releases the window's serial ports,
giving that step at most two seconds.

## Tests

- `src/test/routing.test.ts`: the ladder, pins, refusals and a control-server
  round trip
- `src/test/workspaceRegistry.test.ts`: registration, pruning and path
  matching
- `src/test/windowCoordinator.test.ts`: the serial teardown on dispose
- `src/test/opTable.test.ts`: the op table
- `test/transport/two-window-routing.js`: two coordinators against one
  registry — one router, one worker, the same advertised endpoint, pinning,
  republishing on session start, promotion when the router closes
