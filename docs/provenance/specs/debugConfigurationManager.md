# Spec: src/utils/debugConfigurationManager.ts

Supplies the debug configuration for `start_debugging`. The module does four things. It reads the named configurations of a folder's `.vscode/launch.json`. It lets the user pick one in a quick-pick when the agent names none. It maps a source file's extension to a VS Code debug type. It synthesizes a default launch configuration, or a single-test configuration, for that file when no `launch.json` entry is used. CMSIS / `gdbtarget` sessions normally bypass the synthesis: `DebuggingHandler` starts a named configuration by name, and only the sentinel `Default Configuration` (or no name at all) reaches `getDebugConfig`. The module does not parse YAML: `*.cbuild-run.yml` is read in `src/core/cmsisTarget.ts` and `src/core/buildInfo/`.

## External contract

The module exports exactly two names. Keep the names, the zero-argument constructor and every public member below. Parameter names are free.

```ts
export interface IDebugConfigurationManager {
    getDebugConfig(workingDirectory: string, fileFullPath: string, configurationName?: string, testName?: string): Promise<vscode.DebugConfiguration>;
    promptForConfiguration(workingDirectory: string): Promise<string | undefined>;
    detectLanguageFromFilePath(fileFullPath: string): string;
}

export class DebugConfigurationManager implements IDebugConfigurationManager {
    constructor(); // no arguments, no side effects, no vscode calls
    getDebugConfig(workingDirectory: string, fileFullPath: string, configurationName?: string, testName?: string): Promise<vscode.DebugConfiguration>;
    promptForConfiguration(workingDirectory: string): Promise<string | undefined>;
    detectLanguageFromFilePath(fileFullPath: string): string;
    validateWorkspace(workspaceFolder: vscode.WorkspaceFolder): boolean;
    getAvailableConfigurations(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]>;
    hasLaunchJson(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean>;
    static getAutoLaunchConfigName(): string;
}
```

| Export | Used by |
|---|---|
| `IDebugConfigurationManager` | `src/debuggingHandler.ts` (constructor parameter; calls `promptForConfiguration`, then `getDebugConfig`); `src/test/debuggingHandler.test.ts` (casts `{}` to it); `src/index.ts` re-exports it as `IConfigurationManager` |
| `DebugConfigurationManager` | `src/index.ts` re-exports it as `ConfigurationManager`. It is constructed with no arguments by `src/windowCoordinator.ts` and `src/debugMCPServer.ts` (default handler factory). The transport scripts `test/transport/surface-snapshot.js` and `test/transport/session-lifecycle.js` construct it from `out/src/index.js` under the vscode stub in `test/transport/vscode-stub.js` |

`validateWorkspace`, `getAvailableConfigurations`, `hasLaunchJson` and `getAutoLaunchConfigName` have no caller today. They stay, because the rewrite keeps the public surface; removing them is codebase-review item 3.2, a separate change.

The module must load under the transport stub. The stub offers `Uri.file` but not `Uri.joinPath`, and its `workspace.openTextDocument` rejects with `not stubbed`. Loading the module and constructing the class must not touch `vscode`.

## Behaviour

### Constants

- **Sentinel name:** `Default Configuration`. `getAutoLaunchConfigName()` returns it. `src/debuggingHandler.ts` compares against the same literal to decide between "start by name" and "synthesize".
- **launch.json location:** `<dir>/.vscode/launch.json`. `<dir>` is the `workingDirectory` argument, or the folder's `uri` for the folder-based members.
- **Reading:** through the VS Code document model (`vscode.workspace.openTextDocument` of the URI, then its text). The read therefore sees unsaved editor changes. It is not read with `fs`.
- **Parsing:** `jsonc-parser` `parse` with its default options. This tolerates comments, trailing commas, missing commas and `//` inside strings. It returns `undefined` for empty or unparseable text and never throws. Plain `JSON.parse` or regex comment stripping would change behaviour.

### Language detection: `detectLanguageFromFilePath`

The extension is taken with `path.extname` and lower-cased. Mapping (anything else, including no extension, gives `python`):

| Extension | Result |
|---|---|
| `.py` | `python` |
| `.js`, `.ts`, `.jsx`, `.tsx` | `node` |
| `.java` | `java` |
| `.cs` | `coreclr` |
| `.cpp`, `.cc`, `.c` | `cppdbg` |
| `.go` | `go` |
| `.rs` | `lldb` |
| `.php` | `php` |
| `.rb` | `ruby` |

### `getDebugConfig(workingDirectory, fileFullPath, configurationName?, testName?)`

1. If `configurationName` equals the sentinel, return the synthesized configuration for the file (see below) without reading `launch.json`.
2. Otherwise read and parse `launch.json`. If `configurations` is a non-empty array and `configurationName` is truthy, take the first entry whose `name` is strictly equal to `configurationName`. Return a shallow copy of it with `name` replaced by `CMSIS Developer Assistant Launch (<configurationName>)`.
3. A missing file, a parse result without `configurations`, or no matching entry falls through to the synthesized configuration. So does any exception in steps 2–3, for example a `null` array entry. These cases are logged, never thrown.

Synthesized configuration: the language comes from `detectLanguageFromFilePath(fileFullPath)`, and `cwd` is always `path.dirname(fileFullPath)`; `workingDirectory` is not used. If `testName` is truthy and the language is not `coreclr`, the test configuration is returned. Otherwise the default configuration is returned.

Default configurations. `F` is `fileFullPath`, `D` is its directory, `B` is the file's base name without extension. Every one has `request: 'launch'`. Key order is not significant.

| Language | `type` | `name` | Other fields |
|---|---|---|---|
| `python`, and `lldb`/`php`/`ruby` (no entry of their own) | `python` | `CMSIS Developer Assistant Python Launch` | `program: F`, `console: 'integratedTerminal'`, `cwd: D`, `env: {}`, `stopOnEntry: false` |
| `node` | `pwa-node` | `CMSIS Developer Assistant Node.js Launch` | same fields as python |
| `java` | `java` | `CMSIS Developer Assistant Java Launch` | `mainClass: B`, `console: 'integratedTerminal'`, `cwd: D` |
| `coreclr` | `coreclr` | `CMSIS Developer Assistant .NET Launch` | `program: F`, `console: 'integratedTerminal'`, `cwd: D`, `stopAtEntry: false` |
| `cppdbg` | `cppdbg` | `CMSIS Developer Assistant C++ Launch` | `program`: `F` with a trailing lower-case `.cpp`, `.cc` or `.c` replaced by `.exe` (otherwise unchanged), `cwd: D`, `console: 'integratedTerminal'` |
| `go` | `go` | `CMSIS Developer Assistant Go Launch` | `mode: 'debug'`, `program: F`, `cwd: D` |

Test configurations (`testName` = `T`, file name = base name with extension):

- **python:**
  - Fields: `type: 'python'`, name `CMSIS Developer Assistant Python Test: T`, `module: 'unittest'`, `args: [<qualified>, '-v']`, `console: 'integratedTerminal'`, `cwd: D`, `env: {}`, `stopOnEntry: false`, `justMyCode: false`, `purpose: ['debug-test']`.
  - The module name `M` is the base name with a trailing `.py` removed. The match is case-sensitive: `x.PY` keeps its suffix.
  - `<qualified>` is `M.T` when `T` contains a dot.
  - Otherwise the file is read as UTF-8, and the first place anywhere in the text where the word `class` is followed by whitespace and an identifier is found. The identifier must start with an ASCII capital letter and continue with ASCII letters, digits or `_`. The match is not anchored, so text in comments counts, and so does `subclass Foo`. A match gives `M.<Class>.T`. No match or a read error gives `M.T`.
- **node:** if the file name contains `.test.` or `.spec.`, Jest is used, otherwise Mocha. Both have `type: 'pwa-node'`, `console: 'integratedTerminal'`, `cwd: D`, `env: {}` and `stopOnEntry: false`.
  - Jest: name `CMSIS Developer Assistant Jest Test: T`, `program: '${workspaceFolder}/node_modules/.bin/jest'`, `args: ['--testNamePattern', T, '--runInBand', F]`.
  - Mocha: name `CMSIS Developer Assistant Mocha Test: T`, `program: '${workspaceFolder}/node_modules/.bin/mocha'`, `args: ['--grep', T, F]`.
  - The `${workspaceFolder}` is literal text that VS Code substitutes.
- **java:** `type: 'java'`, name `CMSIS Developer Assistant JUnit Test: T`, `mainClass: B`, `args: ['--tests', 'B.T']`, `console: 'integratedTerminal'`, `cwd: D`.
- **Every other language** (`cppdbg`, `go`, `lldb`, `php`, `ruby`): `type: <language>`, name `CMSIS Developer Assistant Launch (test filtering not supported for <language>)`, `program: F`, `console: 'integratedTerminal'`, `cwd: D`, `stopOnEntry: false`.
- **coreclr** never gets a test configuration: `.cs` with a `testName` returns the plain .NET launch.

### `promptForConfiguration(workingDirectory)`

1. **First action:** build the `launch.json` URI with `vscode.Uri.joinPath(vscode.Uri.file(workingDirectory), '.vscode', 'launch.json')`. An exception here propagates to the caller unchanged, after logging. It is not treated as "no launch.json". The surface snapshot depends on this (see Known bugs).
2. Read and parse the file. Any failure in this step is logged and gives an empty list: a missing file, an unreadable file, a parse result without an array `configurations`.
3. Build one item per entry, in file order:
   - `label`: the entry's `name`, or the unnamed-entry fallback label (T1) when it is falsy.
   - `description`: the type text (T2) when `type` is truthy, else `''`.
   - `detail`: the request text (T3) when `request` is truthy, else `''`.

   A `null` entry makes this step throw, and the exception propagates.
4. Append the sentinel item last:
   - `label`: `Default Configuration`.
   - `description`: the sentinel description (T4).
   - `detail`: `CMSIS Developer Assistant will create a default configuration based on file extension. This is a heuristic and may not always work as expected.`
5. Show `vscode.window.showQuickPick(items, { placeHolder, title })` with the placeholder (T5) and the title `Choose Debug Configuration`. There is no `ignoreFocusOut`, no cancellation token and no timeout.
6. If the user dismisses it, reject with an `Error` carrying the cancellation message (T6). Otherwise resolve with the chosen item's `label`. The promise never resolves `undefined`, even though the type allows it.

### Folder-based members

- **`getAvailableConfigurations(folder)`:** reads and parses `<folder.uri>/.vscode/launch.json`. Returns each entry's `name`, or the fallback label (T1) when it is falsy, in file order. Returns `[]` when there is no `configurations` array or on any error; a single `null` entry gives `[]` for the whole list.
- **`hasLaunchJson(folder)`:** `true` if `openTextDocument` of that URI succeeds, else `false`.
- **`validateWorkspace(folder)`:** `true` when `folder.uri.fsPath` is non-empty. When `folder` or `folder.uri` is falsy it returns that falsy value itself (for example `undefined`), despite the `boolean` type. It returns `false` on any exception.
- **`getAutoLaunchConfigName()`:** the sentinel.

## Agent- or user-visible text

`[REWORD]` strings: **6**. They are marked T1–T6, the tags the behaviour section uses. Each appears in DebugMCP's history; write fresh wording with the same meaning. Everything else is quoted exactly. *(near-shared)* marks a DebugMCP sentence with the product name swapped, kept verbatim here.

- **Quick-pick** (VS Code UI):
  - T1 `[REWORD]`: the fallback label for an entry without a `name`, "an unnamed configuration". The same text is the name that the picker returns and that `getAvailableConfigurations` lists.
  - T2 `[REWORD]`: the item description, "the entry's debug type", followed by the `type` value.
  - T3 `[REWORD]`: the item detail, "the entry's request kind", followed by the `request` value.
  - T4 `[REWORD]`: the sentinel item's description, "use the auto-detected default configuration", marked as beta.
  - T5 `[REWORD]`: the placeholder, "pick the debug configuration to use".
  - Title: `Choose Debug Configuration`.
  - Sentinel item detail: `CMSIS Developer Assistant will create a default configuration based on file extension. This is a heuristic and may not always work as expected.` *(near-shared)*
- **Error to the MCP client:** T6 `[REWORD]`, "the user cancelled the debug-configuration selection". `DebuggingHandler` wraps it as `Error starting debug session: Error: <T6>`, so it reaches the agent.
- **Configuration names** (visible as the VS Code session name, and in tool replies that print the session name): all the `CMSIS Developer Assistant … Launch` / `… Test: T` / `Launch (…)` names in the tables above, exactly as written.
- **Surface snapshot** (`test/transport/surface.snapshot.json`, run with `npm run test:surface`): `start_debugging` in the `default` and `all-groups` shapes must still yield `Error starting debug session: TypeError: vscode.Uri.joinPath is not a function`.
- **Identifier, not reworded:** `Default Configuration` is both a visible label and a protocol value. It is shared with DebugMCP, but `debuggingHandler.ts` compares against it and agents may pass it as `configurationName`. The debug types, field names and values (`integratedTerminal`, `pwa-node`, `debug-test`, …) are identifiers too. So are the test-runner arguments and program paths (`--testNamePattern`, `--runInBand`, `--grep`, `--tests`, `${workspaceFolder}/node_modules/.bin/jest`, …).
- **Log events** (wording free, not contract, through `logger`):
  - `launch.json` could not be read or parsed.
  - A named configuration was not found.
  - The prompt failed.
  - The Python class name could not be extracted.
  - `validateWorkspace` hit an exception.
  - Available configurations could not be read.

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. **The picker can hang or vanish.** The `start_debugging` quick-pick has no timeout and no token: a call without `configurationName` waits forever, invisible in a worker window. It also closes on focus loss, which rejects with the cancellation error (T6). Proposal #14 adds the fence.
2. `.rs`, `.php` and `.rb` produce the **Python** launch configuration (`type: 'python'`), while their test variant uses the detected type.
3. `cppdbg` appends `.exe` on every OS, and only for lower-case `.c` / `.cc` / `.cpp`. `cwd` is the file's directory, never `workingDirectory`.
4. An unknown extension is treated as Python.
5. A `configurationName` that is not found, or a broken `launch.json`, silently yields a synthesized configuration. In practice `DebuggingHandler` only calls `getDebugConfig` with the sentinel or an empty name, so the named branch is dormant.
6. Choosing an unnamed entry returns the fallback label (T1) as a configuration name, and the start then fails.
7. The Python class lookup matches the first capitalized `class` word anywhere, including comments and docstrings.
8. `.cs` with a `testName` silently ignores the test filter.
9. `validateWorkspace` can return a non-boolean.
10. The URI for the prompt is built outside the read's error handling. Under the transport stub this surfaces as the `vscode.Uri.joinPath` TypeError pinned by the surface snapshot.
11. A `null` entry in `configurations` makes the prompt throw and empties `getAvailableConfigurations`.

## Test cases

Characterization tests for a new `src/test/debugConfigurationManager.test.ts` (extension host; temp folders with a `.vscode/launch.json`; `vscode.window.showQuickPick` replaced per test):

1. Given each extension in the mapping table, when `detectLanguageFromFilePath` is called, then it returns the mapped type. Given `X.C` it returns `cppdbg`. Given `Makefile` or `a.xyz` it returns `python`.
2. Given a `launch.json` that contains an entry named `Default Configuration`, when `getDebugConfig(dir, '/p/main.c', 'Default Configuration')` is called, then the synthesized `cppdbg` configuration is returned (`program` `/p/main.exe`, `cwd` `/p`) and the file entry is ignored.
3. Given a JSONC `launch.json` with `//` and `/* */` comments, a trailing comma and an `https://` URL in a string, when `getDebugConfig(dir, f, 'CMSIS Debugger: pyOCD')` is called, then the entry is returned with every original field and `name` `CMSIS Developer Assistant Launch (CMSIS Debugger: pyOCD)`.
4. Given no `launch.json`, an empty one, one without `configurations`, or one without the requested name, when `getDebugConfig` is called, then the default configuration for the file is returned and nothing throws.
5. Given `main.cpp`, `main.cc`, `main.c` and `main.C`, when the default configuration is built, then `program` is `main.exe` ×3 and `main.C`.
6. Given `lib.rs`, when `getDebugConfig(dir, 'lib.rs', 'Default Configuration')` is called, then `type` is `python` and `name` is `CMSIS Developer Assistant Python Launch`.
7. Given `test_x.py` containing `class TestX(unittest.TestCase)`, when called with `testName` `test_a`, then `args` is `['test_x.TestX.test_a', '-v']`. With `TestY.test_b` it is `['test_x.TestY.test_b', '-v']`. For a file without a class it is `['test_x.test_a', '-v']`. For an unreadable path it is `test_x.test_a`.
8. Given `a.test.ts` and `a.ts` with `testName` `adds`, then the Jest and Mocha shapes above are returned, with literal `${workspaceFolder}` programs.
9. Given `Foo.java` with `testName` `bar`, then `mainClass` is `Foo` and `args` is `['--tests', 'Foo.bar']`.
10. Given `P.cs` with `testName` `t`, then the plain `.NET Launch` configuration is returned. Given `m.go` with `testName` `t`, then `type` is `go` and `name` is `CMSIS Developer Assistant Launch (test filtering not supported for go)`.
11. Given `testName` `''`, then no test configuration is built.
12. Given a `launch.json` with entries `{name:'A',type:'gdbtarget',request:'launch'}` and `{type:'x'}`, when `promptForConfiguration` runs, then the quick-pick receives three items in this order:
    - `A`, with T2 plus `gdbtarget` and T3 plus `launch`
    - T1, with T2 plus `x` and an empty detail
    - `Default Configuration`, with T4 and the exact detail

    It uses the title `Choose Debug Configuration`, the placeholder T5 and no `ignoreFocusOut`. Choosing `A` resolves `'A'`.
13. Given the user dismisses the pick, then the promise rejects with an `Error` whose message is T6.
14. Given no `launch.json`, then the pick offers only `Default Configuration`.
15. Given `getAvailableConfigurations` on the JSONC file from case 3, it returns the names in order. On a missing file it returns `[]`. `hasLaunchJson` returns `true` and `false` for the same two cases.
16. `validateWorkspace({uri: vscode.Uri.file('/x'), …})` returns `true`, and `validateWorkspace(undefined as any)` returns `undefined`.
17. `DebugConfigurationManager.getAutoLaunchConfigName()` returns `Default Configuration`.
18. `npm run test:surface` passes unchanged.

## Constraints

- **VS Code APIs:** `Uri.file`, `Uri.joinPath`, `workspace.openTextDocument` / `TextDocument.getText`, `window.showQuickPick`, the `DebugConfiguration`, `QuickPickItem` and `WorkspaceFolder` types. Node: `path`, `fs.promises.readFile` (for the Python class lookup only). Parser: `jsonc-parser` (`esbuild.js` aliases it to its ESM build; keep using the package).
- **Logging:** `logger` from `src/utils/logger` (`info` / `warn` / `error`), never `console.*`. Log text is not contract.
- **File header:** the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`. No Microsoft line. Remove `src/utils/debugConfigurationManager.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Provenance gate:** `npm run provenance:check -- --gate` allows at most 3 identical trimmed non-trivial lines (at least 12 characters) against DebugMCP. The fixed names, the mapping table and the repeated `request`/`type` fields make accidental matches likely. Parameter names, signature layout and the representation of the mapping (a list of pairs, a `switch`, a `Map`) are free; the values are not.
- **Tests:** `npm test`, `npm run test:transport` and `npm run test:surface` pass without changes to existing tests.
