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
 * The MCP boundary of every tool: the measurement of each call, its call id
 * and call context (#48), the one place where a handler's outcome becomes an
 * MCP result (`toCallToolResult`), and the inputs a session adds to some of
 * its tools (`addArgument`).
 */

import { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runInCallContext } from './callContext';
import { renderProblemsBlock } from './problemFeed';
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

/** An input a session adds to the inputs some of its tools declare themselves. */
interface AddedArgument {
    name: string;
    /** A zod schema, as in a tool's own input shape. */
    schema: unknown;
    tools: ReadonlySet<string>;
}

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
 *   `{status: 'ok', message, ...data}` only when it has data;
 * - a `ToolReply` that is `running` or `timeout`: its text, and
 *   `structuredContent` `{status, message, ...data}`; neither is a failure;
 * - a `ToolError`: `[CODE] message` and the hint on the next line, `isError`,
 *   and `structuredContent` `{status: 'error', error_code, message, hint, ...data}`.
 *
 * Every `structuredContent` carries the text as `message` (and a failure's
 * hint as `hint`): some MCP clients hand the model
 * `structuredContent` instead of `content`, so the object has to say
 * everything the text says. The problem records that ride along with a
 * failure or a timeout (#48, `data.problems`) are also listed under the
 * text, as "Recent problems:".
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
            content: [{ type: 'text', text: errorText(outcome) + renderProblemsBlock(outcome.data?.problems) }],
            isError: true,
            structuredContent: withDetail(described, outcome.data),
        };
    }
    if (typeof outcome === 'string') {
        return { content: [{ type: 'text', text: outcome }] };
    }
    const content: CallToolResult['content'] = [{ type: 'text', text: outcome.text + renderProblemsBlock(outcome.data?.problems) }];
    if (outcome.status === 'ok') {
        return outcome.data === undefined
            ? { content }
            : { content, structuredContent: withDetail({ status: 'ok', message: outcome.text }, outcome.data) };
    }
    return { content, structuredContent: withDetail({ status: outcome.status, message: outcome.text }, outcome.data) };
}

/**
 * The lines of a result's text that its `structuredContent` does not carry,
 * none when it has no `structuredContent`. A line counts as carried when it
 * is part of `message` or `hint`; the `[CODE]` prefix of a failure's first
 * line is `error_code`, and the "Recent problems:" block is `problems`. The
 * surface harness and the unit tests hold every result to an empty answer.
 */
export function linesMissingFromStructured(result: CallToolResult): string[] {
    const structured = result.structuredContent;
    if (structured === undefined || structured === null) {
        return [];
    }
    const text = (result.content ?? []).map((item) => (item.type === 'text' ? item.text : '')).join('\n');
    const said = [structured.message, structured.hint].filter((part): part is string => typeof part === 'string').join('\n');
    const shown = text.replace(/\nRecent problems:\n[\s\S]*$/, '');
    return shown.split('\n')
        .map((line, index) => (index === 0 && result.isError === true ? line.replace(/^\[[A-Z_]+\] /, '') : line))
        .filter((line) => line.trim() !== '' && !said.includes(line));
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
 * greps for — except that a session can add one input to a set of tools
 * (`addArgument`), as a router session adds `window` (#16).
 *
 * A callback that throws is answered here, through `toCallToolResult`, rather
 * than by the SDK, whose error result would carry the message alone. Schema
 * errors are raised by the SDK before the callback runs and stay its own.
 *
 * Every call gets an id, `<first 8 characters of the session id>-<n>` (#48),
 * and the callback runs in a call context with that id and the session id
 * (`src/core/callContext.ts`): the router copies both into the control
 * envelope, and the problem journal stamps its records with the id.
 *
 * Nothing here depends on vscode; logging and sinks hang off the metrics'
 * onSample callback.
 */
export class MeasuredMcpServer extends McpServer {
    private readonly addedArguments: AddedArgument[] = [];
    /** Calls of this server so far; each server serves one MCP session. */
    private calls = 0;

    constructor(serverInfo: ServerInfo, options: ServerOptions, private readonly metrics: ToolMetrics) {
        super(serverInfo, options);
    }

    /**
     * Give each tool named in `tools` that is registered from now on one more
     * input, `name` with the zod `schema`, after the inputs it declares. The
     * value reaches the tool's callback with its other arguments. Only a tool
     * that declares an input shape can take one; registering another throws.
     */
    public addArgument(name: string, schema: unknown, tools: ReadonlySet<string>): void {
        this.addedArguments.push({ name, schema, tools });
    }

    /** The id of the next call: the session's first 8 characters (`local` without a session) and a count. */
    private nextCallId(sessionId: string | undefined): string {
        this.calls += 1;
        return `${sessionId ? sessionId.slice(0, 8) : 'local'}-${this.calls}`;
    }

    public override registerTool(name: string, declared: RegisterToolConfig, cb: unknown): RegisteredTool {
        const config = this.withAddedArguments(name, declared);
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
            const context = { callId: this.nextCallId(extra?.sessionId), ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}) };
            let result: CallToolResult;
            try {
                result = await runInCallContext(context, () => original(...callArgs));
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

    /** The tool's config with the added arguments that name it appended to its input shape. */
    private withAddedArguments(tool: string, config: RegisterToolConfig): RegisterToolConfig {
        const added = this.addedArguments.filter((argument) => argument.tools.has(tool));
        if (added.length === 0) {
            return config;
        }
        const shape = config.inputSchema;
        // A zod schema object (it carries `_zod` or `_def`) is not a shape whose keys are the inputs.
        if (typeof shape !== 'object' || shape === null || '_zod' in shape || '_def' in shape) {
            throw new Error(`Tool ${tool} declares no input shape, so it cannot take ${added.map((argument) => argument.name).join(', ')}`);
        }
        const inputSchema: Record<string, unknown> = { ...(shape as Record<string, unknown>) };
        for (const argument of added) {
            inputSchema[argument.name] = argument.schema;
        }
        return { ...config, inputSchema };
    }
}
