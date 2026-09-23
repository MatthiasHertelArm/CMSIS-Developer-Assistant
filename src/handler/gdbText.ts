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
 * The GDB side of breakpoints and logpoints: what GDB's answer to a `break`,
 * `dprintf`, `clear` or `delete` says, and how a VS Code logpoint message
 * becomes a `dprintf` format string with its argument expressions.
 *
 * The executor sends these commands as `-exec …` evaluate requests. On a
 * `gdbtarget` session the adapter evaluates that as an expression and
 * answers with its generic "could not evaluate expression", so a reply that
 * is neither a binding nor a known refusal counts as "no echo", never as a
 * failure. Pure: no `vscode` import.
 */

/** What a `break` / `dprintf` reply tells about the breakpoint. */
export type GdbReplyKind = 'bound' | 'rejected' | 'unconfirmed';

/** `Breakpoint 2 at 0x800012c: file main.c, line 10.` */
const BINDING_ECHO = /Breakpoint\s+\d+\s+at/i;

/** GDB's ways of saying a location does not exist or cannot take a breakpoint. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
    /No source file named/i,
    /No line\s+\d+\s+in/i,
    /No symbol/i,
    /Function\s+"[^"]*"\s+not defined/i,
    /No such file/i,
    /cannot be inserted/i,
    /No default breakpoint address/i,
];

/** Words a `clear` / `delete` answer carries when GDB really handled it. */
const REMOVAL_ECHO = /Deleted|Breakpoint|No source|No symbol/i;

/** The number GDB gives a new `dprintf` (or breakpoint) in its echo. */
const NUMBER_ECHO = /(?:Dprintf|Breakpoint)\s+(\d+)\s+at/i;

/** A printf conversion: flags, width and precision, a length modifier, the conversion letter. */
const PRINTF_CONVERSION = /^%[-+ #0-9.]*(?:hh|h|ll|l|z|j|t|L)?[diouxXeEfgGaAcsp]$/;

export function classifyGdbReply(reply: string | null | undefined): GdbReplyKind {
    const text = (reply ?? '').trim();
    if (BINDING_ECHO.test(text)) {
        return 'bound';
    }
    return REFUSAL_PATTERNS.some((pattern) => pattern.test(text)) ? 'rejected' : 'unconfirmed';
}

/** True when a `clear` / `delete` reply reads like GDB's own answer rather than an adapter placeholder. */
export function removalEchoed(reply: string | null | undefined): boolean {
    return REMOVAL_ECHO.test(reply ?? '');
}

/** The breakpoint number in a `dprintf` echo, when there is one. */
export function echoedBreakpointNumber(reply: string | null | undefined): number | undefined {
    const found = NUMBER_ECHO.exec(reply ?? '');
    return found ? Number(found[1]) : undefined;
}

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
 * printf and the GDB command line. A trailing `\n` ends each line of output.
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
