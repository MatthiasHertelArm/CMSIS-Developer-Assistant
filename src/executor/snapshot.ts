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
 * The state snapshot: one `DebugState` filled from the session, VS Code's
 * focused stack frame, a 50-level `stackTrace` of that frame's thread, the
 * source text around the top frame, and the window's source breakpoints
 * followed by the session's GDB `dprintf` logpoints.
 *
 * The location always comes from the adapter's top frame, never from the
 * active editor. The same snapshot, without the source text, serves as the
 * executor's frame lookup, which is why every GDB command and register read
 * starts with a `stackTrace` request (KB8).
 *
 * A snapshot never fails: each step that can go wrong is logged and leaves its
 * fields at their defaults.
 */

import * as vscode from 'vscode';
import { DebugState, formatBreakpointModifiers } from '../debugState';
import { logger } from '../utils/logger';
import { gdbLogpointsOf, resolveActiveSession } from '../utils/sessionStateTracker';
import { customRequestWithTimeout } from '../utils/timeout';
import { DapFrameBody, NAME_PLACEHOLDER, StackTraceBody, toStackFrame } from './common';

/** Frames the snapshot asks for. */
const SNAPSHOT_DEPTH = 50;

export interface SnapshotPlan {
    /** Deadline of the `stackTrace` request. */
    budgetMs: number;
    /** How many non-empty source lines to collect after the current one. */
    lookahead: number;
    /** Open the top frame's source file; a frame lookup does without. */
    withSource: boolean;
}

export async function captureDebugState(plan: SnapshotPlan): Promise<DebugState> {
    const snapshot = new DebugState();
    try {
        const session = resolveActiveSession();
        if (session) {
            snapshot.sessionActive = true;
            snapshot.updateConfigurationName(session.configuration.name ?? null);
            const focus = vscode.debug.activeStackItem;
            if (focus && 'frameId' in focus) {
                snapshot.updateContext(focus.frameId, focus.threadId);
                const top = await readStack(session, focus.threadId, plan.budgetMs, snapshot);
                if (top && plan.withSource) {
                    await readSourceAround(top, plan.lookahead, snapshot);
                }
            }
        }
        snapshot.updateBreakpoints([...describeSourceBreakpoints(), ...(session ? describeGdbLogpoints(session) : [])]);
    } catch (err) {
        logger.warn('Debug state snapshot cut short by an unexpected error', err);
    }
    return snapshot;
}

/**
 * Fills the frame name and stack of `snapshot` from one `stackTrace` of the
 * focused thread, sent to `session` even when the focus belongs to another
 * session. Returns the top frame, if there is one.
 */
async function readStack(
    session: vscode.DebugSession,
    threadId: number,
    budgetMs: number,
    snapshot: DebugState,
): Promise<DapFrameBody | undefined> {
    try {
        const reply = await customRequestWithTimeout<StackTraceBody | undefined>(
            session, 'stackTrace', { threadId, startFrame: 0, levels: SNAPSHOT_DEPTH }, budgetMs);
        const frames = reply?.stackFrames ?? [];
        if (frames.length === 0) {
            return undefined;
        }
        snapshot.updateFrameName(frames[0].name || null);
        snapshot.updateStackTrace(frames.map((frame) => toStackFrame(frame, false)));
        return frames[0];
    } catch (err) {
        logger.debug('Debug state snapshot: the stackTrace request for the focused thread failed', err);
        snapshot.updateFrameName(null);
        snapshot.updateStackTrace([]);
        return undefined;
    }
}

/**
 * Current line and the next non-empty lines of the top frame's source. The
 * adapter's line is reported as is; only the text lookup is clamped to the
 * document. Frames without a source path or line (assembly, ROM) are skipped.
 */
async function readSourceAround(top: DapFrameBody, lookahead: number, snapshot: DebugState): Promise<void> {
    const sourcePath = top.source?.path;
    const line = top.line;
    if (!sourcePath || typeof line !== 'number') {
        return;
    }
    try {
        const text = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
        const row = Math.min(Math.max(line - 1, 0), text.lineCount - 1);
        const following: string[] = [];
        for (let next = row + 1; next < text.lineCount && following.length < lookahead; next++) {
            const content = text.lineAt(next).text.trim();
            if (content.length > 0) {
                following.push(content);
            }
        }
        snapshot.updateLocation(sourcePath, lastPathSegment(sourcePath), line, text.lineAt(row).text.trim(), following);
    } catch (err) {
        logger.debug(`Debug state snapshot: could not open ${sourcePath} for the top frame`, err);
    }
}

/** `<file>:<line><modifiers>` for every source breakpoint of the window; other kinds are left out. */
function describeSourceBreakpoints(): string[] {
    return vscode.debug.breakpoints
        .filter((entry): entry is vscode.SourceBreakpoint => entry instanceof vscode.SourceBreakpoint)
        .map((entry) => {
            const file = lastPathSegment(entry.location.uri.fsPath) || NAME_PLACEHOLDER;
            return `${file}:${entry.location.range.start.line + 1}${formatBreakpointModifiers(entry)}`;
        });
}

/** `<file>:<line><modifiers> (GDB dprintf <n>)` for every logpoint the tools set as a GDB `dprintf` in the session. */
function describeGdbLogpoints(session: vscode.DebugSession): string[] {
    return gdbLogpointsOf(session).map((logpoint) => {
        const file = lastPathSegment(logpoint.file) || NAME_PLACEHOLDER;
        const modifiers = formatBreakpointModifiers({ condition: logpoint.condition, logMessage: logpoint.message });
        return `${file}:${logpoint.line}${modifiers} (GDB dprintf ${logpoint.number})`;
    });
}

/** The part after the last `/` or `\`. */
function lastPathSegment(fullPath: string): string {
    return fullPath.split(/[\\/]/).pop() ?? '';
}
