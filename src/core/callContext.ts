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
 * The tool call an async chain belongs to (#48). `MeasuredMcpServer` gives
 * every call an id and runs its handler inside this context; the router
 * copies the id and the MCP session id into the control envelope, and the
 * control server of the target window runs the op inside the same context.
 * Code anywhere below a handler can then ask which call it serves: the
 * problem journal stamps its records with the call id, and #49 binds a
 * serial port to the MCP session that opened it.
 *
 * Callbacks that VS Code or the debug adapter start (DAP messages, task
 * events) run outside any call; the journal falls back to timing for them.
 *
 * Pure: Node's `AsyncLocalStorage`, no vscode.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The call a piece of work runs for. */
export interface CallContext {
    /** `<first 8 characters of the MCP session id>-<n>`, as `MeasuredMcpServer` assigns it. */
    callId: string;
    /** The MCP session the call came in on. */
    sessionId?: string;
}

const calls = new AsyncLocalStorage<CallContext>();

/** Runs `work` with `context` as the current call, for everything it awaits and starts. */
export function runInCallContext<T>(context: CallContext, work: () => T): T {
    return calls.run(context, work);
}

/** The call the current async chain belongs to; undefined outside a tool call. */
export function currentCallContext(): CallContext | undefined {
    return calls.getStore();
}
