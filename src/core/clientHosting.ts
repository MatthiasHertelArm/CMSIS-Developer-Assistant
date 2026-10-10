/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Where an MCP client lives, judged by the name it sent with `initialize`.
 *
 * `open_solution` from a window without a folder may open the folder in that
 * window, which VS Code reloads: a client that runs outside the window (a CLI
 * in a terminal) loses its MCP session for a few seconds and connects again,
 * but a chat that lives inside the window — Copilot Chat, Cline, Roo Code,
 * any editor that hosts the extension — is ended by the reload, mid-turn.
 * So the reload is only for clients known to survive it; everyone else gets
 * a new window, which always works.
 *
 * Pure: no vscode.
 */

/** Name prefixes of the clients that run outside the VS Code window: the CLIs. */
const OUTSIDE_THE_WINDOW: readonly string[] = ['claude-code', 'codex', 'gemini'];

/**
 * Whether a client of this name keeps working while the VS Code window it
 * talks to reloads. Unknown and absent names count as inside the window.
 */
export function survivesWindowReload(clientName: string | undefined): boolean {
    if (!clientName) {
        return false;
    }
    const name = clientName.trim().toLowerCase();
    return OUTSIDE_THE_WINDOW.some((prefix) => name.startsWith(prefix));
}
