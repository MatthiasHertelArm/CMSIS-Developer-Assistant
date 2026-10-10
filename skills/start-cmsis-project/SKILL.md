---
name: start-cmsis-project
description: "Create the first CMSIS solution for a board or device in a folder that has no *.csolution.yml yet: a minimal project (CMSIS CORE, the DFP's Device:Startup component, a bare main) that every device with a DFP can have, or an example or template of the board's pack when one exists; write the files, open the solution with cmsis_action open_solution and build with cmsis_action build, which fetches the packs. Use from cmsis-bootstrap or cmsis-project when a new project has to be started for a verified board, device and pack. Not for extending a solution that exists (add-cmsis-target) and not for Zephyr (start-zephyr-project)."
---

# Start a CMSIS project

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

Goal: a `<folder>/<project-name>.csolution.yml` with one project that builds with
`cmsis_action build` for the verified board or device. The minimal project is the
path that always exists: it needs only the Device Family Pack (DFP) of the device.
An example or a template of the board's pack is the better start when the board has
a Board Support Pack (BSP) that ships one, and the user wants it.

Nothing in this skill needs a shell. The files are written from the assets next to
this file, the CMSIS Solution extension loads the solution and fetches the packs the
solution names when `cmsis_action build` runs. The only shell commands are the
listing commands named in step 3, and only when `$check-cmsis-environment` has
reported `PASS` in this session; without that, skip them and take the minimal
project.

## 1. Inputs

Collect, or take over from `cmsis-bootstrap`:

- the folder, which must not contain a `*.csolution.yml` (stop and name
  `$add-cmsis-target` when it does);
- the project name: letters, digits, dash, underscore; it names the solution file,
  the project folder and the project file;
- the board or device as `$identify-cmsis-board-support` verified it: the exact
  CMSIS board identifier and BSP when the board has one, and in every case the exact
  device `Dname` and its DFP. Do not start from an unverified name;
- the compiler: `AC6`, `GCC`, `CLANG` or `IAR`. **When the user has no preference,
  use `AC6`** (Arm Compiler 6), the most stable choice for CMSIS packs; say so in one
  line. The Arm Tools Environment Manager fetches it and asks for the licence;
- the debug adapter, when the user wants to debug on hardware or a model now: a name
  from the table in `$cmsis-debugger-setup` (`CMSIS-DAP@pyOCD`, `ST-Link@pyOCD`,
  `ULINKplus@pyOCD`, `J-Link Server`, `Arm-FVP`, …). Do not infer it from the board.
  Without a choice, write no `debugger:` node; `$cmsis-debugger-setup` adds it later.

## 2. Choose the starting point

| Starting point | When it exists | What it brings |
|---|---|---|
| **Minimal project** (this skill's assets) | The DFP has a `Device:Startup` component — nearly every DFP; the exception is a DFP whose device support comes only from a configuration generator | `main()` and startup, nothing else; the user adds drivers and components |
| **Example** of the BSP | The board has a BSP that ships `csolution` examples | A complete application the vendor tested on this board |
| **Template** of the DFP or BSP | The pack ships csolution templates | The vendor's empty project for the family; may need the vendor's generator |

Offer an example or a template only when step 3 could list them. Otherwise, or when
the user does not care, take the minimal project without asking.

## 3. Examples and templates, when the tools are reachable

Only after `$check-cmsis-environment` reported `PASS`, with the absolute paths it
reported:

```text
csolution list examples --filter "<board name without vendor>" --verbose
csolution list templates --verbose
```

An example qualifies when its `environment:` is `csolution` and its `boards:` names
the verified board; keep its `folder:`. A template qualifies when its `pack:` is the
verified DFP or BSP; keep its `path:`. Show the user the qualifying entries with
their descriptions and let them choose, the minimal project always among the
options.

When `csolution` is not reachable (no `PASS`, or the command is not found), say in
one line that the pack's examples and templates were not listed and continue with
the minimal project. Do not search for the executable.

## 4. Write the minimal project

1. Create the folder when it does not exist. Do not overwrite anything.
2. Copy [assets/project.csolution.yml](assets/project.csolution.yml) to
   `<folder>/<project-name>.csolution.yml`,
   [assets/project/project.cproject.yml](assets/project/project.cproject.yml) to
   `<folder>/<project-name>/<project-name>.cproject.yml` and
   [assets/project/main.c](assets/project/main.c) to
   `<folder>/<project-name>/main.c`. Keep `created-for: CMSIS-Toolbox@2.12.0`.
3. Replace every token:

   | Token | Value |
   |---|---|
   | `__COMPILER__` | `AC6`, `GCC`, `CLANG` or `IAR` |
   | `__DEVICE_SUPPORT_PACK__` | the DFP, `Vendor::Name`; remove the whole `- pack:` line and its comment when the BSP is the same pack |
   | `__BOARD_SUPPORT_PACK__` | the BSP; remove the whole `- pack:` line and its comment when there is no BSP |
   | `__TARGET_TYPE__` | the board name, or the device name without a BSP, without `Vendor::`; letters, digits, dash, underscore, at most 32 characters; ask when the name does not fit |
   | `__CMSIS_BOARD__` | the CMSIS board identifier; remove the `board:` line and its comment when there is no BSP |
   | `__CMSIS_DEVICE__` | the CMSIS device `Dname`. A device with several processors (the DFP lists more than one `Pname`, as the MCXN947 does with `cm33_core0` and `cm33_core1`) needs `Dname:Pname`: take the core the user named, otherwise ask which one; when the user does not care, the first core the DFP lists is the boot core, say so in the report |
   | `__PROJECT_NAME__` | the project name, in both files |
   | `__DEBUG_ADAPTER__` | the adapter name; remove the `debugger:` node and its comment when none was chosen |
   | `__STARTUP_COMPONENT__` | `Device:Startup` |

4. Check that no `__` token is left in either file, and that no comment that says
   "remove" survives next to a removed line.

## 5. Write an example or a template

1. Copy the whole `folder:` of the example or `path:` of the template into the
   folder; files in the pack directory can be read-only, make the copies writable.
2. Read the copied `*.csolution.yml`. A `select-compiler:` list without a
   `compiler:` node needs `compiler: <chosen compiler>` added below `solution:`,
   one of the listed compilers; ask when the chosen one is not listed.
3. Use the target type whose `board:` or `device:` is the verified one; stop and
   report when there is none.
4. Add the `debugger:` node under its target set when an adapter was chosen, as in
   the minimal project's template. Change nothing else.
5. A generator project or an `.ioc`, `.mex` or similar file in the copy is a
   follow-on step for the user; do not run a generator here.

## 6. The tools manifest

When neither the folder nor a parent folder has a `vcpkg-configuration.json`, copy
[assets/vcpkg-configuration.json](assets/vcpkg-configuration.json) into the folder.
It names CMSIS-Toolbox, CMake, Ninja and Arm Compiler 6. For another compiler
replace the compiler line:

| Compiler | Line in `requires` |
|---|---|
| `GCC` | `"arm:compilers/arm/arm-none-eabi-gcc": "^14.3.1"` |
| `CLANG` | `"arm:compilers/arm/llvm-embedded": "^17.0.1"` |
| `IAR` | none: remove the line; the user provides the compiler |

An example copied from a pack may bring its own manifest; keep it. The Arm Tools
Environment Manager fetches the tools when the folder is open in VS Code; its
download and licence prompts stay with the user.

## 7. Open and build

```text
cmsis_action { action: 'open_solution', path: '<folder>/<project-name>.csolution.yml' }
cmsis_action { action: 'build' }
```

A folder that a window already has open is used there; a window without a folder
opens it in itself and reloads when the client is a CLI outside the window (wait
about 10 s, then `get_session_status`); otherwise the folder opens in a new window,
and the session's later calls go to it. The first build resolves and
downloads the packs and can take minutes; a `running` result is not a failure,
`cmsis_action { action: 'status' }` waits. Read the result:

| The build result says | Do |
|---|---|
| the device has several processors, or a `Pname` is required (the error names the cores, for example `MCXN947:cm33_core0`) | A multi-core device: write `Dname:Pname` into the `device:` of the csolution, with the core the user wants (ask when it was not named; the first listed core is the boot core), and build again |
| `Device:Startup` matches several components or variants | Show the variants it names, let the user choose, write the full identifier (for example `Device:Startup&C Startup`) into the cproject, build again |
| no component matches `Device:Startup` | The DFP's startup comes from a configuration generator or a board layer only. Remove the rendered files, report it, and offer an example or template of the pack (step 3), or `$add-board-layer` once a solution exists. Do not write startup code, a device header or a linker script |
| a component is `MISSING` (an unsatisfied `requires`) | Add the named component to the cproject's `components:` and build again; the DFP's own device header and common components are the usual ones |
| a pack could not be downloaded, or the tools are not installed | Ask the user to answer the prompts of the Arm Tools Environment Manager and the CMSIS Solution extension in the window, then build again |
| the compiler is not registered | The manifest line of step 6 and the Environment Manager's licence prompt; with `AC6` the user must accept the licence once |

Do not run `cbuild` or `csolution convert` in a shell to get past a failed build;
the build result shows the error lines.

## 8. Report

State the solution file, the project folder, the board or device, the packs, the
compiler, the starting point and where it came from, the debug adapter or that none
was set, the build result, and the open steps: the debugger when no adapter was set
(`$cmsis-debugger-setup`), a generator the copy needs, drivers and components the
user wants next.

## Shell commands this skill allows

| Command | Condition |
|---|---|
| `csolution list examples`, `csolution list templates` | step 3, after `$check-cmsis-environment` reported `PASS`, by the absolute path it reported |
| `mkdir`, copying files, removing the read-only attribute (`chmod -R u+w` or `attrib -R /S`) | steps 4 to 6 |

Everything else goes through `cmsis_action`. Never `cpackget add`, `cbuild` or
`csolution convert`: the extension installs the packs and builds.

## What stays with the user

- The board, the folder, the project name, the compiler when they have a preference,
  the debug adapter.
- The download and licence prompts of the Arm Tools Environment Manager.
- The choice between an example, a template and the minimal project when more than
  one exists.
