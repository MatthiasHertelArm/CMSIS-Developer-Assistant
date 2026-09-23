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
import {
    AT_END,
    afterBlock,
    afterLine,
    beforeLine,
    beginMarker,
    endMarker,
    extractBlock,
    removeBlock,
    renderBlock,
    upsertBlock,
} from '../utils/markerBlock';

/**
 * The marker blocks are how the extension writes into files it does not own:
 * the bundled skills and the agent guide today, agents' rule files later. A
 * user's own text around a block must come through every operation byte for
 * byte, and repeating an operation must change nothing.
 */
suite('Marker blocks', () => {
    const BODY = '## Rules\n\n- One.\n- Two.';
    const block = (id = 'rules', body = BODY): string => renderBlock(id, body);

    test('the markers carry the namespace and the id, each on a line of its own', () => {
        assert.strictEqual(beginMarker('rules'), '<!-- cmsis-developer-assistant:rules:begin -->');
        assert.strictEqual(endMarker('rules'), '<!-- cmsis-developer-assistant:rules:end -->');
        assert.strictEqual(block(), `${beginMarker('rules')}\n## Rules\n\n- One.\n- Two.\n${endMarker('rules')}`);
        assert.strictEqual(renderBlock('rules', '\n\nx\n\n'), `${beginMarker('rules')}\nx\n${endMarker('rules')}`,
            'blank lines around the body are dropped');
    });

    test('a missing file and an empty file become the block alone', () => {
        assert.strictEqual(upsertBlock(undefined, 'rules', BODY), `${block()}\n`);
        assert.strictEqual(upsertBlock('', 'rules', BODY), `${block()}\n`);
        assert.strictEqual(extractBlock(undefined, 'rules'), undefined);
    });

    test('a file without the block gets it at the end, one blank line apart', () => {
        assert.strictEqual(upsertBlock('# Notes\n\nMine.\n', 'rules', BODY), `# Notes\n\nMine.\n\n${block()}\n`);
        assert.strictEqual(upsertBlock('Mine.', 'rules', BODY), `Mine.\n\n${block()}\n`, 'a last line without a break is ended first');
        assert.strictEqual(upsertBlock('Mine.\n\n', 'rules', BODY), `Mine.\n\n${block()}\n`, 'an existing gap is reused');
    });

    test('a placement puts a new block between lines, with a blank line on either side', () => {
        const text = '# Title\nIntro.\n\n## Next\n';
        assert.strictEqual(upsertBlock(text, 'rules', BODY, afterLine(/^# /)), `# Title\n\n${block()}\n\nIntro.\n\n## Next\n`);
        assert.strictEqual(upsertBlock(text, 'rules', BODY, beforeLine(/^## Next/)), `# Title\nIntro.\n\n${block()}\n\n## Next\n`);
        assert.strictEqual(upsertBlock(text, 'rules', BODY, AT_END), `${text}\n${block()}\n`);
    });

    test('a placement whose anchor is missing is an error, not a guess', () => {
        assert.throws(() => upsertBlock('text\n', 'rules', BODY, afterLine(/^# /)), /Block "rules" has no place/);
        assert.throws(() => upsertBlock('text\n', 'table', BODY, afterBlock('rules')), /Block "table" has no place/);
    });

    test('a second block can follow the first', () => {
        const once = upsertBlock('# T\n\nBody.\n', 'rules', BODY, afterLine(/^# /));
        const twice = upsertBlock(once, 'table', '| a |', afterBlock('rules'));
        assert.strictEqual(twice, `# T\n\n${block()}\n\n${block('table', '| a |')}\n\nBody.\n`);
        assert.strictEqual(extractBlock(twice, 'rules'), BODY);
        assert.strictEqual(extractBlock(twice, 'table'), '| a |');
    });

    test('an older block is replaced in place, and the text around it is kept byte for byte', () => {
        const before = 'Line one  \n\tindented\n\n' + block('rules', 'old text') + '\ntrailing, no gap\n\n\nend without newline';
        const after = upsertBlock(before, 'rules', BODY);
        assert.strictEqual(after, 'Line one  \n\tindented\n\n' + block() + '\ntrailing, no gap\n\n\nend without newline');
    });

    test('a second upsert with the same body is a no-op', () => {
        const once = upsertBlock('# T\n\nBody.\n', 'rules', BODY, afterLine(/^# /));
        assert.strictEqual(upsertBlock(once, 'rules', BODY, afterLine(/^# /)), once);
        assert.strictEqual(upsertBlock(once, 'rules', BODY), once, 'the placement only matters for a new block');
    });

    test('a CRLF file stays CRLF, inserted or replaced', () => {
        const crlf = '# Title\r\n\r\nMine.\r\n';
        const inserted = upsertBlock(crlf, 'rules', BODY, afterLine(/^# /));
        assert.strictEqual(inserted, `# Title\r\n\r\n${renderBlock('rules', BODY, '\r\n')}\r\n\r\nMine.\r\n`);
        assert.ok(!/[^\r]\n/.test(inserted), 'no bare LF');
        const replaced = upsertBlock(inserted, 'rules', 'new\nbody');
        assert.strictEqual(replaced, `# Title\r\n\r\n${renderBlock('rules', 'new\nbody', '\r\n')}\r\n\r\nMine.\r\n`);
        assert.strictEqual(extractBlock(replaced, 'rules'), 'new\nbody', 'the body comes back with LF line endings');
    });

    test('removing a block leaves no blank-line residue and nothing else changes', () => {
        const original = '# Notes\n\nMine.\n';
        assert.strictEqual(removeBlock(upsertBlock(original, 'rules', BODY), 'rules'), original);
        const middle = `A\n\n${block()}\n\nB\n`;
        assert.strictEqual(removeBlock(middle, 'rules'), 'A\n\nB\n');
        const tight = `A\n${block()}\nB\n`;
        assert.strictEqual(removeBlock(tight, 'rules'), 'A\nB\n');
        const first = `${block()}\n\nB\n`;
        assert.strictEqual(removeBlock(first, 'rules'), 'B\n');
        assert.strictEqual(removeBlock(`${block()}\n`, 'rules'), '');
        const crlf = `A\r\n\r\n${renderBlock('rules', BODY, '\r\n')}\r\n\r\nB\r\n`;
        assert.strictEqual(removeBlock(crlf, 'rules'), 'A\r\n\r\nB\r\n');
    });

    test('a text without the block is left alone by removal and extraction', () => {
        assert.strictEqual(removeBlock('A\n\nB\n', 'rules'), 'A\n\nB\n');
        assert.strictEqual(extractBlock('A\n', 'rules'), undefined);
        assert.strictEqual(extractBlock(`${block('table', 'x')}\n`, 'rules'), undefined, 'another id is another block');
    });

    test('a marker quoted inside a line is not a marker', () => {
        const quoted = `Write \`${beginMarker('rules')}\` above the rules.\n`;
        assert.strictEqual(extractBlock(quoted, 'rules'), undefined);
        assert.strictEqual(upsertBlock(quoted, 'rules', BODY), `${quoted}\n${block()}\n`);
    });

    test('a broken pair is an error for every operation', () => {
        const unclosed = `${beginMarker('rules')}\nbody\n`;
        const reversed = `${endMarker('rules')}\nbody\n${beginMarker('rules')}\n`;
        const doubled = `${block()}\n\n${block()}\n`;
        for (const broken of [unclosed, reversed, doubled]) {
            assert.throws(() => extractBlock(broken, 'rules'), /Block "rules" is broken/);
            assert.throws(() => upsertBlock(broken, 'rules', BODY), /Block "rules" is broken/);
            assert.throws(() => removeBlock(broken, 'rules'), /Block "rules" is broken/);
        }
    });
});
