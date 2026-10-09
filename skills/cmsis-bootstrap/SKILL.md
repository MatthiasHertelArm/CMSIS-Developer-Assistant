---
name: cmsis-bootstrap
description: "Get from an empty VS Code window (no folder open, no project on disk) or from a folder without a solution to a CMSIS solution that builds, flashes and debugs: check the CMSIS extensions, choose the project folder, open it so the Arm Tools Environment Manager fetches the tools, create the solution for the board or device with $start-cmsis-project (a minimal project that always works, or an example of the board's pack) or open an existing one with cmsis_action open_solution, build, wire the debugger and hand over to cmsis-debug-live. Use when the user wants to start a new CMSIS project for a board, when get_session_status says that no folder is open, or when cmsis_action answers NO_WORKSPACE or CMSIS_NO_SOLUTION. Not for extending an existing solution (cmsis-project) and not for debugging a running target (cmsis-debug-live)."
---

# From an empty VS Code window to a debugged board

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

## Goal and method

Goal: a CMSIS solution that is open in a VS Code window, builds with
`cmsis_action build`, and reaches `main` with `cmsis_action load_and_debug`.

This skill does little work of its own. It finds out what is missing, asks the user
for the few things only they can decide or do, and hands over to the skill that owns
each step. Every `$name` is a skill installed next to this one
(`../<name>/SKILL.md`). When one is missing, say so: the user installs the skills
again with **CMSIS Developer Assistant: Configure Agent** in VS Code. Do not improvise
its steps.

The agent's shell is not the VS Code terminal: the tools the Arm Tools Environment
Manager activates are on the PATH of VS Code's terminals, not on yours. Nothing in
this skill depends on them. The solution is created from files, the extension
fetches the packs and builds through `cmsis_action`.

## 1. Find out where you are

Call `get_session_status`, and `list_debug_windows` when more than one window may be
open. Read the result against this table and start at the first row that applies.

| Sign | State | Go to |
|---|---|---|
| `Extensions: … not installed` | The CMSIS Solution or CMSIS Debugger extension is missing | Step 2 |
| `Workspace: no folder is open`, or `[NO_WORKSPACE]` from a tool | No project is open in the window | Step 3 |
| A folder is open and `cmsis_action` answers `[CMSIS_NO_SOLUTION]` with "contains no *.csolution.yml" | A folder without a solution: it is the project folder | Step 3, then 4 with that folder |
| `[CMSIS_NO_SOLUTION]` with "A solution file exists" | The solution is not loaded | Step 6 |
| A solution is active | Nothing to bootstrap | Step 7 |

## 2. Extensions

Ask the user to install the **Keil Studio Pack** (`Arm.keil-studio-pack`) from the
Extensions view and to reload the window. It brings the CMSIS Solution extension, the
CMSIS Debugger and the Arm Tools Environment Manager. When the user agrees and the
`code` command is available in your shell, you may run
`code --install-extension Arm.keil-studio-pack` instead. Then call
`get_session_status` again.

## 3. An existing project, or a new one?

Ask, unless the request already says:

- **An existing project.** Ask for its folder or its `*.csolution.yml`, then go to
  step 6.
- **A new project.** Ask for
  - the board, or the device when there is no board: the name printed on it, the
    manufacturer, and the revision when known;
  - the parent folder and a project name (letters, digits, dash, underscore), unless
    a folder without a solution is already open: then that folder is the project
    folder and its name the project name, confirmed in one question;
  - the compiler, when the user has a preference: `AC6`, `GCC`, `CLANG` or `IAR`.
    **Without a preference use `AC6`** (Arm Compiler 6), the most stable compiler
    for CMSIS packs; say so in one line;
  - how it will be debugged: the probe on the board or on the desk (CMSIS-DAP,
    ST-Link, J-Link, ULINKplus, …), or an Arm FVP simulation model.
- **A Zephyr board.** When the user wants a Zephyr application, the project skill
  is `$start-zephyr-project` instead of step 5; it needs `$check-zephyr-environment`
  and `$identify-zephyr-board`, and runs `west` in a shell as its steps name.

Do not guess the board from a vague name and do not pick a folder yourself.

## 4. The project folder and its tools

1. Create `<parent>/<project-name>` when it does not exist. Never write into a folder
   that already holds a `*.csolution.yml`; go to step 6 with it instead.
2. When neither the folder nor a parent has a `vcpkg-configuration.json`, copy
   [assets/vcpkg-configuration.json](assets/vcpkg-configuration.json) into the
   folder. It names CMSIS-Toolbox, CMake, Ninja and Arm Compiler 6 from the Arm tools
   registry. For another compiler replace the compiler line:

   | Compiler | Line in `requires` |
   |---|---|
   | `GCC` | `"arm:compilers/arm/arm-none-eabi-gcc": "^14.3.1"` |
   | `CLANG` | `"arm:compilers/arm/llvm-embedded": "^17.0.1"` |
   | `IAR` | none: remove the line, the user provides the compiler |

   The file only names the tools. The Arm Tools Environment Manager fetches them when
   the folder is open in VS Code.
3. Open the folder when no window has it:
   `cmsis_action {action:'open_solution', path:'<folder>'}`. The result says that
   the folder has no solution yet; that is expected. Ask the user to answer the
   prompts of the Arm Tools Environment Manager in that window (download, licence;
   Arm Compiler 6 asks for a licence once) and to tell you when the environment is
   active. Do not download or install a compiler, CMake, Ninja or CMSIS-Toolbox
   yourself, and do not check for them in your shell: the minimal project of step 5
   needs none of them there.
4. Resolve the board or device now with `$identify-cmsis-board-support`: the exact
   CMSIS board identifier and BSP when the board has one, the device `Dname` and
   its DFP in every case. Its `csolution list boards` cross-check is optional; the
   online catalog is the source.
5. `$check-cmsis-environment` is needed only when the user wants an example or a
   template of the board's pack listed (step 3 of `$start-cmsis-project`). Run it at
   most once. When it reports `FAIL` because `cbuild` is not found in your shell, do
   not repeat it and do not search for the tools: take the minimal project. If you
   do look, the artifacts the manifest names are under
   `~/.vcpkg/artifacts/<registry hash>/<artifact id with "/" as ".">/<version>/`
   (Windows: `%USERPROFILE%\.vcpkg\artifacts\…`), for example
   `tools.open.cmsis.pack.cmsis.toolbox/2.12.0/bin/cbuild`; several hashes can
   exist, and every call to a tool needs its absolute path, because each shell call
   is a new process.

## 5. Create the solution

Hand over to `$start-cmsis-project` with the folder, the project name, the verified
board or device and packs, the compiler and the debug adapter. It writes a minimal
project (CMSIS CORE, the DFP's startup component, a bare `main`) or copies an
example or a template of the board's pack when the user wants one and the tools
could list them, opens the solution with `cmsis_action open_solution` and builds it
with `cmsis_action build`, which fetches the packs. Then continue with step 7.

When it reports that the DFP has no startup component (device support comes only
from a configuration generator), tell the user, and offer a template of the pack,
or `$add-board-layer` once a solution exists. Do not write csolution, cproject,
startup or linker files from memory.

## 6. Open the solution in VS Code

```text
cmsis_action { action: 'open_solution', path: '<folder or *.csolution.yml>' }
```

- A folder that a window already has open is used there, and the solution is made
  the active one. No new window: a solution created in the open folder is loaded in
  place.
- Any other folder opens in a new window, because a window without a folder would
  restart its extensions, and the MCP server with them, when a folder is opened in
  it. The window you started in stays as it is; this session's later calls go to
  the new window. `list_debug_windows` shows both.
- A window needs some seconds after it opens. Call `get_session_status`. When
  `cmsis_action build` still answers `[CMSIS_NO_SOLUTION]` with "A solution file
  exists", wait ten seconds and try again, at most three times; then read
  `get_recent_problems` and report what the extension said.

## 7. Build

`cmsis_action { action: 'build' }`. The first build resolves packs and can take
minutes: a result with status `running` is not a failure, `cmsis_action
{ action: 'status' }` waits for it. A failed build shows its error lines; fix the
cause, do not run cbuild yourself. `$start-cmsis-project` step 7 says what the
usual first-build errors mean.

## 8. The debugger

`cmsis_action load_and_debug` needs a `debugger:` node in the active target set and
the `launch.json` the CMSIS Solution extension writes from it.

- Hardware probe: `$cmsis-debugger-setup`.
- Arm FVP: `$fvp-debug-setup`.
- Neither skill installed: ask the user to choose the debug adapter in the CMSIS
  view under **Manage Solution Settings**.

Skip this step when `$start-cmsis-project` already set the adapter, or the copied
example has one.

## 9. Flash, debug, hand over

Ask the user to connect the board. Then `cmsis_action { action: 'load_and_debug' }`
and continue with `cmsis-debug-live`. When the session does not start, read the
hint of the result and `get_recent_problems`; for a probe or connection failure
continue with `$debugger-troubleshooting`.

## 10. Report

State the folder, the solution file, the board or device and its packs, the compiler,
the debug adapter, the result of the build and of the first debug start, and every
step that is still open, with who has to do it.

## Shell commands this skill allows

Only these, and only for the step named:

| Command | Step |
|---|---|
| `code --install-extension Arm.keil-studio-pack` | 2, when the user agrees |
| `mkdir`, copying the manifest | 4 |
| the commands of `$check-cmsis-environment` (`cbuild --version`, `cbuild list environment`, `cbuild list toolchains`), at most once | 4 |
| the commands of `$identify-cmsis-board-support` and `$start-cmsis-project` (`csolution list boards`, `devices`, `examples`, `templates`), by absolute path, after a `PASS` | 4, 5 |
| `west` as `$start-zephyr-project` names it | 5, Zephyr only |

Everything after step 6 goes through the MCP tools.

## What stays with the user

- Installing extensions, unless they ask you to run the command.
- The download and licence prompts of the Arm Tools Environment Manager.
- The choice of board, folder, compiler and debug adapter.
- Connecting the board and its probe.

Ask for each when its step comes, in one short question, and wait for the answer.
