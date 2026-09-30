---
name: fvp-debug-setup
description: "Wire the CMSIS Solution extension's Run/Debug buttons to an Arm FVP using the model's built-in GDBServer plugin (MDK FVP models 11.32.23+, vcpkg arm:models/arm/avh-fvp). Sets the csolution `debugger: name: Arm-FVP` node, installs a model shim that resolves plugins/GDBServer.so, line-buffers the model's stdout and runs the model in Docker on macOS (where Arm ships no FVP build), and fixes the launch config's readiness handshake so GDB does not connect before the model is listening. Use when the user wants to debug firmware on a Corstone FVP, migrate off fvp-gdb/Iris, or map the CMSIS view buttons to an FVP in a csolution project."
---

# FVP debugging via the model's own GDBServer plugin

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
- If a tool fails twice, call `get_session_status` and `get_recent_problems`, then stop and tell the user what to do in VS Code. Do not work around a failing tool with a shell command.
<!-- cmsis-developer-assistant:rules:end -->

Goal: make the CMSIS view's **Load & Debug** and **Run** buttons work end-to-end against an FVP, with no external GDB bridge.

Since **MDK FVP models 11.32.23** the release ships `plugins/GDBServer.so` (`.dll` on Windows), so the model *is* the GDB server. `fvp-gdb`, Iris and the whole `--iris-server` detour are obsolete — do not reintroduce them. If the user's project still has `start-fvp-gdb.sh`/`stop-fvp-gdb.sh`/`tail-fvp-log.sh` and a `.vscode.d/tasks.json` overriding `CMSIS Load`/`CMSIS Run`, delete them as part of this migration.

## 1. Verify prerequisites

**The model release.** `arm:models/arm/avh-fvp` in `vcpkg-configuration.json` must be `>= 11.32.23`. The registry is a zip served at `https://artifacts.tools.arm.com/vcpkg-registry/` — download and unpack it to see the real versions and their download URLs rather than trusting the local cache in `~/.vcpkg/registries/`, which goes stale. Archive naming changed with this release: `mdk-fvp-<major>.<minor>_<patch>_linux_{arm64,x86}.tar.gz` (was `avh-linux-*`).

**Host support.** The artifact has demands for `windows and x64`, `linux and x64`, `linux and arm64` — **no darwin**. On macOS `vcpkg activate` silently installs nothing (you get an artifact dir containing only `artifact.json`), so the model has to run in Docker. Check `docker info` there.

**GDB.** `arm-none-eabi-gdb` must resolve — from the vcpkg `arm-none-eabi-gcc` artifact or the registry's separate `arm-none-eabi-gdb`.

**Arm license.** The FVP needs an activated user-based license in `~/.armlm`.

## 2. The plugin's contract (verified against 11.32.23)

`FVP_<model> --plugin <path>/GDBServer.so --list-params` gives exactly six parameters:

| Parameter | Default | Note |
|---|---|---|
| `GDBServer.port` | `10000` | the extension passes 3333 |
| `GDBServer.allow_remote` | `0` | **required behind Docker port forwarding** |
| `GDBServer.core_name` | `''` | empty = plugin picks a core |
| `GDBServer.list_cores` | `0` | |
| `GDBServer.shutdown_on_disconnect` | `0` | |
| `GDBServer.verbose_logging` | `0` | |

Two behaviours matter more than the parameters:

- **`-D` / `--allow-debug-plugin` is what makes the model start halted at the reset vector.** With the plugin but without `-D` the model opens the port *and free-runs to completion* — a `tbreak main` would never fire. With `-D` it waits, and GDB attaches at `Reset_Handler`.
- **RSP detach does not resume the target.** After `detach` the core stays halted at wherever it was, and `monitor help` lists only logging commands — there is no resume. So a "Run" action cannot resume a halted debug instance; it must start its own free-running model (no plugin, no `-D`).

On startup the plugin prints, on the model's stdout:

```text
GDBServer: Debug core: component.Corstone_SSE_320_Main.mps4_board.subsystem.cpu0
GDBServer: Listening address="0.0.0.0" port=3333
```

That banner is the readiness signal used in step 5.

## 3. How the CMSIS Solution extension maps its buttons

Verified against `arm.cmsis-csolution` **1.70.0** and **1.72.0**; the debug adapter is `gdbtarget` from `eclipse-cdt.cdt-gdb-vscode` (2.9.1).

- The **debug button** starts the launch config by **name**, rendered from the active adapter template. For `Arm-FVP` that is `Arm-FVP@GDB (launch)`; the attach button starts `Arm-FVP@GDB (attach)`.
- The **run button** runs the task `CMSIS Load+Run`; the standalone buttons run `CMSIS Load` / `CMSIS Run` / `CMSIS Erase`.
- On regeneration the extension rewrites every `CMSIS *` task and every launch config carrying `"cmsis": {"updateConfiguration": "auto"}`, and *removes* auto configs that are not in the generated set. `"manual"` survives both. Regeneration also fires on a plain file-watch of the csolution yml — useful for testing: `touch <name>.csolution.yml`, wait, re-read `.vscode/launch.json`.

**`templates/debug/FVP.adapter.json` in the extension already does the right thing** — read it (`~/.vscode/extensions/arm.cmsis-csolution-*/templates/debug/`) rather than reinventing it. It generates `Arm-FVP@GDB (launch)` as a `request: "launch"` config whose `target.server` is the model and whose `serverParameters` are `-D --plugin ${env:AVH_FVP_PLUGINS}/GDBServer.so -C GDBServer.port=<port> <config-file> <args> -a <image>`, plus `CMSIS Load` (echo no-op — the model loads the image at launch), `CMSIS Run` (the bare model, free-running) and `CMSIS Load+Run`. That is why this skill switches the adapter instead of hijacking the pyOCD names; older notes claiming `Arm-FVP` generates no launch config are out of date.

## 4. Set the csolution debugger node

Under the FVP target-type's `target-set:`:

```yaml
debugger:
  name: Arm-FVP
  model: ${workspaceFolder}/.vscode/fvp.sh    # or FVP_Corstone_SSE-320 where no shim is needed
  config-file: board/Corstone-320/fvp_config.txt
```

The yml-node names come from `debug-adapters.yml` (`model`, `config-file`, `args`) — the csolution JSON schema does not document `debugger:` at all, so do not go looking there. `${workspaceFolder}` passes through csolution untouched and is expanded by VS Code.

**Do not set `args: ""`.** The template does `config.args?.trim().split(/\s+/) ?? []`, and an empty string splits to `['']`, injecting an empty argv entry into the model command line. Omit the node entirely instead.

Regenerate and confirm the node landed: the `debugger:` block in `out/<solution>+<target>.cbuild-run.yml` should show `name: Arm-FVP`, `model:`, `config-file:`.

## 5. The two readiness bugs — fix both or neither works

The generated launch config does **not** work as shipped. Both of these must be fixed together.

**(a) The adapter connects after 0 ms.** From `cdt-gdb-adapter`'s `startGDBServer`:

```js
if (target.port && target.serverParameters) {
    setTimeout(() => resolveStartup(), target.serverStartupDelay ?? 0);   // 0 ms!
} else {
    // wait for target.serverPortRegExp on the server's stdout, take the port from the match
}
```

The template sets both `port` and `serverParameters`, so GDB connects immediately while the model still needs a second or more to build the platform (plus a container start on macOS). The symptom is a session that tears itself down and only *then* prints the banner:

```text
gdb connection lost
GDBServer: Listening address="0.0.0.0" port=3333    ← too late
Info: <model>: Stopping simulation...
```

Blank the port to select the event-driven branch — better than `serverStartupDelay`, which is a fixed cost paid on every single launch:

```jsonc
"port": "",
"serverPortRegExp": "GDBServer: Listening .*port=([0-9]+)",
"portDetectionTimeout": 300000
```

**(b) The banner is stuck in a pipe buffer.** The model block-buffers its own stdout whenever it is not a TTY — which it never is under VS Code — so the banner (and every semihosting `printf`) sits in a 4KB buffer until the model exits. Fix (a) reads that banner, so it depends on this. Run the model under `stdbuf -oL -eL`; the shim in step 6 does it on both paths. Note this is separate from `uart0.unbuffered_output`, which only covers the UART model.

**This forces `"updateConfiguration": "manual"` on the launch config.** A `.vscode.d/launch.json` drop-in does *not* work as a lighter alternative: `LaunchJsonFile.addConfig` calls `fromObject`, which **replaces** the config rather than merging fields — it drops `server`, `serverParameters` and the `cmsis` node. And `ConfigurationSchema` requires `name`, `type` **and** `request`; without all three the drop-in fails validation and is discarded with no message. So a drop-in would have to restate the whole config anyway. Take `manual`, and leave a comment in the config saying how to re-sync it (flip to `auto`, run "Update Debug Tasks and Launch Configurations", re-apply the three `target` fields).

Leave `Arm-FVP@GDB (attach)` on `auto` — it has no `serverParameters`, so it is unaffected.

## 6. Install the model shim

Copy `templates/fvp.sh` and (macOS only) `templates/fvp.Dockerfile` into the project's `.vscode/`, replace `{{FVP_MODEL}}`, `{{FVP_VERSION}}` and, in the Dockerfile, `{{FVP_ARCHIVE}}` (`fvp.sh` passes the real archive name as a build argument, so any placeholder value works there), and `chmod +x fvp.sh`. It is worth installing even on Linux-only projects for the first two reasons:

- **Resolves the plugin.** The generated config takes the path from `${env:AVH_FVP_PLUGINS}`, which only exists in a shell that has run `vcpkg activate` — a VS Code launched from Finder, the dock or a desktop entry has not. VS Code expands the unset variable to the empty string, giving `/GDBServer.so`. The shim rewrites any `--plugin` argument that does not resolve, deriving the path from the model executable's own location.
- **Line-buffers** the model, per 5(b).
- **Runs the model in Docker on macOS**, publishing the GDB port. Specifics that each cost a debugging session if missed:
  - `-C GDBServer.allow_remote=1` must be injected. Through Docker's port forwarder the debugger is not a localhost client, and the plugin resets the connection without it.
  - The container must run as the **host user name and uid** (`groupadd`/`useradd` from build args), with `~/.armlm` mounted and `ARMLM_CACHED_LICENSES_LOCATION` set — the Arm user-based license is bound to the account that activated it, otherwise: `Fatal: license error: The license found is assigned to another user.`
  - The tarball unpacks as `./<host_triple>/{bin,plugins,...}`, so `tar --strip-components 2` (not 1, whatever the vcpkg artifact json says).
  - Install a `libpython3*.so` in the image. It is only dlopen'd by the VSI/VIO bridges, which these projects do not use, but without it the model prints a five-paragraph error before every run. Ubuntu's own `libpython3.10` plus a `.so` symlink is enough; do not depend on the deadsnakes PPA, whose key import is flaky and which has no arm64 jammy builds for some packages.
  - Bind-mount `$HOME` at the same path and set `--workdir "$PWD"` so the ELF and config-file paths the extension passes in resolve unchanged.
  - `--rm --init` plus a `--name cmsis-fvp-<port>` that is `docker rm -f`'d first, so a session that died badly cannot hold the port.

## 7. Verify

Verify through VS Code, because that exercises the adapter's own readiness path, which is what breaks:

1. `cmsis_action { action: 'build' }`, then `cmsis_action { action: 'load_and_debug' }` with the FVP target active.
2. The result reports a session that stopped at `main`. `get_call_stack` shows `main` on top.
3. `get_recent_problems { sources: ['gdb-server'], minSeverity: 'info' }` lists the model's output. The line `GDBServer: Listening address="0.0.0.0" port=3333` must appear **before** the session came up. A line `gdb connection lost` followed by the banner means fix 5(a) or 5(b) is missing.
4. `continue_execution`, then read the firmware's output: the model's stdout is in the debug console, and the UART is in its telnet or log file, as the model's configuration says.
5. `stop_debugging`. On macOS, `docker ps` must be empty afterwards.
6. `cmsis_action { action: 'load_and_run' }` for the free-running path (no `-D`, no plugin), and check that the firmware's output appears; `cmsis_action { action: 'stop_run' }` ends it.

When the session cannot be started through VS Code, or the user asks for the launch path to be replayed outside it, `templates/verify-launch.py` in this skill directory does that: it parses the committed `launch.json`, spawns `target.server` with `target.serverParameters` as VS Code would expand them, reads the server's output until `serverPortRegExp` matches, then runs `arm-none-eabi-gdb -batch` with the configuration's `initCommands` plus `continue`, `bt`, `detach`. It talks to the model only, never to a board. It exits non-zero unless the breakpoint was hit and no container was left behind, and it says so when `target.port` is still set, which means fix 5(a) was never applied.

Success looks like:

```text
port detected: 3333 after 0.9s
Temporary breakpoint 1, main () at board/.../main.c:31
[Inferior 1 (Remote target) detached]
```

On macOS warn that the very first run builds the container image (~100MB download).

## Caveats to tell the user

- **Run restarts the model, it does not resume a halted one** — RSP detach leaves the core halted and the plugin has no resume command (§2).
- Only one model can hold the GDB port at a time; a stale `fvp-gdb` or an older container will block it. `lsof -nP -iTCP:3333 -sTCP:LISTEN` finds the culprit.
- The launch config is `manual`: after changing target-type or build-type, its `program`/`serverParameters` paths need re-syncing (§5).
- Windows: point `model:` straight at `FVP_Corstone_SSE-320.exe` — the shim is a macOS detour and is POSIX shell.
- Worth reporting upstream: Arm's `FVP.adapter.json` sets neither `serverStartupDelay` nor `serverPortRegExp`, so the generated config races on every host; macOS just loses it every time.
