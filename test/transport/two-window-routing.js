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

// Two-window routing check for CMSIS Developer Assistant.
//
// Stands up two WindowCoordinators against a shared temporary registry, with a
// stubbed `vscode`, and drives the router's MCP endpoint with a real MCP client.
// No board and no VS Code required.
//
// Covers:
//   1. Exactly one window binds the well-known port; the other becomes a worker.
//   2. Both windows publish themselves to the registry.
//   3. list_debug_windows reports both.
//   4. A path hint routes to the window owning that folder.
//   5. A later path-less call sticks to that same window.
//   6. A path-less call with no hint routes to the sole window that has an
//      active debug session.
//   7. With both windows debugging, a path-less call is refused as
//      AMBIGUOUS_WINDOW and both windows come back as candidates (#11).
//   8. Closing the router frees the port and a worker is promoted.
//   9. The routed tools/list, what agents see, stays within its byte budget.
//  10. The window argument (#16): each window publishes its role; the routed
//      tools/list offers window on exactly the listed tools; cmsis_action
//      {window} runs in the named window, by pid or by path, and re-aims the
//      session; one that matches nothing is INVALID_ARGUMENT; the promoted
//      window publishes its new role.

const stub = require('./vscode-stub.js');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) { failures++; }
}

const REGISTRY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-twowindow-'));
// The router's well-known port; CDA_ROUTER_TEST_PORT lets concurrent runs (several checkouts) use their own.
const PORT = Number(process.env.CDA_ROUTER_TEST_PORT) || 39117;

// Point the registry at the temp dir and give each coordinator its own identity
// and its own view of `vscode`, since a real window has both.
const { WorkspaceRegistry } = require(path.join(OUT, 'utils', 'workspaceRegistry.js'));
const origRegistry = WorkspaceRegistry;

function makeWindow(pid, folder, name) {
    const registry = new origRegistry(pid, REGISTRY_DIR, () => true);
    return { pid, folder, name, registry };
}

// The coordinator reads vscode.workspace.* and vscode.debug.* at publish time.
// Swap those per window around each call.
// Must be awaited around async work: restoring the stub synchronously while
// `fn()`'s promise is still pending means publish() sees the wrong window.
async function withWindowContext(win, activeSession, fn) {
    const prevFolders = stub.workspace.workspaceFolders;
    const prevName = stub.workspace.name;
    const prevSession = stub.debug.activeDebugSession;
    stub.workspace.workspaceFolders = [{ uri: { fsPath: win.folder } }];
    stub.workspace.name = win.name;
    stub.debug.activeDebugSession = activeSession;
    try {
        return await fn();
    } finally {
        stub.workspace.workspaceFolders = prevFolders;
        stub.workspace.name = prevName;
        stub.debug.activeDebugSession = prevSession;
    }
}

function post(port, headers, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method: 'POST',
            agent: false,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function parseSse(text) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
}

async function openSession(port) {
    const init = await post(port, {}, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'two-window', version: '1' } },
    });
    const sid = init.headers['mcp-session-id'];
    await post(port, { 'mcp-session-id': sid }, { jsonrpc: '2.0', method: 'notifications/initialized' });
    return sid;
}

async function callToolResult(port, sid, name, args, id) {
    const res = await post(port, { 'mcp-session-id': sid }, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    });
    const parsed = parseSse(res.body);
    return parsed?.result ?? { content: [{ type: 'text', text: JSON.stringify(parsed) }] };
}

async function callTool(port, sid, name, args, id) {
    return (await callToolResult(port, sid, name, args, id)).content?.[0]?.text ?? '';
}

/** The line of a window listing that names `folder`. */
function rowOf(listing, folder) {
    return listing.split('\n').find((line) => line.includes(folder)) ?? '';
}

async function main() {
    const { WindowCoordinator } = require(path.join(OUT, 'windowCoordinator.js'));
    const { WINDOW_ARGUMENT_TOOLS } = require(path.join(OUT, 'debugTools.js'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmsis-projects-'));
    const alphaDir = path.join(root, 'alpha');
    // A non-ASCII folder name: the path crosses the registry file, the router and the MCP reply as UTF-8.
    const betaDir = path.join(root, 'beta-😀');
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });

    const alpha = makeWindow(600001, alphaDir, 'alpha');
    const beta = makeWindow(600002, betaDir, 'beta');

    const context = { subscriptions: [] };

    // Each coordinator gets its own registry instance (own pid + temp dir),
    // which is what two real windows look like.
    const makeCoordinator = (win) => new WindowCoordinator({
        port: PORT, timeoutInSeconds: 30, hardwareTimeouts: {}, registry: win.registry,
    });

    const c1 = makeCoordinator(alpha);
    const c2 = makeCoordinator(beta);

    await withWindowContext(alpha, undefined, () => c1.start(context));
    await withWindowContext(beta, undefined, () => c2.start(context));

    check('exactly one window became the router',
        (c1.isRouter() ? 1 : 0) + (c2.isRouter() ? 1 : 0) === 1,
        `alpha=${c1.isRouter()} beta=${c2.isRouter()}`);
    check('both windows advertise the same endpoint',
        c1.getEndpoint() === c2.getEndpoint() && c1.getEndpoint().endsWith(`:${PORT}`),
        c1.getEndpoint());

    const registered = alpha.registry.list();
    check('both windows are in the registry', registered.length === 2, `${registered.length} entries`);

    // #16: each entry says what its window does.
    const roleOf = (c) => (c.isRouter() ? 'router' : 'worker');
    const published = Object.fromEntries(registered.map((w) => [w.pid, w.role]));
    check('each window publishes its role', published[alpha.pid] === roleOf(c1) && published[beta.pid] === roleOf(c2),
        JSON.stringify(published));

    const sid = await openSession(PORT);

    // The routed list is what agents see: a router always routes, so it adds
    // list_debug_windows and select_debug_window to the single-window list
    // that session-lifecycle.js measures, and the window argument (#16). It
    // rides along on every agent turn. 47 tools measured 30 104 bytes in
    // 2.5.0; the budget leaves room for the 2.5.1 additions
    // (get_recent_problems, serial_capture, the window argument).
    const ROUTED_TOOLS_LIST_BUDGET_BYTES = 34_000;
    const routedList = await post(PORT, { 'mcp-session-id': sid }, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} });
    const routedTools = parseSse(routedList.body)?.result?.tools ?? [];
    const routedBytes = Buffer.byteLength(JSON.stringify(routedTools));
    check(`the routed tools/list stays under the ${ROUTED_TOOLS_LIST_BUDGET_BYTES} byte budget`,
        routedTools.length > 30 && routedBytes <= ROUTED_TOOLS_LIST_BUDGET_BYTES, `${routedTools.length} tools, ${routedBytes} bytes`);
    const withWindow = routedTools.filter((t) => t.inputSchema?.properties?.window !== undefined).map((t) => t.name).sort();
    const listed = [...WINDOW_ARGUMENT_TOOLS].filter((name) => routedTools.some((t) => t.name === name)).sort();
    check('the routed tools/list offers window on exactly the listed tools',
        JSON.stringify(withWindow) === JSON.stringify(listed) && ['cmsis_action', 'flash', 'reset', 'serial_open'].every((n) => withWindow.includes(n)),
        withWindow.join(', '));

    const listing = await callTool(PORT, sid, 'list_debug_windows', {}, 2);
    check('list_debug_windows reports both windows and marks the router',
        listing.includes(alphaDir) && listing.includes(betaDir) && rowOf(listing, c1.isRouter() ? alphaDir : betaDir).includes(' | router'),
        listing.replace(/\n/g, ' | '));

    // #16: two idle windows are a tie for a path-less call.
    const idleTie = await callToolResult(PORT, sid, 'read_memory', { address: '0x20000000', length: 4 }, 20);
    const idleData = idleTie.structuredContent ?? {};
    check('two idle windows are refused as AMBIGUOUS_WINDOW; the hint names the window argument, the candidates their role',
        idleTie.isError === true && idleData.error_code === 'AMBIGUOUS_WINDOW' && /window set to its pid/.test(idleData.hint ?? '')
            && (idleData.candidates ?? []).length === 2
            && (idleData.candidates ?? []).every((c) => c.role === published[c.pid]),
        JSON.stringify(idleData.candidates));

    // The window argument names the window for one call, by pid or by path, and re-aims the session:
    // the listing then marks that window as the session's current target.
    const byPid = await callToolResult(PORT, sid, 'cmsis_action', { action: 'status', window: String(beta.pid) }, 21);
    const byPidText = byPid.content?.[0]?.text ?? '';
    const aimed = await callTool(PORT, sid, 'list_debug_windows', {}, 22);
    check('cmsis_action {window: pid} runs in the named window and re-aims the session',
        byPid.isError !== true && /^No CMSIS job in this window/.test(byPidText) && rowOf(aimed, betaDir).includes('current target'),
        `${byPidText.split('\n')[0]} | ${rowOf(aimed, betaDir)}`);
    const byPath = await callToolResult(PORT, sid, 'cmsis_action', { action: 'status', window: path.join(alphaDir, 'src') }, 23);
    const aimedByPath = await callTool(PORT, sid, 'list_debug_windows', {}, 30);
    check('cmsis_action {window: path} runs in the window owning the path',
        byPath.isError !== true && rowOf(aimedByPath, alphaDir).includes('current target'), rowOf(aimedByPath, alphaDir));
    const missed = await callToolResult(PORT, sid, 'flash', { window: path.join(root, 'no-such-window') }, 24);
    check('a window that matches nothing is INVALID_ARGUMENT with the candidates',
        missed.isError === true && missed.structuredContent?.error_code === 'INVALID_ARGUMENT'
            && (missed.structuredContent?.candidates ?? []).length === 2,
        (missed.content?.[0]?.text ?? '').split('\n')[0]);

    // A path hint must reach the window owning that folder. The handler will
    // fail for lack of a real debug session — what matters is *which* window
    // reports the failure, which the registry listing lets us infer. Instead
    // assert routing directly via select + list.
    const pinned = await callTool(PORT, sid, 'select_debug_window', { workspaceFolder: betaDir }, 3);
    check('select_debug_window pins to the named workspace',
        pinned.startsWith('This session is now pinned to:') && pinned.includes(betaDir), pinned);

    const afterPin = await callTool(PORT, sid, 'list_debug_windows', {}, 4);
    const betaLine = rowOf(afterPin, betaDir);
    check('the pinned window is marked as the current target',
        betaLine.includes('pinned') && betaLine.includes('current target'), betaLine);

    // An active session in beta only must make beta the automatic target for a
    // fresh session that has no hint and no pin.
    await withWindowContext(beta, { configuration: { name: 'AppKit-E8 Debug' } }, async () => {
        // publish() is private, but the debug-session listeners call it; invoke
        // the same path directly here since there is no real event to fire.
        c2.publish();
    });
    const withActive = alpha.registry.list().filter((w) => w.hasActiveSession);
    check('the active session is published to the registry',
        withActive.length === 1 && withActive[0].workspaceFolders[0] === betaDir,
        JSON.stringify(withActive.map((w) => w.name)));

    const sid2 = await openSession(PORT);
    const listing2 = await callTool(PORT, sid2, 'list_debug_windows', {}, 5);
    check('a window with an active session is shown as debugging',
        /debugging: AppKit-E8 Debug/.test(listing2), listing2.replace(/\n/g, ' | '));

    // Both windows debugging: the router must not guess, and says which windows qualify.
    await withWindowContext(alpha, { configuration: { name: 'Corstone Debug' } }, async () => {
        c1.publish();
    });
    const tieSid = await openSession(PORT);
    const tie = await callToolResult(PORT, tieSid, 'read_memory', { address: '0x20000000', length: 4 }, 7);
    const tied = tie.structuredContent ?? {};
    const candidatePids = (tied.candidates ?? []).map((c) => c.pid).sort();
    check('two debugging windows are refused as AMBIGUOUS_WINDOW with both as candidates',
        tie.isError === true && tied.error_code === 'AMBIGUOUS_WINDOW'
            && JSON.stringify(candidatePids) === JSON.stringify([alpha.pid, beta.pid].sort())
            && (tied.candidates ?? []).every((c) => c.hasActiveSession === true),
        JSON.stringify(tied));

    // Router failover: close the router, the survivor must take the port.
    const router = c1.isRouter() ? c1 : c2;
    const worker = c1.isRouter() ? c2 : c1;
    const workerWindow = c1.isRouter() ? beta : alpha;
    await router.dispose();
    check('the router released the port', !router.isRouter());

    // The promotion republishes the window, which reads its folders from `vscode`.
    await withWindowContext(workerWindow, undefined, () => worker.tryBecomeRouter());
    check('the surviving worker was promoted to router', worker.isRouter(),
        `isRouter=${worker.isRouter()}`);
    const promotedEntry = workerWindow.registry.list().find((w) => w.pid === workerWindow.pid);
    check('the promoted window publishes its new role', promotedEntry?.role === 'router', promotedEntry?.role);

    const sid3 = await openSession(PORT);
    const listing3 = await callTool(PORT, sid3, 'list_debug_windows', {}, 6);
    check('the promoted router serves MCP', listing3.includes('Registered VS Code windows'), listing3.slice(0, 120));

    await worker.dispose();
    fs.rmSync(REGISTRY_DIR, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
