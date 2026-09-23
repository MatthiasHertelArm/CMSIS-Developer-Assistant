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
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugState, formatBreakpointModifiers, StackFrame } from '../debugState';
import type { BreakpointBinding, GdbLogpoint, GdbReply, IDebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler, probeSchedule } from '../debuggingHandler';
import type { IDebugConfigurationManager } from '../utils/debugConfigurationManager';
import { REDACTION_NOTICE } from '../utils/secretRedaction';
import type { StopWaitResult } from '../utils/sessionStateTracker';
import { HardwareTimeoutError } from '../utils/timeout';
import { renderResetOutcome, ResetOutcomeView } from '../core/resetAssist';
import { ErrorCode, ToolError, ToolText, errorDetail } from '../core/toolResult';
import type { HandlerHost } from '../handler/host';
import { CmsisJobTracker } from '../cmsisJobTracker';
import { FakeExecution, FakeTasks, FixtureTask, workspaceTasks } from './cmsisTaskFixtures';

/**
 * The debugging handler against a scripted executor. The handler's host is
 * replaced where a case needs the focused frame, task events, workspace
 * folders or a faster clock; CMSIS Solution commands are registered as
 * stand-ins (the test host has no CMSIS Solution extension).
 */

type StatusShape = Awaited<ReturnType<IDebuggingExecutor['getSessionStatus']>>;
type ThreadShape = Awaited<ReturnType<IDebuggingExecutor['getThreads']>>[number];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_SVD = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'test-device.svd');

const delay = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

function sampleState(): DebugState {
    const state = new DebugState();
    state.sessionActive = true;
    state.fileName = 'main.c';
    state.fileFullPath = '/w/main.c';
    state.currentLine = 42;
    state.frameName = 'main';
    return state;
}

function status(state: StatusShape['state'], extra: Partial<StatusShape> = {}): StatusShape {
    return {
        state, sessionName: 'Fake session', sessionType: 'gdbtarget', configurationName: 'Fake config',
        dapResponsive: state !== 'no-session', dapProbeMs: null, ...extra,
    };
}

/**
 * Records what the handler asks for and answers from its fields; a case
 * replaces any method it needs to behave differently.
 */
class ScriptedExecutor {
    /** Execution requests and waiter arming, in order. */
    readonly moves: string[] = [];
    /** Every call with its arguments. */
    readonly calls: unknown[][] = [];
    /** Answers for successive `armStopWaiter` calls. */
    readonly waiters: Array<StopWaitResult | Promise<StopWaitResult>> = [];
    /** Methods that throw instead of answering. */
    readonly failures: Record<string, Error> = {};
    session = true;
    stopped = true;
    sessionStatus: StatusShape = status('running');
    state: DebugState = sampleState();
    registers: Record<string, string> = { pc: '0x08000100', lr: '0x08000200' };
    breakpoints: vscode.Breakpoint[] = [];
    /** What the adapter reports for a breakpoint; by default verified where it was set. */
    binding: (bp: vscode.Breakpoint) => BreakpointBinding | undefined = (bp) => ({
        reported: true, verified: true, line: bp instanceof vscode.SourceBreakpoint ? bp.location.range.start.line + 1 : undefined, id: 7,
    });
    /** Whether the adapter answers `setBreakpoints` in time after a removal. */
    removalApplied: boolean | undefined = true;
    /** GDB's answers, by the first word of the command. */
    gdbReplies: Record<string, GdbReply> = {
        dprintf: { text: JSON.stringify({ bkpt: { number: '3', type: 'dprintf', addr: '0x080002f4', file: 'main.c', line: '12' } }), errored: false },
        condition: { text: '', errored: false },
        delete: { text: '', errored: false },
        list: { text: JSON.stringify({ BreakpointTable: { body: [{ number: '3', type: 'dprintf', times: '4' }] } }), errored: false },
    };
    logpoints: GdbLogpoint[] = [];
    restartOutcome: Awaited<ReturnType<IDebuggingExecutor['restart']>> = { via: 'workbench' };

    note(name: string, ...args: unknown[]): void {
        this.calls.push([name, ...args]);
    }

    argsOf(name: string): unknown[][] {
        return this.calls.filter((call) => call[0] === name).map((call) => call.slice(1));
    }

    private failIfScripted(name: string): void {
        const failure = this.failures[name];
        if (failure) {
            throw failure;
        }
    }

    private async execute(name: string, timeoutMs?: number): Promise<void> {
        this.moves.push(name);
        this.note(name, timeoutMs);
        this.failIfScripted(name);
    }

    hasDebugSession: IDebuggingExecutor['hasDebugSession'] = () => this.session;
    hasActiveSession: IDebuggingExecutor['hasActiveSession'] = async () => {
        this.note('hasActiveSession');
        return this.stopped;
    };
    getSessionStatus: IDebuggingExecutor['getSessionStatus'] = async () => {
        this.note('getSessionStatus');
        return this.sessionStatus;
    };
    getDiagnostics: IDebuggingExecutor['getDiagnostics'] = () =>
        ({ serverVersion: '9.8.7', liveSessionCount: 0, liveSessionNames: [], hasVscodeActiveSession: false });
    armStopWaiter: IDebuggingExecutor['armStopWaiter'] = (limitMs) => {
        this.moves.push('arm');
        this.note('armStopWaiter', limitMs);
        const next = this.waiters.shift();
        if (next === undefined) {
            throw new Error('no stop waiter scripted');
        }
        return Promise.resolve(next);
    };
    continue: IDebuggingExecutor['continue'] = (ms) => this.execute('continue', ms);
    stepOver: IDebuggingExecutor['stepOver'] = (ms) => this.execute('stepOver', ms);
    stepInto: IDebuggingExecutor['stepInto'] = (ms) => this.execute('stepInto', ms);
    stepOut: IDebuggingExecutor['stepOut'] = (ms) => this.execute('stepOut', ms);
    pause: IDebuggingExecutor['pause'] = (ms) => this.execute('pause', ms);
    getCurrentDebugState: IDebuggingExecutor['getCurrentDebugState'] = async (lines) => {
        this.note('getCurrentDebugState', lines);
        return this.state;
    };
    readCoreRegisters: IDebuggingExecutor['readCoreRegisters'] = async (ms, names) => {
        this.note('readCoreRegisters', ms, names);
        this.failIfScripted('readCoreRegisters');
        return this.registers;
    };
    startDebugging: IDebuggingExecutor['startDebugging'] = async (folder, config) => {
        this.note('startDebugging', folder, config);
        return true;
    };
    startDebuggingByName: IDebuggingExecutor['startDebuggingByName'] = async (folder, name) => {
        this.note('startDebuggingByName', folder, name);
        return true;
    };
    stopDebugging: IDebuggingExecutor['stopDebugging'] = async (...args) => {
        this.note('stopDebugging', ...args);
    };
    restart: IDebuggingExecutor['restart'] = async () => {
        this.moves.push('restart');
        this.note('restart');
        this.failIfScripted('restart');
        return this.restartOutcome;
    };
    waitForStop: IDebuggingExecutor['waitForStop'] = async (ms) => {
        this.note('waitForStop', ms);
        return { kind: 'timeout' };
    };
    addBreakpoint: IDebuggingExecutor['addBreakpoint'] = async (uri, line, options) => {
        this.moves.push('addBreakpoint');
        // uri.path, not fsPath: forward slashes on every OS, so the expectations hold on Windows too.
        this.note('addBreakpoint', uri.path, line, options);
        this.failIfScripted('addBreakpoint');
        const added = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)), true,
            options?.condition, undefined, options?.logMessage);
        this.breakpoints = [...this.breakpoints, added];
        return added;
    };
    removeBreakpoint: IDebuggingExecutor['removeBreakpoint'] = async (uri, line, options) => {
        this.moves.push('removeBreakpoint');
        this.note('removeBreakpoint', uri.path, line, options);
        const matching = this.breakpoints.filter((bp) => bp instanceof vscode.SourceBreakpoint
            && bp.location.uri.toString() === uri.toString() && bp.location.range.start.line === line - 1
            && (!options?.logpointsOnly || Boolean(bp.logMessage)));
        this.breakpoints = this.breakpoints.filter((bp) => !matching.includes(bp));
        return matching.length > 0 ? { removed: matching.length, applied: this.session ? this.removalApplied : undefined } : { removed: 0 };
    };
    getBreakpoints: IDebuggingExecutor['getBreakpoints'] = () => this.breakpoints;
    clearAllBreakpoints: IDebuggingExecutor['clearAllBreakpoints'] = async () => {
        this.moves.push('clearAllBreakpoints');
        this.note('clearAllBreakpoints');
        const removed = this.breakpoints.length;
        this.breakpoints = [];
        return removed > 0 ? { removed, applied: this.session ? this.removalApplied : undefined } : { removed: 0 };
    };
    breakpointBinding: IDebuggingExecutor['breakpointBinding'] = async (bp, waitMs) => {
        this.note('breakpointBinding', waitMs);
        return this.session ? this.binding(bp) : undefined;
    };
    private gdb(name: string, key: string, ...args: unknown[]): GdbReply {
        this.moves.push(name);
        this.note(name, ...args);
        return this.gdbReplies[key];
    }
    insertDprintfViaGdb: IDebuggingExecutor['insertDprintfViaGdb'] = async (location, format, values) =>
        this.gdb('insertDprintfViaGdb', 'dprintf', location, format, values);
    setBreakpointConditionViaGdb: IDebuggingExecutor['setBreakpointConditionViaGdb'] = async (num, condition) =>
        this.gdb('setBreakpointConditionViaGdb', 'condition', num, condition);
    deleteBreakpointsViaGdb: IDebuggingExecutor['deleteBreakpointsViaGdb'] = async (numbers) =>
        this.gdb('deleteBreakpointsViaGdb', 'delete', numbers);
    listBreakpointsViaGdb: IDebuggingExecutor['listBreakpointsViaGdb'] = async () => this.gdb('listBreakpointsViaGdb', 'list');
    gdbLogpoints: IDebuggingExecutor['gdbLogpoints'] = () => this.logpoints.map((logpoint) => ({ ...logpoint }));
    rememberGdbLogpoint: IDebuggingExecutor['rememberGdbLogpoint'] = (logpoint) => {
        this.note('rememberGdbLogpoint', logpoint);
        this.logpoints = [...this.logpoints, logpoint];
    };
    forgetGdbLogpoints: IDebuggingExecutor['forgetGdbLogpoints'] = (numbers) => {
        this.note('forgetGdbLogpoints', numbers);
        this.logpoints = this.logpoints.filter((logpoint) => !numbers.includes(logpoint.number));
    };
    getVariables: IDebuggingExecutor['getVariables'] = async (frameId, scope, ms) => {
        this.note('getVariables', frameId, scope, ms);
        return { scopes: [] };
    };
    getVariablesForFrame: IDebuggingExecutor['getVariablesForFrame'] = async (frameId, scope, ms) => {
        this.note('getVariablesForFrame', frameId, scope, ms);
        return { scopes: [] };
    };
    evaluateExpression: IDebuggingExecutor['evaluateExpression'] = async (expression, frameId, ms) => {
        this.note('evaluateExpression', expression, frameId, ms);
        return { result: '1' };
    };
    readMemory: IDebuggingExecutor['readMemory'] = async (address, length, ms) => {
        this.note('readMemory', address, length, ms);
        return Buffer.alloc(length);
    };
    readCycleCounter: IDebuggingExecutor['readCycleCounter'] = async () => ({ cycles: 0, enabledNow: false, present: true });
    readPeripheralRegister: IDebuggingExecutor['readPeripheralRegister'] = async () => 'peripheral text';
    getFaultInfo: IDebuggingExecutor['getFaultInfo'] = async () => 'fault text';
    readFaultRegisters: IDebuggingExecutor['readFaultRegisters'] = async () =>
        ({ CFSR: 0x00008200, HFSR: 0x40000000, DFSR: 0, MMFAR: 0, BFAR: 0x60000000, AFSR: 0 });
    readExceptionFrame: IDebuggingExecutor['readExceptionFrame'] = async (sp, ms) => {
        this.note('readExceptionFrame', sp, ms);
        return Buffer.alloc(32);
    };
    resetTarget: IDebuggingExecutor['resetTarget'] = async (options) => {
        this.note('resetTarget', options);
        return {
            serverKind: 'pyocd', methodsTried: ['system'], commandsIssued: ['monitor reset halt system'], replies: ['ok'],
            verified: true, verificationDetail: 'PC matches', haltedByUs: false, resumed: false,
        };
    };
    getDeviceInfo: IDebuggingExecutor['getDeviceInfo'] = async () => '=== Debug Session Info ===\n  Session name: S\n';
    checkTargetConnection: IDebuggingExecutor['checkTargetConnection'] = async () => 'connection text';
    getThreads: IDebuggingExecutor['getThreads'] = async (ms) => {
        this.note('getThreads', ms);
        return [{ id: 1, name: 'main' }];
    };
    getCallStack: IDebuggingExecutor['getCallStack'] = async (threadId, levels, ms) => {
        this.note('getCallStack', threadId, levels, ms);
        return [{ name: 'main', source: '/w/main.c', line: 42, frameId: 1000 }];
    };
}

/** A clock `speedup` times faster than real time; it records the timers it is asked for. */
function fastClock(speedup: number, timers: number[] = []): Pick<HandlerHost, 'now' | 'sleep' | 'startTimer'> {
    const origin = Date.now();
    return {
        now: () => origin + (Date.now() - origin) * speedup,
        sleep: (ms) => new Promise<void>((wake) => {
            setTimeout(wake, ms / speedup);
        }),
        startTimer: (ms, fire) => {
            timers.push(ms);
            const handle = setTimeout(fire, ms / speedup);
            return () => clearTimeout(handle);
        },
    };
}

/** The handler with parts of its host replaced. */
class HostedHandler extends DebuggingHandler {
    constructor(
        executor: ScriptedExecutor,
        private readonly replaced: Partial<HandlerHost>,
        timeoutSeconds: number,
        configurations: Partial<IDebugConfigurationManager>,
    ) {
        super(executor as unknown as IDebuggingExecutor, configurations as IDebugConfigurationManager, timeoutSeconds);
    }

    protected host(): HandlerHost {
        return { ...super.host(), ...this.replaced };
    }
}

function handlerFor(
    executor: ScriptedExecutor,
    replaced: Partial<HandlerHost> = {},
    timeoutSeconds = 5,
    configurations: Partial<IDebugConfigurationManager> = {},
): HostedHandler {
    return new HostedHandler(executor, replaced, timeoutSeconds, configurations);
}

async function rejectionOf(pending: Promise<unknown>): Promise<string> {
    try {
        await pending;
    } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
    }
    assert.fail('expected the call to reject');
}

/** The `ToolError` a call rejects with; `code` is checked when given. */
async function refusalOf(pending: Promise<unknown>, code?: ErrorCode): Promise<ToolError> {
    try {
        await pending;
    } catch (caught) {
        assert.ok(caught instanceof ToolError, `expected a ToolError, got ${String(caught)}`);
        if (code !== undefined) {
            assert.strictEqual(caught.code, code, errorDetail(caught));
        }
        return caught;
    }
    assert.fail('expected the call to reject');
}

/** The answer of a call that ends with a plain text: a success. */
async function textAnswer(pending: Promise<ToolText>): Promise<string> {
    const answered = await pending;
    assert.strictEqual(typeof answered, 'string', `expected a plain text, got ${JSON.stringify(answered)}`);
    return answered as string;
}

/** The text of a call that ends with a reply of the given status. */
async function replyAnswer(pending: Promise<ToolText>, status: 'running' | 'timeout'): Promise<string> {
    const answered = await pending;
    assert.ok(typeof answered === 'object' && answered.status === status, `expected status ${status}, got ${JSON.stringify(answered)}`);
    return answered.text;
}

function sourceBreakpoint(file: string, zeroBasedLine: number, condition?: string): vscode.SourceBreakpoint {
    return new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(file), new vscode.Position(zeroBasedLine, 0)), true, condition);
}

function frames(count: number): StackFrame[] {
    return Array.from({ length: count }, (_, level) => ({ name: `fn${level}`, source: `/w/f${level}.c`, line: level + 1, frameId: 1000 + level }));
}

/** Register stand-ins for CMSIS Solution commands; dispose the result afterwards. */
function standIns(handlers: Record<string, (...args: unknown[]) => unknown>): vscode.Disposable {
    return vscode.Disposable.from(...Object.entries(handlers).map(([id, run]) => vscode.commands.registerCommand(id, run)));
}

suite('DebuggingHandler', () => {

    suite('logpoint messages become GDB dprintf calls', () => {
        const translate = (message: string) => DebuggingHandler.translateLogMessage(message);

        test('plain text ends with a newline escape and takes no arguments', () => {
            assert.deepStrictEqual(translate('reached init'), { format: 'reached init\\n', args: [] });
        });

        test('an interpolation prints with %d', () => {
            assert.deepStrictEqual(translate('count={count}'), { format: 'count=%d\\n', args: ['count'] });
        });

        test('a conversion after the colon replaces %d', () => {
            assert.deepStrictEqual(translate('name={name:%s} duty={duty:%f}'), { format: 'name=%s duty=%f\\n', args: ['name', 'duty'] });
            assert.deepStrictEqual(translate('t={ticks:%08lx}'), { format: 't=%08lx\\n', args: ['ticks'] });
        });

        test('a scope operator is not a conversion', () => {
            assert.deepStrictEqual(translate('v={ns::value}'), { format: 'v=%d\\n', args: ['ns::value'] });
        });

        test('doubled braces are literal braces', () => {
            assert.deepStrictEqual(translate('{{literal}} x={x}'), { format: '{literal} x=%d\\n', args: ['x'] });
        });

        test('a percent sign in the text is doubled', () => {
            assert.deepStrictEqual(translate('duty 50% at {t}'), { format: 'duty 50%% at %d\\n', args: ['t'] });
        });

        test('quotes and backslashes are escaped for the GDB command string', () => {
            assert.strictEqual(translate('path "C:\\dev"').format, 'path \\"C:\\\\dev\\"\\n');
        });

        test('expressions are passed on as written', () => {
            assert.deepStrictEqual(translate('{buf[i]} {p->field} {a + b}').args, ['buf[i]', 'p->field', 'a + b']);
        });

        test('unbalanced and empty braces are refused with their position', () => {
            assert.throws(() => translate('x={unclosed'), /Unbalanced '\{' in logMessage at position 2/);
            assert.throws(() => translate('x=}'), /Unbalanced '\}' in logMessage at position 2/);
            assert.throws(() => translate('x={}'), /Empty interpolation '\{\}' in logMessage at position 2/);
        });
    });

    suite('breakpoint modifier suffix used by list_breakpoints', () => {
        test('a plain enabled breakpoint has none', () => {
            assert.strictEqual(formatBreakpointModifiers({ enabled: true }), '');
            assert.strictEqual(formatBreakpointModifiers({}), '', 'an absent enabled flag is not "disabled"');
        });

        test('each modifier is listed in order', () => {
            assert.strictEqual(formatBreakpointModifiers({ condition: 'i == 100' }), ' [when: i == 100]');
            assert.strictEqual(formatBreakpointModifiers({ logMessage: 'x={x}' }), ' [log: x={x}]');
            assert.strictEqual(
                formatBreakpointModifiers({ enabled: false, condition: 'n > 0', logMessage: 'n={n}', hitCondition: '>5' }),
                ' [when: n > 0, log: n={n}, hits: >5, disabled]');
        });
    });

    suite('execution waits for the armed DAP stopped event', () => {
        test('continue arms the waiter before the request and reports the stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            const reply = await textAnswer(handlerFor(x).handleContinue());
            assert.deepStrictEqual(x.moves, ['arm', 'continue']);
            assert.ok(reply.startsWith('Target stopped (reason: breakpoint).\n\n{'), reply);
            assert.ok(reply.includes('main.c') && reply.includes('42'), reply);
        });

        for (const [method, request] of [['handleStepOver', 'stepOver'], ['handleStepInto', 'stepInto'], ['handleStepOut', 'stepOut']] as const) {
            test(`${method} sends ${request} after arming`, async () => {
                const x = new ScriptedExecutor();
                x.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 });
                const reply = await textAnswer(handlerFor(x)[method]());
                assert.deepStrictEqual(x.moves, ['arm', request]);
                assert.ok(reply.includes('reason: step'), reply);
            });
        }

        test('only the stop event ends the wait', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            const first = await Promise.race([
                handlerFor(x).handleContinue().then(() => 'settled'),
                delay(100).then(() => 'still waiting'),
            ]);
            assert.strictEqual(first, 'still waiting');
        });

        test('a timeout pauses the target and says where it is, with status timeout', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await replyAnswer(handlerFor(x).handleContinue(), 'timeout');
            assert.deepStrictEqual(x.moves, ['arm', 'continue', 'arm', 'pause']);
            assert.ok(reply.includes('\'continue_execution\' did not complete within 5s'), reply);
            assert.ok(reply.includes('Recovery attempt'), reply);
            assert.ok(reply.includes('Paused successfully. PC = 0x08000100, LR = 0x08000200 in main at main.c:42.'), reply);
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [[5000, ['pc', 'lr']]]);
            assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);
        });

        test('the end of the session during a continue rejects with NO_SESSION, unwrapped, like pause and wait_for_stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'ended' });
            const failure = await refusalOf(handlerFor(x).handleContinue(), 'NO_SESSION');
            assert.strictEqual(failure.message, 'Debug session ended during \'continue_execution\' — '
                + 'the target may have run to completion, crashed, or lost its connection.');
            assert.strictEqual(failure.hint, 'Call get_session_status to confirm; to debug again, start a session with '
                + 'cmsis_action load_and_debug (CMSIS projects) or start_debugging.');
        });

        test('pause on a running target waits for the stop', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await textAnswer(handlerFor(x).handlePause());
            assert.deepStrictEqual(x.moves, ['arm', 'pause']);
            assert.ok(reply.startsWith('Target paused. {'), reply);
        });

        test('recovery variants: register read failure, no stop, session end, pause failure, current line', async () => {
            const noRegisters = new ScriptedExecutor();
            noRegisters.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            noRegisters.failures.readCoreRegisters = new Error('boom');
            const failedRead = await replyAnswer(handlerFor(noRegisters).handleStepOver(), 'timeout');
            assert.ok(failedRead.includes('Paused successfully. PC = <read failed: boom> in main at main.c:42.'), failedRead);
            assert.ok(!failedRead.includes('LR ='), failedRead);

            const silent = new ScriptedExecutor();
            silent.waiters.push({ kind: 'timeout' }, { kind: 'timeout' });
            assert.ok((await replyAnswer(handlerFor(silent).handleStepOver(), 'timeout')).includes(
                'Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. '
                + 'Call check_target_connection, then restart_debugging if needed.'));

            const gone = new ScriptedExecutor();
            gone.waiters.push({ kind: 'timeout' }, { kind: 'ended' });
            assert.ok((await replyAnswer(handlerFor(gone).handleStepOver(), 'timeout')).includes(
                'Pause issued but the debug session ended. The target may have crashed during \'step_over\'.'));

            const wedged = new ScriptedExecutor();
            wedged.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'x', threadId: 1 });
            wedged.pause = async () => {
                throw new Error('probe wedged');
            };
            assert.ok((await replyAnswer(handlerFor(wedged).handleContinue(), 'timeout')).endsWith(
                'Pause failed: probe wedged. Probe / GDB server may be wedged — call check_target_connection.'));

            const withLine = new ScriptedExecutor();
            withLine.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            withLine.state.currentLineContent = 'while (1) {';
            const located = await replyAnswer(handlerFor(withLine).handleContinue(), 'timeout');
            assert.ok(located.includes('.\n  Current line: while (1) {\nThe breakpoint you expected was not hit'), located);
        });

        test('the timeout text names the setting, not the wait (KB8)', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push({ kind: 'timeout' }, { kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            const reply = await replyAnswer(handlerFor(x, {}, 180).handleContinue({ timeoutMs: 5000 }), 'timeout');
            assert.deepStrictEqual(x.argsOf('armStopWaiter')[0], [5000]);
            assert.deepStrictEqual(x.argsOf('continue'), [[5000]]);
            assert.ok(reply.includes('within 180s'), reply);

            const plain = new ScriptedExecutor();
            plain.waiters.push({ kind: 'stopped', reason: 'breakpoint', threadId: 1 });
            await handlerFor(plain, {}, 180).handleContinue();
            assert.deepStrictEqual(plain.argsOf('armStopWaiter'), [[60000]]);
        });

        test('a request that fails after arming is wrapped', async () => {
            const x = new ScriptedExecutor();
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            x.failures.stepOver = new Error('adapter gone');
            const failure = await refusalOf(handlerFor(x).handleStepOver(), 'INTERNAL');
            assert.strictEqual(failure.message, 'Step over failed: adapter gone', 'a plain Error reads without "Error: "');
            x.waiters.push(new Promise<StopWaitResult>(() => undefined));
            x.failures.stepOver = new HardwareTimeoutError('DAP next', 50);
            assert.match((await refusalOf(handlerFor(x).handleStepOver(), 'TIMEOUT')).message, /^Step over failed: HardwareTimeoutError: /);
        });

        test('a step while the target runs rejects with the gate\'s TARGET_RUNNING refusal, not wrapped again', async () => {
            const x = new ScriptedExecutor();
            x.stopped = false;
            x.sessionStatus = status('running');
            const failure = await refusalOf(handlerFor(x).handleStepOver(), 'TARGET_RUNNING');
            assert.strictEqual(failure.message, 'Cannot step over: session state is \'running\'.');
            assert.match(failure.hint ?? '', /^The target is running: call pause_execution first, or set a breakpoint and wait_for_stop\./);
            assert.deepStrictEqual(x.moves, [], 'nothing was sent');
        });
    });

    suite('survival probe schedule', () => {
        test('both probes fit into the budget', () => {
            for (const budget of [1000, 4000, 8000, 16000, 60000]) {
                const plan = probeSchedule(budget);
                assert.ok(plan.firstDelayMs + plan.probeMs + plan.secondDelayMs + plan.probeMs <= budget, `budget ${budget}`);
                assert.ok(plan.probeMs >= 250 && plan.probeMs <= 5000, `probe ${plan.probeMs}`);
                assert.ok(plan.firstDelayMs > 0 && plan.secondDelayMs >= 0);
            }
            assert.deepStrictEqual(probeSchedule(8000), { firstDelayMs: 2800, secondDelayMs: 1200, probeMs: 2000 });
            assert.deepStrictEqual(probeSchedule(0), probeSchedule(1000));
        });
    });

    suite('fence and state gate', () => {
        test('a failing body rejects with a ToolError, its code classified, without the tool label', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = async () => {
                throw new Error('x');
            };
            assert.strictEqual((await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4 }), 'INTERNAL')).message, 'x');
            x.readMemory = async () => {
                throw new HardwareTimeoutError('DAP readMemory', 10);
            };
            await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4 }), 'TIMEOUT');
        });

        test('read_memory without a session rejects with NO_SESSION', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.stopped = false;
            x.sessionStatus = status('no-session');
            const failure = await refusalOf(handlerFor(x).handleReadMemory({ address: '0x20000000', length: 4 }), 'NO_SESSION');
            assert.strictEqual(failure.message, 'Cannot read memory: session state is \'no-session\'.');
            assert.strictEqual(failure.hint, 'No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise. '
                + 'Use get_session_status for a definitive, never-failing classification.');
        });

        test('the cap of a read rejects with TIMEOUT and drops the late result', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 150));
            let unhandled = 0;
            const count = (): void => {
                unhandled++;
            };
            process.on('unhandledRejection', count);
            try {
                const failure = await refusalOf(handlerFor(x).handleReadMemory({ address: '0x0', length: 4, timeoutMs: 100 }), 'TIMEOUT');
                assert.strictEqual(failure.message, '\'read_memory\' did not complete within 100 ms (handler-level cap).');
                assert.match(failure.hint ?? '', /^The DAP probe or target may be unresponsive/);
                await delay(300);
                assert.strictEqual(unhandled, 0);
            } finally {
                process.removeListener('unhandledRejection', count);
            }
        });

        test('the cap of a tool that waits answers with status timeout', async () => {
            const x = new ScriptedExecutor();
            x.resetTarget = () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 150));
            const text = await replyAnswer(handlerFor(x).handleReset({ timeoutMs: 100 }), 'timeout');
            assert.ok(text.startsWith('\'reset\' did not complete within 100 ms (handler-level cap). The DAP probe or target may be unresponsive'), text);
            await delay(300);
        });

        test('the fence limit defaults to 30 s and is capped at 60 s', async () => {
            const timers: number[] = [];
            const h = handlerFor(new ScriptedExecutor(), fastClock(1000, timers));
            await h.handleReadCoreRegisters();
            await h.handleReadCoreRegisters({ timeoutMs: 0 });
            await h.handleReadCoreRegisters({ timeoutMs: -1 });
            await h.handleReadCoreRegisters({ timeoutMs: 120_000 });
            await h.handleReadCoreRegisters({ timeoutMs: 2500 });
            assert.deepStrictEqual(timers, [30000, 30000, 30000, 60000, 2500]);
        });

        test('each session state has its own refusal code and hint', async () => {
            const hints: Record<StatusShape['state'], string> = {
                'no-session': 'No active debug session: cmsis_action load_and_debug for CMSIS projects, start_debugging otherwise.',
                initializing: 'The debug adapter is still starting. Wait briefly and retry; the session has not torn down.',
                running: 'The target is running: call pause_execution first, or set a breakpoint and wait_for_stop.',
                unresponsive: 'The probe/GDB server is unresponsive. Call check_target_connection to confirm, then restart_debugging or stop_debugging.',
                stopped: 'Session reports stopped — please retry the operation.',
            };
            const codes: Record<StatusShape['state'], ErrorCode> = {
                'no-session': 'NO_SESSION', initializing: 'NO_SESSION', running: 'TARGET_RUNNING', unresponsive: 'TIMEOUT', stopped: 'INTERNAL',
            };
            for (const [state, hint] of Object.entries(hints) as Array<[StatusShape['state'], string]>) {
                const x = new ScriptedExecutor();
                x.stopped = false;
                x.sessionStatus = status(state);
                const fullHint = `${hint} Use get_session_status for a definitive, never-failing classification.`;
                const read = await refusalOf(handlerFor(x).handleReadMemory({ address: 'zz', length: 4 }), codes[state]);
                assert.strictEqual(read.message, `Cannot read memory: session state is '${state}'.`);
                assert.strictEqual(read.hint, fullHint);
                assert.deepStrictEqual(x.argsOf('readMemory'), [], 'the gate runs before anything else');
                const step = await refusalOf(handlerFor(x).handleStepInto(), codes[state]);
                assert.strictEqual(step.message, `Cannot step into: session state is '${state}'.`, 'the gate refusal is not wrapped');
                assert.strictEqual(step.hint, fullHint);
            }
        });
    });

    suite('session start, stop, restart and reset', () => {
        test('a second start is refused without touching the configuration manager', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped', { sessionName: null });
            let asked = false;
            const refused = await refusalOf(handlerFor(x, {}, 5, {
                promptForConfiguration: async () => {
                    asked = true;
                    return 'x';
                },
            }).handleStartDebugging({ workingDirectory: '/w', configurationName: 'C' }), 'PROBE_BUSY');
            assert.strictEqual(refused.message, 'A debug session is already active (name=\'?\', state=stopped). Refusing to start a second session.');
            assert.strictEqual(refused.hint, 'Use stop_debugging first, or call restart_debugging to reuse the current session, '
                + 'or proceed directly with inspection tools (get_variables_values, read_memory, …).');
            assert.strictEqual(asked, false);
            assert.deepStrictEqual(x.argsOf('startDebuggingByName'), []);
        });

        test('without a configuration name the picker is asked first, and its failure is wrapped', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const asked: string[] = [];
            const message = await rejectionOf(handlerFor(x, {}, 5, {
                promptForConfiguration: async (folder: string) => {
                    asked.push(folder);
                    throw new Error('picker dismissed');
                },
            }).handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/main.c' }));
            assert.deepStrictEqual(asked, ['/w']);
            assert.ok(message.startsWith('Error starting debug session: picker dismissed'), message);
            assert.deepStrictEqual(x.argsOf('startDebugging'), []);
        });

        test('a named configuration starts by name and shows the full state; motion then diffs the breakpoints', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('stopped');
            const h = handlerFor(x);
            const reply = await textAnswer(h.handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.deepStrictEqual(x.argsOf('startDebuggingByName'), [['/w', 'CMSIS Debugger: pyOCD']]);
            assert.ok(reply.startsWith('Debug session started successfully for: CMSIS Debugger: pyOCD '
                + 'using configuration \'CMSIS Debugger: pyOCD\'. Current state: {\n  "sessionActive": true,\n  "configurationName"'), reply);

            x.session = true;
            x.waiters.push({ kind: 'stopped', reason: 'step', threadId: 1 }, { kind: 'stopped', reason: 'step', threadId: 1 });
            assert.ok((await textAnswer(h.handleStepOver())).includes('"breakpointsUnchanged": 0'));
            x.state.breakpoints = ['main.c:7'];
            assert.ok((await textAnswer(h.handleStepOver())).includes('"breakpoints": [\n    "main.c:7"\n  ]'));
        });

        test('Default Configuration without a file is refused', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const refused = await refusalOf(handlerFor(x).handleStartDebugging({ workingDirectory: '/w', configurationName: 'Default Configuration' }),
                'INVALID_ARGUMENT');
            assert.ok(refused.message.startsWith('Error starting debug session: fileFullPath is required when no named configuration is provided.'),
                refused.message);
        });

        test('a file start builds the configuration and names the test', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('running');
            const built: unknown[][] = [];
            const config = { type: 'python', name: 'n', request: 'launch' };
            const reply = await textAnswer(handlerFor(x, {}, 5, {
                promptForConfiguration: async () => undefined,
                getDebugConfig: async (...args: unknown[]) => {
                    built.push(args);
                    return config;
                },
            }).handleStartDebugging({ workingDirectory: '/w', fileFullPath: '/w/test_x.py', testName: 't1' }));
            assert.deepStrictEqual(built, [['/w', '/w/test_x.py', undefined, 't1']]);
            assert.deepStrictEqual(x.argsOf('startDebugging'), [['/w', config]]);
            assert.ok(reply.startsWith('Debug session started successfully for: /w/test_x.py with default configuration for test \'t1\'. Current state: {'), reply);
        });

        test('a session that never comes up fails the start', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            x.sessionStatus = status('initializing');
            const message = await rejectionOf(handlerFor(x, fastClock(200), 5)
                .handleStartDebugging({ workingDirectory: '/w', configurationName: 'CMSIS Debugger: pyOCD' }));
            assert.ok(message.startsWith('Error starting debug session: Debug session started but failed to become active within timeout period'), message);
        });

        test('stop without a session, and with one', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual(await textAnswer(handlerFor(idle).handleStopDebugging()), 'Nothing to stop — no debug session is active.');

            const x = new ScriptedExecutor();
            const reply = await textAnswer(handlerFor(x).handleStopDebugging());
            assert.deepStrictEqual(x.argsOf('stopDebugging'), [[]]);
            assert.ok(reply.startsWith('The debug session has been stopped.\n\n⚠️ **Root-cause check before you stop**'), reply);
            assert.ok(reply.includes('1. Set breakpoints at the places worth investigating with `add_breakpoint`.'), reply);
        });

        test('restart needs a session and waits for it to come back', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual((await refusalOf(handlerFor(idle).handleRestart(), 'NO_SESSION')).message,
                'Nothing to restart — no debug session is active', 'a refusal, not wrapped');

            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped');
            assert.strictEqual(await textAnswer(handlerFor(x).handleRestart({ timeoutMs: 1 })), 'The debug session has been restarted.');
            assert.deepStrictEqual(x.argsOf('restart'), [[]]);
            assert.deepStrictEqual(x.moves, ['restart'], 'a stopped target is not paused');

            const stuck = new ScriptedExecutor();
            stuck.sessionStatus = status('initializing');
            assert.strictEqual(await rejectionOf(handlerFor(stuck, fastClock(200), 7).handleRestart()),
                'Could not restart the debug session: Debug session restart issued but target did not become ready '
                + 'within the 7s timeout. The probe or target may be unresponsive.');
        });

        test('restart pauses a running CMSIS Debugger target first and says how it restarted', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running');
            x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
            x.restartOutcome = { via: 'relaunched', configurationName: 'CMSIS Debugger: pyOCD', preLaunchTask: 'CMSIS Load' };
            x.logpoints = [{ number: 3, file: '/w/main.c', line: 12, message: 'tick' }];
            const reply = await textAnswer(handlerFor(x).handleRestart());
            assert.deepStrictEqual(x.moves, ['arm', 'pause', 'restart'], 'the pause is armed and sent before the restart');
            assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);
            assert.strictEqual(reply, 'The debug session has been restarted. '
                + 'It was stopped and its launch configuration \'CMSIS Debugger: pyOCD\' started again. '
                + 'The target was paused first. '
                + 'Its preLaunchTask "CMSIS Load" ran first; a CMSIS launch configuration flashes the image there and resets the target in its initCommands. '
                + 'The 1 GDB dprintf logpoint(s) ended with the old session; add them again with add_logpoint.');
        });

        test('restart goes ahead when the pause before it does not stop the target or fails', async () => {
            const silent = new ScriptedExecutor();
            silent.sessionStatus = status('running');
            silent.waiters.push({ kind: 'timeout' });
            const late = await textAnswer(handlerFor(silent).handleRestart());
            assert.deepStrictEqual(silent.moves, ['arm', 'pause', 'restart']);
            assert.strictEqual(late, 'The debug session has been restarted. '
                + '⚠️ The target did not stop within 5 s of the pause request; the session was restarted anyway.');

            const refused = new ScriptedExecutor();
            refused.sessionStatus = status('running');
            refused.waiters.push(new Promise<StopWaitResult>(() => undefined));
            refused.failures.pause = new ToolError('INTERNAL', 'GDB rejected \'pause\': no thread');
            const failed = await textAnswer(handlerFor(refused).handleRestart());
            assert.ok(failed.endsWith('⚠️ Pausing the target first failed (GDB rejected \'pause\': no thread); the session was restarted anyway.'), failed);
            assert.deepStrictEqual(refused.argsOf('restart'), [[]]);
        });

        test('restart does not pause other adapters, and a failed restart is wrapped with its code', async () => {
            const python = new ScriptedExecutor();
            python.sessionStatus = status('running', { sessionType: 'python' });
            assert.strictEqual(await textAnswer(handlerFor(python).handleRestart()), 'The debug session has been restarted.');
            assert.deepStrictEqual(python.moves, ['restart']);

            const broken = new ScriptedExecutor();
            broken.sessionStatus = status('stopped');
            broken.failures.restart = new Error('Restarting the debug session failed: VS Code did not start the launch configuration \'X\' again.');
            const failure = await refusalOf(handlerFor(broken).handleRestart(), 'INTERNAL');
            assert.strictEqual(failure.message,
                'Could not restart the debug session: Restarting the debug session failed: VS Code did not start the launch configuration \'X\' again.');
        });

        test('reset passes the method default and renders the outcome', async () => {
            const x = new ScriptedExecutor();
            const reply = await textAnswer(handlerFor(x).handleReset({}));
            assert.deepStrictEqual(x.argsOf('resetTarget'), [[{ method: 'auto', halt: undefined, timeoutMs: undefined }]]);
            const outcome = await new ScriptedExecutor().resetTarget({});
            assert.strictEqual(reply, renderResetOutcome(outcome as ResetOutcomeView, undefined));

            const idle = new ScriptedExecutor();
            idle.session = false;
            const refused = await refusalOf(handlerFor(idle).handleReset({ halt: false }), 'NO_SESSION');
            assert.strictEqual(errorDetail(refused), 'No active debug session.\nStart debugging first — reset drives the target through the live probe.');
        });
    });

    suite('wait_for_stop and pause', () => {
        test('wait budgets leave room for the fence', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, fastClock(100));
            await h.handleWaitForStop({ timeoutMs: 5000 });
            await h.handleWaitForStop({ timeoutMs: 1000 });
            await h.handleWaitForStop();
            assert.deepStrictEqual(x.argsOf('waitForStop'), [[3500], [100], [28500]]);
        });

        test('each wait outcome has its text', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, fastClock(100));
            const answer = (outcome: Awaited<ReturnType<IDebuggingExecutor['waitForStop']>>): Promise<ToolText> => {
                x.waitForStop = async () => outcome;
                return h.handleWaitForStop();
            };
            assert.ok((await replyAnswer(answer({ kind: 'timeout' }), 'timeout')).startsWith('Target did not stop within the timeout — it is still running'));
            const ended = await refusalOf(answer({ kind: 'ended' }), 'NO_SESSION');
            assert.ok(ended.message.startsWith('The debug session ended while waiting for a stop'), ended.message);
            assert.strictEqual(ended.hint, 'Call get_session_status to confirm.');
            assert.ok((await textAnswer(answer({ kind: 'already-stopped', reason: null }))).startsWith('Target was already stopped (reason: unknown).\n\n{'));
            assert.ok((await textAnswer(answer({ kind: 'stopped', reason: 'breakpoint', threadId: 3 }))).startsWith('Target stopped (reason: breakpoint, threadId=3).\n\n{'));
            assert.ok((await textAnswer(answer({ kind: 'stopped', reason: 'step', threadId: null }))).startsWith('Target stopped (reason: step).'));

            const idle = new ScriptedExecutor();
            idle.session = false;
            const refused = await refusalOf(handlerFor(idle).handleWaitForStop(), 'NO_SESSION');
            assert.strictEqual(errorDetail(refused), 'No active debug session.\nStart debugging first — wait_for_stop waits on a live session.');
        });

        test('pause answers by session state', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x);
            x.sessionStatus = status('stopped', { detail: 'breakpoint' });
            assert.strictEqual(await textAnswer(h.handlePause()), 'Target is already stopped (reason: breakpoint). No pause needed — proceed with inspection tools.');
            x.sessionStatus = status('stopped');
            assert.ok((await textAnswer(h.handlePause())).startsWith('Target is already stopped (reason: n/a).'));
            x.sessionStatus = status('unresponsive');
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'TIMEOUT')),
                'Cannot pause: probe/GDB server is unresponsive.\nCall check_target_connection or restart_debugging.');
            x.sessionStatus = status('initializing');
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')),
                'Cannot pause yet: session is still initializing.\nWait briefly and retry.');
            x.sessionStatus = status('no-session');
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')), 'No active debug session.');
            x.sessionStatus = status('running');
            x.waiters.push({ kind: 'timeout' });
            assert.ok((await replyAnswer(h.handlePause({ timeoutMs: 700 }), 'timeout')).startsWith('Pause requested but target did not stop within the timeout.'));
            assert.deepStrictEqual(x.argsOf('pause'), [[700]]);
            x.waiters.push({ kind: 'ended' });
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')),
                'Pause requested but the debug session ended. The target may have crashed.');
            x.session = false;
            assert.strictEqual(errorDetail(await refusalOf(h.handlePause(), 'NO_SESSION')), 'No active debug session.\nStart debugging first.');
        });
    });

    suite('breakpoints and logpoints', () => {
        let scratch: string | undefined;
        teardown(() => {
            if (scratch) {
                fs.rmSync(scratch, { recursive: true, force: true });
                scratch = undefined;
            }
        });

        /** A scripted CMSIS Debugger session whose target is halted. */
        function halted(): ScriptedExecutor {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('stopped');
            return x;
        }

        test('line numbers are checked and a location is required', async () => {
            const x = halted();
            assert.strictEqual((await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 0 }), 'INVALID_ARGUMENT')).message,
                'Error adding breakpoint: Invalid line number 0: must be a 1-based integer.');
            assert.strictEqual(await rejectionOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c' })),
                'Error adding breakpoint: No location given: pass `line` (1-based line number). '
                + 'The legacy `lineContent` form is still accepted but deprecated.');
            assert.deepStrictEqual(x.argsOf('addBreakpoint'), []);
            assert.deepStrictEqual(x.moves, [], 'a refused request pauses nothing');
        });

        test('without a session the breakpoint only goes to the model', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10, condition: 'i > 3' }));
            assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 10, { condition: 'i > 3' }]]);
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), []);
            assert.deepStrictEqual(x.moves, ['addBreakpoint']);
            assert.strictEqual(reply, 'Breakpoint added at /w/main.c:10 [when: i > 3]\n'
                + '(No debug session yet — added to VS Code\'s breakpoint list; the debugger binds it when a session starts.)');
        });

        test('the adapter\'s own report says how the breakpoint bound', async () => {
            const x = halted();
            const h = handlerFor(x);
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 })),
                'Breakpoint added at /w/main.c:10\nAdapter: verified as GDB breakpoint 7.');
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), [[2000]], 'the wait for the adapter is bounded to 2 s');

            x.binding = () => ({ reported: true, verified: true, line: 12, id: 8 });
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 11 })),
                'Breakpoint added at /w/main.c:11\nAdapter: verified as GDB breakpoint 8 at line 12.');

            x.binding = () => ({ reported: true, verified: false, message: 'No line 99 in file "main.c".' });
            const unbound = await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 99 }));
            assert.strictEqual(unbound, 'Breakpoint added at /w/main.c:99\nAdapter: NOT verified — No line 99 in file "main.c".\n'
                + 'An unverified breakpoint never stops the target: the line may have no code (a declaration, a comment, code the '
                + 'optimiser removed), the path may not match the ELF\'s compiled paths, or the FPB comparators may be used up.');

            x.binding = () => ({ reported: false, verified: false });
            assert.strictEqual(await textAnswer(h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 13 })),
                'Breakpoint added at /w/main.c:13\nAdapter: not reported by the adapter yet.\n'
                + 'Call list_breakpoints later to see whether the adapter bound it.');
            assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), [], 'no parallel GDB breakpoint');
        });

        test('other adapters: no GDB numbers, and a running target is not paused', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running', { sessionType: 'cppdbg' });
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }));
            assert.strictEqual(reply, 'Breakpoint added at /w/main.c:10\nAdapter: verified.');
            assert.deepStrictEqual(x.moves, ['addBreakpoint']);
        });

        test('the deprecated lineContent form sets every matching line and reports each', async () => {
            scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-handler-'));
            const file = path.join(scratch, 'loop.c');
            fs.writeFileSync(file, ['a', 'b', '  return;', 'c', 'd', 'e', 'return;', 'f', 'x = 1; return;', 'g'].join('\r\n'));
            const x = halted();
            x.binding = (bp) => {
                const line = (bp as vscode.SourceBreakpoint).location.range.start.line + 1;
                return line === 7 ? { reported: true, verified: false, message: 'no code' } : { reported: true, verified: true, line };
            };
            const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: file, lineContent: 'return;' }));
            assert.deepStrictEqual(x.argsOf('addBreakpoint').map((call) => call[1]), [3, 7, 9]);
            assert.ok(reply.startsWith(`Breakpoints added at 3 locations in ${file}: lines 3, 7, 9\n`
                + '⚠️ Located via the deprecated `lineContent` match (3 line(s) matched). '
                + 'Pass `line` instead — content matching hits every line containing the text.\n'
                + 'Adapter:\n  line 3: verified\n  line 7: NOT verified — no code\n  line 9: verified\nAn unverified breakpoint'), reply);
            assert.strictEqual(await rejectionOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: file, lineContent: 'nowhere' })),
                'Error adding breakpoint: Could not find any lines containing: nowhere');
        });

        suite('a change on a running CMSIS Debugger target pauses, applies and resumes', () => {
            /** A running target whose pause stops it. */
            function running(): ScriptedExecutor {
                const x = new ScriptedExecutor();
                x.sessionStatus = status('running');
                x.waiters.push({ kind: 'stopped', reason: 'SIGINT', threadId: 1 });
                x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
                x.logpoints = [{ number: 3, file: '/w/main.c', line: 5, message: 'tick' }];
                return x;
            }

            const tools: Array<[string, (h: DebuggingHandler) => Promise<ToolText>, string[]]> = [
                ['add_breakpoint', (h) => h.handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), ['addBreakpoint']],
                ['add_logpoint', (h) => h.handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }),
                    ['removeBreakpoint', 'insertDprintfViaGdb']],
                ['remove_breakpoint', (h) => h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 }),
                    ['deleteBreakpointsViaGdb', 'removeBreakpoint']],
                ['clear_all_breakpoints', (h) => h.handleClearAllBreakpoints(), ['deleteBreakpointsViaGdb', 'clearAllBreakpoints']],
            ];

            for (const [tool, call, mutation] of tools) {
                test(`${tool}: arm, pause, change, continue — and the answer says so`, async () => {
                    const x = running();
                    const reply = await textAnswer(call(handlerFor(x)));
                    assert.deepStrictEqual(x.moves, ['arm', 'pause', ...mutation, 'continue']);
                    assert.deepStrictEqual(x.argsOf('pause'), [[5000]]);
                    assert.match(reply, /\nTarget paused \d+\.\d s to apply this, then resumed\.(\n|$)/);
                });
            }

            test('a stopped target is not paused, and without a session nothing is', async () => {
                for (const [tool, call] of tools) {
                    const x = running();
                    x.sessionStatus = status('stopped');
                    const reply = await textAnswer(call(handlerFor(x)));
                    assert.ok(!x.moves.includes('pause') && !x.moves.includes('continue'), `${tool}: ${x.moves.join(', ')}`);
                    assert.ok(!reply.includes('Target paused'), `${tool}: ${reply}`);
                }
                const idle = new ScriptedExecutor();
                idle.session = false;
                await handlerFor(idle).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 });
                assert.deepStrictEqual(idle.moves, ['addBreakpoint']);
                assert.deepStrictEqual(idle.argsOf('getSessionStatus'), []);
            });

            test('a change that fails still resumes the target, and the failure keeps its code', async () => {
                const x = running();
                x.failures.addBreakpoint = new Error('model refused');
                const failure = await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), 'INTERNAL');
                assert.deepStrictEqual(x.moves, ['arm', 'pause', 'addBreakpoint', 'continue']);
                assert.strictEqual(failure.message, 'Error adding breakpoint: model refused');

                const refused = running();
                refused.gdbReplies.dprintf = { text: 'No source file named nowhere.c.', errored: true };
                const rejected = await refusalOf(handlerFor(refused).handleAddLogpoint({ fileFullPath: '/w/nowhere.c', line: 3, logMessage: 'x' }),
                    'INVALID_ARGUMENT');
                assert.deepStrictEqual(refused.moves, ['arm', 'pause', 'removeBreakpoint', 'insertDprintfViaGdb', 'continue']);
                assert.strictEqual(rejected.message, 'Could not add the logpoint: GDB rejected the logpoint: No source file named nowhere.c.');
            });

            test('a target that cannot be resumed is reported, with or without a failing change', async () => {
                const x = running();
                x.failures.continue = new Error('probe gone');
                const reply = await textAnswer(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }));
                assert.ok(reply.endsWith('\n⚠️ The target was paused for this and could not be resumed: probe gone. It is halted — call continue_execution.'),
                    reply);

                const both = running();
                both.failures.continue = new Error('probe gone');
                both.failures.addBreakpoint = new Error('model refused');
                const failure = await refusalOf(handlerFor(both).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), 'INTERNAL');
                assert.ok(failure.message.endsWith('model refused The target was paused for this and could not be resumed: probe gone.'), failure.message);
                assert.strictEqual(failure.hint, 'The target is halted: call continue_execution when ready.');
            });

            test('initializing, unresponsive, a pause that does not stop and a session that ends are refused before any change, unwrapped', async () => {
                const cases: Array<[StatusShape['state'], StopWaitResult | undefined, ErrorCode, string]> = [
                    ['initializing', undefined, 'NO_SESSION', 'Cannot add a breakpoint yet: the session is still initializing.'],
                    ['unresponsive', undefined, 'TIMEOUT', 'Cannot add a breakpoint: the probe/GDB server is unresponsive.'],
                    ['running', { kind: 'timeout' }, 'TIMEOUT',
                        'Cannot add a breakpoint: the target did not stop within 5 s of the pause request.'],
                    ['running', { kind: 'ended' }, 'NO_SESSION',
                        'Cannot add a breakpoint: the debug session ended while the target was being paused for it.'],
                ];
                for (const [state, waiter, code, message] of cases) {
                    const x = new ScriptedExecutor();
                    x.sessionStatus = status(state);
                    if (waiter) {
                        x.waiters.push(waiter);
                    }
                    const failure = await refusalOf(handlerFor(x).handleAddBreakpoint({ fileFullPath: '/w/main.c', line: 10 }), code);
                    assert.strictEqual(failure.message, message);
                    assert.ok(!x.moves.includes('addBreakpoint') && !x.moves.includes('continue'), x.moves.join(', '));
                }
            });
        });

        suite('logpoints', () => {
            test('without a session a logpoint only goes to the model', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}', condition: 'n > 1' }));
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 12, { condition: 'n > 1', logMessage: 'n={n}' }]]);
                assert.strictEqual(reply, 'Logpoint added at /w/main.c:12\n(No debug session yet — added to VS Code\'s breakpoint list. '
                    + 'The CMSIS Debugger prints such a logpoint\'s text without the {expr} values: '
                    + 'call add_logpoint again once the session is up to set it as a GDB dprintf.)');
            });

            test('on the CMSIS Debugger a logpoint is a GDB dprintf at a workspace-relative location, remembered by number', async () => {
                const x = halted();
                const h = handlerFor(x, { workspaceFolders: () => [{ uri: vscode.Uri.file('/w'), name: 'w', index: 0 }] });
                const reply = await textAnswer(h.handleAddLogpoint({ fileFullPath: '/w/src/main.c', line: 12, logMessage: 'n={n:%u} at {p->x}', condition: ' n > 5 ' }));
                assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), [['src/main.c:12', 'n=%u at %d\\n', ['n', 'p->x']]]);
                assert.deepStrictEqual(x.argsOf('setBreakpointConditionViaGdb'), [[3, 'n > 5']]);
                assert.deepStrictEqual(x.argsOf('rememberGdbLogpoint'),
                    [[{ number: 3, file: '/w/src/main.c', line: 12, message: 'n={n:%u} at {p->x}', condition: 'n > 5' }]]);
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [], 'no VS Code logpoint besides the dprintf');
                assert.deepStrictEqual(x.argsOf('removeBreakpoint'), [['/w/src/main.c', 12, { logpointsOnly: true }]]);
                const lines = reply.split('\n');
                assert.deepStrictEqual(lines.slice(0, 5), [
                    'Logpoint added at /w/src/main.c:12',
                    '  GDB dprintf 3 (main.c:12, 0x080002f4): dprintf src/main.c:12,"n=%u at %d\\n",n,p->x',
                    '  Condition: n > 5',
                    'It prints to VS Code\'s Debug Console; list_breakpoints shows how often it fired. remove_breakpoint on /w/src/main.c:12 deletes it.',
                    '',
                ]);
                assert.ok(lines[5].startsWith('ℹ️ On Cortex-M a logpoint is not free:'), lines[5]);
            });

            test('a VS Code logpoint set there before the session is replaced; several locations are flagged', async () => {
                const x = halted();
                x.breakpoints = [new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file('/w/main.c'), new vscode.Position(11, 0)),
                    true, undefined, undefined, 'n={n}')];
                x.gdbReplies.dprintf = {
                    text: JSON.stringify({ bkpt: [{ number: '4', addr: '<MULTIPLE>' }, { number: '4.1', file: 'main.c', line: '12' }, { number: '4.2' }] }),
                    errored: false,
                };
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }));
                assert.deepStrictEqual(x.breakpoints, []);
                assert.ok(reply.includes('\n  GDB dprintf 4 (main.c:12): dprintf main.c:12,"n=%d\\n",n\n'
                    + '⚠️ GDB set it at 2 locations: the location matched more than one place.\n'
                    + 'Replaced the VS Code logpoint set at this line before the session, which printed its text without the values.\n'), reply);
            });

            test('GDB\'s refusals: location, condition (taken back out), running target, and a reply that names no breakpoint', async () => {
                const x = halted();
                x.gdbReplies.dprintf = { text: 'No line 99 in file "main.c".', errored: true };
                const rejected = await refusalOf(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 99, logMessage: '{q}' }), 'INVALID_ARGUMENT');
                assert.strictEqual(errorDetail(rejected), 'Could not add the logpoint: GDB rejected the logpoint: No line 99 in file "main.c".\n'
                    + 'Check that the line has code and the path matches the ELF\'s compiled paths, and that every expression is in scope at that line.');
                assert.deepStrictEqual(x.argsOf('rememberGdbLogpoint'), []);

                const badCondition = halted();
                badCondition.gdbReplies.condition = { text: 'No symbol "q" in current context.', errored: true };
                await refusalOf(handlerFor(badCondition).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x', condition: 'q' }),
                    'INVALID_ARGUMENT');
                assert.deepStrictEqual(badCondition.argsOf('deleteBreakpointsViaGdb'), [[[3]]], 'the dprintf is taken back out');
                assert.deepStrictEqual(badCondition.argsOf('rememberGdbLogpoint'), []);

                const racing = halted();
                racing.gdbReplies.dprintf = { text: 'Cannot execute this command while the target is running.', errored: true };
                const raced = await refusalOf(handlerFor(racing).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x' }), 'TARGET_RUNNING');
                assert.strictEqual(raced.hint, 'pause_execution first, or wait_for_stop if a stop is expected.');

                const garbled = halted();
                garbled.gdbReplies.dprintf = { text: '', errored: false };
                assert.match((await refusalOf(handlerFor(garbled).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'x' }), 'INTERNAL'))
                    .message, /GDB did not report the new dprintf: <empty reply>$/);

                assert.strictEqual(await rejectionOf(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 3, logMessage: 'x={' })),
                    'Could not add the logpoint: Unbalanced \'{\' in logMessage at position 2. Use {{ for a literal brace.');
            });

            test('other adapters keep a VS Code logpoint, which they fill in themselves', async () => {
                const x = new ScriptedExecutor();
                x.sessionStatus = status('stopped', { sessionType: 'cppdbg' });
                const reply = await textAnswer(handlerFor(x).handleAddLogpoint({ fileFullPath: '/w/main.c', line: 12, logMessage: 'n={n}' }));
                assert.deepStrictEqual(x.argsOf('addBreakpoint'), [['/w/main.c', 12, { condition: undefined, logMessage: 'n={n}' }]]);
                assert.deepStrictEqual(x.argsOf('insertDprintfViaGdb'), []);
                assert.ok(reply.startsWith('Logpoint added at /w/main.c:12\nAdapter: verified.\n\nℹ️'), reply);
            });
        });

        test('remove: the model breakpoint and the logpoint at that line, and nothing when there is none', async () => {
            const x = halted();
            const h = handlerFor(x);
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })),
                'Nothing to remove — no breakpoint is set at /w/main.c:5.');
            assert.deepStrictEqual(x.moves, []);

            x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })), 'Breakpoint removed from /w/main.c:5');
            assert.deepStrictEqual(x.argsOf('removeBreakpoint'), [['/w/main.c', 5, undefined]]);
            assert.deepStrictEqual(x.argsOf('deleteBreakpointsViaGdb'), [], 'no GDB `clear`');

            x.breakpoints = [sourceBreakpoint('/w/main.c', 4)];
            x.removalApplied = false;
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 5 })),
                'Breakpoint removed from /w/main.c:5\n⚠️ The debug adapter did not confirm the change within 2 s; list_breakpoints shows what it reports.');

            x.logpoints = [{ number: 3, file: '/w/main.c', line: 7, message: 'tick' }, { number: 5, file: '/w/led.c', line: 7, message: 'tock' }];
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/main.c', line: 7 })),
                'Logpoint removed from /w/main.c:7\nDeleted GDB dprintf 3.');
            assert.deepStrictEqual(x.argsOf('deleteBreakpointsViaGdb'), [[[3]]]);
            assert.deepStrictEqual(x.logpoints.map((logpoint) => logpoint.number), [5]);

            x.gdbReplies.delete = { text: 'No breakpoint number 5.', errored: false };
            assert.strictEqual(await textAnswer(h.handleRemoveBreakpoint({ fileFullPath: '/w/led.c', line: 7 })),
                'Logpoint removed from /w/led.c:7\nGDB no longer had dprintf 5 (deleted outside these tools).');
            assert.deepStrictEqual(x.logpoints, []);
        });

        test('clear all: the model and the logpoints by number — never a bare delete', async () => {
            const idle = new ScriptedExecutor();
            idle.session = false;
            assert.strictEqual(await textAnswer(handlerFor(idle).handleClearAllBreakpoints()), 'Nothing to clear — no breakpoints are set.');
            idle.breakpoints = [sourceBreakpoint('/w/a.c', 1), sourceBreakpoint('/w/b.c', 2)];
            assert.strictEqual(await textAnswer(handlerFor(idle).handleClearAllBreakpoints()), 'Cleared 2 breakpoint(s) from the model.');

            const live = halted();
            assert.strictEqual(await textAnswer(handlerFor(live).handleClearAllBreakpoints()), 'Nothing to clear — no breakpoints are set.');
            assert.deepStrictEqual(live.moves, [], 'nothing is sent to GDB when nothing is set');

            live.breakpoints = [sourceBreakpoint('/w/a.c', 1)];
            live.logpoints = [{ number: 3, file: '/w/main.c', line: 7, message: 'tick' }, { number: 4, file: '/w/main.c', line: 9, message: 'tock' }];
            assert.strictEqual(await textAnswer(handlerFor(live).handleClearAllBreakpoints()),
                'Cleared 1 breakpoint(s) from the model.\nDeleted GDB dprintf 3, 4.');
            assert.deepStrictEqual(live.moves, ['deleteBreakpointsViaGdb', 'clearAllBreakpoints'], 'the logpoints go first');
            assert.deepStrictEqual(live.argsOf('deleteBreakpointsViaGdb'), [[[3, 4]]]);
            assert.deepStrictEqual(live.logpoints, []);
        });

        test('the list numbers every breakpoint and shows the binding and the logpoints with their hits', async () => {
            const x = halted();
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()), 'The breakpoint list is empty.');
            x.breakpoints = [
                sourceBreakpoint('/w/src/main.c', 41, 'x'),
                new vscode.FunctionBreakpoint('HardFault_Handler'),
                { enabled: true } as unknown as vscode.Breakpoint,
                sourceBreakpoint('/w/src/led.c', 0),
            ];
            x.binding = (bp) => bp instanceof vscode.FunctionBreakpoint
                ? { reported: true, verified: false, message: 'Function "HardFault_Handler" not defined.' }
                : bp instanceof vscode.SourceBreakpoint && bp.location.range.start.line === 0
                    ? { reported: false, verified: false }
                    : { reported: true, verified: true, line: 42 };
            x.logpoints = [
                { number: 3, file: '/w/src/main.c', line: 50, message: 'n={n}', condition: 'n > 2' },
                { number: 9, file: '/w/src/main.c', line: 60, message: 'gone' },
            ];
            assert.strictEqual(await textAnswer(handlerFor(x).handleListBreakpoints()),
                'Breakpoints that are set:\n'
                + '1. main.c:42 [when: x] — verified\n'
                + '2. Function: HardFault_Handler — NOT verified — Function "HardFault_Handler" not defined.\n'
                + '4. led.c:1 — not reported by the adapter yet\n'
                + 'GDB dprintf logpoints (they print to the Debug Console):\n'
                + '5. main.c:50 [when: n > 2, log: n={n}] — GDB dprintf 3, 4 hits\n'
                + '6. main.c:60 [log: gone] — dprintf 9 is gone from GDB (deleted outside these tools)\n');
            assert.deepStrictEqual(x.argsOf('breakpointBinding'), [[0], [0], [0]], 'the list does not wait for the adapter');
            assert.deepStrictEqual(x.logpoints.map((logpoint) => logpoint.number), [3], 'a logpoint GDB no longer has is forgotten');

            x.gdbReplies.list = { text: 'Cannot access memory', errored: true };
            assert.ok((await textAnswer(handlerFor(x).handleListBreakpoints())).endsWith('5. main.c:50 [when: n > 2, log: n={n}] — GDB dprintf 3\n'));

            const idle = new ScriptedExecutor();
            idle.session = false;
            idle.breakpoints = [sourceBreakpoint('/w/src/main.c', 41)];
            assert.strictEqual(await textAnswer(handlerFor(idle).handleListBreakpoints()), 'Breakpoints that are set:\n1. main.c:42\n');
        });
    });

    suite('variables and expressions', () => {
        const focusedOn = (frameId: number | undefined): Partial<HandlerHost> => ({ focusedFrameId: () => frameId });
        const localScope = [{ name: 'Local', variables: [{ name: 'count', value: '3', type: 'int' }] }];

        test('a missing global scope widens to all', async () => {
            const x = new ScriptedExecutor();
            x.getVariables = async (frameId, scope, ms) => {
                x.note('getVariables', frameId, scope, ms);
                return scope === 'global' ? { scopes: [] } : { scopes: localScope };
            };
            const reply = await textAnswer(handlerFor(x, focusedOn(7)).handleGetVariables({ scope: 'global', timeoutMs: 900 }));
            assert.deepStrictEqual(x.argsOf('getVariables'), [[7, 'global', 900], [7, 'all', 900]]);
            assert.ok(reply.startsWith('Note: No dedicated "Global" scope is available from this debug adapter. '
                + 'Showing all available scopes instead. Use evaluate_expression to inspect specific global variables by name.\n\n'
                + 'Variables:\n==========\n\nLocal:\n  count: 3 (int)\n'), reply);

            const none = await textAnswer(handlerFor(x, focusedOn(7)).handleGetVariables({ variableNames: ['nope', 'other'] }));
            assert.strictEqual(none, 'None of the requested variables are in scope: nope, other.\nCall list_variable_names to see what is available here.');
        });

        test('the variable tools need a focused frame and scopes', async () => {
            const x = new ScriptedExecutor();
            const unfocused = await refusalOf(handlerFor(x, focusedOn(undefined)).handleListVariableNames({}), 'TARGET_RUNNING');
            assert.strictEqual(errorDetail(unfocused), 'There is no active stack frame.\n'
                + 'Call wait_for_stop, which returns once the target is stopped at a frame, or pause_execution if it is running; then retry.');
            await refusalOf(handlerFor(x, focusedOn(undefined)).handleEvaluateExpression({ expression: 'x' }), 'TARGET_RUNNING');
            assert.strictEqual(await textAnswer(handlerFor(x, focusedOn(0)).handleGetVariables({})),
                'The debug adapter reports no variable scopes at the current execution point.');
            assert.deepStrictEqual(x.argsOf('getVariables'), [[0, 'all', undefined]]);
            x.getVariables = async () => ({ scopes: localScope });
            assert.ok((await textAnswer(handlerFor(x, focusedOn(3)).handleListVariableNames({ scope: 'local' }))).includes('  count: int\n'));
        });

        test('evaluate redacts by name, leaves -exec alone and shows the type', async () => {
            const x = new ScriptedExecutor();
            x.evaluateExpression = async (expression) => expression === 'apiKey'
                ? { result: '"k3y-value-123"', type: 'char *' }
                : { result: 'ghp_abcdefghijklmnopqrstuv0123' };
            const h = handlerFor(x, focusedOn(4));
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'apiKey' })),
                `Evaluated: apiKey\nResult: <redacted: possible secret>\nType: char *\n\n${REDACTION_NOTICE}`);
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '  -exec info registers' })),
                'Evaluated:   -exec info registers\nResult: ghp_abcdefghijklmnopqrstuv0123');
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '>info registers' })),
                'Evaluated: >info registers\nResult: ghp_abcdefghijklmnopqrstuv0123', 'the > spelling is a GDB command too');
            x.evaluateExpression = async () => ({ result: '' });
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: '-exec set var x = 1' })),
                'Evaluated: -exec set var x = 1\nResult: (GDB printed nothing)');
            x.evaluateExpression = async () => ({ result: undefined });
            assert.strictEqual((await refusalOf(h.handleEvaluateExpression({ expression: 'x' }), 'INTERNAL')).message,
                'The debug adapter returned no result for this expression.');
            x.evaluateExpression = async () => ({ result: 42, type: 'int' });
            assert.strictEqual(await textAnswer(h.handleEvaluateExpression({ expression: 'x' })), 'Evaluated: x\nResult: 42\nType: int');
        });

        test('frame variables use the given frame', async () => {
            const x = new ScriptedExecutor();
            const h = handlerFor(x, focusedOn(undefined));
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12 })), 'No variable scopes available for frameId=12.');
            x.getVariablesForFrame = async () => ({ scopes: localScope });
            assert.strictEqual(await textAnswer(h.handleGetFrameVariables({ frameId: 12, variableNames: ['zz'] })),
                'None of the requested variables are in scope at frameId=12: zz.');
            assert.ok((await textAnswer(h.handleGetFrameVariables({ frameId: 12 }))).startsWith('Variables for frameId=12:\n==========\n\nLocal:\n  count: 3 (int)'));
        });
    });

    suite('raw target reads', () => {
        test('memory dump: header, hex rows and ASCII block', async () => {
            const x = new ScriptedExecutor();
            const bytes = Buffer.from('Hello, Cortex-M!\x00\x01ab', 'latin1');
            x.readMemory = async () => bytes;
            const reply = await textAnswer(handlerFor(x).handleReadMemory({ address: '20000000', length: 20, format: 'both' }));
            assert.strictEqual(reply, 'Memory at 0x20000000 (20 bytes):\n'
                + '\nHex:\n  0x20000000: 48 65 6c 6c 6f 2c 20 43 6f 72 74 65 78 2d 4d 21\n  0x20000010: 00 01 61 62\n'
                + '\nASCII:\n  Hello, Cortex-M!..ab\n');
            x.readMemory = async () => bytes.subarray(0, 4);
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x20000000', length: 20, format: 'hex' })),
                'Memory at 0x20000000 (20 bytes):\n\nHex:\n  0x20000000: 48 65 6c 6c\n');
            await refusalOf(handlerFor(x).handleReadMemory({ address: 'zz', length: 4 }), 'INTERNAL');
        });

        test('a long ASCII block breaks after every 64 characters', async () => {
            const x = new ScriptedExecutor();
            x.readMemory = async () => Buffer.alloc(70, 0x41);
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadMemory({ address: '0x0', length: 70, format: 'ascii' })),
                `Memory at 0x0 (70 bytes):\n\nASCII:\n  ${'A'.repeat(64)}\n  AAAAAA\n`);
        });

        test('core registers are normalised and laid out in fixed cells', async () => {
            const x = new ScriptedExecutor();
            x.registers = {
                r0: '536870912', r1: '0x8000123 <main+4>', r2: '0X1F <x>', r3: '-7', r4: '', r6: '0', r7: '1', r8: '2', r9: '3',
                r10: '4', r11: '5', r12: '6', sp: '0x20017fd0', lr: '134218161', pc: '0x80002fe <main+22>',
                xpsr: '[ Z C ]', msp: '0x20017fd0', psp: '0x0', control: '0', faultmask: '0', basepri: '0', primask: '1',
            };
            const reply = await textAnswer(handlerFor(x).handleReadCoreRegisters());
            const cell = (name: string, value: string): string => `${name.padEnd(4)}= ${value.padEnd(14)}`;
            assert.strictEqual(reply, 'Core Registers:\n'
                + `  ${cell('r0', '0x20000000')}${cell('r1', '0x8000123')}${cell('r2', '0X1F <x>')}${cell('r3', '-7')}\n`
                + `  ${cell('r4', '<?>')}${cell('r5', '<?>')}${cell('r6', '0x00000000')}${cell('r7', '0x00000001')}\n`
                + `  ${cell('r8', '0x00000002')}${cell('r9', '0x00000003')}${cell('r10', '0x00000004')}${cell('r11', '0x00000005')}\n`
                + `  ${cell('r12', '0x00000006')}${cell('sp', '0x20017fd0')}${cell('lr', '0x080001b1')}${cell('pc', '0x80002fe')}\n`
                + '  xpsr = [ Z C ]\n  msp  = 0x20017fd0\n  psp  = 0x0\n  control   = 0\n'
                + '  faultmask = 0x00000000\n  basepri   = 0x00000000\n  primask   = 0x00000001\n');
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'), [[undefined, undefined]]);
        });

        test('cycle counter, present or not', async () => {
            const x = new ScriptedExecutor();
            x.readCycleCounter = async () => ({ cycles: 0, enabledNow: false, present: false });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadCycleCounter()),
                'This core reports no DWT cycle counter (DWT_CTRL.NOCYCCNT=1) — read_cycle_counter is unavailable. '
                + 'Use an RTOS tick or a timer peripheral for timing instead.');
            x.readCycleCounter = async () => ({ cycles: 255, enabledNow: true, present: true });
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadCycleCounter()), 'DWT cycle counter: 255 (0x000000ff)\n'
                + 'DWT was enabled during this call — deltas are valid from now.\n'
                + 'Wrap: 32-bit, wraps every 2^32 cycles (~10.7 s @ 400 MHz) — for longer spans, sample repeatedly and accumulate.\n'
                + 'Note: CYCCNT stops while the core is halted and during WFE sleep — it counts ACTIVE cycles only.\n'
                + 'To time a region: read here, continue_execution / wait_for_stop to the end point, read again, subtract (mod 2^32).');
        });

        test('peripheral registers and fault info pass the executor text through', async () => {
            const x = new ScriptedExecutor();
            assert.strictEqual(await textAnswer(handlerFor(x).handleReadPeripheralRegister({ peripheral: 'RCC' })), 'peripheral text');
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetFaultInfo()), 'fault text');
        });
    });

    suite('fault diagnosis and SVD lookups', () => {
        test('diagnose_fault degrades section by section', async () => {
            const x = new ScriptedExecutor();
            x.failures.readCoreRegisters = new Error('registers timed out');
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.ok(reply.startsWith('=== Fault diagnosis ==='), reply);
            assert.ok(reply.includes('Exception frame: LR unavailable — read_core_registers, then read_memory at PSP/MSP'), reply);
            assert.ok(reply.includes('Skipped (timeout or read failure): core registers —'), reply);
            assert.ok(reply.includes('Note: no SVD found — addresses are classified by the Cortex-M system map only; '
                + 'pass svdFile to lookup_peripheral to resolve them'), reply);
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), []);
            assert.deepStrictEqual(x.argsOf('getCallStack'), [[undefined, 3, undefined]]);
            assert.deepStrictEqual(x.argsOf('readCoreRegisters'),
                [[undefined, ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim']]]);

            const y = new ScriptedExecutor();
            y.registers = { sp: '0x20001000', lr: '-7', pc: '0x08000100', msp: '0x20001000', psp: '0x0' };
            y.getCallStack = async (threadId, levels, ms) => {
                y.note('getCallStack', threadId, levels, ms);
                throw new Error('no stack');
            };
            const noStack = await textAnswer(handlerFor(y).handleDiagnoseFault({ levels: 5, timeoutMs: 4000 }));
            assert.ok(noStack.includes('Skipped (timeout or read failure): call stack —'), noStack);
            assert.deepStrictEqual(y.argsOf('getCallStack'), [[undefined, 5, 4000]]);
        });

        test('an EXC_RETURN in LR reads the stacked frame', async () => {
            const x = new ScriptedExecutor();
            x.registers = { sp: '0x20001000', lr: '0xfffffff9', pc: '0x080001a4', xpsr: '1627389955', msp: '0x20001000', psp: '0x0' };
            const frame = Buffer.alloc(32);
            frame.writeUInt32LE(0x0800027a, 24);
            x.readExceptionFrame = async (sp, ms) => {
                x.note('readExceptionFrame', sp, ms);
                return frame;
            };
            x.getCallStack = async () => [{ name: 'HardFault_Handler' }, { name: 'led_toggle', source: '/w/led.c', line: 18, frameId: 1002 }];
            const reply = await textAnswer(handlerFor(x).handleDiagnoseFault());
            assert.deepStrictEqual(x.argsOf('readExceptionFrame'), [[0x20001000, undefined]]);
            assert.ok(reply.includes('Exception frame: MSP @ 0x20001000 (EXC_RETURN 0xfffffff9)'), reply);
            assert.ok(reply.includes('  #1 led_toggle @ /w/led.c:18 [frameId=1002]'), reply);

            x.readExceptionFrame = async () => Buffer.alloc(16);
            assert.ok((await textAnswer(handlerFor(x).handleDiagnoseFault())).includes('Exception frame: short read at MSP'));
            x.registers = { lr: '0xfffffffd', msp: '0x20001000' };
            assert.ok((await textAnswer(handlerFor(x).handleDiagnoseFault())).includes('Exception frame: PSP unavailable — read_core_registers'));
        });

        test('lookup_peripheral: address first, then name, then the list', async () => {
            const h = handlerFor(new ScriptedExecutor());
            const byAddress = await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, address: '0x40023800', name: 'GPIOA' }));
            assert.ok(byAddress.startsWith('0x40023800 = RCC.CR'), byAddress);
            assert.strictEqual(await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, address: 'zz' })),
                '\'zz\' is not an address — pass hex like 0x40005400 or a decimal number.');
            assert.strictEqual(await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, name: 'RCX' })),
                'Peripheral \'RCX\' is not in the SVD of TESTDEVICE. Did you mean: RCC?\nCall lookup_peripheral without name for the full list.');
            assert.ok((await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD, name: 'gpioa' }))).startsWith('=== GPIOA @ 0x40020000 ==='));
            assert.ok((await textAnswer(h.handleLookupPeripheral({ svdFile: FIXTURE_SVD }))).startsWith('TESTDEVICE: 5 peripherals'));
        });

        test('lookup_register names what is missing', async () => {
            const h = handlerFor(new ScriptedExecutor());
            assert.strictEqual(await textAnswer(h.handleLookupRegister({ svdFile: FIXTURE_SVD, peripheral: 'RCC', register: 'CRX' })),
                'Register \'CRX\' is not in RCC. Did you mean: CR?\nCall lookup_peripheral { name: \'RCC\' } for its register map.');
            assert.ok((await textAnswer(h.handleLookupRegister({ svdFile: FIXTURE_SVD, peripheral: 'rcc', register: 'cr' }))).startsWith('=== RCC.CR @ 0x40023800'));
            const missing = await textAnswer(h.handleLookupRegister({ svdFile: '/nonexistent/device.svd', peripheral: 'RCC', register: 'CR' }));
            // The lookup normalises the path, so Windows reports it with backslashes.
            assert.ok(missing.startsWith(`No SVD file found for a lookup.\nTried:\n  - svdFile ${path.normalize('/nonexistent/device.svd')} (not found)`), missing);
            assert.ok(missing.endsWith('Pass svdFile (the device .svd from the DFP; ${CMSIS_PACK_ROOT} is expanded), '
                + 'or build the solution so out/<context>.cbuild-run.yml names it, or add "svdFile" to the launch configuration. '
                + 'For a multi-core device pass pname to pick the core.'), missing);
        });
    });

    suite('stack, threads, status, device and connection', () => {
        test('call stack: default cut, explicit depth, and frame details', async () => {
            const x = new ScriptedExecutor();
            x.getCallStack = async (threadId, levels, ms) => {
                x.note('getCallStack', threadId, levels, ms);
                return frames(25);
            };
            const cut = (await textAnswer(handlerFor(x).handleGetCallStack({ threadId: 2 }))).split('\n');
            assert.strictEqual(cut[0], 'Call stack (25 frames):');
            assert.strictEqual(cut[1], '  # 0  fn0  @ /w/f0.c:1 [frameId=1000]');
            assert.strictEqual(cut[20], '  #19  fn19  @ /w/f19.c:20 [frameId=1019]');
            assert.deepStrictEqual(cut.slice(21), ['  … 5 more frames — pass levels to see all', '',
                'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.']);
            assert.deepStrictEqual(x.argsOf('getCallStack'), [[2, 50, undefined]]);
            const all = (await textAnswer(handlerFor(x).handleGetCallStack({ levels: 30 }))).split('\n');
            assert.strictEqual(all.length, 1 + 25 + 2);

            x.getCallStack = async () => [{ name: 'Reset_Handler' }];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetCallStack({})),
                'Call stack (1 frame):\n  # 0  Reset_Handler  @ <no source>:?\n\n'
                + 'Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
            x.getCallStack = async () => [];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetCallStack({})), 'No stack frames available.');
        });

        test('threads: top frames and the cut at 32', async () => {
            const x = new ScriptedExecutor();
            x.getThreads = async () => Array.from({ length: 40 }, (_, i): ThreadShape => (i === 0
                ? { id: 1, name: 'app_main', topFrame: { name: 'main', source: '/w/main.c', line: 42 } }
                : { id: i + 1, name: `task${i + 1}` }));
            const lines = (await textAnswer(handlerFor(x).handleGetThreads())).split('\n');
            assert.strictEqual(lines[0], 'Threads / RTOS tasks (40):');
            assert.strictEqual(lines[1], '  [1] app_main  → main @ /w/main.c:42');
            assert.strictEqual(lines[2], '  [2] task2');
            assert.deepStrictEqual(lines.slice(33), ['  … 8 more threads', '', 'Tip: pass a threadId to get_call_stack to inspect a specific task.']);
            x.getThreads = async () => [];
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetThreads()), 'No threads reported by the debug adapter.');
        });

        test('check_target_connection turns a hardware timeout into text', async () => {
            const x = new ScriptedExecutor();
            const timeout = new HardwareTimeoutError('DAP threads', 3000);
            x.checkTargetConnection = async () => {
                throw timeout;
            };
            assert.strictEqual(await textAnswer(handlerFor(x).handleCheckTargetConnection()), `check_target_connection: ${timeout.message}`);
            x.checkTargetConnection = async () => {
                throw new Error('boom');
            };
            assert.strictEqual(await rejectionOf(handlerFor(x).handleCheckTargetConnection()), 'Error checking target connection: boom');
            x.checkTargetConnection = async () => 'No active debug session.';
            assert.strictEqual(await textAnswer(handlerFor(x).handleCheckTargetConnection()), 'No active debug session.');
        });

        test('session status lists what is known and ends with a hint for the state', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = { state: 'stopped', sessionName: 'S', sessionType: 'gdbtarget', configurationName: 'C',
                dapResponsive: true, dapProbeMs: 12, detail: 'Stopped reason: step' };
            x.getDiagnostics = () => ({ serverVersion: '1.2.3', liveSessionCount: 2, liveSessionNames: ['S', 'T'], hasVscodeActiveSession: true });
            assert.strictEqual(await textAnswer(handlerFor(x).handleGetSessionStatus()), 'State: stopped\nSession: S\nType: gdbtarget\nConfiguration: C\n'
                + 'DAP responsive: true (probe 12ms)\nDetail: Stopped reason: step\n'
                + 'Diagnostics: serverVersion=1.2.3, liveSessionsInThisWindow=2 [S, T], vscodeActiveDebugSession=set\n'
                + 'Hint: full inspection (variables, memory, registers) is available.');

            const hints: Array<[StatusShape['state'], string]> = [
                ['no-session', 'Hint: call start_debugging or cmsis_action load_and_debug to attach.'],
                ['initializing', 'Hint: the adapter is still starting — wait a moment and retry.'],
                ['running', 'Hint: target is running. Add a breakpoint then continue_execution, or call pause_execution to inspect now.'],
                ['unresponsive', 'Hint: probe/GDB server is hung. Try restart_debugging, stop_debugging, or check the physical connection.'],
            ];
            for (const [state, hint] of hints) {
                x.sessionStatus = { state, sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
                const text = await textAnswer(handlerFor(x).handleGetSessionStatus());
                assert.strictEqual(text, `State: ${state}\nDAP responsive: false\n`
                    + 'Diagnostics: serverVersion=1.2.3, liveSessionsInThisWindow=2 [S, T], vscodeActiveDebugSession=set\n' + hint);
            }
            x.getDiagnostics = () => ({ serverVersion: '1.2.3', liveSessionCount: 0, liveSessionNames: [], hasVscodeActiveSession: false });
            x.sessionStatus = { state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null };
            const empty = await textAnswer(handlerFor(x).handleGetSessionStatus());
            assert.ok(empty.includes('liveSessionsInThisWindow=0, vscodeActiveDebugSession=undefined\n'
                + 'Hint: no debug session is running in the VS Code window this call was routed to.'), empty);
        });

        test('device info adds the active CMSIS target', async () => {
            const x = new ScriptedExecutor();
            let answer: () => unknown = () => 'HP@debug';
            const registration = vscode.commands.registerCommand('cmsis-csolution.getActiveTargetSet', () => answer());
            try {
                assert.strictEqual(await textAnswer(handlerFor(x).handleGetDeviceInfo()),
                    '=== Debug Session Info ===\n  Session name: S\n  CMSIS target: HP@debug');
                answer = () => {
                    throw new Error('not ready');
                };
                assert.strictEqual(await textAnswer(handlerFor(x).handleGetDeviceInfo()), '=== Debug Session Info ===\n  Session name: S\n');
            } finally {
                registration.dispose();
            }
            x.session = false;
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleGetDeviceInfo(), 'NO_SESSION')),
                'No active debug session.\nStart debugging first.', 'a refusal, not wrapped');
        });
    });

    suite('cmsis_action', () => {
        let registrations: vscode.Disposable | undefined;
        teardown(() => {
            registrations?.dispose();
            registrations = undefined;
        });

        const solutionOn = (target: string, more: Record<string, (...args: unknown[]) => unknown> = {}): void => {
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => '/w/demo.csolution.yml',
                'cmsis-csolution.getActiveTargetSet': () => target,
                ...more,
            });
        };

        test('refusals come before any CMSIS command', async () => {
            const x = new ScriptedExecutor();
            x.sessionStatus = status('running', { sessionName: 'CMSIS Debugger' });
            const executed: string[] = [];
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => {
                    executed.push('getSolutionFile');
                    return '/w/demo.csolution.yml';
                },
                'cmsis-csolution.getActiveTargetSet': () => 'HE',
                'cmsis-csolution.cmsisLoadAndDebug': () => {
                    executed.push('cmsisLoadAndDebug');
                },
            });
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'load_and_debug' }), 'PROBE_BUSY')),
                'A debug session is already active (name=\'CMSIS Debugger\', state=running). Refusing to load_and_debug.\n'
                + 'Use stop_debugging or restart_debugging first, or proceed with inspection.');
            assert.deepStrictEqual(executed, []);

            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach', target: '@x' }), 'INVALID_ARGUMENT')),
                'CMSIS \'detach\' not attempted: target \'@x\' is not a valid reference — '
                + 'pass a target-type name or type@set as declared in the csolution, e.g. \'MPS3\' or \'HP@debug\'.');
            assert.strictEqual(errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach', target: 'HP' }), 'PROBE_BUSY')),
                'CMSIS \'detach\' not attempted: the active target is \'HE\' and switching to \'HP\' re-activates the solution, '
                + 'which is not done under a live debug session.\nCall stop_debugging first, then repeat this call.');
        });

        test('an unknown action is noticed only after the solution checks (KB17)', async () => {
            const x = new ScriptedExecutor();
            const asked: string[] = [];
            registrations = standIns({
                'cmsis-csolution.getSolutionFile': () => {
                    asked.push('solution');
                    return '/w/demo.csolution.yml';
                },
                'cmsis-csolution.getActiveTargetSet': () => {
                    asked.push('target');
                    return 'HE';
                },
            });
            const action = 'reboot' as Parameters<DebuggingHandler['handleCmsisCommand']>[0]['action'];
            assert.strictEqual((await refusalOf(handlerFor(x).handleCmsisCommand({ action }), 'INVALID_ARGUMENT')).message, 'Unknown CMSIS action: reboot');
            assert.deepStrictEqual(asked, ['solution', 'target']);
        });

        test('no active solution is answered before anything runs', async () => {
            const x = new ScriptedExecutor();
            const refused = await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'stop_run' }), 'CMSIS_NO_SOLUTION');
            assert.ok(refused.message.startsWith('CMSIS \'stop_run\' not attempted: the CMSIS Solution extension reports no active solution '
                + 'in this VS Code window (cmsis-csolution.getSolutionFile → query failed: '), refused.message);
            assert.ok(refused.hint?.includes('(serverVersion=9.8.7)'), refused.hint);
        });

        test('a failing command within the kick-off is returned through the fence; a late one is dropped', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => {
                    throw new Error('no active solution');
                },
            });
            const noSolution = errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach' }), 'CMSIS_NO_SOLUTION'));
            assert.ok(noSolution.startsWith('CMSIS \'detach\' failed: no active CMSIS solution. '), noSolution);
            assert.ok(noSolution.includes('(serverVersion=9.8.7)'), noSolution);
            registrations?.dispose();

            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => {
                    throw new Error('boom');
                },
            });
            const other = errorDetail(await refusalOf(handlerFor(x).handleCmsisCommand({ action: 'detach' }), 'TASK_FAILED'));
            assert.match(other, /^CMSIS command 'cmsis-csolution.cmsisDetachDebugger' failed: .*boom.*\.\nEnsure the CMSIS Solution extension is installed and a solution context is active\./s);
            registrations?.dispose();

            solutionOn('HE', {
                'cmsis-csolution.cmsisDetachDebugger': () => new Promise((_, fail) => setTimeout(() => fail(new Error('late')), 300)),
            });
            assert.strictEqual(await textAnswer(handlerFor(x, fastClock(100)).handleCmsisCommand({ action: 'detach' })),
                'CMSIS \'detach\' on HE issued via \'cmsis-csolution.cmsisDetachDebugger\'. '
                + 'It runs in the CMSIS extension — check the CMSIS output channel if you need to confirm.');
            await delay(400);
        });

        suite('jobs: completion, deadline, attach and status (#47, #12)', () => {
            const BUILD_TASK: FixtureTask = {
                name: 'cbuild demo.csolution.yml --active HE', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' },
            };
            const shellTask = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });

            /** A handler on a clock `speedup` times real time, with a tracker over fake task events on the same clock. */
            const jobWorld = (speedup = 20, more: Partial<HandlerHost> = {}) => {
                const clock = fastClock(speedup);
                const tasks = new FakeTasks();
                tasks.fetched = workspaceTasks('/w', ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                const tracker = new CmsisJobTracker(tasks, clock);
                const x = new ScriptedExecutor();
                x.session = false;
                return { clock, tasks, tracker, x, handler: handlerFor(x, { ...clock, cmsisJobs: () => tracker, ...more }) };
            };
            /** A stand-in command whose task starts a few ms later and ends with `exitCode` unless that is 'never'. */
            const runs = (tasks: FakeTasks, task: FixtureTask, exitCode: number | undefined | 'never', returned = false) => (): unknown => {
                const execution = tasks.execution(task);
                setTimeout(() => {
                    tasks.start(execution);
                    if (exitCode !== 'never') {
                        setTimeout(() => tasks.finish(execution, exitCode), 5);
                    }
                }, 5);
                return returned ? execution : undefined;
            };
            const again = (): void => {
                registrations?.dispose();
                registrations = undefined;
            };

            test('build ends with the task, its exit code, how long it ran and the job id: 0, 2, none', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 0, true) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'build' })),
                    /^✅ CMSIS 'build' succeeded on HE \(task 'cbuild demo\.csolution\.yml --active HE' exited 0 after [\d.]+ s, job b-1\)\. The firmware is built — use cmsis_action load or load_and_debug to flash it\.$/);
                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 2, true) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task 'cbuild demo\.csolution\.yml --active HE' exited with code 2 after [\d.]+ s \(job b-2\)\.$/);
                assert.strictEqual(failed.hint, 'Open the CMSIS/cbuild terminal or the Problems panel to read the compiler/linker errors, fix them in the source, '
                    + 'then re-run cmsis_action build. This is a terminal result — do not wait for an output file.');
                again();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, undefined, true) });
                const cancelled = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(cancelled.message, /^CMSIS 'build' on HE — task '.*' ended without an exit code after [\d.]+ s \(it may have been cancelled; job b-3\)\.$/);
                assert.strictEqual(cancelled.hint, 'Re-run cmsis_action build to get a definite result.');
            });

            test('the build the command returns is the result, not another build that started first', async () => {
                const w = jobWorld();
                const other: FixtureTask = { ...BUILD_TASK, name: 'cbuild other.csolution.yml' };
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        const theirs = w.tasks.start(w.tasks.execution(other));
                        const ours = w.tasks.execution(BUILD_TASK);
                        setTimeout(() => {
                            w.tasks.start(ours);
                            w.tasks.finish(theirs, 0);
                            setTimeout(() => w.tasks.finish(ours, 2), 5);
                        }, 5);
                        return ours;
                    },
                });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'build' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'build' FAILED on HE — task 'cbuild demo\.csolution\.yml --active HE' exited with code 2 .* Note: also started meanwhile: 'cbuild other\.csolution\.yml' — not this call's result\.$/);
            });

            test('a CMSIS Load is never a build\'s result: nothing started within 10 s', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, shellTask('CMSIS Load'), 0) });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 20_000 }), 'TASK_FAILED');
                assert.strictEqual(errorDetail(refused), 'CMSIS \'build\' on HE: nothing started within 10 s of issuing \'cmsis-csolution.build\' (job b-1). '
                    + 'Note: also started meanwhile: \'CMSIS Load\' — not this call\'s result.\n'
                    + 'The CMSIS panel may be showing a picker or a save prompt: answer it in VS Code, then repeat the call. '
                    + 'This does not mean "already up to date" — cbuild runs even when nothing changed.');
                assert.strictEqual(w.tracker.last('load')?.origin, 'adopted', 'the Load became a job of its own');
            });

            test('still running at the deadline answers running with the job; a repeat attaches; status waits and reports', async () => {
                const w = jobWorld();
                let builds = 0;
                let execution: FakeExecution | undefined;
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        builds++;
                        execution = w.tasks.start(w.tasks.execution(BUILD_TASK));
                        return execution;
                    },
                });
                const first = await w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 8_000 });
                assert.ok(typeof first === 'object' && first.status === 'running', JSON.stringify(first));
                assert.match(first.text, /^CMSIS 'build' on HE is still running after [\d.]+ s \(task 'cbuild demo\.csolution\.yml --active HE', job b-1\)\. This is not a failure\. Call cmsis_action \{action:'status'\} to wait for the result — do not start another build\.$/);
                const job = first.data?.job as Record<string, unknown>;
                assert.deepStrictEqual([job.id, job.action, job.target, job.task, job.state, job.origin],
                    ['b-1', 'build', 'HE', BUILD_TASK.name, 'started', 'call']);
                assert.ok(typeof job.startedAt === 'string' && typeof job.elapsedMs === 'number', JSON.stringify(job));

                const busy = await w.handler.handleCmsisCommand({ action: 'status', timeoutMs: 4_000 });
                assert.ok(typeof busy === 'object' && busy.status === 'running' && busy.text.includes('job b-1'), JSON.stringify(busy));

                setTimeout(() => w.tasks.finish(execution as FakeExecution, 0), 30);
                const attached = await textAnswer(w.handler.handleCmsisCommand({ action: 'build' }));
                assert.match(attached, /^Attached to the build started [\d.]+ s ago \(job b-1, not started again\)\. ✅ CMSIS 'build' succeeded on HE \(task '.*' exited 0 after [\d.]+ s, job b-1\)\./);
                assert.strictEqual(builds, 1, 'the repeat did not issue a second build');

                const idle = await textAnswer(w.handler.handleCmsisCommand({ action: 'status' }));
                assert.match(idle, /^No CMSIS job in flight in this window\. Last results \(10 min\): build on HE ✅ [\d.]+ s ago \(job b-1, '.*'\)\.\nNo CMSIS task is running in this window\.$/);
            });

            test('a build of another target while one runs is refused; one from the panel is attached to', async () => {
                const w = jobWorld();
                solutionOn('HE', { 'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 'never', true) });
                await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 4_000 }), 'running');
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'build', target: 'HP' }), 'TASK_FAILED');
                assert.match(errorDetail(refused), /^CMSIS 'build' not started on 'HP': the build started [\d.]+ s ago on 'HE' is still running \(job b-1\)\.\nWait for it with cmsis_action \{action:'status'\}, then run build on the other target\.$/);

                const panel = jobWorld();
                const fromPanel = panel.tasks.start(panel.tasks.execution(BUILD_TASK));
                let issued = 0;
                again();
                solutionOn('HE', {
                    'cmsis-csolution.build': () => {
                        issued++;
                    },
                });
                setTimeout(() => panel.tasks.finish(fromPanel, 0), 20);
                assert.match(await textAnswer(panel.handler.handleCmsisCommand({ action: 'build' })),
                    /^Attached to the build started from the CMSIS panel [\d.]+ s ago \(job b-1, not started again\)\. ✅ CMSIS 'build' succeeded on HE \(task/);
                assert.strictEqual(issued, 0);
            });

            test('status needs no solution and launches nothing', async () => {
                const w = jobWorld();
                assert.strictEqual(await textAnswer(w.handler.handleCmsisCommand({ action: 'status' })),
                    'No CMSIS job in this window: nothing is in flight and nothing finished in the last 10 min.\n'
                    + 'No CMSIS task is running in this window.');
            });

            test('one deadline per call: a 20 s target switch still ends in the job\'s running reply, not the fence', async () => {
                const solutionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-switch-'));
                try {
                    const solution = path.join(solutionDir, 'demo.csolution.yml');
                    fs.writeFileSync(solution, ['solution:', '  target-types:', '    - type: HE', '    - type: HP', ''].join('\n'));
                    const w = jobWorld(20, { workspaceFolders: () => [{ uri: vscode.Uri.file(solutionDir), name: 'ws', index: 0 }] });
                    let active = 'HE';
                    registrations = standIns({
                        'cmsis-csolution.getSolutionFile': () => solution,
                        'cmsis-csolution.getActiveTargetSet': () => active,
                        'cmsis-csolution.deactivateSolution': () => undefined,
                        // 1 s of real time is 20 s on the handler's clock.
                        'cmsis-csolution.activateSolution': () => new Promise((done) => setTimeout(() => {
                            active = 'HP';
                            done(undefined);
                        }, 1_000)),
                        'cmsis-csolution.build': runs(w.tasks, BUILD_TASK, 'never', true),
                    });
                    const text = await replyAnswer(w.handler.handleCmsisCommand({ action: 'build', target: 'HP', timeoutMs: 30_000 }), 'running');
                    assert.match(text, /^CMSIS 'build' on HP, switched from HE is still running after \d+ s \(task '.*', job b-1\)\./);
                    assert.ok(!text.includes('did not complete within'), text);
                } finally {
                    fs.rmSync(solutionDir, { recursive: true, force: true });
                }
            });

            test('the label pre-check refuses a task the debugger adapter does not offer before anything runs', async () => {
                const w = jobWorld();
                w.tasks.fetched = workspaceTasks('/w', ['CMSIS Load+Run']);
                let loads = 0;
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoad': () => {
                        loads++;
                    },
                });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'INVALID_ARGUMENT');
                assert.strictEqual(errorDetail(refused), 'CMSIS \'load\' on HE not started: this debugger adapter has no \'CMSIS Load\' task; '
                    + 'it offers load_and_run and load_and_debug.\n'
                    + 'Use one of those, or flash. (Arm Debugger adapters offer only load_and_run and load_and_debug.)');
                const cached = await refusalOf(w.handler.handleCmsisCommand({ action: 'erase' }), 'INVALID_ARGUMENT');
                assert.ok(cached.message.includes('no \'CMSIS Erase\' task'), 'the labels are cached until tasks.json changes');
                assert.strictEqual(w.tasks.fetchCount, 1);
                const bare = jobWorld();
                bare.tasks.fetched = [];
                const none = await refusalOf(bare.handler.handleCmsisCommand({ action: 'erase' }), 'INVALID_ARGUMENT');
                assert.ok(none.message.includes('the solution\'s .vscode/tasks.json has no CMSIS tasks'), none.message);
                assert.strictEqual(loads, 0);
            });

            test('load_and_run: flashed and CMSIS Run stays up; a failed Load answers with its code', async () => {
                const w = jobWorld();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndRun': () => {
                        const load = w.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Load+Run')), false);
                            w.tasks.start(load);
                            w.tasks.finish(load, 0);
                            w.tasks.start(w.tasks.execution(shellTask('CMSIS Run')));
                        }, 5);
                    },
                });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load_and_run' })),
                    /^✅ CMSIS 'load_and_run' on HE: flashed \('CMSIS Load' exited 0 after [\d.]+ s\); 'CMSIS Run' started and stays active — it hosts the GDB server \(job r-1\)\. cmsis_action attach to debug; cmsis_action stop_run frees the probe\.$/);

                const failing = jobWorld();
                again();
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndRun': () => {
                        const load = failing.tasks.execution(shellTask('CMSIS Load'));
                        const parent = failing.tasks.execution(shellTask('CMSIS Load+Run'));
                        setTimeout(() => {
                            failing.tasks.start(parent, false);
                            failing.tasks.start(load);
                            failing.tasks.finish(load, 1);
                            failing.tasks.finish(parent, undefined, false);
                        }, 5);
                    },
                });
                const failed = await refusalOf(failing.handler.handleCmsisCommand({ action: 'load_and_run' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'load_and_run' FAILED on HE — 'CMSIS Load' exited with code 1 after [\d.]+ s, so 'CMSIS Run' was not started \(job r-1\)\.$/);
                assert.ok(failed.hint?.includes('call flash, which returns pyOCD\'s own error lines'), failed.hint);
            });

            test('load_and_debug: a failed pre-launch Load is the answer before any session probe; a good one leads the result', async () => {
                const w = jobWorld(50);
                solutionOn('HE', { 'cmsis-csolution.cmsisLoadAndDebug': runs(w.tasks, shellTask('CMSIS Load'), 1) });
                const failed = await refusalOf(w.handler.handleCmsisCommand({ action: 'load_and_debug' }), 'TASK_FAILED');
                assert.match(failed.message, /^❌ CMSIS 'load_and_debug' FAILED on HE — its pre-launch task 'CMSIS Load' exited with code 1 after [\d.]+ s; no debug session was started \(job d-1\)\.$/);
                assert.deepStrictEqual(w.x.argsOf('getThreads'), [], 'no session probe');
                again();

                const good = jobWorld(50);
                good.x.sessionStatus = status('running');
                good.x.getThreads = async () => [{ id: 1, name: 'main' }];
                solutionOn('HE', {
                    'cmsis-csolution.cmsisLoadAndDebug': () => {
                        const load = good.tasks.execution(shellTask('CMSIS Load'));
                        setTimeout(() => {
                            good.tasks.start(load);
                            good.tasks.finish(load, 0);
                            good.x.session = true;
                        }, 5);
                    },
                });
                const text = await textAnswer(good.handler.handleCmsisCommand({ action: 'load_and_debug' }));
                assert.match(text, /^CMSIS 'load_and_debug' completed on HE — 'CMSIS Load' exited 0 after [\d.]+ s \(job d-1\); debug session survived the connect \(t\+3s: 1 thread\(s\), t\+6s: 1 thread\(s\) — target threads present\)\. State: \{/);
            });
        });

        suite('the probe guard (#46)', () => {
            const shellTask = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });
            const again = (): void => {
                registrations?.dispose();
                registrations = undefined;
            };
            const guarded = (setupOwners: (tasks: FakeTasks, tracker: CmsisJobTracker) => void, session = false) => {
                const clock = fastClock(20);
                const tasks = new FakeTasks();
                tasks.fetched = workspaceTasks('/w', ['CMSIS Load', 'CMSIS Run', 'CMSIS Load+Run', 'CMSIS Erase']);
                const tracker = new CmsisJobTracker(tasks, clock);
                setupOwners(tasks, tracker);
                const x = new ScriptedExecutor();
                x.session = session;
                const issued: string[] = [];
                const record = (name: string) => () => {
                    issued.push(name);
                };
                solutionOn('HE', {
                    'cmsis-csolution.build': record('build'),
                    'cmsis-csolution.cmsisLoad': record('load'),
                    'cmsis-csolution.cmsisErase': record('erase'),
                    'cmsis-csolution.cmsisLoadAndRun': record('load_and_run'),
                    'cmsis-csolution.cmsisLoadAndDebug': record('load_and_debug'),
                    'cmsis-csolution.cmsisAttachDebugger': record('attach'),
                });
                return { handler: handlerFor(x, { ...clock, cmsisJobs: () => tracker }), issued, tasks, tracker, x };
            };

            test('a live CMSIS Run refuses load, erase, load_and_run, load_and_debug and flash, names itself, and lets attach and build through', async () => {
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Load+Run')), false);
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                for (const action of ['load', 'erase', 'load_and_run', 'load_and_debug'] as const) {
                    const refused = await refusalOf(w.handler.handleCmsisCommand({ action, timeoutMs: 2_000 }), 'PROBE_BUSY');
                    assert.match(errorDetail(refused), new RegExp(`^CMSIS '${action}' on HE not started: the 'CMSIS Run' task \\(started [\\d.]+ s ago\\) holds the probe\\.\\n`
                        + 'cmsis_action \\{action:\'stop_run\'\\} first — or cmsis_action attach to debug the running firmware\\.$'));
                }
                const flash = await refusalOf(w.handler.handleFlash({}), 'PROBE_BUSY');
                assert.match(errorDetail(flash), /^Refusing to flash: the 'CMSIS Run' task \(started [\d.]+ s ago\) holds the probe\.\ncmsis_action \{action:'stop_run'\} first, then flash\.$/);
                assert.deepStrictEqual(w.issued, []);
                await w.handler.handleCmsisCommand({ action: 'attach', timeoutMs: 2_000 });
                await w.handler.handleCmsisCommand({ action: 'build', timeoutMs: 2_000 });
                assert.deepStrictEqual(w.issued, ['attach', 'build']);
            });

            test('a Load in flight: the same action attaches to it, another one waits', async () => {
                let load: FakeExecution | undefined;
                const w = guarded((tasks) => {
                    load = tasks.start(tasks.execution(shellTask('CMSIS Load')));
                });
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'erase' }), 'PROBE_BUSY');
                assert.match(errorDetail(refused), /^CMSIS 'erase' on HE not started: the 'CMSIS Load' task \(started [\d.]+ s ago\) is using the probe\.\ncmsis_action \{action:'status'\} waits for it\.$/);
                setTimeout(() => w.tasks.finish(load as FakeExecution, 0), 20);
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'load' })),
                    /^Attached to the load started from the CMSIS panel [\d.]+ s ago \(job l-1, not started again\)\. ✅ CMSIS 'load' succeeded on HE \(task 'CMSIS Load' exited 0/);
                assert.deepStrictEqual(w.issued, []);
            });

            test('a debug session now refuses load, erase and load_and_run too', async () => {
                const w = guarded(() => undefined, true);
                const refused = await refusalOf(w.handler.handleCmsisCommand({ action: 'load' }), 'PROBE_BUSY');
                assert.strictEqual(errorDetail(refused),
                    'CMSIS \'load\' on HE not started: a debug session is active (name=\'Fake session\', state=running) and holds the probe.\n'
                    + 'Call stop_debugging first.');
                assert.deepStrictEqual(w.issued, []);
            });

            test('stop_run waits until the CMSIS tasks ended, terminates leftovers itself, and says when one survives', async () => {
                const stopper = (tasks: FakeTasks) => () => {
                    for (const execution of tasks.taskExecutions()) {
                        if (execution.task.name.startsWith('CMSIS')) {
                            execution.terminate();
                        }
                    }
                };
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Load+Run')), false);
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                again();
                solutionOn('HE', { 'cmsis-csolution.cmsisStopRun': stopper(w.tasks) });
                assert.match(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_run' })),
                    /^CMSIS 'stop_run' on HE: stopped 'CMSIS Load\+Run' and 'CMSIS Run' \(ended [\d.]+ s after the stop request\); the probe is free\.$/);
                assert.deepStrictEqual(w.tracker.probeOwners(), []);

                assert.strictEqual(await textAnswer(w.handler.handleCmsisCommand({ action: 'stop_run' })),
                    'CMSIS \'stop_run\' on HE: nothing to stop — no CMSIS task is running in this window. '
                    + '\'cmsis-csolution.cmsisStopRun\' was issued anyway; it also ends a debug session the CMSIS panel started.');

                let stubborn: FakeExecution | undefined;
                again();
                const s = guarded((tasks) => {
                    stubborn = tasks.start(tasks.execution(shellTask('CMSIS Run'), true));
                });
                again();
                solutionOn('HE', { 'cmsis-csolution.cmsisStopRun': stopper(s.tasks) });
                const refused = await refusalOf(s.handler.handleCmsisCommand({ action: 'stop_run' }), 'PROBE_BUSY');
                assert.match(errorDetail(refused), /^CMSIS 'stop_run' on HE: 'CMSIS Run' is still running 1\d s after the stop request, although terminated twice\.\n/);
                assert.ok(refused.hint?.startsWith('Stop it with the trash icon in the Terminal panel'), refused.hint);
                assert.strictEqual(stubborn?.terminateCalls, 2);
            });

            test('get_session_status adds one line on the CMSIS tasks, before the hint', async () => {
                const w = guarded((tasks) => {
                    tasks.start(tasks.execution(shellTask('CMSIS Run')));
                });
                const text = await textAnswer(w.handler.handleGetSessionStatus());
                assert.match(text, /\nCMSIS tasks: 'CMSIS Run' alive [\d.]+ s \(holds the probe\)\nHint: /);
            });
        });

        test('attach waits for the session and probes it twice; no threads yet is not a failure, a vanished session is', async () => {
            const attach = async (threadCounts: Array<number | 'gone'> | undefined): Promise<ToolText> => {
                const x = new ScriptedExecutor();
                x.session = false;
                x.sessionStatus = status(threadCounts ? 'running' : 'initializing');
                x.getThreads = async () => {
                    const next = threadCounts?.shift() ?? 0;
                    if (next === 'gone') {
                        x.session = false;
                        throw new Error('session ended');
                    }
                    return Array.from({ length: next }, (_, i) => ({ id: i + 1, name: 't' }));
                };
                solutionOn('HE', {
                    'cmsis-csolution.cmsisAttachDebugger': () => {
                        x.session = true;
                    },
                });
                try {
                    return await handlerFor(x, fastClock(50)).handleCmsisCommand({ action: 'attach' });
                } finally {
                    registrations?.dispose();
                    registrations = undefined;
                }
            };
            const survived = await textAnswer(attach([1, 1]));
            assert.ok(survived.startsWith('CMSIS \'attach\' completed on HE — debug session survived the connect '
                + '(t+3s: 1 thread(s), t+6s: 1 thread(s) — target threads present). State: {'), survived);
            assert.strictEqual(await replyAnswer(attach([1, 0]), 'running'),
                'CMSIS \'attach\' on HE: the debug session is up but the target is not reporting threads yet — '
                + 't+3s: 1 thread(s), then t+6s: session object present, 0 threads so far. '
                + 'This is not a failure: poll get_session_status until it reports \'running\' or \'stopped\'.');
            const lost = await refusalOf(attach([1, 'gone']), 'TASK_FAILED');
            assert.strictEqual(lost.message, 'CMSIS \'attach\' on HE started a debug session but it did NOT survive the initial connect — '
                + 't+3s: 1 thread(s), then t+6s: thread probe failed — session ended.');
            assert.ok(lost.hint?.startsWith('For \'attach\' this almost always means no GDB server is listening'), lost.hint);
            assert.ok(lost.hint?.includes('No CMSIS Run task is alive in this window — load_and_run first, or load_and_debug.'), lost.hint);
            const never = await replyAnswer(attach(undefined), 'running');
            assert.ok(never.startsWith('CMSIS \'attach\' on HE issued via \'cmsis-csolution.cmsisAttachDebugger\'. '
                + 'The flash/connect pipeline is running in the CMSIS extension'), never);
        });

        test('the fence honours the long cap for cmsis_action and flash only', async () => {
            const timers: number[] = [];
            const x = new ScriptedExecutor();
            const tracker = new CmsisJobTracker(new FakeTasks(), fastClock(1));
            const handler = handlerFor(x, { ...fastClock(1, timers), cmsisJobs: () => tracker });
            await refusalOf(handler.handleFlash({ timeoutMs: 120_000 }), 'PROBE_BUSY');
            assert.strictEqual(timers[0], 120_000, 'flash');
            timers.length = 0;
            await textAnswer(handler.handleCmsisCommand({ action: 'status', timeoutMs: 600_000 }));
            assert.strictEqual(timers[0], 600_000, 'cmsis_action');
            timers.length = 0;
            await textAnswer(handler.handleCmsisCommand({ action: 'status', timeoutMs: 900_000 }));
            assert.strictEqual(timers[0], 600_000, 'cmsis_action beyond the cap');
            timers.length = 0;
            await textAnswer(handler.handleReadMemory({ address: '0x20000000', length: 4, timeoutMs: 120_000 }));
            assert.strictEqual(timers[0], 60_000, 'a read keeps the 60 s cap');
        });
    });

    suite('flash', () => {
        const folder = (fsPath: string): vscode.WorkspaceFolder => ({ uri: vscode.Uri.file(fsPath), name: 'ws', index: 0 });

        test('refused under a live session', async () => {
            const refused = await refusalOf(handlerFor(new ScriptedExecutor()).handleFlash({}), 'PROBE_BUSY');
            assert.strictEqual(refused.message,
                'Refusing to flash while a debug session is active — programming under a live session wedges most probes.');
            assert.strictEqual(refused.hint, 'Call stop_debugging first, then flash, then cmsis_action attach or load_and_debug.');
        });

        test('the cbuild-run file is resolved or its absence explained', async () => {
            const x = new ScriptedExecutor();
            x.session = false;
            const workspace = '/nonexistent-cda-ws';
            const withFolder = handlerFor(x, { workspaceFolders: () => [folder(workspace)] });
            const refused = async (pending: Promise<ToolText>): Promise<string> => errorDetail(await refusalOf(pending, 'INVALID_ARGUMENT'));
            assert.strictEqual(await refused(withFolder.handleFlash({ cbuildRunFile: 'out/x.cbuild-run.yml' })),
                `cbuild-run file not found: ${path.join(workspace, 'out/x.cbuild-run.yml')}.\n`
                + 'Pass an existing path, or omit cbuildRunFile to auto-resolve from launch.json / out/.');
            assert.strictEqual(await refused(handlerFor(x, { workspaceFolders: () => [] }).handleFlash({})),
                'No workspace folder open and no cbuildRunFile argument given — cannot resolve what to flash.');

            const found = [vscode.Uri.file('/ws/out/a.cbuild-run.yml'), vscode.Uri.file('/ws/out/b.cbuild-run.yml')];
            const twoMatches = handlerFor(x, { workspaceFolders: () => [folder(workspace)], findFiles: async () => found });
            assert.strictEqual(await refused(twoMatches.handleFlash({})),
                `Found 2 cbuild-run files under out/ — pass cbuildRunFile explicitly:\n  ${found[0].fsPath}\n  ${found[1].fsPath}`);
            const noMatch = handlerFor(x, { workspaceFolders: () => [folder(workspace)], findFiles: async () => [] });
            assert.strictEqual(await refused(noMatch.handleFlash({})),
                'No cbuild-run file found (launch.json has no resolvable cmsis.cbuildRunFile and out/ has none).\n'
                + 'Build first (cmsis_action build), or pass cbuildRunFile explicitly.');
        });

        suite('pyOCD: the CMSIS Debugger\'s, never "pip install" (#46, #45)', () => {
            /** The fake pyOCD executables below are shell scripts. */
            const shellScriptsRun = process.platform !== 'win32';
            let dir: string;
            let cbuildRun: string;
            setup(() => {
                dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-flash-')));
                fs.mkdirSync(path.join(dir, 'out'));
                cbuildRun = path.join(dir, 'out', 'demo+HE.cbuild-run.yml');
                fs.writeFileSync(cbuildRun, 'cbuild-run:\n  generated-by: csolution\n  solution: ../demo.csolution.yml\n  target-type: HE\n');
            });
            teardown(() => fs.rmSync(dir, { force: true, recursive: true }));

            const flashHost = (extensionPath: string | undefined): Partial<HandlerHost> => ({
                workspaceFolders: () => [folder(dir)],
                toolEnvironment: () => ({
                    extension: (id) => (id === 'Arm.vscode-cmsis-debugger' && extensionPath ? { path: extensionPath, version: '1.8.0' } : undefined),
                    pathEnv: '',
                    platform: process.platform,
                }),
            });

            test('without any pyOCD the answer is TOOL_DISABLED and names the CMSIS Debugger, with no pip', async () => {
                const x = new ScriptedExecutor();
                x.session = false;
                const refused = await refusalOf(handlerFor(x, flashHost(undefined)).handleFlash({ cbuildRunFile: cbuildRun }), 'TOOL_DISABLED');
                assert.strictEqual(errorDetail(refused),
                    'pyOCD not found: it ships with the CMSIS Debugger extension (Arm.vscode-cmsis-debugger), and neither the solution\'s '
                    + '.cmsis/tools-environment.yml nor PATH names another one.\n'
                    + 'Install or enable the CMSIS Debugger extension, or use cmsis_action load, which flashes through the CMSIS Solution '
                    + 'extension. Do not install pyOCD yourself.');
                assert.ok(!/pip/i.test(errorDetail(refused)));
            });

            test('the bundled pyOCD programs the target, and the result says which pyOCD it was', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'arm.vscode-cmsis-debugger-1.8.0-darwin-arm64');
                const bin = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(bin), { recursive: true });
                fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.45.1; exit 0; fi\n'
                    + 'echo "Erased 4096 bytes (1 sector), programmed 4096 bytes (16 pages), identical 0 bytes (0 pages) at 52.00 kB/s"\n');
                fs.chmodSync(bin, 0o755);
                const x = new ScriptedExecutor();
                x.session = false;
                assert.strictEqual(await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun })),
                    `✅ Flash succeeded — programmed 4096 bytes at 52 kB/s (pyOCD 0.45.1 from CMSIS Debugger 1.8.0: \`${bin} load --cbuild-run ${cbuildRun}\`). `
                    + 'Use cmsis_action attach or load_and_debug to start a debug session.');
            });

            test('a bundled pyOCD that does not run is reported, and tools-environment.yml is the next place looked', async function () {
                if (!shellScriptsRun) {
                    this.skip();
                }
                const extensionPath = path.join(dir, 'ext');
                const broken = path.join(extensionPath, 'tools', 'pyocd', 'pyocd');
                fs.mkdirSync(path.dirname(broken), { recursive: true });
                fs.writeFileSync(broken, 'not a program');
                fs.chmodSync(broken, 0o644);
                const x = new ScriptedExecutor();
                x.session = false;
                const refused = await refusalOf(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }), 'TOOL_DISABLED');
                assert.ok(refused.message.endsWith(`(found, but it did not run: ${broken}).`), refused.message);

                const listed = path.join(dir, 'listed');
                fs.mkdirSync(listed);
                fs.writeFileSync(path.join(listed, 'pyocd'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.44.0; exit 0; fi\n'
                    + 'echo "programmed 1024 bytes (4 pages) at 10.00 kB/s"\n');
                fs.chmodSync(path.join(listed, 'pyocd'), 0o755);
                fs.mkdirSync(path.join(dir, '.cmsis'));
                fs.writeFileSync(path.join(dir, '.cmsis', 'tools-environment.yml'),
                    `cmsis-tools-environment:\n  tools:\n    - name: pyOCD\n      version: 0.44.0\n      directory: ${listed}\n`);
                const text = await textAnswer(handlerFor(x, flashHost(extensionPath)).handleFlash({ cbuildRunFile: cbuildRun }));
                assert.ok(text.includes('(pyOCD 0.44.0 from .cmsis/tools-environment.yml: '), text);
            });
        });
    });
});
