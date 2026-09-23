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
 * The debugging handler the router window gives each MCP session. It runs
 * nothing itself: every call goes over HTTP to the control server of the
 * window that owns the target, so one MCP URL reaches whichever window holds
 * the board, and two sessions can drive two boards at once.
 *
 * The target comes from a fixed ladder — path hint, pin, the session's
 * established target, the sole window with a debug session, the sole window —
 * and a tie is refused with a listing, never guessed. The two routing tools,
 * `list_debug_windows` and `select_debug_window`, are answered here.
 */

import * as http from 'http';
import type { IDebuggingHandler } from './debuggingHandler';
import {
    CONTROL_RESPONSE_MAX_BYTES,
    DEBUG_OPS,
    DebugOpName,
    forwardTimeoutMs,
    pathHintOf,
} from './core/opTable';
import {
    describeWindow,
    ResolutionReason,
    WindowRegistration,
    WorkspaceRegistry,
} from './utils/workspaceRegistry';
import { logger } from './utils/logger';

/** Must match the header the control server checks. */
const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
/** How much of an unparsable reply the error quotes. */
const MALFORMED_PREVIEW_CHARS = 200;

const NO_WINDOW_ERROR =
    'No CMSIS Developer Assistant-enabled VS Code window is currently registered. '
    + 'Open your project in VS Code and wait for the extension to activate.';
const NO_WINDOW_LISTING = 'No CMSIS Developer Assistant-enabled VS Code windows are currently registered.';
const SELECT_NEEDS_ARGUMENT = 'Pass either pid or workspaceFolder. Call list_debug_windows to see the options.';
const LISTING_FOOTER = 'Pin one for this session with select_debug_window({ pid }) when the automatic choice is wrong.';

/** One method per debugging op; the class gets them from the op table below. */
type DebugForwarders = { [Op in DebugOpName]: (args?: unknown) => Promise<string> };

interface Resolved {
    entry: WindowRegistration;
    reason: ResolutionReason;
}

function textOf(thrown: unknown): string {
    return thrown instanceof Error ? thrown.message : String(thrown);
}

/** The indented window list inside routing errors and the selection miss. */
function bulletList(windows: WindowRegistration[]): string {
    return windows.map((w) => `  • ${describeWindow(w)}`).join('\n');
}

/** Declaration merge: the class instance carries one forwarder per `DEBUG_OPS` name. */
export interface RoutingDebuggingHandler extends DebugForwarders {}

export class RoutingDebuggingHandler implements IDebuggingHandler {
    static {
        // Generated from the op table rather than written out: a tool added to
        // IDebuggingHandler must be added to DEBUG_OPS (opTable checks that),
        // and it is then routable here with no further change.
        for (const op of DEBUG_OPS) {
            Object.defineProperty(RoutingDebuggingHandler.prototype, op, {
                configurable: true,
                writable: true,
                value(this: RoutingDebuggingHandler, args?: unknown): Promise<string> {
                    return this.relay(op, args);
                },
            });
        }
    }

    /** The window this session last reached; reused while it stays registered on the same port. */
    private target: WindowRegistration | undefined;
    /** Set by `select_debug_window`; only a later selection replaces it. */
    private pinnedPid: number | undefined;

    constructor(
        private readonly registry: WorkspaceRegistry,
        private readonly defaultToolMs: number,
    ) {}

    serialOp(op: string, args?: unknown): Promise<string> {
        return this.relay(op, args);
    }

    packDocsOp(op: string, args?: unknown): Promise<string> {
        return this.relay(op, args);
    }

    /** The `list_debug_windows` text. Changes nothing. */
    listDebugWindows(): string {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return NO_WINDOW_LISTING;
        }
        const rows = windows.map((w) => `• ${describeWindow(w)}${this.markers(w)}`);
        return `Registered VS Code windows:\n${rows.join('\n')}\n\n${LISTING_FOOTER}`;
    }

    /** The `select_debug_window` text; on a match the window is pinned for this session. */
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string {
        const { pid, workspaceFolder } = args;
        if (pid === undefined && !workspaceFolder) {
            return SELECT_NEEDS_ARGUMENT;
        }
        const chosen = pid !== undefined
            ? this.registry.findByPid(pid)
            : this.registry.findByWorkspaceFolder(workspaceFolder as string);
        if (!chosen) {
            const wanted = pid !== undefined ? `pid=${pid}` : `"${workspaceFolder}"`;
            const windows = this.registry.list();
            const known = windows.length > 0
                ? `Currently registered:\n${bulletList(windows)}`
                : 'No windows are registered.';
            return `No registered window matches ${wanted}.\n${known}`;
        }
        this.pinnedPid = chosen.pid;
        this.target = chosen;
        return `This session is now pinned to: ${describeWindow(chosen)}\n`
            + 'Every subsequent tool call runs in that window until you pin another.';
    }

    /** ` ← current target, pinned` (whichever apply) for a listing row. */
    private markers(w: WindowRegistration): string {
        const marks: string[] = [];
        if (this.target !== undefined && this.target.pid === w.pid) {
            marks.push('current target');
        }
        if (this.pinnedPid === w.pid) {
            marks.push('pinned');
        }
        return marks.length > 0 ? `  ← ${marks.join(', ')}` : '';
    }

    /** One forwarded call: pick the window, send, and wrap any failure. */
    private async relay(op: string, args: unknown): Promise<string> {
        const sent = args === undefined ? {} : args;
        const { entry, reason } = this.resolveTarget(pathHintOf(sent));
        logger.info(`Routing ${op} → pid=${entry.pid} port=${entry.controlPort} (via ${reason})`);
        try {
            // The worker's result goes back as it is, without a type check.
            return (await this.post(entry, op, sent)) as string;
        } catch (failure) {
            if (this.target !== undefined && this.target.pid === entry.pid) {
                this.target = undefined;
            }
            throw new Error(
                `Could not reach the VS Code window handling this session (pid=${entry.pid}): ${textOf(failure)}\n`
                + 'It may have been closed. Call list_debug_windows to see what is still open.');
        }
    }

    /** The resolution ladder; the first rung that applies decides, and a miss throws. */
    private resolveTarget(hint: string | undefined): Resolved {
        if (hint !== undefined) {
            // A named file must never run in another window, cached or pinned.
            const owner = this.registry.findByPath(hint);
            if (!owner) {
                throw new Error(this.unroutable(hint));
            }
            this.target = owner;
            return { entry: owner, reason: 'path' };
        }
        if (this.pinnedPid !== undefined) {
            const pinned = this.registry.findByPid(this.pinnedPid);
            if (!pinned) {
                throw new Error(
                    `The window pinned with select_debug_window (pid=${this.pinnedPid}) is gone. `
                    + 'Pin another with select_debug_window, or call list_debug_windows to see what is open.');
            }
            this.target = pinned;
            return { entry: pinned, reason: 'pinned' };
        }
        if (this.target !== undefined && this.registry.isLive(this.target)) {
            return { entry: this.target, reason: 'cached' };
        }
        this.target = undefined;
        const debugging = this.registry.findSoleActiveSession();
        if (debugging) {
            this.target = debugging;
            return { entry: debugging, reason: 'active-session' };
        }
        const only = this.registry.findSoleWindow();
        if (only) {
            this.target = only;
            return { entry: only, reason: 'only-window' };
        }
        throw new Error(this.unroutable(undefined));
    }

    /** Why no window could take the call, from a fresh look at the registry. */
    private unroutable(hint: string | undefined): string {
        const windows = this.registry.list();
        if (windows.length === 0) {
            return NO_WINDOW_ERROR;
        }
        const listing = bulletList(windows);
        if (hint !== undefined) {
            return `No open VS Code window has "${hint}" inside its workspace.\n`
                + `Open the folder containing it, or pass a path that is inside one of these:\n${listing}`;
        }
        const debugging = windows.filter((w) => w.hasActiveSession).length;
        if (debugging > 1) {
            return `${debugging} VS Code windows have an active debug session, so there is no unambiguous target for this call.\n`
                + `Pick one with select_debug_window:\n${listing}`;
        }
        return `${windows.length} VS Code windows are registered and none has an active debug session, `
            + 'so there is no unambiguous target for this call.\n'
            + `Start a session (cmsis_action load_and_debug), or pick a window with select_debug_window:\n${listing}`;
    }

    /** POST `{op, args}` to the window's control server; resolve with its `result`. */
    private post(entry: WindowRegistration, op: string, args: unknown): Promise<unknown> {
        const body = Buffer.from(JSON.stringify({ op, args }), 'utf8');
        const idleLimitMs = forwardTimeoutMs(op, args, this.defaultToolMs);
        return new Promise<unknown>((resolve, reject) => {
            const outgoing = http.request({
                host: '127.0.0.1',
                port: entry.controlPort,
                path: '/op',
                method: 'POST',
                // Socket inactivity, not a wall-clock deadline.
                timeout: idleLimitMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    [TOKEN_HEADER]: entry.controlToken,
                },
            }, (incoming) => {
                const parts: Buffer[] = [];
                let size = 0;
                let refused = false;
                incoming.on('data', (chunk: Buffer) => {
                    if (refused) {
                        return;
                    }
                    size += chunk.length;
                    if (size > CONTROL_RESPONSE_MAX_BYTES) {
                        refused = true;
                        parts.length = 0;
                        outgoing.destroy(new Error(
                            `control response above ${CONTROL_RESPONSE_MAX_BYTES} bytes from pid ${entry.pid}`));
                        return;
                    }
                    parts.push(chunk);
                });
                incoming.on('error', reject);
                incoming.on('end', () => {
                    if (!refused) {
                        settleReply(incoming.statusCode, Buffer.concat(parts).toString('utf8'), resolve, reject);
                    }
                });
            });
            outgoing.on('timeout', () => {
                outgoing.destroy(new Error(
                    `no response within ${Math.round(idleLimitMs / 1000)}s — the target window may be busy or wedged`));
            });
            outgoing.on('error', reject);
            outgoing.end(body);
        });
    }
}

/** Turn a complete control-server reply into the call's outcome. */
function settleReply(
    status: number | undefined,
    body: string,
    resolve: (value: unknown) => void,
    reject: (reason: Error) => void,
): void {
    let reply: { result?: unknown; error?: unknown } | null;
    try {
        reply = body.length === 0 ? {} : JSON.parse(body);
    } catch {
        reply = null;
    }
    if (reply === null) {
        reject(new Error(`malformed control response: ${body.slice(0, MALFORMED_PREVIEW_CHARS)}`));
        return;
    }
    if (status === 200 && reply.result !== undefined) {
        resolve(reply.result);
        return;
    }
    const reported = reply.error;
    reject(new Error(reported !== undefined && reported !== null
        ? String(reported)
        : `control server returned ${status}`));
}
