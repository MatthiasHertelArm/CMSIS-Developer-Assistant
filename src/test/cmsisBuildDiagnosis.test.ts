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
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachBuildDiagnosis, DiagnosisHost, DiagnosticChild, DiagnosticSpawnOptions } from '../cmsisBuildDiagnosis';
import { CmsisJobTracker } from '../cmsisJobTracker';
import { DIAGNOSTIC_RERUN_CAP_MS } from '../core/buildFailure';
import type { Job } from '../core/cmsisTasks';
import { idleStatus, jobResult } from '../handler/jobText';
import { ToolError } from '../core/toolResult';
import { FakeExecution, FakeTasks, FixtureTask, ManualClock } from './cmsisTaskFixtures';

/**
 * The runner of #15 over a tracker fed with fake task events: which stage
 * answers, the re-run's command line and guards (the cap, a build that
 * starts meanwhile, a build already running, no environment file, the
 * setting), and how the lines reach a waiting call and `status`. cbuild is a
 * fake: the test writes its log and ends it.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildinfo');
const GCC_LOG = fs.readFileSync(path.join(FIXTURES, 'build-failed-gcc.log'), 'utf8');
const IDX = fs.readFileSync(path.join(FIXTURES, 'Blinky.cbuild-idx.yml'), 'utf8');

/** A cbuild that does nothing until the test ends it. */
class FakeChild extends EventEmitter implements DiagnosticChild {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    killed = 0;

    constructor(readonly pid: number | undefined, readonly command: string, readonly args: readonly string[], readonly options: DiagnosticSpawnOptions) {
        super();
    }

    kill(): boolean {
        this.killed++;
        return true;
    }

    /** cbuild prints, writes its log and exits. */
    finish(code: number | null, log?: string, printed = ''): void {
        if (log !== undefined) {
            const logFile = this.args[this.args.indexOf('--log') + 1];
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.writeFileSync(logFile, log);
        }
        if (printed) {
            this.stdout.emit('data', Buffer.from(printed));
        }
        this.emit('close', code);
    }
}

interface World {
    dir: string;
    solution: string;
    tasks: FakeTasks;
    clock: ManualClock;
    tracker: CmsisJobTracker;
    host: DiagnosisHost;
    children: FakeChild[];
    killed: FakeChild[];
    settings: { rerun: boolean; closeOnKill: boolean };
    dispose(): void;
}

/** A solution folder with (optionally) the environment file and a cbuild, a tracker, and the diagnosis attached to it. */
function world(options: { environment?: boolean; cbuild?: boolean } = {}): World {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cda-diagnosis-'));
    const solution = path.join(dir, 'Blinky.csolution.yml');
    fs.writeFileSync(solution, 'solution:\n');
    const bin = path.join(dir, 'toolbox', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (options.cbuild !== false) {
        fs.writeFileSync(path.join(bin, 'cbuild'), '');
    }
    if (options.environment !== false) {
        fs.mkdirSync(path.join(dir, '.cmsis'));
        fs.writeFileSync(path.join(dir, '.cmsis', 'tools-environment.yml'), [
            'cmsis-tools-environment:',
            '  environment:',
            '    path:',
            `      - ${bin.replace(/\\/g, '/')}`,
            '    variables:',
            '      GCC_TOOLCHAIN_14_3_1: /opt/gcc/bin',
            '  tools:',
            '    - name: CMSIS-Toolbox',
            '      version: 2.14.1',
            `      directory: ${bin.replace(/\\/g, '/')}`,
            '',
        ].join('\n'));
    }
    const tasks = new FakeTasks();
    const clock = new ManualClock(Date.now());
    const tracker = new CmsisJobTracker(tasks, clock);
    const children: FakeChild[] = [];
    const killed: FakeChild[] = [];
    const settings = { rerun: true, closeOnKill: true };
    const host: DiagnosisHost = {
        rerunEnabled: () => settings.rerun,
        solutionFile: async () => solution,
        activeTarget: async () => 'MPS3',
        outputDirectorySetting: () => undefined,
        packRoot: async () => '/packs',
        workingDirectory: () => dir,
        baseEnvironment: () => ({ PATH: '/usr/bin' }),
        platform: 'linux',
        spawn: (command, args, spawnOptions) => {
            const child = new FakeChild(4242 + children.length, command, args, spawnOptions);
            children.push(child);
            return child;
        },
        killTree: (child) => {
            killed.push(child as FakeChild);
            if (settings.closeOnKill) {
                setImmediate(() => (child as FakeChild).emit('close', null));
            }
        },
        clock,
    };
    const attached = attachBuildDiagnosis(tracker, host);
    return {
        dir, solution, tasks, clock, tracker, host, children, killed, settings,
        dispose: () => {
            attached.dispose();
            tracker.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

function buildTask(w: World, definition: Record<string, unknown> = {}): FixtureTask {
    return {
        name: 'cbuild Blinky.csolution.yml --active MPS3 --packs', source: 'cmsis-csolution.build',
        definition: {
            type: 'cmsis-csolution.build', solution: w.solution, schemaCheck: false, active: 'MPS3', clean: false, rebuild: false,
            setup: false, buildOutputVerbosity: 'normal', downloadPacks: true, cmakeTarget: 'all', ...definition,
        },
    };
}

/** Let promise chains and `setImmediate` callbacks run until `done` holds. */
async function until(done: () => boolean, what: string): Promise<void> {
    for (let round = 0; round < 200; round++) {
        if (done()) {
            return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail(`never happened: ${what}`);
}

/** A build job whose task starts and fails with `exitCode`; the diagnosis starts from its end. */
function failBuild(w: World, exitCode = 2, definition: Record<string, unknown> = {}): { job: Job; execution: FakeExecution } {
    const job = w.tracker.begin('build', 'MPS3');
    w.tracker.issued(job.id);
    const execution = w.tasks.start(w.tasks.execution(buildTask(w, definition)));
    w.clock.advance(w.clock.now() + 3_000);
    w.tasks.finish(execution, exitCode);
    return { job, execution };
}

async function diagnosed(w: World, id: string): Promise<Job> {
    await until(() => w.tracker.job(id)?.diagnosis?.state === 'done', 'the diagnosis is done');
    return w.tracker.job(id) as Job;
}

suite('build diagnosis (#15)', () => {
    let current: World | undefined;
    teardown(() => {
        current?.dispose();
        current = undefined;
    });
    const make = (options?: Parameters<typeof world>[0]): World => {
        current = world(options);
        return current;
    };

    test('a failed build is re-run once with --log and without --packs, and its log gives the lines', async () => {
        const w = make();
        const { job } = failBuild(w);
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending', 'the job carries a pending diagnosis at once');
        assert.ok(w.tracker.isCompleting(job.id));
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = path.join(w.dir, 'out', 'cmsis-developer-assistant', 'build-diagnostic.log');
        assert.strictEqual(child.command, path.posix.join(path.join(w.dir, 'toolbox', 'bin').replace(/\\/g, '/'), 'cbuild'));
        assert.deepStrictEqual(child.args, [w.solution, '--target', 'all', '--active', 'MPS3', '--log', logFile],
            'no fresh index, so the re-run converts again; no --packs, no --schema (schemaCheck false)');
        assert.strictEqual(child.options.shell, false);
        assert.strictEqual(child.options.cwd, w.dir);
        assert.strictEqual(child.options.env.CMSIS_PACK_ROOT, '/packs');
        assert.strictEqual(child.options.env.GCC_TOOLCHAIN_14_3_1, '/opt/gcc/bin');
        assert.ok(child.options.env.PATH.endsWith(':/usr/bin'), child.options.env.PATH);

        child.finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        const diagnosis = done.diagnosis;
        assert.ok(diagnosis);
        assert.strictEqual(diagnosis.source, 'rerun');
        assert.strictEqual(diagnosis.errorCount, 2);
        assert.strictEqual(diagnosis.warningCount, 1);
        assert.deepStrictEqual(diagnosis.errors[0], {
            severity: 'error', file: '/Users/dev/work/Blinky/Blinky/main.c', line: 42, column: 5, message: '\'ledx\' undeclared (first use in this function)',
        });
        assert.strictEqual(diagnosis.logFile, logFile);
        assert.match(diagnosis.text, /^2 errors \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1\):\n/);
        assert.ok(diagnosis.text.endsWith('Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).'), diagnosis.text);
        assert.strictEqual(w.tracker.isCompleting(job.id), false);
        assert.strictEqual(w.clock.pendingTimers(), 0, 'the cap timer was cancelled');
    });

    test('stage A: a fresh cbuild-idx.yml with errors answers without a re-run', async () => {
        const w = make();
        fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), IDX);
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0, 'nothing was re-run');
        assert.strictEqual(done.diagnosis?.source, 'csolution');
        assert.strictEqual(done.diagnosis?.errorCount, 2);
        assert.strictEqual(done.diagnosis?.warningCount, 4);
        assert.match(done.diagnosis?.text ?? '', /^2 errors from csolution \(Blinky\.cbuild-idx\.yml, context \.Debug\+MPS3\), 4 warnings:\n {2}error: component 'Compiler:CORE'/);
    });

    test('a fresh index without errors: the re-run skips the convert step, and csolution\'s warnings come along', async () => {
        const w = make();
        fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'),
            'build-idx:\n  cbuilds:\n    - cbuild: x.cbuild.yml\n      configuration: .Debug+MPS3\n      messages:\n        warnings:\n          - no compiler registered\n');
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.strictEqual(w.children[0].args[w.children[0].args.length - 1], '--skip-convert');
        w.children[0].finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.warningCount, 2, 'the re-run\'s warning and csolution\'s');
        assert.ok(done.diagnosis?.text.includes('  csolution warning: no compiler registered'), done.diagnosis?.text);
    });

    test('an index older than the build is not the build\'s: the re-run converts again', async () => {
        const w = make();
        const idx = path.join(w.dir, 'Blinky.cbuild-idx.yml');
        fs.writeFileSync(idx, IDX);
        const old = new Date(w.clock.now() - 60_000);
        fs.utimesSync(idx, old, old);
        failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.ok(!w.children[0].args.includes('--skip-convert'));
        w.children[0].finish(1, '');
    });

    test('no re-run without the environment file; the result says why and names get_build_diagnostics', async () => {
        const w = make({ environment: false });
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0);
        assert.strictEqual(done.diagnosis?.source, 'none');
        assert.strictEqual(done.diagnosis?.text, 'No error lines: .cmsis/tools-environment.yml is missing (CMSIS Solution 1.70.1 and later write it), '
            + 'so cbuild was not re-run.\n'
            + 'get_build_diagnostics (setting cmsis-developer-assistant.buildInfo.enabled) reads a build log if the user captures one with cbuild --log.');
    });

    test('no cbuild where the environment file says, the setting off, a clean: no re-run, each said', async () => {
        const noCbuild = make({ cbuild: false });
        const first = failBuild(noCbuild);
        assert.match((await diagnosed(noCbuild, first.job.id)).diagnosis?.text ?? '', /^No error lines: cbuild was not found in the CMSIS-Toolbox directory/);
        noCbuild.dispose();

        const off = make();
        off.settings.rerun = false;
        fs.writeFileSync(path.join(off.dir, 'Blinky.cbuild-idx.yml'), IDX.replace(/errors:[\s\S]*?warnings:/, 'warnings:'));
        const second = failBuild(off);
        const text = (await diagnosed(off, second.job.id)).diagnosis?.text ?? '';
        assert.ok(text.startsWith('No error lines: the diagnostic re-run of cbuild is off (setting cmsis-developer-assistant.build.diagnosticRerun).\n'
            + '  csolution warning: Blinky.csolution.yml - solution created for unknown tool'), text);
        assert.strictEqual(off.children.length, 0);
        off.dispose();

        const clean = make();
        const third = failBuild(clean, 2, { clean: true });
        assert.match((await diagnosed(clean, third.job.id)).diagnosis?.text ?? '', /^No error lines: a failed clean is not re-run\./);
        assert.strictEqual(clean.children.length, 0);
    });

    test('a build or setup that starts meanwhile kills the re-run, and its result says so', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.tasks.start(w.tasks.execution({ name: 'cbuild setup Blinky.csolution.yml', source: 'cmsis-csolution.build',
            definition: { type: 'cmsis-csolution.build', setup: true } }));
        assert.deepStrictEqual(w.killed, [w.children[0]], 'the new build killed the child at once');
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.text, 'No error lines: the diagnostic re-run of cbuild was stopped because another build started; '
            + 'that build\'s result replaces this one.\n'
            + 'get_build_diagnostics (setting cmsis-developer-assistant.buildInfo.enabled) reads a build log if the user captures one with cbuild --log.');
    });

    test('the re-run is killed at 120 s; what its log had by then is shown', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = child.args[child.args.indexOf('--log') + 1];
        fs.writeFileSync(logFile, GCC_LOG);
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS - 1);
        assert.deepStrictEqual(w.killed, []);
        w.clock.advance(w.clock.now() + 1);
        assert.deepStrictEqual(w.killed, [child]);
        const done = await diagnosed(w, job.id);
        assert.match(done.diagnosis?.text ?? '', /^2 errors \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1; the re-run was stopped after 120 s\):/);
    });

    test('a child that does not close after the kill counts as ended 5 s later', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
        await until(() => w.killed.length === 1, 'the cap killed it');
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending');
        w.clock.advance(w.clock.now() + 5_000);
        const done = await diagnosed(w, job.id);
        assert.match(done.diagnosis?.text ?? '', /^A diagnostic re-run of cbuild with --log was stopped after 120 s before it printed an error line\./);
    });

    test('no re-run beside another build that is running', async () => {
        const w = make();
        w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
        const { job } = failBuild(w);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(w.children.length, 0);
        assert.match(done.diagnosis?.text ?? '', /^No error lines: 'cbuild other\.csolution\.yml' is running, so cbuild was not re-run beside it\./);
    });

    test('cbuild\'s own output stands in when the log is missing; a spawn failure is said', async () => {
        const w = make();
        const first = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.children[0].finish(1, undefined, '/w/main.c:3:1: error: expected \';\' before \'}\' token\n');
        const done = await diagnosed(w, first.job.id);
        assert.strictEqual(done.diagnosis?.errorCount, 1);
        assert.strictEqual(done.diagnosis?.logFile, undefined);

        w.host.spawn = () => {
            throw new Error('spawn EACCES');
        };
        const second = failBuild(w);
        assert.match((await diagnosed(w, second.job.id)).diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild could not start \(spawn EACCES\)\./);
    });

    test('a definition naming the solution through a variable asks CMSIS Solution for it; a successful build is never diagnosed', async () => {
        const w = make();
        const ok = w.tracker.begin('build', 'MPS3');
        w.tasks.finish(w.tasks.start(w.tasks.execution(buildTask(w))), 0);
        assert.strictEqual(w.tracker.job(ok.id)?.diagnosis, undefined);

        const { job } = failBuild(w, 2, { solution: '${command:cmsis-csolution.getSolutionFile}', active: '${command:cmsis-csolution.getActiveTargetSet}' });
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.deepStrictEqual(w.children[0].args.slice(0, 5), [w.solution, '--target', 'all', '--active', 'MPS3']);
        w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:01\n');
        assert.match((await diagnosed(w, job.id)).diagnosis?.text ?? '', /^A diagnostic re-run of cbuild with --log succeeded \(exit 0\)/);
    });

    suite('the lines reach the waiting call, or status afterwards', () => {
        test('within the deadline: the failed build\'s result carries the lines and the data', async () => {
            const w = make();
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 2);
            await until(() => w.children.length === 1, 'cbuild was spawned');
            let woken = false;
            void waiting.then(() => {
                woken = true;
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(woken, false, 'the waiter waits for the diagnosis, not only for the job');
            w.children[0].finish(1, GCC_LOG);
            const outcome = await waiting as Job;
            assert.strictEqual(outcome.diagnosis?.state, 'done');
            let failure: unknown;
            try {
                jobResult(outcome, { tag: ' on MPS3', now: w.clock.now() });
            } catch (caught) {
                failure = caught;
            }
            assert.ok(failure instanceof ToolError && failure.code === 'TASK_FAILED');
            assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited with code 2 after 3 s \(job b-1\)\.\n2 errors \(from a diagnostic re-run/);
            assert.strictEqual(failure.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
            const data = failure.data?.diagnosis as Record<string, unknown>;
            assert.deepStrictEqual([data.state, data.source, data.errorCount, data.warningCount], ['done', 'rerun', 2, 1]);
            assert.deepStrictEqual((data.errors as unknown[])[0], {
                severity: 'error', message: '\'ledx\' undeclared (first use in this function)', file: '/Users/dev/work/Blinky/Blinky/main.c', line: 42, column: 5,
            });
        });

        test('after the deadline: the result says the lines are coming, and status shows them', async () => {
            const w = make();
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 10_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 2);
            await until(() => w.children.length === 1, 'cbuild was spawned');
            w.clock.advance(w.clock.now() + 7_000);
            const early = await waiting as Job;
            assert.strictEqual(early.diagnosis?.state, 'pending');
            let failure: unknown;
            try {
                jobResult(early, { tag: ' on MPS3', now: w.clock.now() });
            } catch (caught) {
                failure = caught;
            }
            assert.ok(failure instanceof ToolError);
            assert.ok(failure.message.endsWith('\nError lines: still being collected (a diagnostic re-run of cbuild with --log, at most 120 s).'), failure.message);
            assert.strictEqual(failure.hint, 'Call cmsis_action {action:\'status\'} for the error lines — do not start another build to see them. '
                + 'This is a terminal result — do not wait for an output file.');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /\nThe error lines of build job b-1 are still being collected — cmsis_action \{action:'status'\} again shows them\.\n/);

            const status = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            w.children[0].finish(1, GCC_LOG);
            await status;
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /^No CMSIS job in flight in this window\. Last results \(10 min\): build on MPS3 ❌ exit 2 [\d.]+ s ago \(job b-1, '.*'\)\.\nBuild job b-1 failed: 2 errors \(from a diagnostic re-run of cbuild with --log; /);
            assert.ok(idle.includes('\n  Blinky/main.c:42:5 error:') || idle.includes('main.c:42:5 error:'), idle);
        });

        test('a listener hears the job when its diagnosis is in, for the journal (#48)', async () => {
            const w = make({ environment: false });
            const heard: string[] = [];
            w.tracker.onDidDiagnoseJob((job) => heard.push(`${job.id}:${job.diagnosis?.state}:${job.diagnosis?.source}`));
            const { job } = failBuild(w);
            await diagnosed(w, job.id);
            assert.deepStrictEqual(heard, [`${job.id}:done:none`]);
        });
    });
});
