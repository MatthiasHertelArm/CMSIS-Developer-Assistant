# GDB port conflicts: guard the ports that are certain, detect the rest

| | |
|---|---|
| Issue | No issue yet. Follows K04 and the tester feedback on 2.7.0-preview4 |
| Area · priority · source | Window routing, problem journal · Medium (proposed) · Maintainer |
| Size | S |
| Depends on | One bind-failure line captured per GDB server (rule of `problemCodes.ts`) |
| Related | #41 (cross-extension commands), #48 (problem journal) |
| Status | Proposed 2026-10-28. Part 1 is done in 2.7.0 |

## Problem

The K04 guard reserves the GDB port of a launch or a CMSIS Run across the windows, and refuses a start whose port another window or program holds. To do that it has to know the port before the start.

- For the adapter templates of CMSIS Solution it does.
- For a custom or user debug setup (an adapter template of its own in `debug-adapters.yml`, a wrapper script around the server) it can only guess from the command line, and every new setup needs another rule.

Guessing also fails in the other direction. In the preview-4 feedback the guard reserved an FVP configuration that was never going to start, and refused a valid start on port 3334.

## What the debug adapter does

The facts below are from cdt-gdb-adapter, as bundled with cdt-gdb-vscode 2.9.1 (`GDBTargetDebugSession.js`).

- **`target.port` set.** GDB connects after `serverStartupDelay` (default 0), without waiting for the server.
  - When another server already listens on that port, GDB reaches it and its target first.
  - The new server's exit may end the session later, but by then the other window's target has been halted.
  - The tools see nothing wrong. Only a check before the start helps.
- **No `target.port`.** The adapter waits up to `portDetectionTimeout` (10 s) for `serverPortRegExp` (default `Listening on port ([0-9]+)`).
  - A server that cannot bind never prints that line, and exits.
  - The launch fails with `gdbserver exited with code N` and the server's stderr.
  - The worst case is a blocked port, and the failure is visible.
- **Server output.** The server's stdout and stderr reach the adapter tracker as output events of category `server`. `journalOutput` in `src/utils/sessionStateTracker.ts` already writes each line to the problem journal (source `gdb-server`), and `classifyProblem` in `src/core/problemCodes.ts` gives a known line a code and the next step.

So the silent case is the fixed port, which is exactly the case in which the port is known.

## Proposed fix

1. **Guard only the ports that are certain** (done in 2.7.0).
   - The ports that count:
     - `target.port`, as a number or digits, also in quotes;
     - a port the server's command line sets (`--port`, `-port`, the FVP's `GDBServer.port`, pyOCD's `-p`);
     - the ports of the cbuild-run file that a `gdbserver` passes with `--cbuild-run`. For Load & Debug this is the active target's file when it lists exactly one port; for a live session it is the resolved file.
   - Load & Debug reserves only the launch of the active target's debugger.
   - No server is recognised by the name of a wrapper.
   - A port that is not certain gets no reservation.
2. **Detect a bind failure in the journal.** Add one `classifyProblem` row per GDB server's bind-failure line, with this hint: "The GDB server could not open its port: a session or CMSIS Run of another window, or another program, holds it. `list_debug_windows` names a window that publishes the port. Stop that session or Run, or change the port of the setup, then retry."
   - As `problemCodes.ts` requires, each row ships only with a line captured from a real session.
   - For pyOCD, expect Python's `Address already in use` (errno 48 on macOS, 98 on Linux, 10048 on Windows).
   - Lines to capture: the J-Link GDB server, OpenOCD in a custom setup, and the FVP's GDBServer plugin.
3. **Say when a start was not checked.** When the port of a Load & Debug launch or a Run is not certain, the `cmsis_action` reply adds one line: "GDB port not checked: the setup does not say which port its server uses."
   - This line never appears for the FVP adapter's Run, which hosts no GDB server, or for a server on another host.
   - Agent-visible text, so the DAP-scenario snapshot changes with it.

## Decisions for you

1. Code of the bind-failure row.
   - [ ] `PROBE_BUSY` (recommended): agents already handle it for a held probe or port.
   - [ ] A new journal-only code `GDB_PORT_IN_USE`.
2. Where the "not checked" line goes.
   - [ ] In the `cmsis_action` reply (recommended).
   - [ ] Only in the problem journal.

## How to test

- Unit tests:
  - `src/test/problemCodes.test.ts` gets one fixture per captured line, with where it was captured.
  - `src/test/gdbServerPorts.test.ts` already holds the certain-port cases, including a wrapper whose name proves nothing.
- DAP scenario: a scripted `gdbtarget` session whose server output carries the bind failure, checking the journal record and its hint.
- Live:
  - Two windows with the same fixed port: the second start is refused before it starts.
  - A custom setup without a fixed port, started while the port is taken: the bind failure shows up in `get_recent_problems` with the hint.

## Out of scope

- Recognising more servers or wrappers by name.
- Asking CMSIS Solution for the rendered port, which needs the commands of #41.
- A Load that succeeds but whose launch never creates a session: its reservation stays until the window closes (known gap of K04).

## Review

- [ ] Approved as proposed
- [ ] Approved with the changes noted below
- [ ] Deferred or rejected

Notes:
