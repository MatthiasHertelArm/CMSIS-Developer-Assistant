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
 * The executor: the one layer of the extension that calls VS Code's debug API
 * and, through `customRequest`, the debug adapter of the session this window
 * acts on (`resolveActiveSession`: VS Code's focused session, else the most
 * recently started one). `DebuggingHandler` calls it for every debug tool and
 * turns what it returns into tool results.
 *
 * Every method keeps to the same rules:
 * - DAP traffic goes only through `customRequestWithTimeout` and `withTimeout`
 *   (src/utils/timeout.ts). A `HardwareTimeoutError` keeps its class unless the
 *   method wraps its errors in a message of its own; that wrap (`wrapError`)
 *   keeps the error code the cause carries or implies (#11).
 * - Deadlines come from `Budgets` (src/executor/common.ts): one per DAP request
 *   and, for reads that take several requests, a fence around the whole read.
 * - Thread and frame ids are those of VS Code's focused stack item (KB7). A
 *   frame lookup is a state snapshot, `stackTrace` request included (KB8).
 *
 * The contract types live in src/executor/contract.ts and are re-exported
 * here. The snapshot, the GDB word read, the reset and the session reports
 * have modules of their own under src/executor/. `SERVER_VERSION` stays in
 * this file because the release recipe edits its literal with `npm version`.
 */

import * as vscode from 'vscode';
import { DEMCR_TRCENA, DWT_ADDRESSES, DWT_CTRL_CYCCNTENA, DWT_CTRL_NOCYCCNT } from './core/dwt';
import { decodeFaultRegisters, FAULT_REGISTER_ADDRESSES, FAULT_REGISTER_BLOCK, FaultRegisters, faultRegistersFromBlock } from './core/faultDecoder';
import { readPeripheralViaMemory, tryReadPeripheralViaExtension } from './core/peripheralReader';
import { ResetMethod } from './core/resetAssist';
import { DebugState, StackFrame } from './debugState';
import { logger } from './utils/logger';
import { getLiveSessionCount, getLiveSessionNames, getStoppedReason, isSessionStopped, resolveActiveSession, StopWaitResult, waitForStopEvent } from './utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError, withTimeout } from './utils/timeout';
import { ToolError, wrapError } from './core/toolResult';
import { Budgets, DEFAULT_HARDWARE_TIMEOUTS, EvaluateBody, FrameArg, frameArgOf, focusedThreadId, hex8, messageOf, ReadMemoryBody, ScopesBody, sessionOrThrow, StackTraceBody, ThreadsBody, toStackFrame, VariablesBody } from './executor/common';
import { AlreadyStopped, DapThread, ExecutorDiagnostics, HardwareTimeouts, IDebuggingExecutor, ResetOutcome, SessionStatus } from './executor/contract';
import { nthWordAddress, readWordThroughGdb, withHexPrefix } from './executor/gdbMemory';
import { connectionReport, deviceReport, launchFolderFor, noLaunchFolderText, probeSession } from './executor/sessionReports';
import { captureDebugState } from './executor/snapshot';
import { performReset, programCounterFrom } from './executor/targetReset';

export { DEFAULT_HARDWARE_TIMEOUTS } from './executor/common';
export type { DapThread, ExecutorDiagnostics, HardwareTimeouts, IDebuggingExecutor, ResetOutcome, SessionState, SessionStatus } from './executor/contract';

/** The version the MCP server, the server definition and the HTTP user agent report. Equals package.json. */
export const SERVER_VERSION = '2.3.10';

type Motion = 'stepOver' | 'stepInto' | 'stepOut' | 'continue' | 'pause';

/**
 * Each run-control operation: the DAP request it sends, and the workbench
 * command it runs instead when that request fails for any reason but a
 * timeout. The command acts on VS Code's focused session and its outcome is
 * not checked (KB1, #13).
 */
const MOTIONS: Readonly<Record<Motion, { request: string; workbenchCommand: string }>> = {
    stepOver: { request: 'next', workbenchCommand: 'workbench.action.debug.stepOver' },
    stepInto: { request: 'stepIn', workbenchCommand: 'workbench.action.debug.stepInto' },
    stepOut: { request: 'stepOut', workbenchCommand: 'workbench.action.debug.stepOut' },
    continue: { request: 'continue', workbenchCommand: 'workbench.action.debug.continue' },
    pause: { request: 'pause', workbenchCommand: 'workbench.action.debug.pause' },
};

/** Restart goes through the workbench only, on the focused session (KB2, #13). */
const WORKBENCH_RESTART = 'workbench.action.debug.restart';

/** Registers `read_core_registers` returns when no names are given, in this order. */
const CORE_REGISTER_NAMES: readonly string[] =
    'r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 sp lr pc xpsr msp psp control faultmask basepri primask'.split(' ');

/** `getThreads` fetches top frames for this many threads, this many requests at a time. */
const TOP_FRAME_THREADS = 32;
const TOP_FRAME_BATCH = 4;

/** Default depth of `getCallStack`. */
const CALL_STACK_LEVELS = 50;

/** Size of the stacked exception frame (R0-R3, R12, LR, PC, xPSR). */
const EXCEPTION_FRAME_BYTES = 32;

/** The fault status registers in the order the word-by-word read visits them. */
const FAULT_REGISTER_ORDER: ReadonlyArray<keyof FaultRegisters> = ['CFSR', 'HFSR', 'DFSR', 'MMFAR', 'BFAR', 'AFSR'];

/** A GDB passthrough reply. Callers read only the text; `adapterError` goes unused (KB4). */
interface GdbReply {
    text: string;
    adapterError: boolean;
}

export class DebuggingExecutor implements IDebuggingExecutor {
    private readonly budgets: Budgets;

    /** Keys given in `timeouts` replace the defaults one by one. Touches no VS Code API. */
    constructor(timeouts?: Partial<HardwareTimeouts>) {
        this.budgets = new Budgets({ ...DEFAULT_HARDWARE_TIMEOUTS, ...timeouts });
    }

    // ── Session lifecycle ──────────────────────────────────────────────

    async startDebugging(folderPath: string, launch: vscode.DebugConfiguration): Promise<boolean> {
        try {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderPath));
            return await vscode.debug.startDebugging(folder, launch);
        } catch (err) {
            throw wrapError('Starting the debug session failed', err);
        }
    }

    async startDebuggingByName(folderPath: string, launchName: string): Promise<boolean> {
        try {
            const folder = launchFolderFor(folderPath);
            if (!folder) {
                throw new ToolError('INVALID_ARGUMENT', noLaunchFolderText(folderPath));
            }
            // The name, not a configuration: VS Code looks it up in the folder's launch.json.
            return await vscode.debug.startDebugging(folder, launchName);
        } catch (err) {
            throw wrapError(`Failed to start debugging with configuration '${launchName}'`, err);
        }
    }

    async stopDebugging(which?: vscode.DebugSession): Promise<void> {
        try {
            const ending = which ?? resolveActiveSession();
            if (ending) {
                await vscode.debug.stopDebugging(ending);
            }
        } catch (err) {
            throw wrapError('Stopping the debug session failed', err);
        }
    }

    async restart(): Promise<void> {
        try {
            await vscode.commands.executeCommand(WORKBENCH_RESTART);
        } catch (err) {
            throw wrapError('Restarting the debug session failed', err);
        }
    }

    hasDebugSession(): boolean {
        return resolveActiveSession() !== undefined;
    }

    getActiveSession(): vscode.DebugSession | undefined {
        return resolveActiveSession();
    }

    // ── Readiness, status, diagnostics ─────────────────────────────────

    async hasActiveSession(): Promise<boolean> {
        const session = resolveActiveSession();
        if (!session) {
            return false;
        }
        try {
            // Only whether it answers matters; the thread list is not looked at.
            await customRequestWithTimeout(session, 'threads', {}, this.budgets.probe());
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                logger.warn('hasActiveSession: threads probe timed out — probe or target may be unresponsive');
            } else {
                logger.debug('hasActiveSession: threads probe failed', err);
            }
            return false;
        }
        return isSessionStopped(session);
    }

    getSessionStatus(): Promise<SessionStatus> {
        return probeSession(this.budgets.probe());
    }

    async checkTargetConnection(): Promise<string> {
        return connectionReport(await this.getSessionStatus());
    }

    getDiagnostics(): ExecutorDiagnostics {
        return {
            serverVersion: SERVER_VERSION,
            liveSessionCount: getLiveSessionCount(),
            liveSessionNames: getLiveSessionNames(),
            // The only place that reads VS Code's focused session directly.
            hasVscodeActiveSession: vscode.debug.activeDebugSession !== undefined,
        };
    }

    async getDeviceInfo(): Promise<string> {
        return deviceReport(sessionOrThrow());
    }

    // ── Run control ────────────────────────────────────────────────────

    stepOver(overrideMs?: number): Promise<void> {
        return this.move('stepOver', overrideMs);
    }

    stepInto(overrideMs?: number): Promise<void> {
        return this.move('stepInto', overrideMs);
    }

    stepOut(overrideMs?: number): Promise<void> {
        return this.move('stepOut', overrideMs);
    }

    continue(overrideMs?: number): Promise<void> {
        return this.move('continue', overrideMs);
    }

    pause(overrideMs?: number): Promise<void> {
        return this.move('pause', overrideMs);
    }

    armStopWaiter(limitMs: number): Promise<StopWaitResult> {
        const session = sessionOrThrow();
        return waitForStopEvent(session, this.budgets.stopWait(limitMs));
    }

    async waitForStop(limitMs?: number): Promise<StopWaitResult | AlreadyStopped> {
        const session = sessionOrThrow();
        if (isSessionStopped(session)) {
            return { kind: 'already-stopped', reason: getStoppedReason(session) };
        }
        return waitForStopEvent(session, this.budgets.stopWait(limitMs));
    }

    /** Sends the operation's request without waiting for the stop; the handler arms the waiter first. */
    private async move(motion: Motion, overrideMs: number | undefined): Promise<void> {
        const session = sessionOrThrow();
        const { request, workbenchCommand } = MOTIONS[motion];
        try {
            await customRequestWithTimeout(session, request, { threadId: focusedThreadId() }, this.budgets.request(overrideMs));
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            await vscode.commands.executeCommand(workbenchCommand);
        }
    }

    // ── Breakpoints: VS Code model ─────────────────────────────────────

    async addBreakpoint(file: vscode.Uri, line: number, extras?: { condition?: string; logMessage?: string }): Promise<void> {
        try {
            // A Position, not a Range: the transport stub's Location keeps its second argument as `range.start`.
            const anchor = new vscode.Location(file, new vscode.Position(line - 1, 0));
            const added = new vscode.SourceBreakpoint(anchor, true, extras?.condition, undefined, extras?.logMessage);
            vscode.debug.addBreakpoints([added]);
        } catch (err) {
            throw wrapError('Adding the breakpoint failed', err);
        }
    }

    async removeBreakpoint(file: vscode.Uri, line: number): Promise<void> {
        try {
            const target = file.toString();
            const matching = vscode.debug.breakpoints.filter((entry) => entry instanceof vscode.SourceBreakpoint
                && entry.location.uri.toString() === target
                && entry.location.range.start.line === line - 1);
            if (matching.length > 0) {
                vscode.debug.removeBreakpoints(matching);
            }
        } catch (err) {
            throw wrapError('Removing the breakpoint failed', err);
        }
    }

    getBreakpoints(): ReadonlyArray<vscode.Breakpoint> {
        return vscode.debug.breakpoints;
    }

    clearAllBreakpoints(): void {
        const everything = [...vscode.debug.breakpoints];
        if (everything.length > 0) {
            vscode.debug.removeBreakpoints(everything);
        }
    }

    // ── Breakpoints and logpoints through GDB ──────────────────────────
    // Paths and expressions go in verbatim; the handler escapes `format`.

    async setBreakpointViaGdb(sourcePath: string, line: number, overrideMs?: number, condition?: string): Promise<string> {
        const guard = condition?.trim();
        const command = guard ? `break ${sourcePath}:${line} if ${guard}` : `break ${sourcePath}:${line}`;
        return (await this.gdb(command, overrideMs)).text;
    }

    async setLogpointViaGdb(sourcePath: string, line: number, format: string, values: string[], overrideMs?: number): Promise<string> {
        const tail = values.length > 0 ? `,${values.join(',')}` : '';
        return (await this.gdb(`dprintf ${sourcePath}:${line},"${format}"${tail}`, overrideMs)).text;
    }

    async setBreakpointConditionViaGdb(breakpointNo: number, condition: string, overrideMs?: number): Promise<string> {
        return (await this.gdb(`condition ${breakpointNo} ${condition}`, overrideMs)).text;
    }

    async clearBreakpointViaGdb(sourcePath: string, line: number, overrideMs?: number): Promise<string> {
        return (await this.gdb(`clear ${sourcePath}:${line}`, overrideMs)).text;
    }

    async clearAllBreakpointsViaGdb(overrideMs?: number): Promise<string> {
        return (await this.gdb('delete', overrideMs)).text;
    }

    /**
     * One GDB command as a REPL evaluate of `-exec <command>` in the focused
     * frame. cdt-gdb-adapter treats that input as an expression, not a CLI
     * command, so on `gdbtarget` the command does not reach GDB (KB3). An
     * adapter error becomes the reply text; only a timeout rejects.
     */
    private async gdb(command: string, overrideMs?: number): Promise<GdbReply> {
        const session = sessionOrThrow();
        const frame = await this.frameArg();
        try {
            const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
                { expression: `-exec ${command}`, context: 'repl', ...frame }, this.budgets.request(overrideMs));
            return { text: String(reply?.result ?? '').trim(), adapterError: false };
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            return { text: messageOf(err).trim(), adapterError: true };
        }
    }

    // ── State, stack, threads, variables, expressions ──────────────────

    getCurrentDebugState(lookahead = 3): Promise<DebugState> {
        return captureDebugState({ budgetMs: this.budgets.snapshot(), lookahead, withSource: true });
    }

    /** The focused frame's id, found by a snapshot without source text (KB8); null without a focused frame. */
    private async focusedFrameId(): Promise<number | null> {
        const snapshot = await captureDebugState({ budgetMs: this.budgets.snapshot(), lookahead: 0, withSource: false });
        return snapshot.frameId;
    }

    private async frameArg(): Promise<FrameArg> {
        return frameArgOf(await this.focusedFrameId());
    }

    async getCallStack(threadId?: number, levels: number = CALL_STACK_LEVELS, overrideMs?: number): Promise<StackFrame[]> {
        const session = sessionOrThrow();
        const reply = await customRequestWithTimeout<StackTraceBody | undefined>(session, 'stackTrace',
            { threadId: threadId ?? focusedThreadId(), startFrame: 0, levels }, this.budgets.request(overrideMs));
        return (reply?.stackFrames ?? []).map((frame) => toStackFrame(frame, true));
    }

    async getThreads(overrideMs?: number): Promise<DapThread[]> {
        const session = sessionOrThrow();
        const budgetMs = this.budgets.request(overrideMs);
        const reply = await customRequestWithTimeout<ThreadsBody | undefined>(session, 'threads', {}, budgetMs);
        const threads: DapThread[] = (reply?.threads ?? []).map((thread) => ({ id: thread.id, name: thread.name ?? `thread-${thread.id}` }));
        const framed = threads.slice(0, TOP_FRAME_THREADS);
        for (let first = 0; first < framed.length; first += TOP_FRAME_BATCH) {
            // One batch in flight at a time; a failed request just leaves its thread without a frame.
            await Promise.allSettled(framed.slice(first, first + TOP_FRAME_BATCH).map(async (thread) => {
                const trace = await customRequestWithTimeout<StackTraceBody | undefined>(session, 'stackTrace',
                    { threadId: thread.id, startFrame: 0, levels: 1 }, budgetMs);
                const innermost = trace?.stackFrames?.[0];
                if (innermost) {
                    thread.topFrame = toStackFrame(innermost, false);
                }
            }));
        }
        return threads;
    }

    async getVariables(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any> {
        try {
            const session = sessionOrThrow();
            const budgetMs = this.budgets.request(overrideMs);
            const reply = await customRequestWithTimeout<ScopesBody | undefined>(session, 'scopes', { frameId }, budgetMs);
            const offered = reply?.scopes;
            if (!offered || offered.length === 0) {
                return { scopes: [] };
            }
            const kept = scope === 'local' || scope === 'global'
                ? offered.filter((candidate) => candidate.name.toLowerCase().includes(scope))
                : offered;
            // One scope after the other; the adapter's scope objects are extended in place.
            for (const entry of kept) {
                try {
                    const content = await customRequestWithTimeout<VariablesBody | undefined>(session, 'variables',
                        { variablesReference: entry.variablesReference }, budgetMs);
                    entry.variables = content?.variables ?? [];
                } catch (err) {
                    entry.variables = [];
                    entry.error = messageOf(err);
                }
            }
            return { scopes: kept };
        } catch (err) {
            // Also flattens a `scopes` timeout (KB14): no longer a HardwareTimeoutError, though its code stays TIMEOUT.
            throw wrapError('Reading the variables failed', err);
        }
    }

    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any> {
        return this.getVariables(frameId, scope, overrideMs);
    }

    async evaluateExpression(expression: string, frameId: number, overrideMs?: number): Promise<any> {
        try {
            const session = sessionOrThrow();
            // Verbatim, an agent's own `-exec …` included.
            return await customRequestWithTimeout(session, 'evaluate', { expression, frameId, context: 'repl' }, this.budgets.request(overrideMs));
        } catch (err) {
            throw wrapError('Evaluating the expression failed', err);
        }
    }

    // ── Memory ─────────────────────────────────────────────────────────

    async readMemory(address: string, length: number, overrideMs?: number): Promise<Buffer> {
        const session = sessionOrThrow();
        const start = withHexPrefix(address);
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readMemory', this.budgets.operation(overrideMs), async () => {
            try {
                const reply = await customRequestWithTimeout<ReadMemoryBody | undefined>(session, 'readMemory',
                    { memoryReference: start, count: length }, budgetMs);
                if (reply?.data) {
                    // Returned as it came, even when shorter than asked (KB9).
                    return Buffer.from(reply.data, 'base64');
                }
            } catch (err) {
                if (err instanceof HardwareTimeoutError) {
                    throw err;
                }
            }
            return this.readWordsThroughGdb(session, start, length, budgetMs);
        });
    }

    /** `readMemory`'s fallback: word by word through GDB; the first word that fails fails the read. */
    private async readWordsThroughGdb(session: vscode.DebugSession, start: string, length: number, budgetMs: number): Promise<Buffer> {
        const lookup = await this.frameArg();
        // Without a focused frame each word looks again.
        const shared = lookup.frameId === undefined ? undefined : lookup;
        const words: Buffer[] = [];
        for (let index = 0; index < Math.ceil(length / 4); index++) {
            const value = await this.wordThroughGdb(session, nthWordAddress(start, index), budgetMs, shared);
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(value >>> 0, 0);
            words.push(bytes);
        }
        return Buffer.concat(words).subarray(0, length);
    }

    private async wordThroughGdb(session: vscode.DebugSession, address: string, budgetMs: number, frame?: FrameArg): Promise<number> {
        return readWordThroughGdb(session, address, frame ?? await this.frameArg(), budgetMs);
    }

    async readMemoryWord(address: string, overrideMs?: number): Promise<number> {
        const session = sessionOrThrow();
        const at = withHexPrefix(address);
        const budgetMs = this.budgets.request(overrideMs);
        try {
            const reply = await customRequestWithTimeout<ReadMemoryBody | undefined>(session, 'readMemory',
                { memoryReference: at, count: 4 }, budgetMs);
            const bytes = reply?.data ? Buffer.from(reply.data, 'base64') : undefined;
            if (bytes && bytes.length >= 4) {
                return bytes.readUInt32LE(0);
            }
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
        }
        // No overall fence here: each request has its own deadline.
        return this.wordThroughGdb(session, at, budgetMs);
    }

    async writeMemoryWord(address: string, value: number, overrideMs?: number): Promise<void> {
        const session = sessionOrThrow();
        const at = withHexPrefix(address);
        const budgetMs = this.budgets.request(overrideMs);
        const wanted = value >>> 0;
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(wanted, 0);
        try {
            await customRequestWithTimeout(session, 'writeMemory', { memoryReference: at, data: bytes.toString('base64') }, budgetMs);
        } catch (err) {
            if (err instanceof HardwareTimeoutError) {
                throw err;
            }
            // Whatever GDB answers is ignored (KB4): the read-back below decides.
            await this.gdb(`set {unsigned int}${at} = ${wanted}`, budgetMs);
        }
        const readBack = await this.readMemoryWord(at, budgetMs);
        if (readBack >>> 0 !== wanted) {
            throw new Error(`Write to ${at} did not stick (wrote ${hex8(wanted)}, read back ${hex8(readBack)})`);
        }
    }

    async readExceptionFrame(stackPointer: number, overrideMs?: number): Promise<Buffer> {
        // The request budget becomes the nested read's override, so it also bounds that read's fence.
        return this.readMemory(`0x${(stackPointer >>> 0).toString(16)}`, EXCEPTION_FRAME_BYTES, this.budgets.request(overrideMs));
    }

    // ── Core registers, DWT, peripherals, fault status ─────────────────

    async readCoreRegisters(overrideMs?: number, names?: string[]): Promise<Record<string, string>> {
        const session = sessionOrThrow();
        const wanted = names && names.length > 0 ? names : CORE_REGISTER_NAMES;
        const frame = await this.frameArg();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readCoreRegisters', this.budgets.operation(overrideMs), async () => {
            // All requests go out together, in list order.
            const values = await Promise.all(wanted.map((name) => this.registerText(session, name, frame, budgetMs)));
            const table: Record<string, string> = {};
            wanted.forEach((name, index) => {
                table[name] = values[index];
            });
            return table;
        });
    }

    /** GDB's text for `$<name>` as the adapter returns it, or a placeholder when the read failed. */
    private async registerText(session: vscode.DebugSession, name: string, frame: FrameArg, budgetMs: number): Promise<string> {
        try {
            const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
                { expression: `$${name}`, context: 'watch', ...frame }, budgetMs);
            if (!reply) {
                return '<unavailable>';
            }
            return reply.result as string;
        } catch (err) {
            return err instanceof HardwareTimeoutError ? '<timeout>' : '<unavailable>';
        }
    }

    async readCycleCounter(overrideMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }> {
        sessionOrThrow();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readCycleCounter', this.budgets.operation(overrideMs), async () => {
            const demcr = await this.readMemoryWord(DWT_ADDRESSES.DEMCR, budgetMs);
            if ((demcr & DEMCR_TRCENA) === 0) {
                await this.writeMemoryWord(DWT_ADDRESSES.DEMCR, (demcr | DEMCR_TRCENA) >>> 0, budgetMs);
            }
            const control = await this.readMemoryWord(DWT_ADDRESSES.DWT_CTRL, budgetMs);
            if ((control & DWT_CTRL_NOCYCCNT) !== 0) {
                return { present: false, cycles: 0, enabledNow: false };
            }
            let enabledNow = false;
            if ((control & DWT_CTRL_CYCCNTENA) === 0) {
                await this.writeMemoryWord(DWT_ADDRESSES.DWT_CTRL, (control | DWT_CTRL_CYCCNTENA) >>> 0, budgetMs);
                enabledNow = true;
            }
            const cycles = (await this.readMemoryWord(DWT_ADDRESSES.DWT_CYCCNT, budgetMs)) >>> 0;
            return { present: true, cycles, enabledNow };
        });
    }

    async readPeripheralRegister(peripheral: string, register?: string, overrideMs?: number): Promise<string> {
        // The Peripheral Inspector is asked before the session is checked (KB13).
        const inspected = await tryReadPeripheralViaExtension(peripheral, register);
        if (inspected !== null) {
            return inspected;
        }
        const session = sessionOrThrow();
        const frameId = await this.focusedFrameId();
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readPeripheralRegister', this.budgets.operation(overrideMs),
            () => readPeripheralViaMemory(session, peripheral, register, frameId, budgetMs));
    }

    /**
     * CFSR, HFSR, DFSR, MMFAR, BFAR and AFSR: one 24-byte read, else one word
     * at a time. No session check of its own; the reads fail without one.
     */
    async readFaultRegisters(overrideMs?: number): Promise<FaultRegisters> {
        const budgetMs = this.budgets.request(overrideMs);
        return withTimeout('readFaultRegisters', this.budgets.operation(overrideMs), async () => {
            try {
                // The request budget is the nested read's override, fence included (KB10).
                const block = await this.readMemory(FAULT_REGISTER_BLOCK.address, FAULT_REGISTER_BLOCK.bytes, budgetMs);
                if (block.length >= FAULT_REGISTER_BLOCK.bytes) {
                    return faultRegistersFromBlock(block);
                }
            } catch (err) {
                if (err instanceof HardwareTimeoutError) {
                    throw err;
                }
            }
            const registers = {} as FaultRegisters;
            for (const name of FAULT_REGISTER_ORDER) {
                registers[name] = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES[name], budgetMs);
            }
            return registers;
        });
    }

    async getFaultInfo(overrideMs?: number): Promise<string> {
        return decodeFaultRegisters(await this.readFaultRegisters(overrideMs));
    }

    // ── Reset ──────────────────────────────────────────────────────────

    async resetTarget(request: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome> {
        const session = sessionOrThrow();
        return performReset(session, request, this.budgets.request(request.timeoutMs), {
            halt: (budgetMs) => this.pause(budgetMs),
            resume: (budgetMs) => this.continue(budgetMs),
            monitor: async (command, budgetMs) => (await this.gdb(command, budgetMs)).text,
            readWord: (address, budgetMs) => this.readMemoryWord(address, budgetMs),
            readPc: (budgetMs) => this.readProgramCounter(budgetMs),
        });
    }

    /** `$pc` in the focused frame, Thumb bit cleared; the budget is used as given. */
    private async readProgramCounter(budgetMs: number): Promise<number> {
        const session = sessionOrThrow();
        const frame = await this.frameArg();
        const reply = await customRequestWithTimeout<EvaluateBody | undefined>(session, 'evaluate',
            { expression: '$pc', context: 'watch', ...frame }, budgetMs);
        return programCounterFrom(reply?.result);
    }
}
