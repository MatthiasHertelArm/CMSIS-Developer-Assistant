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

import * as assert from 'assert';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { flashWithPyocd, parsePyocdLoadOutput, pyocdDirectoryIn, resolvePyocd } from '../core/flashController';

/**
 * Test suite for pyOCD flash-output parsing. Strings mirror
 * pyocd/flash/loader.py completion and failure output.
 */
suite('flashController parsePyocdLoadOutput', () => {

    test('sector-erase completion yields bytes and rate', () => {
        const stdout = [
            '0001234 I Erasing sectors [0x00000000-0x00040000] [eraser]',
            '0002345 I Erased 262144 bytes (128 sectors), programmed 196608 bytes (48 pages), identical 0 bytes (0 pages) at 85.31 kB/s [loader]',
        ].join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 196608);
        assert.strictEqual(parsed.kbps, 85.31);
        assert.strictEqual(parsed.errorLines.length, 0);
    });

    test('chip-erase completion yields bytes', () => {
        const stdout = '0001987 I Erased chip, programmed 524288 bytes (128 pages) at 120.05 kB/s [loader]';
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.programmedBytes, 524288);
        assert.strictEqual(parsed.kbps, 120.05);
    });

    test('empty output yields nulls, not zeros', () => {
        const parsed = parsePyocdLoadOutput('', '');
        assert.strictEqual(parsed.programmedBytes, null);
        assert.strictEqual(parsed.kbps, null);
        assert.deepStrictEqual(parsed.errorLines, []);
        assert.deepStrictEqual(parsed.tail, []);
    });

    test('traceback on stderr lands in errorLines', () => {
        const stderr = [
            'Traceback (most recent call last):',
            '  File "pyocd/probe/pydapaccess.py", line 100, in open',
            'pyocd.core.exceptions.ProbeError: No probe connected',
        ].join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.ok(parsed.errorLines.length >= 2, `expected error lines, got ${JSON.stringify(parsed.errorLines)}`);
        assert.ok(parsed.errorLines.some(l => /Traceback/.test(l)));
        assert.ok(parsed.errorLines.some(l => /No probe connected/i.test(l)));
        assert.strictEqual(parsed.programmedBytes, null);
    });

    test('errorLines keeps only the last 8 matches', () => {
        const stderr = Array.from({ length: 20 }, (_, i) => `error number ${i}`).join('\n');
        const parsed = parsePyocdLoadOutput('', stderr);
        assert.strictEqual(parsed.errorLines.length, 8);
        assert.strictEqual(parsed.errorLines[7], 'error number 19');
    });

    test('tail keeps the last 12 non-empty lines', () => {
        const stdout = Array.from({ length: 30 }, (_, i) => `line ${i}\n\n`).join('\n');
        const parsed = parsePyocdLoadOutput(stdout, '');
        assert.strictEqual(parsed.tail.length, 12);
        assert.strictEqual(parsed.tail[11], 'line 29');
        assert.strictEqual(parsed.tail[0], 'line 18');
    });
});

suite('flashWithPyocd kill escalation', () => {
    /** A child that answers `kill` the way `child_process` does, driven by the test. */
    function fakeChild(onKill: (child: FakeChild, signal: NodeJS.Signals) => void) {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(),
            exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, killed: false,
            signals: [] as NodeJS.Signals[],
            kill(signal: NodeJS.Signals) { child.signals.push(signal); child.killed = true; onKill(child, signal); return true; },
        });
        return child;
    }
    type FakeChild = ReturnType<typeof fakeChild>;
    const spawnFake = (child: FakeChild) => ((() => child) as unknown as typeof spawn);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    test('a child that honours SIGTERM is not SIGKILLed', async () => {
        const child = fakeChild((c, signal) => {
            if (signal === 'SIGTERM') { c.signalCode = 'SIGTERM'; setImmediate(() => c.emit('close', null)); }
        });
        const result = await flashWithPyocd('x.cbuild-run.yml', 20, { spawn: spawnFake(child), killGraceMs: 30 });
        assert.strictEqual(result.timedOut, true);
        await sleep(80);
        assert.deepStrictEqual(child.signals, ['SIGTERM']);
    });

    test('killed=true alone does not stop the escalation: a child still alive after SIGTERM is SIGKILLed', async () => {
        // `killed` is set as soon as the signal is *sent* — the old guard checked exactly that.
        const child = fakeChild((c, signal) => {
            if (signal === 'SIGKILL') { c.signalCode = 'SIGKILL'; setImmediate(() => c.emit('close', null)); }
        });
        const result = await flashWithPyocd('x.cbuild-run.yml', 20, { spawn: spawnFake(child), killGraceMs: 30 });
        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.exitCode, null);
        assert.deepStrictEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    });

    test('a real process that ignores SIGTERM is killed after the grace period', async function () {
        if (process.platform === 'win32') { this.skip(); }
        const spawnIgnoring = ((_cmd: string, _args: string[], opts: object) =>
            spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], opts as never)) as unknown as typeof spawn;
        // A generous deadline: node must have started and installed the
        // SIGTERM handler before the signal arrives (a slow CI runner takes
        // well over 200 ms), else the default action kills it early.
        const t0 = Date.now();
        const result = await flashWithPyocd('x.cbuild-run.yml', 2_000, { spawn: spawnIgnoring, killGraceMs: 300 });
        const elapsed = Date.now() - t0;
        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.exitCode, null, 'died by signal, not by exit');
        assert.ok(elapsed >= 2_250 && elapsed < 10_000, `elapsed ${elapsed} ms`);
    });
});

/** A tools-environment.yml as CMSIS Solution 1.70.1 writes it (trimmed). */
const TOOLS_ENVIRONMENT = [
    'cmsis-tools-environment:',
    '  version: 1.0.0',
    '  generated-by: arm.cmsis-csolution version 1.70.1-63-20260910',
    '  solution: ../Blinky.csolution.yml',
    '  environment:',
    '    path:',
    '      - /home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd',
    '  tools:',
    '    - name: CMSIS-Toolbox',
    '      version: 2.14.1',
    '      origin: built-in',
    '      directory: /home/me/.vscode/extensions/arm.cmsis-csolution-1.70.1/tools/cmsis-toolbox/bin',
    '    - name: pyOCD',
    '      version: 0.45.1',
    '      origin: built-in',
    '      provider:',
    '        type: vscode-extension',
    '        id: arm.vscode-cmsis-debugger',
    '        directory: /not/this/one',
    '      directory: /home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd',
    '      manual: https://pyocd.io/docs/',
    '    - name: Arm GNU GDB',
    '      directory: /home/me/gdb/bin',
    '',
].join('\n');

suite('pyOCD lookup (#46, #45)', () => {
    const only = (...present: string[]) => (candidate: string): boolean => present.includes(candidate);

    test('tools-environment.yml: the directory of the pyOCD entry, not of a nested key or another tool', () => {
        assert.strictEqual(pyocdDirectoryIn(TOOLS_ENVIRONMENT), '/home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd');
        assert.strictEqual(pyocdDirectoryIn('cmsis-tools-environment:\r\n  tools:\r\n    - name: "pyocd"\r\n      directory: \'C:/tools/pyocd\'\r\n'),
            'C:/tools/pyocd');
        assert.strictEqual(pyocdDirectoryIn('cmsis-tools-environment:\n  tools:\n    - name: CMSIS-Toolbox\n      directory: /x\n'), undefined);
        assert.strictEqual(pyocdDirectoryIn(''), undefined);
    });

    test('macOS and Linux: the CMSIS Debugger\'s bundled pyOCD first, then tools-environment.yml, then the first on PATH', () => {
        const extension = '/Users/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-darwin-arm64';
        const bundled = `${extension}/tools/pyocd/pyocd`;
        const listed = '/home/me/.vscode/extensions/arm.vscode-cmsis-debugger-1.8.0-linux-x64/tools/pyocd/pyocd';
        const found = resolvePyocd({
            debuggerExtensionPath: extension, debuggerVersion: '1.8.0', toolsEnvironmentYml: TOOLS_ENVIRONMENT,
            platform: 'darwin', pathEnv: '/usr/bin:/opt/pyocd/bin:/usr/local/bin',
            isFile: only(bundled, listed, '/opt/pyocd/bin/pyocd', '/usr/local/bin/pyocd'),
        });
        assert.deepStrictEqual(found, [
            { bin: bundled, origin: 'debugger-extension', from: 'CMSIS Debugger 1.8.0' },
            { bin: listed, origin: 'tools-environment', from: '.cmsis/tools-environment.yml' },
            { bin: '/opt/pyocd/bin/pyocd', origin: 'path', from: 'PATH' },
        ]);
        const linux = resolvePyocd({ debuggerExtensionPath: '/home/me/ext', platform: 'linux', isFile: only('/home/me/ext/tools/pyocd/pyocd') });
        assert.deepStrictEqual(linux, [{ bin: '/home/me/ext/tools/pyocd/pyocd', origin: 'debugger-extension', from: 'CMSIS Debugger' }]);
    });

    test('Windows: pyocd.exe, backslash paths, PATH split on ; with quoted entries', () => {
        const extension = 'C:\\Users\\me\\.vscode\\extensions\\arm.vscode-cmsis-debugger-1.8.0-win32-x64';
        const bundled = 'C:\\Users\\me\\.vscode\\extensions\\arm.vscode-cmsis-debugger-1.8.0-win32-x64\\tools\\pyocd\\pyocd.exe';
        const listed = 'C:\\tools\\pyocd\\pyocd.exe';
        const onPath = 'C:\\Program Files\\Python\\Scripts\\pyocd.exe';
        const found = resolvePyocd({
            debuggerExtensionPath: extension, debuggerVersion: '1.8.0',
            toolsEnvironmentYml: 'cmsis-tools-environment:\n  tools:\n    - name: pyOCD\n      directory: C:/tools/pyocd\n',
            platform: 'win32', pathEnv: 'C:\\Windows;"C:\\Program Files\\Python\\Scripts"',
            isFile: only(bundled, listed, onPath),
        });
        assert.deepStrictEqual(found.map((candidate) => candidate.bin), [bundled, listed, onPath]);
    });

    test('nothing installed is an empty list; the same file is offered once', () => {
        assert.deepStrictEqual(resolvePyocd({ platform: 'linux', pathEnv: '/usr/bin', isFile: only() }), []);
        const same = resolvePyocd({
            toolsEnvironmentYml: 'x:\n  tools:\n    - name: pyOCD\n      directory: /usr/bin\n', platform: 'linux', pathEnv: '/usr/bin',
            isFile: only('/usr/bin/pyocd'),
        });
        assert.deepStrictEqual(same.map((candidate) => candidate.origin), ['tools-environment']);
    });

    test('a real extension folder resolves under the path it was given, /private/var realpath or not', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-pyocd-'));
        try {
            const executable = process.platform === 'win32' ? 'pyocd.exe' : 'pyocd';
            fs.mkdirSync(path.join(root, 'tools', 'pyocd'), { recursive: true });
            fs.writeFileSync(path.join(root, 'tools', 'pyocd', executable), '');
            for (const given of [root, fs.realpathSync(root)]) {
                const found = resolvePyocd({ debuggerExtensionPath: given, platform: process.platform, pathEnv: '' });
                assert.deepStrictEqual(found.map((candidate) => candidate.bin), [path.join(given, 'tools', 'pyocd', executable)]);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('flashWithPyocd runs the resolved binary and shows it in the command line, quoted when it has a space', async () => {
        const seen: Array<{ command: string; args: string[] }> = [];
        const fakeSpawn = ((command: string, args: string[]) => {
            seen.push({ command, args });
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
            setImmediate(() => {
                child.stdout.end('programmed 1024 bytes (4 pages) at 10.00 kB/s\n');
                child.emit('close', 0);
            });
            return child;
        }) as unknown as typeof spawn;
        const bin = '/Users/me/Library/Application Support/ext/tools/pyocd/pyocd';
        const result = await flashWithPyocd('/w/out/x.cbuild-run.yml', 5_000, { spawn: fakeSpawn, bin });
        assert.deepStrictEqual(seen, [{ command: bin, args: ['load', '--cbuild-run', '/w/out/x.cbuild-run.yml'] }]);
        assert.strictEqual(result.commandLine, `"${bin}" load --cbuild-run /w/out/x.cbuild-run.yml`);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.programmedBytes, 1024);
    });
});
