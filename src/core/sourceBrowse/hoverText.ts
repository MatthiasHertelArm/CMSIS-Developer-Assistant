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
 * What clangd says about a symbol on hover, taken apart for a card.
 *
 * The editor's client asks for Markdown, so that is what arrives: a heading
 * with the kind and the name (`### function `main``), rules, lines on the
 * return type, the parameters, the type, the size and the value, the
 * documentation comment, and a fenced block with the declaration, which for
 * a macro is its definition and what it expands to. A peer that asked for
 * plain text gets the same paragraphs without the marks; both are read.
 * Nothing here depends on one clangd version's exact wording: a hover that
 * does not have the expected parts still yields its lines.
 *
 * Pure: no `vscode`, no file access.
 */

import type { Hover, MarkedCode } from './protocol';

/** A hover in parts. */
export interface HoverParts {
    /** The kind word of the heading: `function`, `variable`, `macro`, `class`, `struct`, `field`, `enumerator`, `type-alias`, … */
    kind?: string;
    /** The name of the heading. */
    name?: string;
    /** The declaration; for a macro its definition and expansion. */
    code?: string;
    /** The lines between heading and declaration, marks removed. */
    details: string[];
}

/** Kind words of what can be called. */
const CALLABLE_WORDS: ReadonlySet<string> = new Set(['function', 'method', 'instance-method', 'static-method', 'constructor', 'destructor',
    'conversion-function', 'conversion-func']);
/** Kind words of what can have base and derived types. */
const RECORD_WORDS: ReadonlySet<string> = new Set(['class', 'struct', 'union', 'interface']);
/** Kind words of a member function, which a derived class can override. */
const METHOD_WORDS: ReadonlySet<string> = new Set(['method', 'instance-method']);
/** The kind words clangd opens a hover with, by which a heading without Markdown marks is known. */
const KIND_WORDS: ReadonlySet<string> = new Set([...CALLABLE_WORDS, ...RECORD_WORDS, 'variable', 'field', 'param', 'macro', 'enum', 'enumerator',
    'type-alias', 'namespace', 'namespace-alias', 'static-property', 'instance-property', 'concept', 'using', 'module', 'type', 'label']);

/** True for a kind word of something that has callers and callees. */
export function isCallable(kind: string | undefined): boolean {
    return kind !== undefined && CALLABLE_WORDS.has(kind);
}

/** True for a kind word of something that has supertypes and subtypes. */
export function isRecord(kind: string | undefined): boolean {
    return kind !== undefined && RECORD_WORDS.has(kind);
}

/** True for a kind word of something that can have implementations in derived classes. */
export function isOverridable(kind: string | undefined): boolean {
    return kind !== undefined && METHOD_WORDS.has(kind);
}

/** A piece of the older hover format as Markdown. */
function pieceText(piece: string | MarkedCode): string {
    return typeof piece === 'string' ? piece : `\`\`\`${piece.language}\n${piece.value}\n\`\`\``;
}

/** The text of a hover, whatever form its contents have; empty when there is none. */
export function hoverText(hover: Hover | null | undefined): string {
    const contents = hover?.contents;
    if (contents === undefined || contents === null) {
        return '';
    }
    if (typeof contents === 'string') {
        return contents;
    }
    if (Array.isArray(contents)) {
        return contents.map(pieceText).join('\n\n');
    }
    if ('language' in contents) {
        return pieceText(contents);
    }
    return typeof contents.value === 'string' ? contents.value : '';
}

/** One line without the marks of Markdown. */
function plain(line: string): string {
    return line
        .replace(/^#{1,6}\s+/, '')
        .replace(/\s{2,}$/, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/`/g, '')
        .replace(/\\([\\`*_{}[\]()#+\-.!<>|~])/g, '$1')
        // The rule of a banner comment, which clangd passes on as documentation.
        .replace(/[-=*#~_/]{6,}/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * The parts of a hover; undefined for one without text. The declaration is
 * the last fenced block, or without fences the last paragraph when there are
 * several; the heading is the first line.
 */
export function parseHover(hover: Hover | null | undefined): HoverParts | undefined {
    const text = hoverText(hover).replace(/\r\n/g, '\n').trim();
    if (text.length === 0) {
        return undefined;
    }
    let code: string | undefined;
    let rest = text;
    const fences = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)];
    if (fences.length > 0) {
        code = fences[fences.length - 1][1].trim();
        rest = text.replace(/```[^\n`]*\n[\s\S]*?```/g, '');
    } else {
        const paragraphs = text.split(/\n\s*\n/);
        if (paragraphs.length > 1) {
            code = paragraphs[paragraphs.length - 1].trim();
            rest = paragraphs.slice(0, -1).join('\n\n');
        }
    }
    // In Markdown the heading is marked as one; in plain text it is known by its kind word.
    const marked = /^\s*#{1,6}\s/.test(rest);
    const lines = rest.split('\n').map(plain).filter((line) => line.length > 0 && !/^-{3,}$/.test(line));
    const parts: HoverParts = { details: [] };
    if (code !== undefined && code.length > 0) {
        parts.code = code;
    }
    if (lines.length === 0) {
        return parts;
    }
    const heading = /^([a-z][a-z-]*)\s+(.+?)(?:\s+provided by\s.*)?$/.exec(lines[0]);
    if (heading && (marked || KIND_WORDS.has(heading[1]))) {
        parts.kind = heading[1];
        parts.name = heading[2];
        parts.details = lines.slice(1);
    } else {
        parts.details = lines;
    }
    return parts;
}
