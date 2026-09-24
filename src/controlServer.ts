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
 * The receiving end of multi-window routing. Every window runs one: a
 * loopback HTTP endpoint that runs a single named op against this window's
 * own handlers (debugging, serial, documentation and build artefacts) and
 * answers with the handler's result. The router window forwards each tool
 * call here, so the call runs in the window that owns the workspace and the
 * probe.
 *
 * Windows of different extension versions talk to each other through this
 * endpoint; its request and response shapes are a contract (POST /op, the
 * token header, `{op, args}` in, `{result}` or `{error}` out). A router that
 * sends the envelope header (see `CONTROL_ENVELOPE_HEADER`) gets the outcome
 * typed: the `ToolText` as it is, a failure as `{message, code, hint, data}`.
 * Any other router gets the 2.3.10 shapes, strings only.
 *
 * Each op runs through the window's problem journal (#48): in the call
 * context the envelope names (`callId`, `sessionId`), registered while it
 * runs, and with the problems it produced in `data.problems` when it fails
 * or its wait runs out. A typed reply also carries the journal's counters,
 * `journalSeq` and `journalErrors`, from which the router tells the agent
 * about new errors.
 *
 * The ops include flashing and erasing the target, so a request passes
 * three checks before its body is read (#19): `POST /op` (else 404); a
 * loopback `Host` and no `Origin` at all, since the router never sends one
 * and a browser always does (else 403); and the per-window token the window
 * publishes in the registry, compared in constant time (else 403). The 403
 * and 404 bodies point whoever probes the port at the MCP tools instead.
 *
 * `onOp` hears when each op starts and settles; the window's status-bar item
 * shows from it that an agent call runs here (#16).
 *
 * The internal ops (`INTERNAL_OPS`) are no tools and are answered here, before
 * the op table: `sessionEnded` (#49) releases the serial port an ended MCP
 * session held in this window. They pass neither the op hook nor the journal.
 */

import { timingSafeEqual } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { IDebuggingHandler } from './debuggingHandler';
import type { PackDocsHandlers } from './packDocsDispatch';
import { serialHandler } from './serialHandler';
import type { CallContext } from './core/callContext';
import {
    CONTROL_ENVELOPE_HEADER,
    CONTROL_ENVELOPE_VERSION,
    CONTROL_REQUEST_MAX_BYTES,
    InternalOpName,
    OpName,
    isInternalOp,
    isKnownOp,
    isPackDocsDocOp,
    isPackDocsOp,
    isSerialOp,
} from './core/opTable';
import { JournaledOutcome, runJournaled } from './core/problemFeed';
import { problemJournal, type JournalCounters, type ProblemJournal } from './core/problemJournal';
import { JsonObject, ToolError, ToolText, errorDetail, isToolReply, textOf, toToolError } from './core/toolResult';
import { closeHttpServer } from './utils/closeHttpServer';
import { logger } from './utils/logger';
import { isLoopbackHostHeader } from './utils/loopback';

/** Loopback only: nothing off this machine may reach the endpoint. */
const LOOPBACK_ONLY = '127.0.0.1';
const OP_ENDPOINT = '/op';
/** Node lower-cases incoming header names; the sender may use any case. */
const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
const JSON_REPLY: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };
/** The body of every 403 and 404: this port is not for agents, and here is what is. */
const NOT_FOR_AGENTS = {
    error: 'internal endpoint of the CMSIS Developer Assistant; agents use the MCP tools list_debug_windows and select_debug_window',
};

/** What one request asks for, once its body is parsed. */
interface OpRequest {
    op: string;
    args: unknown;
    /** The tool call the router forwarded, when it named one. */
    call?: CallContext;
}

/** Told when an op starts running in this window and when it has settled, either way (#16: the status bar). */
export type OpListener = (op: OpName, phase: 'start' | 'end') => void;

/** Longest call id and session id taken from an envelope; anything longer is not one of ours. */
const CALL_ID_MAX_CHARS = 128;
const SESSION_ID_MAX_CHARS = 256;

/** The call context an envelope names: `callId`, and `sessionId` when present. */
function callNamed(callId: unknown, sessionId: unknown): CallContext | undefined {
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > CALL_ID_MAX_CHARS) {
        return undefined;
    }
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= SESSION_ID_MAX_CHARS
        ? { callId, sessionId }
        : { callId };
}

/** The journal counters a typed reply carries; nothing for a 2.3.10 router. */
function countersBody(counters: JournalCounters, typed: boolean): object {
    return typed ? { journalSeq: counters.seq, journalErrors: counters.errors } : {};
}

/** A handler result as the text it carries, or undefined when it is none. */
function carriedText(value: unknown): string | undefined {
    return typeof value === 'string' || isToolReply(value) ? textOf(value) : undefined;
}

/** UTF-8 size of the text of a handler result for the trace line; anything else counts as 0. */
function resultBytes(value: unknown): number {
    const text = carriedText(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

/** True when the request carries the envelope header with a version this window speaks. */
function wantsTypedReply(incoming: http.IncomingMessage): boolean {
    const asked = Number.parseInt(String(incoming.headers[CONTROL_ENVELOPE_HEADER] ?? ''), 10);
    return Number.isInteger(asked) && asked >= CONTROL_ENVELOPE_VERSION;
}

/** The success body: the outcome as it is for a typed router, its text for a 2.3.10 one. */
function resultBody(result: unknown, typed: boolean): object {
    return { result: typed ? result : carriedText(result) ?? result };
}

/** The failure body: code, message, hint and data for a typed router, one string for a 2.3.10 one. */
function errorBody(failure: ToolError, typed: boolean): object {
    if (!typed) {
        return { error: errorDetail(failure) };
    }
    const error: JsonObject = { message: failure.message, code: failure.code };
    if (failure.hint !== undefined) {
        error.hint = failure.hint;
    }
    if (failure.data !== undefined) {
        error.data = failure.data;
    }
    return { error };
}

/** Milliseconds since the returned function was made. */
function stopwatch(): () => number {
    const origin = Date.now();
    return () => Date.now() - origin;
}

/**
 * The body as an op request. An empty body counts as `{}`; JSON `null`
 * fails on the property read, which ends as a 500 like any other failure.
 */
function parseOpRequest(body: string): OpRequest {
    const parsed = body.length === 0 ? {} : JSON.parse(body);
    const named: unknown = parsed.op;
    if (typeof named === 'string') {
        const call = callNamed(parsed.callId, parsed.sessionId);
        return { op: named, args: parsed.args ?? {}, ...(call ? { call } : {}) };
    }
    throw new Error('Control request has no op');
}

/** A status with no body and no content type. */
function replyBare(reply: http.ServerResponse, status: number): void {
    reply.writeHead(status).end();
}

/**
 * True when the request carries exactly the window's token. A header sent
 * twice arrives joined or as an array and never matches; bytes are compared
 * only at equal length, since `timingSafeEqual` throws otherwise.
 */
function carriesToken(presented: string | string[] | undefined, token: string): boolean {
    if (typeof presented !== 'string') {
        return false;
    }
    const given = Buffer.from(presented, 'utf8');
    const expected = Buffer.from(token, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The router's requests name 127.0.0.1 and never carry an `Origin`; a browser's always do. */
function comesFromRouter(incoming: http.IncomingMessage): boolean {
    return isLoopbackHostHeader(incoming.headers.host) && incoming.headers.origin === undefined;
}

function replyJson(reply: http.ServerResponse, status: number, payload: object, typed = false): void {
    const headers = typed ? { ...JSON_REPLY, [CONTROL_ENVELOPE_HEADER]: String(CONTROL_ENVELOPE_VERSION) } : JSON_REPLY;
    reply.writeHead(status, headers).end(JSON.stringify(payload), 'utf8');
}

export class ControlServer {
    private listener: http.Server | undefined;
    private boundPort = 0;
    private opListener: OpListener | undefined;

    /** @param journal the window's problem journal; a test gives each fake window its own. */
    constructor(
        private readonly handler: IDebuggingHandler,
        private readonly token: string,
        private readonly packDocs?: PackDocsHandlers,
        private readonly journal: ProblemJournal = problemJournal(),
    ) {}

    /** The listening port; 0 before `start()` resolved and from the moment `stop()` begins. */
    getPort(): number {
        return this.boundPort;
    }

    /** Tell `listener` about every op this window runs from now on; it replaces the one set before. */
    onOp(listener: OpListener | undefined): void {
        this.opListener = listener;
    }

    /** Hand one op event to the listener; a listener that throws is logged, never felt by the op. */
    private tell(op: OpName, phase: 'start' | 'end'): void {
        try {
            this.opListener?.(op, phase);
        } catch (failure) {
            logger.warn(`The op listener failed on ${op} ${phase}`, failure);
        }
    }

    /** Listen on an OS-chosen loopback port and resolve with it. */
    start(): Promise<number> {
        const httpServer = http.createServer((incoming, reply) => this.accept(incoming, reply));
        return new Promise<number>((resolvePort, rejectListen) => {
            httpServer.once('error', rejectListen);
            httpServer.listen(0, LOOPBACK_ONLY, () => {
                httpServer.removeListener('error', rejectListen);
                // From here on an unhandled 'error' would take the extension host down.
                httpServer.on('error', (fault) => logger.error('Control server error', fault));
                this.listener = httpServer;
                this.boundPort = (httpServer.address() as AddressInfo).port;
                logger.info(`Accepting forwarded tool calls on ${LOOPBACK_ONLY}:${this.boundPort}`);
                resolvePort(this.boundPort);
            });
        });
    }

    /**
     * Close within the grace of `closeHttpServer`: idle connections at once,
     * in-flight ones when the grace ends. Their ops are not cancelled.
     */
    stop(): Promise<void> {
        const closing = this.listener;
        this.listener = undefined;
        this.boundPort = 0;
        // Never started, or a stop already under way: nothing to wait for.
        return closing ? closeHttpServer(closing) : Promise.resolve();
    }

    private accept(incoming: http.IncomingMessage, reply: http.ServerResponse): void {
        if (incoming.method !== 'POST' || incoming.url !== OP_ENDPOINT) {
            replyJson(reply, 404, NOT_FOR_AGENTS);
            return;
        }
        if (!comesFromRouter(incoming) || !carriesToken(incoming.headers[TOKEN_HEADER], this.token)) {
            replyJson(reply, 403, NOT_FOR_AGENTS);
            return;
        }

        // Raw bytes, decoded once at the end, so a character split across two
        // chunks arrives whole.
        const received: Buffer[] = [];
        let byteCount = 0;
        let oversize = false;
        incoming.on('data', (piece: Buffer) => {
            byteCount += piece.length;
            if (oversize) {
                return;
            }
            if (byteCount > CONTROL_REQUEST_MAX_BYTES) {
                // Keep draining to the end: answering while the client is
                // still writing resets the connection before it reads the 413.
                oversize = true;
                received.length = 0;
                return;
            }
            received.push(piece);
        });
        incoming.on('error', (fault: Error) => {
            logger.warn(`Control request aborted: ${fault.message}`);
            if (!reply.headersSent) { replyBare(reply, 400); }
        });
        const typed = wantsTypedReply(incoming);
        incoming.on('end', () => this.finish(reply, oversize ? undefined : Buffer.concat(received), typed));
    }

    /** Answer a completely received request; `body` is undefined when it was over the cap. */
    private finish(reply: http.ServerResponse, body: Buffer | undefined, typed: boolean): void {
        if (body === undefined) {
            replyJson(reply, 413, { error: `control request above ${CONTROL_REQUEST_MAX_BYTES} bytes` });
            return;
        }
        this.execute(body.toString('utf8')).then(
            ({ outcome, counters }) => {
                const counted = countersBody(counters, typed);
                if (outcome instanceof ToolError) {
                    replyJson(reply, 500, { ...errorBody(outcome, typed), ...counted }, typed);
                } else {
                    replyJson(reply, 200, { ...resultBody(outcome, typed), ...counted }, typed);
                }
            },
            (failure: unknown) => {
                const counted = countersBody(this.journal.counters(), typed);
                replyJson(reply, 500, { ...errorBody(toToolError(failure), typed), ...counted }, typed);
            },
        );
    }

    /**
     * Parse the body and run its op. A request that cannot be run — no op,
     * an unknown one — rejects; the op's own failure is the outcome. Fields
     * beyond `op`, `args`, `callId` and `sessionId` are ignored.
     */
    private async execute(text: string): Promise<JournaledOutcome> {
        const request = parseOpRequest(text);
        return this.dispatch(request.op, request.args, request.call);
    }

    /** Run one op against the handler that owns it, through the journal, and trace the outcome. */
    private async dispatch(op: string, opArgs: unknown, call: CallContext | undefined): Promise<JournaledOutcome> {
        if (isInternalOp(op)) {
            return { outcome: await this.runInternal(op, opArgs), counters: this.journal.counters() };
        }
        // Before any property lookup: `constructor` or `__proto__` stop here.
        if (!isKnownOp(op)) {
            throw new ToolError('TOOL_DISABLED', `Control op ${op} refused: not a known operation`);
        }
        const owner = this.ownerOf(op);
        const entryPoint: unknown = Reflect.get(owner, op);
        if (!(entryPoint instanceof Function)) {
            throw new ToolError('TOOL_DISABLED', `Control op ${op} is not implemented in this window`);
        }
        const elapsed = stopwatch();
        this.tell(op, 'start');
        try {
            const journaled = await runJournaled(this.journal, call,
                () => (entryPoint as (args: unknown) => Promise<ToolText>).call(owner, opArgs));
            const { outcome } = journaled;
            logger.info(outcome instanceof ToolError
                ? `control op=${op} ms=${elapsed()} failed: ${outcome.message}`
                : `control op=${op} ms=${elapsed()} out=${resultBytes(outcome)} B`);
            return journaled;
        } finally {
            this.tell(op, 'end');
        }
    }

    /** An internal op, answered by this window itself; a request it cannot read is refused like a failed op. */
    private async runInternal(op: InternalOpName, opArgs: unknown): Promise<ToolText> {
        switch (op) {
            case 'sessionEnded': {
                const sessionId: unknown = (opArgs as { sessionId?: unknown } | null | undefined)?.sessionId;
                if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_CHARS) {
                    throw new ToolError('INVALID_ARGUMENT', 'sessionEnded needs the id of the MCP session that ended');
                }
                const answer = await serialHandler.sessionEnded(sessionId);
                logger.info(`control op=${op}: ${answer}`);
                return answer;
            }
        }
    }

    private ownerOf(op: string): object {
        if (isSerialOp(op)) {
            return serialHandler;
        }
        if (!isPackDocsOp(op)) {
            return this.handler;
        }
        if (this.packDocs === undefined) {
            throw new ToolError('TOOL_DISABLED',
                `Control op ${op}: the documentation and build-artefact handlers are not available in this window`);
        }
        return isPackDocsDocOp(op) ? this.packDocs.docs : this.packDocs.build;
    }
}
