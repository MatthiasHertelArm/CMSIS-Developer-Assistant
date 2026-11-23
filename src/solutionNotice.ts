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
 * The notice of a CMSIS Solution extension that is too old. The manifest
 * names CMSIS Solution as an extension dependency, which makes VS Code
 * install it and activate it before this extension, but a manifest cannot
 * ask for a version. So each window looks at activation whether the
 * extension offers API version 3 (`solutionApiTooOld`: the API is asked, no
 * version number is compared) and, when it does not, tells the user with a
 * warning that has two buttons: one opens the extension's page in the
 * Extensions view, where it is updated; the other silences the notice for
 * the installed version of CMSIS Solution, so that another version that is
 * still too old is reported again. An agent learns the same from
 * `get_session_status` and from each refusal.
 *
 * `tellWhenSolutionTooOld` takes what it needs of the window as a host, so
 * a test hands in stand-ins; `windowSolutionNoticeHost` is the real one.
 */

import * as vscode from 'vscode';
import { SOLUTION_EXTENSION_ID } from './core/bootstrapState';
import { solutionTooOldNotice } from './core/solutionApi';
import type { SolutionExtensionHandle } from './core/solutionApi';
import { installedSolutionExtension } from './handler/host';
import { logger } from './utils/logger';
import { notifyWarning } from './utils/notify';

const PRODUCT = 'CMSIS Developer Assistant';
/** The button that opens CMSIS Solution's page in the Extensions view. */
export const SHOW_SOLUTION_EXTENSION = 'Show CMSIS Solution';
/** The button that silences the notice for the installed version of CMSIS Solution. */
export const DO_NOT_SHOW_AGAIN = 'Don\'t Show Again';
/** globalState: the version of CMSIS Solution for which the user silenced the notice. */
export const SILENCED_VERSION_KEY = 'cmsis-developer-assistant.solutionTooOld.silencedVersion';
/** What stands for the version of an extension whose manifest names none. */
const UNKNOWN_VERSION = 'unknown';
/** VS Code's command that opens the page of an extension, by its id. */
const OPEN_EXTENSION_COMMAND = 'extension.open';

/** What the notice needs of the window. */
export interface SolutionNoticeHost {
    /** The CMSIS Solution extension of this VS Code; undefined when it is not installed. */
    solutionExtension(): SolutionExtensionHandle | undefined;
    /** Shows a warning with buttons; resolves with the one the user picked. */
    warn(message: string, ...buttons: string[]): Thenable<string | undefined>;
    /** Opens the page of an extension in the Extensions view. */
    showExtension(id: string): Thenable<unknown>;
    /** The version of CMSIS Solution for which the notice is silenced. */
    silencedVersion(): string | undefined;
    /** Silences the notice for that version. */
    silence(version: string): Thenable<void>;
}

/** The window's own host: VS Code's extensions, its notifications, and the extension's global state. */
export function windowSolutionNoticeHost(context: vscode.ExtensionContext): SolutionNoticeHost {
    return {
        solutionExtension: () => installedSolutionExtension(),
        warn: (message, ...buttons) => notifyWarning(message, ...buttons),
        showExtension: (id) => vscode.commands.executeCommand(OPEN_EXTENSION_COMMAND, id),
        silencedVersion: () => context.globalState.get<string>(SILENCED_VERSION_KEY),
        silence: (version) => context.globalState.update(SILENCED_VERSION_KEY, version),
    };
}

/**
 * Tell the user that the CMSIS Solution extension is too old, when it is
 * installed, active and offers no API version 3, and the notice is not
 * silenced for its version. Resolves with whether the notice was shown, once
 * the user has answered it; never rejects.
 */
export async function tellWhenSolutionTooOld(host: SolutionNoticeHost): Promise<boolean> {
    try {
        const extension = host.solutionExtension();
        const notice = solutionTooOldNotice(extension);
        if (notice === undefined) {
            return false;
        }
        const version = extension?.version ?? UNKNOWN_VERSION;
        if (host.silencedVersion() === version) {
            logger.info(`${PRODUCT}: ${notice} The notice is silenced for this version.`);
            return false;
        }
        logger.warn(`${PRODUCT}: ${notice}`);
        const picked = await host.warn(`${PRODUCT}: ${notice}`, SHOW_SOLUTION_EXTENSION, DO_NOT_SHOW_AGAIN);
        if (picked === SHOW_SOLUTION_EXTENSION) {
            await host.showExtension(SOLUTION_EXTENSION_ID);
        } else if (picked === DO_NOT_SHOW_AGAIN) {
            await host.silence(version);
        }
        return true;
    } catch (caught) {
        logger.debug('The notice on the CMSIS Solution extension could not be shown or answered', caught);
        return false;
    }
}
