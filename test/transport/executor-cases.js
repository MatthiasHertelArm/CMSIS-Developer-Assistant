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

// Executor characterization cases (issue #53).
//
// Runs the cases listed in docs/provenance/specs/debuggingExecutor.md against
// out/src/debuggingExecutor.js with scripted fake debug sessions: DAP request
// shapes, fallbacks, timeouts, reset verification and the memory-read ladder.
// Complements dap-scenarios.js, which drives the executor through the handler.
//
//   node test/transport/executor-cases.js
const path = require('path');
const stub = require('./vscode-stub.js');

const factories = [];
stub.debug.registerDebugAdapterTrackerFactory = (_t, f) => { factories.push(f); return { dispose() {} }; };
stub.debug.startDebugging = async () => true;
stub.debug.stopDebugging = async () => {};
const addLog = [];
const removeLog = [];
stub.debug.addBreakpoints = (bps) => { addLog.push(bps); stub.debug.breakpoints = [...stub.debug.breakpoints, ...bps]; };
stub.debug.removeBreakpoints = (bps) => { removeLog.push(bps); stub.debug.breakpoints = stub.debug.breakpoints.filter((b) => !bps.includes(b)); };
const commandLog = [];
stub.commands.executeCommand = async (command, ...args) => { commandLog.push({ command, args }); return stub.commandHandlers[command]?.(...args); };

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const tracker = require(path.join(OUT, 'utils', 'sessionStateTracker.js'));
tracker.registerSessionStateTracker({ subscriptions: [] });
const { DebuggingExecutor, SERVER_VERSION, DEFAULT_HARDWARE_TIMEOUTS } = require(path.join(OUT, 'debuggingExecutor.js'));
const { HardwareTimeoutError } = require(path.join(OUT, 'utils', 'timeout.js'));
const { Budgets } = require(path.join(OUT, 'executor', 'common.js'));
const { unsupportedResetDetail } = require(path.join(OUT, 'core', 'resetAssist.js'));
const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));

let failures = 0;
let passes = 0;
function check(name, cond, detail) {
    if (cond) { passes++; console.log(`  ok   ${name}`); }
    else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const le = (w) => { const b = Buffer.alloc(4); b.writeUInt32LE(w >>> 0); return b; };

let seq = 0;
const trackers = [];
/** A fake session; `answer(command, args)` returns a promise or value. */
function makeSession(answer, config = { type: 'gdbtarget', name: 'Cfg' }, name = 'S') {
    const calls = [];
    const session = {
        id: `s${++seq}`, name, type: config.type, configuration: config,
        customRequest(command, args) {
            calls.push({ command, json: JSON.stringify(args), args });
            try {
                const r = answer(command, args, calls);
                return r instanceof Promise ? r : Promise.resolve(r);
            } catch (e) { return Promise.reject(e); }
        },
    };
    return { session, calls };
}
function focusOn(session) { stub.debug.activeDebugSession = session; }
function trackerFor(session) {
    const t = factories[0].createDebugAdapterTracker(session);
    trackers.push(t);
    return t;
}
function event(t, ev, body = {}) { t.onDidSendMessage({ type: 'event', event: ev, body }); }
function reset() {
    for (const t of trackers.splice(0)) { t.onWillStopSession(); }
    stub.debug.activeDebugSession = undefined;
    stub.debug.activeStackItem = undefined;
    stub.debug.breakpoints = [];
    addLog.length = 0; removeLog.length = 0; commandLog.length = 0;
    stub.commandHandlers = {};
    stub.workspace.workspaceFolders = [];
    stub.workspace.openTextDocument = async () => { throw new Error('not stubbed'); };
}
async function rejects(p) { try { await p; return undefined; } catch (e) { return e; } }

async function main() {
    console.log(`SERVER_VERSION ${SERVER_VERSION} package ${pkg.version}`);
    check('SERVER_VERSION equals package.json', SERVER_VERSION === pkg.version);
    check('DEFAULT_HARDWARE_TIMEOUTS', eq(DEFAULT_HARDWARE_TIMEOUTS, { dapRequestMs: 10000, memoryReadMs: 30000 }));

    // Budgets
    const bud = new Budgets({ dapRequestMs: 80, memoryReadMs: 30000 });
    check('budget 0/-1/NaN/undefined/null → fallback', [0, -1, NaN, undefined, null, Infinity].every((v) => bud.request(v) === 80));
    const big = new Budgets({ dapRequestMs: 90000, memoryReadMs: 30000 });
    check('fallback not capped, override capped', big.request() === 90000 && big.request(90000) === 60000 && big.request(5) === 5);
    check('probe = min(dap, 3000)', bud.probe() === 80 && big.probe() === 3000);
    check('stopWait default 60000, capped', bud.stopWait() === 60000 && bud.stopWait(70000) === 60000 && bud.stopWait(1234) === 1234);
    check('operation', bud.operation() === 30000 && bud.operation(100) === 100);

    // ── Run control ──
    reset();
    {
        const { session, calls } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 7, frameId: 70 };
        const ex = new DebuggingExecutor();
        await ex.stepOver();
        check('RC1 stepOver with frame item threadId 7', calls.length === 1 && calls[0].command === 'next' && calls[0].json === '{"threadId":7}' && commandLog.length === 0, calls);
        stub.debug.activeStackItem = undefined;
        calls.length = 0;
        await ex.stepOver();
        check('RC1 no stack item → threadId 1', calls[0].json === '{"threadId":1}');
    }
    reset();
    {
        const pairs = [['stepOver', 'next', 'workbench.action.debug.stepOver'], ['stepInto', 'stepIn', 'workbench.action.debug.stepInto'],
            ['stepOut', 'stepOut', 'workbench.action.debug.stepOut'], ['continue', 'continue', 'workbench.action.debug.continue'],
            ['pause', 'pause', 'workbench.action.debug.pause']];
        for (const [method, dap, ui] of pairs) {
            reset();
            const { session, calls } = makeSession(() => { throw new Error('Cannot execute this command while the target is running'); });
            focusOn(session);
            const ex = new DebuggingExecutor();
            const r = await rejects(ex[method]());
            check(`RC2 ${method} falls back to ${ui}`, r === undefined && calls.length === 1 && calls[0].command === dap
                && commandLog.length === 1 && commandLog[0].command === ui && commandLog[0].args.length === 0, { r: String(r), commandLog });
        }
        reset();
        const { session } = makeSession(() => { throw new Error('x'); });
        focusOn(session);
        stub.commandHandlers['workbench.action.debug.stepOver'] = () => { throw new Error('ui boom'); };
        const r = await rejects(new DebuggingExecutor().stepOver());
        check('RC2 UI command rejection propagates unwrapped', r && r.message === 'ui boom', String(r));
    }
    reset();
    {
        const { session } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 80 });
        const e1 = await rejects(ex.stepOver(50));
        check('RC3 stepOver(50) → HardwareTimeoutError 50 DAP next', e1 instanceof HardwareTimeoutError && e1.timeoutMs === 50 && e1.operation === 'DAP next' && commandLog.length === 0, String(e1));
        for (const v of [0, -1, NaN]) {
            const e = await rejects(ex.stepOver(v));
            check(`RC3 stepOver(${v}) → 80`, e instanceof HardwareTimeoutError && e.timeoutMs === 80);
        }
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        let threw = false;
        try { ex.armStopWaiter(1000); } catch { threw = true; }
        check('RC4 armStopWaiter throws synchronously without a session', threw);
        check('RC4 stepOver rejects', (await rejects(ex.stepOver())) instanceof Error);
        check('RC4 waitForStop rejects', (await rejects(ex.waitForStop())) instanceof Error);
        const e = await rejects(ex.getDeviceInfo());
        console.log(`       S1 text: ${e.message}`);
    }
    reset();
    {
        const { session } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        const ex = new DebuggingExecutor();
        check('RC5 already stopped', eq(await ex.waitForStop(), { kind: 'already-stopped', reason: null }));
        const t = trackerFor(session);
        event(t, 'continued', { threadId: 1 });
        const p = ex.waitForStop(2000);
        setTimeout(() => event(t, 'stopped', { reason: 'breakpoint', threadId: 3 }), 20);
        check('RC5 stopped after continued', eq(await p, { kind: 'stopped', reason: 'breakpoint', threadId: 3 }));
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        await ex.restart();
        check('RC6 restart without session', commandLog.length === 1 && commandLog[0].command === 'workbench.action.debug.restart' && commandLog[0].args.length === 0);
        stub.commandHandlers['workbench.action.debug.restart'] = () => { throw new Error('nope'); };
        const e = await rejects(ex.restart());
        console.log(`       S6 text: ${e && e.message}`);
    }

    // ── Session and status ──
    reset();
    {
        const started = [];
        stub.debug.startDebugging = async (folder, cfg) => { started.push({ folder: folder?.uri?.fsPath, cfg }); return true; };
        const f = (p) => ({ uri: stub.Uri.file(p), name: p, index: 0 });
        stub.workspace.workspaceFolders = [f('/w/a'), f('/w/b')];
        const ex = new DebuggingExecutor();
        await ex.startDebuggingByName('/w/a/', 'Cfg');
        check('SS1 /w/a/ → /w/a with name', started.length === 1 && started[0].folder === '/w/a' && started[0].cfg === 'Cfg', started);
        started.length = 0;
        await ex.startDebuggingByName('/w', 'Cfg');
        check('SS1 /w → /w/a', started[0]?.folder === '/w/a', started);
        const e = await rejects(ex.startDebuggingByName('/x', 'Cfg'));
        const s4 = "No VS Code workspace folder matches workingDirectory '/x'. Open workspace folders: /w/a, /w/b. launch.json is resolved relative to an open workspace folder — open the project folder (the one containing .vscode/launch.json) in this VS Code window.";
        check('SS1 /x two folders → S3(S4)', e && e.message === `Failed to start debugging with configuration 'Cfg': Error: ${s4}`, e && e.message);
        stub.workspace.workspaceFolders = [];
        const e2 = await rejects(ex.startDebuggingByName('/x', 'Cfg'));
        check('SS1 no folders → (none)', e2 && e2.message.includes('Open workspace folders: (none).'), e2 && e2.message);
        stub.workspace.workspaceFolders = [f('/w/a')];
        started.length = 0;
        await ex.startDebuggingByName('/x', 'Cfg');
        check('SS1 one folder fallback', started[0]?.folder === '/w/a');
        stub.workspace.workspaceFolders = [f('/w/a\\'), f('/w/b')];
        started.length = 0;
        stub.workspace.getWorkspaceFolder = () => undefined;
        await ex.startDebuggingByName('/w/b//', 'Cfg');
        check('SS1 trailing separators stripped', started[0]?.folder === '/w/b', started);
        delete stub.workspace.getWorkspaceFolder;
        stub.workspace.getWorkspaceFolder = function (uri) { return stub.workspace.workspaceFolders.find((fo) => String(uri.fsPath).startsWith(fo.uri.fsPath)); };
        stub.debug.startDebugging = async () => { throw new Error('launch boom'); };
        const e3 = await rejects(ex.startDebugging('/w/a', { name: 'x' }));
        console.log(`       S2 text: ${e3 && e3.message}`);
        stub.debug.startDebugging = async () => true;
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        const st = await ex.getSessionStatus();
        check('SS2 no-session object', eq(st, { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null }) && !('detail' in st), st);
        check('SS2 S28', (await ex.checkTargetConnection()) === 'No active debug session.');
    }
    reset();
    {
        const { session } = makeSession(never, { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 200 });
        const st = await ex.getSessionStatus();
        check('SS3 unresponsive', st.state === 'unresponsive' && st.detail === 'DAP threads probe timed out after 200ms — probe/target may be hung.' && st.dapProbeMs === null && st.dapResponsive === false, st);
        const txt = await ex.checkTargetConnection();
        check('SS3 check text', txt === 'Session: Sess (type=gdbtarget)\nConfiguration: Cfg\nDAP probe: TIMEOUT — probe/target unresponsive\nDAP threads probe timed out after 200ms — probe/target may be hung.', txt);
    }
    reset();
    {
        const { session } = makeSession(() => { throw new Error('boom'); }, { type: 'gdbtarget' }, 'Sess');
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 200 });
        const st = await ex.getSessionStatus();
        check('SS3 initializing', st.state === 'initializing' && st.detail === 'DAP threads probe failed: boom', st);
        const txt = await ex.checkTargetConnection();
        check('SS3 check text S32, no config line', txt === 'Session: Sess (type=gdbtarget)\nDAP probe: FAILED — adapter likely still initializing\nDAP threads probe failed: boom', txt);
    }
    reset();
    {
        const { session } = makeSession(() => ({ threads: [] }), { type: 'gdbtarget', name: 'Cfg' }, 'Sess');
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 5 };
        const ex = new DebuggingExecutor();
        const st = await ex.getSessionStatus();
        check('SS4 stopped', st.state === 'stopped' && st.dapResponsive === true && typeof st.dapProbeMs === 'number' && 'detail' in st && st.detail === undefined, st);
        const txt = await ex.checkTargetConnection();
        check('SS4 text', /^Session: Sess \(type=gdbtarget\)\nConfiguration: Cfg\nDAP probe: OK \(\d+ms\)\nTarget state: stopped — full inspection is available\.$/.test(txt), txt);
        const t = trackerFor(session);
        event(t, 'stopped', { reason: 'step', threadId: 1 });
        const st2 = await ex.getSessionStatus();
        check('SS4 stopped reason', st2.detail === 'Stopped reason: step', st2);
        event(t, 'continued', {});
        const txt2 = await ex.checkTargetConnection();
        check('SS4 running text', txt2.endsWith('Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.'), txt2);
    }
    reset();
    {
        const ex0 = new DebuggingExecutor();
        check('SS5 hasActiveSession no session', (await ex0.hasActiveSession()) === false);
        const { session, calls } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 150 });
        const t0 = Date.now();
        check('SS5 probe timeout → false', (await ex.hasActiveSession()) === false && Date.now() - t0 >= 140 && Date.now() - t0 < 1000, Date.now() - t0);
        check('SS5 one threads {}', calls.length === 1 && calls[0].command === 'threads' && calls[0].json === '{}');
    }
    reset();
    {
        const { session } = makeSession(() => { throw new Error('x'); });
        focusOn(session);
        check('SS5 error → false', (await new DebuggingExecutor().hasActiveSession()) === false);
        reset();
        const s2 = makeSession(() => ({ threads: [] }));
        focusOn(s2.session);
        stub.debug.activeStackItem = { session: s2.session, threadId: 1, frameId: 1 };
        check('SS5 success → stopped', (await new DebuggingExecutor().hasActiveSession()) === true);
        stub.debug.activeStackItem = undefined;
        check('SS5 success → not stopped', (await new DebuggingExecutor().hasActiveSession()) === false);
    }
    reset();
    {
        const { session } = makeSession(() => undefined, { type: 'gdbtarget' }, 'Live');
        trackerFor(session);
        const d = new DebuggingExecutor().getDiagnostics();
        check('SS6 diagnostics', d.serverVersion === SERVER_VERSION && d.liveSessionCount === 1 && eq(d.liveSessionNames, ['Live']) && d.hasVscodeActiveSession === false, d);
        focusOn(session);
        check('SS6 active set', new DebuggingExecutor().getDiagnostics().hasVscodeActiveSession === true);
    }

    // ── Breakpoints and GDB ──
    reset();
    {
        const ex = new DebuggingExecutor();
        const uri = stub.Uri.file('/w/src/main.c');
        await ex.addBreakpoint(uri, 12, { condition: 'x > 3' });
        const bp = addLog[0]?.[0];
        check('BP1 add', addLog.length === 1 && bp instanceof stub.SourceBreakpoint && bp.location.range.start.line === 11 && bp.location.range.start.character === 0
            && bp.enabled === true && bp.condition === 'x > 3' && bp.hitCondition === undefined && bp.logMessage === undefined, bp);
        await ex.removeBreakpoint(stub.Uri.file('/w/src/other.c'), 12);
        check('BP1 no remove call when none match', removeLog.length === 0);
        const fb = new stub.FunctionBreakpoint();
        stub.debug.breakpoints = [...stub.debug.breakpoints, fb];
        await ex.addBreakpoint(uri, 13);
        await ex.removeBreakpoint(uri, 12);
        check('BP1 remove exactly one', removeLog.length === 1 && removeLog[0].length === 1 && removeLog[0][0] === bp, removeLog);
        check('BP getBreakpoints is the array itself', ex.getBreakpoints() === stub.debug.breakpoints);
        ex.clearAllBreakpoints();
        check('BP clearAll one call incl function bp', removeLog.length === 2 && removeLog[1].length === 2 && stub.debug.breakpoints.length === 0, removeLog[1]);
        ex.clearAllBreakpoints();
        check('BP clearAll empty → no call', removeLog.length === 2);
    }
    reset();
    {
        let reply = { result: ' Breakpoint 2 at 0x8000100: file main.c, line 42. \n' };
        const { session, calls } = makeSession((c) => c === 'stackTrace' ? { stackFrames: [] } : (typeof reply === 'function' ? reply() : reply));
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 2, frameId: 5 };
        const ex = new DebuggingExecutor();
        const r = await ex.setBreakpointViaGdb('/w/main.c', 42, undefined, '  x > 3 ');
        check('BP2 requests', calls.length === 2 && calls[0].command === 'stackTrace' && calls[0].json === '{"threadId":2,"startFrame":0,"levels":50}'
            && calls[1].command === 'evaluate' && calls[1].json === '{"expression":"-exec break /w/main.c:42 if x > 3","context":"repl","frameId":5}', calls.map((c) => c.command + ' ' + c.json));
        check('BP3 trimmed text', r === 'Breakpoint 2 at 0x8000100: file main.c, line 42.', r);
        stub.debug.activeStackItem = undefined;
        calls.length = 0;
        await ex.setBreakpointViaGdb('/w/main.c', 42);
        check('BP2 no stack item: no stackTrace, no frameId', calls.length === 1 && calls[0].json === '{"expression":"-exec break /w/main.c:42","context":"repl"}', calls.map((c) => c.json));
        reply = () => { throw new Error(' could not evaluate expression '); };
        check('BP3 rejection → text', (await ex.clearAllBreakpointsViaGdb()) === 'could not evaluate expression');
        reply = { result: undefined };
        check('BP3 absent result → empty', (await ex.clearAllBreakpointsViaGdb()) === '');
        calls.length = 0;
        reply = {};
        await ex.setLogpointViaGdb('/w/m.c', 7, 'n=%d\\n', ['n', 'p->x']);
        await ex.setLogpointViaGdb('/w/m.c', 7, 'tick', []);
        await ex.setBreakpointConditionViaGdb(3, 'i == 2');
        await ex.clearBreakpointViaGdb('/w/m.c', 9);
        await ex.clearAllBreakpointsViaGdb();
        const exprs = calls.map((c) => c.args.expression);
        check('BP4 commands', eq(exprs, ['-exec dprintf /w/m.c:7,"n=%d\\n",n,p->x', '-exec dprintf /w/m.c:7,"tick"', '-exec condition 3 i == 2', '-exec clear /w/m.c:9', '-exec delete']), exprs);
        reply = never;
        const ex2 = new DebuggingExecutor({ dapRequestMs: 60 });
        check('BP3 hang → HardwareTimeoutError', (await rejects(ex2.clearAllBreakpointsViaGdb())) instanceof HardwareTimeoutError);
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        const uri = stub.Uri.file('/w/src/main.c');
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(uri, new stub.Position(11, 0)), true, 'x'), new stub.FunctionBreakpoint()];
        const noSession = await ex.getCurrentDebugState();
        check('BP5 breakpoints without session', eq(noSession.breakpoints, ['main.c:12 [when: x]']) && noSession.sessionActive === false, noSession.breakpoints);
        const { session, calls } = makeSession(() => ({ stackFrames: [{ id: 1000, name: 'main', source: { path: '/w/src/main.c' }, line: 40, column: 0 }, { id: 1001, name: '', source: { name: 'x.c' }, line: 0 }] }), { type: 'gdbtarget', name: 'Cfg' });
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 1000 };
        const st = await ex.getCurrentDebugState();
        check('BP5 frame, location null when open fails', st.frameName === 'main' && st.currentLine === null && st.fileName === null && st.frameId === 1000 && st.threadId === 1
            && st.configurationName === 'Cfg' && eq(st.stackTrace, [{ name: 'main', source: '/w/src/main.c', line: 40 }, { name: 'unknown', source: 'x.c' }]), st);
        check('BP5 stackTrace args', calls[0].json === '{"threadId":1,"startFrame":0,"levels":50}');
        const lines = ['int main(void) {', '', '  a();  ', '', '   b();', 'c();', '}'];
        stub.workspace.openTextDocument = async () => ({ lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }) });
        const st2 = await ex.getCurrentDebugState();
        check('BP5 location', st2.currentLine === 40 && st2.fileName === 'main.c' && st2.fileFullPath === '/w/src/main.c' && st2.currentLineContent === '}' && eq(st2.nextLines, []), st2);
        session.customRequest = (c, a) => { calls.push({ command: c, json: JSON.stringify(a) }); return Promise.resolve({ stackFrames: [{ id: 1, name: 'f', source: { path: 'C:\\w\\m.c' }, line: 1 }] }); };
        const st3 = await ex.getCurrentDebugState(2);
        check('BP5 lookahead 2 skips empty, windows path', st3.currentLineContent === 'int main(void) {' && eq(st3.nextLines, ['a();', 'b();']) && st3.fileName === 'm.c', st3);
    }

    // ── Memory ──
    reset();
    {
        let mem = (c, a) => ({ data: b64([1, 2, 3, 4, 5, 6, 7, 8]) });
        const { session, calls } = makeSession((c, a) => mem(c, a));
        focusOn(session);
        const ex = new DebuggingExecutor();
        const buf = await ex.readMemory('20000000', 8);
        check('M1 readMemory args', calls[0].json === '{"memoryReference":"0x20000000","count":8}' && eq([...buf], [1, 2, 3, 4, 5, 6, 7, 8]), calls[0].json);
        mem = () => ({ data: b64([1, 2, 3, 4]) });
        check('M1 short reply returned', (await ex.readMemory('0X20000000', 8)).length === 4 && calls[1].json === '{"memoryReference":"0X20000000","count":8}');
    }
    reset();
    {
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') { throw new Error('unrecognized request'); }
            if (c === 'evaluate' && a.expression === '*(unsigned int*)0x20000000') { return { result: '0x04030201' }; }
            if (c === 'evaluate' && a.expression === '*(unsigned int*)0x20000004') { return { result: '0x08070605' }; }
            throw new Error('unexpected');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const buf = await ex.readMemory('0x20000000', 6);
        check('M2 fallback bytes', eq([...buf], [1, 2, 3, 4, 5, 6]), [...buf]);
        check('M2 requests', eq(calls.map((c) => c.command + ' ' + c.json), [
            'readMemory {"memoryReference":"0x20000000","count":6}',
            'evaluate {"expression":"*(unsigned int*)0x20000000","context":"watch"}',
            'evaluate {"expression":"*(unsigned int*)0x20000004","context":"watch"}']), calls.map((c) => c.command + ' ' + c.json));
        calls.length = 0;
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 9 };
        await ex.readMemory('0x20000000', 6);
        check('M2 with frame: one lookup then frameId', eq(calls.map((c) => c.command), ['readMemory', 'stackTrace', 'evaluate', 'evaluate']) && calls[2].args.frameId === 9 && calls[3].args.frameId === 9, calls.map((c) => c.command + ' ' + c.json));
        calls.length = 0;
        const e = await rejects(ex.readMemory('0xZZ', 4));
        check('M2 BigInt SyntaxError', e instanceof SyntaxError, String(e));
        const upper = [];
        session.customRequest = (c, a) => { upper.push(a.memoryReference ?? a.expression); if (c === 'readMemory') { return Promise.reject(new Error('x')); } return Promise.resolve({ result: '1' }); };
        await ex.readMemory('0xE000ED28', 8);
        check('M2 ladder addresses lower-case', eq(upper.filter((x) => typeof x === 'string' && x.startsWith('*')), ['*(unsigned int*)0xe000ed28', '*(unsigned int*)0xe000ed2c']), upper);
    }
    reset();
    {
        let script;
        const { session, calls } = makeSession((c, a) => script(c, a));
        focusOn(session);
        stub.debug.activeStackItem = { session, threadId: 1, frameId: 3 };
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        script = (c, a) => {
            if (c === 'readMemory') { throw new Error('x'); }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.context === 'watch') { return { result: 'garbage' }; }
            if (a.expression.startsWith('-exec x/1xw')) { return { result: '0x20000000:\t0x000000ff' }; }
            throw new Error('?');
        };
        check('M3 x/1xw → 255', (await ex.readMemoryWord('0x20000000')) === 255);
        script = (c, a) => {
            if (c === 'readMemory') { throw new Error('x'); }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.expression.startsWith('-exec print/x')) { return { result: '$1 = 0x10' }; }
            return { result: 'Error: could not evaluate expression' };
        };
        calls.length = 0;
        check('M3 print/x → 16', (await ex.readMemoryWord('0x20000000')) === 16);
        check('M3 ladder requests', eq(calls.map((c) => c.command + ' ' + c.json), [
            'readMemory {"memoryReference":"0x20000000","count":4}',
            'stackTrace {"threadId":1,"startFrame":0,"levels":50}',
            'evaluate {"expression":"*(unsigned int*)0x20000000","context":"watch","frameId":3}',
            'evaluate {"expression":"-exec x/1xw 0x20000000","context":"repl","frameId":3}',
            'evaluate {"expression":"-exec print/x *(unsigned int*)0x20000000","context":"repl","frameId":3}']), calls.map((c) => c.command + ' ' + c.json));
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } throw new Error('nope'); };
        const e = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 all fail → S11', e && e.message === 'Failed to read memory at 0x20000000 — all GDB strategies exhausted', e && e.message);
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } if (c === 'readMemory') { throw new Error('x'); } return never(); };
        calls.length = 0;
        const e2 = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 strategy-1 timeout → HardwareTimeoutError, no further request', e2 instanceof HardwareTimeoutError && calls.filter((c) => c.command === 'evaluate').length === 1, calls.map((c) => c.command));
        script = (c) => { if (c === 'stackTrace') { return { stackFrames: [] }; } if (c === 'readMemory') { return { data: b64([1, 2]) }; } return { result: '-7 <sym>' }; };
        check('M3 short data → ladder, negative decimal kept', (await ex.readMemoryWord('0x20000000')) === -7);
        script = (c) => { if (c === 'readMemory') { return {}; } if (c === 'stackTrace') { return { stackFrames: [] }; } return { result: ' 42 junk' }; };
        check('M3 no data → ladder decimal 42', (await ex.readMemoryWord('0x20000000')) === 42);
        script = () => never();
        const e3 = await rejects(ex.readMemoryWord('0x20000000'));
        check('M3 readMemory timeout rethrown', e3 instanceof HardwareTimeoutError && e3.operation === 'DAP readMemory');
    }
    reset();
    {
        const { session } = makeSession(never);
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 1000, memoryReadMs: 100 });
        const t0 = Date.now();
        const e = await rejects(ex.readMemory('0x20000000', 16));
        const dt = Date.now() - t0;
        check('M4 fence readMemory ~100ms', e instanceof HardwareTimeoutError && e.operation === 'readMemory' && dt < 400, `${e} ${dt}`);
        const e2 = await rejects(new DebuggingExecutor().readMemory('0x20000000', 16));
        reset();
        const e3 = await rejects(new DebuggingExecutor().readMemory('0x20000000', 16));
        check('M4 no session rejects before fence (plain Error)', e3 && !(e3 instanceof HardwareTimeoutError), String(e3));
        void e2;
    }
    reset();
    {
        const words = new Map();
        let writeFails = false;
        let stick = true;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'writeMemory') { if (writeFails) { throw new Error('no write'); } if (stick) { words.set(a.memoryReference, Buffer.from(a.data, 'base64').readUInt32LE(0)); } return undefined; }
            if (c === 'readMemory') { return { data: le(words.get(a.memoryReference) ?? 0).toString('base64') }; }
            if (c === 'evaluate') { return { result: 'Error: could not evaluate expression' }; }
            return { stackFrames: [] };
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        await ex.writeMemoryWord('0xE000EDFC', 0x01000000);
        check('M5 write + readback', eq(calls.map((c) => c.command + ' ' + c.json), ['writeMemory {"memoryReference":"0xE000EDFC","data":"AAAAAQ=="}', 'readMemory {"memoryReference":"0xE000EDFC","count":4}']), calls.map((c) => c.command + ' ' + c.json));
        writeFails = true;
        calls.length = 0;
        words.set('0xE000EDFC', 0);
        const e = await rejects(ex.writeMemoryWord('0xE000EDFC', 0x01000000));
        check('M5 set fallback then read-back', eq(calls.map((c) => c.command + ' ' + (c.args?.expression ?? c.args?.memoryReference)), ['writeMemory 0xE000EDFC', 'evaluate -exec set {unsigned int}0xE000EDFC = 16777216', 'readMemory 0xE000EDFC']), calls.map((c) => c.command + ' ' + c.json));
        check('M5 did not stick', e && e.message === 'Write to 0xE000EDFC did not stick (wrote 0x01000000, read back 0x00000000)', e && e.message);
    }
    reset();
    {
        const words = new Map([['0xE000EDFC', 0], ['0xE0001000', 0], ['0xE0001004', 1234]]);
        const { session, calls } = makeSession((c, a) => {
            if (c === 'writeMemory') { words.set(a.memoryReference, Buffer.from(a.data, 'base64').readUInt32LE(0)); return undefined; }
            if (c === 'readMemory') { return { data: le(words.get(a.memoryReference) ?? 0).toString('base64') }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const r = await ex.readCycleCounter();
        const seqs = calls.map((c) => `${c.command} ${c.args.memoryReference}${c.args.data ? ' ' + Buffer.from(c.args.data, 'base64').readUInt32LE(0).toString(16) : ''}`);
        check('M6 cycle counter enable', r.present === true && r.enabledNow === true && r.cycles === 1234 && eq(seqs, [
            'readMemory 0xE000EDFC', 'writeMemory 0xE000EDFC 1000000', 'readMemory 0xE000EDFC',
            'readMemory 0xE0001000', 'writeMemory 0xE0001000 1', 'readMemory 0xE0001000', 'readMemory 0xE0001004']), seqs);
        words.set('0xE0001000', 1 << 28);
        calls.length = 0;
        const r2 = await ex.readCycleCounter();
        check('M6 absent', eq(r2, { present: false, cycles: 0, enabledNow: false }) && !calls.some((c) => c.args.memoryReference === '0xE0001004'), r2);
    }

    // ── Registers and faults ──
    reset();
    {
        const pending = [];
        const { session, calls } = makeSession((c, a) => {
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (a.expression === '$r3') { return never(); }
            if (a.expression === '$r5') { throw new Error('bad'); }
            if (a.expression === '$r6') { return undefined; }
            if (a.expression === '$r7') { return {}; }
            return new Promise((res) => pending.push(() => res({ result: `v${a.expression}` })));
        });
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 100 });
        const p = ex.readCoreRegisters();
        await sleep(10);
        const evals = calls.filter((c) => c.command === 'evaluate');
        check('R1 23 requests before any answer, in order', evals.length === 23 && evals.map((c) => c.args.expression).join(' ') === '$r0 $r1 $r2 $r3 $r4 $r5 $r6 $r7 $r8 $r9 $r10 $r11 $r12 $sp $lr $pc $xpsr $msp $psp $control $faultmask $basepri $primask'
            && evals.every((c) => c.args.context === 'watch' && !('frameId' in c.args)), evals.map((c) => c.json));
        pending.forEach((f) => f());
        const regs = await p;
        check('R1 values', regs.r3 === '<timeout>' && regs.r5 === '<unavailable>' && regs.r6 === '<unavailable>' && regs.r7 === undefined && 'r7' in regs && regs.r0 === 'v$r0'
            && Object.keys(regs).join(' ') === 'r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 sp lr pc xpsr msp psp control faultmask basepri primask', regs);
        calls.length = 0;
        const p2 = ex.readCoreRegisters(5000, ['pc', 'lr']);
        await sleep(5);
        pending.forEach((f) => f());
        const regs2 = await p2;
        check('R1 two names', calls.filter((c) => c.command === 'evaluate').length === 2 && eq(Object.keys(regs2), ['pc', 'lr']), calls.map((c) => c.json));
        calls.length = 0;
        const ex2 = new DebuggingExecutor({ dapRequestMs: 1000, memoryReadMs: 50 });
        const e = await rejects(ex2.readCoreRegisters(undefined, ['r3']));
        check('R1 fence', e instanceof HardwareTimeoutError && e.operation === 'readCoreRegisters', String(e));
    }
    reset();
    {
        let size = 24;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') { return { data: b64(Array.from({ length: a.count === 24 ? size : 4 }, (_, i) => i)) }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor();
        const regs = await ex.readFaultRegisters();
        check('F2 block read', calls.length === 1 && calls[0].json === '{"memoryReference":"0xE000ED28","count":24}' && regs.CFSR === 0x03020100 && regs.AFSR === 0x17161514, regs);
        size = 20;
        calls.length = 0;
        await ex.readFaultRegisters();
        check('F2 short → six words', eq(calls.slice(1).map((c) => c.json), ['0xE000ED28', '0xE000ED2C', '0xE000ED30', '0xE000ED34', '0xE000ED38', '0xE000ED3C'].map((m) => `{"memoryReference":"${m}","count":4}`)), calls.map((c) => c.json));
        calls.length = 0;
        await ex.readExceptionFrame(0x20001000);
        check('F3 exception frame', calls[0].json === '{"memoryReference":"0x20001000","count":32}');
        const info = await ex.getFaultInfo();
        check('F getFaultInfo text', info.startsWith('=== Cortex-M Fault Analysis ==='));
        reset();
        const e = await rejects(new DebuggingExecutor().readFaultRegisters());
        console.log(`       fault no session: ${e && e.message}`);
    }
    reset();
    {
        const { session } = makeSession((c) => { if (c === 'readMemory') { return never(); } throw new Error('?'); });
        focusOn(session);
        const e = await rejects(new DebuggingExecutor({ dapRequestMs: 60 }).readFaultRegisters());
        check('F timeout in block read rethrown', e instanceof HardwareTimeoutError, String(e));
    }

    // ── Reset ──
    async function resetCase(name, { config, stopped = true, method, halt, words = {}, pc = '0x08000100 <Reset_Handler>', monitorReply = () => ({ result: '' }), stopEvents, pauseStops = false, terminateDuringWait = false }) {
        reset();
        const cfg = { type: 'gdbtarget', name: 'Cfg', ...(config ?? {}) };
        let t;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'readMemory') {
                if (!(a.memoryReference in words)) { throw new Error('unreadable'); }
                return { data: le(words[a.memoryReference]).toString('base64') };
            }
            if (c === 'stackTrace') { return { stackFrames: [] }; }
            if (c === 'evaluate' && a.expression === '$pc') { return { result: typeof pc === 'function' ? pc() : pc }; }
            if (c === 'evaluate' && a.expression.startsWith('-exec ')) {
                if (terminateDuringWait) { setTimeout(() => event(t, 'terminated'), 50); }
                return monitorReply(a.expression.slice(6));
            }
            if (c === 'pause') { if (pauseStops) { setTimeout(() => event(t, 'stopped', { reason: 'pause', threadId: 1 }), 5); } return undefined; }
            if (c === 'continue') { return undefined; }
            throw new Error(`? ${c}`);
        }, cfg, name);
        focusOn(session);
        t = trackerFor(session);
        event(t, stopped ? 'stopped' : 'continued', { reason: 'breakpoint', threadId: 1 });
        const ex = new DebuggingExecutor();
        const t0 = Date.now();
        const out = await ex.resetTarget({ method, halt });
        return { out, calls, ms: Date.now() - t0 };
    }
    {
        const { out, calls, ms } = await resetCase('pyOCD S', { config: { target: { server: 'pyocd' } }, method: 'auto', words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        check('RS1 pyocd verified', out.serverKind === 'pyocd' && eq(out.commandsIssued, ['monitor reset halt system']) && eq(out.replies, ['<no echo from adapter>'])
            && eq(out.methodsTried, ['system']) && out.verified === true && out.verificationDetail === 'PC=0x08000100 matches the reset vector (0x08000100, vector table at 0x00000000)'
            && out.haltedByUs === false && out.resumed === false, out);
        check('RS1 timing ~3.5 s', ms >= 3400 && ms < 4500, ms);
        check('RS1 VTOR exact reference, vector at 0x00000004', calls.some((c) => c.json === '{"memoryReference":"0xE000ED08","count":4}') && calls.some((c) => c.json === '{"memoryReference":"0x00000004","count":4}'));
    }
    {
        const { out, calls } = await resetCase('J-Link S', { config: { target: { server: 'JLinkGDBServer' } }, method: 'core', monitorReply: (cmd) => ({ result: cmd === 'monitor reset 1' ? 'Unknown monitor command' : '' }) });
        check('RS2 jlink core unsupported', out.serverKind === 'jlink' && eq(out.commandsIssued, ['monitor halt', 'monitor reset 1']) && out.verificationDetail === unsupportedResetDetail('core', 0)
            && !calls.some((c) => c.command === 'readMemory') && out.verified === false, out);
    }
    {
        const { out, calls } = await resetCase('S', { method: 'auto', halt: false, words: { '0xE000ED08': 0x08000000, '0x08000004': 0x08000199 }, pc: '0x8000256 <delay_ms+14>' });
        check('RS3 all methods, unverified, no continue', eq(out.methodsTried, ['system', 'core', 'hardware']) && out.verified === false
            && out.verificationDetail === 'PC=0x08000256 does NOT match the reset vector 0x08000198 (vector table at 0x08000000)' && !calls.some((c) => c.command === 'continue') && out.resumed === false, out);
        check('RS6 vector read at 0x08000004', calls.some((c) => c.json === '{"memoryReference":"0x08000004","count":4}'));
    }
    {
        const { out, calls, ms } = await resetCase('S', { stopped: false, method: 'system' });
        check('RS4 running, pause did not stop', out.verificationDetail === 'could not halt the target to issue the reset (pause did not stop it within 5 s)' && out.commandsIssued.length === 0
            && out.haltedByUs === false && calls[0].command === 'pause' && ms >= 4900, { out, ms });
    }
    {
        const { out, calls } = await resetCase('S', { stopped: false, pauseStops: true, method: 'system', halt: false, words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        const order = calls.map((c) => c.command);
        check('RS5 halted by us, verified, resumed', out.haltedByUs === true && out.verified === true && out.resumed === true && order[0] === 'pause' && order[order.length - 1] === 'continue', { out, order });
    }
    {
        const { out } = await resetCase('S', { method: 'system', terminateDuringWait: true, words: { '0xE000ED08': 0, '0x00000004': 0x08000101 } });
        check('RS5 terminated during wait', out.verificationDetail === 'debug session ended during the reset' && out.verified === false, out);
    }
    {
        const { out } = await resetCase('S', { method: 'system', words: { '0xE000ED08': 0x08000000, '0x08000004': 0x08000199 }, pc: 'xyz' });
        check('RS6 unparsable pc', out.verificationDetail === "verification reads failed: could not parse PC from 'xyz'", out.verificationDetail);
    }
    {
        const { out } = await resetCase('S', { method: 'system', words: { '0x00000004': 0x08000101 } });
        check('RS VTOR failure → base 0 silently', out.verified === true && out.verificationDetail.endsWith('vector table at 0x00000000)'), out.verificationDetail);
    }

    // ── Threads, stack, variables, evaluate, device info ──
    reset();
    {
        let outstanding = 0;
        let maxOutstanding = 0;
        const { session, calls } = makeSession((c, a) => {
            if (c === 'threads') { return { threads: Array.from({ length: 40 }, (_, i) => (i === 5 ? { id: i + 1 } : { id: i + 1, name: `t${i + 1}` })) }; }
            if (c === 'stackTrace') {
                outstanding++;
                maxOutstanding = Math.max(maxOutstanding, outstanding);
                return new Promise((res, rej) => setTimeout(() => {
                    outstanding--;
                    if (a.threadId === 3) { rej(new Error('bad')); } else { res({ stackFrames: [{ id: 7, name: 'fn', source: { path: '/p/a.c' }, line: 3, column: 0 }] }); }
                }, 5));
            }
            throw new Error('?');
        });
        focusOn(session);
        const threads = await new DebuggingExecutor().getThreads();
        const st = calls.filter((c) => c.command === 'stackTrace');
        check('T1 40 threads, unnamed', threads.length === 40 && threads[5].name === 'thread-6' && threads[0].name === 't1', threads.slice(0, 7));
        check('T1 32 stackTrace levels 1, ≤4 outstanding', st.length === 32 && st.every((c) => c.json === `{"threadId":${c.args.threadId},"startFrame":0,"levels":1}`) && maxOutstanding === 4, { n: st.length, maxOutstanding });
        check('T1 failed leaves no topFrame; beyond 32 none', threads[2].topFrame === undefined && threads[35].topFrame === undefined && eq(threads[0].topFrame, { name: 'fn', source: '/p/a.c', line: 3 }) && !('frameId' in threads[0].topFrame), threads[0]);
    }
    reset();
    {
        const { session, calls } = makeSession(() => ({ stackFrames: [{ name: '', source: { name: 'n.c' } }, { id: 0, name: 'm', source: { path: '/x/m.c', name: 'm.c' }, line: 4, column: 2 }] }));
        focusOn(session);
        const frames = await new DebuggingExecutor().getCallStack();
        check('T2 call stack request', calls[0].json === '{"threadId":1,"startFrame":0,"levels":50}', calls[0].json);
        check('T2 mapping', eq(frames, [{ name: 'unknown', source: 'n.c' }, { name: 'm', source: '/x/m.c', line: 4, column: 2, frameId: 0 }]) && !('frameId' in frames[0]), frames);
        calls.length = 0;
        await new DebuggingExecutor().getCallStack(0, 3, 500);
        check('T2 thread 0 given', calls[0].json === '{"threadId":0,"startFrame":0,"levels":3}', calls[0].json);
    }
    reset();
    {
        let varsFail = false;
        let scopes = [{ name: 'Locals', variablesReference: 1 }, { name: 'Globals', variablesReference: 2 }, { name: 'Registers', variablesReference: 3 }];
        const { session, calls } = makeSession((c, a) => {
            if (c === 'scopes') { return scopes === 'hang' ? never() : { scopes }; }
            if (c === 'variables') { if (varsFail) { throw new Error('vars bad'); } return { variables: [{ name: 'v' + a.variablesReference }] }; }
            throw new Error('?');
        });
        focusOn(session);
        const ex = new DebuggingExecutor({ dapRequestMs: 80 });
        const r = await ex.getVariables(3, 'local');
        check('V3 local filter', calls.length === 2 && calls[0].json === '{"frameId":3}' && calls[1].json === '{"variablesReference":1}' && r.scopes.length === 1 && r.scopes[0] === scopes[0] && eq(r.scopes[0].variables, [{ name: 'v1' }]), calls.map((c) => c.json));
        varsFail = true;
        const r2 = await ex.getVariablesForFrame(3, 'global');
        check('V3 rejected variables', r2.scopes.length === 1 && eq(r2.scopes[0].variables, []) && r2.scopes[0].error === 'vars bad', r2);
        scopes = [];
        check('V3 empty scopes', eq(await ex.getVariables(3), { scopes: [] }));
        scopes = 'hang';
        const e = await rejects(ex.getVariables(3));
        // KB14 flattens the class; since #11 the wrap keeps the error code, TIMEOUT.
        check('V3 scopes timeout → Error with HardwareTimeoutError: and the code TIMEOUT', e && !(e instanceof HardwareTimeoutError) && e.message.includes('HardwareTimeoutError:') && e.code === 'TIMEOUT', e && `${e.code} ${e.message}`);
        console.log(`       S9 text: ${e && e.message.slice(0, 60)}`);
        reset();
        const e2 = await rejects(ex.getVariables(3));
        console.log(`       S9 no session: ${e2 && e2.message}`);
    }
    reset();
    {
        const body = { result: '42', type: 'int', variablesReference: 0 };
        const { session, calls } = makeSession(() => body);
        focusOn(session);
        const ex = new DebuggingExecutor();
        const r = await ex.evaluateExpression('x', 4);
        check('E4 evaluate', calls[0].json === '{"expression":"x","frameId":4,"context":"repl"}' && r === body);
        session.customRequest = () => Promise.reject(new Error('eval bad'));
        const e = await rejects(ex.evaluateExpression('x', 4));
        console.log(`       S10 text: ${e && e.message}`);
    }
    reset();
    {
        const { session } = makeSession(() => undefined, { type: 'gdbtarget', program: 'a.elf', target: { server: 'pyocd', port: 3333 }, cmsis: { cbuildRunFile: 'x.cbuild-run.yml' } }, 'S');
        focusOn(session);
        const info = await new DebuggingExecutor().getDeviceInfo();
        check('D5 device info', info === '=== Debug Session Info ===\n  Session name: S\n  Debug type: gdbtarget\n  Program: a.elf\n  GDB: <default>\n  Server: pyocd\n  Port: 3333\n  cbuild-run: x.cbuild-run.yml\n', info);
        const s2 = makeSession(() => undefined, {}, 'T');
        focusOn(s2.session);
        const info2 = await new DebuggingExecutor().getDeviceInfo();
        check('D5 fallbacks, no cbuild-run', info2 === '=== Debug Session Info ===\n  Session name: T\n  Debug type: <unknown>\n  Program: <unknown>\n  GDB: <default>\n  Server: <unknown>\n  Port: <unknown>\n', info2);
    }
    reset();
    {
        const { session } = makeSession(() => undefined);
        focusOn(session);
        stub.debug.stopDebugging = async (s) => { stub.stopped = s; };
        await new DebuggingExecutor().stopDebugging();
        check('stopDebugging default target', stub.stopped === session);
        reset();
        stub.stopped = 'untouched';
        await new DebuggingExecutor().stopDebugging();
        check('stopDebugging nothing to stop', stub.stopped === 'untouched');
        stub.debug.stopDebugging = async () => { throw new Error('stop bad'); };
        const e = await rejects(new DebuggingExecutor().stopDebugging(session));
        console.log(`       S5 text: ${e && e.message}`);
    }
    reset();
    {
        const ex = new DebuggingExecutor();
        stub.debug.addBreakpoints = () => { throw new Error('add bad'); };
        console.log(`       S7 text: ${(await rejects(ex.addBreakpoint(stub.Uri.file('/a'), 1))).message}`);
        stub.debug.breakpoints = [new stub.SourceBreakpoint(new stub.Location(stub.Uri.file('/a'), new stub.Position(0, 0)), true)];
        stub.debug.removeBreakpoints = () => { throw new Error('remove bad'); };
        console.log(`       S8 text: ${(await rejects(ex.removeBreakpoint(stub.Uri.file('/a'), 1))).message}`);
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error', e); process.exit(2); });
