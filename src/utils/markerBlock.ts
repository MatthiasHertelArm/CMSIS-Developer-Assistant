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
 * Text this extension manages inside files that belong to someone else — a
 * skill, the agent guide, later an agent's rule file — fenced by a pair of
 * HTML comments that Markdown renderers do not show:
 *
 *     <!-- cmsis-developer-assistant:rules:begin -->
 *     …the managed text…
 *     <!-- cmsis-developer-assistant:rules:end -->
 *
 * The id in the middle ("rules") tells several blocks of one file apart. A
 * marker counts only as a line of its own, so a marker quoted inside a
 * sentence is never mistaken for one.
 *
 * The rules of the three operations: nothing outside a block changes, byte for
 * byte; the block takes the line ending the file already uses; running an
 * operation twice gives the same text as running it once. Pure: no I/O and no
 * vscode, so the generator script and the tests share it with the extension.
 */

/** The namespace of every marker this extension writes. */
export const MARKER_NAMESPACE = 'cmsis-developer-assistant';

/**
 * Where a block goes in a text that does not have it yet: the index of the
 * line it is inserted before, from 0 (the top) to the line count (the end).
 * A negative index means the anchor the placement looks for is missing.
 */
export type BlockPlacement = (lines: readonly string[]) => number;

/** One line of a text: where it starts, where its content ends, and where the next line starts. */
interface LineSpan {
    start: number;
    end: number;
    next: number;
    content: string;
}

/** The comment that opens block `id`. */
export function beginMarker(id: string): string {
    return `<!-- ${MARKER_NAMESPACE}:${id}:begin -->`;
}

/** The comment that closes block `id`. */
export function endMarker(id: string): string {
    return `<!-- ${MARKER_NAMESPACE}:${id}:end -->`;
}

/** At the end of the text: what a file that is only appended to wants. */
export const AT_END: BlockPlacement = (lines) => lines.length;

/** Directly below the first line that matches `pattern`. */
export function afterLine(pattern: RegExp): BlockPlacement {
    return (lines) => {
        const hit = lines.findIndex((line) => pattern.test(line));
        return hit < 0 ? -1 : hit + 1;
    };
}

/** Directly above the first line that matches `pattern`. */
export function beforeLine(pattern: RegExp): BlockPlacement {
    return (lines) => lines.findIndex((line) => pattern.test(line));
}

/** Directly below block `id`, which the text must already have. */
export function afterBlock(id: string): BlockPlacement {
    const closing = endMarker(id);
    return (lines) => {
        const hit = lines.findIndex((line) => line.trim() === closing);
        return hit < 0 ? -1 : hit + 1;
    };
}

/**
 * Block `id` as it is written into a file: the two markers with the body
 * between them, lines joined by `eol`, no line ending after the closing
 * marker.
 */
export function renderBlock(id: string, body: string, eol = '\n'): string {
    return [beginMarker(id), ...bodyLines(body), endMarker(id)].join(eol);
}

/**
 * The body of block `id` with `\n` line endings, as it was handed to
 * `upsertBlock`; undefined when the text (or the file, when `text` is
 * undefined) has no such block.
 */
export function extractBlock(text: string | undefined, id: string): string | undefined {
    if (text === undefined) {
        return undefined;
    }
    const lines = splitLines(text);
    const found = locateBlock(lines, id);
    if (found === undefined) {
        return undefined;
    }
    return lines.slice(found.begin + 1, found.end).map((line) => line.content).join('\n');
}

/**
 * The text with block `id` holding `body`. An existing block has the lines
 * between its markers replaced; otherwise a new block goes where `placement`
 * says (the end of the text by default), separated from its neighbours by one
 * blank line. `undefined` stands for a file that does not exist yet.
 */
export function upsertBlock(text: string | undefined, id: string, body: string, placement: BlockPlacement = AT_END): string {
    if (text === undefined || text.length === 0) {
        return `${renderBlock(id, body)}\n`;
    }
    const lines = splitLines(text);
    const found = locateBlock(lines, id);
    if (found !== undefined) {
        const opening = lines[found.begin];
        const eol = text.slice(opening.end, opening.next);
        const inner = bodyLines(body).map((line) => `${line}${eol}`).join('');
        return text.slice(0, opening.next) + inner + text.slice(lines[found.end].start);
    }
    const at = placement(lines.map((line) => line.content));
    if (at < 0 || at > lines.length) {
        throw new Error(`Block "${id}" has no place in this text: the line its placement looks for is missing`);
    }
    const eol = dominantEol(text);
    const offset = at < lines.length ? lines[at].start : text.length;
    // A text that ends without a line break gets one before a block appended to it.
    const unterminated = offset === text.length && !text.endsWith('\n') ? eol : '';
    const gapAbove = at > 0 && !isBlank(lines[at - 1]) ? eol : '';
    const gapBelow = at < lines.length && !isBlank(lines[at]) ? eol : '';
    const block = `${renderBlock(id, body, eol)}${eol}`;
    return text.slice(0, offset) + unterminated + gapAbove + block + gapBelow + text.slice(offset);
}

/**
 * The text without block `id`, markers included. One of the blank lines that
 * separated it from its neighbours goes with it, so no double gap is left
 * behind, and a block at the very end takes the gap above it along. A text
 * without the block comes back unchanged.
 */
export function removeBlock(text: string, id: string): string {
    const lines = splitLines(text);
    const found = locateBlock(lines, id);
    if (found === undefined) {
        return text;
    }
    let from = lines[found.begin].start;
    let to = lines[found.end].next;
    const above = found.begin > 0 ? lines[found.begin - 1] : undefined;
    const below = found.end + 1 < lines.length ? lines[found.end + 1] : undefined;
    if (below !== undefined && isBlank(below) && (above === undefined || isBlank(above))) {
        to = below.next;
    } else if (below === undefined && above !== undefined && isBlank(above)) {
        from = above.start;
    }
    return text.slice(0, from) + text.slice(to);
}

/** The lines of `body`, without the blank lines it may start or end with. */
function bodyLines(body: string): string[] {
    const lines = body.split(/\r?\n/);
    while (lines.length > 0 && lines[0].trim() === '') {
        lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }
    return lines;
}

/** Every line of `text` with its offsets; a final line break does not open another line. */
function splitLines(text: string): LineSpan[] {
    const lines: LineSpan[] = [];
    let start = 0;
    while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const next = newline < 0 ? text.length : newline + 1;
        const end = newline < 0 ? text.length : newline > start && text[newline - 1] === '\r' ? newline - 1 : newline;
        lines.push({ start, end, next, content: text.slice(start, end) });
        start = next;
    }
    return lines;
}

/** The line indexes of the markers of block `id`, or undefined when there is none; a broken pair is an error. */
function locateBlock(lines: readonly LineSpan[], id: string): { begin: number; end: number } | undefined {
    const opening = beginMarker(id);
    const closing = endMarker(id);
    const begins = indexesOf(lines, opening);
    const ends = indexesOf(lines, closing);
    if (begins.length === 0 && ends.length === 0) {
        return undefined;
    }
    if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
        throw new Error(`Block "${id}" is broken: expected one ${opening} followed by one ${closing}, `
            + `found ${begins.length} opening and ${ends.length} closing marker(s)`);
    }
    return { begin: begins[0], end: ends[0] };
}

function indexesOf(lines: readonly LineSpan[], marker: string): number[] {
    const hits: number[] = [];
    lines.forEach((line, index) => {
        if (line.content.trim() === marker) {
            hits.push(index);
        }
    });
    return hits;
}

function isBlank(line: LineSpan): boolean {
    return line.content.trim() === '';
}

/** CRLF when most line breaks of `text` are CRLF, LF otherwise. */
function dominantEol(text: string): string {
    const crlf = text.split('\r\n').length - 1;
    const lf = text.split('\n').length - 1 - crlf;
    return crlf > lf ? '\r\n' : '\n';
}
