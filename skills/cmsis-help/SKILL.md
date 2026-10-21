---
name: cmsis-help
description: "Health check and entry point for the CMSIS Developer Assistant, and the first skill for any CMSIS or Cortex-M task. Use when firmware misbehaves on a board: faults, crashes, hangs, failing tests, wrong/null values, unexpected output, runtime bugs, a board that does not respond or a debug session that will not start. Also use to check whether the board, the debug session, the build or a serial port is ready, and for any other CMSIS task. It checks the session read-only, reads recent problems and names the debug topic or knowledge procedure that fits. Use it whenever live inspection is practical, instead of adding temporary printf/UART logging, LED toggles, or console output: halting the CPU and looking is cheaper and does not perturb the target."
allowed-tools:
  - get_session_status
  - list_debug_windows
  - check_target_connection
  - get_recent_problems
  - get_debug_instructions
  - knowledge_search
  - knowledge_get
  - list_target_docs
  - search_target_docs
---

# CMSIS Developer Assistant — health check and where to look

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools: never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against it from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks or a CMSIS skill step names it.
- Serial I/O only through the `serial_*` tools, not `screen`, PuTTY, a read of the port or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Firmware symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep of the map file.
- If a tool you need is missing, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`), not a shell command.
- The control server and the registry files are internal: never call or read them. With several windows, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- When one call fails twice the same way, follow the hints of `get_session_status` and `get_recent_problems`, never a shell command. A value GDB cannot read is an answer, not a failure. Before you finish, leave the target running; ask the user only for what no tool can do.
<!-- cmsis-developer-assistant:rules:end -->

<!-- cmsis-developer-assistant:shell-to-tool:begin -->
## Shell commands and the tools that replace them

| Instead of | Use |
|---|---|
| `pyocd load`, `pyocd flash` | `flash`, or `cmsis_action load` |
| `pyocd reset`, `monitor reset` | `reset`, which verifies that the target did reset |
| `pyocd gdbserver`, `JLinkGDBServer`, `openocd`, `arm-none-eabi-gdb` | `cmsis_action load_and_debug`; or `cmsis_action run` (the GDB server without programming) followed by `cmsis_action attach` |
| `pyocd commander`, `gdb -ex "x/…"` | `read_memory`, `read_core_registers`, `evaluate_expression` |
| `pyocd list`, `JLinkExe` to check the probe | `check_target_connection`, `get_session_status` |
| `pip install pyocd` | nothing to install: `flash` uses the pyOCD bundled with the CMSIS Debugger, then the one `.cmsis/tools-environment.yml` names, then PATH |
| `cbuild …` | `cmsis_action build` |
| `arm-none-eabi-nm`, `readelf -s` | `lookup_symbol` |
| `arm-none-eabi-size`, a grep over the `.map` file | `get_memory_usage`, `get_section_layout` |
| a grep over the build log | `get_build_diagnostics` |
| `screen /dev/tty…`, `cat /dev/tty…`, PuTTY or `type COM3` on Windows, a pyserial script | `serial_capture` for one read; `serial_open`, `serial_read`, `serial_write` |
| `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
| reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |
<!-- cmsis-developer-assistant:shell-to-tool:end -->

## Health check (read-only)

Run these in order and stop as soon as an answer decides the next step:

1. `get_session_status`: the session state and its hint. Follow the `session` topic of `get_debug_instructions` for the state it reports.
2. `check_target_connection`: only when a session exists. It says whether the probe answers.
3. `list_debug_windows`: only when several VS Code windows are open. Say which window holds the target; do not select another window without the user's go-ahead.
4. `get_recent_problems`: what went wrong in this window since the last check (adapter and GDB-server errors, failed builds, notifications).

Report the answer in five short lines: session, target, windows, problems, next step. Name the next tool; do not run a tool that changes the board, the session or a file unless the user asks for it.

## Where a task's procedure is

| Task | Where it comes from |
|---|---|
| A new project, a board or device, the toolchain, the environment | `knowledge_search` with the task's name in two or three words (`new project`, `board layer`), then `knowledge_get`; the `route-project` unit says the order |
| Build, flash, load or attach | `get_debug_instructions` topic `build` |
| Breakpoints, logpoints, the breakpoint budget | topic `breakpoints` |
| Variables, registers, memory, peripherals, run control | topic `inspection` |
| A HardFault or another fault | topic `faults`, then `get_fault_info` or `diagnose_fault`; `knowledge_search HardFault` for the live-debugging procedure (`proc-cmsis-debug-live`) |
| A hang, a breakpoint that never hits, a wrong value | topic `troubleshooting` |
| An error text from a build, csolution, packchk or svdconv | `knowledge_search` with the exact text |
| A datasheet, reference manual or register meaning | `list_target_docs`, then `search_target_docs`; never read the PDF yourself |

Agents that do not load skills (GitHub Copilot Chat) get the same topics from `get_debug_instructions`.
