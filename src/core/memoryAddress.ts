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

/** The deliberately small symbolic address language accepted by read_memory. */

const MAX_ADDRESS_EXPRESSION_CHARS = 512;

// A symbol or register, optionally qualified and addressed, then fields and
// literal array indices. No calls, casts, arithmetic, assignments, command
// delimiters or expression-valued indices reach GDB. The disjoint separators
// make the repetition unambiguous; the input length is bounded as well.
const ADDRESS_PATH = /^&?[ \t]*(?:(?:::)?[a-zA-Z_][a-zA-Z_0-9]*(?:::[a-zA-Z_][a-zA-Z_0-9]*)*|\$[a-zA-Z_][a-zA-Z_0-9]*)(?:[ \t]*(?:(?:\.|->)[ \t]*[a-zA-Z_][a-zA-Z_0-9]*|\[[ \t]*(?:0[xX][0-9a-fA-F]+|[0-9]+)[ \t]*\]))*$/;

/**
 * A single scoped GDB command for an accepted symbolic address, or undefined
 * for unsupported syntax. Syntax alone is not a read-only guarantee: C++
 * conversions/operators can call the inferior, and debug macros can hide
 * assignments. GDB's low-level permissions block both for this command;
 * `with` restores each prior setting even when evaluation fails. There is
 * deliberately no unguarded fallback when a GDB version lacks these settings.
 *
 * `output/x` of an integer produces only the address, without value-history
 * or symbol annotations, so the caller can reject a mixed/error reply.
 */
export function readOnlyAddressCommand(expression: string): string | undefined {
    if (expression.length > MAX_ADDRESS_EXPRESSION_CHARS || /[\r\n]/.test(expression)) {
        return undefined;
    }
    const path = expression.trim();
    if (!ADDRESS_PATH.test(path)) {
        return undefined;
    }
    return '-exec with may-write-registers off -- with may-write-memory off -- with may-call-functions off -- '
        + `output/x (unsigned long)(${path})`;
}
