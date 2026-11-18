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
import { BUILD_STOPPED_EXIT_CODE, type Job, type JobAction } from '../core/cmsisTasks';
import { idleStatus, jobResult } from '../handler/jobText';
import { ToolError } from '../core/toolResult';
import { FakeExecution, FakeTasks, FixtureTask, ManualClock } from './cmsisTaskFixtures';

/**
 * The runner of #15 over a tracker fed with fake task events: which stage
 * answers, the re-run's command line and guards (the cap, a build that
 * starts meanwhile, a build already running, no environment file, the
 * setting), what a stop leaves of its lines and its log (#135), and how the
 * lines reach a waiting call and `status`. cbuild is a fake: the test writes
 * its log and ends it.
 */

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildinfo');
const GCC_LOG = fs.readFileSync(path.join(FIXTURES, 'build-failed-gcc.log'), 'utf8');
const IDX = fs.readFileSync(path.join(FIXTURES, 'Blinky.cbuild-idx.yml'), 'utf8');

/** A long build's progress so far: no error line yet. */
const PROGRESS = [
    '(1/1) Building context: "Blinky.Debug+MPS3"',
    'Building CMake target \'Blinky.Debug+MPS3\'',
    '[1/900] Building CXX object CMakeFiles/Group_Kernels.dir/kernels/op_mul.cpp.obj',
    '[2/900] Building CXX object CMakeFiles/Group_Kernels.dir/kernels/op_sub.cpp.obj',
    '',
].join('\n');

/** What ninja and cbuild print when the stop kills the compiler under them (#135): the stop's lines, not the build's. */
const KILL_FALLOUT = [
    'FAILED: [code=1] CMakeFiles/Group_Kernels.dir/kernels/op_add.cpp.obj ',
    '/opt/gcc/bin/arm-none-eabi-g++ -c kernels/op_add.cpp -o CMakeFiles/Group_Kernels.dir/kernels/op_add.cpp.obj',
    'ninja: build stopped: subcommand failed.',
    'error cbuild: error building \'cmake --build /w/tmp --target Blinky.Debug+MPS3\'',
    '',
].join('\n');

/** The line a stopped re-run leaves at the end of its log. */
const stopLine = (cause: string): string => `[cmsis-developer-assistant] This diagnostic re-run was stopped here ${cause}, before cbuild finished; `
    + 'what ninja and cbuild printed because of the stop is left out.\n';

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
    /** `onKill`: what the killed cbuild, ninja and compilers write before the child closes. */
    settings: { rerun: boolean; closeOnKill: boolean; onKill?: (child: FakeChild) => void };
    /** End the diagnosis as the extension's end does, the tracker left as it is. */
    detach(): void;
    dispose(): void;
}

/** The log file a spawned re-run was given. */
function logOf(child: FakeChild): string {
    return child.args[child.args.indexOf('--log') + 1];
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
    const settings: World['settings'] = { rerun: true, closeOnKill: true };
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
            settings.onKill?.(child as FakeChild);
            if (settings.closeOnKill) {
                setImmediate(() => (child as FakeChild).emit('close', null));
            }
        },
        clock,
    };
    const attached = attachBuildDiagnosis(tracker, host);
    return {
        dir, solution, tasks, clock, tracker, host, children, killed, settings,
        detach: () => attached.dispose(),
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

/** Let promise chains and `setImmediate` callbacks run for a while, for a test that asserts something did not happen. */
async function rounds(count = 50): Promise<void> {
    for (let round = 0; round < count; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
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

/** A build job (or `action`) whose task starts and fails with `exitCode`; the diagnosis starts from its end. */
function failBuild(w: World, exitCode = 2, definition: Record<string, unknown> = {}, action: JobAction = 'build'): { job: Job; execution: FakeExecution } {
    const job = w.tracker.begin(action, 'MPS3');
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

/**
 * A build job (or `action`) whose task starts and exits 0, which CMSIS Solution 1.70.1 reports for failed builds
 * too; `during` runs while cbuild would build (write the image there). The check starts from its end.
 */
function passBuild(w: World, definition: Record<string, unknown> = {}, action: JobAction = 'build', during: () => void = () => undefined): { job: Job; execution: FakeExecution } {
    const job = w.tracker.begin(action, 'MPS3');
    w.tracker.issued(job.id);
    const execution = w.tasks.start(w.tasks.execution(buildTask(w, definition)));
    during();
    w.clock.advance(w.clock.now() + 3_000);
    w.tasks.finish(execution, 0);
    return { job, execution };
}

/**
 * What CMSIS-Toolbox 2.14 leaves after a build of Blinky for MPS3: the index,
 * which names the context's cbuild.yml, that cbuild.yml with its outputs, and
 * the image, `ageMs` older than the build's start (0: written by the build),
 * or none. Returns the image's path.
 */
function builtLayout(w: World, image: { ageMs: number } | 'none' = { ageMs: 0 }): string {
    const debug = path.join(w.dir, 'out', 'Blinky', 'MPS3', 'Debug');
    fs.mkdirSync(debug, { recursive: true });
    fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), [
        'build-idx:',
        '  generated-by: csolution version 2.14.1',
        '  csolution: Blinky.csolution.yml',
        '  cbuild-run: out/Blinky+MPS3.cbuild-run.yml',
        '  cbuilds:',
        '    - cbuild: out/Blinky/MPS3/Debug/Blinky.Debug+MPS3.cbuild.yml',
        '      project: Blinky',
        '      configuration: .Debug+MPS3',
        '      messages:',
        '        info:',
        '          - Blinky.Debug+MPS3.cbuild.yml - file is already up-to-date',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(debug, 'Blinky.Debug+MPS3.cbuild.yml'), [
        'build:',
        '  context: Blinky.Debug+MPS3',
        '  compiler: AC6',
        '  output-dirs:',
        '    intdir: ../../../../tmp',
        '    outdir: .',
        '  output:',
        '    - type: elf',
        '      file: Blinky.axf',
        '    - type: hex',
        '      file: Blinky.hex',
        '    - type: map',
        '      file: Blinky.axf.map',
        '',
    ].join('\n'));
    const file = path.join(debug, 'Blinky.axf');
    if (image !== 'none') {
        fs.writeFileSync(file, 'ELF');
        if (image.ageMs > 0) {
            const at = new Date(w.clock.now() - image.ageMs);
            fs.utimesSync(file, at, at);
        }
    }
    return file;
}

/** The error `jobResult` throws for a job, or a failure of the test when it returns. */
function resultError(job: Job, now: number): ToolError {
    try {
        jobResult(job, { tag: ' on MPS3', now });
    } catch (caught) {
        assert.ok(caught instanceof ToolError, String(caught));
        return caught;
    }
    return assert.fail('jobResult did not throw');
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

    test('the result names the knowledge unit of an error message the index knows; a lookup that throws changes nothing', async () => {
        const known = 'Known message: knowledge_get { id: "ts-x" } has its cause and fix.';
        const w = make();
        const asked: string[][] = [];
        w.host.knownMessageLines = (messages) => {
            asked.push([...messages]);
            return [known, known, known, known];
        };
        const first = failBuild(w).job;
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.children[0].finish(1, GCC_LOG);
        const text = (await diagnosed(w, first.id)).diagnosis?.text ?? '';
        assert.ok(text.endsWith(`get_build_diagnostics reads it).\n${known}\n${known}\n${known}`), text);
        assert.strictEqual(asked[0][0], '\'ledx\' undeclared (first use in this function)');

        w.host.knownMessageLines = () => { throw new Error('index gone'); };
        const second = failBuild(w).job;
        await until(() => w.children.length === 2, 'cbuild was spawned again');
        w.children[1].finish(1, GCC_LOG);
        assert.ok((await diagnosed(w, second.id)).diagnosis?.text.endsWith('get_build_diagnostics reads it).'));
    });

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
            + 'cmsis_action build re-runs cbuild with --log itself when it can.');
    });

    test('without the file, the environment from CMSIS Solution\'s API version 3 stands in: cbuild is re-run from its directory', async () => {
        const w = make({ environment: false });
        const bin = path.join(w.dir, 'toolbox', 'bin').replace(/\\/g, '/');
        w.host.apiToolsEnvironment = async () => ['cmsis-tools-environment:', '  environment:', '    path:', `      - ${bin}`, '  tools:',
            '    - name: CMSIS-Toolbox', `      directory: ${bin}`, ''].join('\n');
        failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned from the API\'s environment');
        assert.strictEqual(path.dirname(w.children[0].command), path.join(w.dir, 'toolbox', 'bin'));
        w.children[0].finish(1, '');
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
        const third = failBuild(clean, 2, { clean: true }, 'clean');
        assert.match((await diagnosed(clean, third.job.id)).diagnosis?.text ?? '', /^No error lines: a failed clean is not re-run\./);
        assert.strictEqual(clean.children.length, 0);
    });

    test('the re-run\'s cbuild is the one the CMSIS-Toolbox entry names, never one from the PATH VS Code inherited (#128)', async () => {
        const w = make();
        // An older toolbox first on the inherited PATH, as a legacy installation had put it on Windows.
        const legacy = path.join(w.dir, 'legacy', 'cmsis-toolbox', 'bin');
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(path.join(legacy, 'cbuild'), '');
        w.host.baseEnvironment = () => ({ PATH: `${legacy}:/usr/bin` });
        const toolbox = path.join(w.dir, 'toolbox', 'bin').replace(/\\/g, '/');

        const first = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.strictEqual(w.children[0].command, path.posix.join(toolbox, 'cbuild'), 'the file\'s cbuild, by its absolute path');
        assert.strictEqual(w.children[0].options.env.PATH, `${toolbox}:${legacy}:/usr/bin`, 'the file\'s directories before the inherited PATH');
        w.children[0].finish(1, GCC_LOG);
        await diagnosed(w, first.job.id);

        // A file that names no CMSIS-Toolbox: no re-run, although the inherited PATH has a cbuild.
        fs.writeFileSync(path.join(w.dir, '.cmsis', 'tools-environment.yml'),
            'cmsis-tools-environment:\n  environment:\n    path:\n      - /opt/gcc/bin\n  tools:\n    - name: Arm GNU GDB\n      directory: /opt/gdb/bin\n');
        const second = failBuild(w);
        assert.match((await diagnosed(w, second.job.id)).diagnosis?.text ?? '',
            /^No error lines: \.cmsis\/tools-environment\.yml names no CMSIS-Toolbox directory/);
        assert.strictEqual(w.children.length, 1, 'nothing else was started');
    });

    test('a failed rebuild is diagnosed like a build: the re-run leaves out --rebuild, and the result names the rebuild', async () => {
        const w = make();
        const { job } = failBuild(w, 2, { rebuild: true }, 'rebuild');
        assert.strictEqual(w.tracker.job(job.id)?.state, 'failed');
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.ok(!w.children[0].args.includes('--rebuild'), w.children[0].args.join(' '));
        w.children[0].finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        const failure = resultError(done, w.clock.now());
        assert.match(failure.message, /^❌ CMSIS 'rebuild' FAILED on MPS3 — task '.*' exited with code 2 after 3 s \(job rb-1\)\.\n2 errors \(from a diagnostic re-run/);
        assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /\nRebuild job rb-1 failed: 2 errors/);
    });

    test(`a build stopped with ${BUILD_STOPPED_EXIT_CODE} (Stop Build, cmsis_action stop_build) is not diagnosed: no re-run starts`, () => {
        const w = make();
        const { job } = failBuild(w, BUILD_STOPPED_EXIT_CODE);
        assert.strictEqual(w.tracker.job(job.id)?.state, 'cancelled');
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis, undefined);
        assert.strictEqual(w.tracker.isCompleting(job.id), false);
        assert.strictEqual(w.children.length, 0);
        const stopped = resultError(w.tracker.job(job.id) as Job, w.clock.now());
        assert.strictEqual(stopped.message, 'CMSIS \'build\' on MPS3 — task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' was stopped after 3 s (job b-1), '
            + 'so its outputs are incomplete: cmsis_action build before load or flash.');
        assert.strictEqual(stopped.hint, 'cmsis_action build starts it again.');
        assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /build on MPS3 stopped [\d.]+ s ago \(job b-1, /);
    });

    test('a build that starts meanwhile kills the re-run, and its result says so', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
        assert.deepStrictEqual(w.killed, [w.children[0]], 'the new build killed the child at once');
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.text, 'No error lines: the diagnostic re-run of cbuild was stopped because another build started; '
            + 'that build\'s result replaces this one.\n'
            + 'cmsis_action build re-runs cbuild with --log itself when it can.');
    });

    suite('CMSIS Solution\'s setup task is no newer build (#138)', () => {
        /** The setup of the issue: CMSIS Solution's database refresh after a target switch. */
        const setupTask = (): FixtureTask => ({
            name: 'cbuild setup Blinky.csolution.yml --target database --active MPS3 --packs --skip-convert', source: 'cmsis-csolution.build',
            definition: { type: 'cmsis-csolution.build', setup: true },
        });

        test('a build that exited 0 while a setup starts: the check waits for the setup, then re-runs and confirms the build', async () => {
            const w = make();
            builtLayout(w, 'none');
            const { job } = passBuild(w);
            // The setup starts right after the build ended, before the check's re-run could spawn.
            const setup = w.tasks.start(w.tasks.execution(setupTask()));
            await rounds();
            assert.strictEqual(w.children.length, 0, 'no re-run beside the setup');
            assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending');
            w.tasks.finish(setup, 0);
            await until(() => w.children.length === 1, 'the re-run was spawned once the setup ended');
            w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed\n');
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'up-to-date', done.diagnosis?.text);
            assert.ok(!(done.diagnosis?.text ?? '').includes('another build started'), done.diagnosis?.text);
        });

        test('a failed build while a setup runs: the re-run starts only once the setup ended, and has the lines', async () => {
            const w = make();
            const setup = w.tasks.start(w.tasks.execution(setupTask()));
            const { job } = failBuild(w);
            await rounds();
            assert.strictEqual(w.children.length, 0, 'no re-run beside the setup');
            w.tasks.finish(setup, 0);
            await until(() => w.children.length === 1, 'the re-run was spawned once the setup ended');
            w.children[0].finish(1, GCC_LOG);
            assert.strictEqual((await diagnosed(w, job.id)).diagnosis?.errorCount, 2);
        });

        test('a setup that starts during the re-run stops it; once the setup ended the re-run runs again from an empty log', async () => {
            const w = make();
            const { job } = failBuild(w);
            await until(() => w.children.length === 1, 'cbuild was spawned');
            const logFile = logOf(w.children[0]);
            fs.writeFileSync(logFile, PROGRESS);
            w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
            const setup = w.tasks.start(w.tasks.execution(setupTask()));
            assert.deepStrictEqual(w.killed, [w.children[0]], 'the re-run made way for the setup');
            await rounds();
            assert.strictEqual(w.children.length, 1, 'not again while the setup runs');
            w.tasks.finish(setup, 0);
            await until(() => w.children.length === 2, 'the re-run ran again once the setup ended');
            assert.ok(!fs.existsSync(logFile), 'the second re-run starts from an empty log');
            w.children[1].finish(1, GCC_LOG);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.errorCount, 2);
            assert.ok(!(done.diagnosis?.text ?? '').includes('op_add'), 'nothing of the stopped re-run');
        });

        test('while it waits for a setup, a build that starts supersedes the re-run and stop_build stops it: neither spawns', async () => {
            const w = make();
            const setup = w.tasks.start(w.tasks.execution(setupTask()));
            const first = failBuild(w).job;
            await rounds();
            w.tasks.finish(w.tasks.start(w.tasks.execution(buildTask(w))), BUILD_STOPPED_EXIT_CODE);
            assert.match((await diagnosed(w, first.id)).diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild was stopped because another build started;/);

            const second = failBuild(w).job;
            await rounds();
            w.tracker.stopFollowUps();
            assert.match((await diagnosed(w, second.id)).diagnosis?.text ?? '', /^No error lines: cmsis_action stop_build stopped the diagnostic re-run of cbuild before it started\./);
            assert.strictEqual(w.children.length, 0);
            w.tasks.finish(setup, 0);
        });

        test('a setup that runs on for 10 min: the re-run gives up and says which task kept it from running', async () => {
            const w = make();
            w.tasks.start(w.tasks.execution(setupTask()));
            const { job } = failBuild(w);
            await rounds();
            w.clock.advance(w.clock.now() + 10 * 60_000);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(w.children.length, 0);
            assert.strictEqual(done.diagnosis?.text, 'No error lines: CMSIS Solution\'s task \'cbuild setup Blinky.csolution.yml --target database --active MPS3 '
                + '--packs --skip-convert\' was still running after 10 min, so cbuild was not re-run beside it.\n'
                + 'cmsis_action build re-runs cbuild with --log itself when it can.');
        });
    });

    test('a superseded re-run leaves the log as it is: no cut and no mark, also after its kill grace', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const logFile = logOf(w.children[0]);
        fs.writeFileSync(logFile, PROGRESS);
        w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
        w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
        assert.deepStrictEqual(w.killed, [w.children[0]], 'the build that started stopped the re-run');
        w.clock.advance(w.clock.now() + 5_000);
        const done = await diagnosed(w, job.id);
        assert.match(done.diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild was stopped because another build started;/);
        assert.strictEqual(fs.readFileSync(logFile, 'utf8'), `${PROGRESS}${KILL_FALLOUT}`, 'a superseded re-run neither cuts nor marks the log');
    });

    test('a newer re-run starts only once the older one has let go of the log, and the log is its own', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        const first = failBuild(w).job;
        await until(() => w.children.length === 1, 'the first re-run was spawned');
        const logFile = logOf(w.children[0]);
        fs.writeFileSync(logFile, PROGRESS);
        const second = failBuild(w).job;
        assert.deepStrictEqual(w.killed, [w.children[0]], 'the second build stopped the first re-run');
        await rounds();
        assert.strictEqual(w.children.length, 1, 'no second cbuild while the first one is in its kill grace');
        fs.appendFileSync(logFile, KILL_FALLOUT);
        w.clock.advance(w.clock.now() + 5_000);
        await until(() => w.children.length === 2, 'the second re-run was spawned once the first one let go');
        assert.ok(!fs.existsSync(logFile), 'the second re-run starts from an empty log');
        w.children[1].finish(1, GCC_LOG);
        const done = await diagnosed(w, second.id);
        assert.strictEqual(done.diagnosis?.errorCount, 2);
        assert.ok(!(done.diagnosis?.text ?? '').includes('op_add'), done.diagnosis?.text);
        assert.strictEqual(fs.readFileSync(logFile, 'utf8'), GCC_LOG, 'neither cut nor marked by the first re-run');
        assert.match((await diagnosed(w, first.id)).diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild was stopped because another build started;/);
    });

    test('a re-run waiting for the log is superseded by a build that starts meanwhile, and never starts', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        failBuild(w);
        await until(() => w.children.length === 1, 'the first re-run was spawned');
        const second = failBuild(w).job;
        await rounds();
        // A third build starts and is stopped at once: nothing runs any more, but it came after the second build ended.
        w.tasks.finish(w.tasks.start(w.tasks.execution(buildTask(w))), BUILD_STOPPED_EXIT_CODE);
        w.clock.advance(w.clock.now() + 5_000);
        const done = await diagnosed(w, second.id);
        assert.strictEqual(w.children.length, 1, 'the waiting re-run never started');
        assert.match(done.diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild was stopped because another build started;/);
    });

    test('cmsis_action stop_build stops a running re-run: the lines it printed before count, and its log is cut and marked', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const logFile = logOf(w.children[0]);
        fs.writeFileSync(logFile, GCC_LOG);
        w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
        w.tracker.stopFollowUps();
        assert.deepStrictEqual(w.killed, [w.children[0]]);
        const done = await diagnosed(w, job.id);
        assert.deepStrictEqual([done.state, done.diagnosis?.errorCount], ['failed', 2], 'the job stays as it settled');
        assert.match(done.diagnosis?.text ?? '', /^2 errors \(from a diagnostic re-run of cbuild with --log, printed before cmsis_action stop_build stopped it; /);
        assert.match(done.diagnosis?.note ?? '', /^the re-run was stopped by cmsis_action stop_build, so its lines are only those it printed before the stop; /);
        assert.strictEqual(fs.readFileSync(logFile, 'utf8'), `${GCC_LOG}${GCC_LOG.endsWith('\n') ? '' : '\n'}${stopLine('by cmsis_action stop_build')}`);
    });

    test('cmsis_action stop_build also stops a re-run that waits for the log: it never starts', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        failBuild(w);
        await until(() => w.children.length === 1, 'the first re-run was spawned');
        const second = failBuild(w).job;
        await rounds();
        w.tracker.stopFollowUps();
        w.clock.advance(w.clock.now() + 5_000);
        const done = await diagnosed(w, second.id);
        assert.strictEqual(w.children.length, 1);
        assert.strictEqual(done.diagnosis?.text, 'No error lines: cmsis_action stop_build stopped the diagnostic re-run of cbuild before it started.\n'
            + 'cmsis_action build re-runs cbuild with --log itself when it can.');
    });

    test('a re-run waiting for the log when the extension shuts down never starts', async () => {
        const w = make();
        w.settings.closeOnKill = false;
        failBuild(w);
        await until(() => w.children.length === 1, 'the first re-run was spawned');
        const second = failBuild(w).job;
        await rounds();
        w.detach();
        const done = await diagnosed(w, second.id);
        assert.strictEqual(w.children.length, 1, 'no cbuild once the extension shuts down');
        assert.match(done.diagnosis?.text ?? '', /^No error lines: the diagnostic re-run of cbuild could not start \(the extension shut down\)\./);
    });

    test('a re-run that runs longer than 2 min is not stopped: it goes on to its result', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        w.clock.advance(w.clock.now() + 25 * 60_000);
        assert.deepStrictEqual(w.killed, []);
        assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending', 'the lines are still coming');
        w.children[0].finish(1, GCC_LOG);
        const done = await diagnosed(w, job.id);
        assert.strictEqual(done.diagnosis?.errorCount, 2);
        assert.match(done.diagnosis?.text ?? '', /^2 errors \(from a diagnostic re-run of cbuild with --log; warnings only from the files it recompiled: 1\):\n/);
    });

    test('at its 30 min limit the re-run is stopped: the error lines it had by then are shown, those the stop made it print are not', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = logOf(child);
        fs.writeFileSync(logFile, GCC_LOG);
        child.stdout.emit('data', Buffer.from(GCC_LOG));
        w.settings.onKill = (killed) => {
            fs.appendFileSync(logFile, KILL_FALLOUT);
            killed.stdout.emit('data', Buffer.from(KILL_FALLOUT));
        };
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS - 1);
        assert.deepStrictEqual(w.killed, []);
        w.clock.advance(w.clock.now() + 1);
        assert.deepStrictEqual(w.killed, [child]);
        const done = await diagnosed(w, job.id);
        const diagnosis = done.diagnosis;
        assert.strictEqual(diagnosis?.errorCount, 2, 'the two errors printed before the stop, not cbuild\'s error about the stop');
        assert.match(diagnosis?.text ?? '', /^2 errors \(from a diagnostic re-run of cbuild with --log, printed before it was cut off at its 30 min limit; warnings only from the files it recompiled: 1\):\n {2}\S*main\.c:42:5 error: 'ledx' undeclared/);
        assert.ok(!(diagnosis?.text ?? '').includes('op_add'), diagnosis?.text);
        assert.match(diagnosis?.note ?? '', /^the re-run was cut off at its 30 min limit, so its lines are only those it printed before the stop; /);
        assert.strictEqual(fs.readFileSync(logFile, 'utf8'), `${GCC_LOG}${GCC_LOG.endsWith('\n') ? '' : '\n'}${stopLine('at its 30 min limit')}`,
            'the log keeps what it had at the stop and loses what the stop made ninja and cbuild print');
    });

    test('cut off before any error line: what the stop made ninja and cbuild print is no error, and the result says the re-run was cut off', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        const logFile = logOf(child);
        fs.writeFileSync(logFile, PROGRESS);
        child.stdout.emit('data', Buffer.from(PROGRESS));
        w.settings.onKill = (killed) => {
            fs.appendFileSync(logFile, KILL_FALLOUT);
            killed.stdout.emit('data', Buffer.from(KILL_FALLOUT));
        };
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
        const done = await diagnosed(w, job.id);
        const diagnosis = done.diagnosis;
        assert.deepStrictEqual([diagnosis?.source, diagnosis?.errorCount, diagnosis?.errors.length], ['rerun', 0, 0]);
        assert.strictEqual(diagnosis?.text, 'The diagnostic re-run of cbuild with --log was cut off: the CMSIS Developer Assistant stopped it at its 30 min limit, '
            + 'before cbuild finished, and no compiler, linker or ninja error had appeared by then, so it shows no cause of the failure.\n'
            + 'Full log: out/cmsis-developer-assistant/build-diagnostic.log (get_build_diagnostics reads it).');
        const failure = resultError(done, w.clock.now());
        assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited with code 2 after 3 s \(job b-1\)\.\nThe diagnostic re-run of cbuild with --log was cut off: /);
        assert.strictEqual(failure.hint, 'get_recent_problems lists what the Problems panel shows; otherwise ask the user for the errors in the cbuild terminal '
            + '— do not run cbuild yourself. Fix them, then cmsis_action build again. This is a terminal result — do not wait for an output file.',
        'no "fix the first error" without an error line');
        assert.strictEqual(fs.readFileSync(logFile, 'utf8'), `${PROGRESS}${stopLine('at its 30 min limit')}`);
        assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /\nBuild job b-1 failed: The diagnostic re-run of cbuild with --log was cut off: /);
    });

    test('without a log, cbuild\'s output stands in as far as it came before the stop', async () => {
        const w = make();
        const { job } = failBuild(w);
        await until(() => w.children.length === 1, 'cbuild was spawned');
        const child = w.children[0];
        child.stdout.emit('data', Buffer.from(`${PROGRESS}/w/Blinky/main.c:7:1: error: expected ';' before '}' token\n`));
        w.settings.onKill = (killed) => killed.stderr.emit('data', Buffer.from(KILL_FALLOUT));
        w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
        const done = await diagnosed(w, job.id);
        assert.deepStrictEqual([done.diagnosis?.errorCount, done.diagnosis?.logFile], [1, undefined]);
        assert.deepStrictEqual(done.diagnosis?.errors.map((error) => error.message), ['expected \';\' before \'}\' token']);
        assert.ok(!(done.diagnosis?.text ?? '').includes('ninja FAILED'), done.diagnosis?.text);
        assert.ok(!fs.existsSync(logOf(child)), 'no log is made up');
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
        assert.match(done.diagnosis?.text ?? '', /^The diagnostic re-run of cbuild with --log was cut off: the CMSIS Developer Assistant stopped it at its 30 min limit, /);
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

    test('a definition naming the solution through a variable asks CMSIS Solution for it', async () => {
        const w = make();
        const { job } = failBuild(w, 2, { solution: '${command:cmsis-csolution.getSolutionFile}', active: '${command:cmsis-csolution.getActiveTargetSet}' });
        await until(() => w.children.length === 1, 'cbuild was spawned');
        assert.deepStrictEqual(w.children[0].args.slice(0, 5), [w.solution, '--target', 'all', '--active', 'MPS3']);
        w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:01\n');
        assert.match((await diagnosed(w, job.id)).diagnosis?.text ?? '', /^A diagnostic re-run of cbuild with --log succeeded \(exit 0\)/);
    });

    suite('a build that exited 0 is checked before it counts as a success', () => {
        test('an image written since the build started confirms it without a re-run', async () => {
            const w = make();
            const image = builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w, {}, 'build', () => fs.writeFileSync(image, 'ELF, linked again'));
            assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending', 'the success waits for the check');
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0, 'nothing was re-run');
            assert.match(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }) as string,
                /^✅ CMSIS 'build' succeeded on MPS3 \(task 'cbuild Blinky\.csolution\.yml --active MPS3 --packs' exited 0 after 3 s, job b-1\)\. The firmware is built/);
        });

        test('an image older than the build: the check re-run fails where the build failed, and the job fails with the error lines', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            const args = w.children[0].args;
            assert.ok(!args.includes('--packs'), 'no pack download');
            assert.strictEqual(args[args.length - 1], '--skip-convert', 'the index is fresh, so csolution is not run again');
            w.children[0].finish(1, GCC_LOG);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'failed', 'exit 0 with errors is a failed job');
            assert.strictEqual(done.diagnosis?.check, 'failed');
            assert.strictEqual(done.diagnosis?.errorCount, 2);
            const failure = resultError(done, w.clock.now());
            assert.strictEqual(failure.code, 'TASK_FAILED');
            assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited 0 after 3 s, but the build failed \(CMSIS Solution reports exit 0 for a failed build too\) \(job b-1\)\.\n2 errors \(from a diagnostic re-run of cbuild with --log;/);
            assert.strictEqual(failure.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
            assert.strictEqual((failure.data?.diagnosis as Record<string, unknown>).check, 'failed');
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /build on MPS3 ❌ build errors \(exit 0\) [\d.]+ s ago \(job b-1, /);
            assert.match(idle, /\nBuild job b-1 failed: 2 errors \(from a diagnostic re-run/);
        });

        test('an image older than the build and a check re-run that succeeds: up to date, a success', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(0, 'Build summary: 1 succeeded, 0 failed - Time Elapsed: 00:00:01\n');
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'up-to-date');
            assert.strictEqual(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }),
                '✅ CMSIS \'build\' succeeded on MPS3 (task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s, job b-1). '
                + 'The image out/Blinky/MPS3/Debug/Blinky.axf was not rewritten: it is from 60 min before the build started; '
                + 'a check re-run of cbuild succeeded (exit 0), so the build is up to date. '
                + 'The firmware is built — use cmsis_action load or load_and_debug to flash it.');
        });

        test('errors in a fresh cbuild-idx.yml fail it without a re-run', async () => {
            const w = make();
            fs.writeFileSync(path.join(w.dir, 'Blinky.cbuild-idx.yml'), IDX);
            const { job } = passBuild(w);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(w.children.length, 0);
            assert.strictEqual(done.state, 'failed');
            assert.deepStrictEqual([done.diagnosis?.check, done.diagnosis?.source, done.diagnosis?.errorCount], ['failed', 'csolution', 2]);
            assert.match(resultError(done, w.clock.now()).message, /exited 0 after 3 s, but the build failed .*\n2 errors from csolution/);
        });

        test('a missing image and no way to re-run cbuild: exit 0 is reported, but not as a confirmed success', async () => {
            const w = make({ environment: false });
            builtLayout(w, 'none');
            const { job } = passBuild(w);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, '⚠️ CMSIS \'build\' on MPS3: task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s (job b-1), '
                + 'but that does not confirm the build. The image out/Blinky/MPS3/Debug/Blinky.axf is missing, and CMSIS Solution reports exit 0 '
                + 'for a failed build too, so this build may have failed. It could not be checked: .cmsis/tools-environment.yml is missing '
                + '(CMSIS Solution 1.70.1 and later write it), so cbuild was not re-run. '
                + 'Before you load this image, ask the user whether the build in the cbuild terminal succeeded — do not run cbuild yourself.');
            assert.strictEqual(((reply.data as Record<string, unknown>).diagnosis as Record<string, unknown>).check, 'unverified');
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /build on MPS3 ⚠️ exit 0, not confirmed [\d.]+ s ago/);
            assert.match(idle, /\nBuild job b-1 exited 0, but that does not confirm it: The image /);
        });

        test('a check still going when the call\'s wait ends answers running; status gives the result', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const job = w.tracker.begin('build', 'MPS3');
            const waiting = w.tracker.waitFor(job.id, w.clock.now() + 10_000);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 0);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.clock.advance(w.clock.now() + 7_000);
            const early = await waiting as Job;
            assert.deepStrictEqual([early.state, early.diagnosis?.state], ['ok', 'pending']);
            const reply = jobResult(early, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'running');
            assert.match(reply.text, /^CMSIS 'build' on MPS3: task '.*' exited 0 after 3 s \(job b-1\); its result is still being checked .*Call cmsis_action \{action:'status'\} for the result — do not start another build\.$/);
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /build on MPS3 exit 0, being checked .*\nThe result of build job b-1 \(exit 0\) is still being checked/);
            const status = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            w.children[0].finish(2, GCC_LOG);
            assert.strictEqual((await status)?.state, 'failed');
        });

        test('a build that starts meanwhile stops the check re-run: not confirmed, and why', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.tasks.start(w.tasks.execution({ name: 'cbuild other.csolution.yml', source: 'cmsis-csolution.build', definition: { type: 'cmsis-csolution.build' } }));
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            assert.match(done.diagnosis?.text ?? '', /It could not be checked: the diagnostic re-run of cbuild was stopped because another build started/);
        });

        test('a check re-run cut off at its limit before any error line: not confirmed, never failed by what the stop printed', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            const logFile = logOf(w.children[0]);
            fs.writeFileSync(logFile, PROGRESS);
            w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
            w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check], ['ok', 'unverified'], 'the stop\'s FAILED step and cbuild error fail nothing');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, '⚠️ CMSIS \'build\' on MPS3: task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s (job b-1), '
                + 'but that does not confirm the build. The image out/Blinky/MPS3/Debug/Blinky.axf was not rewritten: it is from 60 min before the build '
                + 'started, and CMSIS Solution reports exit 0 for a failed build too, so this build may have failed. The check could not decide: the CMSIS '
                + 'Developer Assistant stopped its re-run of cbuild at its 30 min limit, before cbuild finished, and no compiler, linker or ninja error had '
                + 'appeared by then. Before you load this image, ask the user whether the build in the cbuild terminal succeeded — do not run cbuild yourself.');
            assert.strictEqual(((reply.data as Record<string, unknown>).diagnosis as Record<string, unknown>).note,
                'the check re-run of cbuild was cut off at its 30 min limit');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()), /build on MPS3 ⚠️ exit 0, not confirmed /);
        });

        test('cmsis_action stop_build stops a check re-run: the build that exited 0 is not confirmed, never failed', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            const logFile = logOf(w.children[0]);
            fs.writeFileSync(logFile, PROGRESS);
            w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
            w.tracker.stopFollowUps();
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check], ['ok', 'unverified']);
            assert.ok(done.diagnosis?.text.endsWith('The check could not decide: cmsis_action stop_build stopped its re-run of cbuild, before cbuild '
                + 'finished, and no compiler, linker or ninja error had appeared by then.'), done.diagnosis?.text);
            assert.strictEqual(done.diagnosis?.note, 'the check re-run of cbuild was stopped by cmsis_action stop_build');
        });

        test('a check re-run killed from elsewhere, without an exit code, is not said to be stopped at the limit', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(null, PROGRESS);
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check, w.killed.length], ['ok', 'unverified', 0]);
            assert.ok(done.diagnosis?.text.endsWith('so this build may have failed. The check could not decide: its re-run of cbuild ended without '
                + 'an exit code before it printed an error line.'), done.diagnosis?.text);
        });

        test('an error line printed before the limit still fails a build that exited 0, with that line and none of the stop\'s', async () => {
            const w = make();
            builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            const logFile = logOf(w.children[0]);
            fs.writeFileSync(logFile, `${PROGRESS}/w/Blinky/main.c:7:1: error: expected ';' before '}' token\n`);
            w.settings.onKill = () => fs.appendFileSync(logFile, KILL_FALLOUT);
            w.clock.advance(w.clock.now() + DIAGNOSTIC_RERUN_CAP_MS);
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check, done.diagnosis?.errorCount], ['failed', 'failed', 1]);
            assert.deepStrictEqual(done.diagnosis?.errors.map((error) => error.message), ['expected \';\' before \'}\' token']);
            assert.match(done.diagnosis?.text ?? '', /^1 error \(from a diagnostic re-run of cbuild with --log, printed before it was cut off at its 30 min limit; /);
            assert.ok(!(done.diagnosis?.text ?? '').includes('ninja FAILED'), done.diagnosis?.text);
        });

        test('an image younger than 2 s but unchanged since the build started is not its: the re-run decides', async () => {
            // A tester's failed build that started under 2 s after a good one read ✅ from the age of that one's image.
            const w = make();
            builtLayout(w, { ageMs: 500 });
            const { job } = passBuild(w);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(1, GCC_LOG);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'failed');
            assert.strictEqual(done.diagnosis?.check, 'failed');
            assert.strictEqual(done.diagnosis?.errorCount, 2);
        });

        test('without a note from the start (a solution named through a variable), an image under 2 s older than the build still counts', async () => {
            const w = make();
            builtLayout(w, { ageMs: 500 });
            const { job } = passBuild(w, { solution: '${command:cmsis-csolution.getSolutionFile}' });
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0);
        });

        test('a rebuild that exited 0 is checked like a build', async () => {
            const w = make();
            const image = builtLayout(w, 'none');
            const { job } = passBuild(w, { rebuild: true }, 'rebuild', () => fs.writeFileSync(image, 'ELF'));
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.check, 'rebuilt');
            assert.strictEqual(w.children.length, 0);
            assert.match(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }) as string,
                /^✅ CMSIS 'rebuild' succeeded on MPS3 \(task '.*' exited 0 after 3 s, job rb-1\)\. The firmware is rebuilt from scratch — use cmsis_action load or load_and_debug to flash it\.$/);
        });
    });

    suite('a clean that exited 0 is checked against the images its target had when it started', () => {
        /** A clean job whose task starts now; `during` runs while cbuild would clean, then the task exits 0. */
        const runClean = (w: World, during: () => void, definition: Record<string, unknown> = {}): Job => {
            const job = w.tracker.begin('clean', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution({
                ...buildTask(w, { clean: true, ...definition }), name: 'cbuild Blinky.csolution.yml --clean --target all --packs',
            }));
            during();
            w.clock.advance(w.clock.now() + 1_000);
            w.tasks.finish(execution, 0);
            return job;
        };

        test('the images are gone: cleaned, and the result says what it removed and that the whole solution is clean', async () => {
            const w = make();
            const image = builtLayout(w);
            const done = await diagnosed(w, runClean(w, () => fs.rmSync(path.join(w.dir, 'out'), { recursive: true })).id);
            assert.strictEqual(done.state, 'ok');
            assert.strictEqual(done.diagnosis?.check, 'cleaned');
            assert.ok(!fs.existsSync(image));
            assert.strictEqual(w.children.length, 0, 'a clean is never re-run');
            assert.strictEqual(jobResult(done, { tag: ' on MPS3', now: w.clock.now() }),
                '✅ CMSIS \'clean\' succeeded on MPS3 (task \'cbuild Blinky.csolution.yml --clean --target all --packs\' exited 0 after 1 s, job c-1). '
                + 'Removed: out/Blinky/MPS3/Debug/Blinky.axf. It covers the whole solution (CMSIS Solution: "Clean All \'out\' and \'tmp\' Directories"), '
                + 'not only this target: cmsis_action build before load or flash.');
        });

        test('an image is still there: not confirmed, with the next step', async () => {
            const w = make();
            builtLayout(w);
            const done = await diagnosed(w, runClean(w, () => undefined).id);
            assert.strictEqual(done.diagnosis?.check, 'unverified');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, '⚠️ CMSIS \'clean\' on MPS3: task \'cbuild Blinky.csolution.yml --clean --target all --packs\' exited 0 after 1 s (job c-1), '
                + 'but that does not confirm the clean. out/Blinky/MPS3/Debug/Blinky.axf is still there, and CMSIS Solution reports exit 0 for a failed clean too, '
                + 'so this clean may have failed. Ask the user whether the clean in the cbuild terminal succeeded — do not delete the files yourself; '
                + 'a build compiles what is out of date either way.');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /clean on MPS3 ⚠️ exit 0, not confirmed [\d.]+ s ago \(job c-1, .*\nClean job c-1 exited 0, but that does not confirm it: out\/Blinky/);
        });

        test('nothing built before, or a solution named through a variable: cleaned, and the result says what it could tell', async () => {
            const w = make();
            const none = await diagnosed(w, runClean(w, () => undefined).id);
            assert.strictEqual(none.diagnosis?.check, 'cleaned');
            assert.strictEqual(none.diagnosis?.text, 'No image of MPS3 was there to remove.');
            builtLayout(w);
            // The solution named through a variable, and CMSIS Solution does not say which one is active either.
            w.host.solutionFile = async () => undefined;
            const unknown = await diagnosed(w, runClean(w, () => undefined, { solution: '${command:cmsis-csolution.getSolutionFile}' }).id);
            assert.strictEqual(unknown.diagnosis?.check, 'cleaned');
            assert.strictEqual(unknown.diagnosis?.text, 'Which images were there before the clean is not known, so their removal was not checked.');
        });

        test('a clean whose task names no solution, as one started through CMSIS Solution\'s API: the active solution\'s images are read at its start', async () => {
            const w = make();
            const image = builtLayout(w);
            const job = w.tracker.begin('clean', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution({
                name: 'cbuild --clean --schema', source: 'cmsis-csolution.build',
                definition: { type: 'cmsis-csolution.build', clean: true, rebuild: false, downloadPacks: false, updateRte: false },
            }));
            // CMSIS Solution names the solution and the target set before cbuild gets to the images.
            await rounds(5);
            fs.rmSync(image);
            w.clock.advance(w.clock.now() + 1_000);
            w.tasks.finish(execution, 0);
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.diagnosis?.check, done.diagnosis?.text], ['cleaned', 'Removed: out/Blinky/MPS3/Debug/Blinky.axf.']);
        });
    });

    suite('a build whose result CMSIS Solution captured needs no check and no re-run (#140)', () => {
        const CAPTURED = path.resolve(__dirname, '..', '..', '..', 'src', 'test', 'fixtures', 'buildresult');
        const output = (name: string): string => fs.readFileSync(path.join(CAPTURED, `${name}.txt`), 'utf8');
        /** What `build()` of API version 3 starts: a task whose definition names neither the solution nor the target. */
        const API_TASK: FixtureTask = {
            name: 'cbuild --active "" --schema', source: 'cmsis-csolution.build',
            definition: { type: 'cmsis-csolution.build', clean: false, rebuild: false, downloadPacks: false, updateRte: false },
        };
        interface Capture {
            asked: FakeExecution[];
            /** Settle the result of the n-th build task that started. */
            settle(index: number, result: unknown): void;
            refuse(index: number, error: Error): void;
        }
        /** A host with `getBuildResult`: each started build task is asked for, and the test settles its result. */
        const capturing = (w: World): Capture => {
            const pending: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
            const asked: FakeExecution[] = [];
            w.host.buildResult = (execution) => {
                asked.push(execution as FakeExecution);
                return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }));
            };
            return { asked, settle: (index, result) => pending[index].resolve(result), refuse: (index, error) => pending[index].reject(error) };
        };
        /** A build job whose task starts, ends with `exitCode` 3 s later, and whose captured result is `result`. */
        const captured = (w: World, capture: Capture, exitCode: number | undefined, result: unknown, task: FixtureTask = buildTask(w), action: JobAction = 'build'): Job => {
            const job = w.tracker.begin(action, 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution(task));
            w.clock.advance(w.clock.now() + 3_000);
            capture.settle(capture.asked.indexOf(execution), result);
            w.tasks.finish(execution, exitCode);
            return job;
        };
        const logOfTarget = (w: World, target: string): string => path.join(w.dir, 'out', 'cmsis-developer-assistant', `build-${target}.log`);

        test('exit 0 is the success: the warnings of the output are in the result, the output is the log, nothing is re-run', async () => {
            const w = make();
            const capture = capturing(w);
            // An image older than the build would send the old check into a re-run.
            builtLayout(w, { ageMs: 3_600_000 });
            const job = captured(w, capture, 0, { exitCode: 0, output: output('rebuild-ok') });
            assert.deepStrictEqual(w.tracker.job(job.id)?.diagnosis, { state: 'pending', source: 'build', errors: [], warnings: [], errorCount: 0, warningCount: 0, text: '' });
            const done = await diagnosed(w, job.id);
            assert.strictEqual(capture.asked.length, 1, 'asked once, when the task started');
            assert.strictEqual(done.state, 'ok');
            assert.deepStrictEqual([done.diagnosis?.check, done.diagnosis?.source, done.diagnosis?.errorCount, done.diagnosis?.warningCount], ['succeeded', 'build', 0, 5]);
            assert.strictEqual(w.children.length, 0, 'no diagnostic re-run of cbuild');
            const logFile = logOfTarget(w, 'MPS3');
            assert.strictEqual(done.diagnosis?.logFile, logFile);
            const log = fs.readFileSync(logFile, 'utf8');
            assert.ok(log.startsWith('[cmsis-developer-assistant] Output of \'cbuild Blinky.csolution.yml --active MPS3 --packs\' as CMSIS Solution captured it; cbuild exit code 0.\n'), log);
            assert.ok(!/[\x1b\r]/.test(log) && log.includes('\nWarning: A1950W: The legacy armasm assembler is deprecated.'), 'the output without its control sequences');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string' && reply.status === 'ok');
            assert.strictEqual(reply.text, [
                '✅ CMSIS \'build\' succeeded on MPS3 (task \'cbuild Blinky.csolution.yml --active MPS3 --packs\' exited 0 after 3 s, cbuild\'s own exit code, job b-1). '
                    + 'The firmware is built — use cmsis_action load or load_and_debug to flash it.',
                '5 warnings in its output:',
                '  warning csolution: file \'/work/Blinky/RTE/Device/nRF52833_xxAA/arm_startup_nrf52833.s.base\' not found; base version unknown',
                '  warning: argument unused during compilation: \'-MD\' [-Wunused-command-line-argument]',
                '  warning: argument unused during compilation: \'-MT …\' [-Wunused-command-line-argument]',
                '  warning: argument unused during compilation: \'-MF …\' [-Wunused-command-line-argument]',
                '  warning A1950W: The legacy armasm assembler is deprecated. Consider using the armclang integrated assembler instead.',
                'Full output: out/cmsis-developer-assistant/build-MPS3.log (get_build_diagnostics reads it).',
            ].join('\n'));
            const data = reply.data?.diagnosis as Record<string, unknown>;
            assert.deepStrictEqual([data.state, data.check, data.source, data.warningCount, data.logFile], ['done', 'succeeded', 'build', 5, logFile]);
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /Last results: build on MPS3 ✅ [\d.]+ s ago \(job b-1, /);
            assert.ok(idle.includes('\nBuild job b-1 succeeded: 5 warnings in its output:\n'), idle);
        });

        test('a build without a warning says only whose exit code it is', async () => {
            const w = make();
            const capture = capturing(w);
            const job = captured(w, capture, 0, { exitCode: 0, output: '(1/1) Building context: "Blinky.Debug+MPS3"\r\nninja: no work to do.\r\r\n' });
            const done = await diagnosed(w, job.id);
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.match(reply.text, /^✅ CMSIS 'build' succeeded on MPS3 \(task '.*' exited 0 after 3 s, cbuild's own exit code, job b-1\)\. The firmware is built — use cmsis_action load or load_and_debug to flash it\.$/);
            assert.ok(!idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()).includes('succeeded:'));
        });

        test('the CMake recommendation of a successful build reaches the result, with the code tool-version', async () => {
            const w = make();
            const capture = capturing(w);
            const line = 'CMake 4.2.1 or newer is recommended for CMSIS-Toolbox. You are using CMake 3.31.12.';
            const job = captured(w, capture, 0, { exitCode: 0, output: `${line}\r\n${output('build-noop')}` });
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual(done.diagnosis?.warnings[0], { severity: 'warning', code: 'tool-version', message: line });
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string' && reply.text.includes(`\n2 warnings in its output:\n  warning tool-version: ${line}\n`), JSON.stringify(reply));
        });

        test('another exit code is the failure: the error lines come from the build\'s own output', async () => {
            const w = make();
            const capture = capturing(w);
            const job = captured(w, capture, 1, { exitCode: 1, output: output('build-error') });
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.state, 'failed');
            assert.deepStrictEqual([done.diagnosis?.source, done.diagnosis?.check, done.diagnosis?.errorCount, done.diagnosis?.warningCount], ['build', undefined, 3, 1]);
            assert.strictEqual(w.children.length, 0, 'no diagnostic re-run of cbuild');
            const failure = resultError(done, w.clock.now());
            assert.match(failure.message, /^❌ CMSIS 'build' FAILED on MPS3 — task '.*' exited with code 1 after 3 s \(job b-1\)\.\n3 errors in the build's own output \(cbuild exit 1\), 1 warning:\n {2}…\/work\/Blinky\/Blinky\.c:43:19 error: expected parameter declarator\n/);
            assert.ok(failure.message.endsWith('\nFull log: out/cmsis-developer-assistant/build-MPS3.log (get_build_diagnostics reads it).'), failure.message);
            assert.strictEqual(failure.hint, 'Fix the first error, then cmsis_action build again. This is a terminal result — do not wait for an output file.');
            assert.ok(fs.readFileSync(logOfTarget(w, 'MPS3'), 'utf8').includes('cbuild exit code 1.\n'));
        });

        test('a linker error is read from the output as well', async () => {
            const w = make();
            const capture = capturing(w);
            const done = await diagnosed(w, captured(w, capture, 1, { exitCode: 1, output: output('build-link-error') }).id);
            assert.deepStrictEqual(done.diagnosis?.errors, [{ severity: 'error', code: 'L6218E', message: 'Undefined symbol probe_missing (referred from Blinky.o).' }]);
        });

        test('a task that closed with 0 although cbuild did not is a failed build', async () => {
            const w = make();
            const capture = capturing(w);
            const done = await diagnosed(w, captured(w, capture, 0, { exitCode: 1, output: output('build-error') }).id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check], ['failed', 'failed']);
        });

        test('no exit code is never a success: the build was skipped or stopped, and nothing is re-run', async () => {
            const w = make();
            const capture = capturing(w);
            builtLayout(w, { ageMs: 3_600_000 });
            const done = await diagnosed(w, captured(w, capture, 0, { output: '' }).id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check], ['ok', 'unverified']);
            assert.strictEqual(w.children.length, 0);
            assert.ok(!fs.existsSync(logOfTarget(w, 'MPS3')), 'no log of a build that has no result');
            const reply = jobResult(done, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof reply !== 'string');
            assert.match(reply.text, /^⚠️ CMSIS 'build' on MPS3: task '.*' exited 0 after 3 s \(job b-1\), but that does not confirm the build\. CMSIS Solution recorded no exit code of cbuild for it: the build was skipped as a duplicate of one already queued, or stopped\. Before you load this image, ask the user/);
        });

        test('a build stopped with Stop Build is cancelled as before: no diagnosis, and its result is let go', async () => {
            const w = make();
            const capture = capturing(w);
            const job = captured(w, capture, BUILD_STOPPED_EXIT_CODE, { output: output('rebuild-stopped-command') });
            await rounds();
            assert.deepStrictEqual([w.tracker.job(job.id)?.state, w.tracker.job(job.id)?.diagnosis], ['cancelled', undefined]);
            assert.ok(!fs.existsSync(logOfTarget(w, 'MPS3')));
        });

        test('the solution and the target set are those of the task\'s start, also for a task that names neither', async () => {
            const w = make();
            const capture = capturing(w);
            let active = 'MPS3@debug';
            w.host.activeTarget = async () => active;
            const job = w.tracker.begin('build', 'MPS3@debug');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution(API_TASK));
            await rounds(5);
            active = 'Other';
            w.clock.advance(w.clock.now() + 3_000);
            capture.settle(0, { exitCode: 0, output: output('build-warning') });
            w.tasks.finish(execution, 0);
            const done = await diagnosed(w, job.id);
            assert.strictEqual(done.diagnosis?.logFile, logOfTarget(w, 'MPS3@debug'));
            assert.ok(fs.readFileSync(logOfTarget(w, 'MPS3@debug'), 'utf8').startsWith('[cmsis-developer-assistant] Output of \'cbuild --active "" --schema\' as CMSIS Solution captured it;'));
            assert.ok(!fs.existsSync(logOfTarget(w, 'Other')));
        });

        test('a clean that exited 0 is cleaned, and leaves the log of the build before it', async () => {
            const w = make();
            const capture = capturing(w);
            await diagnosed(w, captured(w, capture, 0, { exitCode: 0, output: output('build-noop') }).id);
            const before = fs.readFileSync(logOfTarget(w, 'MPS3'), 'utf8');
            const image = builtLayout(w);
            const cleanTask: FixtureTask = { name: 'cbuild Blinky.csolution.yml --clean', source: 'cmsis-csolution.build', definition: { ...buildTask(w).definition, clean: true } };
            const job = w.tracker.begin('clean', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution(cleanTask));
            fs.rmSync(image);
            w.clock.advance(w.clock.now() + 1_000);
            capture.settle(1, { exitCode: 0, output: output('clean') });
            w.tasks.finish(execution, 0);
            const done = await diagnosed(w, job.id);
            assert.deepStrictEqual([done.state, done.diagnosis?.check, done.diagnosis?.text], ['ok', 'cleaned', 'Removed: out/Blinky/MPS3/Debug/Blinky.axf.']);
            assert.strictEqual(fs.readFileSync(logOfTarget(w, 'MPS3'), 'utf8'), before);
        });

        test('an image a clean left is named, not doubted: the exit code is cbuild\'s own', async () => {
            const w = make();
            const capture = capturing(w);
            builtLayout(w);
            const cleanTask: FixtureTask = { name: 'cbuild Blinky.csolution.yml --clean', source: 'cmsis-csolution.build', definition: { ...buildTask(w).definition, clean: true } };
            const done = await diagnosed(w, captured(w, capture, 0, { exitCode: 0, output: output('clean') }, cleanTask, 'clean').id);
            assert.deepStrictEqual([done.diagnosis?.check, done.diagnosis?.text], ['cleaned', 'cbuild exited 0, and out/Blinky/MPS3/Debug/Blinky.axf is still there.']);
        });

        test('a result CMSIS Solution refuses leaves the build to the old check', async () => {
            const w = make();
            const capture = capturing(w);
            const job = w.tracker.begin('build', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            capture.refuse(0, new Error('No captured build result is available for this task execution'));
            w.clock.advance(w.clock.now() + 3_000);
            w.tasks.finish(execution, 2);
            await until(() => w.children.length === 1, 'cbuild was re-run');
            w.children[0].finish(1, GCC_LOG);
            assert.strictEqual((await diagnosed(w, job.id)).diagnosis?.source, 'rerun');
        });

        test('a result of another shape leaves the build to the old check', async () => {
            const w = make();
            const capture = capturing(w);
            const image = builtLayout(w, { ageMs: 3_600_000 });
            const job = w.tracker.begin('build', 'MPS3');
            w.tracker.issued(job.id);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            fs.writeFileSync(image, 'ELF, linked again');
            w.clock.advance(w.clock.now() + 3_000);
            capture.settle(0, { status: 'success', logFile: '/tmp/build.log' });
            w.tasks.finish(execution, 0);
            assert.strictEqual((await diagnosed(w, job.id)).diagnosis?.check, 'rebuilt');
        });

        test(`a result that has not settled ${10} s after the task ended leaves the build to the old check`, async () => {
            const w = make();
            capturing(w);
            const image = builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w, {}, 'build', () => fs.writeFileSync(image, 'ELF, linked again'));
            await rounds();
            assert.strictEqual(w.tracker.job(job.id)?.diagnosis?.state, 'pending');
            const early = jobResult(w.tracker.job(job.id) as Job, { tag: ' on MPS3', now: w.clock.now() });
            assert.ok(typeof early !== 'string' && early.status === 'running');
            assert.match(early.text, /exited 0 after 3 s \(job b-1\); the output CMSIS Solution captured for it is still being read\. Call cmsis_action \{action:'status'\} for the result — do not start another build\./);
            w.clock.advance(w.clock.now() + 10_000);
            assert.strictEqual((await diagnosed(w, job.id)).diagnosis?.check, 'rebuilt');
        });

        test('a host without getBuildResult is never asked, and builds are checked as before', async () => {
            const w = make();
            const image = builtLayout(w, { ageMs: 3_600_000 });
            const { job } = passBuild(w, {}, 'build', () => fs.writeFileSync(image, 'ELF, linked again'));
            assert.deepStrictEqual(w.tracker.job(job.id)?.diagnosis?.source, 'none', 'the pending check of before');
            assert.strictEqual((await diagnosed(w, job.id)).diagnosis?.check, 'rebuilt');
        });

        test('a build the user started in the CMSIS view gets its result the same way', async () => {
            const w = make();
            const capture = capturing(w);
            const execution = w.tasks.start(w.tasks.execution(buildTask(w)));
            w.clock.advance(w.clock.now() + 3_000);
            capture.settle(0, { exitCode: 0, output: output('build-warning') });
            w.tasks.finish(execution, 0);
            await until(() => w.tracker.recent().some((job) => job.diagnosis?.state === 'done'), 'the adopted job is diagnosed');
            const adopted = w.tracker.recent()[0];
            assert.deepStrictEqual([adopted.origin, adopted.diagnosis?.check, adopted.diagnosis?.warningCount], ['adopted', 'succeeded', 2]);
            assert.ok(fs.existsSync(logOfTarget(w, 'MPS3')));
        });
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
            assert.ok(failure.message.endsWith('\nError lines: still being collected (a diagnostic re-run of cbuild with --log, at most 30 min).'), failure.message);
            assert.strictEqual(failure.hint, 'Call cmsis_action {action:\'status\'} for the error lines — do not start another build to see them. '
                + 'This is a terminal result — do not wait for an output file.');
            assert.match(idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now()),
                /\nThe error lines of build job b-1 are still being collected — cmsis_action \{action:'status'\} again shows them\.\n/);

            const status = w.tracker.waitFor(job.id, w.clock.now() + 60_000);
            w.children[0].finish(1, GCC_LOG);
            await status;
            const idle = idleStatus(w.tracker.recent(), w.tracker.liveExecutions(), w.clock.now());
            assert.match(idle, /^No CMSIS job in flight in this window\. Last results: build on MPS3 ❌ exit 2 [\d.]+ s ago \(job b-1, '.*'\)\.\nBuild job b-1 failed: 2 errors \(from a diagnostic re-run of cbuild with --log; /);
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
