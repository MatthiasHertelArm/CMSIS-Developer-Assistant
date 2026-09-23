# Spec: src/test/extension.test.ts

A placeholder smoke test left over from the VS Code extension generator template. It runs inside the VS Code extension test host with the rest of `npm test` (`@vscode/test-cli`, config `.vscode-test.mjs`, glob `out/src/test/**/*.test.js`, mocha TDD interface). It shows an information notification when the file is loaded and runs one test whose assertions check JavaScript's `Array.prototype.indexOf`, not the extension. Its only practical value is that the suite always has one trivially passing test.

## External contract

None. The file exports nothing and no other file refers to it, except `src/test/provenance.test.ts`, which lists its path in `DERIVED_FILES`.

## Behaviour

- Imports Node's `assert` and `vscode`. The extension module is not imported.
- Defines one mocha suite (TDD `suite`) containing one test (TDD `test`).
- When mocha loads the file and runs the suite's body (at suite definition, before any test runs), it calls `vscode.window.showInformationMessage` once with a short message announcing that the test run starts. The returned promise is not awaited and its result is ignored.
- The test is synchronous and makes two strict-equality assertions: searching the array `[1, 2, 3]` for a value that is not in it (5, then 0) returns `-1` each time. It always passes.

## Agent- or user-visible text

All three strings are shared with DebugMCP (and the generator template):

- [REWORD] The information notification: a short message saying that the tests are starting.
- [REWORD] The suite title: names the suite as the extension's test suite.
- [REWORD] The test title: marks the test as a sample.

Surface snapshot: no entry depends on this file.

## Known bugs to preserve

All of these: preserve (fixed separately later).

1. The test checks nothing about the extension; it cannot fail. Replacing it with a real smoke test (for example "the extension is present and activates") or deleting the file is a behaviour change for a separate PR.
2. The notification is raised at suite definition, not in a `suiteSetup` hook, so it appears when mocha loads the file even if the test is filtered out.

## Test cases

Derived from the existing file; the rewritten file must keep them:

1. Given the VS Code test host, when mocha loads the file, then exactly one information notification is requested, without awaiting it.
2. Given the array `[1, 2, 3]`, when `indexOf(5)` is evaluated, then the result is strictly equal to `-1`.
3. Given the same array, when `indexOf(0)` is evaluated, then the result is strictly equal to `-1`.
4. Given `npm test`, when the whole suite runs, then this file contributes one suite with one passing test.

## Constraints

- Keep the path `src/test/extension.test.ts` so the `.vscode-test.mjs` glob picks up its compiled form.
- Mocha TDD interface (`suite`, `test`) and Node `assert`, like the other test files; the test host provides `vscode`.
- No commented-out template lines (the old file carries generator comments and a commented-out import; they are not behaviour).
- File header: the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`, without the Microsoft line (ignore the stale "File Header" section of AGENTS.md). Remove `src/test/extension.test.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- `npm run compile`, `npm run lint` and `npm test` must pass.
