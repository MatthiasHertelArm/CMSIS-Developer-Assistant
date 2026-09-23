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
 * Facts about the session, as data and as text: the `threads` readiness
 * probe behind the status tools, the `check_target_connection` report, the
 * `get_device_info` block, and the workspace folder in which a launch
 * configuration named by the agent is looked up.
 */

import * as vscode from 'vscode';
import { getStoppedReason, isSessionStopped, resolveActiveSession } from '../utils/sessionStateTracker';
import { customRequestWithTimeout, HardwareTimeoutError } from '../utils/timeout';
import { messageOf } from './common';
import { SessionStatus } from './contract';

/**
 * Probes the session with one `threads` request. A timeout means the probe
 * or target is hung; any other failure usually means the adapter is still
 * starting. Never rejects.
 */
export async function probeSession(probeMs: number): Promise<SessionStatus> {
    const session = resolveActiveSession();
    if (!session) {
        return {
            state: 'no-session',
            sessionName: null,
            sessionType: null,
            configurationName: null,
            dapResponsive: false,
            dapProbeMs: null,
        };
    }
    const identity = {
        sessionName: session.name,
        sessionType: session.type ?? null,
        configurationName: session.configuration?.name ?? null,
    };
    const sentAt = Date.now();
    try {
        await customRequestWithTimeout(session, 'threads', {}, probeMs);
    } catch (err) {
        const hung = err instanceof HardwareTimeoutError;
        return {
            state: hung ? 'unresponsive' : 'initializing',
            ...identity,
            dapResponsive: false,
            dapProbeMs: null,
            detail: hung
                ? `DAP threads probe timed out after ${probeMs}ms — probe/target may be hung.`
                : `DAP threads probe failed: ${messageOf(err)}`,
        };
    }
    const roundTripMs = Date.now() - sentAt;
    const halted = isSessionStopped(session);
    const reason = halted ? getStoppedReason(session) : null;
    return {
        state: halted ? 'stopped' : 'running',
        ...identity,
        dapResponsive: true,
        dapProbeMs: roundTripMs,
        detail: reason === null ? undefined : `Stopped reason: ${reason}`,
    };
}

/** The `check_target_connection` text for a probe result. The stop reason is left out. */
export function connectionReport(status: SessionStatus): string {
    if (status.state === 'no-session') {
        return 'No active debug session.';
    }
    const report = [`Session: ${status.sessionName} (type=${status.sessionType ?? 'unknown'})`];
    if (status.configurationName) {
        report.push(`Configuration: ${status.configurationName}`);
    }
    switch (status.state) {
        case 'unresponsive':
        case 'initializing':
            report.push(status.state === 'unresponsive'
                ? 'DAP probe: TIMEOUT — probe/target unresponsive'
                : 'DAP probe: FAILED — adapter likely still initializing');
            if (status.detail) {
                report.push(status.detail);
            }
            break;
        case 'running':
            report.push(`DAP probe: OK (${status.dapProbeMs}ms)`,
                'Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.');
            break;
        case 'stopped':
            report.push(`DAP probe: OK (${status.dapProbeMs}ms)`,
                'Target state: stopped — full inspection is available.');
            break;
    }
    return report.join('\n');
}

/** The `get_device_info` block, read from the launch configuration only. */
export function deviceReport(session: vscode.DebugSession): string {
    const launch = session.configuration;
    const rows: Array<[label: string, value: unknown]> = [
        ['Session name', session.name],
        ['Debug type', launch.type || '<unknown>'],
        ['Program', launch.program || '<unknown>'],
        ['GDB', launch.gdb || '<default>'],
        ['Server', launch.target?.server || '<unknown>'],
        ['Port', launch.target?.port || '<unknown>'],
    ];
    if (launch.cmsis?.cbuildRunFile) {
        rows.push(['cbuild-run', launch.cmsis.cbuildRunFile]);
    }
    return rows.reduce((block, [label, value]) => `${block}  ${label}: ${value}\n`, '=== Debug Session Info ===\n');
}

/**
 * The open workspace folder a launch configuration named for `directory` is
 * resolved in: the folder VS Code maps the directory to; else the first
 * folder that equals, contains or lies inside the directory (compared with
 * trailing separators removed, `/` as the only separator and case-sensitive,
 * KB12); else the only folder when exactly one is open.
 */
export function launchFolderFor(directory: string): vscode.WorkspaceFolder | undefined {
    const open = vscode.workspace.workspaceFolders ?? [];
    if (open.length === 0) {
        return undefined;
    }
    const mapped = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(directory));
    if (mapped) {
        return mapped;
    }
    const wanted = trimSeparators(directory);
    const related = open.find((folder) => {
        const root = trimSeparators(folder.uri.fsPath);
        return wanted === root || wanted.startsWith(`${root}/`) || root.startsWith(`${wanted}/`);
    });
    if (related) {
        return related;
    }
    return open.length === 1 ? open[0] : undefined;
}

/** Why `launchFolderFor` found nothing, listing the folders that are open. */
export function noLaunchFolderText(directory: string): string {
    const open = vscode.workspace.workspaceFolders ?? [];
    const listed = open.length > 0 ? open.map((folder) => folder.uri.fsPath).join(', ') : '(none)';
    return `No VS Code workspace folder matches workingDirectory '${directory}'. Open workspace folders: ${listed}. ` +
        'launch.json is resolved relative to an open workspace folder — open the project folder ' +
        '(the one containing .vscode/launch.json) in this VS Code window.';
}

function trimSeparators(fsPath: string): string {
    return fsPath.replace(/[\\/]+$/, '');
}
