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
 * Text for the raw target reads: core registers, memory dumps and the DWT
 * cycle counter. These show the target as it is — secret redaction never
 * applies here, since several SVDs name real registers KEY, KR or UNLOCK.
 *
 * GDB hands registers back in whatever format its target description
 * implies: decimal for `int` registers, `0x…` with a symbol for code
 * pointers, `[ Z C ]` for decoded flags. `normaliseRegister` brings the
 * numeric ones to one hex form. Pure: no `vscode` import.
 */

/** Rows of the general-purpose register table, four cells each. */
const GENERAL_ROWS: readonly (readonly string[])[] = [
    ['r0', 'r1', 'r2', 'r3'],
    ['r4', 'r5', 'r6', 'r7'],
    ['r8', 'r9', 'r10', 'r11'],
    ['r12', 'sp', 'lr', 'pc'],
];

const WORD_SPAN = 2 ** 32;

/** Bytes per hex row and characters per ASCII line of a memory dump. */
const HEX_ROW_BYTES = 16;
const ASCII_LINE_CHARS = 64;

/**
 * One register value in a comparable form. Decoded flags and placeholders
 * stay as they are; `0x…` loses a trailing annotation such as `<main+12>`;
 * a non-negative decimal becomes `0x` and eight hex digits. A `0X…` value
 * and a negative decimal come back unchanged (KB14).
 */
export function normaliseRegister(raw: string): string {
    const text = raw.trim();
    if (text === '' || text === '<?>' || text.startsWith('[')) {
        return text;
    }
    if (text.startsWith('0x') || text.startsWith('0X')) {
        const leadingHex = /^0x[0-9a-fA-F]+/.exec(text);
        return leadingHex ? leadingHex[0] : text;
    }
    const decimal = parseInt(text, 10);
    if (Number.isNaN(decimal) || decimal < 0) {
        return text;
    }
    return `0x${(decimal % WORD_SPAN).toString(16).padStart(8, '0')}`;
}

/**
 * A register as an unsigned 32-bit number, or undefined when it has no
 * usable value: missing, a `<…>` placeholder, or anything that does not
 * normalise to plain hex (decoded flags, a negative decimal).
 */
export function registerNumber(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.startsWith('<')) {
        return undefined;
    }
    const shown = normaliseRegister(raw);
    return /^0x[0-9a-fA-F]+$/.test(shown) ? Number(shown) >>> 0 : undefined;
}

/** The `read_core_registers` table. `xpsr` and `control` are printed as GDB gave them. */
export function renderCoreRegisters(registers: Record<string, string>): string {
    const raw = (name: string): string => registers[name] ? registers[name] : '<?>';
    const value = (name: string): string => normaliseRegister(raw(name));
    const cell = (name: string): string => `${name.padEnd(4)}= ${value(name).padEnd(14)}`;
    const lines = ['Core Registers:'];
    for (const row of GENERAL_ROWS) {
        lines.push(`  ${row.map(cell).join('')}`);
    }
    lines.push(
        `  xpsr = ${raw('xpsr')}`,
        `  msp  = ${value('msp')}`,
        `  psp  = ${value('psp')}`,
        `  control   = ${raw('control')}`,
        `  faultmask = ${value('faultmask')}`,
        `  basepri   = ${value('basepri')}`,
        `  primask   = ${value('primask')}`,
    );
    return lines.map((line) => `${line}\n`).join('');
}

const hexByte = (byte: number): string => byte.toString(16).padStart(2, '0');

/**
 * The `read_memory` dump. The header states the requested length and the
 * address is parsed only here, after the read, and always as hex — so a
 * decimal address is shown as a different hex address and a malformed one
 * fails with BigInt's own error (KB13).
 */
export function renderMemoryDump(addressText: string, length: number, bytes: Buffer, format: string): string {
    const prefixed = /^0x/i.test(addressText) ? addressText : `0x${addressText}`;
    const base = BigInt(prefixed);
    let text = `Memory at ${prefixed} (${length} bytes):\n`;
    if (format === 'hex' || format === 'both') {
        text += '\nHex:\n';
        for (let offset = 0; offset < bytes.length; offset += HEX_ROW_BYTES) {
            const rowAddress = (base + BigInt(offset)).toString(16).padStart(8, '0');
            const row = Array.from(bytes.subarray(offset, offset + HEX_ROW_BYTES), hexByte).join(' ');
            text += `  0x${rowAddress}: ${row}\n`;
        }
    }
    if (format === 'ascii' || format === 'both') {
        let printable = '';
        bytes.forEach((byte, position) => {
            printable += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
            if ((position + 1) % ASCII_LINE_CHARS === 0) {
                printable += '\n  ';
            }
        });
        text += `\nASCII:\n  ${printable}\n`;
    }
    return text;
}

/** What `readCycleCounter` reports. */
export interface CycleCounterReading {
    cycles: number;
    enabledNow: boolean;
    present: boolean;
}

/** The `read_cycle_counter` text. */
export function renderCycleCounter(reading: CycleCounterReading): string {
    if (!reading.present) {
        return 'This core reports no DWT cycle counter (DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is unavailable. '
            + 'Use an RTOS tick or a timer peripheral for timing instead.';
    }
    const parts = [`DWT cycle counter: ${reading.cycles} (0x${reading.cycles.toString(16).padStart(8, '0')})\n`];
    if (reading.enabledNow) {
        parts.push('DWT was enabled during this call — deltas are valid from now.\n');
    }
    parts.push(
        'Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample repeatedly and accumulate.\n',
        'Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE cycles only.\n',
        'To time a region: read here, continue_execution / wait_for_stop to the end point, read again, subtract (mod 2^32).',
    );
    return parts.join('');
}
