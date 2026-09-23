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
 * The types the executor is used through. `src/debuggingExecutor.ts`
 * re-exports each of them, so importers keep a single module path.
 *
 * `IDebuggingExecutor` is put together from one interface per concern. The
 * handler takes the whole of it; its unit tests fake only the parts they
 * drive. Parameter names carry no meaning for callers: every `overrideMs` is
 * a one-call replacement of a configured deadline (see `Budgets` in
 * ./common.ts for how it is bounded).
 */

import * as vscode from 'vscode';
import { FaultRegisters } from '../core/faultDecoder';
import { ResetMethod, ResetOutcomeView } from '../core/resetAssist';
import { DebugState, StackFrame } from '../debugState';
import { StopWaitResult } from '../utils/sessionStateTracker';

/** Deadlines from the settings `dapRequestTimeoutMs` and `memoryReadTimeoutMs`. */
export interface HardwareTimeouts {
    /** One DAP request. */
    dapRequestMs: number;
    /** A whole read that may need several requests: memory, registers, peripherals, DWT, fault status. */
    memoryReadMs: number;
}

/** Where a session stands, judged by the `threads` probe and the stop tracker. */
export type SessionState = 'no-session' | 'initializing' | 'running' | 'stopped' | 'unresponsive';

export interface SessionStatus {
    state: SessionState;
    sessionName: string | null;
    sessionType: string | null;
    configurationName: string | null;
    /** The adapter answered the probe in time. */
    dapResponsive: boolean;
    /** Round trip of the probe in whole milliseconds; null unless it answered. */
    dapProbeMs: number | null;
    /** Why the probe failed, or why the target is stopped. */
    detail?: string;
}

/** One entry of the thread list, with the thread's innermost frame when that could be read. */
export interface DapThread {
    id: number;
    name: string;
    topFrame?: StackFrame;
}

/** The record of one reset attempt: exactly what `renderResetOutcome` prints. */
export interface ResetOutcome extends ResetOutcomeView {}

/** What the status tool reports about this build and the sessions the window can see. */
export interface ExecutorDiagnostics {
    serverVersion: string;
    liveSessionCount: number;
    liveSessionNames: string[];
    hasVscodeActiveSession: boolean;
}

/** `waitForStop` found the target halted before it started waiting. */
export interface AlreadyStopped {
    kind: 'already-stopped';
    /** The reason of the stop event the tracker saw, when it saw one. */
    reason: string | null;
}

/** Starting and ending sessions, and finding the one this window acts on. */
export interface SessionLifecycle {
    startDebugging(folderPath: string, launch: vscode.DebugConfiguration): Promise<boolean>;
    /** Resolves `launchName` from launch.json in the workspace folder that fits `folderPath`. */
    startDebuggingByName(folderPath: string, launchName: string): Promise<boolean>;
    stopDebugging(which?: vscode.DebugSession): Promise<void>;
    /** Runs VS Code's restart command, which acts on the session VS Code has focused. */
    restart(): Promise<void>;
    /** Synchronous, and sends nothing to the adapter. */
    hasDebugSession(): boolean;
    getActiveSession(): vscode.DebugSession | undefined;
}

/** Whether the adapter answers and the target can be inspected. */
export interface Readiness {
    /** A session exists, answers the `threads` probe, and its target is stopped. */
    hasActiveSession(): Promise<boolean>;
    /** Never rejects. */
    getSessionStatus(): Promise<SessionStatus>;
    /** The status as the `check_target_connection` text. Never rejects. */
    checkTargetConnection(): Promise<string>;
    getDiagnostics(): ExecutorDiagnostics;
    getDeviceInfo(): Promise<string>;
}

/** Moving the target. None of these waits for the stop that may follow. */
export interface RunControl {
    stepOver(overrideMs?: number): Promise<void>;
    stepInto(overrideMs?: number): Promise<void>;
    stepOut(overrideMs?: number): Promise<void>;
    continue(overrideMs?: number): Promise<void>;
    pause(overrideMs?: number): Promise<void>;
    /** Not async: without a session it throws before the caller sends its request. */
    armStopWaiter(limitMs: number): Promise<StopWaitResult>;
    waitForStop(limitMs?: number): Promise<StopWaitResult | AlreadyStopped>;
}

/** Breakpoints in VS Code's model, and GDB's own through the `-exec` passthrough. */
export interface BreakpointControl {
    addBreakpoint(file: vscode.Uri, line: number, extras?: { condition?: string; logMessage?: string }): Promise<void>;
    removeBreakpoint(file: vscode.Uri, line: number): Promise<void>;
    getBreakpoints(): ReadonlyArray<vscode.Breakpoint>;
    clearAllBreakpoints(): void;
    // The GDB methods resolve GDB's reply text; telling success from failure is up to the caller.
    setBreakpointViaGdb(sourcePath: string, line: number, overrideMs?: number, condition?: string): Promise<string>;
    setLogpointViaGdb(sourcePath: string, line: number, format: string, values: string[], overrideMs?: number): Promise<string>;
    setBreakpointConditionViaGdb(breakpointNo: number, condition: string, overrideMs?: number): Promise<string>;
    clearBreakpointViaGdb(sourcePath: string, line: number, overrideMs?: number): Promise<string>;
    clearAllBreakpointsViaGdb(overrideMs?: number): Promise<string>;
}

/** Program state: location, stack, threads, variables and expressions. */
export interface ProgramInspection {
    getCurrentDebugState(lookahead: number): Promise<DebugState>;
    getCallStack(threadId?: number, levels?: number, overrideMs?: number): Promise<StackFrame[]>;
    getThreads(overrideMs?: number): Promise<DapThread[]>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any>;
    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', overrideMs?: number): Promise<any>;
    /** Resolves the adapter's evaluate reply body unchanged. */
    evaluateExpression(expression: string, frameId: number, overrideMs?: number): Promise<any>;
}

/** Cortex-M target access: memory, core registers, DWT, fault status, peripherals and reset. */
export interface TargetAccess {
    readMemory(address: string, length: number, overrideMs?: number): Promise<Buffer>;
    readMemoryWord(address: string, overrideMs?: number): Promise<number>;
    writeMemoryWord(address: string, value: number, overrideMs?: number): Promise<void>;
    readExceptionFrame(stackPointer: number, overrideMs?: number): Promise<Buffer>;
    /** Values are GDB's text, or `<timeout>` / `<unavailable>` for a register that could not be read. */
    readCoreRegisters(overrideMs?: number, names?: string[]): Promise<Record<string, string>>;
    readCycleCounter(overrideMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }>;
    readPeripheralRegister(peripheral: string, register?: string, overrideMs?: number): Promise<string>;
    readFaultRegisters(overrideMs?: number): Promise<FaultRegisters>;
    getFaultInfo(overrideMs?: number): Promise<string>;
    resetTarget(request: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome>;
}

/** Everything `DebuggingHandler` needs from the debug layer. */
export interface IDebuggingExecutor
    extends SessionLifecycle, Readiness, RunControl, BreakpointControl, ProgramInspection, TargetAccess {}
