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
 * Opens the Output view of the test window on the extension's log channel, so
 * that an `npm test` run shows the log while the suites run. No suite: the
 * test runner loads this module through `mocha.require` of `.vscode-test.mjs`
 * and calls `mochaGlobalSetup` before it loads the first suite file.
 *
 * The channel is the one of this module tree's `logger`, which the suites log
 * through; the extension under test (the bundle in `dist/`) creates a channel
 * of the same name and identifier, so both write to the one shown here.
 */

import { logger } from '../utils/logger';

/** Called once by `@vscode/test-cli`, inside VS Code, before any suite. The focus stays where it is. */
export function mochaGlobalSetup(): void {
    logger.show(true);
}
