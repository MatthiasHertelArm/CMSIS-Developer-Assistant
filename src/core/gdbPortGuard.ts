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
 * Before a launch starts a GDB server on a local port: is that port taken?
 *
 * Two windows may launch on the same GDB port: CMSIS Solution gives its
 * pyOCD, J-Link and FVP set-ups 3333 alike. A server that listens there
 * already — another window's CMSIS Run task, another window's debug
 * session, any other program — answers GDB's `localhost:<port>` before the
 * new one does, and GDB then debugs that target instead: pyOCD halts its
 * board for the new client, and the launch still looks fine to the tools. A
 * second FVP launch on the same port even removes the first window's model.
 *
 * What is known without a connection decides, since a GDB server takes any
 * connection as a client (pyOCD halts the target for it):
 *
 *   1. the GDB ports the other registered windows publish
 *      (`GdbPortClaim`s of their registry entries), which name the window and
 *      what holds the port;
 *   2. else a bind test: this process binds the port on 127.0.0.1, ::1 and
 *      the wildcard, one after the other, and closes it at once. A bind that
 *      fails with EADDRINUSE means some other process listens where GDB's
 *      `localhost` would reach it. pyOCD listens on 127.0.0.1 only, Docker
 *      publishes a container's port on the wildcard, and on macOS a bind
 *      notices only a listener on the same address, hence all three. Any
 *      other failure (no IPv6, a privileged port) proves nothing.
 *
 * Callers first acquire a cross-process GdbPortReservations claim. The
 * preflight alone is not atomic: two windows could both see a free port
 * before either server starts. The claim spans that gap without binding
 * the port that the real GDB server needs.
 *
 * `gdbPortRefusal` words the `PROBE_BUSY` refusal: what was not started, the
 * port, who holds it, and the way out — stop it there, or another port. A
 * pending start of this window that its next start may not take over yet is
 * named as its own, with what it still waits for.
 *
 * No `vscode`: the windows and the probe come in.
 */

import * as net from 'net';
import { Refusal } from './toolResult';
import type { GdbPortClaim, GdbServerKind } from './gdbServerPorts';

/** Another registered window and the GDB ports it publishes. */
export interface PortClaimingWindow {
    pid: number;
    /** The window's name in the registry; `(no workspace)` for a window without a folder. */
    name: string;
    claims: readonly GdbPortClaim[];
}

/**
 * Why a start of this window that reserved its GDB port and has no session
 * yet may not be taken over by the window's next start: a debug session, a
 * CMSIS task or a `cmsis_action` job of the window may still take it over, or
 * it is younger than `takeOverAfterMs` and may come up any moment.
 */
export type StartWait =
    | { kind: 'session' }
    | { kind: 'task'; name: string }
    | { kind: 'job'; id: string; action: string }
    | { kind: 'starting'; takeOverAfterMs: number };

/**
 * Who holds a GDB port: another window, by its claim or its reservation;
 * this window's own start, session or task (`own`: `adopted` once one of them
 * took the reservation over, `waitingFor` what a pending start still waits
 * for); or a process that is no window of this extension.
 */
export type GdbPortHolder =
    | { kind: 'window'; pid: number; name: string; claim: GdbPortClaim }
    | { kind: 'reservation'; pid: number; name: string; label: string; what?: 'launch' | 'run' }
    | { kind: 'own'; what: 'launch' | 'run'; label: string; ageMs: number; adopted: boolean; server?: GdbServerKind; waitingFor?: StartWait }
    | { kind: 'listener' };

/** What one bind test says: another process listens, nothing does, or the bind failed for another reason. */
export type BindOutcome = 'in-use' | 'free' | 'unknown';

/** Where GDB's `localhost` connects, and the wildcard that Docker publishes on; tried in this order. */
export const BIND_PROBE_HOSTS: readonly string[] = ['127.0.0.1', '::1', '0.0.0.0'];
/** A bind answers at once; this only guards against a listen callback that never comes. */
const BIND_PROBE_MS = 1_000;
/** The registry name of a window without a workspace. */
const NO_WORKSPACE = '(no workspace)';

/**
 * Bind `host:port`, and close it again at once. Never connects: no GDB
 * server sees a client.
 */
export function bindProbe(port: number, host: string): Promise<BindOutcome> {
    return new Promise<BindOutcome>((resolve) => {
        const server = net.createServer();
        let settled = false;
        const settle = (outcome: BindOutcome): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(outcome);
            }
        };
        const timer = setTimeout(() => {
            server.close();
            settle('unknown');
        }, BIND_PROBE_MS);
        server.unref();
        server.once('error', (error: NodeJS.ErrnoException) => settle(error.code === 'EADDRINUSE' ? 'in-use' : 'unknown'));
        server.listen({ port, host }, () => server.close(() => settle('free')));
    });
}

/**
 * True when another process listens on `port` where a GDB on this machine
 * would reach it: a bind on one of `hosts` fails with EADDRINUSE. The binds
 * run one after the other, since on Linux our own open probe on 127.0.0.1
 * would make the wildcard bind fail.
 */
export async function portInUse(port: number, hosts: readonly string[] = BIND_PROBE_HOSTS): Promise<boolean> {
    for (const host of hosts) {
        if (await bindProbe(port, host) === 'in-use') {
            return true;
        }
    }
    return false;
}

/**
 * Who holds `port`: the first other window whose published claims name it,
 * else a process that listens there (`inUse`, the bind test), else nobody.
 */
export async function findGdbPortHolder(
    port: number,
    windows: readonly PortClaimingWindow[],
    inUse: (port: number) => Promise<boolean> = portInUse,
): Promise<GdbPortHolder | undefined> {
    for (const window of windows) {
        const claim = window.claims.find((candidate) => candidate.port === port);
        if (claim) {
            return { kind: 'window', pid: window.pid, name: window.name, claim };
        }
    }
    return await inUse(port) ? { kind: 'listener' } : undefined;
}

/** What was about to start a GDB server, as the refusal names it. */
export interface PortStart {
    /** A debug session's launch (`load_and_debug`, `start_debugging`) or a CMSIS Run task (`run`, `load_and_run`). */
    what: 'launch' | 'run';
    /** The beginning of the refusal: `CMSIS 'load_and_debug' on MPS3 not started`. */
    subject: string;
    /** The launch configuration's name; none for a CMSIS Run. */
    configuration?: string;
    /** The GDB server that would have started, when known. */
    server?: GdbServerKind;
}

/** A window as the refusal names it: `window 'item13' (pid 70401)`. */
function windowText(holder: { pid: number; name: string }): string {
    return holder.name && holder.name !== NO_WORKSPACE ? `window '${holder.name}' (pid ${holder.pid})` : `the window with pid ${holder.pid}`;
}

/** `pyOCD GDB server`, or `GDB server` when the kind is not known. */
function serverText(server: GdbServerKind | undefined): string {
    return server ? `${server} GDB server` : 'GDB server';
}

/** How long ago, as the job texts say it: whole seconds below three minutes, then minutes. */
function agoText(ms: number): string {
    const safe = Math.max(0, ms);
    return safe < 180_000 ? `${Math.round(safe / 1_000)} s` : `${Math.round(safe / 60_000)} min`;
}

/** What uses the port in that window: `its CMSIS Run task (pyOCD GDB server)`. */
function claimText(claim: GdbPortClaim): string {
    const what = claim.source === 'cmsis-run' ? `its ${claim.label} task` : `its debug session '${claim.label}'`;
    return `${what} (${serverText(claim.server)})`;
}

/**
 * What may hold a launch that reserved its GDB port but started no debug
 * session: VS Code shows the start nowhere else, and CMSIS Solution reports
 * a launch VS Code dropped only in its own message. `fvp` adds what the
 * first start of an FVP on Windows can wait for.
 */
export function pendingLaunchCauses(fvp: boolean): string {
    const prompt = fvp ? '; at the first start of an FVP on Windows, an access-permission prompt' : '';
    return `VS Code may be waiting for the user (a picker or a dialog${prompt}), or it dropped the launch before its debug adapter started`;
}

/** Where this project sets another port, by what would have started. */
function anotherPort(start: PortStart): string {
    if (start.what === 'run') {
        return 'give this project\'s GDB server another port';
    }
    return start.server === 'Arm FVP'
        ? 'give this project another port: GDBServer.port in .vscode/launch.json'
        : `give this project another port: target.port of '${start.configuration ?? 'the launch configuration'}' in .vscode/launch.json`;
}

/**
 * The refusal of a start whose port this window holds itself: its own
 * session or task, or its own pending launch or Run that may not be taken
 * over yet. A pending start that may be taken over is never refused: the
 * window's next start takes its port over.
 */
function ownRefusal(start: PortStart, starts: string, follows: string, holder: Extract<GdbPortHolder, { kind: 'own' }>): Refusal {
    if (holder.adopted) {
        const owner = holder.what === 'run' ? `its ${holder.label} task` : `its debug session '${holder.label}'`;
        return new Refusal('PROBE_BUSY', `${start.subject}: ${starts}, which this window uses for ${owner}. ${follows}`,
            `Stop it first once the user agrees (${holder.what === 'run' ? 'cmsis_action stop_run' : 'stop_debugging'}), then repeat this call; `
                + `or ${anotherPort(start)}.`);
    }
    const pending = holder.what === 'run' ? 'its own CMSIS Run' : `its own launch of '${holder.label}'`;
    const reserved = `${start.subject}: ${starts}, which this window reserved ${agoText(holder.ageMs)} ago for ${pending}`;
    const wait = holder.waitingFor;
    switch (wait?.kind) {
        case 'task':
            return new Refusal('PROBE_BUSY', `${reserved}; its task '${wait.name}' still runs.`,
                'Wait for it with cmsis_action {action:\'status\'}, or end that task with cmsis_action stop_run once the user agrees; then repeat this call.');
        case 'job':
            return new Refusal('PROBE_BUSY', `${reserved}; its ${wait.action} (job ${wait.id}) has not started its task yet.`,
                'Wait for it with cmsis_action {action:\'status\'}, then repeat this call.');
        case 'session':
            return new Refusal('PROBE_BUSY', `${reserved}, and a debug session of this window may still take it over.`,
                'Stop that session first once the user agrees (stop_debugging), then repeat this call.');
        default: {
            const after = wait ? ` A start here takes that port over once it has gone ${Math.round(wait.takeOverAfterMs / 1_000)} s without a session or task.` : '';
            return new Refusal('PROBE_BUSY', `${reserved}, which has not come up yet.`,
                `Wait for it: get_session_status shows its session once it is up. ${pendingLaunchCauses(holder.server === 'Arm FVP')}.${after}`);
        }
    }
}

/**
 * The `PROBE_BUSY` refusal of a start whose GDB port `holder` holds: what was
 * not started, the port, who holds it and what follows from two servers on
 * one port; the hint says how to stop the holder or move this project.
 */
export function gdbPortRefusal(start: PortStart, port: number, holder: GdbPortHolder): Refusal {
    const starts = start.what === 'run'
        ? `its ${serverText(start.server)} (CMSIS Run) would use port ${port}`
        : `the ${serverText(start.server)} of '${start.configuration ?? 'its launch configuration'}' would use port ${port}`;
    const follows = start.what === 'run'
        ? 'Two GDB servers on one port: the new one fails to start, or a GDB meant for one of them reaches the other.'
        : 'GDB would connect to that server instead of the new one, and debug — and halt — that target.';
    if (holder.kind === 'own') {
        return ownRefusal(start, starts, follows, holder);
    }
    if (holder.kind === 'reservation') {
        const message = `${start.subject}: ${starts}, which ${windowText(holder)} has reserved for '${holder.label}'. ${follows}`;
        if (holder.what === 'run') {
            return new Refusal('PROBE_BUSY', message,
                `That window keeps the port while its CMSIS Run may still start. Wait for it, or end it there once the user agrees: `
                    + `cmsis_action stop_run with window: '${holder.pid}' once it runs, or a reload of that window if it never starts; or ${anotherPort(start)}.`);
        }
        if (holder.what === 'launch') {
            return new Refusal('PROBE_BUSY', message,
                `That window keeps the port while its launch may still come up. Wait for it, or end it there once the user agrees: `
                    + `select_debug_window {pid: ${holder.pid}}, then stop_debugging once its session is up, or a reload of that window if it never comes; `
                    + `or ${anotherPort(start)}.`);
        }
        // A window of 2.8 or older writes no `what`.
        return new Refusal('PROBE_BUSY', message,
            `Wait for that start to finish, or stop its session/task there once the user agrees. A pending picker keeps its reservation; `
                + `cancel it and reload that window before retrying, or ${anotherPort(start)}.`);
    }
    if (holder.kind === 'window') {
        const stop = holder.claim.source === 'cmsis-run'
            ? `Stop that task there once the user agrees (cmsis_action stop_run with window: '${holder.pid}')`
            : `Stop that session there once the user agrees (select_debug_window {pid: ${holder.pid}}, then stop_debugging)`;
        return new Refusal('PROBE_BUSY',
            `${start.subject}: ${starts}, which ${windowText(holder)} uses for ${claimText(holder.claim)}. ${follows}`,
            `${stop}, or ${anotherPort(start)}.`);
    }
    return new Refusal('PROBE_BUSY',
        `${start.subject}: ${starts}, and another program already listens on that port of this computer — no window of the CMSIS Developer `
            + `Assistant claims it: a GDB server started elsewhere, or one an earlier session left running. ${follows}`,
        `Free the port (the user can end that program), or ${anotherPort(start)}.`);
}
