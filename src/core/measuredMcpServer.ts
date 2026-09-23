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
 * The MCP boundary of every tool: the measurement of each call and the one
 * place where a handler's outcome becomes an MCP result (`toCallToolResult`).
 */

import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolMetrics, classifyOutcome } from './toolMetrics';
import { JsonObject, ToolError, ToolText, errorText, toToolError } from './toolResult';

type ServerInfo = ConstructorParameters<typeof McpServer>[0];
type ServerOptions = ConstructorParameters<typeof McpServer>[1];
/**
 * The base signature is generic over the zod shapes; the wrapper only needs to
 * know whether an input schema exists, so it accepts the config wide and
 * hands it through untouched.
 */
type RegisterToolConfig = {
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
    _meta?: Record<string, unknown>;
};
type AnyToolCallback = (...callArgs: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** `base`, then the keys of `data` that do not collide with it: a detail never overwrites the status. */
function withDetail(base: JsonObject, data: JsonObject | undefined): JsonObject {
    const merged: JsonObject = { ...base };
    for (const [key, value] of Object.entries(data ?? {})) {
        if (!(key in merged)) {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * The MCP result of a handler's outcome, the only place where one is built:
 *
 * - a string: that text alone; the absence of `isError` says it succeeded;
 * - a `ToolReply` with status `ok`: its text, plus `structuredContent`
 *   `{status: 'ok', ...data}` only when it has data;
 * - a `ToolReply` that is `running` or `timeout`: its text, and
 *   `structuredContent` `{status, message, ...data}`; neither is a failure;
 * - a `ToolError`: `[CODE] message` and the hint on the next line, `isError`,
 *   and `structuredContent` `{status: 'error', error_code, message, hint, ...data}`.
 *
 * No tool declares an `outputSchema`, so `tools/list` does not grow; the SDK
 * passes `structuredContent` through without one.
 */
export function toCallToolResult(outcome: ToolText | ToolError): CallToolResult {
    if (outcome instanceof ToolError) {
        const described: JsonObject = { status: 'error', error_code: outcome.code, message: outcome.message };
        if (outcome.hint) {
            described.hint = outcome.hint;
        }
        return {
            content: [{ type: 'text', text: errorText(outcome) }],
            isError: true,
            structuredContent: withDetail(described, outcome.data),
        };
    }
    if (typeof outcome === 'string') {
        return { content: [{ type: 'text', text: outcome }] };
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: outcome.text }];
    if (outcome.status === 'ok') {
        return outcome.data === undefined ? { content } : { content, structuredContent: withDetail({ status: 'ok' }, outcome.data) };
    }
    return { content, structuredContent: withDetail({ status: outcome.status, message: outcome.text }, outcome.data) };
}

/**
 * An McpServer that measures every registered tool and answers every failure
 * with a typed result.
 *
 * The wrapper sits at the MCP boundary, so what it sees is exactly what the
 * client sees: the arguments after schema parsing, the result after every
 * handler, redaction and routing step, and the wall time including any
 * forward to another window. Registration is untouched — callers keep using
 * `registerTool(name, config, cb)` with literal names, which the skill test
 * greps for.
 *
 * A callback that throws is answered here, through `toCallToolResult`, rather
 * than by the SDK, whose error result would carry the message alone. Schema
 * errors are raised by the SDK before the callback runs and stay its own.
 *
 * Nothing here depends on vscode; logging and sinks hang off the metrics'
 * onSample callback.
 */
export class MeasuredMcpServer extends McpServer {
    constructor(serverInfo: ServerInfo, options: ServerOptions, private readonly metrics: ToolMetrics) {
        super(serverInfo, options);
    }

    public override registerTool(name: string, config: RegisterToolConfig, cb: unknown): RegisteredTool {
        // Tools without an input schema receive only the request extra; tools
        // with one receive (args, extra).
        const hasArgs = config.inputSchema !== undefined;
        const original = cb as AnyToolCallback;
        const metrics = this.metrics;

        const measured: AnyToolCallback = async (...callArgs: unknown[]) => {
            const started = Date.now();
            const args = hasArgs ? callArgs[0] : undefined;
            const extra = (hasArgs ? callArgs[1] : callArgs[0]) as { sessionId?: string } | undefined;
            const argBytes = args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args));
            let result: CallToolResult;
            try {
                result = await original(...callArgs);
            } catch (err) {
                result = toCallToolResult(toToolError(err));
            }
            const text = (result.content ?? [])
                .map((item) => (item.type === 'text' ? item.text : ''))
                .join('');
            metrics.record({
                tool: name,
                argBytes,
                resultBytes: Buffer.byteLength(JSON.stringify(result)),
                ms: Date.now() - started,
                outcome: classifyOutcome(text, result.isError === true, result.structuredContent),
                at: Date.now(),
                sessionId: extra?.sessionId,
            });
            return result;
        };

        // The base signature is generic over the zod shapes; the wrapper is
        // shape-agnostic, so hand it over untyped rather than re-deriving them.
        const register = super.registerTool as unknown as (
            this: McpServer, n: string, c: RegisterToolConfig, f: AnyToolCallback,
        ) => RegisteredTool;
        return register.call(this, name, config, measured);
    }
}
