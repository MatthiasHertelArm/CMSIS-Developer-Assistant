/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Mutation testing behind `npm run test:mutation` (Stryker finds this file by
// its name). Stryker copies the checkout into .stryker-tmp/, rewrites the
// files named in `mutate` there so that every mutant can be switched on by
// itself, compiles the copy with the repository's own `compile` script and
// runs the unit tests against each mutant: a mutant the tests do not notice
// "survives", and the report under reports/mutation/ names the lines whose
// behaviour no test pins down. The checkout itself is never changed (no
// `inPlace`: other windows and agents may be editing it).
//
// The suites run headlessly, in Node with the `vscode` stub of the transport
// harness, as CONTRIBUTING.md describes; `npm test` and the VS Code host are
// not involved. Six suites need more of VS Code than the stub offers
// (`Disposable.from`, `LogLevel`, `Uri.joinPath`) and are left out, so the
// mutated files are those of src/core/, which those six do not cover alone;
// one more suite is left out because it fails under load (see `ignore`).
// A full run over src/core/ (29 509 mutants, measured 2026-11-25) takes
// hours; narrow it with `--mutate`:
//
//   npm run test:mutation -- --mutate src/core/faultDecoder.ts
//
// Not part of `npm test` or CI: a local check, run when a module's tests
// should be judged, like test:surface.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
    // The modules of src/core/: 3 of the 103 import `vscode`, and their tests
    // run under the stub like the rest.
    mutate: ['src/core/**/*.ts'],

    // The copy compiles like the checkout (tsc into out/), after the mutants are inserted.
    buildCommand: 'npm run compile',

    testRunner: 'mocha',
    mochaOptions: {
        ui: 'tdd',
        require: ['test/transport/vscode-stub.js'],
        spec: ['out/src/test/*.test.js'],
        // Suites the stub cannot carry: they need VS Code's own API.
        ignore: [
            'out/src/test/debugConfigurationManager.test.js',
            'out/src/test/debuggingHandler.test.js',
            'out/src/test/logger.test.js',
            'out/src/test/toolchainPackRoot.test.js',
            'out/src/test/windowCoordinator.test.js',
            'out/src/test/windowProblems.test.js',
            // A mutant in a module-level table (a "static" mutant) is tested
            // with every suite, and a test that fails under the load of the
            // parallel workers then kills it by mistake: measured for the
            // watcher test "the first project document ... is announced",
            // 33 of 161 kills in one run of faultDecoder.ts. The suite covers
            // src/docService/, nothing of src/core/.
            'out/src/test/docService.test.js',
        ],
        // A test with a wall-clock limit skips itself when `__stryker__` is
        // in globalThis, as the stress test of symptomPattern.test.ts does:
        // with all of src/core/ instrumented (29 509 mutants) the code is
        // slower, and a deadline it misses says nothing about a mutant.
    },

    // Only the tests that cover a mutant run against it.
    coverageAnalysis: 'perTest',

    // Not copied into the sandbox: the bundle, the test-host downloads
    // (13 GB), packages, coverage and evaluation runs; node_modules is
    // symlinked, .git and /reports are always left out. out/ is copied: the
    // compiled suites there are the test files Stryker knows, for the report
    // and for the incremental run, which is why `test:mutation` compiles
    // first; the build command then writes them again.
    ignorePatterns: [
        '.vscode-test',
        '*.vsix',
        'coverage',
        'dist',
        'test/eval/.work',
        'test/eval/reports',
    ],

    // A second run tests only the mutants whose code or tests changed
    // (reports/stryker-incremental.json, git-ignored with the reports).
    incremental: true,

    // The page reports/mutation/mutation.html for a reader, mutation.json
    // beside it for a script or an agent.
    reporters: ['clear-text', 'progress', 'html', 'json'],
};

export default config;
