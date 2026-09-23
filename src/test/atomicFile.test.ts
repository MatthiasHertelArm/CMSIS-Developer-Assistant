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
import { isTempPath, tempPathFor, writeFileAtomic, writeFileAtomicSync } from '../utils/atomicFile';

/** Windows has no POSIX permission bits to look at. */
const POSIX = process.platform !== 'win32';

/**
 * The atomic writers: a reader sees the old file or the new one, never half
 * of one, and the `mode` option decides the new file's permissions (#19: the
 * window registry writes 0600).
 */
suite('Atomic file writes', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-atomic-'));
    });

    teardown(() => {
        fs.rmSync(dir, { force: true, recursive: true });
    });

    const inDir = (name: string): string => path.join(dir, name);
    const permissions = (file: string): number => fs.statSync(file).mode & 0o777;
    const leftovers = (): string[] => fs.readdirSync(dir).filter(isTempPath);

    test('a temp name is unique per call and recognised as one', () => {
        const first = tempPathFor(inDir('window-7.json'));
        const second = tempPathFor(inDir('window-7.json'));
        assert.notStrictEqual(first, second);
        assert.ok(isTempPath(path.basename(first)), first);
        assert.ok(!isTempPath('window-7.json'));
    });

    test('both writers replace the content whole', async () => {
        const file = inDir('config.json');
        writeFileAtomicSync(file, '{"a":1}');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}');
        await writeFileAtomic(file, '{"a":2} ✓');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":2} ✓');
        assert.deepStrictEqual(leftovers(), []);
    });

    test('the mode option applies to a new file and to one that replaces a wider file', async function () {
        if (!POSIX) {
            this.skip();
        }
        const synced = inDir('sync.json');
        writeFileAtomicSync(synced, '{}', { mode: 0o600 });
        assert.strictEqual(permissions(synced).toString(8), '600');

        const awaited = inDir('async.json');
        fs.writeFileSync(awaited, '{}', { mode: 0o644 });
        fs.chmodSync(awaited, 0o644);
        await writeFileAtomic(awaited, '{"b":1}', { mode: 0o600 });
        assert.strictEqual(permissions(awaited).toString(8), '600', 'the rename replaced the 0644 file');
        assert.strictEqual(fs.readFileSync(awaited, 'utf8'), '{"b":1}');
    });

    test('without a mode, a replaced file keeps its permission bits', async function () {
        if (!POSIX) {
            this.skip();
        }
        // An agent's configuration file the user narrowed to 0600 must not come back 0644.
        const narrowed = inDir('agent-config.json');
        fs.writeFileSync(narrowed, '{}');
        fs.chmodSync(narrowed, 0o600);
        writeFileAtomicSync(narrowed, '{"servers":1}');
        assert.strictEqual(permissions(narrowed).toString(8), '600');
        await writeFileAtomic(narrowed, '{"servers":2}');
        assert.strictEqual(permissions(narrowed).toString(8), '600');
        assert.strictEqual(fs.readFileSync(narrowed, 'utf8'), '{"servers":2}');

        // A new file gets the default, and an explicit mode still wins over the old bits.
        const fresh = inDir('fresh.json');
        await writeFileAtomic(fresh, '{}');
        assert.strictEqual(permissions(fresh) & 0o600, 0o600, 'readable and writable by its owner');
        writeFileAtomicSync(narrowed, '{}', { mode: 0o640 });
        assert.strictEqual(permissions(narrowed) & 0o640, 0o640);
        assert.deepStrictEqual(leftovers(), []);
    });

    test('a failed write leaves the old content and no temp file behind', async () => {
        const file = inDir('kept.json');
        fs.writeFileSync(file, 'old');
        // A directory where the file should go: the write succeeds, the rename cannot.
        const blocked = inDir('blocked');
        fs.mkdirSync(blocked);
        fs.writeFileSync(path.join(blocked, 'inside'), 'x');
        assert.throws(() => writeFileAtomicSync(blocked, 'new', { mode: 0o600 }));
        await assert.rejects(writeFileAtomic(blocked, 'new', { mode: 0o600 }));
        assert.deepStrictEqual(leftovers(), []);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old');

        // A folder that does not exist: the temp file is never created.
        const nowhere = path.join(dir, 'missing', 'file.json');
        assert.throws(() => writeFileAtomicSync(nowhere, 'x'), /ENOENT/);
        await assert.rejects(writeFileAtomic(nowhere, 'x'), /ENOENT/);
        assert.deepStrictEqual(leftovers(), []);
    });
});
