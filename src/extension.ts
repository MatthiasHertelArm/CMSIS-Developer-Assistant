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
 * The VS Code entry point (`main` in package.json, bundled by esbuild.js).
 *
 * `activate` wires the modules together in a fixed order: settings read once
 * for this activation, the debug-session trackers, the agent and skill
 * manager, the documentation handlers and their commands, this window's
 * `WindowCoordinator` (the MCP router or a worker), the MCP server definition
 * for in-editor Copilot, agent-configuration migration, the settings and
 * workspace-folder listeners, the agent/skill commands, and the first-run
 * setup or skills prompt two seconds later. `deactivate` shuts the coordinator
 * down so the window leaves the shared registry before the host exits.
 *
 * Only imports and the two references below exist at load time; no `vscode`
 * API is called before `activate` (test/transport/packaged-vsix.js loads the
 * bundle under a minimal stub).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { clearSvdCache } from './core/svdParser';
import { SERVER_VERSION } from './debuggingExecutor';
import { registerPackDocsCommands } from './packDocsCommands';
import type { PackDocsHandlers } from './packDocsDispatch';
import { createPackDocsHandlers, readPackDocsGates } from './packDocsHost';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger } from './utils/logger';
import { registerSessionStateTracker } from './utils/sessionStateTracker';
import { registerToolchainPackRootInvalidation } from './utils/toolchainPackRoot';
import { WindowCoordinator } from './windowCoordinator';

const SECTION = 'cmsis-developer-assistant';
const PRODUCT = 'CMSIS Developer Assistant';
/** The MCP server definition provider id contributed in package.json. */
const MCP_PROVIDER_ID = 'cmsis-developer-assistant';
/** Delay before the first-run setup or the skills prompt, so they do not compete with startup. */
const SETUP_DELAY_MS = 2000;
const RELOAD_BUTTON = 'Reload Window';
const PORT_RELOAD_NOTICE = `${PRODUCT}: the server port setting changed. Reload the window to restart the MCP server on the new port.`;
const GATES_RELOAD_NOTICE = `${PRODUCT}: the documentation / build-artefact tool setting changed. Reload the window so the next agent connection sees the new tool list.`;
const DUPLICATE_PACK_DOCS_NOTICE = `${PRODUCT}: the experimental "CMSIS Pack Docs" extension is also installed. `
    + 'Its tools are now built into this extension (settings cmsis-developer-assistant.packDocs.enabled / buildInfo.enabled); '
    + 'uninstall it so agents do not see the same tool names twice.';

/** Kept from `activate` to `deactivate`. */
let windowCoordinator: WindowCoordinator | null = null;
let agentManager: AgentConfigurationManager | null = null;

/** The settings this activation runs with; changing any of them takes a window reload. */
interface ActivationSettings {
    timeoutInSeconds: number;
    serverPort: number;
    dapRequestMs: number;
    memoryReadMs: number;
    telemetryJsonlPath: string | undefined;
    serialEnabled: boolean;
    packDocsEnabled: boolean;
    buildInfoEnabled: boolean;
}

/**
 * The telemetry file from the trimmed setting: empty means off, an absolute
 * path is used as it is, a relative one is resolved against the first
 * workspace folder (off, with a warning, when no folder is open).
 */
function telemetryFile(setting: string): string | undefined {
    const trimmed = setting.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (!firstFolder) {
        logger.warn(`Telemetry off: "${trimmed}" is a relative path and no workspace folder is open to resolve it against`);
        return undefined;
    }
    return path.join(firstFolder.uri.fsPath, trimmed);
}

function readActivationSettings(): ActivationSettings {
    const gates = readPackDocsGates();
    const settings = vscode.workspace.getConfiguration(SECTION);
    return {
        // The fallbacks apply only if a contributed default is missing (timeoutInSeconds contributes 180).
        timeoutInSeconds: settings.get<number>('timeoutInSeconds', 60),
        serverPort: settings.get<number>('serverPort', 3001),
        dapRequestMs: settings.get<number>('dapRequestTimeoutMs', 10000),
        memoryReadMs: settings.get<number>('memoryReadTimeoutMs', 30000),
        telemetryJsonlPath: telemetryFile(settings.get<string>('telemetry.jsonlPath', '')),
        serialEnabled: settings.get<boolean>('serial.enabled', true),
        packDocsEnabled: gates.packDocsEnabled,
        buildInfoEnabled: gates.buildInfoEnabled,
    };
}

function logActivationSettings(active: ActivationSettings): void {
    logger.info(`Operation timeout: ${active.timeoutInSeconds} s`);
    logger.info(`MCP server port: ${active.serverPort}`);
    logger.info(`DAP request timeout: ${active.dapRequestMs} ms`);
    logger.info(`Memory read timeout: ${active.memoryReadMs} ms`);
    if (active.telemetryJsonlPath) {
        logger.info(`Tool-call telemetry file: ${active.telemetryJsonlPath}`);
    }
    if (!active.serialEnabled) {
        logger.info('Serial tools are switched off (serial.enabled)');
    }
    logger.info(`Documentation tools ${active.packDocsEnabled ? 'on' : 'off'}, build-artefact tools ${active.buildInfoEnabled ? 'on' : 'off'}`);
}

/** The standalone "CMSIS Pack Docs" extension would offer the same tool names a second time. */
function warnIfStandalonePackDocsInstalled(): void {
    if (vscode.extensions.getExtension('arm.cmsis-pack-docs') !== undefined) {
        logger.warn(DUPLICATE_PACK_DOCS_NOTICE);
        void vscode.window.showWarningMessage(DUPLICATE_PACK_DOCS_NOTICE);
    }
}

/**
 * Start this window's coordinator and, when that works, offer the router's
 * MCP endpoint to in-editor Copilot. A failure is reported and not retried;
 * the coordinator stays referenced so that `deactivate` still disposes it.
 */
async function startCoordinator(
    extensionContext: vscode.ExtensionContext,
    active: ActivationSettings,
    packDocs: PackDocsHandlers,
    manager: AgentConfigurationManager,
): Promise<void> {
    try {
        logger.info('Starting the window coordinator');
        const started = new WindowCoordinator({
            port: active.serverPort,
            timeoutInSeconds: active.timeoutInSeconds,
            hardwareTimeouts: { dapRequestMs: active.dapRequestMs, memoryReadMs: active.memoryReadMs },
            serverOptions: {
                serialEnabled: active.serialEnabled,
                packDocsEnabled: active.packDocsEnabled,
                buildInfoEnabled: active.buildInfoEnabled,
                telemetry: { jsonlPath: active.telemetryJsonlPath },
            },
            packDocs,
        });
        windowCoordinator = started;
        await started.start(extensionContext);

        // The router's URL in every window: workers send in-editor Copilot through the router too.
        const endpoint = started.getEndpoint();
        manager.updatePort(active.serverPort);
        const router = started.isRouter();
        logger.info(`Window role: ${router ? 'router' : 'worker'}; MCP endpoint ${endpoint}`);
        if (router) {
            void vscode.window.showInformationMessage(`${PRODUCT}: MCP server listening at ${endpoint}`);
        }

        const mcpUri = vscode.Uri.parse(`${endpoint}/mcp`);
        const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
            provideMcpServerDefinitions: () => [new vscode.McpHttpServerDefinition(PRODUCT, mcpUri, undefined, SERVER_VERSION)],
        };
        extensionContext.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider));
        logger.info(`MCP server definition for ${mcpUri.toString()} offered to VS Code`);
    } catch (failure) {
        logger.error('The MCP server could not be started', failure);
        void vscode.window.showErrorMessage(`${PRODUCT} could not start its MCP server: ${String(failure)}`);
    }
}

/** A settings change: skills follow at once, the rest needs a window reload. */
async function onSettingsChanged(
    change: vscode.ConfigurationChangeEvent,
    manager: AgentConfigurationManager,
    packDocs: PackDocsHandlers,
): Promise<void> {
    const touches = (key: string): boolean => change.affectsConfiguration(`${SECTION}.${key}`);
    if (touches('installedSkills') || touches('aiSkills.enabled')) {
        await manager.syncSkills('setting changed');
    }
    if (touches('packDocs')) {
        packDocs.docs.refreshSettings();
    }
    const portChanged = touches('serverPort');
    const gateChanged = touches('packDocs.enabled') || touches('buildInfo.enabled');
    if (!portChanged && !gateChanged) {
        return;
    }
    const answer = await vscode.window.showInformationMessage(portChanged ? PORT_RELOAD_NOTICE : GATES_RELOAD_NOTICE, RELOAD_BUTTON);
    if (answer === RELOAD_BUTTON) {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** The three agent/skill commands; each does nothing without a manager. */
function registerAgentCommands(extensionContext: vscode.ExtensionContext): void {
    extensionContext.subscriptions.push(
        vscode.commands.registerCommand(`${SECTION}.configure`, async () => {
            await agentManager?.runSetupFlow();
        }),
        vscode.commands.registerCommand(`${SECTION}.selectSkills`, async () => {
            await agentManager?.showSkillSelectionDialog();
        }),
        vscode.commands.registerCommand(`${SECTION}.resetPopupState`, async () => {
            if (!agentManager) {
                return;
            }
            await agentManager.resetPopupState();
            void vscode.window.showInformationMessage(`${PRODUCT}: the setup prompt and the skills reminder have been reset.`);
        }),
    );
}

/** Two seconds after activation: the first-run setup when it is due, else the monthly skills prompt. */
async function setupOrSkillsPrompt(manager: AgentConfigurationManager): Promise<void> {
    try {
        if (await manager.shouldShowPopup()) {
            await manager.runSetupFlow();
        } else {
            await manager.maybePromptForSkills();
        }
    } catch (failure) {
        logger.error('The first-run setup or the skills prompt failed', failure);
    }
}

export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
    logger.info(`${PRODUCT} is activating`);
    logger.logSystemInfo();

    const active = readActivationSettings();
    logActivationSettings(active);

    registerSessionStateTracker(extensionContext);
    registerToolchainPackRootInvalidation(extensionContext);
    // A new session may use another device, so the parsed SVD files are dropped when one ends.
    extensionContext.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => clearSvdCache()));

    const manager = new AgentConfigurationManager(extensionContext, active.timeoutInSeconds, active.serverPort);
    agentManager = manager;
    try {
        await manager.syncSkills('activation');
    } catch (failure) {
        logger.error('Installing the agent skills at activation failed', failure);
    }

    // Every window gets the documentation handlers and commands, router or worker.
    const packDocs = createPackDocsHandlers(extensionContext, active.timeoutInSeconds);
    registerPackDocsCommands(extensionContext, packDocs);
    warnIfStandalonePackDocsInstalled();

    await startCoordinator(extensionContext, active, packDocs, manager);

    try {
        await manager.migrateExistingConfigurations();
    } catch (failure) {
        logger.error('Migrating the agent configurations failed', failure);
    }

    extensionContext.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((change) => onSettingsChanged(change, manager, packDocs)),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await manager.syncSkills('workspace folders changed');
        }),
    );
    registerAgentCommands(extensionContext);

    setTimeout(() => setupOrSkillsPrompt(manager), SETUP_DELAY_MS);
    logger.info(`${PRODUCT} activated`);
}

export async function deactivate(): Promise<void> {
    logger.info(`${PRODUCT} is deactivating`);
    const leaving = windowCoordinator;
    if (leaving) {
        try {
            await leaving.dispose();
        } catch (failure) {
            logger.error('Disposing the window coordinator failed', failure);
        }
        windowCoordinator = null;
    }
    logger.info(`${PRODUCT} deactivated`);
}
