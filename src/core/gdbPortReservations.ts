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
 * Cross-process reservations bridge the gap between the GDB port preflight
 * and the session/task publishing its port. A fully written, nonempty
 * directory is renamed into place atomically; two windows cannot both own
 * it. No TCP connection is made and the real server can bind normally.
 *
 * There is no time-based expiry: a slow flash or picker can outlive a tool
 * deadline. A reservation ends only on evidence that its start is gone.
 * Once a session/task claims the port, its end releases the reservation; a
 * session claims it when its adapter starts (`adoptPort`), whatever the tool
 * call saw. A confirmed start failure releases it too. Shutdown releases this
 * window's claims, and a later contender can reclaim a dead process's claim.
 * Unknown/malformed owners fail closed rather than risk a target.
 *
 * No late start passes this guard: VS Code takes a launch up after awaits of
 * its own, a CMSIS Run task starts once CMSIS Solution has fetched the
 * tasks, and VS Code may still "Debug Anyway" after a failed pre-launch task.
 * A start that VS Code drops tells nobody, so it stays pending: `pending()`
 * lists what this window reserved and no session or task has taken over, for
 * the status tools. The window's next start on such a port takes it over
 * (`acquire` with `takeOver`): the owner record stays, so no other window can
 * have the port in between. The taken-over reservation still covers the
 * earlier start, which may yet begin: when the new start is over, the port
 * goes back to that start, as the reservation it was (its batch, its age,
 * its handle), instead of being freed. An earlier start that has reported
 * its end meanwhile gets nothing back: the port is then free.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gdbPortRefusal, type PortStart } from './gdbPortGuard';
import type { GdbPortClaim, GdbServerKind } from './gdbServerPorts';
import { ToolError } from './toolResult';
import { defaultRegistryDir, ensureRegistryDir, isProcessAlive } from '../utils/workspaceRegistry';
import { logger } from '../utils/logger';

/** A reservation stays held until its confirmed failure or owning session/task ends. */
export interface GdbPortReservation {
    /** The reserved port. */
    readonly port: number;
    /** True while it is held and no session or task of this window has taken its batch over. */
    readonly pending: boolean;
    /**
     * True while a newer start of this window holds the port (a take-over)
     * and would hand it back to this one: `release` then frees nothing, it
     * only keeps the port from coming back.
     */
    readonly superseded: boolean;
    /** A verified session/run owns this batch, even when a periodic port sample missed its start. */
    adopt(): void;
    /**
     * Evidence that this start is over: removes this reservation's unique
     * owner record, or, after a take-over, hands the port back to the earlier
     * start it still covers. Idempotent. Once taken over, the port stays with
     * the newer start, which then does not hand it back to this one.
     */
    release(): void;
}

/** One batch of reservations that no session or task of this window has taken over yet: a start in progress, or one VS Code dropped. */
export interface PendingGdbStart {
    /** The batch, as `acquire` was given it. */
    group: string;
    /** A debug launch (`load_and_debug`, `start_debugging`) or a CMSIS Run (`run`, `load_and_run`). */
    what: PortStart['what'];
    /** The launch configuration, or `CMSIS Run`. */
    label: string;
    /** The GDB server that would have started, when known. */
    server?: GdbServerKind;
    /** The reserved ports, ascending. */
    ports: number[];
    /** When its first port was reserved, on the manager's clock. */
    since: number;
    /** How long ago that was, on the manager's clock. */
    ageMs: number;
}

interface ReservationOwner {
    pid: number;
    name: string;
    label: string;
    /** What reserved, so that another window's refusal names the way out; records of windows of 2.8 or older lack it. */
    what?: PortStart['what'];
}

interface HeldReservation extends GdbPortReservation {
    directory: string;
    ownerFile: string;
    group: string;
    generation: number;
    adopted: boolean;
    start: PortStart;
    since: number;
    /** The reservation of an earlier start of this window that it took over, which may still begin; it is not among the held ones meanwhile. */
    earlier?: HeldReservation;
    /** Its start reported its end (`release`): a reservation taken over is not handed the port back then. */
    over: boolean;
}

/** What a reservation is for, as its owner record and the refusals name it: the launch configuration, or the CMSIS Run task. */
function labelOf(start: PortStart): string {
    return start.configuration ?? (start.what === 'run' ? 'CMSIS Run' : start.subject);
}

/** A filesystem error code without assuming a thrown value is an Error. */
function codeOf(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Remove only the named owner, then its empty directory, never another owner's replacement. */
function removeOwner(directory: string, ownerFile: string): void {
    try {
        fs.unlinkSync(path.join(directory, ownerFile));
    } catch (caught) {
        if (codeOf(caught) === 'ENOENT') {
            return;
        }
        throw caught;
    }
    try {
        fs.rmdirSync(directory);
    } catch (caught) {
        // A contender may have atomically replaced the now-empty directory
        // with its own nonempty one. Never remove that new owner's record.
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(caught) ?? '')) {
            throw caught;
        }
    }
}

/** No filesystem writes until acquire; injectable identity/directory keep tests isolated. */
export class GdbPortReservations {
    private readonly held = new Set<HeldReservation>();
    private generation = 0;
    private readonly directory: string;
    private readonly registryRoot: string | undefined;

    constructor(
        directory?: string,
        private readonly pid: number = process.pid,
        private readonly alive: (pid: number) => boolean = isProcessAlive,
        registryRoot?: string,
        private readonly now: () => number = Date.now,
    ) {
        this.registryRoot = registryRoot ?? (directory === undefined ? defaultRegistryDir() : undefined);
        this.directory = directory ?? path.join(this.registryRoot as string, 'gdb-port-reservations');
    }

    /**
     * Reserve before any asynchronous preflight or launch. A live contender
     * is PROBE_BUSY; so is a port this window holds already, named as its own
     * start, session or task, unless `takeOver` says that this window's
     * pending start there may be taken over: the caller has checked that
     * nothing of the window may still take that start over.
     */
    acquire(port: number, start: PortStart, name: string, group: string = randomUUID(), takeOver = false): GdbPortReservation {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ToolError('INVALID_ARGUMENT', `Invalid GDB port ${port}.`);
        }
        const own = [...this.held].find((held) => held.port === port);
        if (own) {
            if (takeOver && !own.adopted) {
                return this.takeOver(own, start, group);
            }
            throw gdbPortRefusal(start, port, {
                kind: 'own', what: own.start.what, label: labelOf(own.start), ageMs: Math.max(0, this.now() - own.since), adopted: own.adopted,
                server: own.start.server,
            });
        }
        const target = path.join(this.directory, `port-${port}`);
        const ownerFile = `owner-${randomUUID()}.json`;
        let staging: string | undefined;
        try {
            if (this.registryRoot) {
                const rootUnfit = ensureRegistryDir(this.registryRoot, { platform: process.platform, uid: process.getuid?.() });
                if (rootUnfit) {
                    throw new Error(`${this.registryRoot} ${rootUnfit}`);
                }
            }
            const unfit = ensureRegistryDir(this.directory, { platform: process.platform, uid: process.getuid?.() });
            if (unfit) {
                throw new Error(`${this.directory} ${unfit}`);
            }
            staging = fs.mkdtempSync(path.join(this.directory, `.port-${port}-`));
            const prepared = staging;
            const owner: ReservationOwner = { pid: this.pid, name, label: labelOf(start), what: start.what };
            fs.writeFileSync(path.join(staging, ownerFile), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
            // Bounded retries cover a release/reclaim racing this acquire.
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    fs.renameSync(prepared, target);
                    staging = undefined;
                    return this.remember(port, target, ownerFile, group, start);
                } catch (caught) {
                    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(codeOf(caught) ?? '')) {
                        throw caught;
                    }
                }
                let names: string[];
                try {
                    const stats = fs.lstatSync(target);
                    if (!stats.isDirectory() || stats.isSymbolicLink()) {
                        throw new Error(`${target} is not a reservation directory`);
                    }
                    names = fs.readdirSync(target);
                } catch (caught) {
                    if (codeOf(caught) === 'ENOENT') {
                        continue;
                    }
                    throw caught;
                }
                if (names.length === 0) {
                    // Windows will not rename over the empty directory a
                    // releaser left; removing only an empty directory is safe.
                    try {
                        fs.rmdirSync(target);
                    } catch (caught) {
                        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(caught) ?? '')) {
                            throw caught;
                        }
                    }
                    continue;
                }
                if (names.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(names[0])) {
                    throw new Error(`${target} has an unrecognised owner record`);
                }
                let other: ReservationOwner;
                try {
                    const file = path.join(target, names[0]);
                    const stats = fs.lstatSync(file);
                    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16384) {
                        throw new Error(`${file} is not a valid owner record`);
                    }
                    other = JSON.parse(fs.readFileSync(file, 'utf8')) as ReservationOwner;
                } catch (caught) {
                    if (codeOf(caught) === 'ENOENT') {
                        continue;
                    }
                    throw caught;
                }
                if (!Number.isInteger(other.pid) || other.pid <= 0 || typeof other.name !== 'string' || typeof other.label !== 'string') {
                    throw new Error(`${target} has an invalid owner record`);
                }
                if (this.alive(other.pid)) {
                    const what = other.what === 'launch' || other.what === 'run' ? other.what : undefined;
                    throw gdbPortRefusal(start, port, { kind: 'reservation', pid: other.pid, name: other.name, label: other.label, what });
                }
                // Only the reaper that removed this unique dead owner's file
                // may remove the directory. Another reaper cannot erase a new claim.
                removeOwner(target, names[0]);
            }
            throw new Error(`GDB port ${port} reservation changed repeatedly; retry after the other start settles`);
        } catch (caught) {
            if (caught instanceof ToolError) {
                throw caught;
            }
            throw new ToolError('INTERNAL', `GDB port ${port} was not reserved; no launch was started: ${caught instanceof Error ? caught.message : String(caught)}.`);
        } finally {
            if (staging) {
                try {
                    removeOwner(staging, ownerFile);
                } catch (caught) {
                    logger.warn(`Could not remove GDB reservation staging record ${staging}`, caught);
                }
            }
        }
    }

    /** Capture before an asynchronous query so its old state cannot adopt a newer pending start. */
    observationVersion(): number {
        return this.generation;
    }

    /**
     * A debug session of this window begins on `port`: its batch is owned
     * from now on, so the end of the session releases it however long the
     * tool call waited and whether or not a port sample saw it live. VS Code
     * announces a session only once its launch succeeded; a failed one ends
     * unannounced.
     */
    adoptPort(port: number): void {
        for (const reservation of this.held) {
            if (reservation.port === port) {
                reservation.adopt();
            }
        }
    }

    /** Keep pending starts; once adopted, release only when the session/task no longer claims the port. */
    observe(claims: readonly GdbPortClaim[], version: number = this.generation): void {
        const eligible = [...this.held].filter((reservation) => reservation.generation <= version);
        const ports = new Set(claims.map((claim) => claim.port));
        const activeGroups = new Set(eligible.filter((reservation) => ports.has(reservation.port)).map((reservation) => reservation.group));
        for (const reservation of eligible) {
            // Several alternative configurations can be offered by one
            // launch. Their batch ends together, including unselected ports.
            if (activeGroups.has(reservation.group)) {
                reservation.adopted = true;
            } else if (reservation.adopted) {
                reservation.release();
            }
        }
    }

    /**
     * This window's starts whose reservations no session or task has taken
     * over: a start in progress, or one that VS Code dropped without a word.
     * Oldest first, one entry per batch.
     */
    pending(): PendingGdbStart[] {
        const now = this.now();
        const batches = new Map<string, PendingGdbStart>();
        for (const held of this.held) {
            if (held.adopted) {
                continue;
            }
            const batch = batches.get(held.group);
            if (batch) {
                batch.ports.push(held.port);
                batch.since = Math.min(batch.since, held.since);
            } else {
                batches.set(held.group, {
                    group: held.group, what: held.start.what, label: labelOf(held.start), server: held.start.server, ports: [held.port],
                    since: held.since, ageMs: 0,
                });
            }
        }
        return [...batches.values()]
            .map((batch) => ({ ...batch, ports: [...new Set(batch.ports)].sort((a, b) => a - b), ageMs: Math.max(0, now - batch.since) }))
            .sort((a, b) => a.since - b.since);
    }

    /** Normal window shutdown: drop only records created by this manager. */
    dispose(): void {
        for (const reservation of [...this.held]) {
            this.drop(reservation);
        }
    }

    /**
     * A new start of this window takes over its own pending reservation of
     * `previous.port`. The owner record stays on disk, so no other window can
     * have the port in between, and the earlier start stays covered, since
     * it may still begin: its reservation is kept, with the ones it had taken
     * over itself, and gets the port back when the new start is over. Until
     * then the earlier start's handle only records that its start ended, and
     * the new generation keeps an older port sample from adopting or
     * releasing the new reservation.
     */
    private takeOver(previous: HeldReservation, start: PortStart, group: string): GdbPortReservation {
        this.held.delete(previous);
        logger.info(`GDB port ${previous.port}: '${labelOf(start)}' takes over this window's reservation for '${labelOf(previous.start)}', `
            + 'which has started no session or task');
        return this.remember(previous.port, previous.directory, previous.ownerFile, group, start, previous);
    }

    /** Remove a reservation's owner record: its start is gone, or the window shuts down. */
    private drop(reservation: HeldReservation): void {
        try {
            removeOwner(reservation.directory, reservation.ownerFile);
            this.held.delete(reservation);
        } catch (caught) {
            // A failed cleanup must neither mask the launch error
            // nor prevent other window resources from closing.
            logger.warn(`Could not release GDB port ${reservation.port} reservation`, caught);
        }
    }

    private remember(port: number, directory: string, ownerFile: string, group: string, start: PortStart, earlier?: HeldReservation): GdbPortReservation {
        const held = this.held;
        const reservation: HeldReservation = {
            port, directory, ownerFile, group, generation: ++this.generation, adopted: false, start, since: this.now(), earlier, over: false,
            get pending(): boolean {
                return held.has(reservation) && !reservation.adopted;
            },
            get superseded(): boolean {
                if (reservation.over) {
                    return false;
                }
                for (const other of held) {
                    for (let covered = other.earlier; covered !== undefined; covered = covered.earlier) {
                        if (covered === reservation) {
                            return true;
                        }
                    }
                }
                return false;
            },
            adopt: () => {
                if (!this.held.has(reservation)) {
                    return;
                }
                const generation = ++this.generation;
                for (const held of this.held) {
                    if (held.group === group) {
                        held.adopted = true;
                        held.generation = generation;
                    }
                }
            },
            release: () => {
                reservation.over = true;
                if (!this.held.has(reservation)) {
                    // Taken over, or let go already: the evidence is kept, so that the newer start does not hand the port back.
                    return;
                }
                // A batch ends together: its reservations that newer starts took over are over as well.
                for (const other of this.held) {
                    for (let covered = other.earlier; covered !== undefined; covered = covered.earlier) {
                        if (covered.group === group) {
                            covered.over = true;
                        }
                    }
                }
                let earlier = reservation.earlier;
                while (earlier?.over) {
                    earlier = earlier.earlier;
                }
                if (earlier === undefined) {
                    this.drop(reservation);
                    return;
                }
                // This start is over, not the earlier one it took over, which has said nothing: that one gets the port back
                // as the reservation it was, so its batch still ends together and its handle acts on the port again.
                const back = earlier;
                this.held.delete(reservation);
                const mate = [...this.held].find((other) => other.group === back.group && other.adopted);
                back.adopted = mate !== undefined;
                back.generation = mate ? mate.generation : ++this.generation;
                this.held.add(back);
            },
        };
        this.held.add(reservation);
        return reservation;
    }
}
