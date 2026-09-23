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
 * Driving a real GitHub Copilot CLI session from a script: run a process and
 * keep its output, find how to start `copilot` on this platform, the fixed
 * arguments of a scripted one-prompt run, and the JSON-lines event stream
 * that run prints. Used by scripts/test-skill-trigger.ts and
 * scripts/eval-scenario.ts; nothing under `npm test` imports it.
 */

import * as childProcess from 'node:child_process';

/** Output kept from one process; beyond it the spawn fails with ENOBUFS. */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/** Keeps AGENTS.md and the other custom instruction files out of a run. */
const NO_CUSTOM_INSTRUCTIONS = '--no-custom-instructions';

/**
 * Flags of a non-interactive run, after `-C <dir> -p <prompt>`: JSON lines
 * out, every tool allowed without asking, no AGENTS.md or other custom
 * instructions (unless the run asks for them), nothing remote, no log output.
 */
const ONE_SHOT_FLAGS: readonly string[] = [
    '--output-format', 'json', '--allow-all-tools', NO_CUSTOM_INSTRUCTIONS,
    '--no-remote', '--no-remote-export', '--log-level', 'none',
];

/** How a scripted run differs from the default. */
export interface BatchRunOptions {
    /**
     * Read the custom instruction files — the work directory's AGENTS.md
     * above all, and the user's own under $COPILOT_HOME — by leaving out
     * `--no-custom-instructions`.
     */
    customInstructions?: boolean;
    /** More arguments, after the fixed ones. */
    extra?: string[];
}

/** PowerShell switches for a lookup without a profile and without prompts. */
const QUIET_POWERSHELL = ['-NoProfile', '-NonInteractive'];
const WHERE_IS_COPILOT = '(Get-Command copilot -ErrorAction Stop).Source';

/**
 * Run `command` with `args` (no shell, so the arguments arrive verbatim) and
 * return what it wrote to stdout. UTF-8 and a 64 MiB output cap unless the
 * caller's options say otherwise. A process that could not be started throws
 * the spawn error itself; a non-zero exit throws an Error whose first line
 * names the command line and the status, followed by stderr (or stdout when
 * stderr is empty).
 */
export function run(command: string, args: string[], options: childProcess.SpawnSyncOptions = {}): string {
    const finished = childProcess.spawnSync(command, args, { encoding: 'utf8', maxBuffer: OUTPUT_CAP_BYTES, ...options });
    if (finished.error) {
        throw finished.error;
    }
    if (finished.status !== 0) {
        const commandLine = [command, ...args].join(' ');
        const said = finished.stderr || finished.stdout;
        throw new Error(`${commandLine} returned exit status ${finished.status}\n${said}`);
    }
    return finished.stdout as string;
}

/**
 * How to start `copilot`. Elsewhere `PATH` finds it; on Windows npm installs
 * a PowerShell script, which cannot be spawned directly, so PowerShell is
 * asked where it is (on every call) and runs it. Throws when it is not there.
 */
export function getCopilotInvocation(): { command: string; args: string[] } {
    if (process.platform !== 'win32') {
        return { command: 'copilot', args: [] };
    }
    const script = run('powershell.exe', [...QUIET_POWERSHELL, '-Command', WHERE_IS_COPILOT]).trim();
    return { command: 'powershell.exe', args: [...QUIET_POWERSHELL, '-File', script] };
}

/**
 * The events of `--output-format json` output: every line that parses as
 * JSON, in order. Banners, blank and partial lines are skipped; nothing
 * checks that a value is an object.
 */
export function parseEvents<T = unknown>(output: string): T[] {
    const events: T[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (line.length === 0) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as T);
        } catch {
            // not an event
        }
    }
    return events;
}

/** The arguments of a scripted run of one prompt in `workDir`; `options.extra` goes last. */
export function copilotBatchArgs(workDir: string, prompt: string, options: BatchRunOptions = {}): string[] {
    const flags = options.customInstructions === true ? ONE_SHOT_FLAGS.filter(flag => flag !== NO_CUSTOM_INSTRUCTIONS) : ONE_SHOT_FLAGS;
    return ['-C', workDir, '-p', prompt, ...flags, ...(options.extra ?? [])];
}
