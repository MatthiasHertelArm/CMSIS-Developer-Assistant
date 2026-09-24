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
 * Bridge to the Microsoft Serial Monitor extension
 * (`ms-vscode.vscode-serial-monitor`).
 *
 * The extension publishes a typed API package
 * (`@microsoft/vscode-serial-monitor-api`) that VS Code returns from
 * `extensions.getExtension(...).exports`. The current public surface
 * (v0.1.7) is centred on **port enumeration** and **port-set change
 * notifications** — RX byte streaming is captured internally and forwarded
 * to the webview, but is NOT (yet) exposed publicly.
 *
 * This bridge probes the exports object at runtime so:
 *
 *   - We use whatever the API offers today (port list, port-changed events).
 *   - If Microsoft adds a data-subscription event in a later release
 *     (`onDidReceiveData`, `onSerialData`, `subscribeData`, …) we light up
 *     automatically — no extra build required.
 *
 * The bridge buffers received bytes the same way the standalone
 * `serialController` does, so `serial_read` (with `from: 'monitor'`) can
 * consume them uniformly regardless of which backend produced them.
 *
 * A subscription follows the release rules of an owned port (#49,
 * src/core/serialLease.ts): it ends after `serial.idleCloseSeconds` without
 * a serial call and when the MCP session that subscribed ends, and then
 * drops its buffer. Each such end is journaled as info (source `serial`).
 * Tests hand in the extension lookup and the timers.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { problemJournal, type ProblemInput } from './problemJournal';
import { LeaseTimers, REAL_TIMERS, RuleRelease, SerialLease } from './serialLease';

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

export interface BridgePort {
    portName: string;
    friendlyName?: string;
    vid?: string;
    pid?: string;
}

export interface BridgeStatus {
    extensionInstalled: boolean;
    extensionId: string;
    activated: boolean;
    apiKeysDiscovered: string[];
    dataSubscriptionAvailable: boolean;
    subscribed: boolean;
    bufferedBytes: number;
}

/** The Serial Monitor extension as the bridge sees it: the part of `vscode.Extension` it uses. */
export interface BridgeExtension {
    readonly isActive: boolean;
    readonly exports: unknown;
    activate(): Thenable<unknown>;
}

/** Where the bridge finds the extension, its timers and its problem journal; each defaults to the real thing. */
export interface SerialMonitorBridgeDeps {
    lookup?: (id: string) => BridgeExtension | undefined;
    timers?: LeaseTimers;
    journal?: (problem: ProblemInput) => void;
}

/** Who subscribes and how long a subscription may sit idle (#49). */
export interface SubscribeTerms {
    /** The MCP session that subscribes. */
    owner?: string;
    /** The idle limit, 0 for none. */
    idleSeconds?: number;
}

/** The origin of the bridge's problem records. */
const BRIDGE_ORIGIN = 'Serial Monitor';

export class SerialMonitorBridge {
    private extId = 'ms-vscode.vscode-serial-monitor';
    private api: any = null;
    private subscription: vscode.Disposable | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private dataEventName: string | null = null;
    private lease: SerialLease | undefined;
    private readonly lookup: (id: string) => BridgeExtension | undefined;
    private readonly timers: LeaseTimers;
    private readonly journal: (problem: ProblemInput) => void;

    constructor(deps: SerialMonitorBridgeDeps = {}) {
        this.lookup = deps.lookup ?? ((id) => vscode.extensions.getExtension(id));
        this.timers = deps.timers ?? REAL_TIMERS;
        this.journal = deps.journal ?? ((problem) => { problemJournal().append(problem); });
    }

    /** Lazily activates the Microsoft Serial Monitor and grabs its exports. */
    private async getApi(): Promise<any> {
        if (this.api) { return this.api; }
        const ext = this.lookup(this.extId);
        if (!ext) { return null; }
        if (!ext.isActive) {
            try { await ext.activate(); }
            catch (err) {
                logger.warn(`Serial Monitor activation failed: ${err}`);
                return null;
            }
        }
        this.api = ext.exports ?? null;
        return this.api;
    }

    /**
     * Probe the API object for any plausible data-subscription event. If the
     * MS extension exposes one in this build we wire it up; otherwise the
     * bridge cleanly reports "data subscription not available".
     */
    private findDataEvent(api: any): string | null {
        if (!api || typeof api !== 'object') { return null; }
        const candidates = [
            'onDidReceiveData', 'onDataReceived', 'onData',
            'onSerialData', 'onDidReadData', 'subscribeData',
        ];
        for (const name of candidates) {
            if (typeof api[name] === 'function') { return name; }
        }
        return null;
    }

    async status(): Promise<BridgeStatus> {
        const ext = this.lookup(this.extId);
        const installed = !!ext;
        const activated = !!ext?.isActive;
        let keys: string[] = [];
        let dataAvailable = false;
        if (activated) {
            const api = await this.getApi();
            if (api && typeof api === 'object') {
                keys = Object.keys(api).slice(0, 30);
            }
            this.dataEventName = this.findDataEvent(api);
            dataAvailable = this.dataEventName !== null;
        }
        return {
            extensionInstalled: installed,
            extensionId: this.extId,
            activated,
            apiKeysDiscovered: keys,
            dataSubscriptionAvailable: dataAvailable,
            subscribed: this.subscription !== null,
            bufferedBytes: this.buffer.length,
        };
    }

    /**
     * Best-effort port enumeration via the public API. Returns null when the
     * extension isn't installed or the API doesn't expose listing.
     */
    async listPorts(): Promise<BridgePort[] | null> {
        const api = await this.getApi();
        if (!api) { return null; }
        // Typical names in v0.1.x
        const fns = ['getAvailableSerialPorts', 'listPorts', 'getPorts', 'getSerialPorts'];
        for (const name of fns) {
            const fn = api[name];
            if (typeof fn === 'function') {
                try {
                    const ports = await fn.call(api);
                    return Array.isArray(ports) ? ports : [];
                } catch (err) {
                    logger.warn(`Serial Monitor.${name} threw: ${err}`);
                }
            }
        }
        return null;
    }

    /**
     * Subscribe to the Serial Monitor's data event when its API has one. The
     * subscription is held for `terms.owner` and ends after `terms.idleSeconds`
     * without a serial call (#49); a repeated call keeps the one that exists.
     */
    async subscribeIfAvailable(terms: SubscribeTerms = {}): Promise<{ ok: true; eventName: string } | { ok: false; reason: string }> {
        if (this.subscription) {
            this.touch();
            return { ok: true, eventName: this.dataEventName ?? '<active>' };
        }
        const api = await this.getApi();
        if (!api) {
            return { ok: false, reason: `Extension '${this.extId}' is not installed or failed to activate.` };
        }
        const eventName = this.findDataEvent(api);
        if (!eventName) {
            return {
                ok: false,
                reason: `The installed Microsoft Serial Monitor build does not expose a public data-subscription event ` +
                    `(probed: onDidReceiveData / onDataReceived / onData / onSerialData / onDidReadData / subscribeData). ` +
                    `Use serial_open and serial_read to own the port instead, or update the Serial Monitor ` +
                    `extension when MS adds the API.`,
            };
        }
        try {
            const event = api[eventName] as (cb: (arg: any) => void) => vscode.Disposable;
            this.subscription = event.call(api, (evt: any) => this.onData(evt));
            this.dataEventName = eventName;
            this.lease = new SerialLease({ owner: terms.owner, rule: 'idle', idleSeconds: terms.idleSeconds ?? 0 }, this.timers,
                () => { this.endByRule('idle'); });
            return { ok: true, eventName };
        } catch (err) {
            return { ok: false, reason: `Subscribing via ${eventName} threw: ${err}` };
        }
    }

    unsubscribe(): boolean {
        this.lease?.end();
        this.lease = undefined;
        if (!this.subscription) { return false; }
        try { this.subscription.dispose(); } catch { /* ignore */ }
        this.subscription = null;
        return true;
    }

    /** A serial call used the subscription now: its idle time starts again (#49). */
    touch(): void {
        this.lease?.touch();
    }

    /** The MCP session `sessionId` ended: end the subscription it made, dropping the buffer. True when it did. */
    sessionEnded(sessionId: string): boolean {
        return this.lease?.endsWithSession(sessionId) === true && this.endByRule('owner-gone');
    }

    /** A rule ends the subscription: unsubscribe and drop the buffer, then log and journal why. */
    private endByRule(reason: Extract<RuleRelease, 'idle' | 'owner-gone'>): boolean {
        const idleSeconds = this.lease ? this.lease.idleMs / 1000 : 0;
        if (!this.unsubscribe()) {
            return false;
        }
        const dropped = this.clearBuffer();
        const message = reason === 'idle'
            ? `Serial Monitor subscription ended after ${idleSeconds} s without a serial call`
            : 'Serial Monitor subscription ended: the MCP session that subscribed ended';
        logger.info(`${message}; ${dropped} buffered byte(s) dropped`);
        try {
            this.journal({ source: 'serial', origin: BRIDGE_ORIGIN, severity: 'info', message, hint: 'Subscribe again with serial_subscribe_monitor.' });
        } catch (caught) {
            logger.debug('The end of the Serial Monitor subscription could not be journaled', caught);
        }
        return true;
    }

    /**
     * Normalise whatever payload shape the API event hands us. Likely shapes
     * (defensive): Buffer, Uint8Array, string, { data: ... }, { buffer: ... }.
     */
    private onData(evt: any): void {
        const chunk = this.coerceToBuffer(evt);
        if (!chunk || chunk.length === 0) { return; }
        const combined = Buffer.concat([this.buffer, chunk]);
        if (combined.length > MAX_BUFFER_BYTES) {
            this.buffer = combined.subarray(combined.length - MAX_BUFFER_BYTES);
            logger.debug(`Serial Monitor bridge buffer hit ${MAX_BUFFER_BYTES} byte cap`);
        } else {
            this.buffer = combined;
        }
    }

    private coerceToBuffer(evt: any): Buffer | null {
        // eslint-disable-next-line eqeqeq -- intentionally match null and undefined.
        if (evt == null) { return null; }
        if (Buffer.isBuffer(evt)) { return evt; }
        if (evt instanceof Uint8Array) { return Buffer.from(evt); }
        if (typeof evt === 'string') { return Buffer.from(evt, 'utf8'); }
        if (typeof evt === 'object') {
            if (Buffer.isBuffer(evt.data)) { return evt.data; }
            if (evt.data instanceof Uint8Array) { return Buffer.from(evt.data); }
            if (typeof evt.data === 'string') { return Buffer.from(evt.data, 'utf8'); }
            if (Buffer.isBuffer(evt.buffer)) { return evt.buffer; }
            if (Array.isArray(evt.buffer)) { return Buffer.from(evt.buffer); }
            if (typeof evt.asString === 'string') { return Buffer.from(evt.asString, 'utf8'); }
        }
        return null;
    }

    async read(opts: { maxBytes?: number; waitMs?: number; consume?: boolean } = {}): Promise<Buffer> {
        const maxBytes = opts.maxBytes ?? MAX_BUFFER_BYTES;
        const waitMs = opts.waitMs ?? 0;
        const consume = opts.consume !== false;
        if (this.buffer.length === 0 && waitMs > 0) {
            await new Promise<void>((resolve) => {
                const start = Date.now();
                const tick = () => {
                    if (this.buffer.length > 0 || Date.now() - start >= waitMs) { resolve(); }
                    else { setTimeout(tick, 25); }
                };
                tick();
            });
        }
        const slice = this.buffer.subarray(0, Math.min(maxBytes, this.buffer.length));
        const out = Buffer.from(slice);
        if (consume) { this.buffer = this.buffer.subarray(out.length); }
        return out;
    }

    clearBuffer(): number {
        const n = this.buffer.length;
        this.buffer = Buffer.alloc(0);
        return n;
    }
}

/** The window's bridge. */
export const serialMonitorBridge = new SerialMonitorBridge();
