# DebuggingHandler

`DebuggingHandler` (`src/debuggingHandler.ts`, with helper modules in
`src/handler/`) decides what an agent is told. Every debugging tool has one
`handle*` method. The method checks the state of the debug session, asks the
executor — and, for `cmsis_action` and `flash`, the CMSIS Solution extension
or pyOCD — and answers with one text: what happened, the state that
resulted, and the next useful call when something stands in the way. A
failure is not an answer but a rejection with an error code (#11).

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
parsed arguments and resolves to a `ToolText` — a string, or a `ToolReply`
whose status says a wait ran out (`timeout`) or the work goes on
(`running`) — or rejects with a `ToolError` that carries an `ErrorCode`, the
message and, where there is one, the next step as `hint`
(`src/core/toolResult.ts`). The method names are also the op
names that cross window boundaries: the router forwards a call by name, and
the `ControlServer` of the target window invokes the method of that name with
`args ?? {}`. `src/core/opTable.ts` checks at compile time that its
`DEBUG_OPS` list and the interface name the same methods, so a new tool
cannot be left out of the routing (see [windowRouting.md](windowRouting.md)).

## How a call ends

| Tools | Failure | Too slow |
| ----- | ------- | -------- |
| Variables and expressions, memory, registers, cycle counter, peripherals, fault tools, SVD lookups, call stack and threads | rejected with the body's `ToolError`; a plain error gets a code from `classifyError()` | rejected with `TIMEOUT`: a read that returned nothing has failed |
| `reset`, `wait_for_stop`, `cmsis_action`, `flash` | as above | answered with status `timeout` and the notice that the call did not complete within its limit |
| Session start, stop and restart, steps and continue, breakpoints and logpoints, `get_device_info`, `check_target_connection` | rejected as `<what failed>: <cause>` by `wrapError()`, which keeps the cause's code and hint | bounded by the executor's request deadlines and by the stop and session waits below |

The first two groups run inside `fenced()` (`src/handler/fence.ts`); its
`onCap` argument says which answer the cap gives. The limit is the call's
`timeoutMs`, at most 60 s, or 30 s when none is given. `cmsis_action` and
`flash` may wait up to 600 s (#12); they default to 60 s and count one
deadline from the call, so they answer before their fence, which stays as a
backstop with advice of its own. The timer starts before the work; when it
fires, the work keeps running, since a DAP request cannot be withdrawn, and
whatever it produces later, a rejection included, is dropped.

Refusals reject too: a second `start_debugging` while a session exists, or
`flash` while a session or a CMSIS task holds the probe, is `PROBE_BUSY`
with the step that frees the probe in the hint. `pause_execution` on a
halted target is an answer, since there is
nothing to do; it is neither fenced nor wrapped, so its refusals keep their
own text and code (`TIMEOUT` for an unresponsive probe, `NO_SESSION` while
the session starts or after it ended). `get_session_status` and
`check_target_connection` never reject for the state they report:
`check_target_connection` answers a hardware timeout as text.

## State gates

Most reads need a halted target. `requireStoppedTarget()` asks the executor
whether a session exists, answers its `threads` probe and is stopped
(`hasActiveSession()`). If not, it throws the `ToolError` that
`stoppedTargetRefusal()` (`src/handler/sessionText.ts`) builds for the
current state: `NO_SESSION` for `no-session` and `initializing`,
`TARGET_RUNNING` for `running`, `TIMEOUT` for `unresponsive`, each with the
next action for that state as its hint. The SVD lookups are not gated, and
the breakpoint tools do not refuse a running target (see below). `get_session_status` never fails: it reports the state, the
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
handler before it sets more breakpoints; that answer has status `timeout`,
as has a pause that sees no stop in time.
`wait_for_stop` sends nothing: it waits for the next stop, or returns at
once when the target is already halted. A wait that runs out answers with
status `timeout`, a session that ends meanwhile rejects with `NO_SESSION`.

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
where it showed, before the investigation is closed. `handleRestart()`
pauses a running CMSIS Debugger target first, so the adapter lets go of a
halted core, and then has the executor stop the session and start its
launch configuration again; the answer says so, names the configuration's
`preLaunchTask` and counts the GDB logpoints that ended with the old
session.

## Breakpoints and logpoints

A breakpoint lives in VS Code's breakpoint model on every adapter, its
condition included; VS Code sends it to the adapter, and the answer reports
how the adapter bound it (`breakpointBinding()`: verified — on the CMSIS
Debugger with GDB's breakpoint number and the line it moved to — or not,
with the adapter's reason), waiting at most 2 s for the adapter.
`list_breakpoints` shows the same for every breakpoint. A condition is
evaluated by GDB at every hit, which halts the core each time; the session
stops only when it holds. The deprecated `lineContent` argument still works
and sets a breakpoint on every line that contains the text.

On the CMSIS Debugger a logpoint is a GDB `dprintf` (#56), because
cdt-gdb-adapter prints a VS Code logpoint's message without filling in the
values. `translateLogMessage()` (`src/handler/gdbText.ts`) derives the format
string and arguments from the `{expr}` and `{expr:%fmt}` message syntax; the
executor sends MI `-dprintf-insert` at the file's path relative to its
workspace folder (a location that does not name the absolute path, so the
adapter's sync of VS Code's breakpoints for that file leaves the dprintf
alone), then `condition <n>` for a condition — a condition GDB refuses takes
the dprintf back out. The number from the MI result is remembered for the
session: `remove_breakpoint` and `clear_all_breakpoints` delete by number,
never with a bare `delete`, and `list_breakpoints` shows each logpoint with
its hit count from `-break-list`, forgetting one GDB no longer has. A VS
Code logpoint set at that line before the session is replaced. Other
adapters, and a logpoint set without a session, use a VS Code logpoint.
`classifyGdbReply()` sorts GDB's replies into done, running, rejected and
failed, and `gdbRefusal()` turns a refusal into `TARGET_RUNNING`,
`INVALID_ARGUMENT` or `INTERNAL`.

A breakpoint change on a running CMSIS Debugger target pauses the target,
applies the change and resumes it, also when the change fails
(`withTargetHalted()`, #13); the answer says for how long the target was
paused. The change is refused while the session initialises (`NO_SESSION`),
when the probe hangs (`TIMEOUT`) or when the pause does not stop the target
within 5 s (`TIMEOUT`). Other adapters take breakpoint changes while their
target runs.

## Reading the target

- Variables come from the frame VS Code has focused (`focusedScopes()`); a
  request for `global` falls back to all scopes when the adapter reports no
  global scope. `src/core/variableView.ts` renders them, with caps unless the
  agent names the variables it wants.
- Variable and expression values that look like credentials are withheld
  while `redactSecrets` is on (read on every call; `src/utils/secretRedaction.ts`).
  Raw target reads — memory, core registers, peripherals, fault status — and
  GDB commands (`-exec …` or `>…`) are never redacted: real SVDs name
  registers `KEY` or `UNLOCK`. On the CMSIS Debugger the executor sends such
  a command in the adapter's `>` prefix and returns the text GDB printed.
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
their work is done, so the outcome is observed separately, through the
window's CMSIS job tracker (next section):

- `build`, `load`, `erase` and `load_and_run` arm a job, issue the command
  and wait for the job: a ✅ line with the task, its exit code, how long it
  ran and the job id, or a ❌ line rejected as `TASK_FAILED`.
- `load_and_debug` waits for its pre-launch `CMSIS Load` when the launch
  configuration has one (a failed Load is the answer, before any session
  probe); then it and `attach` wait for a live session and probe its threads
  twice (`probeSchedule()`). A session object without threads yet is
  answered with status `running`; `TASK_FAILED` is kept for a session that
  is gone.
- `status` launches nothing and needs no solution: it waits for the job in
  flight, or lists the recent results and the live CMSIS tasks.
- `stop_run` waits until the CMSIS tasks it stops have ended, terminates
  leftovers itself after 3 s, and answers `PROBE_BUSY` for a task still
  alive after 10 s. `detach` returns at once.

Before any command: a debug session refuses `load_and_debug` and `attach`,
the probe guard refuses what another owner blocks (`PROBE_BUSY`), a window
without an active solution is `CMSIS_NO_SOLUTION`, an unknown target or
action `INVALID_ARGUMENT`, and so is a task the solution's `tasks.json` does
not have (`load` on an Arm Debugger adapter, for example).

When `target` names a target-type or target-set that is not active, the
selection is written into the solution folder's `.vscode/cmsis.json`, the
solution is re-activated, and the switch is verified through the extension
before anything runs (`src/core/cmsisTarget.ts` reads the csolution). A
switch is refused under a live debug session.

`src/handler/flashTool.ts` runs `flash`. It picks the `*.cbuild-run.yml` —
the argument, else `cmsis.cbuildRunFile` from `launch.json`, else the only
match under `out/` — refuses while a session or a CMSIS task holds the probe,
and runs `pyocd load --cbuild-run` through `src/core/flashController.ts`
with the pyOCD the CMSIS tasks use: the CMSIS Debugger extension's bundled
one, else the one the solution's `.cmsis/tools-environment.yml` names, else
one on PATH (`resolvePyocd()`). A refusal is `PROBE_BUSY`, a file that
cannot be chosen `INVALID_ARGUMENT`, no runnable pyOCD `TOOL_DISABLED`, a
failing run `TASK_FAILED`, and a run killed at its budget is answered with
status `timeout`.

## CMSIS jobs

The CMSIS Solution extension runs builds as its own task type and the
panel's Load, Run, Load+Run and Erase as tasks it writes into `tasks.json`.
`src/core/cmsisTasks.ts` knows those shapes: `classifyCmsisTask()` names a
task's kind by the rules the extension itself applies (the build type, the
Arm Debugger's flash task, exact labels from `tasks.json`), `reduceJob()`
folds task events into a job's state (`armed`, `started`, then `ok`,
`failed`, `cancelled`, `running-ok` or `not-started`), and `guardProbe()` is
the matrix of which action may touch the probe beside which owner.

`CmsisJobTracker` (`src/cmsisJobTracker.ts`) is one per window, shared by
its debugging handlers and created at activation, so that tasks started from
the panel are seen too. It keeps the live CMSIS executions and the jobs:

- a job is armed before its command goes out; executions alive at that
  moment never complete it, and it binds the first execution of each kind it
  expects that starts afterwards — for a build, the execution the command
  returns. Other CMSIS executions are noted, never the result, so a
  `cbuild setup` after a target switch cannot answer for a build;
- `load_and_run` counts as done once Load ended 0 and CMSIS Run, which
  hosts the GDB server and never ends, stayed up for 2 s;
- nothing expected starting within 10 s of the command is `not-started`;
- a build, load or erase started elsewhere is adopted as a job of its own,
  so that a repeated call attaches to it instead of starting another;
- settled jobs are kept for 10 minutes, in memory only; `get_session_status`
  shows one line from them and the live tasks.

A call has one deadline (#12): the solution checks and a target switch come
out of it, and a job still going when it passes is answered with status
`running` and the job in `data`. The texts live in `src/handler/jobText.ts`.

## The host seam

Everything else the handler needs comes from a `HandlerHost`
(`src/handler/host.ts`): clock, timers, VS Code's focused frame, the
window's CMSIS job tracker, workspace folders, file search, and where `flash`
looks for pyOCD. `VSCODE_HOST` looks each of them up in VS Code at the
moment of the call. Unit tests override `host()` with a scaled clock, so a
60 s fence or an 8 s session wait takes milliseconds, and with a tracker
over fake task events.

## Known deviations

A few behaviours are known to be wrong and were kept on purpose, so that the
rewrite could be reviewed as behaviour-neutral. Comments in the code mark
each with its number (`KB9`, `KB15`, …); the list is in the *Known bugs to
preserve* section of `docs/provenance/specs/debuggingHandler.md`. Each is
fixed in a change of its own: KB1, failures answered as ordinary text, by
the typed results of #11; KB2, KB4 and KB5 — the 60 s cap, the missing
probe guards and the task matching of `cmsis_action` — by the CMSIS jobs of
issues #12, #46 and #47; KB3 and KB12, breakpoint changes that ignored the
run state and a GDB breakpoint `remove_breakpoint` could not reach, by #13;
KB6, the `-exec` passthrough that never reached GDB on the CMSIS Debugger,
by #56.

## Where to look

| File | Contents |
| ---- | -------- |
| `src/debuggingHandler.ts` | `IDebuggingHandler`, `DebuggingHandler`: gates, stop waits, state rendering, session start and stop, breakpoints, variables, target reads, fault triage, SVD lookups |
| `src/handler/fence.ts` | `fenced()` and its `onCap` choice, `fenceLimitMs()`, `failureText()` |
| `src/core/toolResult.ts` | `ToolText`, `ToolReply`, `ToolError`, `ErrorCode`, `classifyError()`, `wrapError()` |
| `src/handler/host.ts` | `HandlerHost`, `VSCODE_HOST` |
| `src/handler/gdbText.ts` | GDB reply classification and refusals, the MI results of `-dprintf-insert` and `-break-list`, a logpoint's GDB location, logpoint message to `dprintf` |
| `src/handler/sessionText.ts` | state refusals with their codes, the `get_session_status` text, call-stack and thread listings, recent adapter lines |
| `src/handler/targetText.ts` | register normalisation, register table, memory dump, cycle-counter text |
| `src/handler/cmsisAction.ts` | `cmsis_action`: commands, probe guard, target switch, label pre-check, jobs, session waits, verified `stop_run`, `status` |
| `src/handler/jobText.ts` | job results, `running` replies, `status`, `PROBE_BUSY` refusals, the `get_session_status` task line |
| `src/cmsisJobTracker.ts` | `CmsisJobTracker`: live CMSIS executions, jobs, probe owners, the label pre-check; the window's instance |
| `src/core/cmsisTasks.ts` | task classifier, `reduceJob()`, `guardProbe()` |
| `src/handler/flashTool.ts` | `flash`: choice of the cbuild-run file, probe guard, pyOCD lookup |
| `src/core/flashController.ts` | `resolvePyocd()`, the pyOCD process and its output |

## Tests

- `src/test/debuggingHandler.test.ts`: the handler against a scripted
  executor and host, CMSIS jobs over fake task events included
- `src/test/cmsisTasks.test.ts`, `src/test/cmsisJobTracker.test.ts`: the
  classifier, the job state machine, the guard matrix and the tracker,
  replayed over task sequences derived from CMSIS Solution 1.70.1
  (`src/test/fixtures/cmsisTasks/`)
- `test/transport/dap-scenarios.js`: 33 scripted `gdbtarget` sessions
  through the real server; every reply and the adapter traffic are compared
  with `dap-scenarios.snapshot.json`
- `src/test/gdbText.test.ts`: GDB reply classification, MI results, logpoint
  locations
- `test/transport/surface-snapshot.js`: every tool's reply without a session
- `test/realboard/run.ts`: every tool against a real board, run by hand
