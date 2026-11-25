# Contributing

Contributions and suggestions are welcome.

- Open an issue to discuss a bug or feature before large changes.
- Submit changes as a pull request against `main`; keep PRs focused and include
  a clear description of what changed and why.
- Make sure the build and tests pass locally (`npm run compile`, `npm run lint`,
  and the test suites) before requesting review.
- Newly contributed files are expected to be licensed under **Apache-2.0** and
  include the appropriate SPDX license identifier; see [LICENSE](LICENSE) and
  [NOTICE](NOTICE) for the project's licensing and provenance requirements.

This project is part of [Open-CMSIS-Pack](https://github.com/Open-CMSIS-Pack);
please follow the org's contribution and sign-off requirements where they apply.
All participation is subject to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```sh
npm ci
npm run knowledge:fetch # fetch the pinned core index and its attribution

npm run compile        # tsc → out/src  (what the tests run against)
npm run check-types    # type-check only
npm run build          # check-types + production esbuild bundle → dist/
npm run package        # build + create a platform-targeted VSIX
npm run lint           # lint src/
npm run lint:md        # lint Markdown files
npm run skills:sync    # regenerate skills/catalog.json and the tool-contract blocks (see skills/README.md)
```

The core knowledge index is git-ignored. Fetch it after installing dependencies
and whenever its lock changes: packaging and `skills:sync` require it, and the
documentation-consistency tests need it to run. `npm run knowledge:check` verifies
that the index and `resources/knowledge/SOURCES.md` match the committed lock.

The extension and its PDF worker ship as bundles in `dist/`; `out/` exists for
the tests. See [docs/packaging-esbuild.md](docs/packaging-esbuild.md) for the
runtime payload, the external `serialport` dependency and package verification.

To install a locally built VSIX:

```sh
code --install-extension cmsis-developer-assistant-<platform>-<version>.vsix --force
```

### Tests

Build the extension first: the VS Code test host loads `dist/extension.js`.
`npm test` compiles the test sources and runs the source linter before the tests.

```sh
npm run build
npm test                                              # VS Code integration tests
npm run test:transport                                # session lifecycle + two-window routing, over real sockets
node test/transport/packaged-vsix.js <built.vsix>        # verify a packaged VSIX
```

For changes to tool replies, configuration or DAP behavior, run the relevant
behavior oracle after compiling:

```sh
node test/transport/dap-scenarios.js
node test/transport/config-scenarios.js
node test/transport/executor-cases.js
npm run test:surface
```

The DAP and configuration oracles accept `--update` for intended snapshot
changes. The surface snapshot depends on the host and is a local check; update
it with `npm run test:surface -- --update` only for an intended change.

The unit tests can also be run headlessly against `out/`, which is useful where
the Electron harness will not start:

```sh
./node_modules/.bin/mocha --ui tdd \
  --require test/transport/vscode-stub.js out/src/test/*.test.js
```

Six suites need more of VS Code than the stub offers (`Disposable.from`,
`LogLevel`, `Uri.joinPath`) and fail in this run; `npm test` runs them.

### Mutation testing

Mutation testing judges the tests themselves. Stryker (`stryker.config.mjs`)
copies the checkout into `.stryker-tmp/`, changes the code of `src/core/` one
small step at a time (`===` into `!==`, a string into `""`, a branch dropped),
compiles the copy and runs the headless unit tests against each change. A
change no test fails on has survived and marks behaviour no test pins down.
The report is `reports/mutation/mutation.html`, with `mutation.json` beside it
for a script or an agent; both folders are git-ignored.
Run it for the module you are working on, with Node 22; the whole of
`src/core/` has about 31 000 mutants (31 299 in 112 files on 2026-11-25), about
five hours at the rate of one module:

```sh
npm run test:mutation -- --mutate src/core/faultDecoder.ts
```

A second run tests only the mutants whose code or tests changed
(`reports/stryker-incremental.json`); `-- --force` tests all of them again.
Property-based tests use `fast-check` inside the mocha suites
(`src/test/faultDecoder.test.ts` is the first); keep their seed fixed, so that
a mutation run judges the same values every time, and take their expected
values from the manual or the proposal, never from the module under test. The
six suites above are left out through `mochaOptions.ignore` in the config, and
so is the document service's suite: a mutant in a module-level table is tested
with every suite, and its watcher test fails under the load of the parallel
workers, which would count as a kill. A test that fails for a reason of its
own kills mutants by mistake, so a suite that is to judge mutants must pass in
parallel with itself, and a test with a wall-clock limit skips itself when
`__stryker__` is in `globalThis`, as the stress test of
`symptomPattern.test.ts` does: the instrumented code is slower.

`test/transport/packaged-vsix.js` is the one that catches packaging mistakes:
a missing entry in the `.vscodeignore` serialport allow-list fails **only** in
the built extension, never in the workspace, so it unpacks the VSIX and proves
the native serial binding really enumerates ports.
