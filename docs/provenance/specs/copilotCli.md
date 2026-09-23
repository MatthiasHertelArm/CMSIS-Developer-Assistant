# Spec: scripts/lib/copilotCli.ts

A small helper module for the two scripts that drive a real GitHub Copilot CLI session: `scripts/test-skill-trigger.ts` (the live skill-trigger check) and `scripts/eval-scenario.ts` (agent evaluation scenarios). It does four things:

- runs a command synchronously and returns its stdout;
- finds how to invoke the `copilot` CLI on this platform;
- splits the CLI's `--output-format json` stream into event objects;
- supplies the fixed argument list for a scripted, non-interactive run.

The file carries only the Arm header, but its functions were extracted from DebugMCP's `scripts/test-debug-skill-trigger.js`: 12 of 36 non-trivial lines are shared. It is rewritten from this spec like the other files.

## External contract

An ES module (`scripts/package.json` has `"type": "module"`), imported as `./lib/copilotCli.js`. Keep these four exports and their signatures:

```ts
export function run(command: string, args: string[], options?: childProcess.SpawnSyncOptions): string;
export function getCopilotInvocation(): { command: string; args: string[] };
export function parseEvents<T = unknown>(output: string): T[];
export function copilotBatchArgs(workDir: string, prompt: string, extra?: string[]): string[];
```

| Export | Used by |
|---|---|
| `run` | `scripts/test-skill-trigger.ts`: for `git worktree add` and the Copilot run, with `cwd` set. `scripts/eval-scenario.ts`: for the Copilot run; on failure it records `copilot run failed: <first line of the error message>` as the scenario's infrastructure error |
| `getCopilotInvocation` | both scripts, once per Copilot run |
| `parseEvents` | both scripts: `test-skill-trigger.ts` with a `ToolEvent` type argument; `eval-scenario.ts` untyped, before `aggregateEvents` (`src/core/evalScenario.ts`) |
| `copilotBatchArgs` | both scripts, as `copilotBatchArgs(<work dir>, <prompt>)` without `extra` |

Other references: comments in `src/core/evalScenario.ts` and `scripts/test-skill-trigger.ts`. `scripts/provenance-check.ts` maps the file to DebugMCP's `scripts/test-debug-skill-trigger.js` in `RENAMED`. Nothing under `npm test` imports it.

## Behaviour

### `run(command, args, options = {})`

1. Spawn `command` with `args` synchronously, without a shell, so the arguments are passed verbatim. The defaults are UTF-8 output encoding and a 64 MiB (`64 * 1024 * 1024` bytes) output buffer. The caller's `options` are merged over those defaults, so a caller key wins; the callers pass `cwd`.
2. If the spawn itself failed (the result carries an `error`), throw that error object unchanged. Examples: `ENOENT` when the command is not found, `ENOBUFS` when output exceeds the buffer, a timeout when the caller set one.
3. If the exit status is not `0`, throw a new `Error`. The status can also be `null` for a signal-terminated process. The message has two parts:
   - The first line holds the command, its arguments joined with single spaces, and the exit status.
   - After a newline comes the captured stderr, or stdout when stderr is empty.

   `eval-scenario.ts` relies on the first line alone being a self-contained summary.
4. Otherwise return stdout as a string.

### `getCopilotInvocation()`

- **Not Windows** (`process.platform !== 'win32'`): return `{ command: 'copilot', args: [] }` without running anything. The spawn resolves `copilot` through `PATH`.
- **Windows:** the `copilot` shim that npm installs is a PowerShell script, which cannot be spawned directly.
  1. Through `run`, ask `powershell.exe` for the full path of the `copilot` command. The call uses a PowerShell without profile, non-interactive, and a `-Command` that runs `Get-Command copilot` with error action `Stop` and takes its `Source` property.
  2. Trim the output; that is the path.
  3. Return `{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', <path>] }`.

  If the command is not found, PowerShell exits non-zero and `run` throws. The lookup runs on every call, with no caching.

### `parseEvents(output)`

1. Split `output` on line breaks (CRLF or LF) and drop empty strings.
2. Parse each remaining line with `JSON.parse`. A line that does not parse (banners, whitespace-only lines, partial output) is silently dropped.
3. Return the parsed values in their original order, typed as `T[]` without any runtime check. Any JSON value is kept: objects, but also numbers, strings, `true` and `null`.

### `copilotBatchArgs(workDir, prompt, extra = [])`

Return exactly this array. The flag order is contract (Copilot CLI flags are identifiers):

```text
-C <workDir>  -p <prompt>  --output-format json  --allow-all-tools  --no-custom-instructions
--no-remote  --no-remote-export  --log-level none  <extra…>
```

As a list: `['-C', workDir, '-p', prompt, '--output-format', 'json', '--allow-all-tools', '--no-custom-instructions', '--no-remote', '--no-remote-export', '--log-level', 'none', ...extra]`. What the flags do:

- run in the work directory;
- run one prompt non-interactively;
- emit JSON lines;
- allow every tool without prompting;
- ignore `AGENTS.md` and other custom instructions;
- no remote session and no remote export;
- no log output.

## Agent- or user-visible text

`[REWORD]` strings: **1**. The rest are identifiers and are kept exactly: the command names, PowerShell parameters and Copilot flags.

- `[REWORD]` The `run` failure message, meaning "<command line> failed with exit code <status>" on the first line, followed by the process output. Keep the two-part structure: the first line is the command, its arguments and the exit status; then a newline and stderr (or stdout).
- Identifiers kept exactly:
  - `copilot`, `powershell.exe`
  - the PowerShell parameters `-NoProfile`, `-NonInteractive`, `-Command`, `-File`
  - the cmdlet `Get-Command` with `-ErrorAction Stop` and the `Source` property
  - every Copilot flag and value listed above

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. A process killed by a signal reports the exit status `null` in the failure message.
2. `parseEvents` returns non-object JSON lines as events. A caller that reads `.type` from each event, as `test-skill-trigger.ts` does, throws on a `null` line.
3. Output beyond 64 MiB fails with the spawn error (`ENOBUFS`) and the partial output is lost.
4. On Windows the lookup assumes `Get-Command copilot` resolves to a script `-File` can run. A `copilot.exe` or `.cmd` found first fails. The lookup is not cached.
5. Caller options replace defaults key by key, so passing `encoding` changes what `run` returns.

## Test cases

`scripts/` is outside `npm test`. Run these ad hoc with `tsx`, or add a small `src/test` suite that imports the compiled helper if one is wanted.

1. `copilotBatchArgs('/w', 'p')` deep-equals the list above. With `['--model', 'x']` as `extra`, those two items are appended at the end.
2. `parseEvents('banner\r\n{"type":"a"}\n\n{bad\n{"type":"b","data":{"x":1}}\n')` returns `[{type:'a'}, {type:'b', data:{x:1}}]`, and `parseEvents('')` returns `[]`.
3. `parseEvents('1\nnull\n"s"')` returns `[1, null, 's']`.
4. `run(process.execPath, ['-e', 'process.stdout.write("x")'])` returns `'x'`. With `{ cwd: dir }` the child's `process.cwd()` is `dir`.
5. When the child writes `bad` to stderr and exits 3, `run` throws an `Error`. The first line of its message contains the executable, the arguments and `3`, and the rest is `bad`.
6. When the child exits 2 with an empty stderr and `out` on stdout, the part after the first line is `out`.
7. `run('definitely-not-a-command-xyz', [])` throws the spawn error (`code` `ENOENT`), not the exit-status message.
8. On macOS or Linux, `getCopilotInvocation()` returns `{ command: 'copilot', args: [] }` and spawns nothing.
9. On Windows (manual check):
   - With Copilot CLI installed, the result is `powershell.exe` with `-NoProfile -NonInteractive -File <path to copilot.ps1>`.
   - Without it, the call throws.
10. `npx tsc -p scripts/tsconfig.json` reports no error in `scripts/lib/copilotCli.ts`.

## Constraints

- **Node APIs:** `node:child_process` (`spawnSync`) only. No new dependencies.
- **Header:** the Arm Apache-2.0 block as in `src/core/toolRun.ts`. The file already carries it and has no Microsoft line, so no `DERIVED_FILES` entry changes.
- **Provenance gate:** at most 3 identical trimmed non-trivial lines against DebugMCP's `scripts/test-debug-skill-trigger.js` (`npm run provenance:check -- --gate`, which now maps this file). The PowerShell arguments and Copilot flags are fixed data, but their layout is free: one array per line, grouping, a constant table. The spawn-error handling and the lookup are described above in words; write them fresh.
- **Path and exports:** keep the path and the four export names. Both scripts import them by name from `./lib/copilotCli.js`.
