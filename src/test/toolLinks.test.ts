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
import { parseToolCallArgs, renderToolReplyHtml } from '../core/packDocs/toolLinks';

const TOOLS = ['list_target_docs', 'search_target_docs', 'read_doc_pages', 'fetch_doc', 'get_peripheral_docs'];

suite('Pack Docs panel: tool calls in a reply become links', () => {
    test('the arguments of a call parse as the agent would write them', () => {
        assert.deepStrictEqual(parseToolCallArgs("doc: 'p/rm', pages: '519,523'"), { doc: 'p/rm', pages: '519,523' });
        assert.deepStrictEqual(parseToolCallArgs('query: "GPIOA clock enable", limit: 8, verbose: true'), { query: 'GPIOA clock enable', limit: 8, verbose: true });
        assert.deepStrictEqual(parseToolCallArgs(' query '), { query: '' }, 'a bare name is a blank to fill in');
        assert.deepStrictEqual(parseToolCallArgs('doc, pages'), { doc: '', pages: '' });
        assert.deepStrictEqual(parseToolCallArgs("query: '<register> <bit>'"), { query: '<register> <bit>' });
        assert.deepStrictEqual(parseToolCallArgs("doc: 'it\\'s'"), { doc: "it's" });
        assert.deepStrictEqual(parseToolCallArgs(''), {});
    });

    test('a call with braces links with its arguments; a bare name links without', () => {
        const html = renderToolReplyHtml("Next: read_doc_pages { doc: 'p/rm', pages: '3' } for the full page. Call list_target_docs for the ids.", TOOLS);
        assert.strictEqual(html,
            'Next: <a class="call" data-tool="read_doc_pages" data-args="{&quot;doc&quot;:&quot;p/rm&quot;,&quot;pages&quot;:&quot;3&quot;}" title="load this call into the runner">' +
            "read_doc_pages { doc: 'p/rm', pages: '3' }</a> for the full page. Call " +
            '<a class="call" data-tool="list_target_docs" title="load this call into the runner">list_target_docs</a> for the ids.');
    });

    test('text around the calls is escaped, and names inside words, ids or paths are left alone', () => {
        const html = renderToolReplyHtml('<b> & "q" — see docs/fetch_doc.md, my_fetch_doc, fetch_doc-2; fetch_doc { doc }', TOOLS);
        assert.strictEqual(html,
            '&lt;b&gt; &amp; &quot;q&quot; — see docs/fetch_doc.md, my_fetch_doc, fetch_doc-2; ' +
            '<a class="call" data-tool="fetch_doc" data-args="{&quot;doc&quot;:&quot;&quot;}" title="load this call into the runner">fetch_doc { doc }</a>');
    });

    test('without tools the reply is only escaped; braces that span lines are not a call', () => {
        assert.strictEqual(renderToolReplyHtml('a < b & fetch_doc { doc }', []), 'a &lt; b &amp; fetch_doc { doc }');
        const html = renderToolReplyHtml("fetch_doc {\n doc: 'x' }", TOOLS);
        assert.strictEqual(html, '<a class="call" data-tool="fetch_doc" title="load this call into the runner">fetch_doc</a> {\n doc: \'x\' }');
    });
});
