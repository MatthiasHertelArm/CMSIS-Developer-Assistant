# CMSIS Developer Assistant tool contract

The rules that keep agents on the MCP tools instead of pyOCD, GDB, cbuild or a
serial terminal in the shell, and the shell commands with the tool that
replaces each (#50). This file is the only place they are written:

- The MCP server starts its `instructions` with the rules block.
- `npm run skills:sync -- --offline` copies the blocks between their markers
  into the bundled skills `cmsis-debug-live`, `cmsis-pack-docs`,
  `add-board-layer` and `cmsis-help`, and into `debug_instructions.md`.
  `src/test/toolContract.test.ts` fails when a copy differs.

Edit the text between the markers here, then run that command. The rules
stay at ten lines and under 1 600 bytes: clients keep them in every turn.

<!-- cmsis-developer-assistant:rules:begin -->
## CMSIS Developer Assistant tool rules

Only the user can lift a rule, by asking for the specific command.

- Talk to the board only through the cmsis-developer-assistant MCP tools. Never run `pyocd`, `gdb`, `JLinkExe`, `JLinkGDBServer` or `openocd` against the board from a shell, and never install pyOCD.
- Build, load, erase, run and debug with `cmsis_action`; program with `flash`. Run `cbuild`, `csolution` or `cpackget` in a shell only when the user asks for it or a CMSIS skill step names the command.
- Serial I/O only through the `serial_*` tools, not `screen`, `cat /dev/tty*` or a serial script.
- Manuals, datasheets and register meanings through the documentation tools; use the web only to find a PDF URL for `fetch_doc`, and never read a PDF into your context.
- Symbol, section, memory-usage and build-log questions through the build-artefact tools, not `nm`, `size` or a grep over the map file.
- If a tool you need is not in your tool list, name the setting that enables it (`cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`) instead of substituting a shell command.
- The control server and the registry files are internal: never call or read them. With several VS Code windows open, use `list_debug_windows` and `select_debug_window`.
- A running target rejects reads and steps: call `pause_execution` first.
- If a tool fails twice, call `get_session_status`, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
<!-- cmsis-developer-assistant:rules:end -->

<!-- cmsis-developer-assistant:shell-to-tool:begin -->
## Shell commands and the tools that replace them

| Instead of | Use |
|---|---|
| `pyocd load`, `pyocd flash` | `flash`, or `cmsis_action load` |
| `pyocd reset`, `monitor reset` | `reset`, which verifies that the target did reset |
| `pyocd gdbserver`, `JLinkGDBServer`, `openocd`, `arm-none-eabi-gdb` | `cmsis_action load_and_debug`, or `cmsis_action attach` for firmware started with `cmsis_action load_and_run` |
| `pyocd commander`, `gdb -ex "x/…"` | `read_memory`, `read_core_registers`, `evaluate_expression` |
| `pyocd list`, `JLinkExe` to check the probe | `check_target_connection`, `get_session_status` |
| `pip install pyocd` | nothing to install: `flash` uses the pyOCD bundled with the CMSIS Debugger, then the one `.cmsis/tools-environment.yml` names, then PATH |
| `cbuild …` | `cmsis_action build` |
| `arm-none-eabi-nm`, `readelf -s` | `lookup_symbol` |
| `arm-none-eabi-size`, a grep over the `.map` file | `get_memory_usage`, `get_section_layout` |
| a grep over the build log | `get_build_diagnostics` |
| `screen /dev/tty…`, `cat /dev/tty…`, a pyserial script | `serial_open`, `serial_read`, `serial_write`; `serial_subscribe_monitor` while the Serial Monitor holds the port |
| `curl localhost:<port>` with the registry token | `list_debug_windows`, `select_debug_window` |
| reading a PDF, a web search for a register | `list_target_docs`, `search_target_docs`, `read_doc_pages`, `fetch_doc`, `get_peripheral_docs`, `lookup_register` |
<!-- cmsis-developer-assistant:shell-to-tool:end -->
