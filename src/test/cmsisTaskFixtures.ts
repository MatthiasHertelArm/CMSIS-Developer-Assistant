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
 * Helpers of the CMSIS task tests: the recorded task sequences under
 * `src/test/fixtures/cmsisTasks/` (derived from the installed CMSIS Solution
 * 1.70.1 and 1.72.0, see each file's `derivedFrom`), a fake `vscode.tasks` that fires
 * their events, a fake of VS Code's terminal shell executions, and a clock
 * the test moves by hand.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecutionLike, FetchedTask, TaskEventSource, TrackerClock } from '../cmsisJobTracker';
import { armJob, classifyCmsisTask, Job, JobAction, JobEvent, reduceJob } from '../core/cmsisTasks';
import { runTaskKind } from '../core/gdbServerPorts';
import type { ShellExecutionLike, ShellExecutionSource } from '../runOutputCapture';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'cmsisTasks');

/** A task as a fixture describes it. */
export interface FixtureTask {
    name: string;
    source: string;
    definition: { type: string; setup?: boolean; clean?: boolean; rebuild?: boolean; [key: string]: unknown };
    /** `vscode.Task.execution`: what a shell task runs (`command` and `args`). */
    execution?: unknown;
}

export interface FixtureEvent {
    at: number;
    event: 'issued' | 'onDidStartTask' | 'onDidStartTaskProcess' | 'onDidEndTaskProcess' | 'onDidEndTask'
        | 'commandReturned' | 'tick' | 'stopRun';
    task?: string;
    exitCode?: number;
}

export interface TaskFixture {
    file: string;
    description: string;
    action: JobAction;
    tasks: Record<string, FixtureTask>;
    events: FixtureEvent[];
    expect: { state: string; decidedBy?: string; exitCode?: number; bystanders?: string[]; endedAfterStop?: string[] };
}

/** Every fixture, by file name. */
export function loadTaskFixtures(): TaskFixture[] {
    return fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort().map((file) => ({
        file,
        ...(JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8')) as Omit<TaskFixture, 'file'>),
    }));
}

/**
 * Fold a fixture through `reduceJob` the way the tracker does: one key per
 * task, only CMSIS tasks reported, the job armed at 0.
 */
export function replayThroughReducer(fixture: TaskFixture): { job: Job; keys: Map<string, number> } {
    const keys = new Map<string, number>(Object.keys(fixture.tasks).map((name, index) => [name, index + 1]));
    let job = armJob({ id: 'x-1', action: fixture.action, origin: 'call', at: 0, preexisting: [] });
    for (const step of fixture.events) {
        const event = toJobEvent(fixture, step, keys);
        if (event) {
            job = reduceJob(job, event);
        }
    }
    return { job, keys };
}

function toJobEvent(fixture: TaskFixture, step: FixtureEvent, keys: Map<string, number>): JobEvent | undefined {
    if (step.event === 'issued' || step.event === 'tick') {
        return { type: step.event, at: step.at };
    }
    if (step.event === 'stopRun' || step.task === undefined) {
        return undefined;
    }
    const task = fixture.tasks[step.task];
    const kind = classifyCmsisTask({
        name: task.name, source: task.source, type: task.definition.type, setup: task.definition.setup === true,
        clean: task.definition.clean === true, rebuild: task.definition.rebuild === true,
    });
    const key = keys.get(step.task) ?? 0;
    if (!kind) {
        return undefined;
    }
    // As the tracker marks a CMSIS Run: what its command line says it runs, a GDB server or the FVP model.
    const runKind = kind === 'run' ? runTaskKind(task) : undefined;
    const marked = runKind ? { runKind } : {};
    switch (step.event) {
        case 'onDidStartTask':
            return { type: 'taskStart', key, name: task.name, kind, at: step.at, ...marked };
        case 'onDidStartTaskProcess':
            return { type: 'processStart', key, name: task.name, kind, at: step.at, ...marked };
        case 'commandReturned':
            return { type: 'identity', key, name: task.name, kind, at: step.at };
        case 'onDidEndTaskProcess':
            return { type: 'processEnd', key, exitCode: step.exitCode, at: step.at };
        case 'onDidEndTask':
            return { type: 'taskEnd', key, at: step.at };
    }
}

/** A clock that moves only when the test says so; due timers fire in order. */
export class ManualClock implements TrackerClock {
    private time = 0;
    private sequence = 0;
    private timers: Array<{ due: number; fire: () => void; id: number }> = [];

    constructor(start = 0) {
        this.time = start;
    }

    now(): number {
        return this.time;
    }

    startTimer(ms: number, fire: () => void): () => void {
        const id = ++this.sequence;
        this.timers.push({ due: this.time + Math.max(0, ms), fire, id });
        return () => {
            this.timers = this.timers.filter((timer) => timer.id !== id);
        };
    }

    /** Move to `to`, firing every timer due on the way. */
    advance(to: number): void {
        for (;;) {
            const due = this.timers.filter((timer) => timer.due <= to).sort((a, b) => a.due - b.due || a.id - b.id)[0];
            if (!due) {
                break;
            }
            this.timers = this.timers.filter((timer) => timer.id !== due.id);
            this.time = Math.max(this.time, due.due);
            due.fire();
        }
        this.time = Math.max(this.time, to);
    }

    pendingTimers(): number {
        return this.timers.length;
    }
}

/** A task execution of the fake; `stubborn` ones ignore `terminate()`. */
export class FakeExecution implements ExecutionLike {
    terminateCalls = 0;

    constructor(
        readonly task: FixtureTask,
        private readonly owner: FakeTasks,
        readonly stubborn = false,
    ) {}

    terminate(): void {
        this.terminateCalls++;
        if (!this.stubborn) {
            this.owner.onTerminate(this);
        }
    }
}

type Listener<T> = (event: T) => unknown;

/** `vscode.tasks` as far as the tracker uses it, fired by hand. */
export class FakeTasks implements TaskEventSource {
    readonly alive: FakeExecution[] = [];
    /** The tasks `fetchTasks` lists; undefined makes it reject. */
    fetched: FetchedTask[] | undefined = [];
    fetchCount = 0;
    /** Set to end terminated executions only when the test says so. */
    terminateEndsProcess = true;
    private readonly listeners = {
        start: new Set<Listener<{ execution: ExecutionLike }>>(),
        processStart: new Set<Listener<{ execution: ExecutionLike }>>(),
        processEnd: new Set<Listener<{ execution: ExecutionLike; exitCode?: number }>>(),
        end: new Set<Listener<{ execution: ExecutionLike }>>(),
    };

    constructor(private readonly withTaskEvents = true) {}

    get onDidStartTask(): TaskEventSource['onDidStartTask'] {
        return this.withTaskEvents ? (listener) => this.subscribe(this.listeners.start, listener) : undefined;
    }

    get onDidEndTask(): TaskEventSource['onDidEndTask'] {
        return this.withTaskEvents ? (listener) => this.subscribe(this.listeners.end, listener) : undefined;
    }

    onDidStartTaskProcess: TaskEventSource['onDidStartTaskProcess'] = (listener) => this.subscribe(this.listeners.processStart, listener);
    onDidEndTaskProcess: TaskEventSource['onDidEndTaskProcess'] = (listener) => this.subscribe(this.listeners.processEnd, listener);

    taskExecutions(): readonly ExecutionLike[] {
        return [...this.alive];
    }

    fetchTasks(): Thenable<readonly FetchedTask[]> {
        this.fetchCount++;
        return this.fetched ? Promise.resolve(this.fetched) : Promise.reject(new Error('fetchTasks failed'));
    }

    execution(task: FixtureTask, stubborn = false): FakeExecution {
        return new FakeExecution(task, this, stubborn);
    }

    /** Task start and process start, as a shell task begins. */
    start(execution: FakeExecution, withProcess = true): FakeExecution {
        this.emit('onDidStartTask', execution);
        if (withProcess) {
            this.emit('onDidStartTaskProcess', execution);
        }
        return execution;
    }

    /** Process end with its exit code, then task end. */
    finish(execution: FakeExecution, exitCode: number | undefined, withProcess = true): void {
        if (withProcess) {
            this.emit('onDidEndTaskProcess', execution, exitCode);
        }
        this.emit('onDidEndTask', execution);
    }

    /** One event, as VS Code would fire it; the alive list follows the task start and end. */
    emit(event: 'onDidStartTask' | 'onDidStartTaskProcess' | 'onDidEndTaskProcess' | 'onDidEndTask', execution: FakeExecution, exitCode?: number): void {
        switch (event) {
            case 'onDidStartTask':
                if (!this.alive.includes(execution)) {
                    this.alive.push(execution);
                }
                this.fire(this.listeners.start, { execution });
                break;
            case 'onDidStartTaskProcess':
                if (!this.alive.includes(execution)) {
                    this.alive.push(execution);
                }
                this.fire(this.listeners.processStart, { execution });
                break;
            case 'onDidEndTaskProcess':
                this.fire(this.listeners.processEnd, { execution, exitCode });
                if (!this.withTaskEvents) {
                    this.drop(execution);
                }
                break;
            case 'onDidEndTask':
                this.drop(execution);
                this.fire(this.listeners.end, { execution });
                break;
        }
    }

    private drop(execution: FakeExecution): void {
        const index = this.alive.indexOf(execution);
        if (index >= 0) {
            this.alive.splice(index, 1);
        }
    }

    onTerminate(execution: FakeExecution): void {
        if (this.terminateEndsProcess) {
            this.finish(execution, undefined);
        }
    }

    listenerCount(): number {
        return Object.values(this.listeners).reduce((sum, set) => sum + set.size, 0);
    }

    private subscribe<T>(set: Set<Listener<T>>, listener: Listener<T>): { dispose(): void } {
        set.add(listener);
        return { dispose: () => set.delete(listener) };
    }

    private fire<T>(set: Set<Listener<T>>, event: T): void {
        for (const listener of [...set]) {
            listener(event);
        }
    }
}

/** Tasks as a pyOCD solution's tasks.json lists them through fetchTasks, scoped to `folder`. */
export function workspaceTasks(folder: string, labels: readonly string[]): FetchedTask[] {
    return labels.map((name) => ({ name, source: 'Workspace', scope: { uri: { fsPath: folder } } }));
}

/**
 * A terminal command as VS Code reports it (`TerminalShellExecution`): the
 * test writes what the terminal receives and ends it; `read()` streams the
 * data written after it was first called, as VS Code's does.
 */
export class FakeShellExecution implements ShellExecutionLike {
    readonly commandLine: { value: string };
    private readonly queued: string[] = [];
    private ended = false;
    private reading = false;
    private wake: (() => void) | undefined;

    constructor(commandLine: string) {
        this.commandLine = { value: commandLine };
    }

    read(): AsyncIterable<string> {
        this.reading = true;
        const queued = this.queued;
        const self = this;
        return {
            async *[Symbol.asyncIterator](): AsyncGenerator<string> {
                for (;;) {
                    while (queued.length > 0) {
                        yield queued.shift() as string;
                    }
                    if (self.ended) {
                        return;
                    }
                    await new Promise<void>((resolve) => {
                        self.wake = resolve;
                    });
                    self.wake = undefined;
                }
            },
        };
    }

    /** Data the terminal receives; lost unless someone reads. */
    write(data: string): void {
        if (this.reading && !this.ended) {
            this.queued.push(data);
            this.wake?.();
        }
    }

    /** The command ended: the stream ends after the data written so far. */
    end(): void {
        this.ended = true;
        this.wake?.();
    }
}

/** `vscode.window`'s terminal shell executions, started by hand. */
export class FakeShell implements ShellExecutionSource {
    private readonly listeners = new Set<(event: { execution: ShellExecutionLike }) => unknown>();

    onDidStartTerminalShellExecution: ShellExecutionSource['onDidStartTerminalShellExecution'] = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    /** A command starts in a terminal, with this command line. */
    start(commandLine: string): FakeShellExecution {
        const execution = new FakeShellExecution(commandLine);
        for (const listener of [...this.listeners]) {
            listener({ execution });
        }
        return execution;
    }

    listenerCount(): number {
        return this.listeners.size;
    }
}

/** Lets the async iterators of fake shell executions run. */
export async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
    }
}
