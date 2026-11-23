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

// The target as the CMSIS Solution extension knows it: its active cbuild-run before the workspace
// scan, and the folders of the target's DFP and BSP before the pack root, with today's lookups as
// the fallback. A pack a csolution names with `path:` lies outside the pack root.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BuildInfoHost, defaultBuildInfoSettings } from '../core/buildInfo/host';
import { discoverIndexes } from '../core/knowledge/packIndexes';
import { projectFacts } from '../core/knowledge/projectFacts';
import { formatPackId } from '../core/packDocs/cbuildRun';
import { PackDocsHost } from '../core/packDocs/host';
import { holdsPack } from '../core/packDocs/pdscBooks';
import { collectTargetDocs, locatePack, namedPackFolders, resolveSvd, resolveTarget, TargetResolution } from '../core/packDocs/targetDocs';
import type { SolutionApi } from '../core/solutionApi';
import { activeCbuildRunFile, activePackFolders, SolutionSource } from '../utils/solutionQueries';
import { buildWorld, World } from './packDocsHandler.test';
import { SAMPLE_CBUILD_RUN } from './cbuildRun.test';

/** The getters of CMSIS Solution's API version 3 that these tests script. */
const GET_BSP_PATH = 'getBspPath';
const GET_CBUILD_RUN_FILE = 'getCbuildRunFile';
const GET_DFP_PATH = 'getDfpPath';

/** A CMSIS Solution extension behind the real query layer: active, with the getters its API version 3 answers. */
function extension(answers: Record<string, () => unknown>, options: { active?: boolean; registered?: string[] } = {}): SolutionSource {
    const api: Record<string, () => Promise<unknown>> = {};
    for (const name of options.registered ?? Object.keys(answers)) {
        api[name] = async () => answers[name]?.();
    }
    return {
        extensionActive: () => options.active ?? true,
        api: () => api as unknown as SolutionApi,
        timeoutMs: 50,
    };
}

/** The pack-docs host asking `source` the way the extension's host does. */
function asking(host: PackDocsHost, source: SolutionSource): PackDocsHost {
    return { ...host, activeCbuildRunFile: () => activeCbuildRunFile(source), activePackFolders: () => activePackFolders(source) };
}

function resolved(result: Awaited<ReturnType<typeof resolveTarget>>): TargetResolution {
    assert.ok(!('error' in result), JSON.stringify(result));
    return result;
}

suite('The target from the CMSIS Solution extension (getCbuildRunFile, getDfpPath, getBspPath)', () => {
    let world: World;
    /** The world's cbuild-run, under out/. */
    let blinky: string;
    /** A second solution's cbuild-run with another device: the scan alone is ambiguous. */
    let other: string;
    /** A cbuild-run that names no device-pack. */
    let bare: string;
    /** A development copy of the DFP outside the pack root, as `path:` names it, with its knowledge index. */
    let devDfp: string;
    /** The cbuild-run of the solution that uses it (2.8 layout: next to the csolution), and the folder of its cbuild.yml. */
    let devRun: string;
    let devCbuildDir: string;
    let scanned: number;
    let scanHost: PackDocsHost;

    suiteSetup(() => {
        world = buildWorld();
        blinky = path.join(world.workspace, 'out', 'Blinky', 'STM32F756ZGTx', 'Debug', 'Blinky+STM32F756ZGTx.cbuild-run.yml');
        other = path.join(world.workspace, 'other', 'Other+HP.cbuild-run.yml');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, SAMPLE_CBUILD_RUN.replace('target-type: STM32F756ZGTx', 'target-type: HP')
            .replace('device: STMicroelectronics::STM32F756ZGTx', 'device: STMicroelectronics::STM32F746NGHx'));
        bare = path.join(world.workspace, 'bare+X.cbuild-run.yml');
        fs.writeFileSync(bare, 'cbuild-run:\n  generated-by: csolution\n  target-type: X\n');

        devDfp = path.join(world.root, 'dev-packs', 'STM32F7xx_DFP');
        const installed = path.join(world.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0');
        for (const part of ['Documentation', path.join('CMSIS', 'SVD'), '.knowledge']) {
            fs.mkdirSync(path.join(devDfp, part), { recursive: true });
        }
        fs.writeFileSync(path.join(devDfp, 'Keil.STM32F7xx_DFP.pdsc'), fs.readFileSync(path.join(installed, 'Keil.STM32F7xx_DFP.pdsc'), 'utf-8')
            .replace('<release version="3.0.0"', '<release version="3.1.0-dev"'));
        fs.copyFileSync(path.join(installed, 'Documentation', 'test-rm.pdf'), path.join(devDfp, 'Documentation', 'test-rm.pdf'));
        fs.copyFileSync(path.join(installed, 'CMSIS', 'SVD', 'test.svd'), path.join(devDfp, 'CMSIS', 'SVD', 'test.svd'));
        fs.writeFileSync(path.join(devDfp, '.knowledge', 'knowledge.db'), '');

        devRun = path.join(world.workspace, 'Dev+STM32F756ZGTx.cbuild-run.yml');
        devCbuildDir = path.join(world.workspace, 'out', 'Dev', 'STM32F756ZGTx', 'Debug');
        fs.mkdirSync(devCbuildDir, { recursive: true });
        fs.writeFileSync(devRun, SAMPLE_CBUILD_RUN.replace('Keil::STM32F7xx_DFP@3.0.0', 'Keil::STM32F7xx_DFP@3.1.0-dev')
            .replace(/  board: .*\n  board-pack: .*\n/, '')
            + '  output:\n    - file: out/Dev/STM32F756ZGTx/Debug/Dev.axf\n      type: elf\n');
    });

    setup(() => {
        scanned = 0;
        scanHost = { ...world.host, findCbuildRunFiles: async () => { scanned++; return [blinky, other]; } };
    });

    test('the active cbuild-run decides before the workspace scan', async () => {
        const ambiguous = await resolveTarget(scanHost, {});
        assert.ok('error' in ambiguous && /2 cbuild-run contexts with different targets/.test(ambiguous.error), JSON.stringify(ambiguous));
        scanned = 0;
        const res = resolved(await resolveTarget(asking(scanHost, extension({ [GET_CBUILD_RUN_FILE]: () => other })), {}));
        assert.strictEqual(res.cbuildRunFile, other);
        assert.strictEqual(res.device?.name, 'STM32F746NGHx');
        assert.strictEqual(scanned, 0, 'no workspace scan');
    });

    test('the scan stays the fallback: inactive extension, missing getter, "", timeout, failure, a missing or bare file', async () => {
        const fallbacks: Record<string, SolutionSource> = {
            'inactive extension': extension({ [GET_CBUILD_RUN_FILE]: () => other }, { active: false }),
            'missing getter': extension({ [GET_CBUILD_RUN_FILE]: () => other }, { registered: ['getSolutionFile'] }),
            '""': extension({ [GET_CBUILD_RUN_FILE]: () => '' }),
            'timeout': extension({ [GET_CBUILD_RUN_FILE]: () => new Promise(() => { /* never answers */ }) }),
            'failure': extension({ [GET_CBUILD_RUN_FILE]: () => { throw new Error('no solution loaded'); } }),
            'a relative answer': extension({ [GET_CBUILD_RUN_FILE]: () => 'other/Other+HP.cbuild-run.yml' }),
            'a file that does not exist': extension({ [GET_CBUILD_RUN_FILE]: () => path.join(world.workspace, 'gone+HP.cbuild-run.yml') }),
            'a file without device-pack': extension({ [GET_CBUILD_RUN_FILE]: () => bare }),
        };
        for (const [why, source] of Object.entries(fallbacks)) {
            scanned = 0;
            const res = await resolveTarget(asking(scanHost, source), {});
            assert.ok('error' in res && /2 cbuild-run contexts with different targets/.test(res.error), `${why}: ${JSON.stringify(res)}`);
            assert.strictEqual(scanned, 1, `${why}: the workspace was scanned`);
        }
        const throwingHost: PackDocsHost = { ...scanHost, activeCbuildRunFile: async () => { throw new Error('host failed'); } };
        assert.ok('error' in await resolveTarget(throwingHost, {}));
    });

    test('an explicit target, cbuildRunFile or pack leaves the answer out', async () => {
        const host = asking(scanHost, extension({ [GET_CBUILD_RUN_FILE]: () => other }));
        assert.strictEqual(resolved(await resolveTarget(host, { target: 'STM32F756' })).cbuildRunFile, blinky);
        assert.strictEqual(scanned, 1);
        assert.strictEqual(resolved(await resolveTarget(host, { cbuildRunFile: blinky })).cbuildRunFile, blinky);
        const byPack = resolved(await resolveTarget(host, { pack: 'Keil::STM32F7xx_DFP@3.0.0', device: 'STM32F756ZGTx' }));
        assert.strictEqual(byPack.cbuildRunFile, undefined);
        assert.strictEqual(byPack.devicePack?.version, '3.0.0');
    });

    test('without the extension, another installed version stands in, and the note says so', async () => {
        const res = resolved(await resolveTarget(world.host, { cbuildRunFile: devRun }));
        assert.strictEqual(res.packDirs, undefined);
        const docs = collectTargetDocs(world.host, res);
        assert.ok(docs.notes.includes(`pack Keil::STM32F7xx_DFP@3.1.0-dev is not installed under ${world.packRoot}; `
            + 'using Keil::STM32F7xx_DFP@3.0.0, another version than the one asked for'), docs.notes.join('\n'));
        const notes: string[] = [];
        assert.strictEqual(locatePack(world.packRoot, { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.0.0' }, notes)?.dir,
            path.join(world.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0'));
        assert.deepStrictEqual(notes, [], 'the exact version needs no note');
    });

    test('a path: pack outside the pack root: its PDSC, documents, cores and SVD, from an absolute or a relative answer', async () => {
        const answers: Record<string, string> = {
            absolute: devDfp,
            'relative to the cbuild.yml': path.relative(devCbuildDir, devDfp),
        };
        for (const [kind, dfp] of Object.entries(answers)) {
            const host = asking(world.host, extension({
                [GET_CBUILD_RUN_FILE]: () => devRun, [GET_DFP_PATH]: () => dfp, [GET_BSP_PATH]: () => '<not found>',
            }));
            const res = resolved(await resolveTarget(host, {}));
            assert.strictEqual(res.cbuildRunFile, devRun, kind);
            assert.deepStrictEqual(res.packDirs, { devicePack: devDfp }, kind);
            const docs = collectTargetDocs(host, res);
            assert.ok(docs.docs.some((d) => d.title === 'Test Reference Manual' && d.path?.startsWith(devDfp)), `${kind}: ${docs.docs.map((d) => d.path).join(', ')}`);
            assert.ok(docs.processors.some((p) => p.core === 'Cortex-M7'), kind);
            assert.ok(!docs.notes.some((n) => n.includes('another version')), `${kind}: ${docs.notes.join('; ')}`);
            assert.ok(docs.notes.includes(`device-pack Keil::STM32F7xx_DFP@3.1.0-dev read from ${devDfp}, the folder the CMSIS Solution extension names for it`),
                docs.notes.join('\n'));
            assert.ok(resolveSvd(host, res)?.path.startsWith(devDfp), kind);

            const build = { workspaceFolders: () => [world.workspace], findFiles: async () => [], settings: () => defaultBuildInfoSettings, log: world.host.log };
            const facts = await projectFacts(host, build);
            assert.deepStrictEqual(facts.facts?.cores, ['Cortex-M7'], `${kind}: ${JSON.stringify(facts)}`);
        }
    });

    test('a folder counts only when its PDSC is the pack: "<not found>", another pack or another version fall back', async () => {
        const bsp = path.join(world.packRoot, 'Keil', 'NUCLEO-F756ZG_BSP', '2.0.0');
        const installed = path.join(world.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0');
        assert.ok(holdsPack(devDfp, { vendor: 'keil', name: 'stm32f7xx_dfp', version: '3.1.0-dev' }), 'vendor and name case aside');
        assert.ok(holdsPack(devDfp, { vendor: 'Keil', name: 'STM32F7xx_DFP' }), 'no version asked for');
        assert.ok(!holdsPack(installed, { vendor: 'Keil', name: 'STM32F7xx_DFP', version: '3.1.0-dev' }));
        assert.ok(!holdsPack(path.join(world.root, 'nowhere'), { vendor: 'Keil', name: 'STM32F7xx_DFP' }));
        for (const [why, dfp] of [['"<not found>"', '<not found>'], ['another pack', bsp], ['another version', installed]]) {
            const host = asking(world.host, extension({ [GET_CBUILD_RUN_FILE]: () => devRun, [GET_DFP_PATH]: () => dfp, [GET_BSP_PATH]: () => '' }));
            const res = resolved(await resolveTarget(host, {}));
            assert.strictEqual(res.packDirs, undefined, why);
            const docs = collectTargetDocs(host, res);
            assert.ok(docs.notes.some((n) => n.includes('another version than the one asked for')), `${why}: ${docs.notes.join('; ')}`);
        }
    });

    test('the BSP folder is the board pack\'s, and an installed folder needs no note', async () => {
        const installed = path.join(world.packRoot, 'Keil', 'STM32F7xx_DFP', '3.0.0');
        const host = asking(world.host, extension({ [GET_CBUILD_RUN_FILE]: () => blinky, [GET_DFP_PATH]: () => installed, [GET_BSP_PATH]: () => devDfp }));
        const res = resolved(await resolveTarget(host, {}));
        assert.deepStrictEqual(res.packDirs, { devicePack: installed }, 'the BSP answer holds no NUCLEO-F756ZG_BSP');
        const docs = collectTargetDocs(host, res);
        assert.ok(!docs.notes.some((n) => n.includes('the folder the CMSIS Solution extension names')), docs.notes.join('; '));
    });

    test('the knowledge index of the path: pack is discovered, labelled like a local pack, and only once', async () => {
        const host = asking(world.host, extension({ [GET_CBUILD_RUN_FILE]: () => devRun, [GET_DFP_PATH]: () => devDfp }));
        const named = await namedPackFolders(host);
        assert.deepStrictEqual(named.map(({ pack, dir }) => [formatPackId(pack), dir]), [['Keil::STM32F7xx_DFP@3.1.0-dev', devDfp]]);
        const folders = named.map(({ pack, dir }) => ({ pack: formatPackId(pack), dir }));
        assert.deepStrictEqual(discoverIndexes(world.packRoot, [], folders),
            [{ label: 'Keil::STM32F7xx_DFP@3.1.0-dev (local)', file: path.join(devDfp, '.knowledge', 'knowledge.db') }]);
        assert.deepStrictEqual(discoverIndexes(world.packRoot, [], [...folders, ...folders]).length, 1, 'no file twice');
        // Without the extension there is nothing beyond the pack root.
        assert.deepStrictEqual(await namedPackFolders(world.host), []);
        assert.deepStrictEqual(await namedPackFolders(asking(world.host, extension({ [GET_DFP_PATH]: () => devDfp }, { active: false }))), []);
    });
});

/**
 * What a knowledge search knows about the project without being told. The
 * documentation and build-artefact cores resolve it; `projectFacts` puts
 * their answers together and never throws.
 */
suite('The project facts of a knowledge search (device, board, packs, cores, compiler, components)', () => {
    let world: World;
    let blinky: string;
    /** The build-artefact host of the world, finding these cbuild-run files. */
    const buildOf = (files: string[]): BuildInfoHost =>
        ({ workspaceFolders: () => [world.workspace], findFiles: async () => files, settings: () => defaultBuildInfoSettings, log: world.host.log });

    suiteSetup(async () => {
        world = buildWorld();
        [blinky] = await world.host.findCbuildRunFiles();
    });

    test('the device, the board with its vendor, their packs and the cores of the device pack; the compiler once there is a build', async () => {
        const target = { device: 'STM32F756ZGTx', board: 'STMicroelectronics::NUCLEO-F756ZG', packs: ['Keil::STM32F7xx_DFP', 'Keil::NUCLEO-F756ZG_BSP'], cores: ['Cortex-M7'] };
        assert.deepStrictEqual(await projectFacts(world.host, buildOf([])), { facts: target }, 'no cbuild-run for the build tools: no compiler, no components');
        // The cbuild-run names the compiler; it lists no image, so there is no cbuild.yml to read components from.
        assert.deepStrictEqual(await projectFacts(world.host, buildOf([blinky])), { facts: { ...target, compiler: 'AC6', components: [] } });
    });

    test('the components and the other packs come from the cbuild.yml next to the image, and the compiler too when the cbuild-run names none', async () => {
        const run = path.join(world.workspace, 'Facts+STM32F756ZGTx.cbuild-run.yml');
        const outDir = path.join(world.workspace, 'out', 'Facts', 'STM32F756ZGTx', 'Debug');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(run, SAMPLE_CBUILD_RUN.replace('  compiler: AC6\n', '').replace(/  board: .*\n  board-pack: .*\n/, '')
            + '  output:\n    - file: out/Facts/STM32F756ZGTx/Debug/Facts.axf\n      type: elf\n');
        fs.writeFileSync(path.join(outDir, 'Facts.Debug+STM32F756ZGTx.cbuild.yml'), [
            'build:', '  generated-by: csolution version 2.9.0', '  context: Facts.Debug+STM32F756ZGTx', '  compiler: GCC', '  device: STMicroelectronics::STM32F756ZGTx',
            '  packs:', '    - pack: ARM::CMSIS@6.1.0', '      path: ${CMSIS_PACK_ROOT}/ARM/CMSIS/6.1.0', '    - pack: Keil::STM32F7xx_DFP@3.0.0',
            '  components:', '    - component: ARM::CMSIS:CORE@6.1.0', '      condition: ARMv6_7_8-M Device', '    - component: "Keil::Device:Startup@1.2.0"', '',
        ].join('\n'));
        const result = await projectFacts({ ...world.host, findCbuildRunFiles: async () => [run] }, buildOf([run]));
        assert.deepStrictEqual(result, {
            facts: {
                device: 'STM32F756ZGTx', packs: ['Keil::STM32F7xx_DFP', 'ARM::CMSIS'], cores: ['Cortex-M7'], compiler: 'GCC',
                components: ['ARM::CMSIS:CORE@6.1.0', 'Keil::Device:Startup@1.2.0'],
            },
        }, 'no board in this cbuild-run; the device pack is named once, without its version');
    });

    test('what is missing is said in one line, and the search runs without it', async () => {
        assert.deepStrictEqual(await projectFacts({ ...world.host, workspaceFolders: () => [] }, buildOf([])), { note: 'no folder is open' });

        // Two contexts with different devices: the first line of the refusal, without the list under it.
        const other = path.join(world.workspace, 'other', 'Other+HP.cbuild-run.yml');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, SAMPLE_CBUILD_RUN.replace('target-type: STM32F756ZGTx', 'target-type: HP')
            .replace('device: STMicroelectronics::STM32F756ZGTx', 'device: STMicroelectronics::STM32F746NGHx'));
        const ambiguous = { ...world.host, findCbuildRunFiles: async () => [blinky, other] };
        const refusal = await resolveTarget(ambiguous, {});
        assert.ok('error' in refusal && refusal.error.includes('\n'), 'the refusal itself lists the contexts');
        assert.deepStrictEqual(await projectFacts(ambiguous, buildOf([])), { note: '2 cbuild-run contexts with different targets — pass target to pick one:' });

        // The device pack is not under the pack root: the facts stay, without the cores, and the note says why.
        const emptyRoot = path.join(world.root, 'empty-root');
        const unknownCore = await projectFacts({ ...world.host, packRoot: emptyRoot }, buildOf([]));
        assert.deepStrictEqual(unknownCore.facts, { device: 'STM32F756ZGTx', board: 'STMicroelectronics::NUCLEO-F756ZG', packs: ['Keil::STM32F7xx_DFP', 'Keil::NUCLEO-F756ZG_BSP'] });
        assert.strictEqual(unknownCore.note, `the core of STM32F756ZGTx is not known (pack Keil::STM32F7xx_DFP@3.0.0 is not installed under ${emptyRoot})`);
    });

    test('a host that fails costs the facts, not the search', async () => {
        const logged = world.lines.length;
        const failing = { ...world.host, workspaceFolders: (): string[] => { throw new Error('the folders are gone'); } };
        assert.deepStrictEqual(await projectFacts(failing, buildOf([])), { note: 'the project could not be read' });
        assert.deepStrictEqual(world.lines.slice(logged), ['D knowledge: no project facts: the folders are gone']);
    });
});
