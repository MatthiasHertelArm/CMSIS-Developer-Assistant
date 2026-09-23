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

// Bundles the extension (package.json `main`) and the pdf.js worker thread
// into dist/:
//
//   node esbuild.js               development build, with linked source maps
//   node esbuild.js --production  minified, no source maps (npm run build)
//   node esbuild.js --watch       rebuild on every change
//
// dist/ is not cleaned first. esbuild's own log output is off; the plugin
// below prints one line when a build starts, the errors, and one line when
// it ends. See docs/packaging-esbuild.md for the packaging side.

const { context: createBuildContext } = require('esbuild');

const flags = new Set(process.argv);
const isRelease = flags.has('--production');
const keepWatching = flags.has('--watch');

/** Start and end lines on stdout; every error as a message line and, when known, its location on stderr. */
const progressReport = {
    name: 'cmsis-progress-report',
    setup(build) {
        build.onStart(() => {
            console.log('[esbuild] bundling…');
        });
        build.onEnd((outcome) => {
            for (const problem of outcome.errors) {
                console.error(`✖ error: ${problem.text}`);
                const where = problem.location;
                if (where) {
                    console.error(`    ${where.file}:${where.line}:${where.column}`);
                }
            }
            console.log('[esbuild] bundling done');
        });
    },
};

const bundleOptions = {
    // Both land flat in dist/: pdfExtract.ts starts the worker from beside the running bundle.
    entryPoints: ['src/extension.ts', 'src/core/packDocs/pdfWorker.ts'],
    outdir: 'dist',
    entryNames: '[name]',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    minify: isRelease,
    sourcemap: !isRelease, sourcesContent: false,
    // vscode is provided by the host. serialport stays a runtime require: node-gyp-build
    // finds its native prebuild relative to __dirname, which bundling would move.
    external: ['vscode', 'serialport'],
    // The package's UMD entry hands `require` around as a parameter, which esbuild cannot
    // follow (2.0.2 failed at activation with "Cannot find module './impl/format'").
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    logLevel: 'silent',
    plugins: [progressReport],
};

async function bundle() {
    const builder = await createBuildContext(bundleOptions);
    if (keepWatching) {
        await builder.watch();
        return;
    }
    await builder.rebuild();
    await builder.dispose();
}

bundle().catch((reason) => {
    console.error(reason);
    process.exit(1);
});
