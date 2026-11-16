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
 * The kinds of `cmsis_query` that only API version 3 of CMSIS Solution
 * answers (#17, #41): `packs` (all, installed, or those a context uses or
 * misses), `toolchains` (registered in the window's environment),
 * `debuggers` (the catalog of debug adapters, not the connected probes) and
 * `environment` (the tools environment of the window: PATH entries,
 * variables, tools). None needs a converted solution except the `used` and
 * `missing` scopes, which need a context of the loaded one.
 *
 * Each API call gets what is left of the query's deadline; one that does not
 * answer by then is a `running` reply, since the toolchain and environment
 * getters wait for Arm Tools to activate. A host whose API lacks the method
 * is refused with `TOOL_DISABLED` and the update hint. Environment variable
 * values pass through the caller's redaction (`redactSecrets`), and the YAML
 * itself is never logged or returned.
 *
 * Pure: no `vscode`; the API, the clock and the redaction come from the
 * caller.
 */

import { readToolsEnvironment } from './buildFailure';
import {
    ApiPackData,
    ApiPackScope,
    Clock,
    requireV3Method,
    settleWithin,
    SolutionApi,
    textField,
} from './solutionApi';
import { clipValue } from './textBudget';
import { JsonObject, ToolError, ToolReply } from './toolResult';

/** The kinds this module answers. */
export const SOLUTION_KINDS = ['packs', 'toolchains', 'debuggers', 'environment'] as const;
export type SolutionKind = typeof SOLUTION_KINDS[number];
/** The scopes of `packs`. */
export const PACK_SCOPES: readonly ApiPackScope[] = ['all', 'installed', 'used', 'missing'];

/** The arguments of `cmsis_query` these kinds read. */
export interface SolutionQuery {
    what: SolutionKind;
    /** packs: a literal text the id or description contains (case-insensitive). */
    name?: string;
    /** packs: all (default), installed, used, missing. */
    scope?: ApiPackScope;
    /** packs used and missing: a context of the loaded solution, `<project>.<build-type>+<target-type>`. */
    context?: string;
    /** packs: entries listed at most; default 20, at most 100. */
    limit?: number;
}

/** The redaction of one environment variable's value: its name and value in, what may be shown out. */
export type Redact = (name: string, value: string) => { value: string; redacted: boolean };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DESCRIPTION_CHARS = 80;
const CONTEXT_HINT = 'Pass context as <project>.<build-type>+<target-type> of the active target set, as the contexts of '
    + 'the solution\'s *.cbuild-idx.yml are named (e.g. Blinky.Debug+B-U585I-IOT02A).';

/** An environment variable whose name says it holds a credential: a part of it, between underscores, is one. */
const SECRET_ENV_NAME = /(^|_)(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)(_|$)/i;
/** What a withheld value reads as; the same words as the variable views. */
const WITHHELD = '<redacted: possible secret>';

/** A call that did not answer by the deadline. */
class StillWaiting extends Error {
    constructor(readonly method: string) {
        super(`${method} did not answer in time`);
    }
}

function isSolutionKind(what: string): what is SolutionKind {
    return (SOLUTION_KINDS as readonly string[]).includes(what);
}

/** Whether `cmsis_query` routes `what` here. */
export function answersSolutionKind(what: string): boolean {
    return isSolutionKind(what);
}

function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/** `call()` within what is left of `deadline`; a rejection is `TASK_FAILED` naming the method, no answer `StillWaiting`. */
async function within<T>(method: string, call: () => PromiseLike<T>, what: string, clock: Clock, deadline: number): Promise<T> {
    let answer: { value: T } | undefined;
    try {
        answer = await settleWithin(Promise.resolve().then(call), Math.max(0, deadline - clock.now()), clock);
    } catch (caught) {
        throw new ToolError('TASK_FAILED', `${what} failed: CMSIS Solution's ${method} rejected (${messageOf(caught)}).`,
            'get_recent_problems shows what the extension reported.');
    }
    if (answer === undefined) {
        throw new StillWaiting(method);
    }
    return answer.value;
}

function limitOf(limit: number | undefined): number {
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
}

/** `packs`: CMSIS Solution's pack lists; `missing` lines name the install call. */
async function listPacks(api: SolutionApi, query: SolutionQuery, clock: Clock, deadline: number): Promise<ToolReply> {
    const scope: ApiPackScope = query.scope ?? 'all';
    const what = `cmsis_query {what:'packs', scope:'${scope}'}`;
    if (!PACK_SCOPES.includes(scope)) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: scope must be one of ${PACK_SCOPES.join(', ')}.`);
    }
    const context = textField(query.context);
    if ((scope === 'used' || scope === 'missing') && context === undefined) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: the scope ${scope} needs a context of the loaded solution.`, CONTEXT_HINT);
    }
    const getPacks = requireV3Method(api, 'getPacks', what);
    const text = textField(query.name);
    const options = {
        scope,
        ...(context !== undefined && (scope === 'used' || scope === 'missing') ? { context } : {}),
        ...(text !== undefined ? { filter: { text } } : {}),
    };
    let answer: { packs?: unknown };
    try {
        answer = await within('getPacks', () => getPacks(options), what, clock, deadline);
    } catch (caught) {
        if (caught instanceof ToolError && context !== undefined && /context/i.test(caught.message)) {
            throw new ToolError('INVALID_ARGUMENT', caught.message, CONTEXT_HINT);
        }
        throw caught;
    }
    const packs = (Array.isArray(answer?.packs) ? answer.packs : []) as ApiPackData[];
    const shown = packs.slice(0, limitOf(query.limit));
    const lines: string[] = [];
    const entries: JsonObject[] = [];
    for (const pack of shown) {
        const { line, data } = scope === 'missing' ? missingPack(pack) : listedPack(pack);
        lines.push(line);
        entries.push(data);
    }
    const filter = [text !== undefined ? `name '${text}'` : undefined, context !== undefined && (scope === 'used' || scope === 'missing') ? `context ${context}` : undefined]
        .filter((part) => part !== undefined).join(', ');
    const count = packs.length === 0 ? 'none' : shown.length < packs.length ? `${packs.length}, the first ${shown.length} listed` : String(packs.length);
    const head = `Packs (${scope}${filter ? `, ${filter}` : ''}): ${count}.`;
    const notes: string[] = [];
    if (shown.length < packs.length) {
        notes.push(`${packs.length - shown.length} more not listed: narrow name, or raise limit (at most ${MAX_LIMIT}).`);
    }
    if (scope === 'missing' && packs.length > 0) {
        notes.push('Install each with cmsis_action {action:\'install_pack\', pack:\'Vendor::Name@version\'}, then build again.');
    }
    if (scope === 'missing' && packs.length === 0) {
        notes.push('Nothing to install for this context.');
    }
    return {
        text: [head, ...lines, ...notes].join('\n'),
        status: 'ok',
        data: { what: 'packs', scope, ...(context !== undefined ? { context } : {}), total: packs.length, listed: shown.length, entries },
    };
}

/** One pack of the `all`, `installed` and `used` scopes. */
function listedPack(pack: ApiPackData): { line: string; data: JsonObject } {
    const id = textField(pack.id) ?? textField(pack.pack) ?? '?';
    const state = pack.installed === true ? 'installed' : pack.installed === false ? 'not installed' : undefined;
    const description = textField(pack.description);
    const parts = [state, description !== undefined ? clipValue(description.replace(/\s+/g, ' '), DESCRIPTION_CHARS) : undefined]
        .filter((part) => part !== undefined);
    const data: JsonObject = { id };
    if (pack.installed !== undefined) {
        data.installed = pack.installed === true;
    }
    const folder = textField(pack.path);
    if (folder !== undefined) {
        data.path = folder;
    }
    if (description !== undefined) {
        data.description = clipValue(description, 400);
    }
    return { line: `- ${id}${parts.length > 0 ? ` — ${parts.join(' — ')}` : ''}`, data };
}

/** A pack is installable by `install_pack` when it names one exact version. */
function exactPack(text: string | undefined): string | undefined {
    return text !== undefined && /^[^:\s]+::[^@\s]+@\d[\w.+-]*$/.test(text) ? text : undefined;
}

/** One pack of the `missing` scope: the requirement, where it comes from, and the call that installs it. */
function missingPack(pack: ApiPackData): { line: string; data: JsonObject } {
    const required = textField(pack.pack) ?? textField(pack.id) ?? '?';
    const origin = textField(pack.origin);
    const resolved = exactPack(textField(pack.resolvedPack)) ?? exactPack(required);
    const action = resolved !== undefined
        ? `cmsis_action {action:'install_pack', pack:'${resolved}'}`
        : `no exact version: cmsis_query {what:'packs', name:'${required.replace(/@.*$/, '').replace(/^.*::/, '')}'} lists the versions there are`;
    const data: JsonObject = { pack: required };
    if (origin !== undefined) {
        data.origin = origin;
    }
    if (resolved !== undefined) {
        data.install = resolved;
    }
    return { line: `- ${required}${origin !== undefined ? ` (required by ${origin})` : ''} → ${action}`, data };
}

/** `toolchains`: the compilers registered in the window's environment. */
async function listToolchains(api: SolutionApi, clock: Clock, deadline: number): Promise<ToolReply> {
    const what = 'cmsis_query {what:\'toolchains\'}';
    const getToolchains = requireV3Method(api, 'getToolchains', what);
    const answer = await within('getToolchains', () => getToolchains(), what, clock, deadline);
    const toolchains = Array.isArray(answer) ? answer : [];
    const entries: JsonObject[] = [];
    const lines: string[] = [];
    for (const toolchain of toolchains) {
        const name = textField(toolchain?.name) ?? '?';
        const version = textField(toolchain?.version);
        const folder = textField(toolchain?.path);
        const variable = textField(toolchain?.registrationVariable);
        lines.push(`- ${name}${version ? ` ${version}` : ''}${folder ? ` — ${folder}` : ''}${variable ? ` (${variable})` : ''}`);
        entries.push({ name, ...(version ? { version } : {}), ...(folder ? { path: folder } : {}), ...(variable ? { registrationVariable: variable } : {}) });
    }
    const head = toolchains.length === 0
        ? 'Toolchains registered in this window\'s environment: none. Arm Tools (vcpkg) registers a compiler as <NAME>_TOOLCHAIN_<version>; '
            + 'ask the user to add one to the solution\'s vcpkg-configuration.json and to activate the environment.'
        : `Toolchains registered in this window's environment: ${toolchains.length}.`;
    return { text: [head, ...lines].join('\n'), status: 'ok', data: { what: 'toolchains', total: toolchains.length, entries } };
}

/** `debuggers`: the adapter names of CMSIS Solution's catalog. */
async function listDebuggers(api: SolutionApi, clock: Clock, deadline: number): Promise<ToolReply> {
    const what = 'cmsis_query {what:\'debuggers\'}';
    const getDebuggers = requireV3Method(api, 'getDebuggers', what);
    const answer = await within('getDebuggers', () => getDebuggers(), what, clock, deadline);
    const names = (Array.isArray(answer) ? answer : []).map((name) => textField(name)).filter((name): name is string => name !== undefined);
    const text = `Debug adapters CMSIS Solution knows (its catalog, not the probes connected or the one the solution configures): ${names.length === 0 ? 'none' : names.join(', ')}.`
        + (names.length > 0 ? '\nThe solution\'s debugger: is one of these names; the cbuild-run.yml of the active target says which one is used.' : '');
    return { text, status: 'ok', data: { what: 'debuggers', total: names.length, entries: names } };
}

/** `environment`: the window's tools environment, variable values redacted. */
async function showEnvironment(api: SolutionApi, clock: Clock, deadline: number, redact: Redact | undefined): Promise<ToolReply> {
    const what = 'cmsis_query {what:\'environment\'}';
    const getToolsEnvironment = requireV3Method(api, 'getToolsEnvironment', what);
    const yaml = await within('getToolsEnvironment', () => getToolsEnvironment(), what, clock, deadline);
    let environment: ReturnType<typeof readToolsEnvironment>;
    try {
        environment = readToolsEnvironment(typeof yaml === 'string' ? yaml : '');
    } catch (caught) {
        throw new ToolError('TASK_FAILED', `${what} failed: CMSIS Solution's tools environment could not be read (${messageOf(caught)}).`);
    }
    let withheld = 0;
    const variables: JsonObject = {};
    // Environment names carry prefixes (ARTIFACTORY_PASSWORD, MY_API_KEY) that a whole-name rule misses.
    const judge: Redact | undefined = redact === undefined ? undefined
        : (name, value) => (SECRET_ENV_NAME.test(name) && value.length > 0 ? { value: WITHHELD, redacted: true } : redact(name, value));
    const variableLines: string[] = [];
    for (const [name, raw] of Object.entries(environment.variables).sort(([a], [b]) => a.localeCompare(b))) {
        const shown = judge ? judge(name, raw) : { value: raw, redacted: false };
        if (shown.redacted) {
            withheld++;
        }
        variables[name] = shown.value;
        variableLines.push(`  ${name}=${shown.value}`);
    }
    const tools = environment.tools.map((tool) => ({ name: tool.name, ...(tool.version ? { version: tool.version } : {}), ...(tool.directory ? { directory: tool.directory } : {}) }));
    const lines = [
        'Tools environment of this window (what CMSIS Solution puts in front of PATH for its tasks; no solution needed):',
        `PATH entries (${environment.path.length}, in order):`,
        ...environment.path.map((entry) => `  ${entry}`),
        `Variables (${variableLines.length}):`,
        ...variableLines,
        `Tools (${tools.length}):`,
        ...tools.map((tool) => `  ${tool.name}${tool.version ? ` ${tool.version}` : ''}${tool.directory ? ` — ${tool.directory}` : ''}`),
    ];
    if (withheld > 0) {
        lines.push(`${withheld} variable value${withheld === 1 ? '' : 's'} withheld as possible secrets (setting cmsis-developer-assistant.redactSecrets).`);
    }
    return {
        text: lines.join('\n'),
        status: 'ok',
        data: { what: 'environment', path: environment.path, variables, tools, ...(withheld > 0 ? { withheld } : {}) },
    };
}

/**
 * Answer `cmsis_query` for the kinds of API version 3. `deadline` is on
 * `clock`; a call still open then is answered as `running`, and the same
 * call again finds the answer. `redact` judges each environment variable.
 */
export async function querySolution(api: SolutionApi, query: SolutionQuery, clock: Clock, deadline: number, redact?: Redact): Promise<ToolReply> {
    try {
        switch (query.what) {
            case 'packs':
                return await listPacks(api, query, clock, deadline);
            case 'toolchains':
                return await listToolchains(api, clock, deadline);
            case 'debuggers':
                return await listDebuggers(api, clock, deadline);
            case 'environment':
                return await showEnvironment(api, clock, deadline, redact);
            default:
                throw new ToolError('INVALID_ARGUMENT', `cmsis_query not attempted: what must be one of ${SOLUTION_KINDS.join(', ')}.`);
        }
    } catch (caught) {
        if (caught instanceof StillWaiting) {
            const why = caught.method === 'getToolchains' || caught.method === 'getToolsEnvironment'
                ? 'CMSIS Solution waits for Arm Tools to activate the environment'
                : 'CMSIS Solution did not answer yet';
            return {
                text: `cmsis_query {what:'${query.what}'}: ${why} (${caught.method}); repeat the same call.`,
                status: 'running',
                data: { what: query.what, waiting: caught.method },
            };
        }
        throw caught;
    }
}
