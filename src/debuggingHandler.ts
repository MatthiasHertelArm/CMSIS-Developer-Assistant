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
 * The debugging tools behind the MCP server: one `handle*` method per tool.
 * Each checks what state the session is in, asks the executor (and, for
 * `cmsis_action` and `flash`, the CMSIS Solution extension or pyOCD) and
 * answers with one text for the agent.
 *
 * `DebugMCPServer` calls a handler directly in the window that serves MCP;
 * a worker window's `ControlServer` calls it by op name with `args ?? {}`.
 * `src/core/opTable.ts` checks at compile time that the interface's method
 * names are exactly its `DEBUG_OPS`.
 *
 * How a call ends (#11, vocabulary in `src/core/toolResult.ts`):
 *   - with a text, or a `ToolReply` whose status is `timeout` (a wait ran out:
 *     `wait_for_stop`, a step or continue, pause, the fence cap of `reset`,
 *     `cmsis_action` and `flash`) or `running` (a CMSIS action goes on);
 *   - with a rejected `ToolError`: refusals such as "a session is already
 *     active" (`PROBE_BUSY`), the state gate (`NO_SESSION`, `TARGET_RUNNING`,
 *     …), failed tasks (`TASK_FAILED`), and the fence cap of the reads
 *     (`TIMEOUT`);
 *   - session, execution and breakpoint tools wrap a cause with `wrapError`
 *     as `<what failed>: <String(error)>`, keeping its code and hint.
 *
 * Steps, continue and pause wait only for the DAP `stopped` event the
 * executor arms before the request goes out; VS Code's stack-item events,
 * which also fire when the item is cleared on resume, never end a wait.
 * Behaviour that is known to be wrong is kept for now and listed in the
 * specification; each item is fixed in its own change.
 */

import * as vscode from 'vscode';
import { DebugState, formatBreakpointModifiers, StackFrame } from './debugState';
import type { IDebuggingExecutor } from './debuggingExecutor';
import type { IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { logger } from './utils/logger';
import { REDACTION_NOTICE, redactExpressionResult, redactVariableValue } from './utils/secretRedaction';
import { getStoppedReason, resolveActiveSession, StopWaitResult } from './utils/sessionStateTracker';
import { HardwareTimeoutError } from './utils/timeout';
import { decodeFault } from './core/faultDecoder';
import { classifyAddress, parseStackedFrame, renderDiagnosis, selectExceptionFrame, StackedFrame } from './core/faultTriage';
import { renderResetOutcome } from './core/resetAssist';
import { lookupAddress, matchName, parseAddress, renderAddressHit, renderPeripheral, renderPeripheralList, renderRegister } from './core/svdLookup';
import { findPeripheral, findRegister, listPeripheralNames, loadSvdForLookup, SvdDevice } from './core/svdParser';
import { shortenPath } from './core/textBudget';
import { ToolError, ToolText, wrapError } from './core/toolResult';
import {
    DapScope,
    DEFAULT_LISTING_LIMITS,
    DEFAULT_NAME_LISTING_LIMIT,
    formatMissingNames,
    renderScopes,
    renderVariableNames,
    selectVariables,
} from './core/variableView';
import { actionTimeoutMs, activeTargetName, CmsisAction, runCmsisAction } from './handler/cmsisAction';
import { CapOutcome, failureText, fenced } from './handler/fence';
import { flashTimeoutMs, runFlash } from './handler/flashTool';
import { classifyGdbReply, DprintfCall, echoedBreakpointNumber, GdbReplyKind, removalEchoed, translateLogMessage } from './handler/gdbText';
import { HandlerHost, VSCODE_HOST } from './handler/host';
import { recentAdapterTraffic, renderCallStack, renderSessionStatus, renderThreads, stoppedTargetRefusal } from './handler/sessionText';
import { normaliseRegister, registerNumber, renderCoreRegisters, renderCycleCounter, renderMemoryDump } from './handler/targetText';

export type { CmsisAction } from './handler/cmsisAction';
export { probeSchedule } from './handler/cmsisAction';

// ── Contract ───────────────────────────────────────────────────────────────

/** Every tool answers with a text or a reply with a status; a failure rejects with a `ToolError`. */
type Answer = Promise<ToolText>;
type VariableScope = 'local' | 'global' | 'all';

interface TimeoutArg { timeoutMs?: number }
interface StartRequest { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }
interface ResetRequest { method?: 'auto' | 'system' | 'core' | 'hardware'; halt?: boolean; timeoutMs?: number }
interface BreakpointRequest { fileFullPath: string; line?: number; condition?: string; lineContent?: string }
interface LogpointRequest { fileFullPath: string; line: number; logMessage: string; condition?: string }
interface SourceLine { fileFullPath: string; line: number }
interface ScopeRequest { scope?: VariableScope; timeoutMs?: number }
interface ValuesRequest { scope?: VariableScope; variableNames?: string[]; timeoutMs?: number }
interface ExpressionRequest { expression: string; timeoutMs?: number }
interface MemoryRequest { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }
interface PeripheralReadRequest { peripheral: string; register?: string; timeoutMs?: number }
interface DiagnoseRequest { levels?: number; timeoutMs?: number }
interface PeripheralLookup { name?: string; address?: string; filter?: string; svdFile?: string; pname?: string; timeoutMs?: number }
interface RegisterLookup { peripheral: string; register: string; svdFile?: string; pname?: string; timeoutMs?: number }
interface StackRequest { threadId?: number; levels?: number; timeoutMs?: number }
interface FrameValuesRequest { frameId: number; scope?: VariableScope; variableNames?: string[]; timeoutMs?: number }
interface CmsisRequest { action: CmsisAction; target?: string; timeoutMs?: number }
interface FlashRequest { cbuildRunFile?: string; timeoutMs?: number }

/**
 * The debugging tools as the MCP server, the control server and the window
 * router see them. The member names must stay equal to `DEBUG_OPS`.
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: StartRequest): Answer;
    handleStopDebugging(): Answer;
    handleStepOver(args?: TimeoutArg): Answer;
    handleStepInto(args?: TimeoutArg): Answer;
    handleStepOut(args?: TimeoutArg): Answer;
    handleContinue(args?: TimeoutArg): Answer;
    handlePause(args?: TimeoutArg): Answer;
    handleWaitForStop(args?: TimeoutArg): Answer;
    handleRestart(args?: TimeoutArg): Answer;
    handleReset(args: ResetRequest): Answer;
    handleAddBreakpoint(args: BreakpointRequest): Answer;
    handleAddLogpoint(args: LogpointRequest): Answer;
    handleRemoveBreakpoint(args: SourceLine): Answer;
    handleClearAllBreakpoints(): Answer;
    handleListBreakpoints(): Answer;
    handleListVariableNames(args: ScopeRequest): Answer;
    handleGetVariables(args: ValuesRequest): Answer;
    handleEvaluateExpression(args: ExpressionRequest): Answer;
    handleReadMemory(args: MemoryRequest): Answer;
    handleReadCoreRegisters(args?: TimeoutArg): Answer;
    handleReadCycleCounter(args?: TimeoutArg): Answer;
    handleReadPeripheralRegister(args: PeripheralReadRequest): Answer;
    handleGetFaultInfo(args?: TimeoutArg): Answer;
    handleDiagnoseFault(args?: DiagnoseRequest): Answer;
    handleLookupPeripheral(args?: PeripheralLookup): Answer;
    handleLookupRegister(args: RegisterLookup): Answer;
    handleGetDeviceInfo(): Answer;
    handleCheckTargetConnection(): Answer;
    handleGetSessionStatus(): Answer;
    handleGetCallStack(args: StackRequest): Answer;
    handleGetThreads(args?: TimeoutArg): Answer;
    handleGetFrameVariables(args: FrameValuesRequest): Answer;
    handleCmsisCommand(args: CmsisRequest): Answer;
    handleFlash(args: FlashRequest): Answer;
}

// ── Fixed texts ────────────────────────────────────────────────────────────

/** The launch.json entry name that means "synthesise a configuration for the file". */
const SYNTHESISED_CONFIGURATION = 'Default Configuration';

/** Waits for a session or a stop never exceed this, whatever the setting says. */
const WAIT_CAP_MS = 60_000;
/** The recovery pause after a step or continue that did not stop. */
const RECOVERY_PAUSE_MS = 5_000;
/** `wait_for_stop` without `timeoutMs`, and the margin that lets its own text beat the fence. */
const WAIT_FOR_STOP_DEFAULT_MS = 28_500;
const WAIT_FOR_STOP_MARGIN_MS = 1_500;
/** Pause between a stop and reading the state, so VS Code has focused the new frame. */
const STOP_SETTLE_MS = 300;
/** Registers `diagnose_fault` reads (`control` is read but not used). */
const TRIAGE_REGISTERS = ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'control', 'msplim', 'psplim'];

const NO_ACTIVE_SESSION = 'No active debug session.';
const START_FIRST = 'Start debugging first.';
const NOTHING_TO_STOP = 'Nothing to stop — no debug session is active.';
const SESSION_STOPPED = 'The debug session has been stopped.';
const NOTHING_TO_RESTART = 'Nothing to restart — no debug session is active';
const SESSION_RESTARTED = 'The debug session has been restarted.';
const NO_FOCUSED_FRAME = 'There is no active stack frame. Pause execution at a breakpoint first.';
const NO_SCOPES_HERE = 'The debug adapter reports no variable scopes at the current execution point.';
const NO_EVALUATION_RESULT = 'The debug adapter returned no result for this expression.';
const START_REFUSED = 'The debug session did not start. Make sure the debugger extension for this kind of file is installed.';
const NO_BREAKPOINTS = 'The breakpoint list is empty.';
const NOTHING_TO_CLEAR = 'Nothing to clear — no breakpoints are set.';
const UNBOUND_NOTE = '<no echo from adapter — normal>';

/** Appended to a successful stop: make sure the investigation reached a cause. */
const ROOT_CAUSE_CHECK = [
    '⚠️ **Root-cause check before you stop**',
    '',
    'Ask yourself one question before closing the investigation: did you find the cause of the problem, or only a symptom of it?',
    '',
    'Knowing only *where* things go wrong usually points to a symptom, so keep debugging if all you have is something like:',
    '- a variable that turns out null or undefined',
    '- a function that hands back a value nobody expected',
    '- an error raised at one particular line',
    '- a condition that took the wrong branch',
    '',
    'The root cause explains *why* it went wrong, for instance:',
    '- a variable that was initialised with the wrong value',
    '- faulty logic inside a function',
    '- an error path that is not handled',
    '- a condition built on a false assumption',
    '',
    'What to do next (required):',
    '1. Set breakpoints at the places worth investigating with `add_breakpoint`.',
    '2. Trace the run from its beginning with `start_debugging`.',
    '3. Work out why it happened, not only what happened.',
    '4. Repeat until the root cause is identified.',
].join('\n');

/** The execution requests the stop waiter drives, with their gate phrase and failure prefix. */
interface MotionSpec {
    tool: string;
    gate: string;
    failure: string;
    send(executor: IDebuggingExecutor, timeoutMs: number | undefined): Promise<void>;
}

const STEP_OVER: MotionSpec = { tool: 'step_over', gate: 'step over', failure: 'Step over failed', send: (x, ms) => x.stepOver(ms) };
const STEP_INTO: MotionSpec = { tool: 'step_into', gate: 'step into', failure: 'Step into failed', send: (x, ms) => x.stepInto(ms) };
const STEP_OUT: MotionSpec = { tool: 'step_out', gate: 'step out', failure: 'Step out failed', send: (x, ms) => x.stepOut(ms) };
const CONTINUE: MotionSpec = { tool: 'continue_execution', gate: 'continue execution', failure: 'Continue failed', send: (x, ms) => x.continue(ms) };

/** How an execution request ended, with the state read afterwards. */
interface StopOutcome {
    state: DebugState;
    timedOut: boolean;
    ended: boolean;
    /** Only for a real stop; undefined after a timeout or the session's end. */
    reason?: string | null;
}

type VariablesReply = { scopes?: DapScope[] } | undefined | null;
type EvaluateReply = { result?: unknown; type?: string } | undefined | null;
type RedactCallback = (name: string, value: string) => { value: string; redacted: boolean };

/** The `redactSecrets` setting, read on every call. */
function redactionEnabled(): boolean {
    return vscode.workspace.getConfiguration('cmsis-developer-assistant').get<boolean>('redactSecrets', true);
}

/** A positive override clamped to the cap, else the configured timeout under the same cap. */
function waitLimitMs(configuredSeconds: number, overrideMs: number | undefined): number {
    if (typeof overrideMs === 'number' && overrideMs > 0) {
        return Math.min(overrideMs, WAIT_CAP_MS);
    }
    return Math.min(configuredSeconds * 1000, WAIT_CAP_MS);
}

/** The last path segment, separated by `/` or `\`. */
function lastSegment(fsPath: string): string {
    return fsPath.replace(/^.*[\\/]/, '');
}

function sourceLocationOf(bp: vscode.Breakpoint): vscode.Location | undefined {
    return bp instanceof vscode.SourceBreakpoint ? bp.location : undefined;
}

/** All scopes, or only the requested variables plus the names that matched nothing. */
function narrowScopes(scopes: DapScope[], names: string[] | undefined): { scopes: DapScope[]; missing: string[] } {
    return names ? selectVariables(scopes, names) : { scopes, missing: [] };
}

function requestedNames(names: string[] | undefined): string[] | undefined {
    return names && names.length > 0 ? names : undefined;
}

// ── The handler ────────────────────────────────────────────────────────────

export class DebuggingHandler
    implements IDebuggingHandler {

    private readonly dbg: IDebuggingExecutor;
    private readonly launchConfigs: IDebugConfigurationManager;
    private readonly configuredSeconds: number;
    /**
     * The breakpoint list the last state rendering showed, joined by line
     * feeds; undefined until the first one, which is not the same as an
     * empty list having been shown.
     */
    private shownBreakpoints: string | undefined;

    constructor(executor: IDebuggingExecutor, configurations: IDebugConfigurationManager, timeoutSeconds: number) {
        this.dbg = executor;
        this.launchConfigs = configurations;
        this.configuredSeconds = timeoutSeconds;
    }

    /** VS Code logpoint message → GDB `dprintf` format and arguments. */
    static translateLogMessage(logMessage: string): DprintfCall {
        return translateLogMessage(logMessage);
    }

    /** Clock, focused frame, task events and workspace; unit tests override this. */
    protected host(): HandlerHost {
        return VSCODE_HOST;
    }

    // ── shared machinery ──

    /** `onCap` is `reply` for tools that wait for something, `error` for reads (#11, decision 3). */
    private fence(label: string, timeoutMs: number | undefined, onCap: CapOutcome, body: () => Promise<ToolText>): Answer {
        return fenced(label, timeoutMs, this.host(), body, onCap);
    }

    /** Throws the state-specific refusal, a `ToolError` with the state's code and hint, unless the target is stopped. */
    private async requireStoppedTarget(operation: string): Promise<void> {
        if (await this.dbg.hasActiveSession()) {
            return;
        }
        const status = await this.dbg.getSessionStatus();
        throw stoppedTargetRefusal(operation, status.state);
    }

    /** The full state, remembering which breakpoint list it showed. */
    private fullState(state: DebugState): string {
        this.shownBreakpoints = state.breakpoints.join('\n');
        return state.toString();
    }

    /** The compact state; its breakpoint list only when it differs from the one shown last. */
    private compactState(state: DebugState): string {
        const listed = state.breakpoints.join('\n');
        const changed = listed !== this.shownBreakpoints;
        this.shownBreakpoints = listed;
        return state.toCompactString({ includeBreakpoints: changed });
    }

    private workspaceRoots(): string[] {
        return this.host().workspaceFolders().map((folder) => folder.uri.fsPath);
    }

    /** Poll until the session is running or stopped. The last backoff can overshoot the budget (KB10). */
    private async awaitLiveSession(overrideMs?: number): Promise<boolean> {
        const clock = this.host();
        const budgetMs = waitLimitMs(this.configuredSeconds, overrideMs);
        const began = clock.now();
        for (let attempt = 0; clock.now() - began < budgetMs; attempt++) {
            const { state } = await this.dbg.getSessionStatus();
            if (state === 'running' || state === 'stopped') {
                logger.info(`Debug session is live (state: ${state})`);
                return true;
            }
            logger.info(`Waiting for the debug session to come up (attempt ${attempt}, state: ${state})`);
            await clock.sleep(Math.min(1000 * 2 ** attempt, 10_000) + Math.random() * 200);
        }
        return false;
    }

    /**
     * Arm the executor's stop waiter, send the request, then wait for the
     * armed DAP event (or its timeout, or the session's end). A request that
     * throws leaves the armed waiter to run out on its own.
     */
    private async sendAndAwaitStop(send: () => Promise<void>, overrideMs: number | undefined): Promise<StopOutcome> {
        const limitMs = waitLimitMs(this.configuredSeconds, overrideMs);
        const armed: Promise<StopWaitResult> = this.dbg.armStopWaiter(limitMs);
        armed.catch(() => undefined);
        await send();
        const result = await armed;
        if (result.kind === 'timeout') {
            logger.warn(`No DAP stopped event within ${limitMs} ms`);
        }
        let state: DebugState;
        try {
            state = await this.dbg.getCurrentDebugState(3);
        } catch {
            state = new DebugState();
        }
        return {
            state,
            timedOut: result.kind === 'timeout',
            ended: result.kind === 'ended',
            reason: result.kind === 'stopped' ? result.reason : undefined,
        };
    }

    /**
     * A step or continue: gate, request, wait, and the recovery pause when
     * nothing stopped, which answers with status `timeout`.
     */
    private async move(spec: MotionSpec, args: TimeoutArg | undefined): Answer {
        try {
            await this.requireStoppedTarget(spec.gate);
            const outcome = await this.sendAndAwaitStop(() => spec.send(this.dbg, args?.timeoutMs), args?.timeoutMs);
            const body = outcome.reason
                ? `Target stopped (reason: ${outcome.reason}).\n\n${this.compactState(outcome.state)}`
                : this.compactState(outcome.state);
            if (outcome.ended) {
                return `${body}\n\n⚠️ Debug session ended during '${spec.tool}'. `
                    + 'The target may have run to completion, crashed, or lost its connection.';
            }
            if (outcome.timedOut) {
                const overrun = `\n\n⚠️ '${spec.tool}' did not complete within ${this.configuredSeconds}s. `
                    + 'The target is still running or the probe is unresponsive. '
                    + 'Consider adding a breakpoint, checking the hardware connection, or calling check_target_connection.';
                return { text: body + overrun + await this.locateRunawayTarget(spec.tool), status: 'timeout' };
            }
            return body;
        } catch (caught) {
            throw wrapError(spec.failure, caught);
        }
    }

    /**
     * After a step or continue that did not stop: pause the target and say
     * where it is. Reads the recovered state directly, so the breakpoint
     * diff of the compact state is not touched. Never throws.
     */
    private async locateRunawayTarget(tool: string): Promise<string> {
        const report = ['\n🩹 Recovery attempt: target did not stop on its own — issuing DAP pause to find out where it is.'];
        let paused: StopOutcome;
        try {
            paused = await this.sendAndAwaitStop(() => this.dbg.pause(RECOVERY_PAUSE_MS), RECOVERY_PAUSE_MS);
        } catch (caught) {
            report.push(`Pause failed: ${failureText(caught)}. Probe / GDB server may be wedged — call check_target_connection.`);
            return report.join('\n');
        }
        if (paused.ended) {
            report.push(`Pause issued but the debug session ended. The target may have crashed during '${tool}'.`);
        } else if (paused.timedOut) {
            report.push('Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. '
                + 'Call check_target_connection, then restart_debugging if needed.');
        } else {
            let pc: string;
            let lr: string | undefined;
            try {
                const registers = await this.dbg.readCoreRegisters(RECOVERY_PAUSE_MS, ['pc', 'lr']);
                pc = registers.pc ? normaliseRegister(registers.pc) : '<unavailable>';
                lr = registers.lr ? normaliseRegister(registers.lr) : undefined;
            } catch (caught) {
                pc = `<read failed: ${failureText(caught)}>`;
            }
            const where = paused.state;
            const lrPart = lr !== undefined ? `, LR = ${lr}` : '';
            const framePart = where.frameName ? ` in ${where.frameName}` : '';
            const filePart = where.fileName ? ` at ${where.fileName}:${where.currentLine}` : '';
            report.push(`Paused successfully. PC = ${pc}${lrPart}${framePart}${filePart}.`);
            if (where.currentLineContent) {
                report.push(`  Current line: ${where.currentLineContent}`);
            }
            report.push('The breakpoint you expected was not hit — the firmware did not reach it. '
                + 'Verify the breakpoint location, check the call stack with get_call_stack, '
                + 'or step from here with step_over / continue_execution.');
        }
        return report.join('\n');
    }

    /** The frame id of the focused stack frame, or the "pause first" error. */
    private focusedFrame(): number {
        const frameId = this.host().focusedFrameId();
        if (frameId === undefined) {
            throw new Error(NO_FOCUSED_FRAME);
        }
        return frameId;
    }

    /** Scopes of the focused frame; a missing `global` scope widens to `all`. */
    private async focusedScopes(scope: VariableScope, timeoutMs: number | undefined): Promise<{ scopes: DapScope[]; widened: boolean }> {
        const frameId = this.focusedFrame();
        const hasScopes = (reply: VariablesReply): reply is { scopes: DapScope[] } =>
            Array.isArray(reply?.scopes) && reply.scopes.length > 0;
        let reply: VariablesReply = await this.dbg.getVariables(frameId, scope, timeoutMs);
        let widened = false;
        if (scope === 'global' && !hasScopes(reply)) {
            reply = await this.dbg.getVariables(frameId, 'all', timeoutMs);
            widened = true;
        }
        return { scopes: hasScopes(reply) ? reply.scopes : [], widened };
    }

    private variableRedactor(): RedactCallback | undefined {
        return redactionEnabled() ? (name, value) => redactVariableValue(name, value) : undefined;
    }

    // ── session ──

    async handleStartDebugging(args: StartRequest): Answer {
        if (this.dbg.hasDebugSession()) {
            const status = await this.dbg.getSessionStatus();
            throw new ToolError('PROBE_BUSY',
                `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). `
                    + 'Refusing to start a second session.',
                'Use stop_debugging first, or call restart_debugging to reuse the current session, '
                    + 'or proceed directly with inspection tools (get_variables_values, read_memory, …).');
        }
        try {
            const chosen = args.configurationName ?? await this.launchConfigs.promptForConfiguration(args.workingDirectory);
            if (chosen && chosen !== SYNTHESISED_CONFIGURATION) {
                if (!(await this.dbg.startDebuggingByName(args.workingDirectory, chosen))) {
                    throw new Error(`Failed to start debug session with configuration '${chosen}'.`);
                }
                await this.requireLiveStart();
                const started = await this.dbg.getCurrentDebugState(3);
                const subject = args.fileFullPath ? args.fileFullPath : chosen;
                return `Debug session started successfully for: ${subject} using configuration '${chosen}'. `
                    + `Current state: ${this.fullState(started)}`;
            }
            if (!args.fileFullPath) {
                throw new ToolError('INVALID_ARGUMENT', 'fileFullPath is required when no named configuration is provided.');
            }
            const launch = await this.launchConfigs.getDebugConfig(args.workingDirectory, args.fileFullPath, chosen, args.testName);
            if (!(await this.dbg.startDebugging(args.workingDirectory, launch))) {
                throw new Error(START_REFUSED);
            }
            await this.requireLiveStart();
            const started = await this.dbg.getCurrentDebugState(3);
            const using = chosen ? ` using configuration '${chosen}'` : ' with default configuration';
            const forTest = args.testName ? ` for test '${args.testName}'` : '';
            return `Debug session started successfully for: ${args.fileFullPath}${using}${forTest}. `
                + `Current state: ${this.fullState(started)}`;
        } catch (caught) {
            const failed = wrapError('Error starting debug session', caught);
            throw new ToolError(failed.code, `${failed.message}${recentAdapterTraffic()}`, failed.hint, failed.data);
        }
    }

    private async requireLiveStart(): Promise<void> {
        if (!(await this.awaitLiveSession())) {
            throw new Error('Debug session started but failed to become active within timeout period');
        }
    }

    async handleStopDebugging(): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                return NOTHING_TO_STOP;
            }
            await this.dbg.stopDebugging();
            return `${SESSION_STOPPED}\n\n${ROOT_CAUSE_CHECK}`;
        } catch (caught) {
            throw wrapError('Could not stop the debug session', caught);
        }
    }

    /** `timeoutMs` is accepted and ignored: the wait uses the configured timeout (KB9). */
    async handleRestart(_args?: TimeoutArg): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NOTHING_TO_RESTART);
            }
            await this.dbg.restart();
            if (!(await this.awaitLiveSession())) {
                throw new Error(`Debug session restart issued but target did not become ready within the ${this.configuredSeconds}s timeout. `
                    + 'The probe or target may be unresponsive.');
            }
            return SESSION_RESTARTED;
        } catch (caught) {
            throw wrapError('Could not restart the debug session', caught);
        }
    }

    handleReset(args: ResetRequest): Answer {
        return this.fence('reset', args.timeoutMs, 'reply', async () => {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, 'Start debugging first — reset drives the target through the live probe.');
            }
            const outcome = await this.dbg.resetTarget({ method: args.method ?? 'auto', halt: args.halt, timeoutMs: args.timeoutMs });
            return renderResetOutcome(outcome, args.halt);
        });
    }

    async handleGetSessionStatus(): Answer {
        const status = await this.dbg.getSessionStatus();
        return renderSessionStatus(status, this.dbg.getDiagnostics());
    }

    async handleCheckTargetConnection(): Answer {
        try {
            return await this.dbg.checkTargetConnection();
        } catch (caught) {
            if (caught instanceof HardwareTimeoutError) {
                return `check_target_connection: ${caught.message}`;
            }
            throw wrapError('Error checking target connection', caught);
        }
    }

    async handleGetDeviceInfo(): Answer {
        try {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, START_FIRST);
            }
            const info = await this.dbg.getDeviceInfo();
            const cmsisTarget = await activeTargetName();
            return cmsisTarget ? `${info.trimEnd()}\n  CMSIS target: ${cmsisTarget}` : info;
        } catch (caught) {
            throw wrapError('Error getting device info', caught);
        }
    }

    // ── execution ──

    handleStepOver(args?: TimeoutArg): Answer {
        return this.move(STEP_OVER, args);
    }

    handleStepInto(args?: TimeoutArg): Answer {
        return this.move(STEP_INTO, args);
    }

    handleStepOut(args?: TimeoutArg): Answer {
        return this.move(STEP_OUT, args);
    }

    handleContinue(args?: TimeoutArg): Answer {
        return this.move(CONTINUE, args);
    }

    /** Not fenced and not wrapped: refusals and errors keep their own text and code. */
    async handlePause(args?: TimeoutArg): Answer {
        if (!this.dbg.hasDebugSession()) {
            throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, START_FIRST);
        }
        const status = await this.dbg.getSessionStatus();
        switch (status.state) {
            case 'stopped':
                return `Target is already stopped (reason: ${status.detail ?? 'n/a'}). No pause needed — proceed with inspection tools.`;
            case 'unresponsive':
                throw new ToolError('TIMEOUT', 'Cannot pause: probe/GDB server is unresponsive.', 'Call check_target_connection or restart_debugging.');
            case 'no-session':
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION);
            case 'initializing':
                throw new ToolError('NO_SESSION', 'Cannot pause yet: session is still initializing.', 'Wait briefly and retry.');
            case 'running':
                break;
        }
        const outcome = await this.sendAndAwaitStop(() => this.dbg.pause(args?.timeoutMs), args?.timeoutMs);
        if (outcome.timedOut) {
            return {
                text: 'Pause requested but target did not stop within the timeout. '
                    + 'Probe may be unresponsive — call get_session_status / check_target_connection.',
                status: 'timeout',
            };
        }
        if (outcome.ended) {
            throw new ToolError('NO_SESSION', 'Pause requested but the debug session ended. The target may have crashed.');
        }
        return `Target paused. ${this.compactState(outcome.state)}`;
    }

    handleWaitForStop(args?: TimeoutArg): Answer {
        return this.fence('wait_for_stop', args?.timeoutMs, 'reply', async () => {
            if (!this.dbg.hasDebugSession()) {
                throw new ToolError('NO_SESSION', NO_ACTIVE_SESSION, 'Start debugging first — wait_for_stop waits on a live session.');
            }
            const budgetMs = args?.timeoutMs
                ? Math.max(args.timeoutMs - WAIT_FOR_STOP_MARGIN_MS, 100)
                : WAIT_FOR_STOP_DEFAULT_MS;
            const outcome = await this.dbg.waitForStop(budgetMs);
            if (outcome.kind === 'timeout') {
                return {
                    text: 'Target did not stop within the timeout — it is still running (or the probe is unresponsive). '
                        + 'Options: call wait_for_stop again with a larger timeoutMs, pause_execution to see where it is, '
                        + 'or check_target_connection if other calls are also stalling.',
                    status: 'timeout',
                };
            }
            if (outcome.kind === 'ended') {
                throw new ToolError('NO_SESSION',
                    'The debug session ended while waiting for a stop — the target may have crashed, the probe disconnected, '
                        + 'or the session was stopped in the UI.',
                    'Call get_session_status to confirm.');
            }
            await this.host().sleep(STOP_SETTLE_MS);
            const state = await this.dbg.getCurrentDebugState(3);
            const reason = outcome.reason ?? 'unknown';
            if (outcome.kind === 'already-stopped') {
                return `Target was already stopped (reason: ${reason}).\n\n${this.compactState(state)}`;
            }
            const thread = outcome.threadId !== null && outcome.threadId !== undefined ? `, threadId=${outcome.threadId}` : '';
            return `Target stopped (reason: ${reason}${thread}).\n\n${this.compactState(state)}`;
        });
    }

    // ── breakpoints ──

    /** Not gated on the run state (KB3). */
    async handleAddBreakpoint(args: BreakpointRequest): Answer {
        try {
            let lines: number[];
            let matchedByContent = false;
            if (typeof args.line === 'number') {
                if (!Number.isInteger(args.line) || args.line < 1) {
                    throw new ToolError('INVALID_ARGUMENT', `Invalid line number ${args.line}: must be a 1-based integer.`);
                }
                lines = [args.line];
            } else if (!args.lineContent) {
                throw new ToolError('INVALID_ARGUMENT',
                    'No location given: pass `line` (1-based line number). The legacy `lineContent` form is still accepted but deprecated.');
            } else {
                const needle = args.lineContent;
                const source = (await vscode.workspace.openTextDocument(vscode.Uri.file(args.fileFullPath))).getText();
                lines = source.split(/\r?\n/).flatMap((text, index) => text.includes(needle) ? [index + 1] : []);
                if (lines.length === 0) {
                    throw new ToolError('INVALID_ARGUMENT', `Could not find any lines containing: ${needle}`);
                }
                matchedByContent = true;
            }

            const place = vscode.Uri.file(args.fileFullPath);
            for (const line of lines) {
                await this.dbg.addBreakpoint(place, line, { condition: args.condition });
            }

            const echoes: string[] = [];
            const kinds: GdbReplyKind[] = [];
            if (this.dbg.hasDebugSession()) {
                for (const line of lines) {
                    const reply = await this.dbg.setBreakpointViaGdb(args.fileFullPath, line, undefined, args.condition);
                    const kind = classifyGdbReply(reply);
                    kinds.push(kind);
                    echoes.push(`line ${line}: ${kind === 'unconfirmed' ? UNBOUND_NOTE : reply} [${kind}]`);
                }
            }

            let head = lines.length === 1
                ? `Breakpoint added at ${args.fileFullPath}:${lines[0]}`
                : `Breakpoints added at ${lines.length} locations in ${args.fileFullPath}: lines ${lines.join(', ')}`;
            if (args.condition) {
                head += ` [when: ${args.condition}]`;
            }
            if (matchedByContent) {
                head += `\n⚠️ Located via the deprecated \`lineContent\` match (${lines.length} line(s) matched). `
                    + 'Pass `line` instead — content matching hits every line containing the text.';
            }
            const listed = echoes.join('\n  ');
            if (!this.dbg.hasDebugSession()) {
                return `${head}\n(No debug session yet — added to the breakpoint list. `
                    + 'It will be GDB-bound when you add it again after the session is up, or re-add after attach.)';
            }
            if (kinds.includes('rejected')) {
                return `${head}\n⚠️ GDB rejected one or more breakpoints:\n  ${listed}\n`
                    + '"No source file" / "No line" means the path does not match the ELF\'s compiled paths — '
                    + 'try the path as the compiler saw it, or set by function name via evaluate_expression ("-exec break <function>").';
            }
            if (kinds.includes('bound')) {
                return `${head}\nGDB confirmed binding:\n  ${listed}`;
            }
            return `${head}\nSent to GDB (\`break\`). The adapter did not echo a confirmation — this is normal for gdbtarget `
                + 'and does NOT mean it failed. The breakpoint is set; verify by running continue_execution '
                + `(the target should stop) or list_breakpoints.\n  ${listed}`;
        } catch (caught) {
            throw wrapError('Error adding breakpoint', caught);
        }
    }

    /** Creates both a VS Code logpoint and a GDB `dprintf` (KB6); not gated (KB3). */
    async handleAddLogpoint(args: LogpointRequest): Answer {
        try {
            if (!Number.isInteger(args.line) || args.line < 1) {
                throw new ToolError('INVALID_ARGUMENT', `Invalid line number ${args.line}: must be a 1-based integer.`);
            }
            const call = translateLogMessage(args.logMessage);
            await this.dbg.addBreakpoint(vscode.Uri.file(args.fileFullPath), args.line,
                { condition: args.condition, logMessage: args.logMessage });
            const added = `Logpoint added at ${args.fileFullPath}:${args.line}`;
            if (!this.dbg.hasDebugSession()) {
                return `${added}\n(No debug session yet — added to the breakpoint list. `
                    + 'Re-add after the session is up so it is bound GDB-native via `dprintf`.)';
            }
            const reply = await this.dbg.setLogpointViaGdb(args.fileFullPath, args.line, call.format, call.args);
            const argumentList = call.args.length > 0 ? `,${call.args.join(',')}` : '';
            const report = [added, `  GDB: dprintf ${args.fileFullPath}:${args.line},"${call.format}"${argumentList}`];
            if (classifyGdbReply(reply) === 'rejected') {
                report.push(`⚠️ GDB rejected the logpoint: ${reply}`,
                    'Check that the path matches the ELF\'s compiled paths, and that every interpolated expression is in scope at that line.');
                return report.join('\n');
            }
            if (args.condition) {
                const number = echoedBreakpointNumber(reply);
                if (number !== undefined) {
                    const conditionReply = await this.dbg.setBreakpointConditionViaGdb(number, args.condition);
                    report.push(`  Condition applied to GDB breakpoint ${number}: ${args.condition}${conditionReply ? ` — ${conditionReply}` : ''}`);
                } else {
                    report.push(`⚠️ Condition "${args.condition}" was set on the VS Code breakpoint but NOT on the GDB dprintf: `
                        + 'the adapter did not echo a breakpoint number to attach it to. The logpoint will fire unconditionally. '
                        + `Apply it manually with evaluate_expression("-exec condition <n> ${args.condition}") `
                        + 'after finding <n> via evaluate_expression("-exec info breakpoints").');
                }
            }
            report.push('\nℹ️ On Cortex-M a logpoint is not free: the core halts on every hit while GDB formats and prints, then resumes. '
                + 'In a hot loop or an ISR this distorts timing far more than it would in a host process. '
                + 'For high-rate tracing prefer read_cycle_counter around the region, or have the firmware fill a RAM buffer you read with read_memory.');
            return report.join('\n');
        } catch (caught) {
            throw wrapError('Could not add the logpoint', caught);
        }
    }

    /** Without a model entry nothing is sent to GDB (KB12). */
    async handleRemoveBreakpoint(args: SourceLine): Answer {
        try {
            const place = vscode.Uri.file(args.fileFullPath);
            const wanted = place.toString();
            const known = this.dbg.getBreakpoints().some((bp) => {
                const location = sourceLocationOf(bp);
                return location !== undefined && location.uri.toString() === wanted && location.range.start.line === args.line - 1;
            });
            if (!known) {
                return `Nothing to remove — no breakpoint is set at ${args.fileFullPath}:${args.line}.`;
            }
            await this.dbg.removeBreakpoint(place, args.line);
            let note = '';
            if (this.dbg.hasDebugSession()) {
                const reply = await this.dbg.clearBreakpointViaGdb(args.fileFullPath, args.line);
                note = `\nGDB \`clear ${args.fileFullPath}:${args.line}\` issued${removalEchoed(reply) ? ` — ${reply}` : '.'}`;
            }
            return `Breakpoint removed from ${args.fileFullPath}:${args.line}${note}`;
        } catch (caught) {
            throw wrapError('Could not remove the breakpoint', caught);
        }
    }

    async handleClearAllBreakpoints(): Answer {
        try {
            const count = this.dbg.getBreakpoints().length;
            this.dbg.clearAllBreakpoints();
            let note = '';
            if (this.dbg.hasDebugSession()) {
                const reply = await this.dbg.clearAllBreakpointsViaGdb();
                note = removalEchoed(reply)
                    ? `\nGDB \`delete\` issued — ${reply}`
                    : '\nGDB `delete` issued — all GDB-native breakpoints removed.';
            }
            if (count === 0 && note === '') {
                return NOTHING_TO_CLEAR;
            }
            return `Cleared ${count} breakpoint(s) from the model.${note}`;
        } catch (caught) {
            throw wrapError('Could not clear the breakpoints', caught);
        }
    }

    /** Kinds other than source and function breakpoints print nothing but keep their number (KB15). */
    async handleListBreakpoints(): Answer {
        try {
            const all = this.dbg.getBreakpoints();
            if (all.length === 0) {
                return NO_BREAKPOINTS;
            }
            let listing = 'Breakpoints that are set:\n';
            all.forEach((bp, index) => {
                const location = sourceLocationOf(bp);
                if (location) {
                    listing += `${index + 1}. ${lastSegment(location.uri.fsPath)}:${location.range.start.line + 1}${formatBreakpointModifiers(bp)}\n`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    listing += `${index + 1}. Function: ${bp.functionName}${formatBreakpointModifiers(bp)}\n`;
                }
            });
            return listing;
        } catch (caught) {
            throw wrapError('Could not list the breakpoints', caught);
        }
    }

    // ── variables and expressions ──

    handleListVariableNames(args: ScopeRequest): Answer {
        return this.fence('list_variable_names', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('list variable names');
            const { scopes } = await this.focusedScopes(args.scope ?? 'all', args.timeoutMs);
            if (scopes.length === 0) {
                return NO_SCOPES_HERE;
            }
            return renderVariableNames(scopes, { maxVariables: DEFAULT_NAME_LISTING_LIMIT });
        });
    }

    handleGetVariables(args: ValuesRequest): Answer {
        return this.fence('get_variables_values', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read variables');
            const { scopes, widened } = await this.focusedScopes(args.scope ?? 'all', args.timeoutMs);
            if (scopes.length === 0) {
                return NO_SCOPES_HERE;
            }
            const names = requestedNames(args.variableNames);
            const picked = narrowScopes(scopes, names);
            const note = widened
                ? 'Note: No dedicated "Global" scope is available from this debug adapter. Showing all available scopes instead. '
                    + 'Use evaluate_expression to inspect specific global variables by name.\n\n'
                : '';
            if (names && picked.scopes.length === 0) {
                return `${note}None of the requested variables are in scope: ${names.join(', ')}.\n`
                    + 'Call list_variable_names to see what is available here.';
            }
            const listing = renderScopes(picked.scopes, {
                header: 'Variables',
                redact: this.variableRedactor(),
                limits: names ? undefined : DEFAULT_LISTING_LIMITS,
            });
            return note + listing + formatMissingNames(picked.missing);
        });
    }

    /** Any frame by id: no focused-frame check and no widening of `global`. */
    handleGetFrameVariables(args: FrameValuesRequest): Answer {
        return this.fence('get_frame_variables', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get frame variables');
            const reply: VariablesReply = await this.dbg.getVariablesForFrame(args.frameId, args.scope ?? 'all', args.timeoutMs);
            const scopes = reply?.scopes;
            if (!Array.isArray(scopes) || scopes.length === 0) {
                return `No variable scopes available for frameId=${args.frameId}.`;
            }
            const names = requestedNames(args.variableNames);
            const picked = narrowScopes(scopes, names);
            if (names && picked.scopes.length === 0) {
                return `None of the requested variables are in scope at frameId=${args.frameId}: ${names.join(', ')}.`;
            }
            const listing = renderScopes(picked.scopes, {
                header: `Variables for frameId=${args.frameId}`,
                redact: this.variableRedactor(),
                limits: names ? undefined : DEFAULT_LISTING_LIMITS,
            });
            return listing + formatMissingNames(picked.missing);
        });
    }

    /** GDB passthrough (`-exec …`) is never redacted (KB6). */
    handleEvaluateExpression(args: ExpressionRequest): Answer {
        return this.fence('evaluate_expression', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('evaluate expression');
            const frameId = this.focusedFrame();
            const reply: EvaluateReply = await this.dbg.evaluateExpression(args.expression, frameId, args.timeoutMs);
            if (reply === undefined || reply === null || reply.result === undefined) {
                throw new Error(NO_EVALUATION_RESULT);
            }
            const passthrough = args.expression.trimStart().startsWith('-exec');
            const shown = redactionEnabled() && !passthrough
                ? redactExpressionResult(args.expression, reply.result)
                : { value: String(reply.result), redacted: false };
            let text = `Evaluated: ${args.expression}\nResult: ${shown.value}`;
            if (reply.type) {
                text += `\nType: ${reply.type}`;
            }
            if (shown.redacted) {
                text += `\n\n${REDACTION_NOTICE}`;
            }
            return text;
        });
    }

    // ── raw target reads (never redacted) ──

    handleReadMemory(args: MemoryRequest): Answer {
        return this.fence('read_memory', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read memory');
            const format = args.format ?? 'hex';
            const bytes = await this.dbg.readMemory(args.address, args.length, args.timeoutMs);
            return renderMemoryDump(args.address, args.length, bytes, format);
        });
    }

    handleReadCoreRegisters(args?: TimeoutArg): Answer {
        return this.fence('read_core_registers', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read core registers');
            return renderCoreRegisters(await this.dbg.readCoreRegisters(args?.timeoutMs));
        });
    }

    handleReadCycleCounter(args?: TimeoutArg): Answer {
        return this.fence('read_cycle_counter', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read cycle counter');
            return renderCycleCounter(await this.dbg.readCycleCounter(args?.timeoutMs));
        });
    }

    handleReadPeripheralRegister(args: PeripheralReadRequest): Answer {
        return this.fence('read_peripheral_register', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read peripheral register');
            return this.dbg.readPeripheralRegister(args.peripheral, args.register, args.timeoutMs);
        });
    }

    handleGetFaultInfo(args?: TimeoutArg): Answer {
        return this.fence('get_fault_info', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('read fault info');
            return this.dbg.getFaultInfo(args?.timeoutMs);
        });
    }

    /** One-call fault triage. Every read after the fault registers degrades to a note instead of failing. */
    handleDiagnoseFault(args?: DiagnoseRequest): Answer {
        return this.fence('diagnose_fault', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('diagnose the fault');
            const timeoutMs = args?.timeoutMs;
            const depth = args?.levels ?? 3;
            const decoded = decodeFault(await this.dbg.readFaultRegisters(timeoutMs));
            const skipped: string[] = [];

            let raw: Record<string, string> = {};
            try {
                raw = await this.dbg.readCoreRegisters(timeoutMs, TRIAGE_REGISTERS);
            } catch {
                skipped.push('core registers');
            }
            const regs = {
                sp: registerNumber(raw.sp),
                lr: registerNumber(raw.lr),
                pc: registerNumber(raw.pc),
                xpsr: registerNumber(raw.xpsr),
                msp: registerNumber(raw.msp),
                psp: registerNumber(raw.psp),
                msplim: registerNumber(raw.msplim),
                psplim: registerNumber(raw.psplim),
            };

            const selection = selectExceptionFrame(regs.lr, regs.msp, regs.psp);
            let frame: StackedFrame | null = null;
            let frameNote: string | undefined;
            if (!selection.isExcReturn) {
                frameNote = regs.lr === undefined
                    ? 'LR unavailable — read_core_registers, then read_memory at PSP/MSP'
                    : 'LR is not an EXC_RETURN value — halted deeper inside the handler; get_call_stack has the frames';
            } else if (selection.sp === null) {
                frameNote = `${selection.source} unavailable — read_core_registers`;
            } else {
                try {
                    frame = parseStackedFrame(await this.dbg.readExceptionFrame(selection.sp, timeoutMs));
                    if (!frame) {
                        frameNote = `short read at ${selection.source}`;
                    }
                } catch {
                    skipped.push('exception frame');
                }
            }

            let frames: StackFrame[] = [];
            try {
                frames = await this.dbg.getCallStack(undefined, depth, timeoutMs);
            } catch {
                skipped.push('call stack');
            }

            let device: SvdDevice | null = null;
            let svdNote: string | undefined;
            try {
                device = (await loadSvdForLookup({})).device;
                if (!device) {
                    svdNote = 'no SVD found — addresses are classified by the Cortex-M system map only; '
                        + 'pass svdFile to lookup_peripheral to resolve them';
                }
            } catch {
                svdNote = 'SVD could not be loaded';
            }

            const faultAddress = decoded.faultAddress ? classifyAddress(decoded.faultAddress.value, device) : undefined;
            const faultingPc = frame?.pc ?? regs.pc;
            const pcInfo = faultingPc !== undefined ? classifyAddress(faultingPc, device) : undefined;
            const session = resolveActiveSession();
            const stopReason = session ? getStoppedReason(session) : null;
            const roots = this.workspaceRoots();
            const shortened = frames.map((f) => (f.source ? { ...f, source: shortenPath(f.source, roots) } : f));
            return renderDiagnosis({
                decoded, frame, selection, regs, faultAddress, pcInfo, stopReason,
                frames: shortened, frameNote, skipped, svdNote, maxFrames: depth,
            });
        });
    }

    // ── SVD lookups (no session needed) ──

    handleLookupPeripheral(args?: PeripheralLookup): Answer {
        return this.fence('lookup_peripheral', args?.timeoutMs, 'error', async () => {
            const loaded = await loadSvdForLookup({ svdFile: args?.svdFile, pname: args?.pname });
            if (!loaded.device) {
                return missingSvdText(loaded.tried);
            }
            const device = loaded.device;
            if (args?.address) {
                const address = parseAddress(args.address);
                if (address === null) {
                    return `'${args.address}' is not an address — pass hex like 0x40005400 or a decimal number.`;
                }
                return renderAddressHit(address, lookupAddress(device, address), device.name);
            }
            if (args?.name) {
                const match = matchName(listPeripheralNames(device), args.name);
                const peripheral = match.exact ? findPeripheral(device, match.exact) : undefined;
                if (!peripheral) {
                    return `Peripheral '${args.name}' is not in the SVD of ${device.name}.${suggestionText(match.suggestions)}\n`
                        + 'Call lookup_peripheral without name for the full list.';
                }
                return renderPeripheral(peripheral, { filter: args.filter });
            }
            return renderPeripheralList(device, { filter: args?.filter });
        });
    }

    handleLookupRegister(args: RegisterLookup): Answer {
        return this.fence('lookup_register', args.timeoutMs, 'error', async () => {
            const loaded = await loadSvdForLookup({ svdFile: args.svdFile, pname: args.pname });
            if (!loaded.device) {
                return missingSvdText(loaded.tried);
            }
            const device = loaded.device;
            const peripheralMatch = matchName(listPeripheralNames(device), args.peripheral ?? '');
            const peripheral = peripheralMatch.exact ? findPeripheral(device, peripheralMatch.exact) : undefined;
            if (!peripheral) {
                return `Peripheral '${args.peripheral}' is not in the SVD of ${device.name}.${suggestionText(peripheralMatch.suggestions)}\n`
                    + 'Call lookup_peripheral without name for the full list.';
            }
            const registerMatch = matchName(peripheral.registers.map((r) => r.name), args.register ?? '');
            const register = registerMatch.exact ? findRegister(peripheral, registerMatch.exact) : undefined;
            if (!register) {
                return `Register '${args.register}' is not in ${peripheral.name}.${suggestionText(registerMatch.suggestions)}\n`
                    + `Call lookup_peripheral { name: '${peripheral.name}' } for its register map.`;
            }
            return renderRegister(peripheral, register);
        });
    }

    // ── stack and threads ──

    handleGetCallStack(args: StackRequest): Answer {
        return this.fence('get_call_stack', args.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get call stack');
            const frames = await this.dbg.getCallStack(args.threadId, args.levels ?? 50, args.timeoutMs);
            return renderCallStack(frames, args.levels !== undefined, this.workspaceRoots());
        });
    }

    handleGetThreads(args?: TimeoutArg): Answer {
        return this.fence('get_threads', args?.timeoutMs, 'error', async () => {
            await this.requireStoppedTarget('get threads');
            return renderThreads(await this.dbg.getThreads(args?.timeoutMs), this.workspaceRoots());
        });
    }

    // ── CMSIS Solution and pyOCD ──

    handleCmsisCommand(args: CmsisRequest): Answer {
        const effectiveMs = actionTimeoutMs(args.action, args.timeoutMs);
        return this.fence('cmsis_action', effectiveMs, 'reply', () => runCmsisAction({
            executor: this.dbg,
            host: this.host(),
            awaitLiveSession: (overrideMs) => this.awaitLiveSession(overrideMs),
            renderFullState: (state) => this.fullState(state),
        }, args.action, args.target, effectiveMs));
    }

    handleFlash(args: FlashRequest): Answer {
        return this.fence('flash', flashTimeoutMs(args.timeoutMs), 'reply', () => runFlash(this.dbg, this.host(), args));
    }
}

/** `Did you mean: A, B?` after a failed name lookup, or nothing. */
function suggestionText(suggestions: string[]): string {
    return suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
}

/** The lookup tools' answer when no device description could be found. */
function missingSvdText(tried: string[]): string {
    const where = tried.length > 0 ? `\nTried:\n  - ${tried.join('\n  - ')}` : '';
    return `No SVD file found for a lookup.${where}\n`
        + 'Pass svdFile (the device .svd from the DFP; ${CMSIS_PACK_ROOT} is expanded), '
        + 'or build the solution so out/<context>.cbuild-run.yml names it, or add "svdFile" to the launch configuration. '
        + 'For a multi-core device pass pname to pick the core.';
}
