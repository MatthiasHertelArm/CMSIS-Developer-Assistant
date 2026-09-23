# DebuggingExecutor

`DebuggingExecutor` (`src/debuggingExecutor.ts`, with its modules in
`src/executor/`) is the only code that calls VS Code's debug API and sends
Debug Adapter Protocol requests to a debug adapter. The handler calls it for
every debugging tool. It hands back data — a `DebugState`, a `Buffer`, a
register table, a status record — and, for a few reports (connection check,
device information, decoded fault registers, peripheral reads), finished
text; how the result is presented to the agent is the handler's business.

## Why it is a layer of its own

On an embedded target the debug adapter is where calls hang: the probe
stalls, the target runs while a read expects it halted, the USB link drops.
With every DAP request in one class, all of them follow the same rules:

- Every request goes through `customRequestWithTimeout()` or `withTimeout()`
  (`src/utils/timeout.ts`) and has a deadline. A timeout is a
  `HardwareTimeoutError`, and fallbacks pass it on instead of trying a slower
  route: a hung probe is reported, not hidden behind a second attempt.
- Every deadline comes from `Budgets` (`src/executor/common.ts`).
- Wording aimed at the agent — refusals, hints, next steps — stays out of the
  executor.

## Which session, thread and frame

`resolveActiveSession()` (`src/utils/sessionStateTracker.ts`) picks the
session: the one VS Code has focused, else the most recently started live
session, since multi-core `gdbtarget` launches often leave none focused.
Thread and frame ids come from VS Code's focused stack item; they are not
checked against the chosen session.

Whether a target is halted is decided by the DAP `stopped` and `continued`
events, which the tracker registered at activation records for every
session. `activeStackItem` is not reliable for this on embedded targets: it
is empty while the target runs and for a moment after each stop. Only when no
event has been seen yet, as after an attach without an initial stop, does the
tracker fall back to the focused stack item.

## Deadlines

`Budgets` turns the two settings into the deadlines of a call. A tool's
`timeoutMs` arrives as `overrideMs` and replaces the setting for that one
call, never beyond 60 s.

| Budget | Default | Used for |
| ------ | ------- | -------- |
| `request()` | `dapRequestTimeoutMs`, 10 s | each DAP request |
| `operation()` | `memoryReadTimeoutMs`, 30 s | a read made of several requests: memory, registers, peripherals, DWT, fault status |
| `probe()` | the request budget, at most 3 s | the `threads` readiness probe |
| `snapshot()` | the request budget, no override | the `stackTrace` of a state snapshot |
| `stopWait()` | 60 s | a wait for the next stop event |

## What it does

The contract, `IDebuggingExecutor` in `src/executor/contract.ts`, is put
together from six interfaces, one per concern, so that the handler's tests
can fake only the part a case drives.

- **Session lifecycle.** Start a session with a configuration object, or by
  the name of a `launch.json` entry in the workspace folder that matches the
  working directory (`launchFolderFor()`); stop it; restart it through VS
  Code's restart command.
- **Readiness.** `hasActiveSession()` is true when a session exists, answers
  a `threads` probe and is halted. `getSessionStatus()` classifies the session
  as `no-session`, `initializing`, `running`, `stopped` or `unresponsive`
  from the same probe and never rejects (`probeSession()` in
  `src/executor/sessionReports.ts`, which also writes the connection and
  device reports). `getDiagnostics()` adds the server version and the live
  sessions of the window.
- **Run control.** Steps, continue and pause send the DAP request (`next`,
  `stepIn`, `stepOut`, `continue`, `pause`) for the focused thread. When the
  request fails for any reason except a timeout, VS Code's workbench command
  for the same action runs instead. None of them waits for the stop:
  `armStopWaiter()` and `waitForStop()` do, and the handler arms the waiter
  before it sends the request.
- **Breakpoints.** VS Code's breakpoint model (add, remove, list, clear
  source breakpoints) and GDB's own breakpoints through the `-exec`
  passthrough: an evaluate request in REPL context, whose reply text is
  returned as it is. On a `gdbtarget` session the adapter treats `-exec` input
  as an expression, so such a command does not reach GDB.
- **Program state.** `getCurrentDebugState()` takes a snapshot
  (`captureDebugState()` in `src/executor/snapshot.ts`): session,
  configuration, focused frame and thread, a 50-frame stack of that thread,
  the current source line with a few lines of look-ahead, and the window's
  source breakpoints. The location always comes from the adapter's top frame,
  never from the editor, and a snapshot never fails. The same snapshot without
  source text is how the executor finds the focused frame before a GDB
  command or register read. Call stacks, the thread list (with the top frame
  of the first 32 threads, fetched four at a time), variables per scope and
  expression evaluation are plain DAP requests.
- **Target access.** `readMemory()` uses DAP `readMemory` and falls back to
  reading word by word through GDB (`readWordThroughGdb()` in
  `src/executor/gdbMemory.ts` tries three expressions in turn);
  `writeMemoryWord()` checks its write by reading it back. Core registers are
  read as `$<name>` expressions, all at once, with `<timeout>` or
  `<unavailable>` for any that fail. The cycle counter enables the DWT
  (`DEMCR.TRCENA`, `CYCCNTENA`) on first use and reports a core without one.
  Peripheral reads ask the Peripheral Inspector extension first and otherwise
  read memory at the SVD address (`src/core/peripheralReader.ts`). The fault
  status registers are read as one block when possible, else word by word, and
  decoded by `src/core/faultDecoder.ts`.
- **Reset.** `resetTarget()` hands over to `performReset()` in
  `src/executor/targetReset.ts`. A running target is halted first; each
  method is sent as GDB monitor commands in the dialect of the GDB server
  behind the session (`src/core/resetAssist.ts`); the reset counts only when
  the PC afterwards equals the reset vector of the table VTOR points to. The
  method `auto` escalates from `system` to `core` to `hardware` until one
  verifies, and the target is resumed only after a verified reset with
  `halt: false`.

`SERVER_VERSION` is defined in `src/debuggingExecutor.ts` and must equal the
version in `package.json`; the release steps update it with `npm version`.

## Known deviations

Some behaviour is known to be wrong and was kept on purpose so that the
rewrite could be reviewed as behaviour-neutral: the workbench fallbacks act on
VS Code's focused session, which need not be the one the request went to; a
GDB command sent through `-exec` does not reach GDB on `gdbtarget`; every
frame lookup costs a `stackTrace` request. Comments in the code number each
case (`KB1`, `KB3`, `KB8`, …); the list is in the *Known bugs to preserve*
section of `docs/provenance/specs/debuggingExecutor.md`.

## Where to look

| File | Contents |
| ---- | -------- |
| `src/debuggingExecutor.ts` | `DebuggingExecutor`, `SERVER_VERSION`, the run-control table, GDB passthrough, memory, registers, DWT, peripherals, fault status, reset entry |
| `src/executor/contract.ts` | `IDebuggingExecutor` and its six parts, `HardwareTimeouts`, `SessionStatus`, `DapThread`, `ResetOutcome` |
| `src/executor/common.ts` | `Budgets`, `DEFAULT_HARDWARE_TIMEOUTS`, DAP reply shapes, `sessionOrThrow()`, `focusedThreadId()`, `toStackFrame()` |
| `src/executor/snapshot.ts` | `captureDebugState()` |
| `src/executor/gdbMemory.ts` | address helpers, `readWordThroughGdb()` |
| `src/executor/sessionReports.ts` | `probeSession()`, `connectionReport()`, `deviceReport()`, `launchFolderFor()` |
| `src/executor/targetReset.ts` | `performReset()`, `programCounterFrom()` |
| `src/utils/sessionStateTracker.ts` | session choice, stop events and waits, recent adapter output |
| `src/utils/timeout.ts` | `withTimeout()`, `customRequestWithTimeout()`, `HardwareTimeoutError` |

## Tests

- `test/transport/executor-cases.js`: the executor alone against scripted
  debug sessions — DAP requests and their arguments, workbench fallbacks,
  timeouts, reset verification, the GDB word-read ladder
- `test/transport/dap-scenarios.js`: the executor behind the handler and the
  server, 28 scripted `gdbtarget` sessions
- `src/test/timeout.test.ts`: the timeout helpers
- `test/realboard/run.ts`: every tool against a real board, run by hand
