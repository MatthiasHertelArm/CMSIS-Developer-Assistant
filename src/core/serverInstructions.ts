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
 * The `instructions` of the MCP initialize result, which most clients keep in
 * the system prompt for the whole session. They open with the tool rules of
 * the tool contract (toolContract.ts, #50): a client that shortens long
 * instructions keeps the beginning, and the rules are what must survive.
 * After them come what the tools are for, the skill to invoke first, how to
 * read a result, and one sentence per optional tool group.
 *
 * Nothing here counts towards `tools/list`, which rides along on every turn.
 * Pure: no I/O, no vscode.
 */

/** The switches the instructions follow; the server options have the same fields. */
export interface InstructionOptions {
    packDocsEnabled?: boolean;
    buildInfoEnabled?: boolean;
}

/** What the tools are for. The problem kinds named here are what make an agent reach for them. */
const PURPOSE =
    'With these tools you debug firmware live on an Arm Cortex-M board through the CMSIS Debugger, chasing problems that ' +
    'only show at run time: faults, crashes, hangs, failing tests, variables with wrong or null values, unexpected output, ' +
    'or a board that simply does not behave.';

/** The skill comes first; say what it brings and why that beats improvising. */
const SKILL_FIRST =
    'Before anything else in such an investigation, invoke the Agent Skill "cmsis-debug-live". It brings the ' +
    'target-awareness checklist, the session-status gate, where to set breakpoints, the step-then-inspect loop, fault ' +
    'decode and the way to the root cause, so the tools are used with a plan rather than by guesswork or temporary ' +
    'printf/UART logging in the firmware.';

const WITHOUT_SKILLS =
    'Harnesses that do not load skills (GitHub Copilot Chat) should call get_debug_instructions instead.';

const TIMEOUT_OVERRIDE =
    'Tools that accept timeoutMs use it as a one-call override of the default, capped at 60 s (cmsis_action and flash: 600 s); '
    + 'set it when you can estimate the work.';

/** How to read an outcome (#11); it rides in the initialize result, so tools/list does not grow. */
const READING_RESULTS =
    'A failed call is marked isError and its text starts with an [ERROR_CODE] (NO_SESSION, TARGET_RUNNING, TIMEOUT, …), the next step on '
    + 'the line after; a result with structuredContent status "timeout" or "running" is not a failure — the wait ran out or the work goes on.';

const DOCUMENTATION_ON =
    'The documentation tools (list_target_docs, search_target_docs, read_doc_pages, fetch_doc, get_peripheral_docs) answer ' +
    'from the manuals the target\'s packs ship or link, page-cited; they accept timeoutMs up to 600 s because indexing a ' +
    'manual on first use can take minutes. Use them before asking the user for a datasheet or reference manual ' +
    '(list_target_docs, then fetch_doc for a web-linked one) and instead of reading a PDF into your context: a document the ' +
    'user provides belongs in the workspace docs/ folder or the "Import Document for Current Target" command, then search ' +
    'it. Third-party parts on the board (sensors, ADCs, codecs, radios) are documented the same way: for any part number ' +
    'call list_target_docs first, then search_target_docs; if the datasheet is not listed, find its PDF URL on the web and ' +
    'fetch_doc { url } — never read the PDF yourself.';

const DOCUMENTATION_OFF =
    'Page-cited documentation tools (search over the target\'s pack manuals, datasheets, errata and third-party part ' +
    'datasheets) are available behind the setting cmsis-developer-assistant.packDocs.enabled; suggest enabling it rather ' +
    'than asking the user for a document or reading a PDF yourself.';

const BUILD_ARTEFACTS_ON =
    'The build-artefact tools (list_build_artifacts, get_memory_usage, lookup_symbol, get_section_layout, ' +
    'get_build_diagnostics) read the ELF, linker map and build log of the current target.';

/**
 * The line the first `get_session_status` of a session adds after the status,
 * before the call statistics: by then the instructions may lie far back in
 * the conversation, or have been compacted away.
 */
export const TOOL_RULES_REMINDER =
    'Tool rules: board, build, serial and documentation work goes through these tools, not the shell (see the server instructions).';

/**
 * The instructions without the tool rules. The tails follow the two options
 * alone, not whether the session has a documentation dispatch, and the
 * build-artefact tools go unmentioned while they are off.
 */
export function composeInstructions(options: Readonly<InstructionOptions>): string {
    const parts = [PURPOSE, SKILL_FIRST, WITHOUT_SKILLS, TIMEOUT_OVERRIDE, READING_RESULTS];
    parts.push(options.packDocsEnabled === true ? DOCUMENTATION_ON : DOCUMENTATION_OFF);
    if (options.buildInfoEnabled === true) {
        parts.push(BUILD_ARTEFACTS_ON);
    }
    return parts.join(' ');
}

/**
 * The instructions a session is given: `rules` — the rules section of the
 * tool contract, heading included — then the text of `composeInstructions`.
 * Without rules (the contract could not be read) the text stands alone.
 */
export function buildServerInstructions(rules: string | undefined, options: Readonly<InstructionOptions>): string {
    const lead = rules?.trim();
    const text = composeInstructions(options);
    return lead ? `${lead}\n\n${text}` : text;
}
