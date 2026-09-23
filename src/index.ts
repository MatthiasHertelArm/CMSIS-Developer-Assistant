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
 * One import path for the debugging core and the agent-configuration types.
 *
 * `src/debugMCPServer.ts` and `src/windowCoordinator.ts` import from `'.'`,
 * which resolves here because the file is `index.ts` and the output is
 * CommonJS; the transport tests load the compiled `out/src/index.js` to build
 * a handler outside VS Code. Re-exports only — nothing runs here beyond
 * loading the four modules.
 */

export { DebugState } from './debugState';

export { DebuggingExecutor, type IDebuggingExecutor } from './debuggingExecutor';

// Exported under shorter names than the module's own.
export {
    DebugConfigurationManager as ConfigurationManager,
    type IDebugConfigurationManager as IConfigurationManager,
} from './utils/debugConfigurationManager';

export { DebuggingHandler, type IDebuggingHandler } from './debuggingHandler';

export {
    AgentConfigurationManager,
    type AgentInfo,
    type MCPServerConfig,
} from './utils/agentConfigurationManager';
