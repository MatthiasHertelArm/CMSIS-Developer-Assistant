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
- Every window publishes its role in its registry entry (`role`, since
  2.5.1) and shows it in the status bar (see
  [Window selection for people](#window-selection-for-people)).

## The pieces

| File | Responsibility |
| ---- | -------------- |
| `src/windowCoordinator.ts` | `WindowCoordinator`: starts the control server, publishes the window, tries to become router (`tryBecomeRouter()`), polls for promotion, gives each MCP session a new `RoutingDebuggingHandler` (`sessionHandlers()`), and owns the window's status-bar item |
| `src/utils/workspaceRegistry.ts` | `WorkspaceRegistry`: the machine-wide list of windows, one JSON file per window, and the default target |
| `src/routingDebuggingHandler.ts` | `RoutingDebuggingHandler`: picks the target window for a call and forwards it; answers `list_debug_windows` and `select_debug_window` |
| `src/controlServer.ts` | `ControlServer`: receives a forwarded call and runs it against this window's handlers |
| `src/core/opTable.ts` | the names of every op that may cross a window boundary, shared by both ends; `targetHintOf()` |
| `src/windowStatus.ts`, `src/core/windowStatus.ts` | the status-bar item and Select Target Window: the wiring, and the pure rendering |
| `src/utils/loopback.ts` | the `Host` and `Origin` checks, shared by the control server and the MCP endpoint |

## The registry

Each window keeps `window-<pid>.json` in a directory under `os.tmpdir()`: the
control port and token, the workspace folders, the window name, whether a
debug session is active and with which configuration, the CMSIS solution
path when the CMSIS Solution extension reports one, and its role (`router`
or `worker`; windows of 2.5.0 and earlier write none). The file is written
atomically, refreshed every 20 s, and rewritten at once when a debug session
starts or ends or the folders change — the session state is what routes every
call that names no file. Readers drop the files of processes that no longer
exist and of other windows not refreshed for 60 s; unreadable files and
leftover temporary files go once they are a minute old, since a peer may
still be writing a younger one. Windows of different extension versions read
each other's files, so the format stays stable and readers ignore fields they
do not know. The first field, `_note`, is for whoever opens the file: it
says the file is internal and names the tools agents use instead.

Beside the window files lies `default-target.json`, written 0600 by
Select Target Window: `{pid, workspaceFolder, name, setAt}`. Readers of every
version pass it by, since its name does not start with `window-`. Whoever
can write it steers path-less agent calls, so it is read only from a
directory this user trusts, like the window files.

A token in the registry is enough to flash or erase that window's board, so
only its user may read the registry (#19):

- **Where.** `resolveRegistryDir()` keeps the name
  `cmsis-developer-assistant-registry` where the temp directory is private to
  the user (macOS `$TMPDIR`, Windows `%TEMP%`, a folder in the home
  directory), so windows of 2.5.0 and earlier stay visible there. Where every
  user may write to the temp directory (Linux `/tmp`, macOS without
  `TMPDIR`), it appends the uid, so another user cannot take the one name all
  windows of this user look for. `os.tmpdir()` is the same in every extension
  host of the user, so all windows agree.
- **Modes.** `ensureRegistryDir()`, called by `register()` and `heartbeat()`,
  creates the directory 0700 and narrows an existing one of this user that
  others may enter (0755 before 2.5.1). The files are written 0600
  (`writeFileAtomicSync(…, { mode })`), and the heartbeat replaces an older
  0644 file within 20 s. Windows has no modes; the ACL of `%TEMP%` applies.
- **Refusal.** A directory that is a symbolic link, not a directory, or owned
  by another user is not written and not read. The window logs an error,
  shows one warning (`onRefused`), and `list()` returns only its own entry,
  so its tool calls still reach it while the other windows stay out of
  reach. Each heartbeat looks again and registers once the directory is fit.
- **Not solved here.** A process of the same user can read the files; that
  case is for agents to leave alone (the tool contract), not for file modes.
  The token is not rotated: a router caches a window's entry, token
  included, and checks only pid and port, so a new token would turn its next
  forward into a 403.

## Choosing the target window

`RoutingDebuggingHandler.resolveTarget()` walks a fixed ladder; the first rung
that applies decides:

1. **Window argument.** `cmsis_action`, `flash`, `reset`, `serial_open` and
   `serial_capture` take `window` in a routed session (#16): all digits is a process id,
   anything else a path inside the window's workspace (`targetHintOf()`). Like
   a path, it re-aims the session: the calls after it go to the same window,
   unless the session is pinned.
2. **Path.** A call that carries `fileFullPath` or `workingDirectory` goes to
   the window whose workspace folder contains it most deeply. A pin never
   overrides a path: a named file must not be opened in another window.
3. **Pin.** The window chosen with `select_debug_window`, by process id or by a
   path inside its workspace, for the rest of the MCP session.
4. **Cache.** The window this MCP session reached last, while it is still
   registered on the same control port.
5. **Default target.** The window the user chose with Select Target Window,
   found by its pid, or by its folder once a reload gave it a new pid.
6. **The only debugging window.** The one window with an active debug
   session.
7. **The only window.** The one registered window.

The default target comes after the cache so that a path the agent named
keeps its window within the session. For a click in the status bar to take
effect at once all the same, every session remembers the `setAt` of the
default it last saw (`followDefault()`): a new one drops the session's cache,
never its pin. Removing the default leaves each session where it is.

Otherwise the call is refused with the list of windows and the ways to pick
one — when two windows are debugging, reading memory from the wrong board
would look exactly like a firmware bug, so the router never guesses. The
refusal is `AMBIGUOUS_WINDOW`, and its `data.candidates` lists every
registered window (`pid`, `name`, `workspaceFolders`, `hasActiveSession`,
`isDefault`, and `role` for windows that publish one); its hint names
`select_debug_window` and the status bar, and a default target whose window
is not open. An empty registry and a pinned window that is gone are
`WINDOW_UNREACHABLE`; a path inside no workspace, a `window` argument that
matches nothing (with the same candidates in `data`), and a
`select_debug_window` without a selector or without a match are
`INVALID_ARGUMENT`. `list_debug_windows` shows every registered window, marks
the router, the current target, the pin and the default target, and the
reply of `select_debug_window` says when the pin overrides a default.

## Forwarding

The router POSTs `{op, args}` to `/op` on the target window's control port,
with the window's token in the `x-cmsis-developer-assistant-token` header,
and returns the `result` as the tool's answer. Both ends take the op names
from `src/core/opTable.ts`: the debugging ops (the `IDebuggingHandler`
method names), the serial ops and the documentation and build-artefact ops.
The table is checked at compile time against the handler interfaces, and the
router's forwarding methods are generated from it, so a new tool is routable
without further code. The `window` argument is the router's alone: it is
taken out of the arguments before they are sent.

- The router waits for socket activity for the tool's timeout plus 15 s, so
  the worker's own, more specific timeout answer arrives first. `cmsis_action`,
  `flash` and the documentation ops, which can take minutes, get at least ten
  minutes (`forwardTimeoutMs()`). A window that stays silent longer ends the
  call with `WORKER_TIMEOUT`; it is busy, not gone, so the session keeps it
  as its target.
- Requests above 1 MiB and responses above 16 MiB are cut off; they only
  guard against runaways. The first reaches the router as a 413 and becomes
  `INVALID_ARGUMENT`, the second is `INTERNAL`; either way the window
  answered and stays the target.
- The worker's own failure comes back with its code and hint, and the
  session keeps its target (#11). Only a failed channel — nothing listening,
  a dropped connection, a 403 for a stale token, a 404, an answer that is not
  a control reply — makes the session forget the window, with
  `WINDOW_UNREACHABLE` and a pointer to `list_debug_windows`. Before #11
  every handler error crossed the channel as a 500 that the router reported
  as an unreachable window, dropping the target on the way.

### The envelope

The request carries the header `x-cmsis-developer-assistant-envelope: 2`
(`CONTROL_ENVELOPE_HEADER` in `src/core/opTable.ts`). A worker that knows it
answers typed and sets the same header on its reply: 200 `{result}` with the
`ToolText` as it is, or 500 `{error: {message, code, hint, data}}`. Without
the header — a router of 2.3.10 in a window not yet reloaded — the worker
answers in the old shapes, `{result: string}` and `{error: string}` with the
hint on the error's second line. The other way round, the router reads a
string without the header as a 2.3.10 result (`upgradeLegacyText()`): the
old fence failure `Error in '<tool>': …` becomes a classified `ToolError`,
the old fence cap a `timeout` reply; an `{error: string}` is classified the
same way. Both ends ignore fields they do not know, in the request body and
in the reply, so later additions need no new version.

Two such additions carry the problem journal (#48). The request names the
call it belongs to: `{op, args, callId, sessionId}`, from the call context
`MeasuredMcpServer` set, and the control server runs the op inside the same
context, so the target window's journal stamps its records with the id, and
`serial_open` records the MCP session as the holder of the port (#49). A typed reply carries the
target window's journal counters, `journalSeq` (the newest record) and
`journalErrors` (errors ever recorded), next to `result` or `error`. The
session's `ProblemNotices` keep a baseline per window pid: the first answer
sets it and `get_recent_problems` moves it. While errors lie beyond it,
`get_session_status` ends with a count line, and one successful result per
new batch ends with a note naming the `get_recent_problems` call to make. A
2.5.0 worker sends no counters, and then there is neither; a 2.3.10 router
gets no counters at all.

## The control server

`ControlServer` listens on an ephemeral port on `127.0.0.1`. The ops include
flashing and erasing the target, so a request passes three checks, in this
order, before its body is read:

1. `POST /op`, else 404.
2. A loopback `Host` (`isLoopbackHostHeader()`) and no `Origin` header at
   all, else 403. The router sends `Host: 127.0.0.1:<port>` and never an
   `Origin`; a browser page always sends one, so this keeps DNS-rebinding
   pages out even though they cannot read a token.
3. The window's token, compared with `crypto.timingSafeEqual` after a length
   check on the bytes, else 403. A header sent twice never matches, and
   nothing in the comparison can throw.

The 403 and 404 bodies are JSON that names `list_debug_windows` and
`select_debug_window`, for an agent that found the port by itself. Routers
read only the status of a 403 or 404, so the body changes nothing for them.

The server then checks the op name against the op table before looking up
any method, dispatches it to the debugging handler, the serial handler, or
the documentation or build-artefact handler, and answers `{result}` with 200
or `{error}` with 500, in the envelope the request asked for (see above). An
unknown op, a method the window lacks and absent documentation handlers are
`TOOL_DISABLED`.

Before the op table come the internal ops (`INTERNAL_OPS`), which are no
tools: the server answers them itself, outside the op hook of the status bar
and the problem journal. `sessionEnded {sessionId}` (#49) is one: the router
posts it, fire-and-forget with 2 s, to every window an MCP session forwarded
to once the session ended (`RoutingDebuggingHandler.sessionEnded()`, which
remembers those pids per session), and the window releases the serial port
and the Serial Monitor subscription the session held there (see
[serial.md](serial.md)). A window of an earlier version answers "not a known
operation", which the router ignores. The op runs through `runJournaled()`: registered in the
window's problem journal while it runs, and when it fails or its wait runs
out, up to five records it produced ride along in `data.problems`. The
trace line of each op logs the size of the result's text. Agents never see
the token: `describeWindow()` leaves port and token out of every listing.

## Window selection for people

Agents have `list_debug_windows`, `select_debug_window` and the `window`
argument; the user has the status bar (#16). Without it, two idle windows
were a tie that only the agent could settle, and nothing showed which window
was the router or which window an agent was driving.

- **The item.** Every started window shows one status-bar item,
  `cmsis-developer-assistant.window`, named "CMSIS Developer Assistant" so the
  status bar's own menu can hide it: `$(plug) CDA router` or
  `$(plug) CDA worker`, `· default` on the default target, and a spinner while
  an agent call runs in the window. Its tooltip gives the MCP endpoint, the
  default target, the calls running and the last one; in the router window
  also every open MCP session with the window it drives and the rung that
  chose it. The item shows with a single window too: it confirms the server
  runs.
- **Its sources.** `ControlServer.onOp()` tells the window when an op starts
  and ends; every call arrives that way, the router's own included. The
  router asks its `DebugMCPServer` for `describeSessions()`, which reads each
  session's `RoutingDebuggingHandler.describeTarget()` from memory. The
  default target is read again on the 20 s heartbeat, and at once in the
  window where the user chose it, so other windows show a new choice within
  20 s while routing follows it on the next call. A 5 s tick keeps the times
  in the tooltip current.
- **The command.** `cmsis-developer-assistant.selectTargetWindow`, the item's
  click, offers the registered windows (name, folders, role, debug session,
  solution) and **Automatic**; the choice is written to `default-target.json`
  (see [The registry](#the-registry)), Automatic removes the file. The
  command is registered in every window, and says so when no coordinator
  runs (the test runner).
- **Where to look.** `renderWindowStatus()`, `targetChoices()` and
  `toolNameOf()` in `src/core/windowStatus.ts` are pure; `WindowStatus` in
  `src/windowStatus.ts` holds the item, the tick and the quick pick; the
  coordinator creates it at the end of `start()` and re-renders it when the
  window becomes router.
- **The serial item.** A second item, apart from this one, shows only while
  an agent holds a serial port in the window, and its click releases the
  port (#49, see [serial.md](serial.md)).

The default target is honoured by routers of 2.5.1 and later; a router of
2.5.0 in a window that was not reloaded ignores the file.

## Shutdown

`WindowCoordinator.dispose()` first disposes the status-bar item and removes
the window from the registry, so no other window forwards into a closing
extension host, then stops the MCP server and the control server, then
releases the window's serial ports, giving that step at most two seconds.

## Tests

- `src/test/routing.test.ts`: the ladder, pins, refusals and a control-server
  round trip; typed outcomes — a worker error with its code and the target
  kept, a dead port, a silent window, 2.3.10 replies, both envelopes; the
  gate — wrong, doubled and non-ASCII tokens, `Origin`, a foreign `Host`; the
  default target, the `window` argument, the candidates' `isDefault` and
  `role`, and the op hook (#16); the problem journal — the call id in the
  envelope, the counters in the reply, a worker failure with its problems,
  the note once per batch and after `get_recent_problems` none, no note from
  a worker without counters; the end of a session — `sessionEnded` only to
  the windows it reached, once, an old or silent window passed by, and the
  control server's own answer without the op hook
- `src/test/workspaceRegistry.test.ts`: registration, pruning and path
  matching; the directory name, modes, and refused directories; the default
  target file and how its window is found again
- `src/test/windowStatus.test.ts`: the item's text and tooltip in every state,
  the Select Target Window entries, and a tool name for every op
- `src/test/atomicFile.test.ts` and `src/test/loopback.test.ts`: the writers'
  `mode` option and the loopback checks
- `src/test/windowCoordinator.test.ts`: the serial teardown on dispose
- `src/test/opTable.test.ts`: the op table and `targetHintOf()`
- `test/transport/two-window-routing.js`: two coordinators against one
  registry — one router, one worker, the same advertised endpoint, pinning,
  republishing on session start, `AMBIGUOUS_WINDOW` with two candidates when
  both debug, promotion when the router closes; roles and status-bar items,
  `window` on exactly the listed tools, `cmsis_action {window}`, a default
  chosen through the quick pick resolving the tie of two idle windows;
  problem records and the count of new errors from the target window only
