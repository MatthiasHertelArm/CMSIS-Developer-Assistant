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
 * Tool calls named in a reply — "Next: read_doc_pages { doc: 'p/rm',
 * pages: '3' }", "fetch_doc { doc }", "Call list_target_docs" — turned into
 * links for the Pack Docs panel: a click loads the call into the panel's
 * runner, ready to run. Text only; no vscode.
 */

/** `&`, `<`, `>` and `"` escaped for an HTML text node or attribute. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);
}

/**
 * The inside of a call's braces — `doc: 'p/rm', pages: '519,523'`,
 * `query: "x", limit: 8`, `doc` — as an arguments object. A bare name (the
 * template form `{ query }`) becomes an empty string to fill in; a quoted
 * value keeps its commas and spaces; a bare number or boolean is typed.
 */
export function parseToolCallArgs(inner: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const re = /([A-Za-z_]\w*)(?:\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,}\s]+)))?/g;
    for (const m of inner.matchAll(re)) {
        const [, key, single, double, bare] = m;
        if (key === '__proto__') { continue; }
        if (single !== undefined) { args[key] = single.replace(/\\(.)/g, '$1'); }
        else if (double !== undefined) { args[key] = double.replace(/\\(.)/g, '$1'); }
        else if (bare !== undefined) {
            args[key] = /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : bare === 'true' ? true : bare === 'false' ? false : bare;
        } else { args[key] = ''; }
    }
    return args;
}

/**
 * The reply as HTML: escaped text in which every call of one of `tools`
 * is an `<a class="call" data-tool="…">`. A call with braces also carries
 * `data-args` (JSON); a bare name has none, and the panel loads the tool's
 * template for it.
 */
export function renderToolReplyHtml(text: string, tools: readonly string[]): string {
    if (!tools.length) { return escapeHtml(text); }
    const names = tools.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(?<![\\w./-])(${names})(?![\\w-])(\\s*\\{([^{}\\n]*)\\})?`, 'g');
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
        const at = m.index ?? 0;
        out += escapeHtml(text.slice(last, at));
        const args = m[2] !== undefined ? ` data-args="${escapeHtml(JSON.stringify(parseToolCallArgs(m[3])))}"` : '';
        out += `<a class="call" data-tool="${escapeHtml(m[1])}"${args} title="load this call into the runner">${escapeHtml(m[0])}</a>`;
        last = at + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
}
