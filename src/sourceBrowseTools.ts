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
 * The MCP tool surface of the source-browsing tools (experimental, off
 * unless `sourceBrowsing.enabled`). Two tools: one says what a symbol is and
 * what can be asked about it, the other returns one of those things. The
 * descriptions are short, because `tools/list` rides along on every turn;
 * `session-lifecycle.js` holds the two definitions to 2 000 bytes together.
 * The window resolves the context, so the tools take no target or compiler.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toCallToolResult } from './core/measuredMcpServer';
import type { ToolText } from './core/toolResult';
import type { PackDocsDispatch } from './packDocsDispatch';
import { SOURCE_RELATIONS } from './sourceBrowseHandler';

const readOnly = { readOnlyHint: true, destructiveHint: false };

/** The MCP result of a dispatched op's outcome, built by the one mapping in `MeasuredMcpServer`. */
function reply(result: ToolText): CallToolResult {
    return toCallToolResult(result);
}

export function registerSourceBrowseTools(mcpServer: McpServer, dispatch: PackDocsDispatch): void {
    mcpServer.registerTool('source_find', {
        description: 'Experimental. A C/C++ symbol in the source, from clangd\'s index of the active context: what it is (signature, type, ' +
            'size, macro expansion), where it is declared and defined, its id, and what source_get returns for it. Pass name; or ' +
            'fileFullPath and line (with name) for a symbol used there, which a macro or a local needs; or fileFullPath alone for the ' +
            'outline of the file.',
        annotations: readOnly,
        inputSchema: {
            name: z.string().optional().describe('Symbol name, plain or qualified'),
            fileFullPath: z.string().optional().describe('Source file'),
            line: z.number().int().min(1).optional().describe('Line in it, from 1'),
            limit: z.number().int().min(1).max(100).optional(),
        },
    }, async (args) => reply(await dispatch('handleSourceFind', args)));

    mcpServer.registerTool('source_get', {
        description: 'Experimental. One answer about a symbol: its definition as source text, its references, callers or callees (depth ' +
            'for more levels), supertypes, subtypes or implementations, each with file:line and the source line.',
        annotations: readOnly,
        inputSchema: {
            symbol: z.string().describe('Id from source_find, or a unique name'),
            what: z.enum(SOURCE_RELATIONS),
            depth: z.number().int().min(1).max(3).optional(),
            limit: z.number().int().min(1).max(200).optional(),
            maxChars: z.number().int().min(500).max(60_000).optional(),
        },
    }, async (args) => reply(await dispatch('handleSourceGet', args)));
}
