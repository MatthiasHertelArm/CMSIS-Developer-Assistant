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
 * Whether an HTTP request names this machine, for the two endpoints the
 * extension listens on: the MCP endpoint and the control server of every
 * window. Both bind 127.0.0.1, so only local processes connect; these checks
 * refuse the ones that arrive through a browser. A web page whose own host
 * name resolves to 127.0.0.1 (DNS rebinding) reaches the port with that name
 * in `Host`, and a page script adds its `Origin`.
 *
 * Pure: no `vscode`, no HTTP framework.
 */

/** Host names a local client uses, as they read once any port is removed. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True for a `Host` header that names this machine, with or without a port.
 * A missing, empty or non-string header is refused.
 */
export function isLoopbackHostHeader(host: unknown): boolean {
    if (typeof host !== 'string' || host.length === 0) {
        return false;
    }
    // A bracketed IPv6 literal keeps its brackets; anything else loses a trailing :port.
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
    return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** True for an `Origin` on this machine; `null`, empty and unparsable origins are refused. */
export function isLoopbackOrigin(origin: string): boolean {
    try {
        return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
    } catch {
        return false;
    }
}
