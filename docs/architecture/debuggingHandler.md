# DebuggingHandler

`DebuggingHandler` (`src/debuggingHandler.ts`, with helper modules in
`src/handler/`) decides what an agent is told. Every debugging tool has one
`handle*` method. The method checks the state of the debug session, asks the
executor — and, for `cmsis_action` and `flash`, the CMSIS Solution extension
or pyOCD — and answers with one text: what happened, the state that
resulted, and the next useful call when something stands in the way.

## Why a layer of its own

- The MCP layer stays a table of tool registrations (`src/debugTools.ts`)
  with no behaviour of its own.
- The executor (`src/debuggingExecutor.ts`) stays with VS Code and DAP
  mechanics: it returns data and throws when a request fails.
- Refusals, hints, state renderings and recovery reports are decided in one
  place, which can be tested against a scripted executor without a debug
  adapter.

## The contract

`IDebuggingHandler` has one method per debugging tool. Each takes the tool's
parsed arguments and resolves to a string. The method names are also the op
names that cross window boundaries: the router forwards a call by name, and
the `ControlServer` of the target window invokes the method of that name with
`args ?? {}`. `src/core/opTable.ts` checks at compile time that its
`DEBUG_OPS` list and the interface name the same methods, so a new tool
cannot be left out of the routing (see [windowRouting.md](windowRouting.md)).

## How a call ends

| Tools | Failure | Too slow |
| ----- | ------- | -------- |
| Variables and expressions, memory, registers, cycle counter, peripherals, fault tools, SVD lookups, call stack and threads, `reset`, `wait_for_stop`, `cmsis_action`, `flash` | answered as `Error in '<tool>': <message>` | answered with a notice that the call did not complete within its limit |
| Session start, stop and restart, steps and continue, breakpoints and logpoints, `get_device_info`, `check_target_connection` | thrown as `<what failed>: <cause>`, which the client sees as an error result | bounded by the executor's request deadlines and by the stop and session waits below |

The first group runs inside `fenced()` (`src/handler/fence.ts`). The limit is
the call's `timeoutMs`, at most 60 s, or 30 s when none is given. The timer
starts before the work; when it fires, the work keeps running, since a DAP
request cannot be withdrawn, and whatever it produces later is dropped. Both
fence texts are ordinary tool results, and `src/core/toolMetrics.ts` counts
them as timeouts and errors by their wording.

Refusals are ordinary answers too: a second `start_debugging` while a session
exists, `pause_execution` on a halted target, `flash` under a live session.
`pause_execution` is neither fenced nor wrapped, so its refusals and errors
keep their own text. `check_target_connection` answers a hardware timeout as
text rather than throwing it.

## State gates

Most reads need a halted target. `requireStoppedTarget()` asks the executor
whether a session exists, answers its `threads` probe and is stopped
(`hasActiveSession()`). If not, it throws the refusal that
`stoppedTargetRefusal()` (`src/handler/sessionText.ts`) writes for the
current state — `no-session`, `initializing`, `running` or `unresponsive` —
with the next action for that state. Breakpoint tools and the SVD lookups are
not gated. `get_session_status` never fails: it reports the state, the
session's identity, the probe round trip and a hint for each state
(`renderSessionStatus()`).

## Moving the target and waiting for the stop

Steps, `continue_execution` and `pause_execution` go through
`sendAndAwaitStop()`. It arms the executor's stop waiter, which listens for
the DAP `stopped` event of the session, *before* the request goes out, then
waits for that event, the end of the session, or the limit: the call's
`timeoutMs` or the configured `timeoutInSeconds`, capped at 60 s either way.
VS Code's stack-item events never end a wait, because they also fire when
the item is cleared on resume.

When a step or continue has not stopped in time, `locateRunawayTarget()`
pauses the target and reports where it is — PC, LR, function and source line
— so the agent learns whether the firmware sits in a loop, an ISR or a fault
handler before it sets more breakpoints. `wait_for_stop` sends nothing: it
waits for the next stop, or returns at once when the target is already
halted.

After a stop the handler takes a `DebugState` from the executor and returns
its compact form. `compactState()` includes the breakpoint list only when it
differs from the list the agent saw last; `fullState()`, used after a session
start or a `cmsis_action` attach, shows everything. See
[debugState.md](debugState.md).

## Starting and stopping

`handleStartDebugging()` refuses while a session exists. With a
`configurationName` it starts that `launch.json` entry by name through the
executor. Without one it lets the user choose through
`promptForConfiguration()`, and the entry `Default Configuration` gets a
configuration synthesized from the source file (see
[debugConfigurationManager.md](debugConfigurationManager.md)). It then polls
the session state with exponential backoff (`awaitLiveSession()`) until the
target runs or stops, and answers with the full state; a failed start
carries the last lines the adapter reported. `handleStopDebugging()` adds a
short root-cause check to its reply: a reminder to explain the bug, not only
where it showed, before the investigation is closed.

## Breakpoints and logpoints

A breakpoint is set in two places: in VS Code's breakpoint model, which the
editor and the adapter see, and, while a session is live, in GDB itself
through the executor's `-exec` passthrough (`break file:line if condition`).
`classifyGdbReply()` (`src/handler/gdbText.ts`) sorts GDB's reply into bound,
rejected or unconfirmed; a `gdbtarget` adapter usually echoes nothing, and
the answer says that this is normal. A logpoint becomes a VS Code logpoint
plus a GDB `dprintf`, whose format string `translateLogMessage()` derives
from the `{expr}` and `{expr:%fmt}` message syntax. Conditions are handed to
GDB — an `if` clause on the breakpoint, a `condition` command for a logpoint
— so GDB evaluates them and the session stops only when they hold. The
deprecated
`lineContent` argument still works and sets a breakpoint on every line that
contains the text.

## Reading the target

- Variables come from the frame VS Code has focused (`focusedScopes()`); a
  request for `global` falls back to all scopes when the adapter reports no
  global scope. `src/core/variableView.ts` renders them, with caps unless the
  agent names the variables it wants.
- Variable and expression values that look like credentials are withheld
  while `redactSecrets` is on (read on every call; `src/utils/secretRedaction.ts`).
  Raw target reads — memory, core registers, peripherals, fault status — and
  the GDB passthrough are never redacted: real SVDs name registers `KEY` or
  `UNLOCK`.
- The memory dump, the core-register table and the cycle-counter text come
  from `src/handler/targetText.ts`.
- `diagnose_fault` combines the decoded fault registers, the stacked
  exception frame chosen by `EXC_RETURN`, the top of the call stack and the
  SVD's view of the faulting address into one report with ranked hypotheses
  (`src/core/faultTriage.ts`). Each read after the fault registers turns into
  a note when it fails, instead of failing the call.
- `lookup_peripheral` and `lookup_register` answer from the device SVD
  (`src/core/svdParser.ts`, `src/core/svdLookup.ts`) without a session.

## CMSIS actions and flashing

`src/handler/cmsisAction.ts` runs `cmsis_action`. Each action maps to a
command of the CMSIS Solution extension (`cmsis-csolution.build`,
`cmsis-csolution.cmsisLoadAndDebug` and so on). Those commands return before
their work is done, so the outcome is observed separately:

- `build`, `load`, `erase` and `load_and_run` wait for the cbuild or flash
  task to end (`vscode.tasks` process events) and report its exit code in a
  ✅ or ❌ line.
- `load_and_debug` and `attach` wait for a live session, then probe its
  threads twice (`probeSchedule()`), so a session with no target behind it is
  reported as such.
- `detach` and `stop_run` return at once.

When `target` names a target-type or target-set that is not active, the
selection is written into the solution folder's `.vscode/cmsis.json`, the
solution is re-activated, and the switch is verified through the extension
before anything runs (`src/core/cmsisTarget.ts` reads the csolution). A
switch is refused under a live debug session.

`src/handler/flashTool.ts` runs `flash`. It picks the `*.cbuild-run.yml` —
the argument, else `cmsis.cbuildRunFile` from `launch.json`, else the only
match under `out/` — refuses under a live debug session, and runs
`pyocd load --cbuild-run` through `src/core/flashController.ts`.

## The host seam

Everything else the handler needs comes from a `HandlerHost`
(`src/handler/host.ts`): clock, timers, VS Code's focused frame, task process
events, workspace folders and file search. `VSCODE_HOST` looks each of them
up in VS Code at the moment of the call. Unit tests override `host()` with a
scaled clock, so a 60 s fence or an 8 s session wait takes milliseconds.

## Known deviations

A few behaviours are known to be wrong and were kept on purpose, so that the
rewrite could be reviewed as behaviour-neutral. Comments in the code mark
each with its number (`KB3`, `KB6`, …); the list is in the *Known bugs to
preserve* section of `docs/provenance/specs/debuggingHandler.md`. Each is
fixed in a change of its own.

## Where to look

| File | Contents |
| ---- | -------- |
| `src/debuggingHandler.ts` | `IDebuggingHandler`, `DebuggingHandler`: gates, stop waits, state rendering, session start and stop, breakpoints, variables, target reads, fault triage, SVD lookups |
| `src/handler/fence.ts` | `fenced()`, `fenceLimitMs()`, `failureText()` |
| `src/handler/host.ts` | `HandlerHost`, `VSCODE_HOST` |
| `src/handler/gdbText.ts` | GDB reply classification, logpoint message to `dprintf` |
| `src/handler/sessionText.ts` | state refusals, the `get_session_status` text, call-stack and thread listings, recent adapter lines |
| `src/handler/targetText.ts` | register normalisation, register table, memory dump, cycle-counter text |
| `src/handler/cmsisAction.ts` | `cmsis_action`: commands, target switch, task and session waits |
| `src/handler/flashTool.ts` | `flash`: choice of the cbuild-run file, pyOCD |

## Tests

- `src/test/debuggingHandler.test.ts`: the handler against a scripted
  executor and host
- `test/transport/dap-scenarios.js`: 28 scripted `gdbtarget` sessions
  through the real server; every reply and the adapter traffic are compared
  with `dap-scenarios.snapshot.json`
- `test/transport/surface-snapshot.js`: every tool's reply without a session
- `test/realboard/run.ts`: every tool against a real board, run by hand
