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
 * What is known of an MCP client from the name it sent with `initialize`:
 * where it lives, and how it shows a tool result to the model.
 *
 * `open_solution` from a window without a folder may open the folder in that
 * window, which VS Code reloads: a client that runs outside the window (a CLI
 * in a terminal) loses its MCP session for a few seconds and connects again,
 * but a chat that lives inside the window — Copilot Chat, Cline, Roo Code,
 * any editor that hosts the extension — is ended by the reload, mid-turn.
 * So the reload is only for clients known to survive it; everyone else gets
 * a new window, which always works.
 *
 * Some clients hand the model a result's `structuredContent` instead of its
 * text, so every `structuredContent` repeats the text as `message`. A client
 * that shows both then reads every result with data twice; its sessions get
 * the text alone (`TEXT_ONLY_CLIENTS`).
 *
 * Pure: no vscode.
 */

/**
 * Name prefixes of the clients that run outside the VS Code window: the CLIs.
 * Not `kimi-code`: the Kimi Code CLI and its VS Code extension, which lives in
 * the window, share the SDK that sends the name.
 */
const OUTSIDE_THE_WINDOW: readonly string[] = ['claude-code', 'codex', 'gemini'];

/**
 * Names of the clients whose sessions get tool results without
 * `structuredContent`, because they show the model the text and the object
 * serialized after it. The text says everything without the object
 * (`linesMissingFromStructured`), and a failure keeps `isError` and its
 * `[CODE]`. A name matches exactly, in the case the client sends it.
 *
 * - `kimi-code`: Kimi Code, the CLI and the VS Code extension, appends
 *   `structuredContent` to the text as `<mcp-result-extras>` JSON; releases
 *   before 2.0 dropped it (MoonshotAI/kimi-code `agent/mcp/output.ts` at
 *   743f140; 17 KB of 95 KB in a session of September 2026).
 *
 * The GitHub Copilot SDK agent shows both too (a tester's log of
 * 2.7.0-preview3: 635 KB of `structuredContent` on top of 764 KB of text);
 * its exact client name goes here once it is known.
 */
export const TEXT_ONLY_CLIENTS: readonly string[] = ['kimi-code'];

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

/**
 * Whether a client of this name gets tool results as text alone: its name is
 * in `textOnly` (`TEXT_ONLY_CLIENTS` unless a test passes another list),
 * exactly. An absent name never is.
 */
export function wantsTextOnly(clientName: string | undefined, textOnly: readonly string[] = TEXT_ONLY_CLIENTS): boolean {
    return clientName !== undefined && textOnly.includes(clientName);
}
