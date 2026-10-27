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

/** The input and output boundaries of read_memory's guarded symbol resolution. */

import * as assert from 'assert';
import { readOnlyAddressCommand } from '../core/memoryAddress';
import { addressFromValue, isAddressLiteral } from '../handler/targetText';

suite('read-only memory addresses', () => {
    test('hex literals require 0x; a name made entirely of hex digits is a symbol', () => {
        for (const literal of ['0x0', '0x20000000', '0XFACE']) {
            assert.strictEqual(isAddressLiteral(literal), true, literal);
        }
        for (const symbol of ['face', 'deadbeef', '1234', '20000000', '0x', '0x20000000oops']) {
            assert.strictEqual(isAddressLiteral(symbol), false, symbol);
        }
    });

    test('symbol paths use one command with scoped memory, register and call permissions', () => {
        const prefix = '-exec with may-write-registers off -- with may-write-memory off -- with may-call-functions off -- output/x ';
        for (const expression of ['buffer', 'face', '&buffer', '$sp', '&buffer[2]', 'ptr->data', 'state.buffer[0x20]',
            'ns::buffer', '::ns::buffer', '&state.rows[1].bytes[2]', '& buffer [ 2 ]', 'pointer -> field']) {
            assert.strictEqual(readOnlyAddressCommand(expression), `${prefix}(unsigned long)(${expression})`, expression);
        }
        assert.strictEqual(readOnlyAddressCommand('  &buffer  '), `${prefix}(unsigned long)(&buffer)`);
    });

    test('side effects and unsupported syntax never produce a GDB command', () => {
        for (const expression of ['ptr = 0', 'ptr += 1', 'ptr++', '++ptr', 'mutate()', 'buffer[mutate()]',
            'buffer[index++]', '(ptr = 0)', 'new Buffer', 'delete ptr', 'ptr, mutate()', 'ptr; call mutate()',
            'ptr\ncall mutate()', 'ptr\rcall mutate()', 'ptr\n', 'ptr/*comment*/', 'ptr//comment',
            'ptr ? buffer : other', 'ptr + 4', '(unsigned long)ptr', '(*callback)()', 'std::move(ptr)',
            '>print ptr', '-exec print ptr', '&', 'buffer[]', 'buffer[-1]', 'buffer[index]', 'buffer..data',
            'buffer->', '0x20000000', '20000000', '', '\u0000ptr', 'a'.repeat(513)]) {
            assert.strictEqual(readOnlyAddressCommand(expression), undefined, expression);
        }
    });

    test('only a complete numeric reply is an address', () => {
        assert.strictEqual(addressFromValue('  0X20000100\r\n'), '0x20000100');
        assert.strictEqual(addressFromValue('536871168'), '0x20000100');
        assert.strictEqual(addressFromValue('9007199254740993'), '0x20000000000001');
        assert.strictEqual(addressFromValue('0'), '0x0');
        for (const value of [undefined, null, 536871168, '', '0x', '-1', '0x20000100 <buffer>', '$1 = 0x20000100',
            '(gdb) 0x20000100', 'Error: cannot read 0x20000100', '0x20000100\nError: function calls forbidden',
            '0x20000100\n0x20000200', '536871168: failed', '{state = 2}', '0x20000100oops']) {
            assert.strictEqual(addressFromValue(value), undefined, String(value));
        }
    });
});
