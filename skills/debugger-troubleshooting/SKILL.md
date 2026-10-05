---
name: debugger-troubleshooting
description: "Diagnose a failing embedded debug or flash session: the GDB server will not start, the target will not connect, \"Failed to power up DAP\", \"Could not find core in Coresight setup\", \"Could not read memory\", \"Waiting for a debug probe\", flashing succeeds but the firmware faults or is silent, or programming is implausibly slow. Covers pyOCD and J-Link sessions of the CMSIS Debugger, CMSIS-Toolbox cbuild-run files and FVP setups, and works through the CMSIS Developer Assistant tools first. Use when cmsis_action load_and_debug, attach, load or flash fails and the cause is not obvious from the error text."
---

# Debugger troubleshooting

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools. Never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks or a CMSIS skill step names the command.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep of the map file.
- If a tool you need is not in your tool list, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`), not a shell command.
- The control server and the registry files are internal: never call or read them. With several windows, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- When one call fails twice the same way, follow the hints of `get_session_status` and `get_recent_problems`, never a shell command. A value GDB cannot read is an answer, not a failure. Before you finish, leave the target running; ask the user only for what no tool can do.
<!-- cmsis-developer-assistant:rules:end -->

Work the checks in order. Each is cheap and rules out a whole class of cause. Most
wasted time on these comes from skipping straight to the interesting hypothesis when
the boring one (a busy port, the wrong core) was true.

The tools come first. The probe vendors' command-line tools (`JLinkExe`, `pyocd`,
`openocd`, a bare `arm-none-eabi-gdb`) are named below where only they can answer a
question. Those steps are for the user to run, or for you once the user asks for
that specific command: say what the command would show and why it is needed, and
wait.

## 0. Read the error for what it actually says

Start with what the window recorded:

```text
get_session_status
get_recent_problems { sources: ['gdb-server', 'dap', 'task'], minSeverity: 'info' }
cmsis_action { action: 'status' }
```

Several of these errors name a consequence, not a cause. A GDB client that dies with
`EPIPE` or `Error getting GDB host-charset` is almost never a GDB problem: the server
exited first and the client wrote into a dead pipe. Read the server's own last lines
in the `gdb-server` records.

## 1. Is something already holding the probe or the port?

```text
Waiting for a debug probe matching unique ID ...
Failed to open listener port 3333
gdbserver exited with code 254
```

- `cmsis_action { action: 'status' }` lists this window's CMSIS tasks. A `CMSIS Run`
  task that is alive holds the probe and the GDB port: `cmsis_action
  { action: 'stop_run' }` ends it, then repeat the call.
- `list_debug_windows` shows whether another VS Code window has a debug session on
  the same probe.
- A process outside VS Code can hold the port too, and it is often a different kind
  of backend than the one you are starting: an FVP bridge or a model left over on
  3333 blocks a J-Link or pyOCD GDB server with exactly the message above. These
  commands only look at the host and are allowed:

  ```sh
  lsof -nP -iTCP:3333 -sTCP:LISTEN
  ps -ww -o pid,etime,command -p <PID>
  ```

  Identify the process before anything is stopped: it may be a session the user
  wants. Tell the user what holds the port and let them decide.

## 2. Is it the core you think it is?

Multi-core parts (Alif Ensemble E7/E8 with `M55_HP` and `M55_HE`, anything with a
Cortex-A next to a Cortex-M) let you attach to a core that is not running your
image. The symptoms are then arbitrary: halted at a reset vector, a garbage PC,
"works but does nothing".

- `get_device_info` shows the launch configuration of the session and the CMSIS
  target; `cmsis_action` results name the target set.
- `out/<solution>+<target>.cbuild-run.yml`: `device`, the `pname` of each image under
  `output`, and the `debugger:` block with `start-pname`.
- `.vscode/launch.json`: each configuration's device or processor and its
  `target.port` must agree with each other and must not collide across
  configurations.
- `get_memory_usage` and `get_section_layout` show where the image was linked. On
  Alif E8 the HP core boots from `0x80200000` with TCM at `0x00000000` and
  `0x20000000`, the HE core from `0x80000000` with TCM at `0x58000000` and
  `0x58800000`. An image linked for one core cannot be running on the other.

## 3. Connection failures, in increasing severity

| Message | Meaning | Action |
|---|---|---|
| `AP[n]: Skipped. Not an AHB-AP` | The AP type is not declared (SoC-600 needs an explicit AP map) | The device pack's debug description, or for J-Link a script that declares the map; see section 8 |
| `AP[n]: Skipped. Could not read AHB ROM register` | The AP is typed correctly but reads fail: the bus hangs, or debug power-up is missing | Retry once; then power-cycle |
| `Could not find core in Coresight setup` | Consequence of the row above | As above |
| `Failed to power up DAP` | The SoC's debug power domain is down | Power-cycle the board |

`Failed to power up DAP` is not recoverable in software. The debug port answers while
the domain behind it is off, so connecting under reset or at a lower clock fails too.
Ask the user to unplug and replug power; the reset button is often not enough. When
the skill `board-power-cycle` is installed and the board sits on a switchable hub, it
can do that.

A hung bus transaction can take the debug port down with it. If the failure started
right after the firmware stalled a bus master (a DMA or an NPU waiting for an
external memory), suspect that, not the probe. `Could not read AHB ROM register`
that recovers on a second or third `cmsis_action load_and_debug` is the signature.

`check_target_connection` tells whether the probe still answers. A probe that does
not is `PROBE_WEDGED` in the calls that follow, and their hint names the way to
reconnect.

## 4. `Could not read memory` at an external-memory window

For XIP windows (OSPI, QSPI, HyperRAM, PSRAM) a debugger read fails until the
firmware has configured the controller. Beyond that:

- **Writes succeed while reads fail**: the controller is up but read capture timing
  is wrong. A write is posted and needs no reply; a read has to sample the device's
  read strobe. Check RXDS or DQS delay, wait cycles and the DDR drive edge in the
  board configuration against the vendor's values for that exact part.
- A `read_memory` of such a window can hang the bus, after which the debug connection
  itself starts failing (section 3). If `check_target_connection` degrades right
  after you read an XIP address, that read is the cause.

## 5. It flashed, but the firmware faults or prints nothing

**Get the fault status first**, with a session attached (`cmsis_action attach` for
firmware that runs, else `load_and_debug`) and the target halted:

```text
diagnose_fault
```

It reads CFSR, HFSR, MMFAR and BFAR, picks the right stack from EXC_RETURN, decodes
the stacked frame and resolves the stacked PC, which is the faulting instruction;
the current PC only sits in the fault handler's loop. `get_fault_info` gives the
decoded status registers alone, `lookup_symbol` resolves any other address.

**Garbage pointers (`0xFFFFFFFF`, or values that look like erased flash) during
static initialisation mean that RW data was never initialised.** The usual cause is
a flashing mistake, not a linker bug: see section 6.

**Silent firmware is not necessarily hung.** If the project mirrors stdout into a RAM
buffer (a `g_log` / `g_log_len` pair, common when the console UART sits on a
connector that is not plugged in), halt and read it: `evaluate_expression` for the
length, `read_memory` at the buffer's address. An empty buffer means it faulted
before the first print; a partial one says how far it got. Otherwise
`serial_capture` on the probe's virtual COM port while the board resets.

## 6. Flashing an ELF that drops its RW init data (LMA and VMA)

This one produces a flash that looks successful and a fault that looks mysterious.

An initialised-data section has its execution address in RAM and its load address in
flash. A tool that places sections by their virtual address writes those bytes to
RAM, where the next reset discards them, and never programs the flash copy. The
startup code then copies erased flash into RAM, and the image dies in static
initialisation.

- `flash` and `cmsis_action load` program from the cbuild-run file with pyOCD, which
  uses the load addresses. Prefer them over any hand-made `objcopy` binary or a
  probe tool's "load file" on an ELF.
- Verify instead of assuming: `get_section_layout` gives the load address of the RW
  section; `read_memory` there must show the initial values, not `0xFF`.
- When the image has to be programmed with a vendor tool, program the LOAD segment by
  its physical address. `arm-none-eabi-readelf -l <image>` lists offset, file size
  and physical address of each segment; reading the ELF on the host is allowed.

## 7. Programming is implausibly slow

If a flash write is orders of magnitude slower than the link allows, the cost is
usually per-call overhead times the number of calls, not bandwidth. A CMSIS flash
algorithm declares a page size in its `FlashDevice` descriptor, and pyOCD makes one
host round trip per page. A 256-byte page over a 20 MB image is 80 000 invocations:
tens of minutes, almost none of it silicon time. Options, best first:

1. The probe vendor's own loader, if it supports the part. That is the user's call
   and the user's command.
2. Put the payload where it is not flash (RAM, PSRAM or HyperRAM written by the
   debugger), or shrink it to fit on-chip memory.
3. Do not simply raise the page size: check first whether the algorithm's
   `ProgramPage` loops over device pages. If it issues a single page program, a
   larger transfer wraps within the device's page and corrupts data without an error.

**Never interrupt a flash algorithm in the middle of an erase.** A killed process
leaves the part partially erased and can leave the controller in a state where even
a working algorithm times out in `Init()`. `flash` and `cmsis_action load` take
`timeoutMs` up to 600 000; a result with status `running` means it still runs, and
`cmsis_action { action: 'status' }` waits for it.

## 8. J-Link device definitions (for the user, or on request)

These need J-Link's own tools. Explain, and let the user run them.

- **A malformed `JLinkDevices.xml` is rejected in silence.** The only sign is
  `The selected device "X" is unknown to this software version` and a fallback to a
  generic core. Validating the XML on the host is allowed:
  `xmllint --noout JLinkDevices.xml`. A double hyphen inside an XML comment is
  illegal and easy to introduce.
- J-Link Commander has no command-line option for the device file's path. It is a
  DLL setting, and it names the file, not the directory:
  `exec JLinkDevicesXMLPath = /abs/path/to/JLinkDevices.xml`.
- A user-defined device does not inherit the built-in device's CoreSight setup or
  debug power-up sequence. It needs an AP map from a `JLinkScriptFile` that declares
  the map in full:

  ```c
  void ConfigTargetSettings(void) {
    CORESIGHT_AddAP(0, CORESIGHT_CUSTOM_AP);
    CORESIGHT_AddAP(1, CORESIGHT_CUSTOM_AP);
    CORESIGHT_AddAP(2, CORESIGHT_CUSTOM_AP);
    CORESIGHT_AddAP(3, CORESIGHT_AHB_AP);
    CORESIGHT_IndexAHBAPToUse = 3;
  }
  ```

- Before building a device definition, check whether the stock device already covers
  the memory, and then confirm it on the board: "supported" in a vendor list does
  not guarantee that the loader works on this board.
- `VTref` in J-Link's connection report says that the target is powered even when
  nothing else works. It separates "the board is off" from "the debug domain is
  down".

## 9. pyOCD specifics

- The pyOCD in use is the one the CMSIS Debugger bundles; `flash` names the one it
  ran. Never install another.
- A lower debug clock comes from the `debugger:` node of the target set (`clock`).
  Other pyOCD session options, such as a longer timeout for a flash algorithm that
  brings up a memory controller, have no node there: that is a change for the user
  to make and test.
- If a pack declares an `<algorithm>` without a matching `<memory>` region, pyOCD
  falls back to the architectural memory map, treats the window as device memory,
  and fails with a memory transfer fault on a raw write. That is a defect of the
  pack: report it with the device and the region, and see `cmsis-pack` for the
  debug description.

## When you are through

Report the check that found the cause, the evidence (the record of
`get_recent_problems`, the register values, the file and line), and what is left for
the user: a power cycle, a vendor tool, a pack update. If no check found it, say
which ones passed, and stop.
