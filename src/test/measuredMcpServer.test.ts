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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MeasuredMcpServer, toCallToolResult } from '../core/measuredMcpServer';
import { ToolMetrics } from '../core/toolMetrics';
import { ToolError, ToolText } from '../core/toolResult';

/**
 * The MCP boundary (#11): every outcome a handler can have, as the client
 * receives it through a real MCP session, and the metrics outcome read from
 * the status rather than from the wording.
 */
suite('MeasuredMcpServer results', () => {
    let metrics: ToolMetrics;
    let client: Client;
    let server: MeasuredMcpServer;
    let reached: string[];

    /** One tool per outcome under test; each answers what `outcomes` holds for its name. */
    const outcomes: Record<string, () => Promise<ToolText>> = {
        plain: async () => 'all good',
        cap_text: async () => '\'x\' did not complete within 5 ms (handler-level cap).',
        ok_with_data: async () => ({ text: 'listed', status: 'ok', data: { count: 2 } }),
        ok_without_data: async () => ({ text: 'listed', status: 'ok' }),
        waiting: async () => ({ text: 'Target did not stop within the timeout.', status: 'timeout' }),
        building: async () => ({ text: 'still building', status: 'running', data: { status: 'hijacked', task: 'cbuild' } }),
        refused: async () => {
            throw new ToolError('AMBIGUOUS_WINDOW', 'Two windows qualify.', 'Pick one with select_debug_window.', { candidates: [{ pid: 1 }, { pid: 2 }] });
        },
        stuck: async () => {
            throw new ToolError('TIMEOUT', '\'read_memory\' did not complete within 100 ms (handler-level cap).');
        },
        plain_error: async () => {
            throw new Error('No active debug session.');
        },
    };

    setup(async () => {
        metrics = new ToolMetrics();
        reached = [];
        server = new MeasuredMcpServer({ name: 'measured-test', version: '1.0.0' }, {}, metrics);
        for (const [name, outcome] of Object.entries(outcomes)) {
            server.registerTool(name, { description: name }, async () => {
                reached.push(name);
                return toCallToolResult(await outcome());
            });
        }
        server.registerTool('typed_args', { description: 'needs a number', inputSchema: { n: z.number() } }, async () => {
            reached.push('typed_args');
            return toCallToolResult('fine');
        });
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        client = new Client({ name: 'measured-test', version: '1.0.0' });
        await client.connect(clientEnd);
    });

    teardown(async () => {
        await client.close();
        await server.close();
    });

    const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
        await client.callTool({ name, arguments: args }) as CallToolResult;
    const textOfResult = (result: CallToolResult): string =>
        result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
    const lastOutcome = (): string => metrics.samples().slice(-1)[0].outcome;

    test('a string is its text alone: no isError, no structuredContent', async () => {
        const result = await call('plain');
        assert.strictEqual(textOfResult(result), 'all good');
        assert.strictEqual(result.isError, undefined);
        assert.strictEqual(result.structuredContent, undefined);
        assert.strictEqual(lastOutcome(), 'ok');
    });

    test('a ToolError is isError, [CODE] message and hint, and structuredContent with its data', async () => {
        const result = await call('refused');
        assert.strictEqual(result.isError, true);
        assert.strictEqual(textOfResult(result), '[AMBIGUOUS_WINDOW] Two windows qualify.\nPick one with select_debug_window.');
        assert.deepStrictEqual(result.structuredContent, {
            status: 'error', error_code: 'AMBIGUOUS_WINDOW', message: 'Two windows qualify.', hint: 'Pick one with select_debug_window.',
            candidates: [{ pid: 1 }, { pid: 2 }],
        });
        assert.strictEqual(lastOutcome(), 'error');
    });

    test('a plain Error thrown by a handler gets a classified code instead of the SDK\'s bare message', async () => {
        const result = await call('plain_error');
        assert.strictEqual(result.isError, true);
        assert.strictEqual(textOfResult(result), '[NO_SESSION] No active debug session.');
        assert.deepStrictEqual(result.structuredContent, { status: 'error', error_code: 'NO_SESSION', message: 'No active debug session.' });
    });

    test('a reply that is running or out of time carries its status and message, and is not an error', async () => {
        const waiting = await call('waiting');
        assert.strictEqual(waiting.isError, undefined);
        assert.strictEqual(textOfResult(waiting), 'Target did not stop within the timeout.');
        assert.deepStrictEqual(waiting.structuredContent, { status: 'timeout', message: 'Target did not stop within the timeout.' });
        assert.strictEqual(lastOutcome(), 'timeout');

        // A data key never overwrites the status or the message.
        const building = await call('building');
        assert.deepStrictEqual(building.structuredContent, { status: 'running', message: 'still building', task: 'cbuild' });
        assert.strictEqual(lastOutcome(), 'ok');
    });

    test('an ok reply carries structuredContent only when it has data', async () => {
        assert.deepStrictEqual((await call('ok_with_data')).structuredContent, { status: 'ok', count: 2 });
        const bare = await call('ok_without_data');
        assert.strictEqual(bare.structuredContent, undefined);
        assert.strictEqual(textOfResult(bare), 'listed');
    });

    test('the metrics outcome comes from the status first, the wording only without one', async () => {
        await call('stuck');
        assert.strictEqual(lastOutcome(), 'timeout', 'a TIMEOUT error counts as a timeout');
        await call('cap_text');
        assert.strictEqual(lastOutcome(), 'timeout', 'a text without status falls back to the markers');
        const stuck = metrics.totals().perTool.stuck;
        assert.deepStrictEqual([stuck.timeouts, stuck.errors], [1, 0]);
    });

    test('schema errors stay the SDK\'s and never reach the handler', async () => {
        const result = await call('typed_args', { n: 'not a number' });
        assert.strictEqual(result.isError, true);
        assert.match(textOfResult(result), /Input validation error/);
        assert.deepStrictEqual(reached, []);
    });

    test('no tool declares an outputSchema', async () => {
        const listed = await client.listTools();
        assert.ok(listed.tools.length > 0);
        assert.deepStrictEqual(listed.tools.filter((tool) => tool.outputSchema !== undefined).map((tool) => tool.name), []);
    });
});

/**
 * An input a session adds to some of its tools (#16: the router's `window`):
 * it joins the named tools after their own inputs and reaches their callback.
 */
suite('MeasuredMcpServer added arguments', () => {
    let client: Client;
    let server: MeasuredMcpServer;
    let received: unknown[];

    setup(async () => {
        received = [];
        server = new MeasuredMcpServer({ name: 'added-test', version: '1.0.0' }, {}, new ToolMetrics());
        server.addArgument('window', z.string().optional().describe('Which window'), new Set(['aimed', 'bare']));
        const keep = async (args: unknown): Promise<CallToolResult> => {
            received.push(args);
            return toCallToolResult('fine');
        };
        server.registerTool('aimed', { description: 'takes the argument', inputSchema: { n: z.number() } }, keep);
        server.registerTool('plain', { description: 'does not', inputSchema: { n: z.number() } }, keep);
        const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
        await server.connect(serverEnd);
        client = new Client({ name: 'added-test', version: '1.0.0' });
        await client.connect(clientEnd);
    });

    teardown(async () => {
        await client.close();
        await server.close();
    });

    test('the named tools list it after their own inputs; the others do not', async () => {
        const listed = await client.listTools();
        const properties = (name: string): string[] => Object.keys(listed.tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {});
        assert.deepStrictEqual(properties('aimed'), ['n', 'window']);
        assert.deepStrictEqual(properties('plain'), ['n']);
    });

    test('its value reaches the callback with the other arguments', async () => {
        await client.callTool({ name: 'aimed', arguments: { n: 1, window: '4711' } });
        await client.callTool({ name: 'aimed', arguments: { n: 2 } });
        assert.deepStrictEqual(received, [{ n: 1, window: '4711' }, { n: 2 }]);
    });

    test('a named tool without an input shape cannot take it', () => {
        assert.throws(() => server.registerTool('bare', { description: 'no inputs' }, async () => toCallToolResult('fine')),
            /Tool bare declares no input shape, so it cannot take window/);
    });
});
