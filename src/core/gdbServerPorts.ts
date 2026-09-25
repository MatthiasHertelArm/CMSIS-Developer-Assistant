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
 * Where a CMSIS attach would connect, and whether anything listens there.
 *
 * An attach configuration of the CMSIS Debugger (`gdbtarget`, `request:
 * attach`) starts no GDB server; GDB's `target remote` connects to
 * `target.host:target.port`. When nothing listens there, GDB retries for its
 * connect timeout (15 s) and fails with "could not connect: Operation timed
 * out.", which VS Code shows as a modal dialog. Checking the port first turns
 * that into an immediate refusal with the next step.
 *
 * No `vscode`: the launch.json text comes in, sockets go out.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

/** One attach configuration's GDB server address. */
export interface AttachEndpoint {
    name: string;
    host: string;
    port: number;
}

/** How long one connection attempt may take; a local server answers at once. */
const PROBE_TIMEOUT_MS = 1_000;

/** A TCP port given as a number or as digits; anything else is none. */
function portOf(value: unknown): number | undefined {
    const port = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/**
 * The GDB server addresses of the `gdbtarget` attach configurations in a
 * launch.json text (comments and trailing commas allowed). Configurations
 * without a numeric `target.port` are left out; the host defaults to
 * localhost, as the adapter's does.
 */
export function attachEndpoints(launchJson: string): AttachEndpoint[] {
    const parsed: unknown = parseJsonc(launchJson, [], { allowTrailingComma: true });
    const configurations = (parsed as { configurations?: unknown } | undefined)?.configurations;
    if (!Array.isArray(configurations)) {
        return [];
    }
    const endpoints: AttachEndpoint[] = [];
    for (const entry of configurations) {
        const config = entry as { type?: unknown; request?: unknown; name?: unknown; target?: { host?: unknown; port?: unknown } };
        if (config?.type !== 'gdbtarget' || config.request !== 'attach') {
            continue;
        }
        const port = portOf(config.target?.port);
        if (port === undefined) {
            continue;
        }
        const host = typeof config.target?.host === 'string' && config.target.host.trim() !== '' ? config.target.host.trim() : 'localhost';
        endpoints.push({ name: typeof config.name === 'string' ? config.name : 'attach', host, port });
    }
    return endpoints;
}

/** True when a TCP connection to `host:port` opens within `timeoutMs`. Never rejects. */
export function isListening(host: string, port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((answer) => {
        const socket = net.connect({ host, port });
        const finish = (listening: boolean): void => {
            socket.removeAllListeners();
            socket.on('error', () => undefined);
            socket.destroy();
            answer(listening);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

/**
 * The attach endpoints of `folder/.vscode/launch.json` when none of them
 * accepts a connection; undefined when one does, or when there is nothing to
 * check (no launch.json, no attach configuration with a port).
 */
export async function silentAttachEndpoints(folder: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<AttachEndpoint[] | undefined> {
    let text: string;
    try {
        text = await fs.promises.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8');
    } catch {
        return undefined;
    }
    const endpoints = attachEndpoints(text);
    if (endpoints.length === 0) {
        return undefined;
    }
    const answers = await Promise.all(endpoints.map((endpoint) => isListening(endpoint.host, endpoint.port, timeoutMs)));
    return answers.some(Boolean) ? undefined : endpoints;
}
