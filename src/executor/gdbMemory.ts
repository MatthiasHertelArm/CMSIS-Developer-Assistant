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
 * Memory helpers of the executor: how addresses are spelled, and how one
 * 32-bit word is read through GDB when the adapter's `readMemory` request
 * fails.
 *
 * The word read tries evaluate requests in turn and keeps the first answer it
 * can parse: a watch expression that dereferences the address, then raw GDB
 * commands in the dialect of the session's adapter (src/core/gdbDialect.ts).
 * On the CMSIS Debugger that is the MI command `-data-read-memory-bytes`,
 * whose result comes back in the evaluate reply (a CLI command's text would
 * only reach the Debug Console); elsewhere `x/1xw` and `print/x` through
 * `-exec`, whose text is the reply. A timeout ends the read at once.
 *
 * `readWord` in src/core/peripheralReader.ts is a similar ladder with its own
 * behaviour (no third form, `readMemory` first); the two stay separate.
 */

import * as vscode from 'vscode';
import { bytesFromMiMemoryReply, CMSIS_DEBUGGER_TYPE, miReadMemoryCommand } from '../core/gdbDialect';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout';
import { EvaluateBody, FrameArg } from './common';

/** An address written without `0x` gets it; anything else is used verbatim (no case change, no padding). */
export function withHexPrefix(address: string): string {
    return /^0x/i.test(address) ? address : `0x${address}`;
}

/**
 * The address `index` words after `start`: lower-case, unpadded, and computed
 * with BigInt, so it is never wrapped at 4 GiB (KB15). A `start` BigInt cannot
 * parse throws its SyntaxError.
 */
export function nthWordAddress(start: string, index: number): string {
    return `0x${(BigInt(start) + BigInt(index) * 4n).toString(16)}`;
}

/** One way of asking GDB for the word, and how its answer is read. */
interface WordQuery {
    context: 'watch' | 'repl';
    expressionFor(address: string): string;
    /** The word in the adapter's `result` text for `address`, or undefined when there is none. */
    parse(result: string, address: string): number | undefined;
}

const WATCH_QUERY: WordQuery = { context: 'watch', expressionFor: (address) => `*(unsigned int*)${address}`, parse: leadingInteger };

/** The ladder per adapter: the CMSIS Debugger answers MI commands in the reply, MIEngine answers `-exec` commands there. */
const CDT_QUERIES: readonly WordQuery[] = [
    WATCH_QUERY,
    { context: 'repl', expressionFor: (address) => `>${miReadMemoryCommand(address, 4)}`, parse: wordFromMiReply },
];
const MI_ENGINE_QUERIES: readonly WordQuery[] = [
    WATCH_QUERY,
    { context: 'repl', expressionFor: (address) => `-exec x/1xw ${address}`, parse: hexAfterColon },
    { context: 'repl', expressionFor: (address) => `-exec print/x *(unsigned int*)${address}`, parse: firstHexLiteral },
];

/**
 * The word at `address`, asked in the frame `frame` names (or in none). A
 * rejected request, an empty or unreadable answer moves on to the next query;
 * a `HardwareTimeoutError` is rethrown without trying the rest.
 */
export async function readWordThroughGdb(
    session: vscode.DebugSession,
    address: string,
    frame: FrameArg,
    budgetMs: number,
): Promise<number> {
    const queries = session.type === CMSIS_DEBUGGER_TYPE ? CDT_QUERIES : MI_ENGINE_QUERIES;
    for (const query of queries) {
        let word: number | undefined;
        try {
            const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
                { expression: query.expressionFor(address), context: query.context, ...frame }, budgetMs);
            const answer = reply?.result;
            word = typeof answer === 'string' ? query.parse(answer, address) : undefined;
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
        }
        if (word !== undefined) {
            return word;
        }
    }
    throw new Error(`Failed to read memory at ${address} — all GDB strategies exhausted`);
}

/**
 * A GDB number with anything after it: hex when it starts with `0x`/`0X`,
 * decimal otherwise, and neither masked nor sign-checked (KB15).
 */
function leadingInteger(result: string): number | undefined {
    const text = result.trim();
    const value = /^0x/i.test(text) ? parseInt(text, 16) : parseInt(text, 10);
    return Number.isNaN(value) ? undefined : value;
}

/** `x/1xw` answers `0x20000000:\t0x12345678`: the word is the hex literal right after a colon. */
function hexAfterColon(result: string): number | undefined {
    const hit = /:\s*(0x[0-9a-fA-F]+)/.exec(result);
    return hit ? parseInt(hit[1], 16) : undefined;
}

/** `print/x` answers `$1 = 0x12345678`: the word is the first hex literal. */
function firstHexLiteral(result: string): number | undefined {
    const hit = /0x[0-9a-fA-F]+/.exec(result);
    return hit ? parseInt(hit[0], 16) : undefined;
}

/** `-data-read-memory-bytes` answers the bytes as hex text: the word is the first four, little-endian. */
function wordFromMiReply(result: string, address: string): number | undefined {
    const bytes = bytesFromMiMemoryReply(result, address);
    return bytes && bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
}
