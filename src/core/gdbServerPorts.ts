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
 * Where a CMSIS attach would connect, and whether the window's CMSIS Run
 * task can be what serves it there.
 *
 * An attach configuration of the CMSIS Debugger (`gdbtarget`, `request:
 * attach`) starts no GDB server; GDB's `target remote` connects to
 * `target.host:target.port`. When nothing listens there, GDB retries for its
 * connect timeout (15 s) and the session ends with "could not connect".
 *
 * Nothing here connects to such a port to find out: a GDB server takes every
 * connection as a client. pyOCD halts the target when a client connects and
 * resumes it when the client leaves, and without `--persist` it shuts down
 * then; the J-Link GDB server started with `-singlerun` closes with its last
 * client. What is known without a connection is the command line of the
 * window's CMSIS Run task: the FVP adapter's Run is the model without its
 * GDBServer plugin, which belongs to the launch configuration, so while it
 * runs nothing the window started serves an attach.
 *
 * No `vscode`: the launch.json text and the task come in.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

/** One attach configuration's GDB server address. */
export interface AttachEndpoint {
    name: string;
    host: string;
    port: number;
}

/**
 * What a CMSIS Run task's command line says about the attach: it loads a GDB
 * server, it is an FVP model without one, or it does not tell (no command
 * line, or a program that is neither, such as a model shim).
 */
export type RunCommandKind = 'gdbServer' | 'bareModel' | 'unknown';

/** The cbuild-run.yml debugger of the FVP adapter, whose CMSIS Run is the model without the GDBServer plugin. */
const FVP_DEBUGGER = 'Arm-FVP';

/**
 * A word of a GDB server's command line: pyOCD's `gdbserver` subcommand, the
 * J-Link `JLinkGDBServerCL`, the FVP's `GDBServer.so` / `GDBServer.dll`
 * plugin and its `GDBServer.port` parameter.
 */
const GDB_SERVER_WORD = /gdbserver/i;
/** The executable of an Arm FVP model (`FVP_Corstone_SSE-300`, `FVP_MPS2_Cortex-M3.exe`; `VHT_…` for the older AVH models). */
const FVP_MODEL = /^(?:FVP|VHT)_/;
/** A word of a command line: double-quoted, single-quoted or bare. */
const COMMAND_LINE_WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** A TCP port given as a number or as digits; anything else is none. */
function portOf(value: unknown): number | undefined {
    const port = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/**
 * The GDB server addresses of the `gdbtarget` attach configurations in a
 * launch.json text (comments and trailing commas allowed). Configurations
 * without a numeric `target.port` are left out; the host defaults to
 * localhost, as the adapter's does.
 */
export function attachEndpoints(launchJson: string): AttachEndpoint[] {
    const parsed: unknown = parseJsonc(launchJson, [], { allowTrailingComma: true });
    const configurations = (parsed as { configurations?: unknown } | undefined)?.configurations;
    if (!Array.isArray(configurations)) {
        return [];
    }
    const endpoints: AttachEndpoint[] = [];
    for (const entry of configurations) {
        const config = entry as { type?: unknown; request?: unknown; name?: unknown; target?: { host?: unknown; port?: unknown } };
        if (config?.type !== 'gdbtarget' || config.request !== 'attach') {
            continue;
        }
        const port = portOf(config.target?.port);
        if (port === undefined) {
            continue;
        }
        const host = typeof config.target?.host === 'string' && config.target.host.trim() !== '' ? config.target.host.trim() : 'localhost';
        endpoints.push({ name: typeof config.name === 'string' ? config.name : 'attach', host, port });
    }
    return endpoints;
}

/** The attach endpoints of `folder/.vscode/launch.json`; none when the file cannot be read. Reads the file only. */
export async function launchAttachEndpoints(folder: string): Promise<AttachEndpoint[]> {
    try {
        return attachEndpoints(await fs.promises.readFile(path.join(folder, '.vscode', 'launch.json'), 'utf8'));
    } catch {
        return [];
    }
}

/** The text of a `string` or a `ShellQuotedString` (`{ value }`). */
function wordOf(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    const quoted = (value as { value?: unknown } | undefined)?.value;
    return typeof quoted === 'string' ? quoted : undefined;
}

/**
 * The program and arguments a task runs: its `ShellExecution` (`command` and
 * `args`, or one `commandLine`) or `ProcessExecution` (`process` and `args`),
 * as `vscode.Task.execution` holds them for a tasks.json task. Undefined for
 * anything else (no execution, a `CustomExecution`).
 */
export function taskCommandWords(task: unknown): string[] | undefined {
    const execution = (task as { execution?: unknown } | undefined)?.execution as
        { commandLine?: unknown; command?: unknown; process?: unknown; args?: unknown } | undefined;
    if (typeof execution?.commandLine === 'string') {
        const words = [...execution.commandLine.matchAll(COMMAND_LINE_WORD)].map((match) => match[1] ?? match[2] ?? match[3]);
        return words.length > 0 ? words : undefined;
    }
    const program = wordOf(execution?.command) ?? wordOf(execution?.process);
    if (program === undefined || program.trim() === '') {
        return undefined;
    }
    const args = Array.isArray(execution?.args) ? execution.args.map(wordOf).filter((word): word is string => word !== undefined) : [];
    return [program, ...args];
}

/**
 * What a CMSIS Run task's command line says: any word that names a GDB server
 * makes it `gdbServer`; otherwise an FVP model executable is the bare model
 * (the FVP adapter's Run: the model, its configuration file and the images);
 * anything else is `unknown`.
 */
export function runCommandKind(words: readonly string[] | undefined): RunCommandKind {
    if (!words || words.length === 0) {
        return 'unknown';
    }
    if (words.some((word) => GDB_SERVER_WORD.test(word))) {
        return 'gdbServer';
    }
    const program = words[0].split(/[\\/]/).pop() ?? words[0];
    return FVP_MODEL.test(program) ? 'bareModel' : 'unknown';
}

/** True for the FVP adapter's debugger name as a cbuild-run.yml writes it (`Arm-FVP`), in any case. */
export function isFvpDebugger(name: string | undefined): boolean {
    return name !== undefined && name.trim().toLowerCase() === FVP_DEBUGGER.toLowerCase();
}
