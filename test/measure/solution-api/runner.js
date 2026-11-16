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

// Timing reference for CMSIS Solution's API version 3 (see README.md). Starts a VS Code in an isolated
// profile: its own extensions folder (clones of the extensions named below), its own user data, and a copy
// of the workspace, so neither the user's VS Code nor the project is touched. Run with Node 22:
//
//   CODE=<VS Code executable> WORKSPACE=<a csolution folder with vcpkg-configuration.json> \
//   EXTENSIONS="<csolution dir>:<environment-manager dir>[:<cmsis-debugger dir>]" RUN_NAME=<name> \
//   node test/measure/solution-api/runner.js
//
// The result lands in results/<RUN_NAME>.json. Unset ELECTRON_RUN_AS_NODE when running from a VS Code terminal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const need = (name) => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`set ${name} (see the comment at the top of runner.js)`);
    }
    return value;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-apimeasure-'));
const extensions = path.join(work, 'ext');
fs.mkdirSync(extensions);
for (const dir of need('EXTENSIONS').split(':').filter(Boolean)) {
    fs.cpSync(dir, path.join(extensions, path.basename(dir)), { recursive: true });
}
const workspace = path.join(work, 'ws');
fs.cpSync(need('WORKSPACE'), workspace, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
// macOS: the user-data folder must be short, or VS Code's IPC socket path is too long.
const userData = process.env.USER_DATA ?? '/tmp/cda-apimeasure-ud';

runTests({
    vscodeExecutablePath: need('CODE'),
    extensionDevelopmentPath: path.join(__dirname, 'probe'),
    extensionTestsPath: path.join(__dirname, 'probe', 'run.js'),
    launchArgs: [workspace, '--extensions-dir', extensions, '--user-data-dir', userData, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { PROBE_OUT: path.join(__dirname, 'results', `${need('RUN_NAME')}.json`) },
}).then(() => {
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`result: results/${process.env.RUN_NAME}.json`);
}, (failure) => {
    console.error('probe failed', failure);
    process.exit(1);
});
