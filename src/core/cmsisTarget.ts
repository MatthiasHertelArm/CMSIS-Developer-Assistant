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
 * Pure helpers behind the `target` input of `cmsis_action`: parsing a
 * `type` / `type@set` reference, matching it against what the CMSIS Solution
 * extension reports as active (`cmsis-csolution.getActiveTargetSet`, same
 * format), listing the target-types a csolution declares, and editing the
 * extension's `.vscode/cmsis.json` selection so a re-activated solution comes
 * up on the requested target.
 *
 * The cmsis.json layout mirrors what the CMSIS Solution extension (1.72.0,
 * `CmsisSettingsJsonFile`) reads and writes itself:
 *
 *   { "targetSet": { "<solutionDisplayName>": {
 *         "activeTargetType": "<type>",
 *         "<type>": <index into that type's target-set list>   // optional
 *   } } }
 *
 * in the `.vscode/cmsis.json` of the workspace's first folder, whichever
 * folder holds the solution. `<solutionDisplayName>` is the csolution path
 * relative to that folder with both extensions stripped, forward slashes.
 * The extension looks the key up as a dotted path, split at every `.`, so
 * a name with dots nests: `../fw/app`, the name of a solution in a second
 * folder, is `targetSet` → `""` → `""` → `"/fw/app"`.
 *
 * No `vscode` import here so the logic is unit-testable outside the host.
 */

import * as path from 'path';
import { applyEdits, modify } from 'jsonc-parser';

/** A target reference as the agent passes it: `MPS3` or `HP@debug`. */
export interface TargetRef {
    type: string;
    /** Named target-set; undefined = any set of the type, '' = the unnamed set. */
    set?: string;
}

/** One `target-types:` entry of a csolution and the names of its target-sets ('' = unnamed). */
export interface TargetTypeInfo {
    name: string;
    sets: string[];
}

/** Parse `type` or `type@set`; undefined for an empty/invalid reference. */
export function parseTargetRef(text: string | undefined): TargetRef | undefined {
    const trimmed = (text ?? '').trim();
    if (!trimmed) { return undefined; }
    const at = trimmed.indexOf('@');
    if (at < 0) { return { type: trimmed }; }
    const type = trimmed.slice(0, at).trim();
    if (!type) { return undefined; }
    return { type, set: trimmed.slice(at + 1).trim() };
}

/** Split an active-target name (`type` or `type@set`) into its parts. */
export function splitActiveTarget(active: string | undefined): TargetRef | undefined {
    const parsed = parseTargetRef(active);
    if (!parsed) { return undefined; }
    return { type: parsed.type, set: parsed.set ?? '' };
}

/** Render a reference the way the extension names it: `type` for the unnamed set, else `type@set`. */
export function formatTargetName(type: string, set: string | undefined): string {
    return set ? `${type}@${set}` : type;
}

/**
 * Does the active target satisfy the request? A type-only request accepts
 * any set of that type; `type@set` must match exactly (`type@` = unnamed).
 */
export function targetMatches(active: string | undefined, wanted: TargetRef): boolean {
    const current = splitActiveTarget(active);
    if (!current) { return false; }
    if (current.type !== wanted.type) { return false; }
    return wanted.set === undefined || wanted.set === current.set;
}

/** A node of the csolution's block structure that the following lines may still belong to. */
interface OpenNode {
    /** Column of the key, or of the entry's `-`. */
    column: number;
    /** The mapping key; undefined for a sequence entry. */
    key?: string;
    /** On an entry of `solution: target-types:`, the target-type it declares. */
    targetType?: TargetTypeInfo;
    /** On an entry of that target-type's `target-set:`, its index in the type's sets. */
    setIndex?: number;
}

/**
 * The target-types a csolution declares and the names of their target-sets,
 * in file order. The YAML is read line by line (the repo carries no YAML
 * parser), following its block structure by column: the keys of a list entry
 * may come in any order, and a list may stand in its key's own column
 * (`target-types:` above `- type:`, as in NXP's examples). A target-type is an
 * entry of `solution: target-types:` with a `type:`; the `type:` keys of
 * deeper lists (`images:`, a debugger's `reset:`) are not. Every entry of its
 * `target-set:` counts as a set, named by its `set:` ('' when empty or
 * missing), as in the list the CMSIS Solution extension's cmsis.json index
 * points into. Comments, quotes, CRLF and a byte-order mark are read; flow
 * collections (`[...]`, `{...}`), anchors, aliases, merge keys and tags are
 * not: `scanTargetTypes` says where they stand in the target-types.
 */
export function listTargetTypes(csolutionText: string): TargetTypeInfo[] {
    return scanTargetTypes(csolutionText).declared;
}

/** What `scanTargetTypes` found: the target-types it read, and the first line of them it could not. */
export interface TargetTypesScan {
    declared: TargetTypeInfo[];
    /** A line of `solution: target-types:` in YAML this reader does not follow; the target-types read may then be wrong (K02). */
    unread?: { line: number; text: string };
}

/** A value that starts a flow collection, an anchor, an alias or a tag. */
const UNREAD_VALUE = /^[[{&*!]/;

/**
 * `listTargetTypes`, and the first line of the target-types written in a
 * form it does not read: a flow collection, an anchor, an alias, a merge key
 * (`<<:`) or a tag where a target-type, its `type:`, its `target-set:` or a
 * set's `set:` would be. Valid YAML, so a target-type it holds would be
 * missed or misnamed without a word; the caller refuses instead.
 */
export function scanTargetTypes(csolutionText: string): TargetTypesScan {
    const declared: TargetTypeInfo[] = [];
    const open: OpenNode[] = [];
    let unread: TargetTypesScan['unread'];
    /** Are the open nodes exactly these keys, `undefined` standing for a sequence entry? */
    const openPathIs = (...keys: (string | undefined)[]): boolean =>
        open.length === keys.length && keys.every((key, depth) => open[depth].key === key);
    /** Is the innermost open node an entry of the target-types, or of a target-type's `target-set:`? */
    const atTargetType = (): boolean => openPathIs('solution', 'target-types', undefined);
    const atSet = (): boolean => openPathIs('solution', 'target-types', undefined, 'target-set', undefined);

    const lines = csolutionText.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    for (const [index, raw] of lines.entries()) {
        const line = yamlLine(raw);
        if (!line) {
            continue;
        }
        const note = (): void => {
            unread ??= { line: index + 1, text: raw.trim() };
        };
        for (const column of line.entries) {
            // An entry ends the deeper nodes and the previous entry of its list; a key in
            // the same column stays open: its list is written without indentation.
            closeWhile(open, (node) => node.column > column || (node.column === column && node.key === undefined));
            const entry: OpenNode = { column };
            if (openPathIs('solution', 'target-types')) {
                entry.targetType = { name: '', sets: [] };
                declared.push(entry.targetType);
            } else if (openPathIs('solution', 'target-types', undefined, 'target-set') && open[2].targetType) {
                entry.setIndex = open[2].targetType.sets.push('') - 1;
            }
            open.push(entry);
        }
        if (line.key === undefined) {
            // A target-type or a set that is no block mapping: `- { type: … }`, `- *base`, `- &a`.
            const written = raw.slice(line.column).trim();
            if ((atTargetType() || atSet()) && written !== '' && !written.startsWith('#')) {
                note();
            }
            continue;
        }
        // A key ends its earlier siblings and everything deeper.
        closeWhile(open, (node) => node.column >= line.column);
        const targetType = open[2]?.targetType;
        const setIndex = open[4]?.setIndex;
        const unreadValue = UNREAD_VALUE.test(line.rest);
        if ((line.key === 'target-types' && openPathIs('solution') && unreadValue)
            || ((atTargetType() || atSet()) && line.key === '<<')
            || (atTargetType() && (line.key === 'type' || line.key === 'target-set') && unreadValue)
            || (atSet() && line.key === 'set' && unreadValue)) {
            note();
        }
        if (targetType && line.key === 'type' && atTargetType()) {
            targetType.name = line.value;
        } else if (targetType && setIndex !== undefined && line.key === 'set' && atSet()) {
            targetType.sets[setIndex] = line.value;
        }
        open.push({ column: line.column, key: line.key });
    }
    return { declared: declared.filter((type) => type.name !== ''), unread };
}

/** The choices to offer when a request does not resolve: `MPS3, HE@debug, HE@release`. */
export function formatTargetChoices(types: TargetTypeInfo[]): string {
    const names: string[] = [];
    for (const t of types) {
        if (t.sets.length === 0) { names.push(t.name); continue; }
        for (const s of t.sets) { names.push(formatTargetName(t.name, s)); }
    }
    return names.join(', ');
}

export type TargetResolution =
    | { ok: true; type: string; set: string | undefined; setIndex: number | undefined; name: string }
    | { ok: false; reason: string };

/**
 * Resolve a request against the declared target-types. A type-only request
 * leaves the set selection alone (the extension keeps its last choice); a
 * named set becomes the index the extension stores.
 */
export function resolveTargetSelection(types: TargetTypeInfo[], wanted: TargetRef): TargetResolution {
    const type = types.find((t) => t.name === wanted.type);
    if (!type) {
        return { ok: false, reason: `target-type '${wanted.type}' is not declared in the csolution` };
    }
    if (wanted.set === undefined) {
        return { ok: true, type: type.name, set: undefined, setIndex: undefined, name: type.name };
    }
    const index = type.sets.indexOf(wanted.set);
    if (index < 0) {
        const sets = type.sets.map((s) => s || '(unnamed)').join(', ') || '(none)';
        return { ok: false, reason: `target-type '${type.name}' has no target-set '${wanted.set || '(unnamed)'}' — its sets: ${sets}` };
    }
    return { ok: true, type: type.name, set: wanted.set, setIndex: index, name: formatTargetName(type.name, wanted.set) };
}

/** The key the extension files a solution under in cmsis.json; `workspaceFolder` is the workspace's first folder. */
export function solutionDisplayName(workspaceFolder: string, solutionPath: string): string {
    const relative = path.relative(workspaceFolder, solutionPath);
    const stripped = relative.replace(/\.[^./\\]+$/, '').replace(/\.[^./\\]+$/, '');
    return stripped.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * Return cmsis.json text with the solution's active target-type set (and the
 * set index when one was named), under the key path the extension reads:
 * `displayName` split at every `.`. Existing content — other solutions, other
 * keys, comments — is preserved; formatting follows the extension (4 spaces).
 */
export function applyTargetSelection(
    cmsisJsonText: string,
    displayName: string,
    type: string,
    setIndex: number | undefined,
): string {
    const formattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };
    const selection = ['targetSet', ...displayName.split('.')];
    let text = cmsisJsonText.trim() ? cmsisJsonText : '{}';
    text = applyEdits(text, modify(text, [...selection, 'activeTargetType'], type, { formattingOptions }));
    if (setIndex !== undefined) {
        text = applyEdits(text, modify(text, [...selection, type], setIndex, { formattingOptions }));
    }
    return text.endsWith('\n') ? text : `${text}\n`;
}

/** Close the innermost open nodes as long as `ends` says the current line ends them. */
function closeWhile(open: OpenNode[], ends: (node: OpenNode) => boolean): void {
    for (let node = open.at(-1); node && ends(node); node = open.at(-1)) {
        open.pop();
    }
}

/** The structure of one line of block YAML. */
interface YamlLine {
    /** Columns of the `- ` sequence entries the line opens, outermost first (`- - x` opens two). */
    entries: number[];
    /** The mapping key that follows the entries, if the line holds one. */
    key?: string;
    /** Column of that key. */
    column: number;
    /** The scalar after the key's colon, unquoted and without its comment; '' for none and for null. */
    value: string;
    /** What follows the key's colon as written, trimmed. */
    rest: string;
}

/** A YAML indicator, which a plain mapping key cannot start with: comment, quote, flow, anchor, alias, tag, block scalar, reserved. */
const INDICATOR_FIRST = /^[#'"{}[\],&*!|>%@`]/;

/**
 * The entries and the key of one line; undefined for a line that opens
 * neither (blank, a comment, a document marker, a scalar that continues the
 * line before, a flow collection).
 */
function yamlLine(raw: string): YamlLine | undefined {
    const entries: number[] = [];
    let column = raw.length - raw.trimStart().length;
    while (raw.charAt(column) === '-' && [' ', '\t', ''].includes(raw.charAt(column + 1))) {
        entries.push(column);
        column++;
        while (raw.charAt(column) === ' ' || raw.charAt(column) === '\t') {
            column++;
        }
    }
    const entry = mappingEntry(raw.slice(column).trimEnd());
    if (!entry) {
        return entries.length > 0 ? { entries, column, value: '', rest: '' } : undefined;
    }
    return { entries, key: entry.key, column, value: scalarValue(entry.rest), rest: entry.rest };
}

/** The key of a `key: value` text and what follows its colon; undefined when the text is no mapping entry. */
function mappingEntry(text: string): { key: string; rest: string } | undefined {
    const quoted = readQuoted(text);
    if (quoted) {
        const colon = /^\s*:(?=\s|$)/.exec(text.slice(quoted.end));
        return colon ? { key: quoted.value, rest: text.slice(quoted.end + colon[0].length).trim() } : undefined;
    }
    // A plain key ends at the first `:` followed by a blank; text with ` #` before it is a scalar and a comment.
    const colon = text.search(/:(?=\s|$)/);
    const key = text.slice(0, Math.max(colon, 0)).trimEnd();
    if (key === '' || INDICATOR_FIRST.test(key) || /\s#/.test(key)) {
        return undefined;
    }
    return { key, rest: text.slice(colon + 1).trim() };
}

/** A scalar as written after a key's colon: unquoted, its comment removed; '' for none and for YAML's null. */
function scalarValue(text: string): string {
    const quoted = readQuoted(text);
    if (quoted) {
        return quoted.value;
    }
    const plain = text.replace(/(?:^|\s)#.*$/, '').trim();
    return /^(?:~|null|Null|NULL)$/.test(plain) ? '' : plain;
}

/** The quoted scalar `text` starts with, and its length; undefined unless one starts and ends there. */
function readQuoted(text: string): { value: string; end: number } | undefined {
    const single = /^'((?:[^']|'')*)'/.exec(text);
    if (single) {
        return { value: single[1].replace(/''/g, '\''), end: single[0].length };
    }
    const double = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!double) {
        return undefined;
    }
    try {
        // JSON's escapes are a subset of YAML's; any other escape keeps the escaped character.
        return { value: String(JSON.parse(double[0])), end: double[0].length };
    } catch {
        return { value: double[1].replace(/\\(.)/g, '$1'), end: double[0].length };
    }
}
