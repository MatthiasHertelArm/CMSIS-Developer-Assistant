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

import * as fs from 'fs';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { writeFileAtomic } from './atomicFile';

export type JsonRewriteOutcome = 'written' | 'unchanged' | 'unparseable';

/** A JSON object, not an array or null. */
function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The object in `text`: strict JSON, or JSON with comments and trailing
 * commas (`kilo.jsonc`, a commented Gemini CLI `settings.json`), which
 * `commented` marks. Undefined for anything else.
 */
export function parseJsonObject(text: string): { config: Record<string, unknown>; commented: boolean } | undefined {
    try {
        const strict: unknown = JSON.parse(text);
        return isObject(strict) ? { config: strict, commented: false } : undefined;
    } catch {
        const errors: ParseError[] = [];
        const loose: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
        return errors.length === 0 && isObject(loose) ? { config: loose, commented: true } : undefined;
    }
}

/**
 * `before` with the top-level keys whose value differs between `old` and
 * `config` replaced, added or removed in place. Comments and layout outside
 * those keys stay; inside a changed key they go.
 */
function editTopLevel(before: string, old: Record<string, unknown>, config: Record<string, unknown>): string {
    let text = before;
    const format = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: before.includes('\r\n') ? '\r\n' : '\n' } };
    for (const key of new Set([...Object.keys(old), ...Object.keys(config)])) {
        if (JSON.stringify(old[key]) !== JSON.stringify(config[key])) {
            text = applyEdits(text, modify(text, [key], key in config ? config[key] : undefined, format));
        }
    }
    return text;
}

/**
 * Read-modify-write of a JSON file that another process may be writing too
 * (`~/.claude.json` is rewritten by Claude Code all the time). `mutate` gets a
 * fresh parse and returns whether it changed anything; the file is re-read
 * immediately before the write and, if it changed underneath, the whole
 * step is retried on the new content — up to `attempts` times. Unrelated
 * keys are preserved because the parsed object is written back whole; a file
 * with comments gets only its changed top-level keys rewritten, so the
 * comments elsewhere stay. An unparseable file is never overwritten.
 */
export async function rewriteJsonFile(
    file: string,
    mutate: (config: Record<string, unknown>) => boolean | Promise<boolean>,
    options: { attempts?: number } = {},
): Promise<JsonRewriteOutcome> {
    const attempts = options.attempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
        const before = await fs.promises.readFile(file, 'utf8');
        const parsed = parseJsonObject(before);
        if (!parsed) { return 'unparseable'; }
        const { config, commented } = parsed;
        const old = commented ? structuredClone(config) : config;
        if (!(await mutate(config))) { return 'unchanged'; }
        const now = await fs.promises.readFile(file, 'utf8').catch(() => before);
        if (now !== before) { continue; } // someone wrote in between — redo on their content
        await writeFileAtomic(file, commented ? editTopLevel(before, old, config) : JSON.stringify(config, null, 2));
        return 'written';
    }
    throw new Error(`${file} changed underneath the write ${attempts} times; not written`);
}
