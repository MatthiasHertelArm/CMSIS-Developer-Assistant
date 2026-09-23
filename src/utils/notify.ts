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
 * The extension's error and warning notifications (#48). Each shows the toast
 * as `vscode.window.showErrorMessage` / `showWarningMessage` would, and also
 * records it in the window's problem journal (source `ui`), so an agent learns
 * what the user was told. Modal confirmations are questions, not problems,
 * and keep calling VS Code directly.
 */

import * as vscode from 'vscode';
import { problemJournal, type ProblemSeverity } from '../core/problemJournal';

/** The origin of this extension's own notifications in the journal. */
const OWN_ORIGIN = 'cmsis-developer-assistant';

function recordNotice(severity: ProblemSeverity, message: string): void {
    try {
        problemJournal().append({ source: 'ui', origin: OWN_ORIGIN, severity, message });
    } catch {
        // The toast matters more than its record.
    }
}

/** Shows an error notification and journals it; resolves with the item the user picked. */
export function notifyError(message: string, ...items: string[]): Thenable<string | undefined> {
    recordNotice('error', message);
    return vscode.window.showErrorMessage(message, ...items);
}

/** Shows a warning notification and journals it; resolves with the item the user picked. */
export function notifyWarning(message: string, ...items: string[]): Thenable<string | undefined> {
    recordNotice('warning', message);
    return vscode.window.showWarningMessage(message, ...items);
}
