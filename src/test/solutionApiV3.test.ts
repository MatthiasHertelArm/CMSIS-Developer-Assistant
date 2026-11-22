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

// CMSIS Solution's API version 3 behind cmsis_query and cmsis_action (2.9.1): the seam asks for
// version 3 and falls back to 2; every method of version 3 is detected by name; the new query
// kinds (packs, toolchains, debuggers, environment) against a scripted version 3, shaped as the
// nightly 1.72.1-86 answers; the install result of installPacks; the getters through the API.

import * as assert from 'assert';
import {
    acquireSolutionApi,
    ApiPackQuery,
    Clock,
    peekSolutionApi,
    requireV3Method,
    SolutionApi,
    solutionApiVersion,
    SolutionExtensionHandle,
    v3Method,
} from '../core/solutionApi';
import { querySolution, SolutionQuery } from '../core/solutionQuery';
import { ErrorCode, errorDetail, ToolError, ToolReply } from '../core/toolResult';
import { convertResult } from '../handler/cmsisAction';
import { folderOfInstall } from '../handler/installPack';
import { activeTargetAnswer, apiToolsEnvironment, askSolution, cachedApiToolsEnvironment, resetApiToolsEnvironment, solutionGetter, SolutionCommands } from '../utils/solutionQueries';

const CLOCK: Clock = {
    now: () => Date.now(),
    startTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
    },
};
const soon = (ms = 2_000): number => Date.now() + ms;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** The four methods of version 2; the catalog is not what these tests ask. */
function v2(): SolutionApi {
    return {
        getBoards: () => Promise.resolve([]),
        getDevices: () => Promise.resolve([]),
        getDraftProjects: () => Promise.resolve([]),
        createNewSolution: () => Promise.resolve(),
    };
}

const ENVIRONMENT_YAML = [
    'cmsis-tools-environment:',
    '  version: 1.1.0',
    '  environment:',
    '    path:',
    '      - /Users/me/.vcpkg/artifacts/compilers.arm.armclang/6.24.0/bin',
    '      - /Users/me/.vscode/extensions/arm.cmsis-csolution/tools/cmsis-toolbox/bin',
    '    variables:',
    '      AC6_TOOLCHAIN_6_24_0: /Users/me/.vcpkg/artifacts/compilers.arm.armclang/6.24.0/bin',
    '      GITHUB_TOKEN: ghp_0123456789abcdefghijABCDEFGHIJ0123456789',
    '      ARTIFACTORY_PASSWORD: hunter2',
    '      MY_API_KEY: x',
    '  tools:',
    '    - name: CMSIS-Toolbox',
    '      version: 2.14.1',
    '      directory: /Users/me/.vscode/extensions/arm.cmsis-csolution/tools/cmsis-toolbox/bin',
].join('\n');

/** A version 3 as the nightly answers, with every call recorded. */
function v3(overrides: Partial<SolutionApi> = {}): SolutionApi & { calls: string[]; packQueries: ApiPackQuery[] } {
    const calls: string[] = [];
    const packQueries: ApiPackQuery[] = [];
    const api = {
        ...v2(),
        calls,
        packQueries,
        getTargets: async () => { calls.push('getTargets'); return ['HP@debug', 'HP@release', 'HE']; },
        getActiveTarget: async () => { calls.push('getActiveTarget'); return 'HP@debug'; },
        getCbuildRunFile: async () => { calls.push('getCbuildRunFile'); return '/w/out/Blinky+HP.cbuild-run.yml'; },
        getToolchains: async () => [
            { name: 'AC6', version: '6.24.0', path: '/Users/me/.vcpkg/artifacts/compilers.arm.armclang/6.24.0/bin', registrationVariable: 'AC6_TOOLCHAIN_6_24_0' },
            { name: 'GCC', version: '14.3.1', path: '/opt/gcc/bin', registrationVariable: 'GCC_TOOLCHAIN_14_3_1' },
        ],
        getDebuggers: async () => ['CMSIS-DAP@pyOCD', 'J-Link Server', 'Arm-FVP'],
        getToolsEnvironment: async () => ENVIRONMENT_YAML,
        getPacks: async (options?: ApiPackQuery) => {
            packQueries.push(options ?? {});
            if ((options?.scope === 'missing' || options?.scope === 'used') && options.context !== 'Blinky.Debug+HP') {
                throw new Error(`Unknown context: ${options.context}`);
            }
            if (options?.scope === 'missing') {
                return {
                    packs: [
                        { pack: 'ARM::CMSIS-RTX@5.9.0', origin: 'Blinky.cproject.yml' },
                        { pack: 'Keil::STM32U5xx_DFP@>=3.0.0', origin: 'Blinky.csolution.yml' },
                        { pack: 'AlifSemiconductor::Ensemble', origin: 'Blinky.csolution.yml', resolvedPack: 'AlifSemiconductor::Ensemble@2.0.4' },
                    ],
                };
            }
            const all = [
                { id: 'ARM::CMSIS@6.2.0', version: '6.2.0', installed: true, path: '/packs/ARM/CMSIS/6.2.0', description: 'CMSIS (Common Microcontroller Software Interface Standard)' },
                { id: 'ARM::CMSIS-RTX@5.9.0', version: '5.9.0', description: 'CMSIS-RTOS2 RTX5' },
                { id: 'Keil::STM32U5xx_DFP@3.1.0', version: '3.1.0', installed: false, description: 'STMicroelectronics STM32U5 Series Device Support' },
            ];
            const text = options?.filter?.text?.toLowerCase();
            return { packs: text ? all.filter((pack) => pack.id.toLowerCase().includes(text) || pack.description.toLowerCase().includes(text)) : all };
        },
        installPacks: async (options: { packs: string[]; approved: boolean }) => options.packs.map((pack) => ({ pack, status: 'installed', path: `/packs/${pack}` })),
        ...overrides,
    };
    return api as SolutionApi & { calls: string[]; packQueries: ApiPackQuery[] };
}

/** An installed CMSIS Solution extension whose getApi answers the versions in `apis`. */
function installed(apis: Record<number, unknown>, options: { active?: boolean } = {}): SolutionExtensionHandle & { asked: number[]; activations: number } {
    const handle = {
        isActive: options.active ?? true,
        version: '1.72.1-86',
        asked: [] as number[],
        activations: 0,
        exports: {
            getApi: (version: number): unknown => {
                handle.asked.push(version);
                if (!(version in apis)) {
                    throw new Error(`No API version ${version} found`);
                }
                return apis[version];
            },
        },
        activate: async (): Promise<unknown> => {
            handle.activations++;
            handle.isActive = true;
            return handle.exports;
        },
    };
    return handle;
}

async function refusalOf(pending: Promise<unknown>, code: ErrorCode): Promise<ToolError> {
    try {
        await pending;
    } catch (caught) {
        assert.ok(caught instanceof ToolError, `expected a ToolError, got ${String(caught)}`);
        assert.strictEqual(caught.code, code, errorDetail(caught));
        return caught;
    }
    assert.fail('expected the call to reject');
}

function ask(api: SolutionApi, query: SolutionQuery, deadline = soon(), redact?: Parameters<typeof querySolution>[4]): Promise<ToolReply> {
    return querySolution(api, query, CLOCK, deadline, redact);
}

suite('CMSIS Solution API version 3 (2.9.1)', () => {
    suite('the seam', () => {
        test('version 3 is asked first and kept; its methods are found by name', async () => {
            const api = v3();
            const handle = installed({ 3: api, 2: v2() });
            const got = await acquireSolutionApi(handle, 'cmsis_query', CLOCK);
            assert.strictEqual(got, api);
            assert.strictEqual(await acquireSolutionApi(handle, 'cmsis_query', CLOCK), api);
            assert.deepStrictEqual(handle.asked, [3]);
            assert.strictEqual(solutionApiVersion(got), 3);
            assert.ok(v3Method(got, 'getToolchains'));
            assert.strictEqual(v3Method(got, 'convertSolution'), undefined, 'a method the scripted version 3 lacks is undefined');
        });

        test('1.72.0 has only version 2: asked after 3, and every version 3 method is absent', async () => {
            const api = v2();
            const handle = installed({ 2: api });
            const got = await acquireSolutionApi(handle, 'cmsis_query', CLOCK);
            assert.strictEqual(got, api);
            assert.deepStrictEqual(handle.asked, [3, 2]);
            assert.strictEqual(solutionApiVersion(got), 2);
            assert.strictEqual(v3Method(got, 'getPacks'), undefined);
            const refused = await refusalOf(Promise.resolve().then(() => requireV3Method(got, 'getPacks', 'cmsis_query {what:\'packs\'}')), 'TOOL_DISABLED');
            assert.strictEqual(refused.message, 'cmsis_query {what:\'packs\'} not attempted: the CMSIS Solution extension offers no getPacks (API version 2).');
            assert.match(refused.hint ?? '', /API version 3, which comes with a release after 1\.72\.0/);
        });

        test('a version 3 without the methods of version 2 is not taken: version 2 is', async () => {
            const partial = { getToolchains: async () => [] };
            const api = v2();
            const handle = installed({ 3: partial, 2: api });
            assert.strictEqual(await acquireSolutionApi(handle, 'cmsis_query', CLOCK), api);
            assert.deepStrictEqual(handle.asked, [3, 2]);
        });

        test('peek neither activates nor throws, and shares the memo', async () => {
            const api = v3();
            const inactive = installed({ 3: api }, { active: false });
            assert.strictEqual(peekSolutionApi(inactive), undefined);
            assert.strictEqual(inactive.activations, 0);
            assert.deepStrictEqual(inactive.asked, []);
            assert.strictEqual(peekSolutionApi(undefined), undefined);
            assert.strictEqual(peekSolutionApi({ isActive: true, exports: {}, activate: async () => ({}) }), undefined);
            assert.strictEqual(peekSolutionApi(installed({})), undefined, 'neither version: undefined, not a refusal');
            const active = installed({ 3: api });
            assert.strictEqual(peekSolutionApi(active), api);
            assert.strictEqual(await acquireSolutionApi(active, 'x', CLOCK), api);
            assert.deepStrictEqual(active.asked, [3]);
        });
    });

    suite('the getters through the API', () => {
        function commands(api: SolutionApi | undefined, answers: Record<string, unknown> = {}): SolutionCommands & { executed: string[] } {
            const executed: string[] = [];
            return {
                executed,
                extensionActive: () => true,
                commands: async () => Object.keys(answers),
                execute: async (command) => { executed.push(command); return answers[command]; },
                api: () => api,
                timeoutMs: 200,
            };
        }

        test('askSolution takes the getter of version 3 and runs no command', async () => {
            const api = v3();
            const source = commands(api, { 'cmsis-csolution.getCbuildRunFile': '/w/from-command.cbuild-run.yml' });
            assert.strictEqual(await askSolution('cmsis-csolution.getCbuildRunFile', source), '/w/out/Blinky+HP.cbuild-run.yml');
            assert.strictEqual(await askSolution('cmsis-csolution.getActiveTargetSet', source), 'HP@debug');
            assert.deepStrictEqual(source.executed, []);
            assert.deepStrictEqual(api.calls, ['getCbuildRunFile', 'getActiveTarget']);
        });

        test('without version 3 the hidden command answers, as with 1.72.0', async () => {
            const source = commands(v2(), { 'cmsis-csolution.getCbuildRunFile': '/w/from-command.cbuild-run.yml' });
            assert.strictEqual(await askSolution('cmsis-csolution.getCbuildRunFile', source), '/w/from-command.cbuild-run.yml');
            assert.strictEqual(await solutionGetter('cmsis-csolution.getSolutionFile', source), undefined);
            assert.deepStrictEqual(source.executed, ['cmsis-csolution.getCbuildRunFile', 'cmsis-csolution.getSolutionFile']);
        });

        test('the active target set and the declared ones (#141): version 3 lists them, 1.72.0 names the active one only', async () => {
            const api = v3();
            assert.deepStrictEqual(await activeTargetAnswer(commands(api)), { active: 'HP@debug', declared: ['HP@debug', 'HP@release', 'HE'] });
            assert.deepStrictEqual(api.calls, ['getActiveTarget', 'getTargets']);
            assert.deepStrictEqual(await activeTargetAnswer(commands(v2(), { 'cmsis-csolution.getActiveTargetSet': 'MPS3' })), { active: 'MPS3' });
            assert.deepStrictEqual(await activeTargetAnswer(commands(v2(), { 'cmsis-csolution.getActiveTargetSet': '' })), {}, 'answered, and none is selected');
            assert.strictEqual(await activeTargetAnswer(commands(v2())), undefined, 'no answer at all');
            const slow = v3({ getTargets: () => never<string[]>() });
            assert.deepStrictEqual(await activeTargetAnswer(commands(slow)), { active: 'HP@debug' }, 'a list that does not come leaves the active one');
        });

        test('a getter of version 3 that does not answer in time is no answer', async () => {
            const api = v3({ getCbuildRunFile: () => never<string>() });
            assert.strictEqual(await askSolution('cmsis-csolution.getCbuildRunFile', commands(api)), undefined);
        });
    });

    suite('the tools environment for a solution without the file (phase 4.3)', () => {
        function source(api: SolutionApi | undefined, active = true): SolutionCommands {
            return { extensionActive: () => active, commands: async () => [], execute: async () => undefined, api: () => api };
        }
        teardown(() => resetApiToolsEnvironment());

        test('the API\'s text, cached for the synchronous readers; one ask at a time; dropped by the reset after an activation', async () => {
            let asks = 0;
            let text = ENVIRONMENT_YAML;
            const api = v3({ getToolsEnvironment: async () => { asks++; return text; } });
            assert.strictEqual(cachedApiToolsEnvironment(source(api)), undefined, 'nothing until an ask answered');
            const [a, b] = await Promise.all([apiToolsEnvironment(source(api)), apiToolsEnvironment(source(api))]);
            assert.deepStrictEqual([a, b, asks], [ENVIRONMENT_YAML, ENVIRONMENT_YAML, 1], 'the sync read started the ask; the two calls joined it');
            assert.strictEqual(cachedApiToolsEnvironment(source(api)), ENVIRONMENT_YAML);
            resetApiToolsEnvironment();
            text = 'cmsis-tools-environment: {}';
            assert.strictEqual(await apiToolsEnvironment(source(api)), text);
        });

        test('no answer: without version 3, an inactive extension, an empty text, a rejection, or none within the fence', async () => {
            assert.strictEqual(await apiToolsEnvironment(source(v2())), undefined);
            assert.strictEqual(await apiToolsEnvironment(source(v3(), false)), undefined);
            let asks = 0;
            assert.strictEqual(await apiToolsEnvironment(source(v3({ getToolsEnvironment: async () => { asks++; return '  '; } }))), undefined);
            assert.strictEqual(await apiToolsEnvironment(source(v3({ getToolsEnvironment: async () => { asks++; throw new Error('Arm Tools failed'); } }))), undefined);
            const started = Date.now();
            assert.strictEqual(await apiToolsEnvironment(source(v3({ getToolsEnvironment: () => { asks++; return never<string>(); } })), 100), undefined);
            const waited = Date.now() - started;
            assert.ok(waited >= 90 && waited < 1_000, `the fence holds (${waited} ms)`);
            assert.strictEqual(asks, 3, 'each getter was asked: no earlier answer stood in for it');
        });

        test('an ask that ends before it waits does not stay as the answer: the next call asks again', async () => {
            const early: Array<[string, () => SolutionCommands]> = [
                ['an inactive extension', () => source(v3(), false)],
                ['no version 3', () => source(v2())],
                ['no API at all', () => source(undefined)],
                ['an extension that cannot be asked', () => ({ ...source(v3()), extensionActive: () => { throw new Error('host gone'); } })],
                ['an API that throws', () => ({ ...source(v3()), api: () => { throw new Error('no exports'); } })],
            ];
            for (const [label, make] of early) {
                let asks = 0;
                const api = v3({ getToolsEnvironment: async () => { asks++; return ENVIRONMENT_YAML; } });
                assert.strictEqual(await apiToolsEnvironment(make()), undefined, label);
                assert.strictEqual(await apiToolsEnvironment(source(api)), ENVIRONMENT_YAML, `${label}, then CMSIS Solution answers`);
                assert.strictEqual(asks, 1, label);
                resetApiToolsEnvironment();
            }
            let asks = 0;
            const api = v3({ getToolsEnvironment: async () => { asks++; return ENVIRONMENT_YAML; } });
            assert.strictEqual(cachedApiToolsEnvironment(source(api, false)), undefined, 'a synchronous read while the extension is inactive');
            // A call in the same tick joins the ask the read started; the next one asks.
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.strictEqual(await apiToolsEnvironment(source(api)), ENVIRONMENT_YAML);
            assert.strictEqual(asks, 1);
        });
    });

    suite('cmsis_query packs, toolchains, debuggers, environment', () => {
        test('packs: all by default, name as the API\'s text filter, limit with the rest counted', async () => {
            const api = v3();
            const reply = await ask(api, { what: 'packs', name: 'cmsis', limit: 1 });
            assert.deepStrictEqual(api.packQueries, [{ scope: 'all', filter: { text: 'cmsis' } }]);
            assert.strictEqual(reply.status, 'ok');
            assert.strictEqual(reply.text, [
                'Packs (all, name \'cmsis\'): 2, the first 1 listed.',
                '- ARM::CMSIS@6.2.0 — installed — CMSIS (Common Microcontroller Software Interface Standard)',
                '1 more not listed: narrow name, or raise limit (at most 100).',
            ].join('\n'));
            assert.deepStrictEqual(reply.data?.entries, [{ id: 'ARM::CMSIS@6.2.0', installed: true, path: '/packs/ARM/CMSIS/6.2.0',
                description: 'CMSIS (Common Microcontroller Software Interface Standard)' }]);
        });

        test('packs missing: needs a context; each requirement with its origin and the install call, or how to find a version', async () => {
            const api = v3();
            const refused = await refusalOf(ask(api, { what: 'packs', scope: 'missing' }), 'INVALID_ARGUMENT');
            assert.match(refused.message, /the scope missing needs a context of the loaded solution/);
            assert.deepStrictEqual(api.packQueries, [], 'refused before the API is asked');
            const reply = await ask(api, { what: 'packs', scope: 'missing', context: 'Blinky.Debug+HP' });
            assert.deepStrictEqual(api.packQueries, [{ scope: 'missing', context: 'Blinky.Debug+HP' }]);
            assert.strictEqual(reply.text, [
                'Packs (missing, context Blinky.Debug+HP): 3.',
                '- ARM::CMSIS-RTX@5.9.0 (required by Blinky.cproject.yml) → cmsis_action {action:\'install_pack\', pack:\'ARM::CMSIS-RTX@5.9.0\'}',
                '- Keil::STM32U5xx_DFP@>=3.0.0 (required by Blinky.csolution.yml) → no exact version: cmsis_query {what:\'packs\', name:\'STM32U5xx_DFP\'} lists the versions there are',
                '- AlifSemiconductor::Ensemble (required by Blinky.csolution.yml) → cmsis_action {action:\'install_pack\', pack:\'AlifSemiconductor::Ensemble@2.0.4\'}',
                'Install each with cmsis_action {action:\'install_pack\', pack:\'Vendor::Name@version\'}, then build again.',
            ].join('\n'));
        });

        test('packs: an unknown context is INVALID_ARGUMENT with the form a context has', async () => {
            const refused = await refusalOf(ask(v3(), { what: 'packs', scope: 'used', context: 'Nope' }), 'INVALID_ARGUMENT');
            assert.match(refused.message, /getPacks rejected \(Unknown context: Nope\)/);
            assert.match(refused.hint ?? '', /<project>\.<build-type>\+<target-type>/);
        });

        test('toolchains and debuggers: as registered, and the adapters labelled as a catalog', async () => {
            const toolchains = await ask(v3(), { what: 'toolchains' });
            assert.strictEqual(toolchains.text, [
                'Toolchains registered in this window\'s environment: 2.',
                '- AC6 6.24.0 — /Users/me/.vcpkg/artifacts/compilers.arm.armclang/6.24.0/bin (AC6_TOOLCHAIN_6_24_0)',
                '- GCC 14.3.1 — /opt/gcc/bin (GCC_TOOLCHAIN_14_3_1)',
            ].join('\n'));
            const none = await ask(v3({ getToolchains: async () => [] }), { what: 'toolchains' });
            assert.match(none.text, /^Toolchains registered in this window's environment: none\. /);
            const debuggers = await ask(v3(), { what: 'debuggers' });
            assert.match(debuggers.text, /^Debug adapters CMSIS Solution knows \(its catalog, not the probes connected .*\): CMSIS-DAP@pyOCD, J-Link Server, Arm-FVP\./);
            assert.deepStrictEqual(debuggers.data?.entries, ['CMSIS-DAP@pyOCD', 'J-Link Server', 'Arm-FVP']);
        });

        test('environment: PATH, variables and tools; a secret-looking value is withheld by the redaction, never shown', async () => {
            const redact = (name: string, value: string): { value: string; redacted: boolean } =>
                (/TOKEN/.test(name) ? { value: '<redacted: possible secret>', redacted: true } : { value, redacted: false });
            const reply = await ask(v3(), { what: 'environment' }, soon(), redact);
            assert.ok(!reply.text.includes('ghp_'), reply.text);
            assert.ok(!JSON.stringify(reply.data).includes('ghp_'));
            assert.match(reply.text, /PATH entries \(2, in order\):\n {2}\/Users\/me\/\.vcpkg/);
            assert.match(reply.text, /AC6_TOOLCHAIN_6_24_0=\/Users\/me/);
            assert.match(reply.text, /GITHUB_TOKEN=<redacted: possible secret>/);
            assert.match(reply.text, /CMSIS-Toolbox 2\.14\.1 — /);
            assert.ok(!reply.text.includes('hunter2'), 'a prefixed credential name is withheld too');
            assert.match(reply.text, /MY_API_KEY=<redacted: possible secret>/);
            assert.match(reply.text, /3 variable values withheld as possible secrets/);
            assert.strictEqual(reply.data?.withheld, 3);
        });

        test('a getter waiting for Arm Tools answers running; a version 2 is TOOL_DISABLED for each kind', async () => {
            const waiting = await ask(v3({ getToolchains: () => never() }), { what: 'toolchains' }, soon(50));
            assert.strictEqual(waiting.status, 'running');
            assert.strictEqual(waiting.text, 'cmsis_query {what:\'toolchains\'}: CMSIS Solution waits for Arm Tools to activate the environment (getToolchains); repeat the same call.');
            for (const what of ['packs', 'toolchains', 'debuggers', 'environment'] as const) {
                await refusalOf(ask(v2(), { what }), 'TOOL_DISABLED');
            }
        });

        test('a rejection is TASK_FAILED naming the method', async () => {
            const refused = await refusalOf(ask(v3({ getDebuggers: async () => { throw new Error('Unable to load debugger adapters'); } }), { what: 'debuggers' }), 'TASK_FAILED');
            assert.strictEqual(refused.message, 'cmsis_query {what:\'debuggers\'} failed: CMSIS Solution\'s getDebuggers rejected (Unable to load debugger adapters).');
        });
    });

    suite('cmsis_action convert', () => {
        test('success with warnings, the detection hint; a failure is TASK_FAILED with the errors first', () => {
            const ok = convertResult('CMSIS \'convert\' on HP@debug', { success: true, severity: 'warning', detection: true,
                logMessages: { warnings: ['pack ARM::CMSIS@6.1.0 is deprecated'] } }, 1_200);
            assert.ok(typeof ok !== 'string');
            assert.match(ok.text, /^✅ CMSIS 'convert' on HP@debug: csolution convert succeeded after .* \(0 error\(s\), 1 warning\(s\), without the RTE update\)\. A compiler or a layer has to be chosen first/);
            assert.match(ok.text, / {2}warning: pack ARM::CMSIS@6\.1\.0 is deprecated\nNext: cmsis_action build\.$/);
            assert.deepStrictEqual(ok.data, { action: 'convert', success: true, severity: 'warning', detection: true, errors: 0, warnings: 1 });
            assert.throws(() => convertResult('CMSIS \'convert\'', { success: false, severity: 'error', detection: false,
                logMessages: { errors: ['required pack: ARM::CMSIS-RTX@5.9.0 not installed'], warnings: ['w'] } }, 900), (caught: unknown) => {
                assert.ok(caught instanceof ToolError && caught.code === 'TASK_FAILED');
                assert.match(caught.message, /^❌ CMSIS 'convert': csolution convert failed \(severity error, 1 error\(s\), 1 warning\(s\)\) after .*:\n {2}error: required pack: ARM::CMSIS-RTX@5\.9\.0 not installed\n {2}warning: w$/);
                assert.match(caught.hint ?? '', /scope:'missing'/);
                return true;
            });
        });
    });

    suite('install_pack through installPacks', () => {
        test('installed answers the folder, or nothing to check where the pack root puts it; failed and cancelled reject with the reason', () => {
            assert.strictEqual(folderOfInstall([{ pack: 'ARM::CMSIS@6.2.0', status: 'installed', path: '/packs/ARM/CMSIS/6.2.0' }]), '/packs/ARM/CMSIS/6.2.0');
            assert.strictEqual(folderOfInstall([{ pack: 'ARM::CMSIS@6.2.0', status: 'installed' }]), undefined);
            assert.throws(() => folderOfInstall([{ pack: 'ARM::CMSIS@9.9.9', status: 'failed', error: 'pack not found in index' }]),
                /^Error: failed: pack not found in index$/);
            assert.throws(() => folderOfInstall([{ pack: 'ARM::CMSIS@6.2.0', status: 'cancelled' }]), /^Error: cancelled: no reason given$/);
            assert.throws(() => folderOfInstall([]), /installPacks answered no result/);
        });
    });
});
