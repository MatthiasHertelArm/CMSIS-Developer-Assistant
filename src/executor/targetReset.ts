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
 * The verified target reset behind the `reset` tool.
 *
 * A running target is halted first. Each reset method is then sent as GDB
 * monitor commands in the dialect of the GDB server behind the session
 * (src/core/resetAssist.ts), always in the form that leaves the core halted.
 * Whether the reset happened is judged by the PC afterwards: it has to equal
 * the reset vector in the vector table that VTOR points to. Only a verified
 * reset is resumed, and only when the caller asked for `halt: false`.
 *
 * Known weak spots, kept on purpose: a target already halted at the reset
 * vector verifies even when no command reached GDB (KB5), and both stop waits
 * are armed only after their trigger returned (KB6).
 */

import * as vscode from 'vscode';
import { buildResetCommands, detectGdbServerKind, replyLooksUnsupported, ResetMethod, unsupportedResetDetail } from '../core/resetAssist';
import { isSessionStopped, waitForStopEvent } from '../utils/sessionStateTracker';
import { hex8, messageOf } from './common';
import { ResetOutcome } from './contract';

/** How long the halt before the reset may take. */
const HALT_WAIT_MS = 5_000;
/** How long a stop event is awaited after the reset commands. */
const POST_RESET_WAIT_MS = 3_000;
/** Fixed pause before the vector table is read. */
const SETTLE_MS = 500;
/** Vector Table Offset Register, spelled as the request sends it. */
const VTOR_ADDRESS = '0xE000ED08';
/** VTOR holds the table base in bits 31:7. */
const TABLE_BASE_MASK = 0xFFFFFF80;
/** Clears the Thumb bit of a code address. */
const WITHOUT_THUMB_BIT = 0xFFFFFFFE;
/** Methods of an `auto` reset, mildest first. */
const AUTO_METHODS: readonly ResetMethod[] = ['system', 'core', 'hardware'];

/** What a reset needs from the executor. Each call gets the reset's request budget. */
export interface ResetPort {
    /** DAP `pause`, with the executor's workbench fallback. */
    halt(budgetMs: number): Promise<void>;
    /** DAP `continue`, with the executor's workbench fallback. */
    resume(budgetMs: number): Promise<void>;
    /** One GDB command through the `-exec` passthrough; resolves the reply text. */
    monitor(command: string, budgetMs: number): Promise<string>;
    readWord(address: string, budgetMs: number): Promise<number>;
    /** The PC, Thumb bit cleared. */
    readPc(budgetMs: number): Promise<number>;
}

export interface ResetRequest {
    method?: 'auto' | ResetMethod;
    halt?: boolean;
}

export async function performReset(
    session: vscode.DebugSession,
    request: ResetRequest,
    budgetMs: number,
    port: ResetPort,
): Promise<ResetOutcome> {
    const staysHalted = request.halt !== false;
    const launch: Record<string, any> = session.configuration ?? {};
    const serverKind = detectGdbServerKind(`${launch.target?.server ?? ''} ${launch.debugger?.name ?? ''} ${session.name}`);
    const outcome: ResetOutcome = {
        serverKind,
        methodsTried: [],
        commandsIssued: [],
        replies: [],
        verified: false,
        verificationDetail: 'not attempted',
        haltedByUs: false,
        resumed: false,
    };

    if (!isSessionStopped(session)) {
        await port.halt(budgetMs);
        const halted = await waitForStopEvent(session, HALT_WAIT_MS);
        if (halted.kind !== 'stopped') {
            outcome.verificationDetail = 'could not halt the target to issue the reset (pause did not stop it within 5 s)';
            return outcome;
        }
        outcome.haltedByUs = true;
    }

    const methods: ResetMethod[] = !request.method || request.method === 'auto' ? [...AUTO_METHODS] : [request.method];
    for (let position = 0; position < methods.length; position++) {
        const method = methods[position];
        outcome.methodsTried.push(method);
        let rejectedByServer = false;
        // The halting form whatever `halt` says: the target is resumed below only once verified.
        for (const command of buildResetCommands(serverKind, method, true)) {
            outcome.commandsIssued.push(command);
            const reply = await port.monitor(command, budgetMs);
            outcome.replies.push(reply || '<no echo from adapter>');
            if (replyLooksUnsupported(reply)) {
                rejectedByServer = true;
            }
        }
        if (rejectedByServer) {
            outcome.verificationDetail = unsupportedResetDetail(method, methods.length - 1 - position);
            continue;
        }
        const afterwards = await waitForStopEvent(session, POST_RESET_WAIT_MS);
        if (afterwards.kind === 'ended') {
            outcome.verificationDetail = 'debug session ended during the reset';
            return outcome;
        }
        await settle(SETTLE_MS);
        const verdict = await compareWithResetVector(port, budgetMs);
        outcome.verificationDetail = verdict.detail;
        if (verdict.verified) {
            outcome.verified = true;
            break;
        }
    }

    if (outcome.verified && !staysHalted) {
        await port.resume(budgetMs);
        outcome.resumed = true;
    }
    return outcome;
}

/**
 * The PC in a `$pc` evaluate result such as `0x080001a0 <Reset_Handler+4>`,
 * with the Thumb bit cleared.
 */
export function programCounterFrom(result: string | undefined): number {
    const hit = /0x[0-9a-fA-F]+/.exec(String(result ?? ''));
    if (!hit) {
        throw new Error(`could not parse PC from '${result ?? '<empty>'}'`);
    }
    return (parseInt(hit[0], 16) & WITHOUT_THUMB_BIT) >>> 0;
}

/**
 * Whether the PC sits on the reset vector. A VTOR that cannot be read counts
 * as a table at 0, silently (KB11); any other failed read gives an unverified
 * verdict that names it. Never rejects.
 */
async function compareWithResetVector(port: ResetPort, budgetMs: number): Promise<{ verified: boolean; detail: string }> {
    let tableBase = 0;
    try {
        const vtor = await port.readWord(VTOR_ADDRESS, budgetMs);
        tableBase = vtor === 0 ? 0 : (vtor & TABLE_BASE_MASK) >>> 0;
    } catch {
        tableBase = 0;
    }
    try {
        const vector = ((await port.readWord(hex8(tableBase + 4), budgetMs)) & WITHOUT_THUMB_BIT) >>> 0;
        const pc = await port.readPc(budgetMs);
        if (pc === vector) {
            return { verified: true, detail: `PC=${hex8(pc)} matches the reset vector (${hex8(vector)}, vector table at ${hex8(tableBase)})` };
        }
        return { verified: false, detail: `PC=${hex8(pc)} does NOT match the reset vector ${hex8(vector)} (vector table at ${hex8(tableBase)})` };
    } catch (err) {
        return { verified: false, detail: `verification reads failed: ${messageOf(err)}` };
    }
}

function settle(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
