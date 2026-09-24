# Serial ports

The `serial_*` tools let an agent read what the firmware prints on a UART
and write to it. They run in the window the router forwards them to, like
every other tool (see [windowRouting.md](windowRouting.md)); each window has
its own serial state.

## Why it is built this way

- **Two backends.** The owned port (`src/core/serialController.ts`) opens the
  device through the `serialport` package and buffers what arrives, up to
  1 MiB. The Serial Monitor bridge (`src/core/serialMonitorBridge.ts`) taps
  the Microsoft Serial Monitor extension, so an agent can read the user's
  session without taking the port; it lights up only once that extension's
  API offers a data event. `src/serialHandler.ts` turns both into the tool
  answers.
- **One owned port per window.** Several ports would need an owner per port
  and a `path` on every serial tool. A second `serial_open` while a port is
  held is `PORT_HELD`.
- **A port is exclusive, and agents forget.** On Windows a COM port has one
  holder; a port an agent left open makes the Serial Monitor or a terminal
  fail with "Access denied" until the window reloads. Nothing on the agent's
  side reliably closes it: a conversation just ends. So the port is held
  under a lease with release rules (#49), and whatever ends it says why.
- **The state follows the port.** When the port closes by itself (the
  adapter was unplugged, the probe's virtual COM port re-enumerated), the
  controller forgets it at once. The received bytes stay readable, and
  `lastRelease` keeps the reason for the tools to name.

## The lease

`SerialLease` in `src/core/serialLease.ts` holds what a held port is
granted on: the MCP session that opened it (the owner) and its rule,
`releaseOn` of `serial_open`:

| Rule | Released by |
| ---- | ----------- |
| `idle` (default) | `serial.idleCloseSeconds` without a serial call; the owner's session ending |
| `debug-session-end` | a debug session in this window ending; the owner's session ending |
| `manual` | nothing but `serial_close`; it outlives its session, for soak tests |

Every rule also ends with `serial_close`, with the window (the coordinator's
teardown) and with the user's Release command.

- **Owner.** `serial_open` records the MCP session id of the call from the
  call context (#48); in a routed session the control envelope brings it to
  the window. A call without a session records none, and then only the idle
  time and the other ends apply.
- **Idle.** Only serial calls count as use: `serial_read`, `serial_write`,
  `serial_status` and `serial_clear_buffer` touch the lease, and a call that
  waits (`during()`) holds it for as long as it runs. The bytes the board
  sends do not count. The limit is read from the setting at each open, so a
  change needs no reload; 0 turns the idle release off. The timer fires once
  per idle period and re-arms for the rest when the port was used meanwhile,
  so a touch is only a timestamp. Clock and timer are injected
  (`LeaseTimers`).
- **Release.** A rule's release forgets the port, keeps the buffer, records
  `lastRelease` (`idle`, `owner-gone`, `debug-session-end`, `user`, next to
  `disconnected` and `closed-unexpectedly` of the port's own end), writes one
  line to the output channel and one record to the window's problem journal
  (source `serial`, without payload: a warning for an unplug and for the
  user's release, info for a rule doing its job), and closes the device in
  the background. The next `serial_read` returns the bytes with the reason,
  `serial_write` fails with `PORT_CLOSED` and the same text.
- **The bridge.** A Serial Monitor subscription follows the same idle and
  owner rules; its end unsubscribes and drops its buffer, since those bytes
  belong to the user's session.

## One read in one call

Most agent questions about a UART are "what does the board print?". With
`serial_open`, `serial_read` and `serial_close` that is three calls and a
port that stays held when the third is forgotten. `serial_capture` does it
in one call and never leaves the port held (`SerialHandler.handleCapture()`,
`src/core/serialCapture.ts`):

- The regex `until` is compiled first: an invalid one is `INVALID_ARGUMENT`
  before any port is touched, since opening a port can already reset a board
  through DTR. A taken slot is `PORT_HELD`, with the hint to read the open
  port with `serial_read {waitMs}` instead.
- The port opens in the window's slot, for the calling session, so
  `serial_status` shows the capture while it runs. `write` is sent, and the
  capture reads until `until` matches, `durationMs` (100 ms to 60 s) runs
  out, or the port goes away; the port is closed in `finally`, also when a
  read throws. `open()` numbers each port, so the capture closes only its
  own. The target is not reset: for start-up output the agent opens the
  port, calls `reset`, then reads.
- `CaptureRecord` keeps up to 1 MiB, then the first 8 kB and the newest
  bytes. The regex is tried on each new chunk and the 8 kB before it, so a
  long capture costs no more per chunk than a short one. The answer is at
  most 16 kB of text: the first and the last 8 kB, cut at character
  boundaries, with the count of the bytes between, why it stopped and how
  long it took. A capture whose `until` never matched answers with status
  `timeout`; `data` repeats the numbers.
- The router gives a serial call at least the wait it names (`durationMs`,
  or `waitMs` of `serial_read`), whatever the tool timeout
  (`forwardTimeoutMs()`).

## When a session ends

The MCP server ends a session on the client's `DELETE`, and after 30 minutes
without a request while it holds no GET stream open (the sweep in
`DebugMCPServer`, see [debugMCPServer.md](debugMCPServer.md)). It then calls
the session's `ended` handler:

- A routed session's `RoutingDebuggingHandler.sessionEnded()` posts the
  internal op `sessionEnded {sessionId}` to every window the session forwarded
  to, at most 2 s each and without waiting for the answers. The control
  server answers it itself (`INTERNAL_OPS` in `src/core/opTable.ts`), outside
  the op table, the status bar's op hook and the journal, and calls
  `SerialHandler.sessionEnded()`. A window of an earlier version answers "not
  a known operation", which the router passes by.
- A server without a router calls the local `serialHandler.sessionEnded()`.

`sessionEnded()` releases the owned port and ends the subscription the
session held, unless the port's rule is `manual`.

## Errors

- `PORT_HELD`: the window's slot is taken, or the OS refuses the open because
  another program holds the device (Windows "Access denied", POSIX `EBUSY`,
  serialport's "Cannot lock port"). The hint names the Serial Monitor and
  `serial_subscribe_monitor`. The refused open is journaled with the code.
- `PORT_CLOSED`: a write without an open port, with the reason when a release
  took it. Windows of 2.5.0 do not know the code and read it as `INTERNAL`.

## Where to look

- `src/core/serialLease.ts`: `SerialLease`, `RELEASE_RULES`,
  `releaseRuleOf()`, `idleSecondsOf()`, `REAL_TIMERS`
- `src/core/serialController.ts`: `SerialController` (`open()` with its
  `HoldTerms`, `hold()`, `touch()`, `during()`, `sessionEnded()`,
  `debugSessionEnded()`, `releaseForUser()`, `onDidChange()`),
  `describeRelease()`, `reopenAdvice()`, `isHeldElsewhere()`
- `src/core/serialMonitorBridge.ts`: `SerialMonitorBridge`, its
  subscription's lease
- `src/core/serialText.ts`: what the tools say about a held port and its rule
- `src/core/serialCapture.ts`: `CaptureRecord`, `untilPattern()`,
  `renderCapture()`
- `src/serialHandler.ts`: the tools, the setting, `handleCapture()`,
  `sessionEnded()`
- `src/extension.ts`: a debug session's end reaches `debugSessionEnded()`
- `src/windowCoordinator.ts`: teardown within 2 s

## Tests

- `src/test/serialController.test.ts`: the port's own end, the lease on a
  hand-moved clock, the `releaseOn` matrix, the end of a session, the journal
  records, `PORT_HELD` for every OS refusal and path spelling, `PORT_CLOSED`
- `src/test/serialHandler.test.ts`: what `serial_open` and `serial_status`
  say, the setting read at each open, `sessionEnded()`, the bridge's rules;
  `serial_capture` closing the port on a match, at the deadline, on a read
  that throws and on an unplug, its refusals (invalid regex, taken slot,
  another program), the 16 kB answer and every path spelling
- `src/test/serialFixtures.ts`: the hand-moved clock, the scripted port, the
  Serial Monitor with a data event, the path fixtures
- `src/test/routing.test.ts`: the session id in the envelope, `sessionEnded`
  to the windows a session reached, an old window passed by, the control
  server's own answer
- `test/transport/session-lifecycle.js`: `serial_capture` over MCP on a mock
  port; `DELETE` and the expiry release a mock port through the local serial
  handler
