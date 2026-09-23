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
 * token header, `{op, args}` in, `{result}` or `{error}` out).
 *
 * The only gate is the per-window token the window publishes in the
 * registry, and the ops include flashing and erasing the target.
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import type { IDebuggingHandler } from './debuggingHandler';
import type { PackDocsHandlers } from './packDocsDispatch';
import { serialHandler } from './serialHandler';
import {
    CONTROL_REQUEST_MAX_BYTES,
    isKnownOp,
    isPackDocsDocOp,
    isPackDocsOp,
    isSerialOp,
} from './core/opTable';
import { closeHttpServer } from './utils/closeHttpServer';
import { logger } from './utils/logger';

/** Loopback only: nothing off this machine may reach the endpoint. */
const LOOPBACK_ONLY = '127.0.0.1';
const OP_ENDPOINT = '/op';
/** Node lower-cases incoming header names; the sender may use any case. */
const TOKEN_HEADER = 'x-cmsis-developer-assistant-token';
const JSON_REPLY: http.OutgoingHttpHeaders = { 'Content-Type': 'application/json' };

/** What one request asks for, once its body is parsed. */
interface OpRequest {
    op: string;
    args: unknown;
}

/** The text of whatever was thrown: an Error's message, else its string form. */
function describeFailure(thrown: unknown): string {
    return thrown instanceof Error ? thrown.message : String(thrown);
}

/** UTF-8 size of a handler result for the trace line; nothing counts as 0. */
function resultBytes(value: unknown): number {
    return value === undefined || value === null ? 0 : Buffer.byteLength(String(value), 'utf8');
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
        return { op: named, args: parsed.args ?? {} };
    }
    throw new Error('Control request has no op');
}

/** A status with no body and no content type. */
function replyBare(reply: http.ServerResponse, status: number): void {
    reply.writeHead(status).end();
}

function replyJson(reply: http.ServerResponse, status: number, payload: object): void {
    reply.writeHead(status, JSON_REPLY).end(JSON.stringify(payload), 'utf8');
}

export class ControlServer {
    private listener: http.Server | undefined;
    private boundPort = 0;

    constructor(
        private readonly handler: IDebuggingHandler,
        private readonly token: string,
        private readonly packDocs?: PackDocsHandlers,
    ) {}

    /** The listening port; 0 before `start()` resolved and from the moment `stop()` begins. */
    getPort(): number {
        return this.boundPort;
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
            replyBare(reply, 404);
            return;
        }
        // Plain equality; a repeated header arrives joined and so never matches.
        if (incoming.headers[TOKEN_HEADER] !== this.token) {
            replyBare(reply, 403);
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
        incoming.on('end', () => this.finish(reply, oversize ? undefined : Buffer.concat(received)));
    }

    /** Answer a completely received request; `body` is undefined when it was over the cap. */
    private finish(reply: http.ServerResponse, body: Buffer | undefined): void {
        if (body === undefined) {
            replyJson(reply, 413, { error: `control request above ${CONTROL_REQUEST_MAX_BYTES} bytes` });
            return;
        }
        this.execute(body.toString('utf8')).then(
            (result) => replyJson(reply, 200, { result }),
            (failure: unknown) => replyJson(reply, 500, { error: describeFailure(failure) }),
        );
    }

    /** Parse the body and run its op; every failure, parsing included, is a rejection. */
    private async execute(text: string): Promise<unknown> {
        const request = parseOpRequest(text);
        return this.dispatch(request.op, request.args);
    }

    /** Run one op against the handler that owns it, and trace the outcome. */
    private async dispatch(op: string, opArgs: unknown): Promise<unknown> {
        // Before any property lookup: `constructor` or `__proto__` stop here.
        if (!isKnownOp(op)) {
            throw new Error(`Control op ${op} refused: not a known operation`);
        }
        const owner = this.ownerOf(op);
        const entryPoint: unknown = Reflect.get(owner, op);
        if (!(entryPoint instanceof Function)) {
            throw new Error(`Control op ${op} is not implemented in this window`);
        }
        const elapsed = stopwatch();
        try {
            const outcome: unknown = await entryPoint.call(owner, opArgs);
            logger.info(`control op=${op} ms=${elapsed()} out=${resultBytes(outcome)} B`);
            return outcome;
        } catch (failure) {
            logger.info(`control op=${op} ms=${elapsed()} failed: ${describeFailure(failure)}`);
            throw failure;
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
            throw new Error(`Control op ${op}: the documentation and build-artefact handlers are not available in this window`);
        }
        return isPackDocsDocOp(op) ? this.packDocs.docs : this.packDocs.build;
    }
}
