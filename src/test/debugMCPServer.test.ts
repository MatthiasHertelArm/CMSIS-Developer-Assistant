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
import * as server from '../debugMCPServer';
import * as loopback from '../utils/loopback';

/**
 * The Host and Origin guard of the MCP endpoint uses the loopback checks of
 * `src/utils/loopback.ts` (tested in loopback.test.ts), which the control
 * server shares since #19. They stay importable from the server module, as
 * before the move.
 */
suite('DebugMCPServer loopback guards', () => {
    test('isLoopbackHostHeader and isLoopbackOrigin are the shared loopback checks, re-exported', () => {
        assert.strictEqual(server.isLoopbackHostHeader, loopback.isLoopbackHostHeader);
        assert.strictEqual(server.isLoopbackOrigin, loopback.isLoopbackOrigin);
        assert.ok(server.isLoopbackHostHeader('localhost:3001'));
        assert.ok(!server.isLoopbackOrigin('http://evil.example'));
    });
});
