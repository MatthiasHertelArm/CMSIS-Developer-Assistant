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
 * extension reports as active (`getActiveTargetSet`, same format), listing
 * the target-types a csolution declares, and naming the solution a folder
 * opens with in its `.vscode/cmsis.json`.
 *
 * The target itself is switched through CMSIS Solution's API
 * (`setActiveTarget`), never by editing cmsis.json. The one thing written
 * there is `activeSolution`, for a folder that is about to open: no
 * extension runs in that window yet that could be asked (#145).
 *
 * No `vscode` import here so the logic is unit-testable outside the host.
 */

import * as path from 'path';
import { CORE_SCHEMA, load, mergeTag, realMapTag } from 'js-yaml';
import { applyEdits, modify } from 'jsonc-parser';

const MAX_CSOLUTION_BYTES = 1024 * 1024;
const MAX_TARGET_NAMES = 10000;
const MAX_TARGET_NAME_LENGTH = 1024;
const TARGET_SCHEMA = CORE_SCHEMA.withTags(mergeTag, realMapTag);

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

/**
 * The target-types a csolution declares and the names of their target-sets,
 * in file order. A real YAML parser handles block/flow collections, escapes,
 * aliases and merge keys alike; maps remain Maps so a key cannot become an
 * object prototype property. Only the target selection's shape is checked,
 * not the whole CMSIS schema. Missing/null set names retain their unnamed
 * place in the extension's target-set index.
 *
 * Invalid YAML, unsupported tags or target shapes, and resource-limit
 * violations throw with a reason. They must never look like an empty list
 * of declared targets. The input, parser depth/aliases/merge work, and the
 * extracted names are bounded before an activation or selection write.
 */
export function listTargetTypes(csolutionText: string): TargetTypeInfo[] {
    if (Buffer.byteLength(csolutionText, 'utf8') > MAX_CSOLUTION_BYTES) {
        throw new Error(`Cannot read csolution targets: YAML exceeds the ${MAX_CSOLUTION_BYTES}-byte limit.`);
    }
    let document: unknown;
    try {
        document = load(csolutionText, {
            schema: TARGET_SCHEMA,
            maxDepth: 64,
            maxAliases: 100,
            maxTotalMergeKeys: 10000,
        });
    } catch (caught) {
        const reason = caught instanceof Error ? caught.message : String(caught);
        throw new Error(`Cannot read csolution targets: invalid or unsupported YAML (${reason}).`);
    }
    const root = targetMapping(document, 'document');
    const solution = targetMapping(root.get('solution'), 'solution');
    if (!solution.has('target-types')) {
        return [];
    }
    const types = targetSequence(solution.get('target-types'), 'solution.target-types');
    let names = types.length;
    checkTargetNameCount(names);
    return types.map((value, index) => {
        const at = `solution.target-types[${index}]`;
        const type = targetMapping(value, at);
        const name = targetName(type.get('type'), `${at}.type`, false);
        const sets = type.has('target-set') ? targetSequence(type.get('target-set'), `${at}.target-set`) : [];
        names += sets.length;
        checkTargetNameCount(names);
        return {
            name,
            sets: sets.map((entry, setIndex) => {
                const setAt = `${at}.target-set[${setIndex}]`;
                return targetName(targetMapping(entry, setAt).get('set'), `${setAt}.set`, true);
            }),
        };
    });
}

/** Every target a csolution declares as `cmsis_action` takes it, in file order: `MPS3`, `HE@debug`, `HE@release`. */
export function declaredTargetNames(types: readonly TargetTypeInfo[]): string[] {
    const names: string[] = [];
    for (const t of types) {
        if (t.sets.length === 0) { names.push(t.name); continue; }
        for (const s of t.sets) { names.push(formatTargetName(t.name, s)); }
    }
    return names;
}

/** The choices to offer when a request does not resolve: `MPS3, HE@debug, HE@release`. */
export function formatTargetChoices(types: TargetTypeInfo[]): string {
    return declaredTargetNames(types).join(', ');
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

/**
 * Return cmsis.json text that names `solutionPath` as the active solution
 * of the folder `workspaceFolder`: `activeSolution`, the csolution path
 * relative to the `.vscode` folder with forward slashes, as the extension
 * writes it itself (1.72.0 `setActiveSolution`). The extension reads it when
 * the folder opens and remembers no other solution for it, which is how
 * `open_solution` gets a csolution below the opened folder activated (#145).
 * Existing content — other keys, comments — is preserved; formatting
 * follows the extension (4 spaces).
 */
export function applyActiveSolution(cmsisJsonText: string, workspaceFolder: string, solutionPath: string): string {
    const formattingOptions = { insertSpaces: true, tabSize: 4, eol: '\n' };
    const relative = path.relative(path.join(workspaceFolder, '.vscode'), solutionPath).split(path.sep).join('/').replace(/\\/g, '/');
    const text = cmsisJsonText.trim() ? cmsisJsonText : '{}';
    const updated = applyEdits(text, modify(text, ['activeSolution'], relative, { formattingOptions }));
    return updated.endsWith('\n') ? updated : `${updated}\n`;
}

/** Require the YAML mapping at a selection path, without coercing scalar/collection types. */
function targetMapping(value: unknown, at: string): Map<unknown, unknown> {
    if (!(value instanceof Map)) {
        throw new Error(`Cannot read csolution targets: ${at} must be a mapping.`);
    }
    for (const key of value.keys()) {
        if (typeof key !== 'string') {
            throw new Error(`Cannot read csolution targets: ${at} contains a non-string mapping key; only string keys are supported.`);
        }
    }
    return value;
}

/** Require a sequence so target-set indexes match the owner's sequence exactly. */
function targetSequence(value: unknown, at: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`Cannot read csolution targets: ${at} must be a sequence.`);
    }
    return value;
}

/** Read one name without turning a YAML number, boolean or object into an invented string. */
function targetName(value: unknown, at: string, unnamed: boolean): string {
    if (unnamed && (value === null || value === undefined)) {
        return '';
    }
    if (typeof value !== 'string' || (!unnamed && value.trim() === '')) {
        throw new Error(`Cannot read csolution targets: ${at} must be ${unnamed ? 'a string or null' : 'a non-empty string'}; quote scalar names when needed.`);
    }
    if (value.length > MAX_TARGET_NAME_LENGTH) {
        throw new Error(`Cannot read csolution targets: ${at} exceeds the ${MAX_TARGET_NAME_LENGTH}-character name limit.`);
    }
    return value;
}

/** Bound extracted alias-backed choices as well as the source/parser work. */
function checkTargetNameCount(count: number): void {
    if (count > MAX_TARGET_NAMES) {
        throw new Error(`Cannot read csolution targets: more than ${MAX_TARGET_NAMES} target-type and target-set names.`);
    }
}
