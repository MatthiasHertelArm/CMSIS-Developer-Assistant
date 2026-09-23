# Spec: src/routingDebuggingHandler.ts

The router window builds one `RoutingDebuggingHandler` per MCP session. It implements the whole `IDebuggingHandler` surface, plus serial and pack-docs dispatch, by forwarding each call over HTTP to the control server of the window that owns the target (see [controlServer.md](controlServer.md) for the wire protocol, and [workspaceRegistry.md](workspaceRegistry.md) for how windows are found). It decides the target window with a fixed ladder: path hint, pin, the session's established target, the sole window with an active debug session, then the sole window. It never breaks a tie by guessing. It also serves the two routing-only tools, `list_debug_windows` and `select_debug_window`, in the router itself. Agents outside VS Code get a single MCP URL; this class makes that URL reach the window that actually holds the board, and it lets two sessions drive two boards at once.

## External contract

### Exports

One export, the class `RoutingDebuggingHandler`:

```ts
export class RoutingDebuggingHandler implements IDebuggingHandler {
    constructor(registry: WorkspaceRegistry, defaultToolMs: number);

    // Every IDebuggingHandler method, with the interface's exact signature:
    // handleStartDebugging … handleFlash (the 34 names in DEBUG_OPS, src/core/opTable.ts).

    listDebugWindows(): string;
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string;
    serialOp(op: string, args?: unknown): Promise<string>;
    packDocsOp(op: string, args?: unknown): Promise<string>;
}
```

- `IDebuggingHandler` (and `CmsisAction`, used in its `handleCmsisCommand` signature) are type-only imports from `./debuggingHandler`. The class must be declared `implements IDebuggingHandler`, so that a method added to the interface fails to compile here. The compile-time check in `src/core/opTable.ts` covers the op table, not this class.
- Users:
  - `src/windowCoordinator.ts` (`sessionHandlers()`), once per MCP session:
    - `new RoutingDebuggingHandler(registry, timeoutInSeconds * 1000)`.
    - It is used as `SessionHandlers.debug`, as `serial: (op, args) => router.serialOp(op, args)` and as `packDocs: (op, args) => router.packDocsOp(op, args)`.
    - It is used even when the target is the router's own window.
  - `src/debugMCPServer.ts` detects a routing handler structurally: `listDebugWindows` and `selectDebugWindow` must be functions reachable on the instance.
    - Only then does it register the tools `list_debug_windows` and `select_debug_window`, and it returns their string as the tool text.
    - A rejected promise from any forwarded method becomes an `isError` tool result carrying the error message. That wrapping is outside this file.
  - `test/transport/surface-snapshot.js` (loads `out/src/routingDebuggingHandler.js`) calls `new RoutingDebuggingHandler(registry, 30_000)`, then `serialOp` and `packDocsOp`.
  - `src/test/routing.test.ts`.

### Client side of the wire protocol

The request format, status codes and caps are specified in [controlServer.md](controlServer.md) under Wire protocol. The router sends:

- `POST` to host `127.0.0.1`, port = the target entry's `controlPort`, path `/op`, through Node's default HTTP agent.
- Headers:
  - `Content-Type: application/json`.
  - `Content-Length` = the UTF-8 byte length of the body.
  - `x-cmsis-developer-assistant-token` = the target entry's `controlToken`.
- The body `{"op":<op>,"args":<args>}`: JSON of an object with exactly these two keys, in this order.

It accepts responses up to `CONTROL_RESPONSE_MAX_BYTES` (16 777 216 bytes) from `src/core/opTable.ts`.

## Behaviour

### State

Each instance holds two pieces of state:

- the **cached target**: a `WindowRegistration` object, or none;
- the **pinned pid**: a number, or none.

Both start empty. Nothing is shared between instances, and nothing persists.

### Forwarded methods

This covers all `IDebuggingHandler` methods, `serialOp` and `packDocsOp`.

- **Op name:** for an interface method it is the method's own name. For `serialOp` and `packDocsOp` it is the given string. The router does not validate it; an unknown name is refused by the worker.
- **Args:** passed on as given. When the caller passes no args (or `undefined`), `{}` is sent. Methods without parameters (`handleStopDebugging`, `handleClearAllBreakpoints`, `handleListBreakpoints`, `handleGetDeviceInfo`, `handleCheckTargetConnection`, `handleGetSessionStatus`) send `{}`.
- Every forwarded method returns a promise and never throws synchronously. Routing errors are rejections too.

Sequence for one forwarded call:

1. Take the path hint `pathHintOf(args)` from `src/core/opTable.ts`: `fileFullPath` when it is a non-empty string, else `workingDirectory` when it is a non-empty string, else none. This applies to every op, serial and pack-docs ops included.
2. Resolve the target with the ladder below. A routing error rejects with its own text, unwrapped.
3. Log an info line naming the op, the target's pid and port, and the reason (see the log lines under Agent- or user-visible text).
4. Send the request and wait, as described under Request and response below.
5. On success, resolve with the worker's `result` value.
6. On any failure in step 4 (connection error, timeout, oversize response, non-200 status, missing `result`, unparsable body, and therefore also a worker handler's own error):
   - If the cached target has the same pid as the window just tried, clear the cached target. The pinned pid is never cleared here.
   - Reject with the wrapper text 6, which embeds the underlying message.

### Resolution ladder

The first step that applies decides.

1. **Path hint present.** `registry.findByPath(hint)`.
   - If it finds a window, that window becomes the cached target, with reason `path`. This happens even when a pin exists: the hint beats the pin for this call and re-aims the cached target, but the pin stays in force for later path-less calls.
   - If it finds none, reject with the no-target text for a hint, even when a cached target or a pin exists. A named file must never run in another window.
2. **Pinned pid set.** `registry.findByPid(pinnedPid)`.
   - If it finds the window, that window becomes the cached target, with reason `pinned`.
   - If not, reject with text 5. The pin stays set, so path-less calls keep failing until another `select_debug_window` succeeds.
3. **Cached target present and `registry.isLive(cachedTarget)`.** Use the cached object as it is (it is not re-read from the registry), with reason `cached`. Liveness means the same pid is registered with the same port.
4. Otherwise clear the cached target, then try `registry.findSoleActiveSession()`. If it finds a window, that window becomes the cached target, with reason `active-session`.
5. `registry.findSoleWindow()`. If it finds a window, that window becomes the cached target, with reason `only-window`.
6. Reject with the no-target text for no hint.

The no-target text is built from a fresh `registry.list()`, in this order:

- **No windows at all:** text 1. This takes precedence even when a hint was given.
- **A hint was given:** text 2, listing every window.
- **No hint, and more than one window has an active session:** text 3, where N = the number of active windows, listing *every* window.
- **No hint, otherwise:** text 4, where N = the number of all windows, listing every window.

The window listing inside these errors is one line per window, joined by `\n`. Each line is two spaces, `•` (U+2022), one space, then `describeWindow(entry)`.

### Request and response

- **Timeout:** `forwardTimeoutMs(op, args, defaultToolMs)` from `src/core/opTable.ts`. It is the per-call `timeoutMs` when that is a positive number, else `defaultToolMs`, plus 15 000 ms, with a floor of 600 000 ms for `handleCmsisCommand`, `handleFlash` and the five documentation ops.
  - The value is the request's socket inactivity timeout (the `timeout` option of `http.request`), not a wall-clock deadline.
  - When it fires, destroy the request with error text 7.
- **Response body:** collect raw bytes and keep a running count. When the count exceeds 16 777 216, destroy the request with error text 8 and discard the rest.
- **At the end of the body:** decode the collected bytes once as UTF-8. A multibyte character split across chunks must survive. Then:
  - Parse the body as JSON; an empty body counts as `{}`.
  - If the status is 200 and the parsed value has a `result` other than `undefined`, resolve with that value as it is. It is not type-checked, so a non-string value passes through.
  - Otherwise reject: with the parsed `error` value when it is neither `null` nor `undefined` (an empty string counts, and gives an empty message), else with text 9 for the status code.
  - If parsing fails, or the parsed value is `null`, reject with text 10.
- A stream error on the request or the response rejects with that error, for example `connect ECONNREFUSED 127.0.0.1:1`. The first settlement wins.

### listDebugWindows

`listDebugWindows()` is synchronous and never forwards. It reads `registry.list()`.

- With no windows it returns text 11.
- Otherwise it returns text 12, with one line per window in list order. A line is `•` (U+2022), one space, then `describeWindow(entry)`.
- Marks: when the window's pid equals the cached target's pid, or the pinned pid, the line gets a suffix. The suffix is two spaces, `←` (U+2190), one space, then the applicable marks joined by a comma and a space, in this order: `current target`, then `pinned`.
- The method does not change the state.

### selectDebugWindow

`selectDebugWindow({ pid, workspaceFolder })` is synchronous and never forwards.

1. If `pid` is `undefined` and `workspaceFolder` is falsy (missing or empty), return text 13. The state does not change.
2. Look the window up:
   - if `pid` is given, with `registry.findByPid(pid)`. `pid` wins when both are given.
   - otherwise with `registry.findByWorkspaceFolder(workspaceFolder)`. That accepts the folder or any path inside it, and also falls back to a sole window that has no folder open.
3. Not found: return text 14. The state does not change, and an existing pin is kept.
4. Found: set the pinned pid to its pid, make it the cached target, and return text 15.

## Agent- or user-visible text

None of these strings is shared with DebugMCP; quote them exactly. `<…>` marks a substituted value. `\n` is a newline. `<listing>` is the error listing defined under Resolution ladder. The surface snapshot's normalisation turns `pid=<digits>` into `pid=<n>`.

Routing errors (rejections):

```text
1  No CMSIS Developer Assistant-enabled VS Code window is currently registered. Open your project in VS Code and wait for the extension to activate.
2  No open VS Code window has "<hint>" inside its workspace.\nOpen the folder containing it, or pass a path that is inside one of these:\n<listing>
3  <N> VS Code windows have an active debug session, so there is no unambiguous target for this call.\nPick one with select_debug_window:\n<listing>
4  <N> VS Code windows are registered and none has an active debug session, so there is no unambiguous target for this call.\nStart a session (cmsis_action load_and_debug), or pick a window with select_debug_window:\n<listing>
5  The window pinned with select_debug_window (pid=<pinnedPid>) is gone. Pin another with select_debug_window, or call list_debug_windows to see what is open.
```

Forwarding failure (rejection). The wrapper is text 6; texts 7–10 are the inner messages the router produces itself:

```text
6  Could not reach the VS Code window handling this session (pid=<target pid>): <underlying message>\nIt may have been closed. Call list_debug_windows to see what is still open.
7  no response within <round(timeoutMs / 1000)>s — the target window may be busy or wedged
8  control response above 16777216 bytes from pid <target pid>
9  control server returned <HTTP status>
10 malformed control response: <first 200 characters of the decoded body>
```

- Text 7 uses `—` (U+2014).
- In text 8 the number is `CONTROL_RESPONSE_MAX_BYTES`.
- "First 200 characters" in text 10 means JavaScript string units, the equivalent of `slice(0, 200)`.

Routing-tool results (returned strings):

```text
11 No CMSIS Developer Assistant-enabled VS Code windows are currently registered.
12 Registered VS Code windows:\n<lines>\n\nPin one for this session with select_debug_window({ pid }) when the automatic choice is wrong.
13 Pass either pid or workspaceFolder. Call list_debug_windows to see the options.
14 No registered window matches <pid=<pid> | "<workspaceFolder>">.\n<Currently registered:\n<listing> | No windows are registered.>
15 This session is now pinned to: <describeWindow(found)>\nEvery subsequent tool call runs in that window until you pin another.
```

- In text 14, the first alternative is `pid=<pid>` when a pid was given, else the folder in double quotes. The tail is `Currently registered:` followed by a newline and the error listing when any window is registered, else `No windows are registered.`

Log line (info, output channel), one per forwarded call:

```text
Routing <op> → pid=<pid> port=<port> (via <ResolutionReason>)
```

- `→` is U+2192.
- `test/acceptance-ai-efficiency.md` item 2b.7 expects `Routing handleListTargetDocs → pid=<worker>`, so keep the prefix `Routing <op> → pid=<pid>`.
- Routing errors log nothing.

## Known bugs to preserve

Each item below: preserve (fixed separately later). The rewrite must not change any of them.

1. **The router misreports handler errors** (#11). Every failure of the request, including an ordinary error that the worker's handler reported as HTTP 500 `{"error"}`, a 403 from a stale token, a 404, a 413 and the router's own timeout, is wrapped in text 6 ("Could not reach the VS Code window …"). It also clears the cached target, so a plain "no active debug session" reads as an unreachable window. The surface snapshot pins this for `step_over`, `get_device_info`, `serial_open` and others.
2. **The timeout is socket-idle based and one-sided** (#14). It is not a wall-clock deadline. When it fires, the worker is not told and its op keeps running.
3. **The cached target is not refreshed** (#19). The cached entry, token included, is reused as long as the same pid is registered with the same port. A changed token on the same pid and port is not picked up.
4. **Routing is always on**, even when the target is the router's own window (one loopback hop). This is decided in `windowCoordinator.ts`; this file must not add a local shortcut.

## Test cases

These cases live in `src/test/routing.test.ts`. The server-side cases of its "control server" sub-suite are listed in [controlServer.md](controlServer.md). Both lists together make up the file.

### Op table cases

The first suite, "Op table", pins `src/core/opTable.ts`. That module is Arm-authored and unchanged, but these tests are part of the file being rewritten. They may stay in `routing.test.ts` or move to a new `src/test/opTable.test.ts`.

1. `isKnownOp` is true for `handleReadMemory`, `handleFlash` and `handleOpen`, and false for `handleNotARealOp`, `constructor` and `__proto__`.
2. `isSerialOp('handleListPorts')` is true, and `isSerialOp('handleReadMemory')` is false.
3. Pack-docs ops:
   - `isKnownOp` is true for `handleSearchTargetDocs` and `handleGetMemoryUsage`.
   - `handleListTargetDocs` is both a pack-docs op and a doc op.
   - `handleLookupSymbol` is a pack-docs op but not a doc op.
   - `handleReadMemory` is not a pack-docs op, and `handleFetchDoc` is not a serial op.
   - `PACKDOCS_OPS` has 10 entries.
4. No name appears twice across `DEBUG_OPS`, `SERIAL_OPS` and `PACKDOCS_OPS`.
5. `pathHintOf` prefers `fileFullPath` (`{fileFullPath:'/a/main.c', workingDirectory:'/b'}` gives `/a/main.c`). It falls back to `workingDirectory` (`{workingDirectory:'/b'}` gives `/b`). It gives `undefined` for `{address:'0x20000000', length:16}`, for `undefined`, and for `{fileFullPath:''}`.
6. `forwardTimeoutMs`:
   - `('handleReadMemory', {timeoutMs:5000}, 30000)` is greater than 5000.
   - `('handleStepOver', {}, 30000)` is exactly 45 000.
   - `handleCmsisCommand` and `handleFlash` with `{}` and 30000 are each at least 600 000.
   - `handleSearchTargetDocs` with `{}` is at least 600 000.
   - `handleReadDocPages` with `{timeoutMs:600000}` is at least 615 000.
   - `handleLookupSymbol` with `{}` is exactly 45 000.

### Routing test fixture

Suite "Multi-window routing":

- Each test gets a fresh temp registry directory, removed in teardown.
- The liveness check accepts only a set of fake pids, allocated from 500 001 upwards.
- A "window" is:
  - a started `ControlServer` with token `token-<label>`;
  - a fake debugging handler whose every `DEBUG_OPS` method answers with a string that encodes the label, the op and the JSON of the args received;
  - by default, a fake pack-docs pair that also encodes `docs` or `build`;
  - a `WindowRegistration` written directly as `window-<label>.json`, with a new fake pid, the server's port, `updatedAt: Date.now()` and per-test overrides.
- A "router" is `new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir, isAlive), 30_000)`.
- Teardown stops every server.
- A "stand-in window" is a bare `http` server on `127.0.0.1:0` that answers any request with a fixed body, registered under a live fake pid.

### Resolution cases

1. **A path hint picks the owner.**
   - Given windows `alpha` (folder `<dir>/alpha`) and `beta` (folder `<dir>/beta`),
   - when `handleAddBreakpoint({ fileFullPath: '<dir>/beta/main.c', line: 10 })` is called,
   - then beta answers.
2. **Path-less calls stick to the established target.**
   - Given the same two windows and a router whose first call was that breakpoint in beta,
   - when `handleReadMemory({ address: '0x20000000', length: 16 })` is called,
   - then beta answers.
3. **The sole active session wins.**
   - Given `idle` and `board` (`hasActiveSession: true`),
   - when a fresh router calls `handleReadCoreRegisters({})`,
   - then board answers.
4. **The only window wins.**
   - Given one window `solo`,
   - when `handleGetSessionStatus()` is called,
   - then solo answers.
5. **Two active sessions are refused.**
   - Given `boardA` (folder `<dir>/a`) and `boardB` (folder `<dir>/b`), both active,
   - when `handleReadMemory({ address: '0x0', length: 4 })` is called,
   - then it rejects with a message that matches `/2 VS Code windows have an active debug session/` and `/select_debug_window/`, and contains both folder paths.
6. **An unmatched hint is an error, even with a cached target.**
   - Given a router that has already routed `handleGetSessionStatus()` to the only window `alpha`,
   - when `handleAddBreakpoint({ fileFullPath: '/not/in/any/workspace.c', line: 1 })` is called,
   - then it rejects with a message matching `/No open VS Code window has/`.
7. **No windows.**
   - Given an empty registry directory,
   - when `handleGetSessionStatus()` is called,
   - then it rejects with a message matching `/No CMSIS Developer Assistant-enabled VS Code window/`.

### Explicit selection cases

1. **A pin beats the active-session rule.**
   - Given `idle` and `board` (active),
   - when `selectDebugWindow({ pid: <idle pid> })` is called,
   - then the returned text matches `/pinned to/`, and a following `handleReadMemory({ address: '0x0', length: 4 })` is answered by idle.
2. **Selecting an unknown window lists what is there.**
   - Given window `alpha`,
   - when `selectDebugWindow({ workspaceFolder: '/nowhere' })` is called,
   - then the text matches `/No registered window matches/` and `/alpha|Currently registered/`.
3. **Selecting with no argument.**
   - When `selectDebugWindow({})` is called,
   - then the text matches `/Pass either pid or workspaceFolder/`.
4. **The listing marks the current target.**
   - Given one window and a router that has routed `handleGetSessionStatus()`,
   - when `listDebugWindows()` is called,
   - then the text matches `/current target/`.
5. **The listing when empty.**
   - Given no windows,
   - when `listDebugWindows()` is called,
   - then the text matches `/No CMSIS Developer Assistant-enabled VS Code windows/`.

### Router-side cases of the control-server sub-suite

1. **A response split inside a character.**
   - Given a stand-in window that answers 200 with `{"result":"ok 😀 done"}`, written in two parts split one byte into the emoji about 20 ms apart,
   - when `handleGetSessionStatus()` is routed to it,
   - then it resolves to exactly `ok 😀 done`.
2. **An oversize response is refused.**
   - Given a stand-in window that answers 200 with `{"result":"` followed by 16 777 217 `A` bytes,
   - when `handleGetSessionStatus()` is routed to it,
   - then it rejects with a message matching `/control response above \d+ bytes/`.
3. **A dead window.**
   - Given a window whose registry entry is rewritten to `controlPort: 1`,
   - when `handleGetSessionStatus()` is called,
   - then it rejects with a message matching `/Could not reach the VS Code window/` and `/list_debug_windows/`.

### Transport harness dependencies

These tests are not rewritten, but they must stay green.

- `test/transport/surface.snapshot.json`:
  - Shape `routed-no-window`: every routed tool, `start_debugging` with its path hint included, must give text 1. `list_debug_windows` must give text 11, and `select_debug_window {pid: 1}` must give `No registered window matches pid=<n>.\nNo windows are registered.`.
  - Shape `routed-one-worker`:
    - `start_debugging`, `add_breakpoint` and `remove_breakpoint` with the hint `/nonexistent/main.c` give text 2, whose listing is the single line two spaces, `•`, one space, `pid=<n> | <tmp>`.
    - Path-less calls reach the worker through `only-window`.
    - The worker's handler errors come back wrapped in text 6 (known bug 1).
    - `list_debug_windows` gives `Registered VS Code windows:\n• pid=<n> | <tmp>  ← current target\n\nPin one …`. The successful calls after the last wrapped failure re-established the target.
    - `select_debug_window {pid: 1}` gives `No registered window matches pid=<n>.\nCurrently registered:\n  • pid=<n> | <tmp>`.
- `test/transport/two-window-routing.js`:
  - `list_debug_windows` contains both folder paths, one of them non-ASCII.
  - `select_debug_window {workspaceFolder}` starts with `This session is now pinned to:` and contains the folder.
  - The pinned window's listing line contains both `pinned` and `current target`.
  - A window with an active session shows `debugging: AppKit-E8 Debug`.
  - After failover, the new router's listing contains `Registered VS Code windows`.

## Constraints

- Node APIs: `http.request` (default agent, `timeout` option, `'timeout'`, `'error'`, `destroy(error)`), `Buffer` (byte length; concatenate, then decode once as UTF-8).
- Use `forwardTimeoutMs`, `pathHintOf` and `CONTROL_RESPONSE_MAX_BYTES` from `src/core/opTable.ts`, and `describeWindow`, `WorkspaceRegistry`, `WindowRegistration` and `ResolutionReason` from `src/utils/workspaceRegistry.ts`. Do not duplicate them.
- Every forwarded method may be written by hand or generated from the op table, but the class must still type-check as `implements IDebuggingHandler`. `listDebugWindows` and `selectDebugWindow` must be callable as methods on the instance.
- Log through `logger` from `src/utils/logger`, never `console`.
- File header: the Arm Apache-2.0 block comment exactly as in lines 1–15 of `src/core/toolRun.ts`, with no Microsoft line. The same applies to the rewritten `src/test/routing.test.ts`, which uses the mocha TDD interface.
- Remove `src/routingDebuggingHandler.ts` (and, with controlServer.md, `src/test/routing.test.ts`) from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- Acceptance: `npm run compile`, `npm run lint`, `npm test`, `node test/transport/surface-snapshot.js` (byte-identical) and `node test/transport/two-window-routing.js` pass, and `npm run provenance:check -- --gate` passes (at most 3 shared non-trivial lines per file).
