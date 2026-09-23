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

import * as assert from 'assert';
import { LOOPBACK_HOSTNAMES, isLoopbackHostHeader, isLoopbackOrigin } from '../utils/loopback';

/**
 * The DNS-rebinding defence of both local endpoints, the MCP endpoint and
 * every window's control server: a page on evil.example that resolves its
 * name to 127.0.0.1 arrives with `Host: evil.example` and an `Origin` of its
 * own, and both must be refused; every local client passes.
 */
suite('Loopback checks', () => {
    test('the loopback names are localhost and the two loopback literals', () => {
        assert.deepStrictEqual([...LOOPBACK_HOSTNAMES].sort(), ['127.0.0.1', '::1', '[::1]', 'localhost']);
    });

    test('a Host naming this machine passes, with or without a port and in any case', () => {
        for (const host of ['localhost', 'localhost:3001', 'LOCALHOST:3001', '127.0.0.1', '127.0.0.1:3001', '[::1]', '[::1]:3001']) {
            assert.ok(isLoopbackHostHeader(host), host);
        }
    });

    test('a missing, empty, foreign or look-alike Host is refused', () => {
        const refused: unknown[] = [
            undefined, null, '', 42, ['localhost'],
            'evil.example', 'evil.example:3001', '127.0.0.1.evil.example', 'localhost.evil.example', '10.0.0.1:3001', '[::2]:3001',
        ];
        for (const host of refused) {
            assert.ok(!isLoopbackHostHeader(host), String(host));
        }
    });

    test('a loopback Origin passes; null, foreign, look-alike and unparsable origins are refused', () => {
        for (const origin of ['http://localhost:5173', 'https://127.0.0.1', 'http://[::1]:3001', 'http://localhost']) {
            assert.ok(isLoopbackOrigin(origin), origin);
        }
        for (const origin of ['null', 'http://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'not a url', '']) {
            assert.ok(!isLoopbackOrigin(origin), origin);
        }
    });
});
