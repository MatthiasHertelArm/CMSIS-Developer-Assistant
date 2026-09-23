# Spec: .vscode-test.mjs, esbuild.js, eslint.config.mjs

Three repository build files still carry the Microsoft line.

- `.vscode-test.mjs` configures the VS Code integration-test runner behind `npm test`.
- `esbuild.js` bundles the extension and the pdf.js worker into `dist/` for packaging.
- `eslint.config.mjs` is the lint configuration behind `npm run lint`.

The files are rewritten from their required *effect*. The generated artefacts and results must not change: the same test discovery and runner options, byte-identical bundles, the same effective lint configuration.

## External contract

### Test runner file (`.vscode-test.mjs`)

- **Name and form:** found by `@vscode/test-cli` (0.0.15) under its default name, and run by `npm test` (`vscode-test --coverage --coverage-output coverage --coverage-reporter lcov --coverage-reporter text`). It is an ES module whose default export is one configuration created with `defineConfig` from `@vscode/test-cli`.
- **Consumers:** CI runs `npm run build`, then `npm test` (under `xvfb-run` on Linux). `.vscodeignore` excludes `**/.vscode-test.*`.

### Bundler script (`esbuild.js`)

- **Language:** CommonJS; the root `package.json` has no `"type"`. It is run with plain `node`.
- **Callers:**
  - `npm run build` runs `npm run check-types && node esbuild.js --production`.
  - `npm run bundle` runs `node esbuild.js`.
  - `npm run package` runs `build` first.
  - The CI step "Build code" runs `npm run build`.

  `node esbuild.js --watch` is supported, but no script uses it.
- **Consumers of its output:**
  - `package.json` `main` is `./dist/extension.js`.
  - `src/core/packDocs/pdfExtract.ts` looks for `pdfWorker.js` beside the running module, so the worker must be `dist/pdfWorker.js`.
  - `.vscodeignore` excludes `esbuild.js` and `dist/**/*.map`.
  - `test/transport/packaged-vsix.js` checks four things:
    - the bundle loads under `test/transport/vscode-stub.js`;
    - the bundle text matches `require("serialport")` or `require('serialport')`;
    - `dist/pdfWorker.js` exists;
    - it starts as a `worker_threads` worker.

### Lint file (`eslint.config.mjs`)

- **Loaded by:** ESLint 10 flat-config discovery, run by `npm run lint` (`eslint src`), which is also `pretest` and the CI "Lint" step.
- **Dependencies:** `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`, both existing devDependencies. Add no new package, for example the `typescript-eslint` meta package.
- `.vscodeignore` excludes `**/eslint.config.mjs`.

## Behaviour

### Test runner options

One configuration with exactly these options; everything else stays at the `@vscode/test-cli` default:

| Option | Value |
|---|---|
| `files` | `out/src/test/**/*.test.js` (the tsc output; `pretest` compiles first) |
| `launchArgs` | on macOS (`process.platform === 'darwin'`) exactly `['--user-data-dir=/tmp/cmsis-vscode-test']`, a short fixed profile path; elsewhere `[]` |
| `mocha` | `{ timeout: 20000 }`. The end-to-end suites build pack/build fixtures in `suiteSetup`, which exceeds mocha's 2 s default on Windows runners |
| `coverage` | `{ reporter: ['lcov', 'text'], output: './coverage' }` |

The defaults are relied on:

- **VS Code version:** `stable`.
- **`extensionDevelopmentPath`:** the directory of the config file, that is the repository root. The extension under test is `dist/extension.js`, which CI builds before testing.
- **Mocha UI:** `tdd`; the suites use `suite` / `test`.
- **Workspace and label:** none. There is a single configuration, not an array.

### Bundler behaviour

- **Mode flags:** `--production` anywhere in `process.argv` selects production. `--watch` anywhere selects watch mode.
- **One esbuild build context with:**
  - entry points `src/extension.ts` and `src/core/packDocs/pdfWorker.ts`;
  - output file names equal to the entry base names (`[name]`), written flat into `dist/` as `dist/extension.js` and `dist/pdfWorker.js`;
  - `bundle`, `format: 'cjs'`, `platform: 'node'`;
  - no explicit `target` (esbuild's default);
  - `minify` in production only;
  - `sourcemap` (linked external `.map` files) outside production only;
  - `sourcesContent: false`.
- **External modules:** `vscode`, which the host provides, and `serialport`. `node-gyp-build` resolves serialport's native `.node` prebuild relative to `__dirname` at runtime, so inlining it breaks every serial tool; `.vscodeignore` ships its subtree. See `docs/packaging-esbuild.md`.
- **Alias:** `jsonc-parser` → `jsonc-parser/lib/esm/main.js`. The package's default UMD entry passes `require` as a parameter, which esbuild cannot trace; the result was `Cannot find module './impl/format'` at activation in 2.0.2. The ESM build bundles cleanly.
- **Logging:** esbuild's own logging is silenced (`logLevel: 'silent'`), so warnings are never printed. A plugin prints a start marker to stdout when each build starts. When each build ends, it prints every error to stderr as two lines, a message line and, when a location exists, an indented `file:line:column` line, followed by a finish marker on stdout.
- **Single build (no `--watch`):** build once, dispose the context, exit 0. On errors the build rejects: the error is printed to stderr (`console.error`) and the process exits with code 1.
- **Watch:** start watching and keep the process alive. Every rebuild prints the markers and errors as above.
- **Stale files:** existing files in `dist/` are not cleaned. A production build leaves an earlier development build's `.map` files in place.

### Lint rules

The effective configuration is pinned by `npx eslint --print-config <file>`, and must be the same for `src/extension.ts` and for the one JavaScript file under `src/` (`src/test/fixtures/packdocs/slowPdfWorker.js`):

- `.ts` files are linted in addition to ESLint's default JavaScript extensions.
- The parser and rules below apply to every linted file, JavaScript included, which is parsed by the TypeScript parser.
- No `ignores` beyond ESLint's defaults. No type-aware linting (no `parserOptions.project`).
- `languageOptions`: `parser` = `@typescript-eslint/parser`, `ecmaVersion: 2022`, `sourceType: 'module'`.
- Plugin namespace `@typescript-eslint` = `@typescript-eslint/eslint-plugin`.
- Rules, all at severity `warn`:
  - `@typescript-eslint/naming-convention`: a single selector `import`, format `camelCase` or `PascalCase`.
  - `curly`, with the default option `all`.
  - `eqeqeq`, with the default option.
  - `no-throw-literal`.
  - `semi`, with the default option.
- `linterOptions` stays at the default (`reportUnusedDisableDirectives: warn`).

The expected result today: `eslint src` lints 147 files (146 `.ts`, 1 `.js`) with 0 problems and exit code 0. Warnings never fail the run; there is no `--max-warnings`.

## Agent- or user-visible text

No agent- or VS Code-visible text. The only human-visible output is the bundler's console output. It is shared with DebugMCP and has no consumer in the repository: there is no `tasks.json` and no problem matcher. `[REWORD]` strings: **4**.

- `[REWORD]` The build-started marker (stdout, once per build start).
- `[REWORD]` The build-finished marker (stdout, once per build end).
- `[REWORD]` The per-error message line (stderr): an error mark, a severity tag and the esbuild error text.
- `[REWORD]` The per-error location line (stderr): indented `file:line:column`.

The test runner and lint files produce no text of their own.

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. The error location line has no trailing colon, and the markers are not `[watch] build started/finished`. VS Code's `$esbuild` / `$esbuild-watch` problem matchers would not match them, and nothing uses them today.
2. esbuild warnings are silenced. An untraceable `require` (the jsonc-parser incident class) produces no output; only `test/transport/packaged-vsix.js` catches it.
3. `dist/` is not cleaned, so stale `.map` files survive a production build. `dist/extension.js.map` is tracked by git today.
4. No explicit esbuild `target`.
5. The macOS test profile path `/tmp/cmsis-vscode-test` is fixed, so two concurrent `npm test` runs on one Mac share it. Coverage is configured both in the file and by CLI flags.
6. Only `src/` is linted (not `scripts/` or `test/`), and every rule is a warning, so CI's lint step cannot fail on them.

## Test cases

1. **Bundle identity:** with the same sources, lockfile and esbuild 0.28.0, `node esbuild.js --production` gives byte-identical `dist/extension.js` and `dist/pdfWorker.js` before and after the rewrite. Record their SHA-256 before switching.
2. **Development build:** `node esbuild.js` writes `dist/extension.js`, `dist/pdfWorker.js` and their `.map` files. Both `.js` files end with a `sourceMappingURL` comment, and the maps have no `sourcesContent`.
3. **Bundle text:**
   - The production `dist/extension.js` contains `require("serialport")` and `require("vscode")`.
   - It does not contain `require("./impl/format")`.
   - Loading it after `test/transport/vscode-stub.js` exposes the functions `activate` and `deactivate`.
4. **Packaged VSIX:** `npm run package` then `node test/transport/packaged-vsix.js <vsix>` passes every check.
5. **Build error:** with a syntax error injected into an entry, `node esbuild.js` exits with 1. Stdout shows the start and finish markers. Stderr shows the message line, the location line and the rejected build error.
6. **Watch:** `node esbuild.js --watch` keeps running and rebuilds after an edit, printing both markers again.
7. **Lint parity:**
   - `npx eslint --print-config src/extension.ts` is equal before and after the rewrite, apart from plugin and parser version strings.
   - The same holds for `src/test/fixtures/packdocs/slowPdfWorker.js`.
   - `npm run lint` reports 147 files and 0 problems.
8. **Rule coverage:** in a scratch `.ts` file under `src/`, `if (a) b();`, `a == b`, `throw 'x';`, a missing semicolon and `import * as Foo_Bar from 'path';` each give exactly one warning (`curly`, `eqeqeq`, `no-throw-literal`, `semi`, `@typescript-eslint/naming-convention`), and the exit code stays 0.
9. **Test runner:**
   - `npm test` runs every `out/src/test/**/*.test.js`, the same count as before.
   - A test lasting 15 s passes.
   - `coverage/lcov.info` and a text summary are produced.
   - On macOS the VS Code command line contains `--user-data-dir=/tmp/cmsis-vscode-test`.

## Constraints

- **Names:** the file names and locations are fixed; `package.json` scripts, `.vscodeignore`, and the test-cli and ESLint discovery depend on them. Module formats are fixed: `.vscode-test.mjs` and `eslint.config.mjs` are ESM, `esbuild.js` is CommonJS.
- **Header:** each file starts with the Arm Apache-2.0 block as in `src/core/toolRun.ts` (block comment), with no Microsoft line. Remove `.vscode-test.mjs`, `esbuild.js` and `eslint.config.mjs` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Provenance gate:** at most 3 identical trimmed non-trivial lines per file against DebugMCP (`npm run provenance:check -- --gate`). Package names, option names and rule ids are fixed. Structure, quoting, grouping of options and the plugin's printing code are free.
- **Dependencies:** none new. Keep `jsonc-parser` aliased, not external, so the bundle stays self-contained.
