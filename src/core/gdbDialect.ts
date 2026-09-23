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
 * How a raw GDB command reaches GDB through the debug adapter of a session,
 * and how its answer comes back (#56).
 *
 * - `gdbtarget` (the CMSIS Debugger, cdt-gdb-adapter): REPL input is a GDB
 *   command only when it starts with `>`. A CLI command answers the
 *   evaluate request with `'\r'` and prints its text as DAP `output` events
 *   (category `stdout`); a `>` command that is itself an MI command (it
 *   starts with `-`) answers with its MI result as JSON. Anything else is
 *   evaluated as a C expression.
 * - Every other adapter gets the `-exec ` prefix of the C/C++ extension
 *   (`cppdbg`, MIEngine), whose evaluate result carries the console text.
 *
 * Pure: no `vscode` import.
 */

import { ToolError } from './toolResult';

/** The debug type of the CMSIS Debugger. */
export const CMSIS_DEBUGGER_TYPE = 'gdbtarget';

/** Where the text of a GDB CLI command comes back. */
export type GdbTextChannel = 'output-events' | 'evaluate-result';

export interface GdbDialect {
    /** Put in front of the command in a REPL `evaluate` request. */
    prefix: '>' | '-exec ';
    textChannel: GdbTextChannel;
}

const CDT_DIALECT: GdbDialect = { prefix: '>', textChannel: 'output-events' };
const MI_ENGINE_DIALECT: GdbDialect = { prefix: '-exec ', textChannel: 'evaluate-result' };

/** The dialect of a session's adapter, by its debug type. */
export function gdbDialectFor(sessionType: string | undefined): GdbDialect {
    return sessionType === CMSIS_DEBUGGER_TYPE ? CDT_DIALECT : MI_ENGINE_DIALECT;
}

/** True for a GDB/MI command (`-data-read-memory-bytes …`), false for a CLI command. */
export function isMiCommand(command: string): boolean {
    return command.trimStart().startsWith('-');
}

/** `-exec` followed by whitespace or nothing: `-execCount` stays an expression. */
const EXEC_SPELLING = /^-exec(?=\s|$)/;

/**
 * The GDB command in an agent's expression written as `-exec <command>` or
 * `><command>`, without the prefix; undefined for anything else.
 */
export function passthroughCommand(expression: string): string | undefined {
    const text = expression.trimStart();
    if (text.startsWith('>')) {
        return text.slice(1).trim();
    }
    const exec = EXEC_SPELLING.exec(text);
    return exec ? text.slice(exec[0].length).trim() : undefined;
}

/** GDB's refusal of a command that needs a halted target. */
const TARGET_RUNNING = /target is running/i;

export function saysTargetRunning(text: string): boolean {
    return TARGET_RUNNING.test(text);
}

/** What to do about a request GDB refused because the target runs. */
export const TARGET_RUNNING_HINT = 'pause_execution first, or wait_for_stop if a stop is expected.';

/**
 * The error for a DAP request that GDB refused on the CMSIS Debugger, in
 * place of the workbench command that would repeat it as a toast (#13).
 */
export function gdbRequestRefusal(request: string, text: string): ToolError {
    if (saysTargetRunning(text)) {
        return new ToolError('TARGET_RUNNING', `GDB rejected '${request}': the target is running.`, TARGET_RUNNING_HINT);
    }
    return new ToolError('INTERNAL', `GDB rejected '${request}': ${text.trim() || 'no reason given'}`);
}

/** The MI command that reads `count` bytes at `address`; its result comes back in the evaluate reply. */
export function miReadMemoryCommand(address: string, count: number): string {
    return `-data-read-memory-bytes ${address} ${count}`;
}

/** One block of a `-data-read-memory-bytes` result. */
interface MiMemoryBlock {
    begin?: string;
    offset?: string;
    contents?: string;
}

/**
 * The bytes a `-data-read-memory-bytes` reply (the adapter's JSON text)
 * carries from its first block, when that block starts at the address that
 * was asked for; undefined for anything else.
 */
export function bytesFromMiMemoryReply(reply: string, address: string): Buffer | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(reply);
    } catch {
        return undefined;
    }
    const blocks = (parsed as { memory?: unknown })?.memory;
    if (!Array.isArray(blocks) || blocks.length === 0) {
        return undefined;
    }
    const first = blocks[0] as MiMemoryBlock;
    const contents = first.contents;
    if (typeof contents !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(contents)) {
        return undefined;
    }
    let start: bigint;
    let wanted: bigint;
    try {
        start = BigInt(first.begin ?? '') + BigInt(first.offset ?? '0');
        wanted = BigInt(address);
    } catch {
        return undefined;
    }
    return start === wanted ? Buffer.from(contents, 'hex') : undefined;
}

/** A c-string argument of an MI command: quoted, with `\` and `"` escaped. */
export function miQuoted(text: string): string {
    return `"${text.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}
