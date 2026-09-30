---
name: cmsis-debugger-setup
description: "Wire the debug adapter of a CMSIS csolution target so that Load & Debug works, and prove it on the target: choose the adapter (CMSIS-DAP@pyOCD, ST-Link@pyOCD, ULINKplus@pyOCD, J-Link Server, …) from csolution list debuggers, set the debugger node of the target set, let the CMSIS Solution extension write launch.json and tasks.json, then verify with cmsis_action load_and_debug, a breakpoint and the serial console. Use when a new target has no debugger yet, when launch.json has no gdbtarget configuration, when cmsis_action says a CMSIS task is not offered, or when the probe changes. For an Arm FVP use fvp-debug-setup; for a session that fails to connect use debugger-troubleshooting."
---

# Wire the debugger of a CMSIS target

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools. Never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against the board from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks for it or a CMSIS skill step names the command.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep over the map file.
- If a tool you need is not in your tool list, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`) instead of substituting a shell command.
- The control server and the registry files are internal: never call or read them. With several VS Code windows open, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- If a tool fails twice, call `get_session_status` and `get_recent_problems`, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
<!-- cmsis-developer-assistant:rules:end -->

## Goal

The active target set of the solution names a debug adapter, the CMSIS Solution
extension has written the launch configuration and the CMSIS tasks for it, and a
debug session started with `cmsis_action load_and_debug` stops at a breakpoint in
the application. A green build is not the goal.

## 1. Read before you change

- The csolution: `target-types`, each `target-set` with its `images` and any
  `debugger:` node, and which target is active (`.vscode/cmsis.json`, or the target
  a `cmsis_action` result names).
- `out/<solution>+<target>.cbuild-run.yml` after a build: its `debugger:` block is
  what the extension and pyOCD use, and its `device`, `system-descriptions` (SVD)
  and `programming` (flash algorithms) entries say what the device pack brings.
- `.vscode/launch.json` and `.vscode/tasks.json`: whether they have a configuration
  of `"type": "gdbtarget"` and the tasks `CMSIS Load`, `CMSIS Run`, `CMSIS Load+Run`
  and `CMSIS Erase`.

If the internal flash has no algorithm in the cbuild-run file, programming cannot
work whatever the adapter is. Report that first.

## 2. Choose the adapter

Ask the user which probe is on the board or on the desk. Do not infer it from the
board name: many boards take an external probe. The valid names are the ones the
CMSIS-Toolbox lists:

```text
csolution list debuggers
```

| Probe | Adapter name |
|---|---|
| CMSIS-DAP, DAPLink, on-board CMSIS-DAP | `CMSIS-DAP@pyOCD` |
| ST-Link, on-board ST-Link | `ST-Link@pyOCD` |
| ULINKplus | `ULINKplus@pyOCD` |
| MCU-Link, Nu-Link, KitProg3, PICkit, Raspberry Pi Debug Probe | `MCU-Link@pyOCD`, `Nu-Link@pyOCD`, `KitProg3@pyOCD`, `PICkit@pyOCD`, `RPiDebugProbe@pyOCD` |
| SEGGER J-Link | `J-Link Server` |
| Arm FVP model | `Arm-FVP`: use `$fvp-debug-setup` |

Use a name exactly as `csolution list debuggers` prints it.

## 3. Set the debugger node

In the csolution, under the target type's target set:

```yaml
  target-types:
    - type: <target-type>
      board: <vendor>::<board>
      device: <device>
      target-set:
        - set:
          images:
            - project-context: <project>.Debug
          debugger:
            name: <adapter name>
```

- Keep an existing target set and add only the `debugger:` node. When the target
  type has no target set, add one with the project context that is to be debugged.
- Optional nodes below `debugger:` are `protocol` (`swd` or `jtag`) and `clock` in
  Hz. Leave them out unless the board needs another value than the adapter's
  default; the defaults are in the toolbox's `etc/debug-adapters.yml`.
- With several probes connected, the probe is chosen by the setting
  `cmsis-csolution.probe-id`, not in the csolution. Ask the user to set it.

## 4. Let the extension write launch.json and tasks.json

The CMSIS Solution extension rewrites both files when the csolution changes, as long
as its setting `cmsis-csolution.autoDebugLaunch` is on (the default). Do not write
them by hand.

1. `cmsis_action { action: 'build' }`. The build also refreshes
   `out/<solution>+<target>.cbuild-run.yml`.
2. Check the cbuild-run file: its `debugger:` block names the adapter.
3. Check `.vscode/launch.json`: a configuration of `"type": "gdbtarget"` named after
   the adapter, such as `CMSIS_DAP@pyOCD (launch)`, `STLink@pyOCD (launch)` or
   `JLink (launch)`, and `.vscode/tasks.json` with the `CMSIS Load` task.
4. When the files did not change: ask the user to open **Manage Solution Settings**
   in the CMSIS view and to confirm the debugger there, or to check that
   `cmsis-csolution.autoDebugLaunch` is on. A launch configuration whose `cmsis`
   node says `"updateConfiguration": "manual"` is never rewritten; leave it alone
   and tell the user.

## 5. Verify on the target

Ask the user to connect the board. Then, in this order:

1. `serial_list_ports`: the probe's virtual COM port is a sign that the board is
   connected. `serial_open` it before anything runs, so that no output is lost.
2. `add_breakpoint` at the entry of the application code, not only at `main`.
3. `cmsis_action { action: 'load_and_debug' }`. Never `start_debugging` for a CMSIS
   target: it skips the flash download.
4. `continue_execution` and `wait_for_stop` to the breakpoint; `get_call_stack`,
   `get_variables_values` and one `read_peripheral_register` to show that stepping
   and reads work.
5. `clear_all_breakpoints`, let it run, and `serial_read` the application's output.
6. `stop_debugging`, `serial_close`.

Things that otherwise cost an hour each:

- **Load runs the firmware before the debugger attaches.** In `load_and_debug` the
  pre-launch `CMSIS Load` task programs and starts the image; the session then
  restarts it and halts at `main`. A complete run's output can already be in the
  serial buffer at the first stop. Do not count that run twice.
- **`reset` reports when the target did not reset.** Follow its hint: usually
  `restart_debugging`, or `stop_debugging` and `cmsis_action load_and_debug` again.
- **At `-Og` the line table can be one volatile store early.** Right after stepping
  past a store, a readback may still show the old value. Let the code run on and
  read again before you suspect the hardware.
- **A silent UART**: halt, and read the UART's status, control and baud-rate
  registers with `read_peripheral_register`. A status register at its reset value
  means the peripheral is alive and its configuration is wrong; all zeros, or the
  same value in every register, means its clock was never enabled.

## 6. When it does not connect

Read the hint of the failed result and `get_recent_problems`
(`sources: ['gdb-server']`, `minSeverity: 'info'` shows what pyOCD or J-Link said),
then continue with `$debugger-troubleshooting`. Do not start pyOCD, a J-Link tool or
GDB in a shell.

## 7. Finish

Report the adapter, the launch configuration's name, the breakpoint that was hit and
the output that was read. The csolution change and the regenerated `.vscode` files
belong in the same commit.
