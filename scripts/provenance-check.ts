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

/**
 * Provenance check against microsoft/DebugMCP (issue #53).
 *
 * For every tracked file that has a counterpart in DebugMCP at the last synced
 * commit, counts the non-trivial lines of ours that also appear, in order, in
 * theirs (longest common subsequence over trimmed lines).
 *
 *   npm run provenance:check                 table of every file with overlap
 *   npm run provenance:check -- --gate       also fail when a file without the
 *                                            Microsoft header still shares more
 *                                            than GATE_MAX_SHARED lines
 *   npm run provenance:check -- --lines F    print the shared lines of file F
 *
 * Needs network on first use: DebugMCP is cloned once into a cache directory.
 * Not part of CI for that reason; it is the acceptance tool for rewrite PRs.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UPSTREAM_URL = 'https://github.com/microsoft/DebugMCP.git';
/** v2.3.1, the last upstream state this project took changes from. */
const UPSTREAM_SHA = '148cbb9a';
// Assembled so that this file does not itself carry the line it looks for.
const MS_LINE = ['Copyright (c)', 'Microsoft', 'Corporation'].join(' ');
/** Shared non-trivial lines tolerated in a file that no longer carries the Microsoft line. */
const GATE_MAX_SHARED = 3;
/** Files whose counterpart upstream lives under another name. */
const RENAMED: Record<string, string> = {
    'scripts/test-skill-trigger.ts': 'scripts/test-debug-skill-trigger.js',
    'skills/cmsis-debug-live/SKILL.md': 'skills/debug-live/SKILL.md',
};
/** Directories whose files map by base name onto an upstream directory. */
const RENAMED_DIRS: Array<[string, string]> = [
    ['docs/agent-resources/troubleshooting/', 'skills/debug-live/references/troubleshooting/'],
    ['skills/cmsis-debug-live/references/troubleshooting/', 'skills/debug-live/references/troubleshooting/'],
];
/** Lines too generic to say anything about where a file came from. */
const BOILERPLATE = new Set([
    "import * as vscode from 'vscode';",
    "import * as path from 'path';",
    "import * as fs from 'fs';",
    "import * as os from 'os';",
    "import * as http from 'http';",
    "import * as assert from 'assert';",
    "'use strict';",
    'export {};',
    '} catch (error) {',
    '} catch (err) {',
    '} finally {',
    '} else {',
    'return undefined;',
    'return false;',
    'return true;',
    'return result;',
]);

interface FileReport {
    file: string;
    upstream: string;
    lines: number;
    shared: number;
    hasMsLine: boolean;
    sharedLines: string[];
}

function repoRoot(): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function upstreamCheckout(): string {
    const dir = path.join(os.tmpdir(), `cda-provenance-debugmcp-${UPSTREAM_SHA}`);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync('git', ['clone', '--quiet', UPSTREAM_URL, dir], { stdio: 'inherit' });
    }
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', UPSTREAM_SHA], { stdio: 'inherit' });
    return dir;
}

function isTrivial(line: string): boolean {
    if (line.length < 12) { return true; }
    if (BOILERPLATE.has(line)) { return true; }
    return /^[\s{}()[\];,.:*/\\-]*$/.test(line);
}

function significantLines(file: string): string[] {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => !isTrivial(l));
}

/** Lines of `a` that are part of a longest common subsequence with `b`. */
function sharedInOrder(a: string[], b: string[]): string[] {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * cols + j] = a[i] === b[j]
                ? table[(i + 1) * cols + j + 1] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
        }
    }
    const out: string[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
        else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { i++; }
        else { j++; }
    }
    return out;
}

function counterpart(file: string, upstream: string): string | undefined {
    const candidates = [RENAMED[file], file];
    for (const [ours, theirs] of RENAMED_DIRS) {
        if (file.startsWith(ours)) { candidates.push(theirs + file.slice(ours.length)); }
    }
    return candidates.find((c) => c !== undefined && fs.existsSync(path.join(upstream, c)));
}

function main(): void {
    const args = process.argv.slice(2);
    const gate = args.includes('--gate');
    const linesOf = args.includes('--lines') ? args[args.indexOf('--lines') + 1] : undefined;
    const root = repoRoot();
    const upstream = upstreamCheckout();
    const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);

    const reports: FileReport[] = [];
    for (const file of tracked) {
        if (file.startsWith('skills/cmsis-skills/') || file.endsWith('package-lock.json')) { continue; }
        const theirs = counterpart(file, upstream);
        if (!theirs) { continue; }
        const ours = significantLines(path.join(root, file));
        const shared = sharedInOrder(ours, significantLines(path.join(upstream, theirs)));
        if (shared.length === 0 && !linesOf) { continue; }
        reports.push({
            file, upstream: theirs, lines: ours.length, shared: shared.length, sharedLines: shared,
            hasMsLine: fs.readFileSync(path.join(root, file), 'utf8').includes(MS_LINE),
        });
    }

    if (linesOf) {
        const report = reports.find((r) => r.file === linesOf);
        if (!report) { console.log(`${linesOf}: no DebugMCP counterpart or no shared lines`); return; }
        console.log(`${report.file} ↔ DebugMCP ${report.upstream}: ${report.shared} shared line(s)`);
        for (const line of report.sharedLines) { console.log(`  ${line}`); }
        return;
    }

    reports.sort((x, y) => y.shared / Math.max(y.lines, 1) - x.shared / Math.max(x.lines, 1));
    console.log(`DebugMCP ${UPSTREAM_SHA}: shared non-trivial lines per file (in order, trimmed)\n`);
    console.log(`${'file'.padEnd(58)} ${'lines'.padStart(6)} ${'shared'.padStart(7)} ${'%'.padStart(6)}  MS line`);
    let totalLines = 0;
    let totalShared = 0;
    for (const r of reports) {
        totalLines += r.lines;
        totalShared += r.shared;
        const pct = (100 * r.shared / Math.max(r.lines, 1)).toFixed(1);
        console.log(`${r.file.padEnd(58)} ${String(r.lines).padStart(6)} ${String(r.shared).padStart(7)} ${pct.padStart(6)}  ${r.hasMsLine ? 'yes' : '-'}`);
    }
    console.log(`\n${reports.length} file(s), ${totalShared} of ${totalLines} non-trivial lines shared`);

    if (gate) {
        const offenders = reports.filter((r) => !r.hasMsLine && r.shared > GATE_MAX_SHARED && /\.(ts|js|mjs)$/.test(r.file));
        if (offenders.length > 0) {
            console.log(`\nGATE FAILED: ${offenders.length} source file(s) without the Microsoft line share more than ${GATE_MAX_SHARED} lines:`);
            for (const r of offenders) { console.log(`  ${r.file} (${r.shared}) — see --lines ${r.file}`); }
            process.exit(1);
        }
        console.log(`\ngate passed: every source file without the Microsoft line shares at most ${GATE_MAX_SHARED} lines`);
    }
}

main();
