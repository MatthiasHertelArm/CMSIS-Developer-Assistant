---
name: cmsis-help
description: "List what the CMSIS Developer Assistant offers and which part fits a task: the CMSIS slash commands (cmsis-bootstrap, cmsis-project, add-board-layer, cmsis-debug-live, cmsis-pack-docs, create-csolution-github-action) and the member skills behind each, the VS Code commands, the MCP tool groups for building, flashing and live Cortex-M debugging, and the settings. Use when the user asks what CMSIS skills, commands or tools are available, which skill or tool to use for a CMSIS task, or how the CMSIS Developer Assistant is configured. Not a workflow itself — it points to the skill or tool that does the work."
---

# CMSIS Developer Assistant — what you can ask for

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

## How to use this list

Answer the user from the lists below: which CMSIS slash commands, VS Code commands,
MCP tools and settings exist, and which one fits the task at hand. This skill does no
work of its own and runs no tools — it points at the skill or tool that does. Every
skill below is installed into the user's personal skills directories by
**CMSIS Developer Assistant: Configure Agent** and at each activation of the extension;
a `/name` whose `../<name>/SKILL.md` is missing next to this file did not install — the
extension's output channel says why, and running the command again repeats the install.

## Slash commands

| Command | What it does |
|---|---|
| `/cmsis-project` | Create, extend or retarget CMSIS csolution and Zephyr projects — one command for the whole category; its 9 member skills are listed below |
| `/add-board-layer` | Add a board layer to an existing csolution by asking for the few open decisions, then build it |
| `/cmsis-bootstrap` | Go from an empty VS Code window to a CMSIS solution that builds and debugs |
| `/cmsis-pack-docs` | Look up registers, peripherals, errata and board facts in the target's manuals, with page citations |
| `/cmsis-debug-live` | Investigate a firmware runtime bug on a live Cortex-M debug session: faults, hangs, wrong values, silent peripherals |
| `/create-csolution-github-action` | Create build or FVP-test CI for a CMSIS solution |
| `/cmsis-help` | This list. |

## Member skills by category

The members of an entry point are installed with `user-invocable: false`: they stay out
of the `/` menu, and the model invokes them by description or through the entry point.

### Project setup (`/cmsis-project`)

- `$add-cmsis-target` — Add a verified target and packaged board layer
- `$check-cmsis-environment` — Verify CMSIS build tools and compiler toolchains
- `$check-zephyr-environment` — Verify a local Zephyr west environment
- `$cmsis-debugger-setup` — Wire the debug adapter of a csolution target and verify Load & Debug
- `$identify-cmsis-board-layer` — Find compatible packaged CMSIS board layers
- `$identify-cmsis-board-support` — Resolve one board or device and find its BSP or DFP
- `$identify-zephyr-board` — Resolve a physical board to a Zephyr target
- `$start-cmsis-project` — Create the first csolution for a board or device: a minimal project, or an example or template of its pack
- `$start-zephyr-project` — Create a CMSIS solution for a Zephyr board

### Live debugging (reached by hand-over)

- `$debugger-troubleshooting` — Find out why a debug or flash session fails to start, connect or program (from `/cmsis-bootstrap`, `$cmsis-debugger-setup`, `/cmsis-debug-live`)
- `$fvp-debug-setup` — Make Load & Debug and Run work against an Arm FVP model (from `/cmsis-bootstrap`, `$cmsis-debugger-setup`)

## VS Code commands

Open the command palette (Ctrl/Cmd+Shift+P) and type the title.

- **CMSIS Developer Assistant: Configure Agent** (`cmsis-developer-assistant.configure`) — The first-run setup, on demand: register the MCP server with the agents you pick (the CMSIS skills are installed into your personal skills directories at the same time), then add the tool rules to your agents' rule files (CLAUDE.md, AGENTS.md, …), each change shown as a diff first.
- **CMSIS Developer Assistant: Select Target Window** (`cmsis-developer-assistant.selectTargetWindow`) — With several VS Code windows open, choose the default window for agent calls that name no window or file (also a click on "CDA" in the status bar), or Automatic.
- **CMSIS Developer Assistant: Release Serial Port** (`cmsis-developer-assistant.releaseSerialPort`) — Take back a serial port an agent holds in this window, so the Serial Monitor or a terminal can open it (also a click on "Serial: …" in the status bar); the agent is told why when it next uses the port.
- **CMSIS Developer Assistant: List Target Documentation** (`cmsis-developer-assistant.listTargetDocs`) — Write the current csolution target's documentation list (pack manuals, Arm documents, imported and workspace PDFs) to the output channel.
- **CMSIS Developer Assistant: Index Target Documentation** (`cmsis-developer-assistant.indexTargetDocs`) — Extract and index every PDF of the current target now, with progress, so the first search is instant.
- **CMSIS Developer Assistant: Import Document for Current Target** (`cmsis-developer-assistant.importUserDoc`) — Copy PDFs the packs do not ship (NDA manuals, portal downloads) into the user documents folder, attributed to the current pack, device, board or core, and index them.
- **CMSIS Developer Assistant: Open User Documents Folder** (`cmsis-developer-assistant.openUserDocsFolder`) — Reveal the user documents folder in the file manager.
- **CMSIS Developer Assistant: Open Pack Docs Panel** (`cmsis-developer-assistant.openPackDocsPanel`) — Open the Pack Docs panel: the resolved target, its documents and their index state, the SVD peripherals, the page store (with confirmed actions to clear the extracted text or delete the downloaded PDFs), and a runner for the documentation tools.
- **CMSIS Developer Assistant: Copy Recent Problems** (`cmsis-developer-assistant.copyRecentProblems`) — Copy the last 50 warnings and errors this window recorded (debug adapter and GDB server, failed tasks and builds, notifications, serial ports) to the clipboard, to paste into a bug report instead of a screenshot.

## MCP tools

The CMSIS Developer Assistant MCP server (`http://localhost:3001/mcp`, registered with
the agents the user selected in the setup) exposes these tool groups:

- **CMSIS Solution actions** — `cmsis_action` — build, load, erase, run (the GDB server alone), load_and_run, load_and_debug, attach, detach, stop_run (the CMSIS Solution panel buttons), status (the job in flight) and open_solution (open the folder of a csolution in a VS Code window and activate it; works from an empty window); `flash` — program with the CMSIS Debugger's pyOCD, with a synchronous result.
- **Run control** — `start_debugging`, `stop_debugging`, `restart_debugging`, `continue_execution`, `pause_execution`, `step_over`, `step_into`, `step_out`, `wait_for_stop`, `reset`.
- **Breakpoints** — `add_breakpoint` (by line, optional condition), `add_logpoint`, `remove_breakpoint`, `list_breakpoints`, `clear_all_breakpoints`.
- **Inspection** — `get_call_stack`, `get_threads`, `get_frame_variables`, `list_variable_names`, `get_variables_values`, `evaluate_expression`.
- **Cortex-M** — `read_memory`, `read_core_registers`, `read_peripheral_register` (SVD), `lookup_peripheral` / `lookup_register` (SVD map and bit fields, no session needed), `get_fault_info` (CFSR/HFSR decode), `diagnose_fault` (one-call triage: frame, stack, address, hypotheses), `read_cycle_counter`, `get_device_info`.
- **Serial ports** — `serial_capture` (one call: open, read until a regex matches or a deadline, close), `serial_list_ports`, `serial_open`, `serial_read`, `serial_write`, `serial_close`, `serial_status`, `serial_clear_buffer`, and the Serial Monitor bridge `serial_subscribe_monitor` / `serial_unsubscribe_monitor` / `serial_open_monitor`.
- **Session health and windows** — `get_session_status`, `check_target_connection`, `get_recent_problems` (what went wrong in the window: adapter and GDB-server errors, failed tasks and builds, notifications), `get_debug_instructions`; with several VS Code windows `list_debug_windows` and `select_debug_window`.
- **Documentation (experimental, on by default — cmsis-developer-assistant.packDocs.enabled)** — `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs` — page-cited answers from the reference manuals, datasheets, errata and board manuals the target's packs ship or link, Arm documents, imported and workspace PDFs, and third-party part datasheets (sensors, ADCs) — start any part-number lookup here; fetch_doc indexes a PDF URL found on the web.
- **Build artefacts (experimental, on by default — cmsis-developer-assistant.buildInfo.enabled)** — `list_build_artifacts`, `get_memory_usage`, `lookup_symbol`, `get_section_layout`, `get_build_diagnostics` — the ELF, linker map and build log of the current target, read deterministically.

For the debugging workflow call `get_debug_instructions` (or read the
`cmsis-developer-assistant://docs/debug_instructions` resource); for a live target investigation
invoke `/cmsis-debug-live` first. The *Agent Tools* section of the extension's user
guide (`docs/user-guide.md` in the repository) lists every tool and parameter.

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
| `screen /dev/tty…`, `cat /dev/tty…`, PuTTY or `type COM3` on Windows, a pyserial script | `serial_capture` for one read; `serial_open`, `serial_read`, `serial_write`; `serial_subscribe_monitor` while the Serial Monitor holds the port |
| `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
| reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |
<!-- cmsis-developer-assistant:shell-to-tool:end -->

## Settings

VS Code settings under `cmsis-developer-assistant.*` (Settings → Extensions → CMSIS Developer Assistant):

| Setting | Default | What it does |
|---|---|---|
| `cmsis-developer-assistant.agentRules.install` | `"ask"` | `ask`: the setup offers to add the tool rules to your agents' rule files, previewed, and keeps blocks written earlier current. `never`: no rule file is touched. |
| `cmsis-developer-assistant.packDocs.enabled` | `true` | Experimental. Offer the documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) to agents. On by default; off drops the five tools from the tool list; PDFs are indexed with the bundled pdf.js, nothing to install; window reload. |
| `cmsis-developer-assistant.buildInfo.enabled` | `true` | Experimental. Offer the build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, get_section_layout, get_build_diagnostics) to agents. On by default; off drops the five tools from the tool list; window reload. |
| `cmsis-developer-assistant.serverPort` | `3001` | Port of the MCP server (default 3001); window reload after a change. |
| `cmsis-developer-assistant.timeoutInSeconds` | `180` | Time limit of a debugging operation (default 180 s); a wait for a stop or a session never exceeds 60 s. |
| `cmsis-developer-assistant.redactSecrets` | `true` | Withhold variable and expression values that look like credentials (default on); raw memory reads are never redacted. |
| `cmsis-developer-assistant.build.diagnosticRerun` | `true` | After a failed build, re-run cbuild once with --log so the cmsis_action result shows the error lines (default on). |
| `cmsis-developer-assistant.serial.enabled` | `true` | Offer the serial_* tools (default on); window reload. |
| `cmsis-developer-assistant.serial.idleCloseSeconds` | `300` | Release a serial port an agent opened after this many seconds without a serial call (default 300; 0 is off). |
| `cmsis-developer-assistant.telemetry.jsonlPath` | `""` | Append one JSON line per tool call to this file; empty is off. |

*Generated by `npm run skills:sync` from skills/catalog.json, package.json,
scripts/skills.config.json and docs/agent-resources/tool-contract.md; edit those, not
this file.*
