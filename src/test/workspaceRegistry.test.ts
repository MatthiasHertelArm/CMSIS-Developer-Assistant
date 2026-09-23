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
import * as os from 'os';
import * as path from 'path';
import { WindowRegistration, WorkspaceRegistry, describeWindow } from '../utils/workspaceRegistry';

/** How far `backdate` moves a file's times: past the registry's one-minute limit. */
const BACKDATE_MS = 120_000;

suite('Workspace registry', () => {
    let dir: string;
    let port: number;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-registry-'));
        port = 40_000;
    });

    teardown(() => {
        fs.rmSync(dir, { force: true, recursive: true });
    });

    const inDir = (name: string): string => path.join(dir, name);
    const exists = (name: string): boolean => fs.existsSync(inDir(name));

    /** A registry for `pid` over the test directory, with the real liveness check. */
    const open = (pid: number = process.pid): WorkspaceRegistry => new WorkspaceRegistry(pid, dir);

    /** Register through the public API with a distinct port per call. */
    function publish(registry: WorkspaceRegistry, overrides: Partial<WindowRegistration> = {}): void {
        registry.register({
            controlPort: port++,
            controlToken: 'test-token',
            workspaceFolders: [],
            name: 'test-window',
            ...overrides,
        });
    }

    /** Write `window-<label>.json` by hand, as a peer of another version might. */
    function plant(label: string, overrides: Partial<WindowRegistration> = {}): WindowRegistration {
        const stamp = Date.now();
        const entry: WindowRegistration = {
            pid: process.pid,
            controlPort: port++,
            controlToken: `token-${label}`,
            workspaceFolders: [],
            name: label,
            updatedAt: stamp,
            ...overrides,
        };
        fs.writeFileSync(inDir(`window-${label}.json`), JSON.stringify(entry));
        return entry;
    }

    function backdate(name: string): void {
        const then = new Date(Date.now() - BACKDATE_MS);
        fs.utimesSync(inDir(name), then, then);
    }

    suite('registration and pruning', () => {

        test('a registered window is listed with its pid and folders', () => {
            const registry = open();
            publish(registry, { workspaceFolders: ['/proj/blinky'] });
            const windows = registry.list();
            assert.strictEqual(windows.length, 1);
            assert.strictEqual(windows[0].pid, process.pid);
            assert.deepStrictEqual(windows[0].workspaceFolders, ['/proj/blinky']);
        });

        test('unregister withdraws the window', () => {
            const registry = open();
            publish(registry);
            registry.unregister();
            assert.deepStrictEqual(registry.list(), []);
        });

        test('the entry of a process that is gone is pruned by the next reader', () => {
            publish(open(999_999));
            const reader = open();
            publish(reader);
            assert.deepStrictEqual(reader.list().map((w) => w.pid), [process.pid]);
            assert.ok(!exists('window-999999.json'), 'the dead window\'s file is removed');
        });

        test('a fresh unparsable file is skipped but left alone: a peer may still be writing it', () => {
            fs.writeFileSync(inDir('window-123.json'), '{"pid": 1');
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(exists('window-123.json'));
        });

        test('an unparsable file older than a minute is removed', () => {
            fs.writeFileSync(inDir('window-123.json'), 'not json at all');
            backdate('window-123.json');
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(!exists('window-123.json'));
        });

        test('writes leave no temp file, and a heartbeat restores a deleted entry', () => {
            const registry = open();
            publish(registry);
            assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
            const firstStamp = registry.list()[0].updatedAt;

            fs.unlinkSync(inDir(`window-${process.pid}.json`));
            registry.heartbeat();
            const healed = registry.list();
            assert.strictEqual(healed.length, 1);
            assert.ok(healed[0].updatedAt >= firstStamp);

            const neverRegistered = open(process.pid + 1);
            neverRegistered.heartbeat();
            assert.ok(!exists(`window-${process.pid + 1}.json`), 'nothing to refresh, nothing written');
        });

        test('a crashed writer\'s temp file is never listed and goes once it is old', () => {
            const stale = 'window-77.json.77.deadbeef.tmp';
            const fresh = 'window-78.json.78.cafebabe.tmp';
            fs.writeFileSync(inDir(stale), '{}');
            fs.writeFileSync(inDir(fresh), '{}');
            backdate(stale);
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.list().length, 1);
            assert.ok(!exists(stale), 'abandoned temp file removed');
            assert.ok(exists(fresh), 'recent temp file kept');
        });
    });

    suite('findByPath', () => {

        test('a path inside a window\'s folder finds that window', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath(inDir('blinky/src/main.c'))?.pid, process.pid);
        });

        test('the deepest containing folder wins', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('work')] });
            plant('nested', { workspaceFolders: [inDir('work/blinky')] });
            assert.strictEqual(registry.findByPath(inDir('work/blinky/main.c'))?.name, 'nested');
        });

        test('a sibling that merely shares the prefix is not inside the folder', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath(inDir('blinky-old/main.c')), undefined);
        });

        test('a path outside every folder finds nothing', () => {
            const registry = open();
            publish(registry, { workspaceFolders: [inDir('blinky')] });
            assert.strictEqual(registry.findByPath('/somewhere/else/main.c'), undefined);
        });

        test('the only window, when it has no folder open, takes any path', () => {
            const registry = open();
            publish(registry);
            assert.strictEqual(registry.findByPath('/anything.c')?.pid, process.pid);
        });
    });

    suite('routing helpers', () => {

        test('the one window with a debug session is found', () => {
            const registry = open();
            plant('idle', { hasActiveSession: false });
            plant('busy', { hasActiveSession: true });
            assert.strictEqual(registry.findSoleActiveSession()?.name, 'busy');
        });

        test('two debug sessions: no guess', () => {
            const registry = open();
            plant('first', { hasActiveSession: true });
            plant('second', { hasActiveSession: true });
            assert.strictEqual(registry.findSoleActiveSession(), undefined);
        });

        test('no debug session: nothing found', () => {
            const registry = open();
            plant('quiet', { hasActiveSession: false });
            assert.strictEqual(registry.findSoleActiveSession(), undefined);
        });

        test('findSoleWindow answers only while exactly one window is registered', () => {
            const registry = open();
            plant('only');
            assert.strictEqual(registry.findSoleWindow()?.name, 'only');
            plant('another');
            assert.strictEqual(registry.findSoleWindow(), undefined);
        });

        test('isLive follows the control port of the same pid', () => {
            const registry = open();
            const original = plant('w', { controlPort: 42_008 });
            assert.strictEqual(registry.isLive(original), true);
            plant('w', { controlPort: 49_999 });
            assert.strictEqual(registry.isLive(original), false);
        });
    });

    suite('describeWindow', () => {

        const base: WindowRegistration = {
            pid: 4242,
            controlPort: 1,
            controlToken: 'never-shown',
            workspaceFolders: ['/proj/blinky'],
            name: 'blinky',
            updatedAt: 0,
        };

        test('names the pid and the folders', () => {
            const line = describeWindow(base);
            assert.match(line, /pid=4242/);
            assert.match(line, /\/proj\/blinky/);
        });

        test('says so when no folder is open', () => {
            assert.match(describeWindow({ ...base, workspaceFolders: [] }), /no folder open/);
        });

        test('shows the active debug configuration', () => {
            const line = describeWindow({ ...base, hasActiveSession: true, activeConfigurationName: 'AppKit-E8 Debug' });
            assert.match(line, /debugging: AppKit-E8 Debug/);
        });

        test('shows the CMSIS solution', () => {
            const line = describeWindow({ ...base, cmsisProject: '/proj/blinky/blinky.csolution.yml' });
            assert.match(line, /cmsis=\/proj\/blinky\/blinky\.csolution\.yml/);
        });
    });
});
