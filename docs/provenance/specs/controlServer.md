# Spec: src/controlServer.ts

Every VS Code window runs one `ControlServer`: a loopback-only HTTP endpoint that executes a single named operation against this window's own handlers (debugging handler, serial handler singleton, documentation / build-artefact handler pair) and answers with the handler's result string. The router window's `RoutingDebuggingHandler` is its only production client. Each forwarded tool call therefore runs in the window that owns the workspace and the probe, not in the window that holds the MCP port. The endpoint can flash and erase hardware and is gated only by a per-window token that the window publishes in the registry file (see [workspaceRegistry.md](workspaceRegistry.md)).

## External contract

### Exports

One export, the class `ControlServer`:

```ts
export class ControlServer {
    constructor(handler: IDebuggingHandler, token: string, packDocs?: PackDocsHandlers);
    getPort(): number;
    start(): Promise<number>;
    stop(): Promise<void>;
}
```

- `IDebuggingHandler` is the interface from `./debuggingHandler` (type-only use). `PackDocsHandlers` is `{ docs: PackDocsHandler; build: BuildInfoHandler }` from `./packDocsDispatch` (type-only use).
- Users:
  - `src/windowCoordinator.ts`: constructs it once per window with the window's local `DebuggingHandler`, a `randomUUID()` token and the optional pack-docs pair. It calls `start()` at activation, `getPort()` whenever it publishes the registry entry, and `stop()` in `dispose()`.
  - `test/transport/surface-snapshot.js` (loads `out/src/controlServer.js`): a worker built from a real `DebuggingHandler` plus a `PackDocsHandler` / `BuildInfoHandler` pair, token `surface-token`; it uses `start()` and `stop()`.
  - `src/test/routing.test.ts`: fake handlers, `start()`, `stop()`; one server is constructed without the third argument.
- Two architecture docs name the private dispatch step `ControlServer.dispatch`: `docs/architecture/debugMCPServer.md` (the `control op=… ms=…` log line) and `docs/architecture/packDocs.md` (three-way dispatch). If the rewrite names that step differently, update both docs.

### Wire protocol

This is a cross-version contract. Windows running different extension versions forward to each other, so every item below must stay exactly as it is.

- **Transport:** HTTP/1.1 over TCP to `127.0.0.1:<controlPort>`, where `controlPort` is the value in the worker's registry entry. The server binds `127.0.0.1` only, on an ephemeral port that the OS chooses (listen on port 0).
- **Request line:** method `POST`, request target exactly `/op`. Anything else (another method, `/op/`, `/op?x`, an absolute-form URL) is not the endpoint.
- **Token header:** `x-cmsis-developer-assistant-token`. The header name is case-insensitive, as in all HTTP. The value must equal the window's token exactly.
- **Other request headers:** the router sends `Content-Type: application/json` and a `Content-Length`. The server checks neither header and also accepts a chunked body.
- **Request body:** a UTF-8 JSON object `{"op": <string>, "args": <any JSON value>}`. The router always sends both keys, `op` first. A missing or `null` `args` is treated as `{}`.
- **Body cap:** `CONTROL_REQUEST_MAX_BYTES` from `src/core/opTable.ts`, which is 1 048 576 bytes (1 MiB). A body of exactly that size is accepted; one byte more is refused.
- **Responses:**

  | Status | When | Body |
  | ------ | ---- | ---- |
  | 404 | method is not `POST` or target is not `/op` (checked first) | empty, no content type |
  | 403 | token header missing or different (checked second) | empty, no content type |
  | 413 | body above the cap; sent only after the whole body was received | JSON `{"error":"control request above 1048576 bytes"}` |
  | 400 | the request stream failed (client aborted) before any answer was sent | empty, no content type |
  | 200 | the handler resolved | JSON `{"result": <handler result>}` |
  | 500 | body not JSON, no string `op`, op refused, handler unavailable, or the handler threw or rejected | JSON `{"error": <message string>}` |

- Status 200, 413 and 500 carry the header `Content-Type: application/json`, with no charset parameter. Every body is UTF-8.
- A handler result of `undefined` serializes as `{}`, so the key `result` is then absent. The router treats that as a failure (see [routingDebuggingHandler.md](routingDebuggingHandler.md)).
- The response cap on the router side is `CONTROL_RESPONSE_MAX_BYTES`, 16 777 216 bytes. That is router behaviour, but the server must not rely on sending more.
- There is no other endpoint, no Host or Origin check, no envelope version header and no timeout on the server side (see Known bugs).

## Behaviour

### Construction and getPort

- The constructor stores the handler, the token and the optional pack-docs pair. It has no side effects: no socket and no logging.
- `getPort()` returns 0 before `start()` has resolved, the bound port after that, and 0 again from the moment `stop()` begins.

### start

- `start()` creates an HTTP server and listens on `127.0.0.1`, port 0.
- It resolves with the port the OS assigned once the server is listening, and records that port for `getPort()`.
- If listening fails, `start()` rejects with the listen error.
- After listening succeeds, later server-level `'error'` events must never be unhandled, because an unhandled one would take down the extension host. They are logged with `logger.error` and nothing else happens.
- `start()` logs one info line with the address (see the log lines under Agent- or user-visible text).
- `start()` is called once per instance. A second call is not supported and need not be guarded.

### stop

- If no server is running (never started, or already stopped), `stop()` resolves at once.
- Otherwise it first forgets the server, so `getPort()` returns 0 and a concurrent or second `stop()` is a no-op. It then closes the server through `closeHttpServer(server)` from `src/utils/closeHttpServer.ts` with the default 2 000 ms grace: idle keep-alive connections close at once, and connections still in flight are destroyed when the grace expires.
- It resolves when the server has closed, and never rejects.
- Handler promises still in flight are not cancelled. Their clients see the connection reset (`socket hang up` or `ECONNRESET`).

### Request handling

For each request, in this order:

1. Method or target mismatch: answer 404 with an empty body. Stop; the body is not read.
2. Token mismatch: compare the token header value to the token with plain string equality. A missing header, a different value, or a duplicated header (Node joins duplicates into one string) is a mismatch. Answer 403 with an empty body. Stop.
3. Read the body as raw bytes and keep a running byte count. Never decode chunk by chunk: a multibyte UTF-8 character split across two chunks must arrive whole.
4. Cap: when the running count first exceeds 1 048 576, discard the bytes buffered so far and stop buffering, but keep reading (draining) the rest of the body. When the body ends, answer 413 with the JSON error above.
   - Do not destroy the socket and do not answer early. Answering while the client is still writing resets the connection before the client reads the answer (seen as `ECONNRESET` on Windows).
   - The drain is bounded, because the channel is loopback and the MCP side caps its requests at the same 1 MiB.
5. Stream error on the request (for example the client aborted mid-body): log a warning with the error message. If no response headers have been sent yet, answer 400 with an empty body. The server keeps serving other requests.
6. On body end, if the body was not refused, decode the collected bytes once as UTF-8.
   - Parse the decoded body as JSON; an empty body counts as `{}`.
   - A parse failure is answered as 500 with the parser's own message.
   - If the value has no string `op` property (this includes numbers, strings and arrays), answer 500 with `Control request has no op`. JSON `null` also ends in a 500, with a runtime error message that is not contract.
   - Otherwise dispatch `op` with `args`, where a missing or `null` `args` becomes `{}`.
7. Dispatch resolved: answer 200 with `{"result": <value>}`. Dispatch threw (synchronously or asynchronously) or rejected: answer 500 with `{"error": m}`. `m` is the `Error`'s `message`, or `String(value)` when something other than an `Error` was thrown.

Requests are independent. There is no queue, no concurrency limit and no deadline, so several ops may run at the same time in one window.

### Dispatch

Dispatch runs one op against this window's handlers:

1. If `isKnownOp(op)` from `src/core/opTable.ts` is false, reject with the unknown-op error (see text 3). The op name must never reach a property lookup before this check, so `constructor`, `__proto__` and similar names are refused here.
2. Choose the owner of the op:
   - Serial ops (`isSerialOp`) go to the `serialHandler` singleton exported by `./serialHandler`.
   - Pack-docs ops (`isPackDocsOp`) go to `packDocs.docs` when `isPackDocsDocOp(op)` holds, else to `packDocs.build`. If the server was built without a pack-docs pair, reject with text 4.
   - Every other op goes to the debugging handler given to the constructor.
3. If the owner has no function under the name `op`, reject with text 5.
4. Call that function with the owner as `this` and exactly one argument, `args`. Handlers that take no parameters receive `{}` as well.
   - A synchronous return value is accepted as if it had been resolved.
   - A synchronous throw becomes a 500 like a rejection.
5. When the call settles, log one info line: elapsed milliseconds and result size on success, or elapsed milliseconds and the error message on failure. The value or error passes through unchanged.

## Agent- or user-visible text

These strings reach the router in the `error` field. The router wraps them into the "Could not reach …" message (see [routingDebuggingHandler.md](routingDebuggingHandler.md)), and that message reaches the MCP client as a tool error.

1. The 413 body error, exactly: `control request above 1048576 bytes` (the number is `CONTROL_REQUEST_MAX_BYTES`). `routing.test.ts` asserts `/control request above \d+ bytes/`.
2. `Control request has no op`
3. [REWORD] Refusal of an op name that is not in the op table; the message must contain the op name. The DebugMCP text is shared verbatim, so the new wording must differ.
   - The test for this refusal asserts the new wording (see test 2 below).
   - Interop note: proposals #14 and #49 plan to recognise an *old* worker by its answer to an op it does not know. Whoever implements them must accept the 2.3.10 wording (`Unknown control op: <op>`) as well as the new one, or better key on HTTP 500 plus the op name, not on the text.
4. `` Control op <op>: the documentation and build-artefact handlers are not available in this window ``. The test asserts `/not available in this window/`.
5. `Control op <op> is not implemented in this window`
6. The JSON parser's own message for a body that is not valid JSON. It is not contract; whatever `JSON.parse` throws.
7. Any handler error message passes through verbatim. The surface snapshot depends on this (see Transport harness dependencies).

Log lines go to the "CMSIS Developer Assistant" output channel through `logger` and are user-visible. Only the `control op=` lines are referenced in docs:

- [REWORD] Info, at start: the control server is listening, with the address `127.0.0.1:<port>`. It must contain `127.0.0.1:<port>`. The current wording matches DebugMCP's apart from the product name.
- Error, on a server error after start: the message `Control server error` with the error attached.
- Warn, on a request stream error: `` Control request aborted: <error message> ``.
- Info, when an op succeeds: `` control op=<op> ms=<elapsed> out=<UTF-8 bytes of result, 0 when null or undefined> B ``.
- Info, when an op fails: `` control op=<op> ms=<elapsed> failed: <message> ``.
- `docs/architecture/debugMCPServer.md` quotes the prefix `control op=… ms=…`. Keep that prefix.

## Known bugs to preserve

Each item below: preserve (fixed separately later). The rewrite must not change any of them.

1. **Non-constant-time token compare** (#19). The token header is compared with plain string equality, not `crypto.timingSafeEqual`. There is no Host or Origin check. The 403 and 404 answers have empty bodies; #19 would make them JSON.
2. **No dispatch fence** (#14).
   - The server awaits the handler with no deadline and no abort.
   - `requestTimeout` and `headersTimeout` are left at Node's defaults.
   - When the router gives up, the worker is not told and the op keeps running.
   - There is no health op and no busy table.
3. **Handler errors are indistinguishable from transport failures** (#11). A handler's own error goes out as a plain 500 `{"error": …}`, with no error code and no envelope version, so the router cannot tell it apart from a transport failure and misreports it (see [routingDebuggingHandler.md](routingDebuggingHandler.md)).

## Test cases

These cases live in `src/test/routing.test.ts`, suite "Multi-window routing", sub-suite "control server". The router-side cases of the same sub-suite, and the fixture they share, are in [routingDebuggingHandler.md](routingDebuggingHandler.md) under "Routing test fixture". Each fake handler answers with a string that identifies the window, the handler kind (debug, docs or build), the op and the JSON of the `args` it received. The shared teardown stops every server.

1. **The token gate.**
   - Given a live window whose registry entry was rewritten with a wrong token,
   - when a fresh router forwards `handleGetSessionStatus`,
   - then the call rejects and the message matches `/403|Could not reach/`.
2. **An unknown op is refused, not dispatched.**
   - Given one live window,
   - when the router forwards the op name `handleNotAnOp` through `serialOp`,
   - then the call rejects and the message contains the reworded unknown-op text (text 3).
3. **Pack-docs ops reach the owning window and the right handler.**
   - Given windows `alpha` and `beta` with their own folders, and a session pinned with `selectDebugWindow({ workspaceFolder: <beta folder>/src })`,
   - when `packDocsOp('handleListTargetDocs', { target: 'HE' })` and then `packDocsOp('handleGetMemoryUsage', { top: 5 })` are forwarded,
   - then the first answer is exactly beta's *docs* handler answer with args `{"target":"HE"}`, and the second is exactly beta's *build* handler answer with args `{"top":5}`.
4. **No pack-docs pair means a refusal.**
   - Given the only window was built without a pack-docs pair,
   - when `packDocsOp('handleListTargetDocs', {})` is forwarded,
   - then it rejects with a message matching `/not available in this window/`.
5. **Args survive the round trip.**
   - Given one window,
   - when `handleReadMemory({ address: '0x20000000', length: 64, format: 'hex' })` is forwarded,
   - then the handler's echo contains `"address":"0x20000000"`, `"length":64` and `"format":"hex"`.
6. **A multibyte character split across request chunks arrives whole.**
   - Given one window, and a raw POST to its control server with the correct token, chunked (no `Content-Length`), whose JSON body `{"op":"handleReadMemory","args":{"address":"a😀b"}}` is split inside the four-byte emoji with about 20 ms between the two writes,
   - when the request completes,
   - then the status is 200, the parsed `result` contains `"address":"a😀b"`, and it contains no U+FFFD.
7. **An oversize request gets 413, and the window keeps serving.**
   - Given one window, and a raw chunked POST written with no deliberate gap as `{"op":"handleGetSessionStatus","args":{}`, then 1 048 577 space bytes, then `}`,
   - when the request completes,
   - then the status is 413, the body matches `/control request above \d+ bytes/`, and a following routed `handleGetSessionStatus` to that window succeeds with that window's answer.
8. **A client abort does not take the window down.**
   - Given one window, and a raw POST that writes `{"op":"handleGetSess` and is destroyed about 20 ms later,
   - when about 50 ms have passed,
   - then a routed `handleGetSessionStatus` to that window succeeds.
9. **stop() is bounded while a request is in flight.**
   - Given a `ControlServer` with token `tok`, no pack-docs pair and a handler whose `handleGetSessionStatus` never settles, and a request for that op sent about 100 ms before,
   - when `stop()` is awaited,
   - then it returns in under 3 s, and the client's request fails with a message matching `/socket hang up|ECONNRESET|aborted/`.

### Transport harness dependencies

These tests are not rewritten, but they must stay green.

- `test/transport/surface.snapshot.json`, shape `routed-one-worker`, via `test/transport/surface-snapshot.js`:
  - The worker is a real `ControlServer`. Every successful routed reply (`stop_debugging`, `list_breakpoints`, the `Error in '…'` fence texts, `get_session_status`, the serial texts, `cmsis_action`, `flash`) depends on 200 `{"result"}` carrying the handler string byte for byte. That includes non-ASCII characters such as `—`, `→` and `·`.
  - Every `Could not reach the VS Code window … (pid=<n>): <handler message>` entry (`step_over`, `step_into`, `step_out`, `pause_execution`, `continue_execution`, `restart_debugging`, `get_device_info`, `serial_open`, `serial_write`) depends on the handler's error message arriving unchanged in 500 `{"error"}`.
- `test/transport/two-window-routing.js`: each `WindowCoordinator` starts a `ControlServer` and publishes `getPort()`. Router failover calls `dispose()`, which awaits `stop()`, and that must return promptly.

## Constraints

- Node APIs: `http` (`createServer`, `listen(0, '127.0.0.1')`, request and response streams), `Buffer` (concatenate, then decode once as UTF-8; byte length).
- Reuse `closeHttpServer` (`src/utils/closeHttpServer.ts`) for `stop()`, and the op table from `src/core/opTable.ts`: `isKnownOp`, `isSerialOp`, `isPackDocsOp`, `isPackDocsDocOp`, `CONTROL_REQUEST_MAX_BYTES`. Do not restate the op lists.
- `serialHandler` is the runtime singleton from `./serialHandler`. `IDebuggingHandler` and `PackDocsHandlers` are type-only imports.
- Log through `logger` from `src/utils/logger` (`info`, `warn`, `error(message, error?)`), never `console`.
- File header: the Arm Apache-2.0 block comment exactly as in lines 1–15 of `src/core/toolRun.ts`, with no Microsoft line. The rewritten `src/test/routing.test.ts` takes the same header.
- Remove `src/controlServer.ts` and `src/test/routing.test.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- Acceptance:
  - `npm run compile`, `npm run lint` and `npm test` pass.
  - `node test/transport/surface-snapshot.js` and `node test/transport/two-window-routing.js` pass unchanged.
  - `npm run provenance:check -- --gate` passes: at most 3 non-trivial lines shared with DebugMCP per file. Protocol constants must keep their values, but write the lines that carry them afresh.
