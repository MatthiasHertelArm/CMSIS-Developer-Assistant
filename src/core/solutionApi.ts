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
 * The public API of the CMSIS Solution extension, versions 2 and 3, as far
 * as this extension uses it. Version 2: the catalog of boards, devices and
 * draft projects (examples, reference applications, templates), and the
 * creation of a solution from a draft. Version 3 keeps those and adds the
 * getters of the loaded solution, the target switch, the conversion without
 * a build, the tools environment, toolchains, debug adapters, packs and
 * their installation. `exports.getApi(n)` of `Arm.cmsis-csolution` returns
 * them. The types are the part of `@arm-software/vscode-cmsis-csolution`
 * (`csolution-api-v2.d.ts`, `csolution-api-v3.d.ts`) that this extension
 * reads, checked against the bundle of CMSIS Solution 1.72.0 (version 2) and
 * its nightly 1.72.1-86 (version 3, "in development"); the package is not a
 * dependency.
 *
 * The catalog merges two sources: Arm's web catalog and the installed packs
 * (through `csolution rpc`). The API returns the merged list and keeps the
 * failures of a source to itself. Only a draft project says where it came
 * from (`draftSource`); `catalogErrorsOf` reads the failures from a field
 * that is not part of the API, when it is there.
 *
 * `acquireSolutionApi` is the seam: it activates the extension when it is
 * installed but inactive, asks for version 3 and falls back to version 2,
 * and turns every way of not getting either into a typed refusal. The four
 * methods of version 2 are required; every method of version 3 is optional
 * and detected by its name (`v3Method`), never by the version number, so a
 * partial or changed version 3 loses only what it lacks. `peekSolutionApi`
 * is the same object for the getters that must neither activate the
 * extension nor throw. The lookups find a board, a device or a
 * draft by the id the catalog listing shows.
 *
 * Pure: no `vscode`, no file access; the caller hands in the extension and a
 * clock.
 */

import { missingSolutionExtensionRefusal } from './bootstrapState';
import { ToolError } from './toolResult';
import { secondsText } from './windowHealth';

/** A pack, as `Vendor::Name@version`; `key` is lower case. */
export interface ApiPackId {
    readonly key: string;
    readonly vendor: string;
    readonly name: string;
    readonly version?: string;
}

/** A device: `key` is `Vendor::Name`. */
export interface ApiDeviceId {
    readonly key: string;
    readonly vendor: string;
    readonly name: string;
}

/** A board: `key` is `Vendor::Name` or `Vendor::Name:Revision`. */
export interface ApiBoardId {
    readonly key: string;
    readonly vendor: string;
    readonly name: string;
    readonly revision?: string;
}

/** A draft project: `key` is `<pack key>:<name in lower case>`, or the web catalog's id in lower case. */
export interface ApiDraftId {
    readonly key: string;
    readonly name: string;
}

/** A board. The first of `devices` is the device it is usually equipped with. */
export interface ApiBoard {
    readonly id: ApiBoardId;
    readonly vendor: string;
    readonly name: string;
    readonly revision?: string;
    readonly devices: PromiseLike<ApiDeviceId[]>;
    /** The board support pack. */
    readonly pack: PromiseLike<ApiPackId | undefined>;
}

/** One processor of a device. */
export interface ApiProcessor {
    readonly name: string;
    readonly core: string;
}

/** A device. */
export interface ApiDevice {
    readonly id: ApiDeviceId;
    readonly vendor: string;
    readonly name: string;
    readonly family: string;
    readonly subfamily?: string;
    /** The device family pack. */
    readonly pack: PromiseLike<ApiPackId | undefined>;
    readonly processors: PromiseLike<ApiProcessor[]>;
}

/** An example, reference application or template a solution can be created from. */
export interface ApiDraft {
    readonly id: ApiDraftId;
    readonly name: string;
    readonly description: string;
    /** `Csolution`, `uVision` (converted on creation) or `Other`. */
    readonly format: string;
    /** `Example`, `Reference Application` or `Template`. */
    readonly draftType: string;
    /** `Web` (downloaded from Arm's web catalog) or `Local` (an installed pack). */
    readonly draftSource: string;
    readonly pack?: ApiPackId;
}

/** `vendor` must match exactly, `name` is a regular expression; the API applies both. */
export interface ApiDeviceFilter {
    vendor?: string;
    name?: string;
}

/** As for devices, plus `revision` and a filter on the board's devices. */
export interface ApiBoardFilter extends ApiDeviceFilter {
    revision?: string;
    mountedDevice?: ApiDeviceFilter;
}

/** What `createNewSolution` takes: the draft, the board or device, the folder, and whether to run `git init`. */
export interface ApiCreateOptions {
    draft: ApiDraft;
    board?: ApiBoard;
    device?: ApiDevice;
    folder: string;
    git?: boolean;
}

/** The part of `CsolutionApiV2` this extension calls. */
export interface SolutionApiV2 {
    getBoards(filter?: ApiBoardFilter): PromiseLike<ApiBoard[]>;
    getDevices(filter?: ApiDeviceFilter): PromiseLike<ApiDevice[]>;
    getDraftProjects(board?: ApiBoardId, device?: ApiDeviceId): PromiseLike<ApiDraft[]>;
    createNewSolution(options: ApiCreateOptions): PromiseLike<void>;
}

/** What `convertSolution` of API version 3 answers. */
export interface ApiConvertResult {
    success: boolean;
    severity: 'abort' | 'error' | 'warning' | 'info' | 'success' | string;
    /** A compiler or a layer has to be chosen first. */
    detection: boolean;
    logMessages?: { success?: boolean; errors?: string[]; warnings?: string[]; info?: string[] };
    toolsOutputMessages?: string[];
}

/** A toolchain registered in the window's environment (`*_TOOLCHAIN_x_y_z`). */
export interface ApiToolchain {
    name: string;
    version: string;
    path: string;
    registrationVariable: string;
}

/** The scopes of `getPacks`; `used` and `missing` need a context of the loaded solution. */
export type ApiPackScope = 'all' | 'installed' | 'used' | 'missing';

/** What `getPacks` takes. */
export interface ApiPackQuery {
    scope?: ApiPackScope;
    context?: string;
    filter?: { text?: string };
}

/** One pack of a `getPacks` answer; a missing one has `pack` and `origin` instead of `id`. */
export interface ApiPackData {
    id?: string;
    version?: string;
    installed?: boolean;
    path?: string;
    description?: string;
    pack?: string;
    origin?: string;
    resolvedPack?: string;
}

/** One pack of an `installPacks` answer. */
export interface ApiPackInstallResult {
    pack: string;
    status: 'installed' | 'failed' | 'cancelled' | string;
    path?: string;
    error?: string;
}

/**
 * The methods API version 3 adds, each optional: a version 3 that lacks one
 * (or a version 2) is detected by `v3Method`, never by the version number.
 */
export interface SolutionApiV3Methods {
    convertSolution(options?: { updateRte?: boolean }): PromiseLike<ApiConvertResult>;
    activateSolution(solutionPath: string): PromiseLike<void>;
    deactivateSolution(): PromiseLike<void>;
    getSolutionFile(): PromiseLike<string | undefined>;
    getTargets(): PromiseLike<string[]>;
    getActiveTarget(): PromiseLike<string>;
    setActiveTarget(activeTarget: string): PromiseLike<void>;
    getDeviceName(): PromiseLike<string>;
    getBoardName(): PromiseLike<string>;
    getDfpName(): PromiseLike<string>;
    getBspName(): PromiseLike<string>;
    getDfpPath(): PromiseLike<string>;
    getBspPath(): PromiseLike<string>;
    getPackRootPath(): PromiseLike<string>;
    getCbuildRunFile(): PromiseLike<string>;
    getToolsEnvironment(): PromiseLike<string>;
    getDebuggers(): PromiseLike<string[]>;
    getToolchains(): PromiseLike<ApiToolchain[]>;
    getPacks(options?: ApiPackQuery): PromiseLike<{ packs: ApiPackData[] }>;
    installPacks(options: { packs: string[]; approved: boolean }): PromiseLike<ApiPackInstallResult[]>;
    /**
     * The result CMSIS Solution captured for a build task (#140): its exit code and terminal output, read by
     * `capturedResultOf`. `execution` is the task's `vscode.TaskExecution`; without one, the latest completed build
     * of the loaded solution and its active target set, or undefined.
     */
    getBuildResult(execution?: unknown): PromiseLike<unknown>;
}

/** The API object `acquireSolutionApi` returns: version 2's methods, and whichever of version 3's the extension offers. */
export type SolutionApi = SolutionApiV2 & Partial<SolutionApiV3Methods>;

/** The CMSIS Solution extension as `vscode.extensions.getExtension` describes it. */
export interface SolutionExtensionHandle {
    readonly isActive: boolean;
    readonly exports: unknown;
    readonly version?: string;
    /** Activates the extension; resolves with its exports. */
    activate(): PromiseLike<unknown>;
}

/** The handler's clock: what the waits of this module need. */
export interface Clock {
    now(): number;
    /** Calls `fire` once after `ms`; the returned function cancels it. */
    startTimer(ms: number, fire: () => void): () => void;
}

/** The API version this extension asks for first. */
export const SOLUTION_API_VERSION = 3;
/** The version it falls back to: the catalog and the creation, since CMSIS Solution 1.46.0. */
export const SOLUTION_API_FALLBACK = 2;
/** How long an inactive CMSIS Solution extension may take to activate. */
export const ACTIVATION_MS = 20_000;

const API_METHODS: readonly (keyof SolutionApiV2)[] = ['getBoards', 'getDevices', 'getDraftProjects', 'createNewSolution'];
const UPDATE_HINT = 'Ask the user to update the CMSIS Solution extension: its API version 2 came with release 1.46.0.';
/** The refusal hint for a method of version 3 the extension does not offer. */
export const V3_UPDATE_HINT = 'Ask the user to update the CMSIS Solution extension: this needs its API version 3, '
    + 'which comes with a release after 1.72.0 (today only its nightly build).';

/** What the CMSIS Solution data manager says when Arm's web catalog failed. */
const WEB_FAILURE = /web service could not be reached/i;

/** The API object of each exports object: `getApi` makes a new one per call and keeps it until the extension ends. */
const acquired = new WeakMap<object, SolutionApi>();
/** The version each acquired API object answered to. */
const versions = new WeakMap<object, number>();

/** A caught value's message. */
function messageOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

/**
 * `pending`'s value, or undefined when it has not settled within `ms`. A
 * rejection within the time passes on; a later one is dropped.
 */
export function settleWithin<T>(pending: PromiseLike<T>, ms: number, clock: Pick<Clock, 'startTimer'>): Promise<{ value: T } | undefined> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const cancel = clock.startTimer(Math.max(0, ms), () => {
            if (!settled) {
                settled = true;
                resolve(undefined);
            }
        });
        Promise.resolve(pending).then((value) => {
            if (!settled) {
                settled = true;
                cancel();
                resolve({ value });
            }
        }, (caught: unknown) => {
            if (!settled) {
                settled = true;
                cancel();
                reject(caught);
            }
        });
    });
}

/** ` 1.72.0` or nothing. */
function versionText(handle: SolutionExtensionHandle): string {
    return handle.version ? ` ${handle.version}` : '';
}

/**
 * CMSIS Solution's API, version 3 when it offers it, else 2. `what` names
 * the call in the refusals:
 * the extension not installed (`CMSIS_NO_SOLUTION`), an activation that
 * fails (`TASK_FAILED`) or takes longer than `activationMs` (`TIMEOUT`),
 * and an extension without `getApi`, without version 3 or 2, or with a
 * version 2 that lacks a method (`TOOL_DISABLED`).
 */
export async function acquireSolutionApi(
    handle: SolutionExtensionHandle | undefined,
    what: string,
    clock: Pick<Clock, 'startTimer'>,
    activationMs: number = ACTIVATION_MS,
): Promise<SolutionApi> {
    if (handle === undefined) {
        throw missingSolutionExtensionRefusal(what);
    }
    let exported: unknown = handle.exports;
    if (!handle.isActive) {
        let activated: { value: unknown } | undefined;
        try {
            activated = await settleWithin(handle.activate(), activationMs, clock);
        } catch (caught) {
            throw new ToolError('TASK_FAILED',
                `${what} not attempted: the CMSIS Solution extension${versionText(handle)} failed to activate (${messageOf(caught)}).`,
                'get_recent_problems shows what it reported; if it persists, ask the user to reload the window.');
        }
        if (activated === undefined) {
            throw new ToolError('TIMEOUT',
                `${what} not attempted: the CMSIS Solution extension did not finish activating within ${secondsText(activationMs)}.`,
                'It may still be starting: repeat the call in a few seconds.');
        }
        exported = activated.value ?? handle.exports;
    }
    const surface = exported as { getApi?: unknown } | null | undefined;
    if (typeof surface?.getApi !== 'function') {
        throw new ToolError('TOOL_DISABLED',
            `${what} not attempted: the CMSIS Solution extension${versionText(handle)} offers no public API (no getApi).`, UPDATE_HINT);
    }
    const known = acquired.get(surface);
    if (known !== undefined) {
        return known;
    }
    return acquireFrom(surface, what, handle);
}

/**
 * `getApi(3)`, else `getApi(2)`, from an exports object; memoised. Version 3
 * is taken only when it answers with the four methods of version 2 (it
 * extends version 2); otherwise, or when it throws, version 2 is asked.
 */
function acquireFrom(surface: { getApi?: unknown }, what: string, handle: SolutionExtensionHandle): SolutionApi {
    const getApi = surface.getApi as (version: number) => unknown;
    let api: unknown;
    let version = SOLUTION_API_VERSION;
    try {
        api = getApi.call(surface, SOLUTION_API_VERSION);
    } catch {
        api = undefined;
    }
    if (missingMethods(api).length > 0) {
        version = SOLUTION_API_FALLBACK;
        try {
            api = getApi.call(surface, SOLUTION_API_FALLBACK);
        } catch (caught) {
            throw new ToolError('TOOL_DISABLED',
                `${what} not attempted: the CMSIS Solution extension${versionText(handle)} offers no API version ${SOLUTION_API_FALLBACK} (${messageOf(caught)}).`,
                UPDATE_HINT);
        }
    }
    const missing = missingMethods(api);
    if (missing.length > 0) {
        throw new ToolError('TOOL_DISABLED',
            `${what} not attempted: API version ${SOLUTION_API_FALLBACK} of the CMSIS Solution extension${versionText(handle)} lacks ${missing.join(', ')}.`,
            UPDATE_HINT);
    }
    acquired.set(surface, api as SolutionApi);
    versions.set(api as object, version);
    return api as SolutionApi;
}

/** The methods of version 2 that `api` lacks. */
function missingMethods(api: unknown): string[] {
    const methods = (api ?? {}) as Record<string, unknown>;
    return API_METHODS.filter((method) => typeof methods[method] !== 'function');
}

/**
 * The API object of an active CMSIS Solution extension, for the getters that
 * must neither activate it nor throw: undefined when the extension is absent
 * or inactive, offers no `getApi`, or neither version. Shares the memo of
 * `acquireSolutionApi`.
 */
export function peekSolutionApi(handle: SolutionExtensionHandle | undefined): SolutionApi | undefined {
    try {
        if (handle === undefined || !handle.isActive) {
            return undefined;
        }
        const surface = handle.exports as { getApi?: unknown } | null | undefined;
        if (surface === null || surface === undefined || typeof surface.getApi !== 'function') {
            return undefined;
        }
        return acquired.get(surface) ?? acquireFrom(surface, 'peek', handle);
    } catch {
        return undefined;
    }
}

/** The version an acquired API object answered to: 3 or 2; undefined for an object this module did not acquire. */
export function solutionApiVersion(api: object | undefined): number | undefined {
    return api === undefined ? undefined : versions.get(api);
}

/**
 * A method of version 3, bound to its API object; undefined when the API
 * does not offer it (a version 2, or a version 3 without that method).
 */
export function v3Method<K extends keyof SolutionApiV3Methods>(api: SolutionApi | undefined, name: K): SolutionApiV3Methods[K] | undefined {
    const method = (api as Record<string, unknown> | undefined)?.[name];
    return typeof method === 'function' ? (method.bind(api) as SolutionApiV3Methods[K]) : undefined;
}

/**
 * A method of version 3, or the `TOOL_DISABLED` refusal that names it and
 * the update. `what` names the call in the refusal.
 */
export function requireV3Method<K extends keyof SolutionApiV3Methods>(api: SolutionApi, name: K, what: string): SolutionApiV3Methods[K] {
    const method = v3Method(api, name);
    if (method === undefined) {
        throw new ToolError('TOOL_DISABLED',
            `${what} not attempted: the CMSIS Solution extension offers no ${name} (API version ${solutionApiVersion(api) ?? SOLUTION_API_FALLBACK}).`,
            V3_UPDATE_HINT);
    }
    return method;
}

/** What CMSIS Solution's catalog reported for its last request, as far as it can be read. */
export interface CatalogErrors {
    /** Arm's web catalog could not be reached. */
    webUnreachable: boolean;
    /** Every failure the data manager kept, as it worded them. */
    messages: string[];
}

/**
 * The failures of the catalog's last request, read from the API object's
 * data manager (`dataManager.errors`), a field outside the published API.
 * Undefined when the field is not there or holds something else: then
 * nothing is known.
 */
export function catalogErrorsOf(api: unknown): CatalogErrors | undefined {
    let errors: unknown;
    try {
        errors = (api as { dataManager?: { errors?: unknown } } | undefined)?.dataManager?.errors;
    } catch {
        return undefined;
    }
    if (!Array.isArray(errors) || !errors.every((entry) => typeof entry === 'string')) {
        return undefined;
    }
    const messages = errors as string[];
    return { webUnreachable: messages.some((message) => WEB_FAILURE.test(message)), messages: [...messages] };
}

/** A string field of an object from another extension, trimmed; undefined when it is empty or not a string. */
export function textField(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** `Vendor::Name@version`, with the vendor and name as the pack spells them. */
export function packText(pack: ApiPackId | undefined): string | undefined {
    if (pack === undefined || pack === null) {
        return undefined;
    }
    const vendor = textField(pack.vendor);
    const name = textField(pack.name);
    if (vendor === undefined || name === undefined) {
        return textField(pack.key);
    }
    const version = textField(pack.version);
    return `${vendor}::${name}${version ? `@${version}` : ''}`;
}

/** `text` with every character a regular expression gives a meaning to escaped. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A case-insensitive test for a filter: the pattern as a regular
 * expression, or as plain text when it is not a valid one. Undefined when
 * there is no filter.
 */
export function matcherOf(pattern: string | undefined): ((value: string | undefined) => boolean) | undefined {
    const given = pattern?.trim();
    if (!given) {
        return undefined;
    }
    let expression: RegExp;
    try {
        expression = new RegExp(given, 'i');
    } catch {
        expression = new RegExp(escapeRegExp(given), 'i');
    }
    const spelled = folded(given);
    return (value) => value !== undefined && (expression.test(value) || folded(value).includes(spelled));
}

/**
 * A name as a user spells it, without case or separators: `micro:bit`,
 * `Micro Bit` and `microbit-v2` are one word. A pattern is compared this
 * way as well as a regular expression, so the user's spelling of a board
 * finds its id, and a pattern with regex syntax loses nothing (its folded
 * form matches no name, and the regular expression decides).
 */
function folded(text: string): string {
    return text.toLowerCase().replace(/[\s:_\-.]/g, '');
}

/** The id of a board, device or draft as the listing shows it. */
export function keyOf(entry: { id?: { key?: unknown } } | undefined): string {
    return textField(entry?.id?.key) ?? '?';
}

/** Two ids are the same when they differ only in case and surrounding blanks. */
function sameKey(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The keys of `entries`, at most `max`, with the count of the rest. */
function keyList(entries: readonly { id?: { key?: unknown } }[], max: number): string {
    const keys = entries.slice(0, max).map(keyOf);
    const more = entries.length > max ? ` and ${entries.length - max} more` : '';
    return `${keys.join(', ')}${more}`;
}

/** The part after `Vendor::`, which is what a bare name is compared with. */
function withoutVendor(key: string): string {
    const at = key.indexOf('::');
    return at >= 0 ? key.slice(at + 2) : key;
}

/** What a wanted id matched: one entry, several, or none (with the entries whose id contains its name). */
type KeyMatch<T> = { found: T } | { several: T[] } | { near: T[] };

/**
 * The entry `wanted` names: its id (`key`), else, for a wanted value without
 * `Vendor::`, the entries whose id without the vendor, or whose name, it is.
 * Case does not matter.
 */
function matchKey<T extends { id?: { key?: unknown }; name?: unknown }>(entries: readonly T[], wanted: string): KeyMatch<T> {
    const exact = entries.filter((entry) => sameKey(keyOf(entry), wanted));
    const loose = exact.length > 0 ? exact : entries.filter((entry) => sameKey(withoutVendor(keyOf(entry)), withoutVendor(wanted))
        || (typeof entry.name === 'string' && sameKey(entry.name, withoutVendor(wanted))));
    if (loose.length === 1) {
        return { found: loose[0] };
    }
    if (loose.length > 1) {
        return { several: loose };
    }
    const name = withoutVendor(wanted).toLowerCase();
    return { near: name.length >= 3 ? entries.filter((entry) => keyOf(entry).toLowerCase().includes(name)) : [] };
}

/**
 * The one entry `wanted` names (see `matchKey`); none and several are
 * `INVALID_ARGUMENT`, with the candidates, and `listing` as the hint.
 */
function findByKey<T extends { id?: { key?: unknown }; name?: unknown }>(
    entries: readonly T[],
    wanted: string,
    kind: string,
    what: string,
    listing: string,
): T {
    const match = matchKey(entries, wanted);
    if ('found' in match) {
        return match.found;
    }
    if ('several' in match) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: ${kind} '${wanted}' matches ${match.several.length}: ${keyList(match.several, 8)}.`,
            `Pass one of these ids. ${listing}`);
    }
    const near = match.near.length > 0 ? ` Ids that contain '${withoutVendor(wanted)}': ${keyList(match.near, 8)}.` : '';
    throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: no ${kind} '${wanted}' among the ${entries.length} CMSIS Solution knows.${near}`,
        listing);
}

/** The board `wanted` names among `boards`; see `matchKey`. */
export function findBoard(boards: readonly ApiBoard[], wanted: string, what: string): ApiBoard {
    return findByKey(boards, wanted, 'board', what, 'cmsis_query {what:\'boards\', name} lists boards with their ids.');
}

/** The device `wanted` names among `devices`; see `matchKey`. */
export function findDevice(devices: readonly ApiDevice[], wanted: string, what: string): ApiDevice {
    return findByKey(devices, wanted, 'device', what, 'cmsis_query {what:\'devices\', name} lists devices with their ids.');
}

/**
 * The draft `wanted` names among `drafts`, the examples and templates of
 * the board or device that `owner` names as arguments (`board:'…'`); see
 * `matchKey`. An id that is none of them is refused with the ids there are.
 */
export function findDraft(drafts: readonly ApiDraft[], wanted: string, ownerArgs: string, what: string): ApiDraft {
    const listing = `cmsis_query {what:'examples', ${ownerArgs}} lists them with their ids.`;
    const owner = ownerArgs.replace(/(\w+):'([^']*)'/g, '$1 $2');
    if (drafts.length === 0) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: CMSIS Solution knows no example or template for ${owner}.`, listing);
    }
    const match = matchKey(drafts, wanted);
    if ('found' in match) {
        return match.found;
    }
    if ('several' in match) {
        throw new ToolError('INVALID_ARGUMENT', `${what} not attempted: '${wanted}' names ${match.several.length} examples and templates for ${owner}: `
            + `${keyList(match.several, 8)}.`, `Pass one of these ids. ${listing}`);
    }
    throw new ToolError('INVALID_ARGUMENT',
        `${what} not attempted: '${wanted}' is none of the ${drafts.length} examples and templates for ${owner}: ${keyList(drafts, 8)}.`, listing);
}
