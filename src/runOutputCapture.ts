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
 * The output of this window's CMSIS Run tasks (#134), read through VS
 * Code's stable shell-integration API.
 *
 * VS Code's task system writes the sequences of its shell integration into
 * the terminal of every shell and process task it runs, around the task's
 * command line. The API then reports that command to every extension as a
 * `TerminalShellExecution` (`window.onDidStartTerminalShellExecution`), whose
 * `read()` streams what the terminal receives until the command ends; the
 * setting `terminal.integrated.shellIntegration.enabled` does not change
 * this, it governs the injection into interactive shells. Observed in VS
 * Code 1.146 with a shell task shaped like the FVP adapter's CMSIS Run. A
 * task its owner runs in a pseudoterminal (CMSIS Solution's builds, and from
 * 1.72.1 its managed pyOCD tasks) is never reported: only its owner sees its
 * output.
 *
 * An execution starts within milliseconds of its task, before or after the
 * tracker sees the task, so the two are paired by the command line
 * (`commandLineMatches`) within `MATCH_WINDOW_MS`; an execution that no CMSIS
 * Run claims in that time is not kept. The output of the last `KEPT_RUNS`
 * Runs is kept, each within `OUTPUT_KEPT_CHARS`, in memory only. Its last
 * data arrives a few milliseconds after the task process end that settles a
 * job, so a reply waits for it (`runOutputsOf`, at most `OUTPUT_SETTLE_MS`).
 *
 * One capture per tracker (`attachRunOutput`, `runOutputOf`): the window's
 * comes with `windowJobTracker()`; tests attach one over fake events. It
 * reads shell executions from a `ShellExecutionSource` and time from the
 * tracker's clock.
 */

import * as vscode from 'vscode';
import { executionIn, Job, JobExecution } from './core/cmsisTasks';
import { commandLineMatches, TerminalOutput } from './core/runOutput';
import { logger } from './utils/logger';
import type { CmsisJobTracker, LiveExecution, TrackerClock } from './cmsisJobTracker';

/** A shell execution as the capture reads it: its command line, and the data its terminal receives. */
export interface ShellExecutionLike {
    readonly commandLine?: { readonly value?: string };
    read(): AsyncIterable<string>;
}

/** A subscription in the shape of `vscode.Event`. */
type Listen<T> = (listener: (event: T) => unknown) => { dispose(): unknown };

/** Where the capture hears of shell executions: `vscode.window`, or a fake; missing in the transport stubs. */
export interface ShellExecutionSource {
    onDidStartTerminalShellExecution?: Listen<{ readonly execution: ShellExecutionLike }>;
}

/** What a reply reads of the capture. */
export interface RunOutputSource {
    /** The output of the CMSIS Run with this tracker key, when its terminal was captured. */
    outputOf(key: number): TerminalOutput | undefined;
    /** Resolves once all of that output has arrived, or after `ms` on the tracker's clock. */
    whenComplete(key: number, ms: number): Promise<void>;
}

/** A shell execution is paired with a CMSIS Run that the tracker sees within this long of it, before or after. */
export const MATCH_WINDOW_MS = 5_000;
/** The output of this many Runs is kept, the newest. */
export const KEPT_RUNS = 4;
/** A reply waits at most this long for the rest of the output of a Run that ended; it comes within milliseconds. */
export const OUTPUT_SETTLE_MS = 1_000;

/** One shell execution and what its terminal received. */
interface Capture {
    readonly commandLine: string;
    readonly seenAt: number;
    readonly output: TerminalOutput;
    readonly waiters: Set<() => void>;
    /** The tracker key of the CMSIS Run it belongs to, once paired. */
    key?: number;
}

/** A CMSIS Run the tracker saw before its shell execution. */
interface WaitingRun {
    readonly key: number;
    readonly words: readonly string[];
    readonly seenAt: number;
}

/** The part of the tracker the capture reads. */
type RunSightings = Pick<CmsisJobTracker, 'onDidStartExecution' | 'commandOf'>;

export class RunOutputCapture implements RunOutputSource {
    private unmatched: Capture[] = [];
    private waiting: WaitingRun[] = [];
    private readonly byKey = new Map<number, Capture>();
    private readonly subscriptions: Array<{ dispose(): unknown }> = [];

    constructor(private readonly tracker: RunSightings, source: ShellExecutionSource, private readonly clock: TrackerClock) {
        const started = source.onDidStartTerminalShellExecution;
        if (typeof started === 'function') {
            try {
                this.subscriptions.push(started((event) => this.started(event.execution)));
            } catch (caught) {
                logger.warn('CMSIS Run output: could not subscribe to the terminal shell executions', caught);
            }
        }
        this.subscriptions.push(tracker.onDidStartExecution((live) => this.runStarted(live)));
    }

    outputOf(key: number): TerminalOutput | undefined {
        return this.byKey.get(key)?.output;
    }

    whenComplete(key: number, ms: number): Promise<void> {
        const capture = this.byKey.get(key);
        if (!capture || capture.output.complete || ms <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let cancel: () => void = () => undefined;
            const wake = (): void => {
                capture.waiters.delete(wake);
                cancel();
                resolve();
            };
            capture.waiters.add(wake);
            cancel = this.clock.startTimer(ms, wake);
        });
    }

    dispose(): void {
        for (const subscription of this.subscriptions.splice(0)) {
            try {
                subscription.dispose();
            } catch {
                // A failing dispose must not keep the others.
            }
        }
        for (const capture of this.byKey.values()) {
            for (const wake of [...capture.waiters]) {
                wake();
            }
        }
    }

    /** A terminal's command started: read its data at once, since only data after the first `read()` is streamed. */
    private started(execution: ShellExecutionLike): void {
        const now = this.clock.now();
        this.prune(now);
        const capture: Capture = {
            commandLine: typeof execution.commandLine?.value === 'string' ? execution.commandLine.value : '',
            seenAt: now, output: new TerminalOutput(), waiters: new Set(),
        };
        let stream: AsyncIterable<string>;
        try {
            stream = execution.read();
        } catch (caught) {
            logger.debug('CMSIS Run output: a terminal command could not be read', caught);
            return;
        }
        void this.drain(capture, stream);
        const run = [...this.waiting].reverse().find((candidate) => commandLineMatches(capture.commandLine, candidate.words));
        if (run) {
            this.waiting = this.waiting.filter((candidate) => candidate !== run);
            this.pair(capture, run.key);
        } else {
            this.unmatched.push(capture);
        }
    }

    /** A CMSIS Run started: pair it with the newest execution of its command line, or wait for that. */
    private runStarted(live: LiveExecution): void {
        if (live.kind !== 'run' || live.seeded) {
            return;
        }
        // A task without a command line runs in a pseudoterminal, which VS Code reports to no one.
        const words = this.tracker.commandOf(live.key);
        if (!words || words.length === 0) {
            return;
        }
        const now = this.clock.now();
        this.prune(now);
        const capture = [...this.unmatched].reverse().find((candidate) => commandLineMatches(candidate.commandLine, words));
        if (capture) {
            this.unmatched = this.unmatched.filter((candidate) => candidate !== capture);
            this.pair(capture, live.key);
        } else {
            this.waiting.push({ key: live.key, words, seenAt: now });
        }
    }

    private pair(capture: Capture, key: number): void {
        capture.key = key;
        this.byKey.set(key, capture);
        logger.debug(`CMSIS Run output: reading the terminal of '${capture.commandLine}'`);
        for (const oldest of [...this.byKey.keys()].slice(0, Math.max(0, this.byKey.size - KEPT_RUNS))) {
            this.byKey.delete(oldest);
        }
    }

    /** What the terminal receives goes into the capture while it is paired, or may still be; the end of the stream completes it. */
    private async drain(capture: Capture, stream: AsyncIterable<string>): Promise<void> {
        try {
            for await (const data of stream) {
                if (capture.key !== undefined || this.clock.now() - capture.seenAt <= MATCH_WINDOW_MS) {
                    capture.output.append(data);
                }
            }
        } catch (caught) {
            logger.debug('CMSIS Run output: reading a terminal stopped', caught);
        }
        capture.output.finish();
        for (const wake of [...capture.waiters]) {
            wake();
        }
    }

    /** Executions no Run claimed in time, and Runs no execution claimed, are let go. */
    private prune(now: number): void {
        this.unmatched = this.unmatched.filter((capture) => now - capture.seenAt <= MATCH_WINDOW_MS);
        this.waiting = this.waiting.filter((run) => now - run.seenAt <= MATCH_WINDOW_MS);
    }
}

/** The capture of each tracker that has one. */
const captures = new WeakMap<object, RunOutputCapture>();

/** Attach a capture to `tracker`, which `runOutputOf` then finds; dispose it with the tracker. */
export function attachRunOutput(tracker: CmsisJobTracker, source: ShellExecutionSource, clock: TrackerClock): { dispose(): void } {
    const capture = new RunOutputCapture(tracker, source, clock);
    captures.set(tracker, capture);
    return {
        dispose: () => {
            if (captures.get(tracker) === capture) {
                captures.delete(tracker);
            }
            capture.dispose();
        },
    };
}

/** The capture attached to `tracker`; undefined when it has none. */
export function runOutputOf(tracker: CmsisJobTracker): RunOutputSource | undefined {
    return captures.get(tracker);
}

/**
 * The output of the CMSIS Run of each of `jobs` for a reply, once every Run
 * that ended has all of its output, its end is `OUTPUT_SETTLE_MS` past at
 * `now` (the tracker's clock), or `waitMs` has passed: an output whose end
 * VS Code never reports (a terminated task) delays no later reply. Undefined
 * when the tracker has no capture.
 */
export async function runOutputsOf(
    tracker: CmsisJobTracker,
    jobs: readonly Job[],
    now: number,
    waitMs: number,
): Promise<((execution: JobExecution) => TerminalOutput | undefined) | undefined> {
    const capture = runOutputOf(tracker);
    if (!capture) {
        return undefined;
    }
    const waits: Array<Promise<void>> = [];
    for (const run of jobs.map((job) => executionIn(job, 'run'))) {
        const endedAt = run?.processEndedAt ?? run?.endedAt;
        if (run && endedAt !== undefined) {
            waits.push(capture.whenComplete(run.key, Math.min(waitMs, OUTPUT_SETTLE_MS - (now - endedAt))));
        }
    }
    await Promise.all(waits);
    return (execution) => capture.outputOf(execution.key);
}

/** `vscode.window`'s shell executions, where the API has them: the transport stubs do not. */
export function vscodeShellSource(): ShellExecutionSource {
    const window: Partial<typeof vscode.window> | undefined = vscode.window;
    const started = window?.onDidStartTerminalShellExecution;
    return { onDidStartTerminalShellExecution: typeof started === 'function' ? started : undefined };
}
