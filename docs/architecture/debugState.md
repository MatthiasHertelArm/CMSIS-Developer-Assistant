# DebugState

`DebugState` (`src/debugState.ts`) is a plain value that says where the
debugger is at one moment: whether a session is active, the name of its
launch configuration, the source location of the top frame, the DAP frame and
thread ids, the function name, the call stack, and the breakpoints of the
window. The executor fills a fresh one for every query
(`captureDebugState()` in `src/executor/snapshot.ts`); the handler turns it
into the state text an agent reads after a session start, a step, a
continue, a pause or a `wait_for_stop`.

## Why a separate value

- One definition of what an agent sees about the current location, used by
  every tool that moves the target.
- The module imports nothing, `vscode` included, so it is tested in plain
  Node, and the executor and the handler can pass it around without sharing
  any other state.

## What it holds

| Field | Meaning |
| ----- | ------- |
| `sessionActive` | A debug session exists; when false, the renderings carry nothing else |
| `configurationName` | Name of the launch configuration the session runs |
| `fileFullPath`, `fileName` | Source file of the top frame, absolute and base name |
| `currentLine`, `currentLineContent` | Its 1-based line and that line's text, trimmed |
| `nextLines` | The next few non-empty source lines after it |
| `frameId`, `threadId` | DAP ids of the focused frame and thread (0 is a valid id) |
| `frameName` | Function name of the top frame |
| `stackTrace` | `StackFrame` entries: name, source, line, column, optional `frameId` |
| `breakpoints` | One string per source breakpoint: `<file>:<line>` and its modifiers |

The `update*` methods set related fields together and copy arrays;
`reset()` restores the initial values and `clone()` copies the arrays too.
`hasValidContext()`, `hasLocationInfo()` and `hasFrameName()` answer the
questions callers ask most.

## Two renderings

Both are JSON with two-space indentation and a fixed key order, which agents
and the recorded snapshots see.

- `toString()`, the full form, lists every field, every frame as `name:line`
  and every breakpoint. The handler uses it after `start_debugging` and after
  a `cmsis_action` that attached a session.
- `toCompactString({ includeBreakpoints, maxFrames })`, the compact form,
  follows every step, continue, pause and wait. It leaves out the
  configuration name and the base file name, lists the top five frames and
  then a marker such as `… 7 more — get_call_stack`, and carries the
  breakpoint list only when the caller says it changed; otherwise it carries
  `breakpointsUnchanged` with the count. The handler decides "changed" by
  comparing the list with the one it showed last.

Without an active session both forms hold the single key `sessionActive`,
set to `false`.

## Breakpoint modifiers

`formatBreakpointModifiers()` turns a breakpoint's condition, log message,
hit condition and disabled flag into a suffix such as `[when: n > 0, disabled]`
(after a space), or nothing for a plain enabled breakpoint. The
snapshot uses it for `breakpoints`, and the handler uses it for the
`list_breakpoints` listing, so both show a breakpoint the same way.

## Where to look

- `src/debugState.ts`: `DebugState`, `StackFrame`, `BreakpointModifiers`,
  `formatBreakpointModifiers()`; the key orders are `FULL_KEYS` and
  `COMPACT_LEAD_KEYS`
- `src/executor/snapshot.ts`: how a snapshot is filled
- `src/debuggingHandler.ts`: `fullState()` and `compactState()`

## Tests

- `src/test/debugState.test.ts`: fields, helpers and both renderings
- `test/transport/dap-scenarios.js`: the renderings as agents receive them
  after real tool calls
