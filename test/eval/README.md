# Agent evaluation scenarios

`npm run eval:scenario -- <id>` runs a real agent (GitHub Copilot CLI) on a firmware bug
planted in a small csolution, with the `cmsis-debug-live` skill and the CMSIS Developer
Assistant MCP server, and reports what the investigation cost and whether the agent found
the root cause. It turns "this change made the HardFault case take 9 calls and 40 kB
instead of 15 and 120 kB" into a number you can quote in an issue.

```text
npm run eval:scenario -- --list
npm run eval:scenario -- divide-by-zero [--target fvp|board] [--endpoint http://localhost:3001/mcp]
                                        [--runs 3] [--wait-for-window 120] [--rules] [--keep] [--no-mcp-config]
```

It is opt-in and never part of `npm test` or CI: it needs an authenticated Copilot CLI
(spends AI credits), a VS Code window with the extension active on the work directory,
and a Corstone-300 FVP (Docker on macOS) or a board. Failures of that infrastructure are
reported as `infra_error`, not as the agent's failure.

## What a run does

1. Materialises `fixtures/<fixture>/` plus `overlays/<scenario>/` into `.work/<id>/` and
   installs `skills/cmsis-debug-live` under `.work/<id>/.agents/skills/`. The agent never
   sees the overlay mechanism, only a project with a bug in it. With `--rules` the tool rules
   go into `.work/<id>/AGENTS.md` between their marker comments, written by the same code as
   step 3 of *Configure Agents and Skills*.
2. Registers the MCP server in `$COPILOT_HOME/mcp-config.json` (restored afterwards; skip
   with `--no-mcp-config` when it is already registered).
3. Checks with `list_debug_windows` that a VS Code window has the work directory open —
   that window runs the debug session the agent drives. `--wait-for-window N` polls for N
   seconds instead of failing at once.
4. Snapshots `cmsis-developer-assistant://stats`, runs
   `copilot -p "<prompt>" --output-format json …`, keeps the raw event stream in
   `reports/events.<id>.<time>.<run>.jsonl`, snapshots again. The run passes
   `--no-custom-instructions` unless `--rules` is given; then Copilot CLI reads the work
   copy's `AGENTS.md`, and also your own user-level instructions
   (`$COPILOT_HOME/copilot-instructions.md`), so compare runs on a machine where that file
   does not differ between them.
5. Judges: the final answer must match `expectedRootCause`; tool calls, turns and wall time
   must stay within `budgets`; nothing in `forbidden` may appear (by default the agent must
   not reach for `add_logpoint` / `printf` — the point of the skill); no shell command may
   bypass the MCP tools (see below). The verdict and the numbers go to
   `reports/eval.<id>.<time>.json`; `--runs N` repeats and reports each run, because a
   model's path is not deterministic.

## Shell bypasses

The tool rules (`docs/agent-resources/tool-contract.md`, #50) keep agents on the MCP tools
instead of `pyocd`, `gdb` or `cbuild` in a shell. Every scenario checks that:

- The commands of the shell tools — `bash` and `powershell` with their `command`, `write_bash`
  and `write_powershell` with their `input` — are matched against a default deny list:
  `pyocd`, `arm-none-eabi-gdb`, `gdb-multiarch`, `JLinkExe`, `JLinkGDBServer…`, `openocd`,
  `cbuild` (not `….cbuild-run.yml` and other file names), `cpackget`, `pip install` /
  `pip3 install`, and `curl` against `localhost` or `127.0.0.1`
  (`DEFAULT_SHELL_DENY_LIST` in `src/core/evalScenario.ts`). The names of the shell tools
  follow Copilot CLI's hook documentation; check them against the first recorded stream.
- `forbidden.shell` adds a regex of the scenario's own; `"defaultShellDenyList": false`
  switches the default list off for a scenario that runs such a command on purpose.
- `forbidden.toolArgs` is matched against every other tool call only — MCP tools, skills,
  file edits — so an MCP `flash` call whose arguments name `app.cbuild-run.yml` is no bypass.
- Each run in the report lists its `bypasses` (tool, command, which rule caught it) and
  their count; the report gives the `bypassRate` of the scenario: the share of judged runs
  (infrastructure failures left out) with at least one bypass. Run a scenario with and
  without `--rules` to see what the rule file changes.

A compaction forced in the middle of a run is not part of it: Copilot CLI documents
`/compact` as an interactive command and nothing that triggers it in `-p` mode.

## Preparing the target

**FVP (reference).** The fixture is the BSP Blinky for the Corstone-300 FVP
(`FVP_Corstone_SSE-300_Ethos-U55`, Cortex-M55; MDK FVP models ≥ 11.32.23 ship the
GDBServer plugin the CMSIS Solution extension drives). Once per machine:

1. Open `.work/<id>/` (run once with `--keep`, or copy the fixture yourself) in VS Code
   with the CMSIS Solution and CMSIS Developer Assistant extensions; let it generate
   `.vscode/launch.json` for the `Arm-FVP` debugger of the target-set.
2. Apply the two readiness fixes to the `Arm-FVP@GDB (launch)` config: `"port": ""`,
   `"serverPortRegExp": "GDBServer: Listening .*port=([0-9]+)"`,
   `"portDetectionTimeout": 300000`, and `"cmsis": { "updateConfiguration": "manual" }` so
   regeneration keeps them. `.vscode/fvp.sh` already line-buffers the model and resolves the
   plugin; on macOS it builds a Docker image on first use (`docker info` must work, the Arm
   user-based licence in `~/.armlm` is mounted). `python3 fixtures/verify-launch.py` replays
   the adapter's launch path and proves the handshake.
3. Build once (`cmsis_action build` from the window, or the CMSIS panel) so
   `out/…cbuild-run.yml` exists.

**Board.** Point the same csolution at your hardware (a second target-type with its own
`target-set` debugger) and pass `--target board`; scenarios list which targets they suit.

## Scenarios

| id | planted bug | expects |
|----|-------------|---------|
| `divide-by-zero` | `delay_ms / blink_divider` with the divider 0 and `DIV_0_TRP` set | UsageFault `DIVBYZERO`, the variable named |
| `undefined-instruction` | a handler-table slot pointing into a RAM buffer of `0xDE` bytes | `UNDEFINSTR`, execution left the code region, the table named |
| `stack-overflow` | a recursive pattern parser that never advances, with `MSPLIM` set | `STKOF`, the function named |
| `unaligned-access` | a `uint32_t` read at `buf + 1` with `UNALIGN_TRP` set | `UNALIGNED`, the expression named |
| `led-off-by-one` | `1 << led_port_bit_length` — mask one bit too wide, `set_led_port` rejects it; **no fault** | the off-by-one, found by breakpoint and inspection |
| `flash-image-missing` | no bug: `flash-check/Blinky+MPS3.cbuild-run.yml` names an image no build produces, so `flash` fails (on the FVP pyOCD also finds no probe) | the agent stops and reports the failure, runs nothing from the deny list and does not claim success |

The five bug scenarios reproduce on the FVP; a peripheral clock-gating bug does not (the
model does not gate clocks) and would be a board-only scenario. `flash-image-missing` makes a
tool fail through the fixture alone, with no test hook in the extension, to check that an
agent follows the rule "if a tool fails twice, stop and tell the user" instead of reaching
for `pyocd` in a shell.

## Adding a scenario

Create `overlays/<id>/…` under the fixture with the files that replace the base (whole
files; keep the Arm header, no comments that give the bug away) and
`scenarios/<id>.json`:

```json
{
  "id": "…", "prompt": "…", "fixture": "corstone-blinky", "overlay": "overlays/…",
  "targets": ["fvp", "board"],
  "expectedRootCause": "regex the final answer must match",
  "expectedTools": ["diagnose_fault"],
  "forbidden": { "toolArgs": "add_logpoint|printf", "shell": "optional regex", "defaultShellDenyList": true },
  "budgets": { "maxToolCalls": 25, "maxTurns": 15, "maxWallMs": 900000 },
  "rootCause": "for the report reader only"
}
```

`src/test/evalScenario.test.ts` validates every scenario file and exercises the pure logic
(`src/core/evalScenario.ts`); the Copilot event shapes it understands were written from
`tool.execution_start` plus defensive guesses — the report lists `unknownEventTypes` so the
aggregator can be refined from a recorded stream.
