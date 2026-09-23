# Spec: scripts/test-skill-trigger.ts

An opt-in, live check that the `cmsis-debug-live` skill *triggers*. The script:

1. creates a scratch git worktree of the repository;
2. installs the skill into it as a project skill;
3. runs one non-interactive GitHub Copilot CLI session there with an embedded "it does not work on the board" prompt;
4. asserts from the CLI's JSON event stream that the agent's first tool call invoked that skill.

It is deliberately not part of `npm test`: it needs an authenticated Copilot CLI, spends AI credits, and a model's first move is not deterministic. The static wording that makes the trigger work is pinned separately by `src/test/debugSkillGuidance.test.ts`.

## External contract

- **Invocation:** `npm run test:skill-trigger-agent`, which runs `tsx scripts/test-skill-trigger.ts`. An optional prompt follows `--`, for example `npm run test:skill-trigger-agent -- "The UART stops transmitting after the first DMA transfer"`. The first line is the shebang `#!npx tsx`, so the file can also be executed directly.
- **Exports:** none. It is a script, not a module.
- **Referenced by:**
  - `package.json` (`test:skill-trigger-agent`)
  - `skills/cmsis-debug-live/README.md` (usage and the default prompt's description)
  - `scripts/lib/copilotCli.ts` and `src/core/evalScenario.ts` (comments)
  - `scripts/provenance-check.ts` (`RENAMED` maps it to DebugMCP `scripts/test-debug-skill-trigger.js`)
  - `src/test/provenance.test.ts` (`DERIVED_FILES`)
  - `CHANGELOG.md`, `CHANGES-VS-UPSTREAM.md`
- **Module system:** ES module (`scripts/package.json` has `"type": "module"`). It type-checks under `scripts/tsconfig.json`, where `noUnusedLocals`, `noUnusedParameters` and `noImplicitReturns` are on. The project currently reports 13 unrelated errors in other scripts; this file must add none.
- **Dependencies:** Node built-ins (`node:assert`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`) and `scripts/lib/copilotCli.ts`, imported as `./lib/copilotCli.js`. That helper is in the rewrite scope too; see `copilotCli.md`. Its exports:
  - `run(command, args, options?)` returns stdout. It spawns synchronously with UTF-8 and a 64 MB buffer, and throws on a spawn error or a non-zero exit.
  - `getCopilotInvocation()` returns `{ command, args }`.
  - `parseEvents<T>(output)` returns one object per JSON line and drops other lines.
  - `copilotBatchArgs(workDir, prompt, extra?)` returns the batch-mode argument list.

## Behaviour

### Constants

- **Skill name:** `cmsis-debug-live`.
- **Repository root:** the parent of the script's own directory, derived from `import.meta.url`. It does not depend on the current directory.
- **Default prompt**, used when no command-line arguments are given:

  ```text
  The firmware HardFaults a few seconds after boot. adc_buffer[0] reads 0 on the board but has the right value on the FVP. Find out why.
  ```

  Otherwise the prompt is all arguments joined with single spaces.
- **Scratch directories:** `fs.mkdtempSync(<os.tmpdir()>/cmsis-skill-eval-)`, created at start-up before anything else can fail. The worktree lives at `<tempRoot>/worktree`.

### Steps

1. Run `git worktree add --detach <worktree> HEAD` with the repository root as the working directory. The worktree is the committed `HEAD`, detached.
2. Copy `<repo>/skills/cmsis-debug-live` recursively, as it is in the working tree including uncommitted edits, to `<worktree>/.agents/skills/cmsis-debug-live`. Create the parent directories first.
3. Get the Copilot invocation. On Windows, `getCopilotInvocation()` resolves `copilot` through PowerShell. Then run `<command> <args…> <copilotBatchArgs(worktree, prompt)…>` with the worktree as the working directory. Today that is `-C <worktree> -p <prompt> --output-format json --allow-all-tools --no-custom-instructions --no-remote --no-remote-export --log-level none`.
4. Parse stdout into events and keep those whose `type` is `tool.execution_start`, in stream order. Take their `data` objects. The event shape read is:

   ```ts
   interface ToolEvent { type?: string; data?: { toolName?: string; arguments?: { skill?: string } } }
   ```

5. Assert, in this order, with `node:assert`:
   1. a first tool call exists;
   2. its `toolName` is strictly `skill`;
   3. its `arguments?.skill` is strictly `cmsis-debug-live`.
6. On success print three lines to stdout: the prompt used, the pass line, and the name of the second tool call, or the placeholder `<none>` if there was none.
7. **Always**, success or failure, as cleanup:
   - `git worktree remove --force <worktree>`, then `git worktree prune`. Both run synchronously from the repository root, and their exit codes and output are ignored.
   - Remove `<tempRoot>` recursively with `force`.

### Exit status

- **Success:** exit code 0.
- **Failure:** any failed assertion or command is an uncaught exception. `tsx` prints it and the process exits non-zero. A failed command reports `run`'s message, which gives the command line and exit code on its first line and stderr (or stdout) after it (see `copilotCli.md`). Cleanup has already run by then.

## Agent- or user-visible text

The script's console output and assertion messages are its user interface. `[REWORD]` strings: **6**. They are shared with DebugMCP's `scripts/test-debug-skill-trigger.js`, some differing only in the skill name.

- `[REWORD]` Assertion when no tool ran: "Copilot executed no tool".
- `[REWORD]` Assertion when the first tool is not `skill`: "the first tool should be `skill`", followed by the actual tool name.
- `[REWORD]` Assertion when the wrong skill ran: "expected `cmsis-debug-live`", followed by the actual `arguments` serialized with `JSON.stringify`.
- `[REWORD]` First output line: a label for the prompt, followed by the prompt text.
- `[REWORD]` Second output line: pass, naming `cmsis-debug-live` as Copilot's first tool call.
- `[REWORD]` Third output line: a label for the following tool, followed by its name or `<none>`.

Kept verbatim:

- the default prompt above, which `skills/cmsis-debug-live/README.md` and `CHANGES-VS-UPSTREAM.md` describe;
- the identifiers `cmsis-debug-live`, `skill`, `tool.execution_start`, `.agents/skills`, the `cmsis-skill-eval-` directory prefix, and the git subcommands and flags.

The file's usage comment is written fresh.

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. The worktree is `HEAD`, but the skill is copied from the working tree. The run therefore mixes committed repository content with an uncommitted skill; the skill part is intended.
2. Only the first tool call is judged. A model that reads a file before loading the skill fails the run, although the skill still triggered.
3. Cleanup failures are silent. When `git worktree add` fails, cleanup still tries to remove a worktree that does not exist.
4. Failures surface as an uncaught exception with a stack trace, not as a formatted FAIL line.
5. An output line that is the JSON literal `null` becomes a `null` event, and the `type` filter then throws a `TypeError`.

## Test cases

The script cannot run in CI. These checks use a fake `copilot` on `PATH`, a small executable that records its arguments and working directory and prints a prepared event stream (POSIX only).

1. Given events `{"type":"tool.execution_start","data":{"toolName":"skill","arguments":{"skill":"cmsis-debug-live"}}}` then `{"type":"tool.execution_start","data":{"toolName":"read_memory"}}`, plus a non-JSON banner line, the script exits 0. It prints exactly three lines: the prompt, the pass line, and the next tool `read_memory`.
2. Given only the first event, the third line shows `<none>`.
3. Given no `tool.execution_start` events, the exit code is non-zero and the message is the "no tool" assertion.
4. Given a first tool `bash`, the exit code is non-zero and the message names `bash`. Given `skill` with `{"skill":"other"}`, the exit code is non-zero and the message contains `{"skill":"other"}`.
5. Given a fake `copilot` that exits 3, the exit code is non-zero, and the message's first line names the `copilot` command line and the exit code 3.
6. **Invocation, during the fake run:**
   - The working directory is the worktree.
   - The arguments equal `copilotBatchArgs(<worktree>, <prompt>)`.
   - `<worktree>/.agents/skills/cmsis-debug-live/SKILL.md` exists and equals the working-tree file.
7. **Prompt:** with no arguments the prompt is the default text; with `a b` it is `a b`.
8. **Cleanup:** after every case above, `git worktree list` no longer shows the scratch worktree and the `cmsis-skill-eval-*` directory is gone.
9. `npx tsc -p scripts/tsconfig.json` reports no error in `scripts/test-skill-trigger.ts`.

## Constraints

- **Header:** the first line stays `#!npx tsx`, followed by the Arm Apache-2.0 block as in `src/core/toolRun.ts`, with no Microsoft line. Remove `scripts/test-skill-trigger.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Path and helpers:** keep the file path, which the npm script, the skill README and the provenance mapping depend on. Use the `scripts/lib/copilotCli.ts` helpers, whose contract is in `copilotCli.md`, rather than re-implementing process spawning or event parsing.
- **Provenance gate:** at most 3 identical trimmed non-trivial lines against DebugMCP `scripts/test-debug-skill-trigger.js` (`npm run provenance:check -- --gate`). The git and Copilot arguments, the event type and the skill name are fixed; the structure and variable names are free.
- **Logging:** console output is fine; this runs outside VS Code, so `src/utils/logger` does not apply.
