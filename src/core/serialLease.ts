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
 * When a serial port an agent holds is let go again (#49). Agents open a
 * port and forget it; on Windows a COM port is exclusive, so the Serial
 * Monitor or a terminal then gets "Access denied" until the window reloads.
 * A lease records who holds the port and under which rule it goes:
 *
 * - `idle` (the default): after `serial.idleCloseSeconds` without a serial
 *   call, and when the MCP session that opened it ends;
 * - `debug-session-end`: when a debug session in this window ends, and when
 *   its MCP session ends, never for idleness;
 * - `manual`: only through `serial_close` and the user's Release command;
 *   it survives its MCP session, for soak tests.
 *
 * Every rule also ends with the window (teardown) and with the user's
 * Release command, which the controller handles without asking the lease.
 *
 * "Idle" means that no agent asked: the serial tools touch the lease, the
 * bytes the board sends do not. A call in progress (a `serial_read` that
 * waits, a capture) keeps the lease busy. The timer looks once per idle
 * period and re-arms for the rest when the port was used meanwhile, so a
 * touch costs nothing. Clock and timer are injected; tests drive both.
 *
 * Pure: no vscode.
 */

/** The rules `serial_open` accepts as `releaseOn`. */
export const RELEASE_RULES = ['idle', 'debug-session-end', 'manual'] as const;
export type ReleaseRule = typeof RELEASE_RULES[number];

/** Why a rule, rather than `serial_close`, let a port go. */
export type RuleRelease = 'idle' | 'owner-gone' | 'debug-session-end' | 'user';

/** `serial.idleCloseSeconds` when the setting says nothing usable. */
export const DEFAULT_IDLE_CLOSE_SECONDS = 300;

/** The clock and the one-shot timer a lease runs on. */
export interface LeaseTimers {
    /** Milliseconds on the lease's clock. */
    now(): number;
    /** Calls `fire` once after `ms`; the returned function cancels it. */
    after(ms: number, fire: () => void): () => void;
}

/** Node's clock and timers; a timer never keeps the process alive. */
export const REAL_TIMERS: LeaseTimers = {
    now: () => Date.now(),
    after: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        handle.unref?.();
        return () => clearTimeout(handle);
    },
};

/** What a lease is granted on. */
export interface LeaseTerms {
    /** The MCP session that opened the port; none when the call carried no session. */
    owner?: string;
    rule: ReleaseRule;
    /** The idle limit; 0 turns the idle release off. Only the `idle` rule uses it. */
    idleSeconds: number;
}

/** The rule a caller named; anything else is the default, `idle`. */
export function releaseRuleOf(value: unknown): ReleaseRule {
    return RELEASE_RULES.find((rule) => rule === value) ?? 'idle';
}

/** The idle limit a setting gives: a finite number of 0 or more, whole seconds; the default otherwise. */
export function idleSecondsOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_IDLE_CLOSE_SECONDS;
}

/** A held port's lease: its owner, its rule and the idle timer. */
export class SerialLease {
    readonly owner: string | undefined;
    readonly rule: ReleaseRule;
    /** The idle limit in milliseconds; 0 when idleness never releases this lease. */
    readonly idleMs: number;
    private lastUse: number;
    private calls = 0;
    private cancel: (() => void) | undefined;
    private ended = false;

    /** @param onIdle called once when the idle limit passes without a serial call. */
    constructor(terms: LeaseTerms, private readonly timers: LeaseTimers, private readonly onIdle: () => void) {
        this.owner = terms.owner;
        this.rule = terms.rule;
        this.idleMs = terms.rule === 'idle' ? Math.max(0, terms.idleSeconds) * 1000 : 0;
        this.lastUse = timers.now();
        this.arm(this.idleMs);
    }

    /** A serial call used the port now. */
    touch(): void {
        this.lastUse = this.timers.now();
    }

    /** Runs `work` as one serial call: the lease is busy meanwhile and touched at both ends. */
    async during<T>(work: () => Promise<T>): Promise<T> {
        this.calls += 1;
        this.touch();
        try {
            return await work();
        } finally {
            this.calls -= 1;
            this.touch();
        }
    }

    /** Milliseconds since the last serial call; 0 while one runs. */
    idleForMs(): number {
        return this.calls > 0 ? 0 : Math.max(0, this.timers.now() - this.lastUse);
    }

    /** Milliseconds until the idle release; undefined when idleness does not release this lease. */
    idleReleaseInMs(): number | undefined {
        return this.idleMs > 0 ? Math.max(0, this.idleMs - this.idleForMs()) : undefined;
    }

    /** True when the end of MCP session `sessionId` lets the port go: its owner, unless the rule is `manual`. */
    endsWithSession(sessionId: string): boolean {
        return this.rule !== 'manual' && this.owner !== undefined && this.owner === sessionId;
    }

    /** True when the end of a debug session in this window lets the port go. */
    endsWithDebugSession(): boolean {
        return this.rule === 'debug-session-end';
    }

    /** Stops the timer; the lease does nothing more. */
    end(): void {
        this.ended = true;
        this.cancel?.();
        this.cancel = undefined;
    }

    private arm(ms: number): void {
        if (this.idleMs === 0 || this.ended) {
            return;
        }
        this.cancel = this.timers.after(ms, () => this.check());
    }

    /** The timer fired: release when the port sat idle for the whole limit, else wait for the rest. */
    private check(): void {
        this.cancel = undefined;
        if (this.ended) {
            return;
        }
        const idle = this.idleForMs();
        if (this.calls === 0 && idle >= this.idleMs) {
            this.end();
            this.onIdle();
            return;
        }
        this.arm(this.calls > 0 ? this.idleMs : this.idleMs - idle);
    }
}
