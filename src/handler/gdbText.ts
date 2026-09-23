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
 * The GDB side of the CMSIS Debugger's logpoints: what GDB's answer to a
 * `-dprintf-insert`, `condition`, `delete` or `-break-list` says, where a
 * logpoint is set, and how a VS Code logpoint message becomes a `dprintf`
 * format string with its argument expressions.
 *
 * The executor sends these commands in the `>` prefix of cdt-gdb-adapter
 * (#56). An MI command's result arrives as JSON in the evaluate reply; a CLI
 * command's text is the output the adapter printed while it ran; a command
 * GDB refuses comes back as an errored reply with GDB's message. Pure: no
 * `vscode` import.
 */

import { saysTargetRunning, TARGET_RUNNING_HINT } from '../core/gdbDialect';
import { ToolError } from '../core/toolResult';

/** A GDB reply as the executor returns it. */
export interface GdbAnswer {
    text: string;
    errored: boolean;
}

/**
 * What a GDB reply says: `done`, or a refusal — `running` (the target has to
 * be halted first), `rejected` (GDB refused the location or an expression),
 * `failed` (anything else).
 */
export type GdbReplyKind = 'done' | 'running' | 'rejected' | 'failed';

/** GDB's ways of saying a location or an expression is not valid here. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
    /No source file named/i,
    /No line\s+\d+\s+in/i,
    /No symbol/i,
    /Function\s+"[^"]*"\s+not defined/i,
    /No such file/i,
    /cannot be inserted/i,
    /No default breakpoint address/i,
    /syntax error/i,
    /Bad format string/i,
    /Invalid character/i,
];

export function classifyGdbReply(reply: GdbAnswer): GdbReplyKind {
    if (saysTargetRunning(reply.text)) {
        return 'running';
    }
    if (!reply.errored) {
        return 'done';
    }
    return REFUSAL_PATTERNS.some((pattern) => pattern.test(reply.text)) ? 'rejected' : 'failed';
}

/** The error for a GDB refusal of `what` (such as "the logpoint"), by its kind. */
export function gdbRefusal(what: string, reply: GdbAnswer): ToolError {
    const reason = reply.text.trim() || 'no reason given';
    switch (classifyGdbReply(reply)) {
        case 'running':
            return new ToolError('TARGET_RUNNING', `GDB rejected ${what}: the target is running.`, TARGET_RUNNING_HINT);
        case 'rejected':
            return new ToolError('INVALID_ARGUMENT', `GDB rejected ${what}: ${reason}`,
                'Check that the line has code and the path matches the ELF\'s compiled paths, '
                    + 'and that every expression is in scope at that line.');
        default:
            return new ToolError('INTERNAL', `GDB rejected ${what}: ${reason}`);
    }
}

/** Where a new `dprintf` landed, from GDB's MI result. */
export interface DprintfPlacement {
    number: number;
    file?: string;
    line?: number;
    address?: string;
    /** More than one when the location matched several places (inlined code, several files of that name). */
    locations: number;
}

type MiRecord = Record<string, unknown>;

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

const textField = (record: MiRecord, key: string): string | undefined =>
    typeof record[key] === 'string' ? record[key] as string : undefined;

/** The `-dprintf-insert` result (the adapter's JSON text): the new breakpoint, or undefined when it is not one. */
export function dprintfFromMiReply(text: string): DprintfPlacement | undefined {
    const bkpt = (parseJson(text) as MiRecord | undefined)?.bkpt;
    // Several locations come as the parent entry followed by one entry each.
    const entries = (Array.isArray(bkpt) ? bkpt : [bkpt]).filter((entry): entry is MiRecord => typeof entry === 'object' && entry !== null);
    const parent = entries[0];
    const number = parent ? Number(textField(parent, 'number')) : NaN;
    if (!parent || !Number.isInteger(number)) {
        return undefined;
    }
    const where = entries.length > 1 ? entries[1] : parent;
    const line = Number(textField(where, 'line'));
    return {
        number,
        file: textField(where, 'file'),
        line: Number.isInteger(line) ? line : undefined,
        address: textField(parent, 'addr'),
        locations: Math.max(entries.length - 1, 1),
    };
}

/** One row of GDB's breakpoint table. */
export interface GdbTableEntry {
    number: number;
    type?: string;
    /** How often it was hit. */
    hits?: number;
    condition?: string;
}

/** The rows of a `-break-list` result (the adapter's JSON text); undefined when it is not one. */
export function breakpointTableFromMiReply(text: string): GdbTableEntry[] | undefined {
    const body = ((parseJson(text) as MiRecord | undefined)?.BreakpointTable as MiRecord | undefined)?.body;
    if (!Array.isArray(body)) {
        return undefined;
    }
    return body.filter((row): row is MiRecord => typeof row === 'object' && row !== null).flatMap((row) => {
        const number = Number(textField(row, 'number'));
        if (!Number.isInteger(number)) {
            return [];
        }
        const hits = Number(textField(row, 'times'));
        return [{ number, type: textField(row, 'type'), hits: Number.isInteger(hits) ? hits : undefined, condition: textField(row, 'cond') }];
    });
}

/** The numbers GDB's `delete` did not know: it prints `No breakpoint number N.` for each and deletes the rest. */
export function unknownBreakpointNumbers(text: string): number[] {
    return [...text.matchAll(/No breakpoint number (\d+)\./g)].map((hit) => Number(hit[1]));
}

/**
 * The GDB location of a logpoint: the path relative to the workspace folder
 * that holds the file, else the file name, with `/` separators. GDB matches
 * it against the end of the ELF's source paths. cdt-gdb-adapter, when it
 * syncs VS Code's breakpoints of a file, deletes every GDB breakpoint whose
 * location contains that file's absolute path and that VS Code did not send;
 * a relative location keeps the logpoint out of that.
 */
export function gdbSourceLocation(fileFullPath: string, line: number, workspaceRoots: readonly string[]): string {
    const forward = (text: string): string => text.replace(/\\/g, '/');
    const file = forward(fileFullPath);
    const caseless = /^[a-zA-Z]:\//.test(file);
    const same = (a: string, b: string): boolean => caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
    const inside = workspaceRoots
        .map((root) => forward(root).replace(/\/+$/, ''))
        .filter((root) => root.length > 0 && file.length > root.length + 1 && same(file.slice(0, root.length + 1), `${root}/`))
        .sort((a, b) => b.length - a.length)[0];
    const relative = inside !== undefined ? file.slice(inside.length + 1) : file.replace(/^.*\//, '');
    return `${relative}:${line}`;
}

/** A printf conversion: flags, width and precision, a length modifier, the conversion letter. */
const PRINTF_CONVERSION = /^%[-+ #0-9.]*(?:hh|h|ll|l|z|j|t|L)?[diouxXeEfgGaAcsp]$/;

/** A GDB `dprintf` call: the format string (already escaped) and its argument expressions. */
export interface DprintfCall {
    format: string;
    args: string[];
}

/** One literal character, escaped for a printf format inside a double-quoted GDB argument. */
function escapeLiteral(character: string): string {
    switch (character) {
        case '%':
            return '%%';
        case '"':
            return '\\"';
        case '\\':
            return '\\\\';
        case '\n':
            return '\\n';
        default:
            return character;
    }
}

/**
 * `{expr}` or `{expr:%fmt}` inside a logpoint message. The conversion is
 * whatever follows the last colon, so `ns::value` stays one expression.
 */
function interpolation(inner: string): { conversion: string; expression: string } {
    const colon = inner.lastIndexOf(':');
    if (colon >= 0) {
        const tail = inner.slice(colon + 1);
        if (PRINTF_CONVERSION.test(tail)) {
            return { conversion: tail, expression: inner.slice(0, colon).trim() };
        }
    }
    return { conversion: '%d', expression: inner };
}

/**
 * Turn a VS Code logpoint message into a `dprintf` format and arguments:
 * `{{` / `}}` are literal braces, `{expr}` prints with `%d`, `{expr:%08lx}`
 * with the given conversion, and every other character is escaped for
 * printf and for a double-quoted GDB argument (CLI or MI c-string alike). A
 * trailing `\n` ends each line of output.
 */
export function translateLogMessage(logMessage: string): DprintfCall {
    const args: string[] = [];
    let format = '';
    let index = 0;
    while (index < logMessage.length) {
        const character = logMessage[index];
        if ((character === '{' || character === '}') && logMessage[index + 1] === character) {
            format += character;
            index += 2;
            continue;
        }
        if (character === '}') {
            throw new Error(`Unbalanced '}' in logMessage at position ${index}. Use }} for a literal brace.`);
        }
        if (character !== '{') {
            format += escapeLiteral(character);
            index += 1;
            continue;
        }
        const closing = logMessage.indexOf('}', index + 1);
        if (closing < 0) {
            throw new Error(`Unbalanced '{' in logMessage at position ${index}. Use {{ for a literal brace.`);
        }
        const inner = logMessage.slice(index + 1, closing).trim();
        if (inner.length === 0) {
            throw new Error(`Empty interpolation '{}' in logMessage at position ${index}.`);
        }
        const { conversion, expression } = interpolation(inner);
        format += conversion;
        args.push(expression);
        index = closing + 1;
    }
    return { format: `${format}\\n`, args };
}
