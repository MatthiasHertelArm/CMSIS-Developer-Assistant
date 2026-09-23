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
 * Programmatic serial port controller — own a connection independent of the
 * Serial Monitor UI extension. Buffers RX data so an MCP client can poll/read
 * it on demand. Use this when the user is NOT running an MS Serial Monitor
 * session for the same port (the OS only allows one reader per tty in the
 * default mode).
 *
 * The state follows the port, not only `close()`: when the port closes by
 * itself (the adapter was unplugged) or fails after it closed, the controller
 * forgets it, keeps the received bytes readable, and remembers why as
 * `lastRelease`, which the serial tools name (#49). Tests build their own
 * controller over serialport's `SerialPortMock` and a fixed clock; the
 * extension uses the `serialController` singleton.
 *
 * A port that cannot be opened, and one that goes away by itself, are
 * journaled as warnings in the window's problem journal (#48, source
 * `serial`), without any payload.
 */

import { SerialPort } from 'serialport';
import { logger } from '../utils/logger';
import { problemJournal, type ProblemInput } from './problemJournal';

export interface SerialOpenOptions {
    path: string;
    baudRate?: number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits?: 1 | 1.5 | 2;
    rtscts?: boolean;
}

export interface SerialPortInfo {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    productId?: string;
    vendorId?: string;
}

/** Why the owned port closed without `serial_close`: unplugged, or closed or failed on its own. */
export interface SerialRelease {
    path: string;
    at: Date;
    reason: 'disconnected' | 'closed-unexpectedly';
    /** The port's error message, when it gave one. */
    detail?: string;
}

export interface SerialStatus {
    open: boolean;
    path: string | null;
    baudRate: number | null;
    bufferedBytes: number;
    openedAt: string | null;
    /** Kept from the port's own close until the next successful open. */
    lastRelease: SerialRelease | null;
}

/** What the controller hands the port factory: the `serialport` options, never opened on construction. */
export interface PortOptions {
    path: string;
    baudRate: number;
    dataBits: 5 | 6 | 7 | 8;
    parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
    stopBits: 1 | 1.5 | 2;
    rtscts: boolean;
    autoOpen: false;
}

/** The part of a port the controller uses; serialport's `SerialPort` and `SerialPortMock` both fit. */
export interface OwnedPort {
    readonly isOpen: boolean;
    open(callback: (err: Error | null) => void): void;
    close(callback: (err: Error | null) => void): void;
    write(data: Buffer, callback: (err: Error | null | undefined) => void): boolean;
    drain(callback: (err: Error | null) => void): void;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
    on(event: 'close', listener: (err?: Error | null) => void): unknown;
}

/** Where ports, timestamps and problem records go and come from; each defaults to the real thing. */
export interface SerialControllerDeps {
    createPort?: (options: PortOptions) => OwnedPort;
    clock?: () => Date;
    /** Records a problem of the port; the window's problem journal by default. */
    journal?: (problem: ProblemInput) => void;
}

const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/** serialport 13 closes an unplugged port with a `DisconnectedError`, marked `disconnected: true`. */
function isDisconnect(err: Error | null | undefined): boolean {
    return (err as { disconnected?: unknown } | null | undefined)?.disconnected === true;
}

/** `10:42:07`: local wall-clock time, as the user reads it next to the board. */
function clockTime(at: Date): string {
    return at.toTimeString().slice(0, 8);
}

/** `COM7 disconnected at 10:42:07`, or `COM7 closed unexpectedly at 10:42:07 (reason)`. */
export function describeRelease(release: SerialRelease): string {
    if (release.reason === 'disconnected') {
        return `${release.path} disconnected at ${clockTime(release.at)}`;
    }
    const why = release.detail ? ` (${release.detail})` : '';
    return `${release.path} closed unexpectedly at ${clockTime(release.at)}${why}`;
}

export class SerialController {
    private port: OwnedPort | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private openedAt: Date | null = null;
    private currentPath: string | null = null;
    private currentBaud: number | null = null;
    private lastRelease: SerialRelease | null = null;
    private readonly createPort: (options: PortOptions) => OwnedPort;
    private readonly clock: () => Date;
    private readonly journal: (problem: ProblemInput) => void;

    constructor(deps: SerialControllerDeps = {}) {
        this.createPort = deps.createPort ?? ((options) => new SerialPort(options));
        this.clock = deps.clock ?? (() => new Date());
        this.journal = deps.journal ?? ((problem) => { problemJournal().append(problem); });
    }

    async listPorts(): Promise<SerialPortInfo[]> {
        const ports = await SerialPort.list();
        return ports.map(p => ({
            path: p.path,
            manufacturer: p.manufacturer,
            serialNumber: p.serialNumber,
            pnpId: p.pnpId,
            locationId: p.locationId,
            productId: p.productId,
            vendorId: p.vendorId,
        }));
    }

    isOpen(): boolean {
        return this.port !== null && this.port.isOpen;
    }

    status(): SerialStatus {
        return {
            open: this.isOpen(),
            path: this.currentPath,
            baudRate: this.currentBaud,
            bufferedBytes: this.buffer.length,
            openedAt: this.openedAt ? this.openedAt.toISOString() : null,
            lastRelease: this.lastRelease,
        };
    }

    async open(opts: SerialOpenOptions): Promise<void> {
        if (this.isOpen()) {
            throw new Error(
                `A serial port is already open on '${this.currentPath}'. Close it first with serial_close.`
            );
        }
        const baudRate = opts.baudRate ?? 115200;
        const dataBits = opts.dataBits ?? 8;
        const parity = opts.parity ?? 'none';
        const stopBits = opts.stopBits ?? 1;
        const rtscts = opts.rtscts ?? false;

        try {
            await new Promise<void>((resolve, reject) => {
                const p = this.createPort({
                    path: opts.path, baudRate, dataBits, parity, stopBits, rtscts,
                    autoOpen: false,
                });

                p.on('data', (chunk: Buffer) => this.appendToBuffer(chunk));
                p.on('error', (err) => this.onPortError(p, err));
                p.on('close', (err) => this.onPortClosed(p, opts.path, err));

                p.open((err) => {
                    if (err) { reject(err); return; }
                    this.port = p;
                    this.openedAt = this.clock();
                    this.currentPath = opts.path;
                    this.currentBaud = baudRate;
                    this.buffer = Buffer.alloc(0);
                    this.lastRelease = null;
                    resolve();
                });
            });
        } catch (err) {
            // The tool reports the failure itself; the record is for whoever reads the journal later.
            this.recordProblem(opts.path, err instanceof Error ? err.message : String(err),
                'serial_list_ports lists the ports; if another program holds this one, close it or use serial_subscribe_monitor.');
            throw err;
        }
    }

    async close(): Promise<void> {
        if (!this.port) { return; }
        const p = this.port;
        // Forgotten before the close, not after: the port's own 'close' event,
        // which comes first, then finds nothing to release. Also when closing
        // fails (the adapter was unplugged): otherwise every later open()
        // refuses with "already open" and the only way out is a window reload.
        this.forgetPort();
        await new Promise<void>((resolve, reject) => {
            p.close((err) => err ? reject(err) : resolve());
        });
    }

    async write(data: string | Buffer, encoding: 'utf8' | 'hex' = 'utf8'): Promise<number> {
        // Held for the whole call: an unplug in between releases `this.port`, not this write's port.
        const port = this.port;
        if (!port || !port.isOpen) {
            throw new Error(this.lastRelease
                ? `No serial port open: ${describeRelease(this.lastRelease)}. Reopen it with serial_open.`
                : 'No serial port open. Call serial_open first.');
        }
        const buf = Buffer.isBuffer(data) ? data
            : (encoding === 'hex' ? Buffer.from(data.replace(/\s+/g, ''), 'hex') : Buffer.from(data, 'utf8'));
        await new Promise<void>((resolve, reject) => {
            port.write(buf, (err) => err ? reject(err) : resolve());
        });
        await new Promise<void>((resolve, reject) => {
            port.drain((err) => err ? reject(err) : resolve());
        });
        return buf.length;
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

    private forgetPort(): void {
        this.port = null;
        this.openedAt = null;
        this.currentPath = null;
        this.currentBaud = null;
    }

    /**
     * The port closed without `close()`: unplugged (a `DisconnectedError`),
     * or closed by the driver. A late event of a port already replaced or
     * closed on purpose changes nothing.
     */
    private onPortClosed(p: OwnedPort, path: string, err: Error | null | undefined): void {
        logger.info(`Serial port '${path}' closed${err ? `: ${err.message}` : ''}`);
        if (this.port !== p) {
            return;
        }
        this.release(path, isDisconnect(err) ? 'disconnected' : 'closed-unexpectedly', err?.message);
    }

    /** An error while the port is open is only logged; one that leaves it closed releases it like a close. */
    private onPortError(p: OwnedPort, err: Error): void {
        logger.warn(`Serial port error: ${err.message}`);
        if (this.port !== p || p.isOpen) {
            return;
        }
        this.release(this.currentPath ?? '?', isDisconnect(err) ? 'disconnected' : 'closed-unexpectedly', err.message);
    }

    /** Forget the port and remember why; the received bytes stay readable. */
    private release(path: string, reason: SerialRelease['reason'], detail: string | undefined): void {
        this.forgetPort();
        this.lastRelease = { path, at: this.clock(), reason, ...(detail && reason !== 'disconnected' ? { detail } : {}) };
        logger.warn(`Serial port released: ${describeRelease(this.lastRelease)}`);
        this.recordProblem(path, describeRelease(this.lastRelease), 'Reopen it with serial_open once the adapter is back; the bytes received before stay readable.');
    }

    /** A warning of the port in the problem journal; a failing journal never fails the port. */
    private recordProblem(path: string, message: string, hint: string): void {
        try {
            this.journal({ source: 'serial', origin: path, severity: 'warning', message, hint });
        } catch (caught) {
            logger.debug('A serial problem could not be journaled', caught);
        }
    }

    private appendToBuffer(chunk: Buffer): void {
        const combined = Buffer.concat([this.buffer, chunk]);
        if (combined.length > MAX_BUFFER_BYTES) {
            this.buffer = combined.subarray(combined.length - MAX_BUFFER_BYTES);
            logger.warn(`Serial RX buffer hit ${MAX_BUFFER_BYTES} byte cap — dropped oldest data`);
        } else {
            this.buffer = combined;
        }
    }
}

export const serialController = new SerialController();
