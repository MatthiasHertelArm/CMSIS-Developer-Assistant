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
import * as fs from 'fs';
import * as path from 'path';
import { parseBuildLog } from '../core/buildInfo/buildLog';
import { capturedResultOf, cleanBuildOutput, resultLogHeader, resultLogPath } from '../core/buildResult';

/**
 * The result CMSIS Solution captures for a build task (#140), over output
 * captured from CMSIS Solution 1.72.1-115 on 2026-11-18 (a micro:bit Blinky
 * built with AC6 6.24.0, paths shortened): its shape, the terminal text as
 * the lines of a log, and what the log parser finds in it.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildresult');
const captured = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');

suite('captured build result (#140)', () => {
    test('a result is an object with the output as text and an exit code that is a number or absent', () => {
        assert.deepStrictEqual(capturedResultOf({ exitCode: 0, output: 'x' }), { exitCode: 0, output: 'x' });
        assert.deepStrictEqual(capturedResultOf({ exitCode: -3, output: '' }), { exitCode: -3, output: '' });
        assert.deepStrictEqual(capturedResultOf({ output: '^C' }), { output: '^C' }, 'a stopped or skipped build has no exit code');
        assert.deepStrictEqual(capturedResultOf({ exitCode: undefined, output: '^C' }), { output: '^C' });
        for (const none of [undefined, null, 'text', 7, {}, { exitCode: 0 }, { exitCode: '0', output: '' }, { exitCode: 0, output: 1 }]) {
            assert.strictEqual(capturedResultOf(none), undefined, JSON.stringify(none));
        }
    });

    test('the fixtures are terminal output: CR CR LF, bare CR and escape sequences', () => {
        const raw = captured('build-warning');
        assert.ok(raw.includes('\r\r\n') && raw.includes('\x1b[K\r[1/2]') && raw.includes('\x1b[0;1;35mwarning: '), 'kept byte for byte in the repository');
    });

    test('the cleaned output has plain lines: no control sequence, no CR, each state of ninja\'s progress line once', () => {
        const text = cleanBuildOutput(captured('build-warning'));
        assert.ok(!/[\x1b\r]/.test(text), 'neither ESC nor CR is left');
        assert.ok(text.endsWith('+============================================================\n'));
        const lines = text.split('\n');
        assert.ok(lines.includes('/work/Blinky/Blinky.c:43:2: warning: probe-warning-720 [-W#warnings]'), text);
        assert.ok(lines.includes('(1/1) Building context: "Blinky.Debug+microbit-v2"'));
        assert.strictEqual(lines.filter((line) => line.startsWith('[0/2] Building C object')).length, 1);
        assert.strictEqual(lines.filter((line) => line.startsWith('[1/2] Building C object')).length, 1);
        assert.strictEqual(lines.filter((line) => line.startsWith('[2/2] Linking C executable')).length, 1, 'the line ninja drew twice is there once');
        assert.ok(!text.includes('\n\n\n'), 'the blank a CR-first line leaves is not kept');
    });

    test('a blank line stays one, and an empty output stays empty', () => {
        assert.strictEqual(cleanBuildOutput('a\r\n\r\nb\r\r\n'), 'a\n\nb\n');
        assert.strictEqual(cleanBuildOutput('\r[1/2] x\x1b[K\r[2/2] y\x1b[K\r\r\ndone'), '[1/2] x\n[2/2] y\ndone\n');
        assert.strictEqual(cleanBuildOutput(''), '');
        assert.strictEqual(cleanBuildOutput('\r\n\r\n'), '');
    });

    test('a stopped build ends in ^C, with Stop Build\'s line when CMSIS Solution stopped it', () => {
        assert.ok(cleanBuildOutput(captured('rebuild-stopped-terminate')).endsWith('\n^C\n'));
        assert.ok(cleanBuildOutput(captured('rebuild-stopped-command')).endsWith('\n^C\n🟥 Build cancelled by user\n'));
    });

    test('the log parser reads the cleaned output of each kind of build', () => {
        const parsed = (name: string) => parseBuildLog(cleanBuildOutput(captured(name)), `${name}.log`);
        const shown = (name: string) => parsed(name).diagnostics.map((d) => `${d.severity} ${d.tool} ${d.code ?? '-'} ${d.message.slice(0, 44)} x${d.count}`);

        const warning = parsed('build-warning');
        assert.deepStrictEqual([warning.errors, warning.warnings, warning.ok, warning.status],
            [0, 2, true, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:00']);
        assert.deepStrictEqual(warning.diagnostics.map((d) => [d.severity, d.tool, d.file, d.line, d.code, d.message]).slice(1), [
            ['warning', 'compiler', '/work/Blinky/Blinky.c', 43, '-W#warnings', 'probe-warning-720'],
        ]);

        const rebuilt = parsed('rebuild-ok');
        assert.deepStrictEqual([rebuilt.errors, rebuilt.warnings, rebuilt.ok], [0, 5, true]);
        assert.deepStrictEqual(shown('rebuild-ok').slice(1), [
            'warning compiler -Wunused-command-line-argument argument unused during compilation: \'-MD\' x1',
            'warning compiler -Wunused-command-line-argument argument unused during compilation: \'-MT …\' x1',
            'warning compiler -Wunused-command-line-argument argument unused during compilation: \'-MF …\' x1',
            'warning compiler A1950W The legacy armasm assembler is deprecated. C x1',
        ], 'the dependency-file options without their file, and armasm\'s own warning');

        const failed = parsed('build-error');
        assert.deepStrictEqual([failed.errors, failed.ok, failed.failedSteps.length], [3, false, 2]);
        assert.strictEqual(failed.diagnostics.find((d) => d.severity === 'error')?.message, 'expected parameter declarator');

        const link = parsed('build-link-error');
        assert.deepStrictEqual(link.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.tool, d.code, d.message]),
            [['linker', 'L6218E', 'Undefined symbol probe_missing (referred from Blinky.o).']]);

        assert.deepStrictEqual([parsed('build-noop').errors, parsed('build-noop').warnings, parsed('build-noop').ok], [0, 1, true]);
        assert.deepStrictEqual([parsed('clean').errors, parsed('clean').warnings, parsed('clean').status], [0, 0, undefined]);
    });

    test('a tool older than CMSIS-Toolbox recommends is a warning with the code tool-version', () => {
        const line = 'CMake 4.2.1 or newer is recommended for CMSIS-Toolbox. You are using CMake 3.31.12.';
        const summary = parseBuildLog(`${line}\n(1/1) Building context: "App.Debug+T"\n${line}\nBuild summary: 1 succeeded, 0 failed - Time Elapsed: 00:02:05\n`, 'b.log');
        assert.deepStrictEqual(summary.diagnostics.map((d) => [d.severity, d.tool, d.code, d.message, d.count]), [['warning', 'cbuild', 'tool-version', line, 2]]);
        assert.deepStrictEqual([summary.warnings, summary.errors, summary.ok], [2, 0, true]);
        assert.strictEqual(parseBuildLog('Ninja 1.12 or newer is recommended for CMSIS-Toolbox. You are using CMake 3.31.12.\n', 'b.log').diagnostics.length, 0,
            'the tool that is recommended is the tool in use');
    });

    test('an armasm line with a location stays the old-style compiler line it was', () => {
        const summary = parseBuildLog('"startup.s", line 12: Warning: A1581W: Added 2 bytes of padding at address 0x6\nError: A1163E: Unknown opcode\n', 'b.log');
        assert.deepStrictEqual(summary.diagnostics.map((d) => [d.severity, d.file, d.line, d.code, d.message]), [
            ['warning', 'startup.s', 12, undefined, 'A1581W: Added 2 bytes of padding at address 0x6'],
            ['error', undefined, undefined, 'A1163E', 'Unknown opcode'],
        ]);
    });

    test('the log is one file per target set under out/cmsis-developer-assistant, never the diagnostic re-run\'s', () => {
        assert.strictEqual(resultLogPath('CYT4BF8CDS@file-io'), 'out/cmsis-developer-assistant/build-CYT4BF8CDS@file-io.log');
        assert.strictEqual(resultLogPath('microbit-v2'), 'out/cmsis-developer-assistant/build-microbit-v2.log');
        assert.strictEqual(resultLogPath('../x y'), 'out/cmsis-developer-assistant/build-_x_y.log');
        assert.strictEqual(resultLogPath(undefined), 'out/cmsis-developer-assistant/build.log');
        assert.strictEqual(resultLogPath('diagnostic'), 'out/cmsis-developer-assistant/build-diagnostic_.log');
        assert.strictEqual(resultLogHeader('cbuild --active "" --schema', 0),
            '[cmsis-developer-assistant] Output of \'cbuild --active "" --schema\' as CMSIS Solution captured it; cbuild exit code 0.\n');
    });
});
