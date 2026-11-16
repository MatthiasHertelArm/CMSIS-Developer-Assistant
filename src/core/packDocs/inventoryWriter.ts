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
 * The agent's request in CMSIS Solution's document inventory (2.9.2,
 * stage 2): when `fetch_doc` cannot get a document the CMSIS view lists,
 * the reason goes into that document's `error` field of `~/.cmsis/docs.yml`,
 * so the view shows its error badge with what to do, and the user sees which
 * document the agent waits for without reading the chat.
 *
 * Only `error` is written: CMSIS Solution shows it, and clears it itself
 * when the document gets a local copy (`path`). A `requested` field of its
 * own is not written, because whether CMSIS Solution keeps an unknown key
 * on its next save has not been confirmed. The file belongs to CMSIS
 * Solution and the user, so the edit is as small as it can be: the lines of
 * that one entry change, every other byte stays. The entry is found by
 * parsing (the parent's key and the document's `name` compared as parsed
 * scalars, so quoting does not matter); the new text is parsed again and
 * must equal the old one except for that one field, or nothing is written.
 * The file is read again just before the write and the edit dropped when
 * it changed meanwhile; the write is a temporary file renamed over it.
 *
 * Pure apart from the file named; no `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { load } from 'js-yaml';

/** The entry a document hangs off: a device or board key, or the `arm-docs` commons. */
export interface InventoryParent {
    tag: 'device' | 'board' | 'common';
    key: string;
}

/** What an edit did. */
export type InventoryEdit = { written: true } | { written: false; reason: string };

const LIST_KEYS: Record<InventoryParent['tag'], string> = { device: 'devices', board: 'boards', common: 'commons' };

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** A YAML scalar as written on a line, parsed; undefined when it is not one. */
function scalar(text: string): string | undefined {
    try {
        const value: unknown = load(text);
        return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
    } catch {
        return undefined;
    }
}

/** The end (exclusive) of the block that starts at `start`: the next non-blank line indented no deeper than `indent`. */
function blockEnd(lines: readonly string[], start: number, indent: number): number {
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim().length > 0 && indentOf(lines[i]) <= indent) {
            return i;
        }
    }
    return lines.length;
}

/** The document `name` under `parent` in parsed data, to compare the edit against. */
function parsedEntry(data: unknown, parent: InventoryParent, name: string): Record<string, unknown> | undefined {
    const docs = (data as { docs?: Record<string, unknown> } | undefined)?.docs;
    const parents = docs?.[LIST_KEYS[parent.tag]];
    if (!Array.isArray(parents)) {
        return undefined;
    }
    const owner = parents.find((item: unknown) => (item as Record<string, unknown> | null)?.[parent.tag] === parent.key) as Record<string, unknown> | undefined;
    const list = owner?.docs;
    if (!Array.isArray(list)) {
        return undefined;
    }
    return list.find((item: unknown) => (item as Record<string, unknown> | null)?.name === name) as Record<string, unknown> | undefined;
}

/**
 * `text` with the `error` of document `name` under `parent` set to `error`,
 * or removed when `error` is undefined; the reason when the entry is not
 * there or the text is not in the shape CMSIS Solution writes.
 */
export function withInventoryError(text: string, parent: InventoryParent, name: string, error: string | undefined): { text: string } | { reason: string } {
    const lines = text.split('\n');
    const parentLine = lines.findIndex((line) => {
        const match = new RegExp(`^\\s*- ${parent.tag}:\\s*(.+)$`).exec(line);
        return match !== null && scalar(match[1]) === parent.key;
    });
    if (parentLine < 0) {
        return { reason: `no ${parent.tag} ${parent.key} in the inventory` };
    }
    const parentEnd = blockEnd(lines, parentLine, indentOf(lines[parentLine]));
    let entryLine = -1;
    for (let i = parentLine + 1; i < parentEnd; i++) {
        const match = /^\s*- name:\s*(.+)$/.exec(lines[i]);
        if (match !== null && scalar(match[1]) === name) {
            entryLine = i;
            break;
        }
    }
    if (entryLine < 0) {
        return { reason: `no document ${name} under ${parent.key}` };
    }
    const dashIndent = indentOf(lines[entryLine]);
    const fieldIndent = dashIndent + 2;
    const entryEnd = blockEnd(lines, entryLine, dashIndent);
    const errorAt: number[] = [];
    for (let i = entryLine + 1; i < entryEnd; i++) {
        if (lines[i].trim().length > 0 && indentOf(lines[i]) === fieldIndent && /^\s*error:/.test(lines[i])) {
            errorAt.push(i);
        }
    }
    if (errorAt.length > 1 || (errorAt.length === 1 && errorAt[0] + 1 < entryEnd && lines[errorAt[0] + 1].trim().length > 0
        && indentOf(lines[errorAt[0] + 1]) > fieldIndent)) {
        return { reason: 'the entry\'s error field is not a one-line scalar' };
    }
    const next = [...lines];
    const field = error === undefined ? undefined : `${' '.repeat(fieldIndent)}error: ${JSON.stringify(error)}`;
    if (errorAt.length === 1) {
        if (field === undefined) {
            next.splice(errorAt[0], 1);
        } else {
            next[errorAt[0]] = field;
        }
    } else if (field !== undefined) {
        let at = entryEnd;
        while (at > entryLine + 1 && next[at - 1].trim().length === 0) {
            at--;
        }
        next.splice(at, 0, field);
    } else {
        return { text };
    }
    const edited = next.join('\n');
    // The edit must change that one field and nothing else.
    let before: unknown;
    let after: unknown;
    try {
        before = load(text);
        after = load(edited);
    } catch {
        return { reason: 'the edited inventory does not parse' };
    }
    const expected = structuredClone(before);
    const entry = parsedEntry(expected, parent, name);
    if (entry === undefined) {
        return { reason: 'the entry was not found where the text has it' };
    }
    if (error === undefined) {
        delete entry.error;
    } else {
        entry.error = error;
    }
    if (!isDeepStrictEqual(after, expected)) {
        return { reason: 'the edit would change more than the one field' };
    }
    return { text: edited };
}

/** The `error` the inventory holds for document `name` under `parent`; undefined when none or no such entry. */
export function inventoryErrorOf(file: string, parent: InventoryParent, name: string): string | undefined {
    try {
        const error = parsedEntry(load(fs.readFileSync(file, 'utf-8')), parent, name)?.error;
        return typeof error === 'string' ? error : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Set or clear the `error` of one document of the inventory at `file`.
 * With `onlyIf`, the field is changed only while it still holds that text
 * (clearing what this extension wrote, never what CMSIS Solution wrote).
 * Never throws.
 */
export function setInventoryError(file: string, parent: InventoryParent, name: string, error: string | undefined,
    onlyIf?: string): InventoryEdit {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf-8');
    } catch (caught) {
        return { written: false, reason: `cannot read ${file} (${String(caught)})` };
    }
    if (onlyIf !== undefined) {
        let current: unknown;
        try {
            current = parsedEntry(load(text), parent, name)?.error;
        } catch {
            return { written: false, reason: `${file} does not parse` };
        }
        if (current !== onlyIf) {
            return { written: false, reason: 'the error is no longer the one written' };
        }
    }
    const edit = withInventoryError(text, parent, name, error);
    if ('reason' in edit) {
        return { written: false, reason: edit.reason };
    }
    if (edit.text === text) {
        return { written: false, reason: 'nothing to change' };
    }
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.cda-${process.pid}.tmp`);
    try {
        // CMSIS Solution takes no lock of ours: the file is compared again right before it is replaced.
        if (fs.readFileSync(file, 'utf-8') !== text) {
            return { written: false, reason: 'the inventory changed meanwhile' };
        }
        fs.writeFileSync(temporary, edit.text, 'utf-8');
        fs.renameSync(temporary, file);
        return { written: true };
    } catch (caught) {
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            // Nothing left to clean.
        }
        return { written: false, reason: `cannot write ${file} (${String(caught)})` };
    }
}

/** How every `error` this extension writes begins: its mark of ownership, also after a window reload. */
export const REQUEST_PREFIX = 'Requested by the agent:';

/**
 * The text an agent's failed request leaves in the view: why the agent
 * could not get the document, and what the user does about it.
 */
export function requestErrorText(failure: string, url: string | undefined): string {
    let host = '';
    try {
        host = url ? new URL(url).hostname : '';
    } catch {
        host = '';
    }
    const loginWall = /\b(401|403)\b|not a pdf|text\/html|login|sign[- ]?in|forbidden|unauthori[sz]ed/i.test(failure);
    if (loginWall) {
        return `${REQUEST_PREFIX} login or manual download needed${host ? ` at ${host}` : ''}; download the file in a browser, then Import Document`;
    }
    const reason = failure.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${REQUEST_PREFIX} download failed (${reason}); Download Document retries`;
}
