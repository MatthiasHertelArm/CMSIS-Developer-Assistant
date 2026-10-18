# DebuggingHandler

`DebuggingHandler` (`src/debuggingHandler.ts`, with helper modules in
`src/handler/`) decides what an agent is told. Every debugging tool has one
`handle*` method. The method checks the state of the debug session, asks the
executor — and, for `cmsis_action`, `cmsis_query` and `flash`, the CMSIS
Solution extension or pyOCD — and answers with one text: what happened, the state that
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
| Variables and expressions, memory, registers, cycle counter, peripherals, fault tools, SVD lookups, call stack and threads, `cmsis_query` | rejected with the body's `ToolError`; a plain error gets a code from `classifyError()` | rejected with `TIMEOUT`: a read that returned nothing has failed |
| `reset`, `wait_for_stop`, `cmsis_action`, `flash` | as above | answered with status `timeout` and the notice that the call did not complete within its limit |
| Session start, stop and restart, steps and continue, breakpoints and logpoints, `get_device_info`, `check_target_connection` | rejected as `<what failed>: <cause>` by `wrapError()`, which keeps the cause's code and hint; a `Refusal` passes as it is | bounded by the executor's request deadlines and by the stop and session waits below; the configuration picker of `start_debugging` fails with `INVALID_ARGUMENT` after its limit, and `stop_debugging` answers with status `timeout` after 10 s (#14). What stays unbounded here, the window's fence answers (see [windowRouting.md](windowRouting.md#fences-and-health-checks)) |

The cause reads as its message: a plain `Error` loses the `Error: ` its
string form would put in front, while a named class such as
`HardwareTimeoutError` keeps its name, which says what happened. A
`Refusal` (`src/core/toolResult.ts`) is a refusal that already names the
operation, the reason and the next step — the state gate, "nothing to
restart", a breakpoint change the session state rules out — so
`wrapError()` hands it on unchanged instead of prefixing it a second time.

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
own text and code (`PROBE_WEDGED` for an unresponsive probe, built by
`stoppedTargetRefusal()` like every gate's, `NO_SESSION` while the session
starts or after it ended). `get_session_status` and
`check_target_connection` never reject for the state they report:
`check_target_connection` answers a hardware timeout as text.

## State gates

Most reads need a halted target. `requireStoppedTarget()` asks the executor
whether a session exists, answers its `threads` probe and is stopped
(`hasActiveSession()`). If not, it throws the `Refusal` that
`stoppedTargetRefusal()` (`src/handler/sessionText.ts`) builds for the
current state: `NO_SESSION` for `no-session` and `initializing`,
`TARGET_RUNNING` for `running`, `PROBE_WEDGED` for `unresponsive` (#3), each
with the next action for that state as its hint: `cmsis_action
load_and_debug` (or `start_debugging` outside CMSIS projects) without a
session; `pause_execution`, or a breakpoint and `wait_for_stop`, while the
target runs (#20); and for `unresponsive` the way to reconnect for the
session's `request`, as for a failed read. The SVD lookups are not gated, and
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

What a wait that runs out means depends on the request (`MotionSpec.onWaitOut`).
A step should have stopped, so `locateRunawayTarget()` pauses the target and
reports where it is — PC, LR, function and source line — so the agent learns
whether the firmware sits in a loop, an ISR or a fault handler before it sets
more breakpoints; that answer has status `timeout`, as has a pause that sees
no stop in time. A continue is meant to run: the target is left running, and
the answer has status `running`, gives the wait it really had and names
`wait_for_stop` and `pause_execution`. Halting a target the agent asked to
run would change what it was waiting to observe. Every timeout text gives
the wait the call had, not the `timeoutInSeconds` setting.
`wait_for_stop` sends nothing: it waits for the next stop, or returns at
once when the target is already halted. A wait that runs out answers with
status `timeout`. A session that ends meanwhile rejects with `NO_SESSION`,
in a step or continue as in `pause_execution` and `wait_for_stop`, with the
calls that confirm it and start a new session as the hint.

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
[debugConfigurationManager.md](debugConfigurationManager.md)). The picker
waits for a person in a window the agent may not see, so
`chooseConfiguration()` bounds it (#14): a cancellation token fires after
the call's `timeoutMs`, 30 s without one and 60 s at most, on the host's
clock. The picker then closes and rejects with `PickerCancelled`, and the
call fails with `INVALID_ARGUMENT`, its hint naming the `launch.json`
entries to pass as `configurationName`. It then polls
the session state with exponential backoff (`awaitLiveSession()`) until the
target runs or stops, and answers with the full state; a failed start
carries what the adapter and the GDB server reported during the call, as
problem records (see [The problem journal](#the-problem-journal)).
`handleStopDebugging()` waits at most 10 s for VS Code to end the session
(`settlesWithin()`, #14): a stop that has not settled by then, while the
session is still listed, answers with status `timeout` and points to
`get_session_status`. Its success reply adds a
short root-cause check: a reminder to explain the bug, not only
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

- Variables and expressions use the frame VS Code has focused
  (`focusedFrame()`, `focusedScopes()`); a request for `global` falls back to
  all scopes when the adapter reports no global scope. The frame is asked
  for only after the state gate passed, so when none is focused the stop has
  not reached VS Code yet, a thread rather than a frame is focused, focus is
  on another session, or the target resumed without the adapter saying so:
  a `TARGET_RUNNING` refusal whose hint is `wait_for_stop` or
  `pause_execution`. `src/core/variableView.ts` renders them, with caps unless the
  agent names the variables it wants.
- An expression whose value has children — a struct, an array, a pointer —
  lists them under its `Result:` as `Fields:`, one level unless the call
  asks for `depth` 2 or 3. An agent that gets only `{...}` reads the fields
  one call at a time, so one `variables` request per level saves many round
  trips. `expandFields()` in `src/core/variableView.ts` fetches them through
  the executor, at most 32 per level and 16 requests in all, cuts long
  values, and redacts each field by its name and value; a withheld field, or
  one whose name is a credential name, is never opened.
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
  a note when it fails, instead of failing the call — except a wedged probe:
  `get_fault_info` and `diagnose_fault` answer the executor's `PROBE_WEDGED`
  itself rather than a diagnosis built on registers that were not read (#3).
  Both read DHCSR once more (`probeDebugPort()`) and add a lockup note when
  `S_LOCKUP` is set.
- `lookup_peripheral` and `lookup_register` answer from the device SVD
  (`src/core/svdParser.ts`, `src/core/svdLookup.ts`) without a session.

## CMSIS actions and flashing

`src/handler/cmsisAction.ts` runs `cmsis_action`. Each action maps to a
command of the CMSIS Solution extension (`cmsis-csolution.build`,
`cmsis-csolution.cmsisLoadAndDebug` and so on). Those commands return before
their work is done, so the outcome is observed separately, through the
window's CMSIS job tracker (next section):

- `build`, `load`, `erase`, `run` and `load_and_run` arm a job, issue the
  command and wait for the job: a ✅ line with the task, its exit code, how
  long it ran and the job id, or a ❌ line rejected as `TASK_FAILED`. `run`
  (#73) starts the adapter's `CMSIS Run` task alone, job id `g-<n>`; its
  result says what the task did to the target, because the adapters differ:
  the pyOCD task resets and runs, the J-Link task leaves the core as it was,
  and the FVP task starts the model with the last-built image and hosts no
  GDB server, so `attach` has nothing to reach there. `rebuild` and `clean`
  (CMSIS Solution 1.72.0's Rebuild and Clean, the build task type with
  `--rebuild` or `--clean`) are jobs of their own, `rb-<n>` and `c-<n>`. A
  build, rebuild or clean while another of the three is in flight is
  refused: CMSIS Solution would start it only after that one ended, too late
  for the job's not-started window.
- `load_and_debug` waits for its pre-launch `CMSIS Load` when the launch
  configuration has one (a failed Load is the answer, before any session
  probe); then it and `attach` wait for a live session and probe its threads
  twice (`probeSchedule()`). A session object without threads yet is
  answered with status `running`; `TASK_FAILED` is kept for a session that
  is gone.
- `status` launches nothing and needs no solution: it waits for the job in
  flight, or lists the recent results and the live CMSIS tasks, with the
  error lines of a failed build once they are in.
- `stop_run` waits until the CMSIS tasks it stops have ended, terminates
  leftovers itself after 3 s, and answers `PROBE_BUSY` for a task still
  alive after 10 s. `detach` returns at once.
- `stop_build` does the same for the build-type tasks of the window (build,
  rebuild, clean, or the `cbuild setup` CMSIS Solution runs after loading a
  solution), over `cmsis-csolution.stopBuild`, which ends only one of them.
  It marks their jobs first (`CmsisJobTracker.requestStop`), so they read as
  stopped whatever code the task closes with. With no build running it
  issues nothing and says so, and names a build result that is still being
  checked: that check is no task, and `status` waits for it. It never
  switches the target.

- `open_solution` needs no active solution either. It takes the path of a
  csolution or of its folder. A folder this window has open is activated
  here (`cmsis-csolution.activateSolution`, verified, refused under a live
  session). The extension takes only a path spelled exactly as in its list,
  which it builds from `vscode.workspace.findFiles`, and otherwise waits in
  its own picker; so the path goes in as the workspace search spells it
  (`solutionAsListed()`), and a solution it did not take while another
  stays active is `TASK_FAILED`, not a hint to build. A window without any folder opens it in itself
  (`openHere()`) when the client runs outside the window — the tool passes
  the client's `initialize` name, `src/core/clientHosting.ts` knows the
  CLIs: VS Code reloads the window for that, the MCP server with it, so the
  reply goes out first and `HandlerHost.openFolder` runs a second later;
  the reply (`data.reloads`) tells the agent to come back after the reload,
  and the client reconnects on the same port (Claude Code does so by
  itself). A chat inside the window (Copilot Chat, Cline, Roo Code; also any
  unknown client) would be ended by the reload, so for it, as for a window
  with another folder, the folder opens in a new VS Code window and the
  window that answers keeps running; the result's `data.newWindow` tells
  the router to follow (see windowRouting.md).
- `install_pack` needs no active solution or folder either
  (`src/handler/installPack.ts`, the pure parts in `src/core/packInstall.ts`).
  It exists so that a pack's knowledge units can be read before the project
  that needs the pack is written, without a `cpackget add` in the shell. It
  calls the CMSIS Solution extension's hidden `installPack` command, which
  answers only a folder or nothing, so the call checks what it can first:
  `Vendor::Name@version` with the version required, the extension installed,
  and the command present once the extension is activated (a window without
  a csolution has not activated it). The licence gate reads the `<license>`
  of the pack's PDSC in the pack root's `.Web/` and asks the user in a modal
  before anything is installed; without that PDSC it installs and says that
  the licence was not checked. After the command the folder is checked, a
  failure is journaled with a pointer to the "CMSIS Solution" output
  channel, and the result names the pack's knowledge units as a
  `knowledge_expand` call, which lists them although `knowledge_search`
  scopes them to projects that use the pack. One install per pack runs at
  a time (question included): a repeated call waits for it, and the call
  answers by its deadline, `running` while cpackget runs. Everything that
  touches VS Code is the host's `packInstall()`.
- `create_solution` needs no active solution either
  (`src/handler/createSolution.ts`). It creates a project from an example,
  reference application or template of CMSIS Solution's catalog through
  that extension's API (next section): the board, device and draft are
  looked up by the ids `cmsis_query` lists, and the API's
  `createNewSolution` gets the objects it listed. After it has copied the
  files, CMSIS Solution writes `.vscode/cmsis.json`, may add a
  `vcpkg-configuration.json` through the Arm Tools Environment Manager, and
  opens the folder in the window that created it, without asking and
  without waiting for us. A window that has exactly that folder open stays,
  any other reloads into it. So the call runs only in such a window, or in
  a window without a folder for a client that survives the reload
  (`clientHosting.ts`, as for `open_solution`); a window with another folder
  would lose it and is refused, and so is an empty window for a chat inside
  it. The reply says what CMSIS Solution does next (`data.reloads`), and a
  creation that outlasts the wait (a web example downloads first) is
  answered with status `running`.

Before any command: a debug session refuses `load_and_debug` and `attach`,
the probe guard refuses what another owner blocks (`PROBE_BUSY`), a window
without an active solution is refused, an unknown target or action is
`INVALID_ARGUMENT`, and so is a task the solution's `tasks.json` does not
have (`load` on an Arm Debugger adapter, for example).

A `tasks.json` without any CMSIS task is a hand-off to the CMSIS Solution
extension rather than a dead end: when the active target's cbuild-run.yml
names a debugger (`cbuildRunDebugger()` in
`src/core/packDocs/cbuildRun.ts`), `writeCmsisTasks()` runs
`cmsis-csolution.updateDebugTasks` once — what that extension runs itself
after each successful convert; it renders the debugger adapter's template
into the CMSIS tasks and launch configurations and leaves other tasks alone
— reads the labels again for up to 5 s and goes on. It is not run when no
debugger is named (the command does nothing then) or when
`cmsis-csolution.autoDebugLaunch` is off (it writes no file then). Otherwise,
or when it wrote nothing, the refusal says why and that the user chooses
the debugger in Manage Solution Settings. The cbuild-run.yml is the one the
extension names, through the lookup `flash` uses
(`HandlerHost.activeCbuildRunFile`): Update Debug Tasks reads that file and
no other, so a file found on disk by convention would not predict what it
does.

A window without an active solution is an ordinary state for an agent that
starts in an empty VS Code, so the refusal says which part is missing
(`whyNoSolution()`, texts in `src/core/bootstrapState.ts`): no folder open is
`NO_WORKSPACE`; the CMSIS Solution extension not installed, no csolution file
in the workspace, or a file the extension has not loaded are
`CMSIS_NO_SOLUTION`, each with its own next step. `flash` answers
`NO_WORKSPACE` likewise, and `get_session_status` adds the same finding as
lines while no session runs in a window without a folder. The steps from
there are the `bootstrap` topic of the agent guide and the skill
`cmsis-bootstrap`.

When `target` names a target-type or target-set that is not active, the
selection is written into `.vscode/cmsis.json`, the solution is
re-activated, and the switch is verified through the extension before
anything runs. The file is the one CMSIS Solution reads: that of the
workspace's first folder, also for a solution in another folder of a
multi-root workspace, keyed by the solution's path relative to that folder,
a key the extension splits at every dot. The solution's `tasks.json` and
`launch.json`, by contrast, are those of the folder that holds it. A switch
is refused under a live debug session. `src/core/cmsisTarget.ts` reads the
declared target-types and their sets from the csolution and edits the file.
There is no YAML parser among the dependencies, so it scans the lines and
follows the block structure by column: the keys of an entry count in any
order and a list may stand in its key's column, as YAML allows, and a
`type:` in a nested list (`images:`, a debugger's `reset:`) declares no
target-type. A set's index counts every entry of `target-set:`, as the CMSIS
Solution extension's index into that list does.

`src/handler/flashTool.ts` runs `flash`. It picks the `*.cbuild-run.yml` —
the argument, else the one of the CMSIS Solution extension's active target
when that file exists (`HandlerHost.activeCbuildRunFile`, the extension's
`getCbuildRunFile`, asked only while the extension is active), else
`cmsis.cbuildRunFile` from `launch.json`, else the only match under `out/` —
refuses while a session or a CMSIS task holds the probe,
and runs `pyocd load --no-wait --cbuild-run` through `src/core/flashController.ts`
with the pyOCD the CMSIS tasks use: the CMSIS Debugger extension's bundled
one, else the one the solution's `.cmsis/tools-environment.yml` names, else
one on PATH (`resolvePyocd()`). A refusal is `PROBE_BUSY`, a file that
cannot be chosen `INVALID_ARGUMENT`, no runnable pyOCD `TOOL_DISABLED`, a
failing run `TASK_FAILED`, and a run killed at its budget is answered with
status `timeout`.

### The catalog: `cmsis_query`

CMSIS Solution publishes a versioned API (`exports.getApi(2)`, the types of
`@arm-software/vscode-cmsis-csolution`). Its catalog merges Arm's web
catalog with the installed packs, so it knows a board's examples before any
of its packs is installed, which `csolution list examples` does not.
`handleCmsisQuery` serves the first slice of #41's `cmsis_query`: `what` is
`boards`, `devices` or `examples`, and `context` and `toolchain` are meant to
join it as further kinds (`QUERY_KINDS` in `src/core/catalogQuery.ts`).

Two pure modules carry it. `src/core/solutionApi.ts` holds the part of the
API this extension calls, as types of its own, and `acquireSolutionApi()`,
the seam: the extension missing is the bootstrap refusal
`CMSIS_NO_SOLUTION`, an inactive one is activated (`TIMEOUT` after 20 s,
`TASK_FAILED` when it fails), and no `getApi`, no version 2 or a version 2
without a method is `TOOL_DISABLED`; one API object is kept per extension,
since `getApi` makes a new one per call. It also finds a board, device or
draft by id, case-insensitively, with near ids when none matches.
`src/core/catalogQuery.ts` applies the filters itself, as case-insensitive
regular expressions (the API's name filter is case-sensitive and its vendor
filter exact), sorts boards and devices by id, caps the list at `limit`
(20, at most 100) and counts the rest. The pack, devices and cores of an
entry can cost the web catalog one request each, so they are read for the
listed entries only, in parallel, and left out with a note when they do not
arrive within 10 s. The answer is a text and the same as `data`.

The API keeps a source's failure to itself. Only a draft says where it came
from (`draftSource`: web or installed pack). Whether the web catalog was
reachable is read from the API object's data manager (`dataManager.errors`,
"Web service could not be reached"), a field outside the published API,
used when it is there (`catalogErrorsOf()`); without it, examples of which
none came from the web are answered with a note that says the cause is not
known.

Programming can make the probe's virtual COM port re-enumerate, which closes
a serial port the window holds. So `flash` and the programming actions of
`cmsis_action` (`load`, `erase`, `load_and_run`) add one line to a result
when the window held a port as they started (`noteHeldSerialPort()`): that
it is open and may need reopening, or why it went during programming (#49).
They do not release the port first: nothing ties a COM port to the probe
being programmed, and a second board's UART would go too.

## CMSIS jobs

The CMSIS Solution extension runs builds as its own task type and the
panel's Load, Run, Load+Run and Erase as tasks it writes into `tasks.json`.
`src/core/cmsisTasks.ts` knows those shapes: `classifyCmsisTask()` names a
task's kind by the rules the extension itself applies (the build type, the
Arm Debugger's flash task, exact labels from `tasks.json`); the build type
splits into build, rebuild, clean and setup by its definition's flags, so
that none answers for another. `reduceJob()`
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
  hosts the GDB server and never ends, stayed up for 2 s; `run` once CMSIS
  Run alone stayed up that long, and a Run that ends earlier is `failed`
  with its exit code;
- nothing expected starting within 10 s of the command is `not-started`;
- a build-type task that closes with 130 (CMSIS Solution's Stop Build) or
  that `stop_build` asked to end is `cancelled` and reads as stopped, never
  as a failed build, so no diagnosis runs for it;
- a build, rebuild, clean, load or erase started elsewhere is adopted as a
  job of its own, so that a repeated call attaches to it instead of
  starting another;
- settled jobs are kept for 10 minutes, in memory only; `get_session_status`
  shows one line from them and the live tasks.

A call has one deadline (#12): the solution checks and a target switch come
out of it, and a job still going when it passes is answered with status
`running` and the job in `data`. The texts live in `src/handler/jobText.ts`.

### Why a build failed

The CMSIS Solution extension runs cbuild in a pseudoterminal no other
extension can read and keeps no log, so a failed build job knows only its
exit code. `src/cmsisBuildDiagnosis.ts` completes such a job's result
(#15); a rebuild is treated as a build. The tracker calls its `onDidFinishJob` listener before it wakes the
job's waiters, and `completeWith` makes them wait for the work as well: the
job carries a pending `diagnosis` until it is done.

- **Stage A** reads the errors and warnings csolution recorded in the
  solution's `*.cbuild-idx.yml`, when the build wrote that file. Errors
  there (a missing pack or component, a schema error) are the answer.
- **Stage B** runs cbuild once more with `--log`: the failed task's
  arguments without the steps that download packs, update RTE files or
  clean, `--skip-convert` after a fresh index, and the environment CMSIS
  Solution recorded in `.cmsis/tools-environment.yml`. Its log is parsed
  with the parser of `get_build_diagnostics`. The re-run starts only while
  no other build or setup runs, is killed when one starts or after 120 s,
  and can be switched off (`build.diagnosticRerun`). It is interim, until
  CMSIS Solution offers a build log of its own (#21).

The same machinery checks a build whose task exited 0. CMSIS Solution
1.70.1 cannot report a failed build: its build runner drops the exit code
cbuild returned, and the task's pseudoterminal closes with 0 either way. So
exit 0 is not a success until `BuildDiagnosisRunner.check` agrees:

- errors in a fresh `*.cbuild-idx.yml` make it a failure;
- the images the build writes — the primary outputs of each context the
  index names, else those of the cbuild-run file — all written since the
  build started confirm it;
- otherwise stage B decides. The build is incremental, so the re-run fails
  where the build failed and succeeds at once when there was nothing to
  rebuild; an image that kept its old time is no failure by itself.

The check's verdict is `diagnosis.check`: `rebuilt` and `up-to-date` are
successes, `failed` turns the job into a failed one (`withDiagnosis` in
`src/core/cmsisTasks.ts`), and `unverified` — an image not rewritten and no
re-run possible — is answered as a warning, not as ✅.

A clean that exited 0 has a check of its own, since exit 0 proves nothing
there either: when its task starts, before cbuild gets to work,
`BuildDiagnosisRunner.onStarted` notes which images of the active target
exist; at its end, `checkClean` names those it removed (`cleaned`), or the
one still there (`unverified`). A failed clean is never re-run.

The `diagnosis` holds the errors and warnings with file and line, which
`onDidDiagnoseJob` announces for the problem journal (#48), and the short
block `renderBuildFailure` makes for the result. When it arrives within the
call's deadline the failing call shows it; otherwise the call says the lines
are coming, and `status` waits for them. The pure parts — the readers of the
two YAML files, the re-run's command line and environment — are in
`src/core/buildFailure.ts`.

## The problem journal

What goes wrong in a window shows up in places the agent cannot see: the
debug adapter's output, the GDB server behind it, a breakpoint VS Code's own
UI set while the target ran, a build started from the CMSIS panel, a toast.
The problem journal (#48) collects all of it in one record shape, one
journal per window, and the agent reads it in three ways: the records a
failed call produced ride along with the failure, a successful result notes
once when errors arrived that the agent has not seen, and
`get_recent_problems` lists them with a cursor.

- **The journal** (`ProblemJournal` in `src/core/problemJournal.ts`, the
  window's instance from `problemJournal()`) keeps 200 records. Every record
  has a `seq`, monotonic per window, which is the cursor; the oldest `info`
  is evicted first, then the oldest `warning`, then the oldest `error`, so
  chatter never pushes out an error. A repeat within 10 s is counted in its
  record, which moves to the end with a new `seq`. Two counters — the newest
  `seq` and the errors ever appended — travel with every answer of the
  window. A call running in the window is registered (`beginCall`), so a
  record written while it runs carries its call id: from the async call
  context when there is one, else by timing while it is the only call.
- **Sources.** The adapter tracker (`src/utils/sessionStateTracker.ts`)
  journals failed responses, adapter errors and output line by line: GDB's
  `stderr` as warnings; the adapter's `console` and `important` and the GDB
  server's own log (category `server` on cdt-gdb-adapter) as `info` unless a
  line is known; never the target's `stdout` or GDB's `log` stream. A failed
  response is an error when VS Code sent the request and a warning when a
  tool did, since the tool reports its own outcome;
  `customRequestWithTimeout` announces the tools' requests to tell them
  apart. `src/windowProblems.ts` journals a
  failed CMSIS job as `TASK_FAILED` and the error lines of a failed build
  (#15) as `BUILD_ERROR` with a workspace-relative file, and reads the
  Problems panel's errors on demand, diffed against the last reading and
  without the IntelliSense sources. `src/utils/notify.ts` journals this
  extension's error and warning toasts, `logger.error` feeds a sink (the same
  message at most once a minute), and the serial controller journals a port
  that cannot be opened or goes away. #49's releases and #14's worker fence
  journal through `problemJournal()` as well.
- **The output channel.** `mirrorProblem()` in `src/windowProblems.ts`
  writes each warning and error as a `[problem #N] …` line at debug level,
  so the channel stays quiet unless the user sets it to Debug: the journal
  is for the agent and for "Copy Recent Problems", not a second log.
- **Codes.** `classifyProblem()` in `src/core/problemCodes.ts` recognises
  known lines and gives them a code, a weight and the next step as the hint.
  The codes are this repository's: `ErrorCode` (#11) and the journal's own
  `DAP_POWER_UP_FAILED` and `BUILD_ERROR`. A row ships only with a line
  captured from a real session, which its test holds as a fixture:

  | Line | Code | Weight | Source |
  | ---- | ---- | ------ | ------ |
  | `Failed to power up DAP` | `DAP_POWER_UP_FAILED` | error | `gdb-server` |
  | `Waiting for a debug probe matching unique ID` | `PROBE_BUSY` | error | `gdb-server` |
  | `target is running` | `TARGET_RUNNING` | warning | as reported |
  | `no active solution` | `CMSIS_NO_SOLUTION` | error | as reported |

  `PROBE_NOT_FOUND` (pyOCD's "No available debug probes", a J-Link connect
  failure) and `CORE_NOT_FOUND` wait for a captured line, as do the pyOCD log
  prefix and the J-Link banner that would mark any GDB-server line.
- **Delivery** (`src/core/problemFeed.ts`). `runJournaled()` runs an op in
  the window that owns it — the control server for a forwarded call,
  `journalLocally()` on a server without a router — and attaches up to five
  records of the call at warning or above to a failure or a timeout, as
  `data.problems`, leaving out records of another call and records that
  only restate the failure. `ProblemNotices` keeps, per MCP session and
  window, what the agent has seen: the first answer sets the baseline,
  `get_recent_problems` moves it, `get_session_status` carries a count line
  while errors lie beyond it, and one successful result per batch carries a
  note naming the call to make. `handleGetRecentProblems()` renders the
  journal from `sinceSeq` on (`src/handler/problemText.ts`): one line per
  record, newest 20 (at most 50), and the same records as JSON in
  `data.records`, for clients that show the model `structuredContent`
  instead of the text; the lines and the records each stay within 8 kB.

## The host seam

Everything else the handler needs comes from a `HandlerHost`
(`src/handler/host.ts`): clock, timers, VS Code's focused frame, the
window's CMSIS job tracker, its owned serial port, workspace folders, file
search, where `flash` looks for pyOCD, what `install_pack` asks of VS
Code and the CMSIS Solution extension (`packInstall()`), and the CMSIS
Solution extension behind `cmsis_query` and `create_solution`
(`solutionExtension()`, its activation state and exports read at each
use). `get_session_status` adds a line
on the serial port from it (#49): the port held, for whom and how long idle,
or why it was released, seen from the MCP session that asks. `VSCODE_HOST` looks each of them up in VS Code at the
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
| `src/handler/sessionText.ts` | state refusals with their codes (`PROBE_WEDGED` and its reconnect hint for `unresponsive`), the `get_session_status` text, call-stack and thread listings |
| `src/core/problemJournal.ts` | `ProblemJournal`, `problemJournal()`, the record shape, `formatProblemLine()` (#48) |
| `src/core/problemCodes.ts` | `ProblemCode`, `classifyProblem()` and its rows |
| `src/core/problemFeed.ts` | `runJournaled()`, `ProblemNotices`, `journalLocally()`, the "Recent problems:" block |
| `src/handler/problemText.ts` | the `get_recent_problems` reply |
| `src/windowProblems.ts` | the output-channel mirror (`mirrorProblem()`, debug level), the `logger.error` sink, "Copy Recent Problems", failed jobs and build lines, the Problems panel |
| `src/handler/targetText.ts` | register normalisation, register table, memory dump, cycle-counter text |
| `src/handler/cmsisAction.ts` | `cmsis_action`: commands, probe guard, target switch, label pre-check and the Update Debug Tasks hand-off, jobs, session waits, verified `stop_run` and `stop_build`, `status`, `open_solution`, the dispatch of `install_pack` and `create_solution`, why no solution is active |
| `src/handler/installPack.ts`, `src/core/packInstall.ts` | `install_pack`: the pack id, the licence gate, the install in flight, the folder check, the knowledge line; `PackInstallHost` |
| `src/core/solutionApi.ts`, `src/core/catalogQuery.ts` | CMSIS Solution's API version 2 as far as it is used, `acquireSolutionApi()`, the lookups by id, `catalogErrorsOf()`; `cmsis_query`'s kinds, filters, caps, texts and data |
| `src/handler/createSolution.ts` | `cmsis_action create_solution`: the folder, the window check, the lookups, `createNewSolution`, the text of what follows |
| `src/core/bootstrapState.ts`, `src/utils/solutionFiles.ts` | The refusals and status lines of a window that lacks a folder, the CMSIS extensions or a loaded solution; the csolution files below a folder that is not open yet |
| `src/core/solutionAnswers.ts`, `src/utils/solutionQueries.ts` | What the answers of the CMSIS Solution extension's getters mean (`getSolutionFile`, `getActiveTargetSet`, `getCbuildRunFile`, `getDfpPath`, `getBspPath`), for every caller; asking the hidden getters only while the extension is active, feature-detected, under a 3 s fence |
| `src/handler/jobText.ts` | job results, `running` replies, `status`, `PROBE_BUSY` refusals, the `get_session_status` task line |
| `src/cmsisJobTracker.ts` | `CmsisJobTracker`: live CMSIS executions, jobs, probe owners, the label pre-check, work that completes a settled job; the window's instance |
| `src/cmsisBuildDiagnosis.ts` | The error lines of a failed build or rebuild: csolution's index, the diagnostic re-run of cbuild and its guards (#15); the check of a build that exited 0, and of a clean |
| `src/core/buildFailure.ts` | The readers of `cbuild-idx.yml` and `tools-environment.yml`, the re-run's arguments and environment, the reasons for no re-run; `renderBuildFailure()` is in `src/core/buildInfo/render.ts` |
| `src/core/cmsisTasks.ts` | task classifier, `reduceJob()`, `guardProbe()` |
| `src/handler/flashTool.ts` | `flash`: choice of the cbuild-run file, probe guard, pyOCD lookup |
| `src/core/flashController.ts` | `resolvePyocd()`, the pyOCD process and its output |

## Tests

- `src/test/debuggingHandler.test.ts`: the handler against a scripted
  executor and host, CMSIS jobs over fake task events included; a picker
  nobody answers and a stop that never settles (#14)
- `src/test/debugConfigurationManager.test.ts`: the configuration picker
  against VS Code's own quick pick, closed by its cancellation token
- `src/test/cmsisTasks.test.ts`, `src/test/cmsisJobTracker.test.ts`: the
  classifier, the job state machine, the guard matrix and the tracker,
  replayed over task sequences derived from CMSIS Solution 1.70.1
  (`src/test/fixtures/cmsisTasks/`)
- `src/test/buildFailure.test.ts`, `src/test/cmsisBuildDiagnosis.test.ts`:
  the two YAML readers on generated files (`src/test/fixtures/buildinfo/`),
  the re-run's command line and the result block, and the diagnosis over
  fake task events with a fake cbuild and a hand-moved clock
- `test/transport/dap-scenarios.js`: 37 scripted `gdbtarget` sessions
  through the real server; every reply and the adapter traffic are compared
  with `dap-scenarios.snapshot.json`
- `src/test/gdbText.test.ts`: GDB reply classification, MI results, logpoint
  locations
- `src/test/problemJournal.test.ts`: eviction, repeats, the cursor, filters,
  call ids, the attached records, the notices and the `get_recent_problems`
  reply; `src/test/problemCodes.test.ts`: every code row against its captured
  line; `src/test/windowProblems.test.ts`: failed jobs, build lines, the
  Problems panel and the copied text; the adapter tracker's records in
  `src/test/sessionStateTracker.test.ts`
- `src/test/solutionCatalog.test.ts`: `cmsis_query` and `create_solution`
  against a stub of CMSIS Solution's API: filters, caps, sources, the web
  catalog unreachable, the extension missing, inactive or without API
  version 2, unknown ids, the window checks
- `test/transport/surface-snapshot.js`: every tool's reply without a session
- `test/realboard/run.ts`: every tool against a real board, run by hand
