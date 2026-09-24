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
 * What a window knows about its own health (#14), for the control server's
 * fence and `health` op, the registry entry and the notices:
 *
 * - `BusyTable`: the ops running in this window, with when each started and
 *   whether it outlived its fence. An op stays in it until its promise
 *   settles, however long after its fence that is.
 * - `LagMonitor`: how late the event loop ran timers since the last reset,
 *   from `perf_hooks.monitorEventLoopDelay`. A blocked extension host shows
 *   here, afterwards, as a delay of seconds.
 * - `NoticeGate`: at most one notice per key in a time window, so a picker
 *   nobody answers does not raise a toast per call.
 *
 * Pure: Node only, no vscode.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

/** One op running in this window. */
export interface BusyRun {
    /** Tells two runs of the same op apart. */
    readonly ticket: number;
    /** The op name, as the control server dispatched it. */
    readonly op: string;
    /** The tool call it serves, when the router named one. */
    readonly callId?: string;
    /** Milliseconds since the epoch. */
    readonly startedAt: number;
    /** True once the fence answered for it; it keeps running. */
    fenced: boolean;
    /** When the fence answered, milliseconds since the epoch. */
    fencedAt?: number;
}

/** The ops running in this window, oldest first. */
export class BusyTable {
    private readonly runs: BusyRun[] = [];
    private lastTicket = 0;

    constructor(private readonly clock: () => number = () => Date.now()) {}

    /** Enter an op that starts now. */
    begin(op: string, callId?: string): BusyRun {
        const run: BusyRun = { ticket: ++this.lastTicket, op, startedAt: this.clock(), fenced: false, ...(callId ? { callId } : {}) };
        this.runs.push(run);
        return run;
    }

    /** Mark the run as answered by its fence. */
    fence(run: BusyRun): void {
        run.fenced = true;
        run.fencedAt = this.clock();
    }

    /** Remove the run once its promise settled; a second call changes nothing. */
    end(run: BusyRun): void {
        const at = this.runs.indexOf(run);
        if (at >= 0) {
            this.runs.splice(at, 1);
        }
    }

    /** The runs, oldest first. */
    list(): readonly BusyRun[] {
        return [...this.runs];
    }
}

/** Event-loop delay in milliseconds: the 99th percentile and the maximum since the last reset. */
export interface LagFigures {
    p99: number;
    max: number;
}

/** How often the delay is sampled. */
const LAG_RESOLUTION_MS = 20;
const NANOSECONDS_PER_MS = 1e6;

/** The event-loop delay of this process, sampled every 20 ms; `reset()` starts a new interval. */
export class LagMonitor {
    private readonly histogram: IntervalHistogram;

    constructor() {
        this.histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
        // The sampling timer is unref'd by Node: it never keeps a process alive.
        this.histogram.enable();
    }

    /** The figures since the last reset, whole milliseconds; zeros before the first sample. */
    read(): LagFigures {
        if (this.histogram.count === 0) {
            return { p99: 0, max: 0 };
        }
        return {
            p99: Math.round(this.histogram.percentile(99) / NANOSECONDS_PER_MS),
            max: Math.round(this.histogram.max / NANOSECONDS_PER_MS),
        };
    }

    reset(): void {
        this.histogram.reset();
    }

    dispose(): void {
        this.histogram.disable();
    }
}

/** Lets one notice per key through in each `windowMs`; the keys are op or tool names. */
export class NoticeGate {
    private readonly shownAt = new Map<string, number>();

    constructor(private readonly windowMs: number) {}

    /** True when no notice for `key` passed within the window before `now`; that notice counts from now. */
    allow(key: string, now: number): boolean {
        const last = this.shownAt.get(key);
        if (last !== undefined && now - last < this.windowMs) {
            return false;
        }
        this.shownAt.set(key, now);
        return true;
    }
}

/** A duration in seconds for a message: one decimal below 10 s, whole seconds above. */
export function secondsText(ms: number): string {
    const tenths = Math.round(Math.max(0, ms) / 100);
    return tenths < 100 ? `${tenths / 10} s` : `${Math.round(tenths / 10)} s`;
}
