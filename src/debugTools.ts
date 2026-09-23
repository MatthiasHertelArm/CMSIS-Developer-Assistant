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
 * What an agent sees of one MCP session: the server identity and
 * instructions, the debugging, serial and window-routing tools (the
 * documentation and build-artefact groups come from their own modules), and
 * the Markdown shipped under docs/ as resources.
 *
 * `buildSessionServer` assembles it once per session. The gates read the
 * server options and the session's handlers at that moment only, so the tool
 * list a client caches stays true for the whole session.
 *
 * Every tool hands its parsed arguments to one handler method and replies
 * with that method's text. Nothing is caught here: `MeasuredMcpServer` counts
 * a failure as an error and the SDK turns it into an `isError` result.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { IDebuggingHandler } from '.';
import { TOPICS, sliceTopic } from './core/instructionTopics';
import { MeasuredMcpServer } from './core/measuredMcpServer';
import type { ToolMetrics } from './core/toolMetrics';
import { SERVER_VERSION } from './debuggingExecutor';
import type { DebugMCPServerOptions, SessionHandlers } from './debugMCPServer';
import { registerBuildInfoTools } from './buildInfoTools';
import { registerPackDocsTools } from './packDocsTools';
import { logger } from './utils/logger';

/** The name in the initialize result, and the scheme of every resource URI. */
const SERVER_NAME = 'cmsis-developer-assistant';

// ── Server instructions ─────────────────────────────────────────────────────

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
    'Tools that accept timeoutMs use it as a one-call override of the default, capped at 60 s; set it when you can estimate the work.';

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
 * The `instructions` of the initialize result. The tails follow the two
 * options alone, not whether the session has a documentation dispatch, and
 * the build-artefact tools go unmentioned while they are off.
 */
export function composeInstructions(options: Readonly<DebugMCPServerOptions>): string {
    const parts = [PURPOSE, SKILL_FIRST, WITHOUT_SKILLS, TIMEOUT_OVERRIDE];
    parts.push(options.packDocsEnabled === true ? DOCUMENTATION_ON : DOCUMENTATION_OFF);
    if (options.buildInfoEnabled === true) {
        parts.push(BUILD_ARTEFACTS_ON);
    }
    return parts.join(' ');
}

// ── Tool descriptions ───────────────────────────────────────────────────────

/** The sentences of one description, joined by single spaces. */
const say = (...sentences: string[]): string => sentences.join(' ');

const ABOUT = {
    get_debug_instructions: say(
        'Debugging guide for harnesses that do not load the "cmsis-debug-live" Agent Skill.',
        'Default: a short overview plus the topic list; pass topic for one section (session, build, breakpoints, inspection, faults, troubleshooting).',
    ),
    start_debugging: say(
        'Start a debug session through the VS Code debug pipeline (launch.json).',
        'Before using this tool, invoke the skill "cmsis-debug-live".',
        'For CMSIS / Cortex-M projects prefer cmsis_action load_and_debug (builds, flashes, attaches); start_debugging skips the ' +
        'flash step and suits non-CMSIS projects or attaching to an already-flashed target.',
        'Refuses while a session is active.',
    ),
    stop_debugging: 'Terminate the active debug session.',
    step_over: 'Run one source line; functions it calls are not entered.',
    step_into: 'Enter the function that the current line calls.',
    step_out: 'Run until the current function returns to its caller.',
    pause_execution: say(
        'Pause a running target so inspection tools (variables, memory, registers, call stack) become valid.',
        'No-op if the target is already stopped.',
        'Returns the new debug state on success, or a structured error if the probe is unresponsive.',
    ),
    continue_execution: 'Let the target run again; it stops at the next breakpoint it reaches or when the program ends.',
    wait_for_stop: say(
        'Block until the target next stops (breakpoint, fault, step, pause) and return the reason and state, or a structured ' +
        'timeout — instead of sleeping blind after continue_execution or "-exec continue".',
        'Returns at once if already stopped; issues no execution commands.',
    ),
    restart_debugging: 'Start the debug session over, reusing its launch configuration.',
    reset: say(
        'Reset the target inside the live session (breakpoints survive, unlike restart_debugging) and verify it: the PC is ' +
        'compared against the reset vector and the result says when the target did NOT reset.',
        'A running target is halted first.',
    ),
    add_breakpoint: say(
        'Set a breakpoint at a line.',
        'Cortex-M binds only a few at once (FPB comparators, typically 4–8) — clear ones you no longer need.',
    ),
    add_logpoint: say(
        'Breakpoint that prints a message and resumes.',
        'Interpolate with {expr} (%d) or {expr:%s|%f|%p|%08lx}; {{ }} are literal braces.',
        'On Cortex-M the core still halts on every hit while GDB prints — in an ISR or hot loop prefer read_cycle_counter or ' +
        'a RAM buffer read with read_memory.',
    ),
    remove_breakpoint: 'Delete one breakpoint, identified by its file and line.',
    clear_all_breakpoints:
        'Delete every breakpoint in one call — the tidy-up step once the cause of the bug is confirmed, before you start on anything else.',
    list_breakpoints: 'Show the breakpoints that are set, in every file.',
    list_variable_names: say(
        'Show which variables exist where the target is stopped, with their types but not their values.',
        'Discover first, then pull only what you need with get_variables_values — on a slow probe that is the difference ' +
        'between one round trip and thirty.',
    ),
    get_variables_values: say(
        'Read variable values where the target is stopped and compare the data the program actually holds with what you ' +
        'expect it to hold — the quickest way to find the value that is wrong.',
        'Omit variableNames to dump the whole scope (capped at 40 variables per scope and 200 chars per value); pass ' +
        'variableNames to read exactly what you need, uncapped.',
    ),
    evaluate_expression: say(
        'Evaluate any expression written in the debugged program\'s language against the live target — to test a hypothesis, ' +
        'compute a value, call a function or read a struct member.',
        'It reaches further than reading a single variable.',
    ),
    read_memory: say(
        'Read a range of bytes from the target\'s memory.',
        'Use this for inspecting SRAM, Flash, peripheral registers, or the stack.',
        'Returns hex dump and/or ASCII representation.',
        'Hex by default; format ascii or both on request.',
    ),
    read_core_registers: say(
        'Read Cortex-M core registers: R0-R12, SP, LR, PC, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK.',
        'Essential for analyzing crash state, stack pointers, and processor mode.',
    ),
    read_cycle_counter: say(
        'Read the DWT cycle counter for cycle-accurate timing: read, run to the end point, read again, subtract mod 2^32.',
        'Wraps (~10.7 s @ 400 MHz); counts ACTIVE cycles only (stops while halted and in WFE).',
        'Enables DWT/CYCCNT on first use; reports cores without one.',
    ),
    read_peripheral_register: say(
        'Read named peripheral registers using SVD data from the Peripheral Inspector extension.',
        'Provide a peripheral name (e.g. "GPIOA", "UART0", "SPI1") and optionally a register name.',
        'If the Peripheral Inspector is not available, provides guidance on using read_memory instead.',
    ),
    get_fault_info: say(
        'Read and decode the Cortex-M fault status registers (CFSR, HFSR, BFAR, MMFAR, DFSR, AFSR) bit by bit.',
        'For a one-call triage with the stacked frame, the call stack and hypotheses, prefer diagnose_fault.',
    ),
    diagnose_fault: say(
        'Triage a HardFault / BusFault / MemManage / UsageFault in one call on a stopped target: decoded fault registers, the ' +
        'stacked exception frame (PC of the faulting instruction, its caller), the top frames, the faulting address resolved ' +
        'against the SVD, and up to three ranked hypotheses each with the next tool call.',
        'Reports a short stop context when no fault flag is set.',
    ),
    lookup_peripheral: say(
        'Answer "which peripheral is at this address" or "which registers does this peripheral have" from the device SVD — ' +
        'no session, no target access.',
        'name: the register map; address: the peripheral and register containing it (resolve a BFAR); neither: the peripheral list.',
        'Unknown names get suggestions.',
    ),
    lookup_register: say(
        'Describe one register from the device SVD without reading the target: address, access, reset value, bit fields with ' +
        'their enumerated values.',
        'Use it to learn which bit is the clock enable before read_peripheral_register or read_memory.',
    ),
    get_device_info:
        'Return information about the connected debug target: session name, debug type, program path, GDB path, GDB server, ' +
        'port, and CMSIS config details.',
    check_target_connection: say(
        'Probe the hardware debug connection with a short-timeout DAP ping.',
        'Use this when other tool calls start timing out or returning "unavailable" to determine whether the probe/GDB server ' +
        'is alive and whether the target is stopped (so DAP reads are valid).',
        'Never hangs — uses an internal short timeout.',
    ),
    get_call_stack: say(
        'Return the full call stack (function names, source, line, frameId) for the active thread, or a specific thread when ' +
        'threadId is provided.',
        'Use the returned frameId values with get_frame_variables to inspect variables of caller frames without changing the ' +
        'active frame.',
        'Paths are workspace-relative; beyond 20 frames the rest is counted unless levels is given.',
    ),
    get_threads: say(
        'List DAP threads reported by the debug adapter.',
        'With an RTOS-aware GDB server (pyOCD --rtos, J-Link RTOS plugin) each FreeRTOS / RTX / ThreadX task appears as a ' +
        'thread, matching the xRTOS viewer task list.',
        'Returns the thread id, name and top frame; pair with get_call_stack(threadId=...) to inspect any task\'s call stack.',
        'Lists up to 32 tasks inline.',
    ),
    get_frame_variables: say(
        'Inspect variables of a specific stack frame by its frameId (obtained from get_call_stack).',
        'Lets you walk up the call stack and examine caller-frame state without changing the editor\'s active frame.',
        'Without variableNames the listing is capped (40 per scope, 200 chars per value); with it, uncapped.',
    ),
    serial_list_ports: say(
        'List available serial ports.',
        'Tries the MS Serial Monitor API first (friendly names), falls back to the bundled serialport library.',
    ),
    serial_open: say(
        'Open an OWNED serial port.',
        'The MCP server holds the connection and buffers RX.',
        'Use only when no MS Serial Monitor UI session is active on the same path — the OS allows one reader per tty.',
        'Defaults: 115200 baud, 8N1, no flow control.',
    ),
    serial_close: 'Close the OWNED serial port (does not affect the MS Serial Monitor UI).',
    serial_status: say(
        'Report state of both backends: owned port (open / buffer size) and Serial Monitor bridge (extension installed / ' +
        'activated / data-subscription available / subscribed).',
        'Includes the discovered API keys so you can see what MS exposes in the installed build.',
    ),
    serial_write: say(
        'Write to the OWNED serial port.',
        'Encoding utf8 (default) or hex.',
    ),
    serial_read: say(
        'Read buffered RX bytes from either backend.',
        'Set from=\'owned\' (default) for the MCP-owned port, from=\'monitor\' for bytes captured via the Serial Monitor bridge subscription.',
        'consume=true (default) drains the buffer; consume=false peeks.',
        'waitMs blocks up to that many ms when buffer is empty.',
    ),
    serial_clear_buffer: say(
        'Discard buffered RX without reading.',
        'from=\'owned\' (default) or \'monitor\'.',
    ),
    serial_subscribe_monitor: say(
        'Subscribe to the MS Serial Monitor extension\'s data event to read the bytes the user\'s UI session receives — no port fight.',
        'Errors clearly when the installed build exposes no data event (then serial_open).',
        'Read with serial_read from=\'monitor\'.',
    ),
    serial_unsubscribe_monitor: 'Stop the Serial Monitor data subscription (the user\'s UI session is unaffected).',
    serial_open_monitor: say(
        'Focus the Microsoft Serial Monitor panel so the user can see / drive their existing session.',
        'UI-only — does not open or read a port.',
        'Pair with serial_subscribe_monitor to also feed bytes back to the agent.',
    ),
    cmsis_action: say(
        'The entry point for CMSIS / Cortex-M debugging: drives the CMSIS Solution extension on the active csolution target, ' +
        'like the panel buttons; every result names the target it ran on.',
        'build / load / erase / load_and_run wait for the task and end with ✅ or ❌ plus the exit code — read that line, do not ' +
        'poll for files.',
        'load_and_debug (flash + debug, the Debug button) and attach (no programming) return with the session state; detach and ' +
        'stop_run are immediate.',
        'Long builds: get_debug_instructions topic build.',
    ),
    flash: say(
        'Program the target with pyocd load --cbuild-run (every image in the cbuild-run file) and return bytes programmed, or ' +
        'the exit code with pyOCD\'s error lines.',
        'Refuses while a debug session is active: stop_debugging → flash → cmsis_action attach.',
        'The cbuild-run file is auto-resolved when omitted; needs pyocd on PATH.',
    ),
    get_session_status: say(
        'Report the debug-session state: no-session, initializing, running, stopped or unresponsive, with the right next action ' +
        'and the session\'s tool-call totals.',
        'Never hangs, never throws — call it whenever a tool said the session is not ready or a call seemed to time out.',
    ),
    list_debug_windows: say(
        'List the VS Code windows this MCP server can drive, with their workspace folders, whether each has an active debug ' +
        'session, and which one this session is currently targeting.',
        'Use it when a tool reports an ambiguous target, or when you suspect you are driving the wrong board.',
    ),
    select_debug_window: say(
        'Pin this session to one VS Code window, by process id or by a path inside its workspace.',
        'Every subsequent tool call runs in that window.',
        'Needed when several windows are open and more than one has a debug session, since the server refuses to guess which ' +
        'board you mean.',
    ),
};

// ── Shared parameters and result shape ──────────────────────────────────────

const TIMEOUT_DESC = 'Per-call timeout in ms, max 60000 (see server instructions).';
const SOURCE_PATH_DESC = 'Absolute path of the source file';
const SOURCE_LINE_DESC = 'Source line, numbered from 1';
const SVD_FILE_DESC = 'Explicit .svd path; default: session, cbuild-run.yml, workspace';
const PNAME_DESC = 'Processor name selecting the SVD in a multi-core cbuild-run';

/** The one-call override of a handler's default timeout (see TIMEOUT_OVERRIDE). */
const CALL_TIMEOUT = z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC);
/** Which variables a listing or a read covers. */
const VARIABLE_SCOPE = z.enum(['local', 'global', 'all']).optional().describe('Which variables to cover: \'local\', \'global\' or \'all\'');
/** Input of every tool whose only parameter is the timeout. */
const TIMEOUT_ONLY = { timeoutMs: CALL_TIMEOUT };

/** Looks at the target or the host and changes nothing. */
const LOOK_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
/** Changes the target irreversibly: a reset, a reprogrammed flash. */
const ALTERS_TARGET: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/** A result of exactly one text item and nothing else; telemetry measures this frame. */
const answer = (body: string): CallToolResult => ({ content: [{ type: 'text', text: body }] });

// ── Shipped documents ───────────────────────────────────────────────────────

const GUIDE_FILE = 'agent-resources/debug_instructions.md';

/**
 * The Markdown under the repository's docs/ folder, read on first use and
 * kept for the life of the server instance (an installed extension's files
 * do not change). A document that cannot be read is not remembered, so the
 * next request tries again.
 */
export class ShippedDocs {
    private readonly remembered = new Map<string, string>();
    /** The bundle first (dist/ beside docs/), then the tsc output (out/src/ two levels below it). */
    private readonly shelves: string[];

    /** @param moduleDir directory of the compiled module; the default suits both layouts. */
    constructor(moduleDir: string = __dirname) {
        this.shelves = [path.join(moduleDir, '..', 'docs'), path.join(moduleDir, '..', '..', 'docs')];
    }

    /** The document's text, or a note saying why it is unavailable (never a rejection). */
    async read(relative: string): Promise<string> {
        const known = this.remembered.get(relative);
        if (known !== undefined) {
            return known;
        }
        const misses: string[] = [];
        for (const shelf of this.shelves) {
            const where = path.join(shelf, relative);
            try {
                const body = await fs.promises.readFile(where, 'utf8');
                this.remembered.set(relative, body);
                logger.debug(`Shipped document ${relative} read from ${where} (${body.length} characters)`);
                return body;
            } catch (miss) {
                misses.push(`${where} (${(miss as NodeJS.ErrnoException | undefined)?.code ?? String(miss)})`);
            }
        }
        const reason = new Error(`not readable at any of: ${misses.join(', ')}`);
        logger.error(`Shipped document ${relative} is unavailable`, reason);
        return `The document ${relative} is not available in this installation: ${reason.message}`;
    }
}

/** One section of the guide, or the whole guide when its topic markers are broken. */
function guideSection(guide: string, topic: string | undefined): string {
    try {
        return sliceTopic(guide, topic);
    } catch (broken) {
        logger.warn('The debugging guide could not be split into topics; serving it whole', broken);
        return guide;
    }
}

interface ShippedResource {
    uri: string;
    name: string;
    description: string;
    file: string;
}

/** The language notes served as resources: id and display name. cpp.md and go.md ship too but are not served. */
const LANGUAGE_NOTES: ReadonlyArray<readonly [string, string]> = [
    ['python', 'Python'],
    ['javascript', 'JavaScript'],
    ['java', 'Java'],
    ['csharp', 'C#'],
];

const SHIPPED_RESOURCES: readonly ShippedResource[] = [
    {
        uri: `${SERVER_NAME}://docs/debug_instructions`,
        name: 'Full Debugging Guide',
        description: 'The complete, ordered debugging procedure for CMSIS Developer Assistant',
        file: GUIDE_FILE,
    },
    ...LANGUAGE_NOTES.map(([id, display]): ShippedResource => ({
        uri: `${SERVER_NAME}://docs/troubleshooting/${id}`,
        name: `${display} Troubleshooting Notes`,
        description: `Advice for debugging ${id} programs`,
        file: `agent-resources/troubleshooting/${id}.md`,
    })),
    {
        uri: `${SERVER_NAME}://docs/cmsis-embedded-guide`,
        name: 'CMSIS Embedded Debugging Guide',
        description: 'Comprehensive guide for debugging Cortex-M embedded targets using CMSIS tools, including fault analysis, ' +
            'peripheral inspection, and memory layout.',
        file: 'agent-resources/cmsis-embedded-guide.md',
    },
    {
        uri: `${SERVER_NAME}://docs/troubleshooting/embedded`,
        name: 'Embedded Debugging Tips',
        description: 'Troubleshooting tips for embedded Cortex-M debugging, HardFault analysis, and peripheral issues.',
        file: 'agent-resources/troubleshooting/embedded.md',
    },
];

// ── Session assembly ────────────────────────────────────────────────────────

/** What one session is built from. */
export interface SessionParts {
    options: Readonly<DebugMCPServerOptions>;
    /** Called once, while the session is built; the session keeps what it returns. */
    handlers: () => SessionHandlers;
    /** This session's samples, read by the stats resource and the get_session_status trailer. */
    ring: ToolMetrics;
    /** Every session's samples; the stats resource reports it as `server`. */
    serverTotals: ToolMetrics;
    docs: ShippedDocs;
}

/** The two extra methods of the window router, recognised by shape so that its module is not imported here. */
interface WindowRouting {
    listDebugWindows(): string;
    selectDebugWindow(args: { pid?: number; workspaceFolder?: string }): string;
}

function windowRoutingOf(handler: IDebuggingHandler): (IDebuggingHandler & WindowRouting) | undefined {
    const shape = handler as unknown as Record<keyof WindowRouting, unknown>;
    const routes = typeof shape.listDebugWindows === 'function' && typeof shape.selectDebugWindow === 'function';
    return routes ? handler as IDebuggingHandler & WindowRouting : undefined;
}

/** A fresh MCP server for one session, with every tool and resource it offers registered. */
export function buildSessionServer(parts: SessionParts): MeasuredMcpServer {
    const mcp = new MeasuredMcpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: composeInstructions(parts.options) },
        parts.ring,
    );
    registerTools(mcp, parts.handlers(), parts);
    registerResources(mcp, parts);
    return mcp;
}

function registerTools(mcp: McpServer, handlers: SessionHandlers, parts: SessionParts): void {
    const { debug, serial, packDocs } = handlers;
    const { options, docs, ring } = parts;

    mcp.registerTool('get_debug_instructions', {
        description: ABOUT.get_debug_instructions,
        inputSchema: {
            topic: z.enum(TOPICS).optional().describe('Section to return. Default: overview (~2 KB) with the topic list.'),
        },
        annotations: LOOK_ONLY,
    }, async (args) => answer(guideSection(await docs.read(GUIDE_FILE), args.topic)));

    mcp.registerTool('start_debugging', {
        description: ABOUT.start_debugging,
        inputSchema: {
            fileFullPath: z.string().optional().describe('Source file to debug; optional when configurationName is given.'),
            workingDirectory: z.string().describe('Directory the debug session runs in'),
            testName: z.string().optional().describe('Name of one test to run on its own; leave out to run the whole file'),
            configurationName: z.string().optional()
                .describe('launch.json configuration name, e.g. "CMSIS Debugger: pyOCD"; empty prompts the user.'),
            timeoutMs: CALL_TIMEOUT,
        },
    }, (args) => debug.handleStartDebugging(args).then(answer));
    mcp.registerTool('stop_debugging', { description: ABOUT.stop_debugging }, () => debug.handleStopDebugging().then(answer));

    // Run control.
    mcp.registerTool('step_over', { description: ABOUT.step_over, inputSchema: TIMEOUT_ONLY }, (args) => debug.handleStepOver(args).then(answer));
    mcp.registerTool('step_into', { description: ABOUT.step_into, inputSchema: TIMEOUT_ONLY }, (args) => debug.handleStepInto(args).then(answer));
    mcp.registerTool('step_out', { description: ABOUT.step_out, inputSchema: TIMEOUT_ONLY }, (args) => debug.handleStepOut(args).then(answer));
    mcp.registerTool('pause_execution', { description: ABOUT.pause_execution, inputSchema: TIMEOUT_ONLY },
        (args) => debug.handlePause(args).then(answer));
    mcp.registerTool('continue_execution', { description: ABOUT.continue_execution, inputSchema: TIMEOUT_ONLY },
        (args) => debug.handleContinue(args).then(answer));
    mcp.registerTool('wait_for_stop', { description: ABOUT.wait_for_stop, inputSchema: TIMEOUT_ONLY, annotations: LOOK_ONLY },
        (args) => debug.handleWaitForStop(args).then(answer));
    mcp.registerTool('restart_debugging', { description: ABOUT.restart_debugging, inputSchema: TIMEOUT_ONLY },
        (args) => debug.handleRestart(args).then(answer));
    mcp.registerTool('reset', {
        description: ABOUT.reset,
        inputSchema: {
            method: z.enum(['auto', 'system', 'core', 'hardware']).optional().describe(
                '\'auto\' (default) escalates system (SYSRESETREQ) → core (VECTRESET) → hardware (nSRST, needs the reset line wired) until one verifies.'),
            halt: z.boolean().optional()
                .describe('Leave the target halted at the reset vector (default true). false resumes after verification.'),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: ALTERS_TARGET,
    }, (args) => debug.handleReset(args).then(answer));

    // Breakpoints and logpoints.
    mcp.registerTool('add_breakpoint', {
        description: ABOUT.add_breakpoint,
        inputSchema: {
            fileFullPath: z.string().describe(SOURCE_PATH_DESC),
            line: z.number().int().min(1).optional().describe(`${SOURCE_LINE_DESC}; preferred over lineContent`),
            condition: z.string().optional().describe('Optional condition, e.g. "i == 100" — GDB-native, so the core halts only when it holds.'),
            lineContent: z.string().optional()
                .describe('DEPRECATED: substring match that breaks on EVERY line containing the text; pass line instead.'),
        },
    }, (args) => debug.handleAddBreakpoint(args).then(answer));
    mcp.registerTool('add_logpoint', {
        description: ABOUT.add_logpoint,
        inputSchema: {
            fileFullPath: z.string().describe(SOURCE_PATH_DESC),
            line: z.number().int().min(1).describe(SOURCE_LINE_DESC),
            logMessage: z.string().describe('Message; {expr} interpolates runtime values.'),
            condition: z.string().optional().describe('Optional condition; logs only when true.'),
        },
    }, (args) => debug.handleAddLogpoint(args).then(answer));
    mcp.registerTool('remove_breakpoint', {
        description: ABOUT.remove_breakpoint,
        // `line` takes any number here, unlike the two tools above.
        inputSchema: { fileFullPath: z.string().describe(SOURCE_PATH_DESC), line: z.number().describe(SOURCE_LINE_DESC) },
    }, (args) => debug.handleRemoveBreakpoint(args).then(answer));
    mcp.registerTool('clear_all_breakpoints', { description: ABOUT.clear_all_breakpoints },
        () => debug.handleClearAllBreakpoints().then(answer));
    mcp.registerTool('list_breakpoints', { description: ABOUT.list_breakpoints }, () => debug.handleListBreakpoints().then(answer));

    // Variables and expressions.
    mcp.registerTool('list_variable_names', {
        description: ABOUT.list_variable_names,
        inputSchema: { scope: VARIABLE_SCOPE, timeoutMs: CALL_TIMEOUT },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleListVariableNames(args).then(answer));
    mcp.registerTool('get_variables_values', {
        description: ABOUT.get_variables_values,
        inputSchema: {
            scope: VARIABLE_SCOPE,
            variableNames: z.array(z.string()).min(1).max(50).optional().describe('Optional filter: read only these variables, ' +
                'e.g. ["adc_raw", "state"]. Names that match nothing are reported back. Omit to return everything in scope.'),
            timeoutMs: CALL_TIMEOUT,
        },
    }, (args) => debug.handleGetVariables(args).then(answer));
    mcp.registerTool('evaluate_expression', {
        description: ABOUT.evaluate_expression,
        inputSchema: {
            expression: z.string().describe('What to evaluate, written in the language of the program being debugged'),
            timeoutMs: CALL_TIMEOUT,
        },
    }, (args) => debug.handleEvaluateExpression(args).then(answer));

    // Cortex-M state: memory, registers, cycle counter, peripherals, faults.
    mcp.registerTool('read_memory', {
        description: ABOUT.read_memory,
        inputSchema: {
            address: z.string().describe('Memory address as hex string, e.g. \'0x20000000\''),
            length: z.number().int().min(1).max(4096).describe('Number of bytes to read (1-4096)'),
            format: z.enum(['hex', 'ascii', 'both']).default('hex').describe('\'hex\' (default), \'ascii\', or \'both\''),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleReadMemory(args).then(answer));
    mcp.registerTool('read_core_registers', { description: ABOUT.read_core_registers, inputSchema: TIMEOUT_ONLY, annotations: LOOK_ONLY },
        (args) => debug.handleReadCoreRegisters(args).then(answer));
    // Marked read-only although the first call enables DWT/CYCCNT (it writes DEMCR and DWT_CTRL).
    mcp.registerTool('read_cycle_counter', { description: ABOUT.read_cycle_counter, inputSchema: TIMEOUT_ONLY, annotations: LOOK_ONLY },
        (args) => debug.handleReadCycleCounter(args).then(answer));
    mcp.registerTool('read_peripheral_register', {
        description: ABOUT.read_peripheral_register,
        inputSchema: {
            peripheral: z.string().describe('Peripheral name, e.g. \'GPIOA\', \'UART0\', \'RCC\''),
            register: z.string().optional().describe('Register name, e.g. \'ODR\', \'CR1\'. If omitted, lists all registers in the peripheral.'),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleReadPeripheralRegister(args).then(answer));
    mcp.registerTool('get_fault_info', { description: ABOUT.get_fault_info, inputSchema: TIMEOUT_ONLY, annotations: LOOK_ONLY },
        (args) => debug.handleGetFaultInfo(args).then(answer));
    mcp.registerTool('diagnose_fault', {
        description: ABOUT.diagnose_fault,
        inputSchema: {
            levels: z.number().int().min(1).max(20).optional().describe('Call-stack frames to include (default 3)'),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleDiagnoseFault(args).then(answer));
    mcp.registerTool('lookup_peripheral', {
        description: ABOUT.lookup_peripheral,
        inputSchema: {
            name: z.string().optional().describe('Peripheral name, e.g. RCC (case-insensitive)'),
            address: z.string().optional().describe('Address to resolve, e.g. 0x40005400'),
            filter: z.string().optional().describe('Name prefix to narrow the list or the register map'),
            svdFile: z.string().optional().describe(SVD_FILE_DESC),
            pname: z.string().optional().describe(PNAME_DESC),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleLookupPeripheral(args).then(answer));
    mcp.registerTool('lookup_register', {
        description: ABOUT.lookup_register,
        inputSchema: {
            peripheral: z.string().describe('Peripheral name, e.g. RCC'),
            register: z.string().describe('Register name, e.g. APB1ENR'),
            svdFile: z.string().optional().describe(SVD_FILE_DESC),
            pname: z.string().optional().describe(PNAME_DESC),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleLookupRegister(args).then(answer));
    mcp.registerTool('get_device_info', { description: ABOUT.get_device_info, annotations: LOOK_ONLY },
        () => debug.handleGetDeviceInfo().then(answer));
    mcp.registerTool('check_target_connection', { description: ABOUT.check_target_connection, annotations: LOOK_ONLY },
        () => debug.handleCheckTargetConnection().then(answer));

    // Stack, threads, frames.
    mcp.registerTool('get_call_stack', {
        description: ABOUT.get_call_stack,
        inputSchema: {
            threadId: z.number().int().optional().describe('Optional DAP thread id (from get_threads). Defaults to the active thread.'),
            levels: z.number().int().min(1).max(200).optional().describe('Maximum frames to return (default 50).'),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleGetCallStack(args).then(answer));
    mcp.registerTool('get_threads', { description: ABOUT.get_threads, inputSchema: TIMEOUT_ONLY, annotations: LOOK_ONLY },
        (args) => debug.handleGetThreads(args).then(answer));
    mcp.registerTool('get_frame_variables', {
        description: ABOUT.get_frame_variables,
        inputSchema: {
            frameId: z.number().int().describe('DAP frame id, as returned by get_call_stack.'),
            scope: VARIABLE_SCOPE,
            variableNames: z.array(z.string()).min(1).max(50).optional()
                .describe('Optional filter: read only these variables. Omit to return everything in the frame.'),
            timeoutMs: CALL_TIMEOUT,
        },
        annotations: LOOK_ONLY,
    }, (args) => debug.handleGetFrameVariables(args).then(answer));

    // Serial console, on unless switched off. serial_read counts as read-only although it drains by default.
    if (options.serialEnabled !== false) {
        mcp.registerTool('serial_list_ports', { description: ABOUT.serial_list_ports, annotations: LOOK_ONLY },
            () => serial('handleListPorts').then(answer));
        mcp.registerTool('serial_open', {
            description: ABOUT.serial_open,
            inputSchema: {
                path: z.string().describe('Device path, e.g. \'/dev/tty.usbmodemABCD\' on macOS or \'COM3\' on Windows'),
                baudRate: z.number().int().optional().describe('Baud rate (default 115200)'),
                dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
                parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
                stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
                rtscts: z.boolean().optional().describe('RTS/CTS hardware flow control (default false)'),
            },
        }, (args) => serial('handleOpen', args).then(answer));
        mcp.registerTool('serial_close', { description: ABOUT.serial_close }, () => serial('handleClose').then(answer));
        mcp.registerTool('serial_status', { description: ABOUT.serial_status, annotations: LOOK_ONLY },
            () => serial('handleStatus').then(answer));
        mcp.registerTool('serial_write', {
            description: ABOUT.serial_write,
            inputSchema: {
                data: z.string().describe('Payload. For encoding=\'hex\' use a hex string like \'0a 1b 2c\'.'),
                encoding: z.enum(['utf8', 'hex']).optional(),
                appendNewline: z.boolean().optional().describe('Append \'\\n\' to utf8 payloads (default false)'),
            },
        }, (args) => serial('handleWrite', args).then(answer));
        mcp.registerTool('serial_read', {
            description: ABOUT.serial_read,
            inputSchema: {
                maxBytes: z.number().int().min(1).optional(),
                waitMs: z.number().int().min(0).max(60000).optional(),
                consume: z.boolean().optional(),
                format: z.enum(['utf8', 'hex', 'both']).optional(),
                from: z.enum(['owned', 'monitor']).optional().describe('Backend to read from (default \'owned\')'),
            },
            annotations: LOOK_ONLY,
        }, (args) => serial('handleRead', args).then(answer));
        mcp.registerTool('serial_clear_buffer', {
            description: ABOUT.serial_clear_buffer,
            inputSchema: { from: z.enum(['owned', 'monitor']).optional() },
        }, (args) => serial('handleClearBuffer', args).then(answer));
        mcp.registerTool('serial_subscribe_monitor', { description: ABOUT.serial_subscribe_monitor },
            () => serial('handleSubscribeMonitor').then(answer));
        mcp.registerTool('serial_unsubscribe_monitor', { description: ABOUT.serial_unsubscribe_monitor },
            () => serial('handleUnsubscribeMonitor').then(answer));
        mcp.registerTool('serial_open_monitor', { description: ABOUT.serial_open_monitor },
            () => serial('handleOpenInUi').then(answer));
    }

    // Documentation and build artefacts: both need the session's dispatch and their own switch.
    if (packDocs !== undefined && options.packDocsEnabled === true) {
        registerPackDocsTools(mcp, packDocs);
    }
    if (packDocs !== undefined && options.buildInfoEnabled === true) {
        registerBuildInfoTools(mcp, packDocs);
    }

    // CMSIS Solution actions and programming.
    mcp.registerTool('cmsis_action', {
        description: ABOUT.cmsis_action,
        inputSchema: {
            action: z.enum(['build', 'load', 'erase', 'load_and_run', 'load_and_debug', 'attach', 'detach', 'stop_run'])
                .describe('Which CMSIS Solution action to invoke'),
            target: z.string().optional().describe('Target-type or type@set from the csolution (e.g. "MPS3", "HP@debug"). ' +
                'Switched and verified when it differs from the active one; omit to use the panel selection.'),
            timeoutMs: z.number().int().min(100).max(60_000).optional()
                .describe(`${TIMEOUT_DESC} For load_and_debug / attach: the session-readiness wait.`),
        },
    }, (args) => debug.handleCmsisCommand(args).then(answer));
    mcp.registerTool('flash', {
        description: ABOUT.flash,
        inputSchema: {
            cbuildRunFile: z.string().optional()
                .describe('Path to the .cbuild-run.yml to program. Omit to auto-resolve from launch.json / out/.'),
            timeoutMs: z.number().int().min(1_000).max(60_000).optional().describe(`${TIMEOUT_DESC} Flash defaults to 60 s.`),
        },
        annotations: ALTERS_TARGET,
    }, (args) => debug.handleFlash(args).then(answer));

    mcp.registerTool('get_session_status', { description: ABOUT.get_session_status, annotations: LOOK_ONLY }, async () => {
        const state = await debug.handleGetSessionStatus();
        // Read after the handler: the totals cover this session's earlier calls, not this one.
        return answer(`${state}\n\n${ring.formatTotals()}`);
    });

    // Only a router has windows to list and pin.
    const router = windowRoutingOf(debug);
    if (router !== undefined) {
        mcp.registerTool('list_debug_windows', { description: ABOUT.list_debug_windows, annotations: LOOK_ONLY },
            async () => answer(router.listDebugWindows()));
        mcp.registerTool('select_debug_window', {
            description: ABOUT.select_debug_window,
            inputSchema: {
                pid: z.number().int().optional().describe('Process id of the window, as reported by list_debug_windows.'),
                workspaceFolder: z.string().optional().describe('Any path inside the target window\'s workspace folder.'),
            },
        }, async (args) => answer(router.selectDebugWindow(args)));
    }
}

function registerResources(mcp: McpServer, parts: SessionParts): void {
    mcp.registerResource('Tool call statistics', `${SERVER_NAME}://stats`, {
        description: 'Per-tool call counts, bytes in/out, durations and outcomes for this MCP session and for the whole server ' +
            'instance, plus the most recent samples',
        mimeType: 'application/json',
    }, async (uri) => {
        const report = { session: parts.ring.totals(), server: parts.serverTotals.totals(), recent: parts.ring.samples().slice(-50) };
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(report, null, 2) }] };
    });
    for (const shipped of SHIPPED_RESOURCES) {
        mcp.registerResource(shipped.name, shipped.uri, { description: shipped.description, mimeType: 'text/markdown' },
            async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await parts.docs.read(shipped.file) }] }));
    }
}
