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

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CmsisJobTracker, JOB_RETENTION_MS, LABEL_FETCH_MS } from '../cmsisJobTracker';
import { executionIn, Job } from '../core/cmsisTasks';
import { formatDuration, idleStatus, sessionTaskLine } from '../handler/jobText';
import { FakeExecution, FakeTasks, FixtureTask, loadTaskFixtures, ManualClock, workspaceTasks } from './cmsisTaskFixtures';

/**
 * The window's CMSIS job tracker (#47, #46, #12) over a fake `vscode.tasks`
 * and a clock moved by hand: correlation of executions and jobs, adoption,
 * retention, deadlines, probe owners, the stop wait and the label
 * pre-check. The handler's use of it is tested with the handler.
 */

const shell = (name: string): FixtureTask => ({ name, source: 'Workspace', definition: { type: 'shell' } });
const BUILD: FixtureTask = { name: 'cbuild Blinky.csolution.yml --active MPS3', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } };
const SETUP: FixtureTask = { name: 'cbuild setup Blinky.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build', setup: true } };

function world(withTaskEvents = true): { tasks: FakeTasks; clock: ManualClock; tracker: CmsisJobTracker; log: string[] } {
    const tasks = new FakeTasks(withTaskEvents);
    const clock = new ManualClock(1_000);
    const log: string[] = [];
    return { tasks, clock, tracker: new CmsisJobTracker(tasks, clock, (line) => log.push(line)), log };
}

suite('CmsisJobTracker', () => {

    suite('replays the CMSIS Solution 1.70.1 task sequences', () => {
        for (const fixture of loadTaskFixtures()) {
            test(fixture.file, () => {
                const { tasks, clock, tracker } = world();
                const executions = new Map<string, FakeExecution>(
                    Object.entries(fixture.tasks).map(([name, task]) => [name, tasks.execution(task)]));
                const base = clock.now();
                const job = tracker.begin(fixture.action, 'NUCLEO-F401RE');
                for (const step of fixture.events) {
                    clock.advance(base + step.at);
                    const execution = step.task ? executions.get(step.task) : undefined;
                    switch (step.event) {
                        case 'issued':
                            tracker.issued(job.id);
                            break;
                        case 'commandReturned':
                            tracker.identify(job.id, execution);
                            break;
                        case 'tick':
                        case 'stopRun':
                            break;
                        default:
                            tasks.emit(step.event, execution as FakeExecution, step.exitCode);
                    }
                }
                const final = tracker.job(job.id);
                assert.strictEqual(final?.state, fixture.expect.state, fixture.description);
                if (fixture.expect.decidedBy) {
                    const decided = final?.executions.find((execution) => execution.key === final.decidedBy);
                    assert.strictEqual(decided?.name, fixture.tasks[fixture.expect.decidedBy].name);
                }
                if (fixture.expect.endedAfterStop) {
                    assert.deepStrictEqual(tracker.liveExecutions(), [], 'nothing is alive after the stop');
                    assert.deepStrictEqual(tracker.probeOwners(), []);
                }
            });
        }
    });

    suite('correlation', () => {
        test('an execution alive before begin never completes the job; the next one of its kind does', () => {
            const { tasks, clock, tracker } = world();
            const earlier = tasks.start(tasks.execution(BUILD));
            const adopted = tracker.inFlight('build');
            assert.strictEqual(adopted?.origin, 'adopted', 'a build started elsewhere is followed as a job');
            const job = tracker.begin('build', 'MPS3');
            tracker.issued(job.id);
            clock.advance(2_000);
            tasks.finish(earlier, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'armed', 'the earlier build ended; it is not this job\'s');
            assert.strictEqual(tracker.job(adopted?.id ?? '')?.state, 'ok', 'the adopted job settles with its own build');
            const ours = tasks.start(tasks.execution(BUILD));
            clock.advance(3_000);
            tasks.finish(ours, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
        });

        test('a cbuild setup is noted, never adopted and never the result', () => {
            const { tasks, tracker } = world();
            const job = tracker.begin('build', undefined);
            const setup = tasks.start(tasks.execution(SETUP));
            tasks.finish(setup, undefined);
            assert.strictEqual(tracker.inFlight('build')?.id, job.id, 'no job was adopted for the setup');
            const current = tracker.job(job.id) as Job;
            assert.strictEqual(current.state, 'armed');
            assert.deepStrictEqual(current.executions.map((execution) => [execution.kind, execution.role]), [['setup', undefined]]);
        });

        test('the build the command returns is bound even when its start was not seen', () => {
            const { tasks, tracker } = world();
            const job = tracker.begin('build', undefined);
            const returned = tasks.execution(BUILD);
            tracker.identify(job.id, returned);
            assert.strictEqual(executionIn(tracker.job(job.id) as Job, 'main')?.name, BUILD.name);
            tasks.emit('onDidStartTaskProcess', returned);
            tasks.emit('onDidEndTaskProcess', returned, 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
            tracker.identify(job.id, 'not an execution');
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
        });

        test('with process events only (the transport stubs) a fresh wrapper per event still finds its execution', () => {
            const { tasks, tracker } = world(false);
            const job = tracker.begin('load', undefined);
            const task = shell('CMSIS Load');
            tasks.emit('onDidStartTaskProcess', tasks.execution(task));
            tasks.emit('onDidEndTaskProcess', tasks.execution(task), 1);
            const final = tracker.job(job.id) as Job;
            assert.strictEqual(final.state, 'failed');
            assert.strictEqual(executionIn(final, 'main')?.exitCode, 1);
        });

        test('a label that matches only when case is ignored is used and logged', () => {
            const { tasks, tracker, log } = world();
            const job = tracker.begin('erase', undefined);
            tasks.finish(tasks.start(tasks.execution({ name: 'cmsis erase', source: 'Workspace', definition: { type: 'shell' } })), 0);
            assert.strictEqual(tracker.job(job.id)?.state, 'ok');
            assert.ok(log.some((line) => line.includes('taken as erase by a case-insensitive label match')), log.join('\n'));
        });

        test('executions alive when the tracker starts are known, without a start time', () => {
            const tasks = new FakeTasks();
            const run = tasks.execution(shell('CMSIS Run'));
            tasks.alive.push(run);
            const tracker = new CmsisJobTracker(tasks, new ManualClock());
            assert.deepStrictEqual(tracker.probeOwners(), [{ name: 'CMSIS Run', kind: 'run', startedAt: undefined }]);
            assert.strictEqual(tracker.liveExecutions()[0].seeded, true);
            tracker.dispose();
            assert.strictEqual(tasks.listenerCount(), 0, 'dispose drops the listeners');
        });
    });

    suite('deadlines, retention and notification', () => {
        test('waitFor resolves at the deadline with the job as it is, and at once when it settles first', async () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('load', undefined);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            const pending = tracker.waitFor(job.id, clock.now() + 5_000);
            clock.advance(clock.now() + 5_000);
            assert.strictEqual((await pending)?.state, 'started');
            const second = tracker.waitFor(job.id, clock.now() + 60_000);
            tasks.finish(load, 0);
            assert.strictEqual((await second)?.state, 'ok');
            assert.strictEqual(clock.pendingTimers(), 0, 'the waiter\'s timer was cancelled');
            assert.strictEqual((await tracker.waitFor(job.id, 0))?.state, 'ok');
        });

        test('nothing started 10 s after issue settles as not-started without any event', async () => {
            const { clock, tracker } = world();
            const job = tracker.begin('load', undefined);
            tracker.issued(job.id);
            const pending = tracker.waitFor(job.id, clock.now() + 60_000);
            clock.advance(clock.now() + 10_000);
            assert.strictEqual((await pending)?.state, 'not-started');
        });

        test('load_and_run turns running-ok 2 s after Run\'s process started, on the clock alone', () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('load_and_run', undefined);
            tasks.start(tasks.execution(shell('CMSIS Load+Run')), false);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            tasks.finish(load, 0);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 1_999);
            assert.strictEqual(tracker.job(job.id)?.state, 'started');
            clock.advance(clock.now() + 1);
            assert.strictEqual(tracker.job(job.id)?.state, 'running-ok');
        });

        test(`settled jobs are kept ${JOB_RETENTION_MS / 60_000} min; open ones are never dropped`, () => {
            const { tasks, clock, tracker } = world();
            const job = tracker.begin('erase', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Erase'))), 0);
            const open = tracker.begin('build', undefined);
            const settledAt = clock.now();
            clock.advance(settledAt + JOB_RETENTION_MS);
            assert.strictEqual(tracker.last('erase')?.id, job.id);
            clock.advance(settledAt + JOB_RETENTION_MS + 1);
            assert.strictEqual(tracker.last('erase'), undefined);
            assert.strictEqual(tracker.inFlight()?.id, open.id);
        });

        test('onDidFinishJob hears each job once, when it settles', () => {
            const { tasks, tracker } = world();
            const heard: string[] = [];
            const subscription = tracker.onDidFinishJob((job) => heard.push(`${job.id}:${job.state}`));
            const job = tracker.begin('load', undefined);
            const load = tasks.start(tasks.execution(shell('CMSIS Load')));
            tasks.emit('onDidEndTaskProcess', load, 0);
            tasks.emit('onDidEndTask', load);
            subscription.dispose();
            tasks.finish(tasks.start(tasks.execution(BUILD)), 0);
            assert.deepStrictEqual(heard, [`${job.id}:ok`]);
        });

        test('discard forgets an open job and wakes its waiters', async () => {
            const { clock, tracker } = world();
            const job = tracker.begin('load_and_debug', undefined);
            const pending = tracker.waitFor(job.id, clock.now() + 30_000);
            tracker.discard(job.id);
            assert.strictEqual((await pending)?.id, job.id);
            assert.strictEqual(tracker.job(job.id), undefined);
            assert.strictEqual(tracker.inFlight(), undefined);
        });
    });

    suite('the probe and stop_run', () => {
        test('probe owners are the live Run, Load+Run, Load, Erase and TargetInfo, and this window\'s flash', () => {
            const { tasks, clock, tracker } = world();
            tasks.start(tasks.execution(BUILD));
            tasks.start(tasks.execution(shell('CMSIS Run')));
            const release = tracker.beginFlash();
            assert.deepStrictEqual(tracker.probeOwners(), [
                { name: 'CMSIS Run', kind: 'run', startedAt: clock.now() },
                { name: 'flash', kind: 'flash', startedAt: clock.now() },
            ]);
            release();
            assert.deepStrictEqual(tracker.probeOwners().map((owner) => owner.kind), ['run']);
        });

        test('waitForEnd reports the executions that ignore terminate()', async () => {
            const { tasks, clock, tracker } = world();
            const run = tasks.start(tasks.execution(shell('CMSIS Run'), true));
            const loadRun = tasks.start(tasks.execution(shell('CMSIS Load+Run')), false);
            const stoppable = tracker.stoppableExecutions();
            assert.deepStrictEqual(stoppable.map((execution) => execution.task.name), ['CMSIS Run', 'CMSIS Load+Run']);
            loadRun.terminate();
            run.terminate();
            const pending = tracker.waitForEnd(stoppable, 3_000);
            clock.advance(clock.now() + 3_000);
            const report = await pending;
            assert.deepStrictEqual(report.alive, [run]);
            assert.ok(report.endedAt.has(loadRun));
            assert.strictEqual(run.terminateCalls, 1);
        });
    });

    suite('label pre-check', () => {
        let folder: string;
        setup(() => {
            folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-labels-'));
        });
        teardown(() => fs.rmSync(folder, { recursive: true, force: true }));

        test('the labels of the folder\'s Workspace tasks, cached until tasks.json changes', async () => {
            const { tasks, tracker } = world();
            tasks.fetched = [
                ...workspaceTasks(folder, ['CMSIS Load', 'CMSIS Run']),
                ...workspaceTasks(path.join(folder, 'other'), ['CMSIS Erase']),
                { name: 'CMSIS Load+Run', source: 'Arm Debugger', scope: { uri: { fsPath: folder } } },
            ];
            assert.deepStrictEqual([...(await tracker.taskLabels(folder)) ?? []], ['CMSIS Load', 'CMSIS Run']);
            await tracker.taskLabels(folder);
            assert.strictEqual(tasks.fetchCount, 1, 'cached');
            fs.mkdirSync(path.join(folder, '.vscode'));
            fs.writeFileSync(path.join(folder, '.vscode', 'tasks.json'), '{}');
            tasks.fetched = workspaceTasks(folder, ['CMSIS Load+Run']);
            assert.deepStrictEqual([...(await tracker.taskLabels(folder)) ?? []], ['CMSIS Load+Run']);
            assert.strictEqual(tasks.fetchCount, 2, 'fetched again after tasks.json changed');
        });

        test('no answer when fetchTasks fails or takes longer than 3 s', async () => {
            const { tasks, clock, tracker } = world();
            tasks.fetched = undefined;
            assert.strictEqual(await tracker.taskLabels(folder), undefined);
            tasks.fetchTasks = () => new Promise(() => undefined);
            const slow = tracker.taskLabels(folder);
            clock.advance(clock.now() + LABEL_FETCH_MS);
            assert.strictEqual(await slow, undefined);
            const bare = new CmsisJobTracker({}, clock);
            assert.strictEqual(await bare.taskLabels(folder), undefined, 'a source without fetchTasks gives no answer');
        });
    });

    suite('texts', () => {
        test('durations read as 0.6 s, 9 s, 140 s, 3 min and 2 h', () => {
            assert.deepStrictEqual([600, 9_400, 140_000, 180_000, 7_200_000 * 1.5].map(formatDuration), ['0.6 s', '9 s', '140 s', '3 min', '3 h']);
            assert.strictEqual(formatDuration(-5), '0.0 s');
        });

        test('the get_session_status line: live tasks and recent results; nothing to say is no line', () => {
            const { tasks, clock, tracker } = world();
            assert.strictEqual(sessionTaskLine(tracker.recent(), tracker.liveExecutions(), clock.now()), undefined);
            tracker.begin('load', 'HP@debug');
            tasks.finish(tasks.start(tasks.execution(shell('CMSIS Load'))), 0);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 180_000);
            assert.strictEqual(sessionTaskLine(tracker.recent(), tracker.liveExecutions(), clock.now()),
                'CMSIS tasks: \'CMSIS Run\' alive 3 min (holds the probe); last load ✅ 3 min ago');
        });

        test('status without a job in flight: the recent results and the live tasks, or that there is nothing', () => {
            const { tasks, clock, tracker } = world();
            assert.strictEqual(idleStatus(tracker.recent(), tracker.liveExecutions(), clock.now()),
                'No CMSIS job in this window: nothing is in flight and nothing finished in the last 10 min.\n'
                + 'No CMSIS task is running in this window.');
            const job = tracker.begin('build', 'MPS3');
            tasks.finish(tasks.start(tasks.execution(BUILD)), 2);
            tasks.start(tasks.execution(shell('CMSIS Run')));
            clock.advance(clock.now() + 5_000);
            assert.strictEqual(idleStatus(tracker.recent(), tracker.liveExecutions(), clock.now()),
                `No CMSIS job in flight in this window. Last results (10 min): build on MPS3 ❌ exit 2 5 s ago (job ${job.id}, '${BUILD.name}').\n`
                + 'CMSIS tasks running: \'CMSIS Run\' for 5 s (holds the probe). cmsis_action {action:\'stop_run\'} ends them.');
        });
    });
});
