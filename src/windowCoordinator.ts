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

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ControlServer, OpPhase, OpRun, WindowFacts } from './controlServer';
import { DebugMCPServer, DebugMCPServerOptions, PortInUseError, SessionHandlers } from './debugMCPServer';
import { DebuggingExecutor, ConfigurationManager, DebuggingHandler } from '.';
import { HardwareTimeouts, SERVER_VERSION } from './debuggingExecutor';
import { RoutingDebuggingHandler } from './routingDebuggingHandler';
import type { PackDocsHandlers } from './packDocsDispatch';
import { WindowRole, WorkspaceRegistry } from './utils/workspaceRegistry';
import { CHANNEL_TIMINGS, ChannelTimings, OpName, forwardTimeoutMs } from './core/opTable';
import { problemJournal, type ProblemJournal } from './core/problemJournal';
import { serialController } from './core/serialController';
import { serialMonitorBridge } from './core/serialMonitorBridge';
import { LagMonitor, NoticeGate, secondsText } from './core/windowHealth';
import { toolNameOf } from './core/windowStatus';
import { logger } from './utils/logger';
import { notifyWarning } from './utils/notify';
import { WindowStatus } from './windowStatus';

/** Refresh well inside the registry's 60 s staleness window. */
const HEARTBEAT_MS = 20_000;

/** Prefix of the notifications this window shows. */
const PRODUCT = 'CMSIS Developer Assistant';

/** How often a worker re-tries the router port after the router disappears. */
const PROMOTION_POLL_MS = 10_000;

/** At most one notice per tool in this time when calls outlive their fence (#14). */
const FENCE_NOTICE_EVERY_MS = 10 * 60_000;

/** The notices' button that opens the output channel. */
const SHOW_LOG = 'Show Log';

/** Shows a warning with buttons and resolves with the one chosen: `notifyWarning`, or a test's stand-in. */
export type WarningNotifier = (message: string, ...items: string[]) => Thenable<string | undefined> | undefined;

export interface CoordinatorOptions {
    port: number;
    timeoutInSeconds: number;
    hardwareTimeouts: Partial<HardwareTimeouts>;
    /**
     * Registry to publish into. Injectable so a test can stand up several
     * coordinators against one temporary directory with distinct identities,
     * which is what two real windows look like.
     */
    registry?: WorkspaceRegistry;
    /**
     * Passed through to the `DebugMCPServer` this window builds when it wins
     * the router port. Resolved from settings once at activation; see
     * `DebugMCPServerOptions` for why it is fixed per instance.
     */
    serverOptions?: DebugMCPServerOptions;
    /**
     * This window's documentation / build-artefact handlers. Every window
     * gets a pair (they are lazy until a call arrives), so a forwarded op
     * always finds them on the worker side; the `packDocsEnabled` /
     * `buildInfoEnabled` server options decide whether the router offers the
     * tools at all.
     */
    packDocs?: PackDocsHandlers;
    /**
     * Release this window's serial backends on dispose. Every window may own
     * a serial port (serial ops run in the window the router forwards to),
     * so the teardown lives here, not in the router-only MCP server.
     * Injectable for tests; bounded to two seconds so a wedged tty cannot
     * hold `deactivate`.
     */
    serialTeardown?: () => Promise<void>;
    /**
     * This window's problem journal (#48), which its control server and
     * debugging handler use; the window's own by default. Injectable so a
     * test can tell two windows in one process apart.
     */
    journal?: ProblemJournal;
    /**
     * The control channel's timings (#14): the router's budgets and health
     * checks, and this window's fences. `CHANNEL_TIMINGS` by default; the
     * transport tests shorten them.
     */
    timings?: Partial<ChannelTimings>;
    /** How this window shows its warnings; `notifyWarning` by default, which journals them too. */
    notify?: WarningNotifier;
}

const SERIAL_TEARDOWN_MS = 2_000;

async function defaultSerialTeardown(): Promise<void> {
    await serialController.close();
    serialMonitorBridge.unsubscribe();
}

/**
 * Decides whether this window serves MCP (router) or only executes work
 * forwarded to it (worker), and keeps the shared registry current.
 *
 * Exactly one window binds the well-known port, so agents outside VS Code have
 * one stable URL that reaches every window. Every window — router included —
 * runs a ControlServer, because the router still has to be able to execute work
 * in *itself* through the same path as anywhere else.
 *
 * Once started, the window also shows its role in the status bar, and the
 * item's click chooses the default target window (#16).
 *
 * The control channel is watched from both ends (#14): the control server
 * fences each op inside the budget the router names, and the coordinator
 * tells the user, at most once per tool in ten minutes, when a call outlived
 * its fence here; the routers of this window share one record of when each
 * window last answered, and ask a quiet one for its health first.
 */
export class WindowCoordinator {
    private readonly registry: WorkspaceRegistry;
    private readonly controlToken = randomUUID();
    private readonly localHandler: DebuggingHandler;
    private readonly journal: ProblemJournal;
    private readonly timings: ChannelTimings;
    private readonly notify: WarningNotifier;
    /** When each window last answered this window's routers, by pid (#14). */
    private readonly heard = new Map<number, number>();
    /** One notice per tool in ten minutes when a call outlives its fence (#14). */
    private readonly fenceNotices = new NoticeGate(FENCE_NOTICE_EVERY_MS);

    private controlServer: ControlServer | undefined;
    private mcpServer: DebugMCPServer | undefined;
    private status: WindowStatus | undefined;
    private lag: LagMonitor | undefined;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private promotionTimer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;

    constructor(private readonly options: CoordinatorOptions) {
        this.notify = options.notify ?? notifyWarning;
        this.registry = options.registry ?? new WorkspaceRegistry(undefined, undefined, undefined, {
            onRefused: (message) => void this.notify(`${PRODUCT}: ${message}`),
        });
        this.journal = options.journal ?? problemJournal();
        this.timings = { ...CHANNEL_TIMINGS, ...options.timings };
        const executor = new DebuggingExecutor(options.hardwareTimeouts);
        const configManager = new ConfigurationManager();
        this.localHandler = new DebuggingHandler(executor, configManager, options.timeoutInSeconds, this.journal);
    }

    /** True when this window owns the well-known port. */
    public isRouter(): boolean {
        return this.mcpServer !== undefined;
    }

    /** What this window does in the routing, as the registry and the status bar say it. */
    public role(): WindowRole {
        return this.isRouter() ? 'router' : 'worker';
    }

    /**
     * The URL agents should use — always the router's, in every window.
     *
     * A worker deliberately advertises the router's port rather than its own
     * control port. In-window Copilot then goes through the same routing as
     * every external agent, so both agree on which window owns the board.
     */
    public getEndpoint(): string {
        return `http://localhost:${this.options.port}`;
    }

    public async start(context: vscode.ExtensionContext): Promise<void> {
        this.lag = new LagMonitor();
        this.controlServer = new ControlServer(this.localHandler, this.controlToken, this.options.packDocs, this.journal, {
            // A router of 2.5.0 names no budget; this window's own router would allow this much.
            defaultBudgetMs: (op, args) => forwardTimeoutMs(op, args, this.options.timeoutInSeconds * 1000, this.forwardTimings()),
            fenceMarginMs: this.timings.fenceMarginMs,
            minFenceMs: this.timings.minFenceMs,
            facts: () => this.facts(),
        });
        this.controlServer.onOp((op, phase, run) => this.noteOp(op, phase, run));
        await this.controlServer.start();

        this.publish();
        this.heartbeat = setInterval(() => {
            this.registry.heartbeat();
            // The lag the health reply shows is that since the last heartbeat.
            this.lag?.reset();
            // Another window may have chosen a new default target since.
            this.status?.reloadDefault();
        }, HEARTBEAT_MS);

        // Debug-session state is the routing signal for every tool that has no
        // file path, so republish the moment it changes rather than waiting for
        // the next heartbeat.
        context.subscriptions.push(
            vscode.debug.onDidStartDebugSession(() => this.publish()),
            vscode.debug.onDidTerminateDebugSession(() => this.publish()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.publish()),
        );

        await this.tryBecomeRouter();
        this.showStatus();
    }

    /**
     * The Select Target Window command of this window: the quick pick that
     * saves the default target. Before `start()` there is nothing to choose
     * from, and the user is told so.
     */
    public async selectTargetWindow(): Promise<void> {
        if (this.status === undefined) {
            void vscode.window.showInformationMessage(`${PRODUCT}: this window has not joined the window registry, so there is no target window to choose.`);
            return;
        }
        await this.status.chooseTarget();
    }

    /** Attempt the router port; on failure stay a worker and keep watching. */
    public async tryBecomeRouter(): Promise<void> {
        if (this.disposed || this.mcpServer) { return; }

        const server = new DebugMCPServer(
            this.options.port,
            this.options.timeoutInSeconds,
            this.options.hardwareTimeouts,
            () => this.sessionHandlers(),
            this.options.serverOptions,
        );

        try {
            await server.initialize();
            await server.start();
            this.mcpServer = server;
            this.stopPromotionPolling();
            logger.info(`This window is the CMSIS Developer Assistant router on ${this.getEndpoint()}`);
        } catch (error) {
            // Whatever start() managed to set up is released (a no-op when
            // the port bind itself failed).
            await server.stop().catch(() => undefined);
            if (error instanceof PortInUseError) {
                logger.info('Another window is the router; this window is a worker.');
                this.startPromotionPolling();
                return;
            }
            throw error;
        }
        // The role is part of the registry entry and of the status bar.
        this.publish();
        this.status?.render();
    }

    /**
     * Watch for the router going away.
     *
     * When the router window closes, its port frees up and some worker must
     * take it or the agents' single URL goes dead. Whoever wins the bind first
     * becomes the new router; the rest keep polling and keep losing, which is
     * harmless.
     */
    private startPromotionPolling(): void {
        if (this.promotionTimer || this.disposed) { return; }
        this.promotionTimer = setInterval(() => {
            this.tryBecomeRouter().catch((err) => logger.warn(`Router promotion attempt failed: ${err}`));
        }, PROMOTION_POLL_MS);
    }

    private stopPromotionPolling(): void {
        if (this.promotionTimer) {
            clearInterval(this.promotionTimer);
            this.promotionTimer = undefined;
        }
    }

    /**
     * Put this window's item into the status bar; the control server's op
     * hook feeds it (`noteOp`). A status bar that cannot be shown costs the
     * window nothing else: the failure is logged and routing goes on.
     */
    private showStatus(): void {
        if (this.disposed || this.status !== undefined || this.controlServer === undefined) { return; }
        try {
            this.status = new WindowStatus({
                registry: this.registry,
                role: () => this.role(),
                endpoint: () => `${this.getEndpoint()}/mcp`,
                sessions: () => this.mcpServer?.describeSessions(),
            });
        } catch (error) {
            logger.warn('The window status bar item could not be shown', error);
        }
    }

    /** The control server's op hook: the status bar hears every phase, the user a call past its fence (#14). */
    private noteOp(op: OpName, phase: OpPhase, run: OpRun): void {
        try {
            this.status?.noteOp(op, phase, run.ticket);
        } catch (error) {
            logger.warn(`The status bar item could not show ${op} ${phase}`, error);
        }
        if (phase === 'fenced') {
            this.noticeFence(op, run.ranMs);
        }
    }

    /**
     * Tell the user that an agent call has waited here past its fence, at
     * most once per tool in ten minutes: often it waits for a picker or a
     * dialog that only the user can answer. The notice is journaled too.
     */
    private noticeFence(op: OpName, ranMs: number): void {
        const tool = toolNameOf(op);
        if (this.disposed || !this.fenceNotices.allow(tool, Date.now())) {
            return;
        }
        const message = `${PRODUCT}: an agent's ${tool} has been waiting ${secondsText(ranMs)} in this window; `
            + 'the agent was told it timed out. A picker or dialog here may be waiting for you.';
        this.warn(message);
    }

    /** Show a warning with the Show Log button; a notifier that fails or answers nothing is fine. */
    private warn(message: string): void {
        try {
            void Promise.resolve(this.notify(message, SHOW_LOG)).then((choice) => {
                if (choice === SHOW_LOG) {
                    logger.show();
                }
            }, () => undefined);
        } catch (error) {
            logger.warn('Could not show a warning', error);
        }
    }

    /** What this window's control server says about it in `health` and its fence's message (#14). */
    private facts(): WindowFacts {
        return {
            pid: this.registry.ownPid(),
            // A window without a workspace is named by its pid alone.
            name: vscode.workspace.name,
            role: this.role(),
            version: SERVER_VERSION,
            lagMs: this.lag?.read(),
        };
    }

    /** The router's budget timings, from this window's channel timings. */
    private forwardTimings(): { marginMs: number; slowFloorMs: number } {
        return { marginMs: this.timings.forwardMarginMs, slowFloorMs: this.timings.slowFloorMs };
    }

    /**
     * Handlers for one MCP session.
     *
     * Always the routing handler, even in the router's own window. Routing to
     * yourself is one loopback hop and keeps a single code path — a "run it
     * locally if the target is me" shortcut would be a second path that only
     * the router exercises, and so the one that rots. When the session ends,
     * the router tells the windows it forwarded to (#49).
     */
    private sessionHandlers(): SessionHandlers {
        const router = new RoutingDebuggingHandler(this.registry, this.options.timeoutInSeconds * 1000, {
            forward: this.forwardTimings(),
            quietMs: this.timings.quietMs,
            healthTimeoutMs: this.timings.healthTimeoutMs,
            watchdogEveryMs: this.timings.watchdogEveryMs,
            heard: this.heard,
        });
        return {
            debug: router,
            serial: (op, args) => router.serialOp(op, args),
            packDocs: (op, args) => router.packDocsOp(op, args),
            ended: (sessionId) => router.sessionEnded(sessionId),
        };
    }

    /**
     * Write this window's current state into the shared registry.
     *
     * Public because debug-session state is a routing input, not just a display
     * detail: until this runs, other windows still believe this one is idle.
     */
    public publish(): void {
        if (this.disposed || !this.controlServer) { return; }

        const session = vscode.debug.activeDebugSession;
        this.registry.register({
            controlPort: this.controlServer.getPort(),
            controlToken: this.controlToken,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
            name: vscode.workspace.name ?? '(no workspace)',
            hasActiveSession: !!session,
            activeConfigurationName: session?.configuration?.name,
            cmsisProject: this.cmsisProjectPath(),
            role: this.role(),
        });
    }

    /**
     * Best-effort path of the CMSIS solution in this window, for the window
     * listing. Never throws: the CMSIS Solution extension may not be installed,
     * and this is a display detail, not a routing decision.
     */
    private cmsisProjectPath(): string | undefined {
        try {
            const ext = vscode.extensions.getExtension('Arm.cmsis-csolution');
            if (!ext?.isActive) { return undefined; }
            const solution = (ext.exports as { activeSolution?: unknown } | undefined)?.activeSolution;
            if (typeof solution === 'string') { return solution; }
            const asRecord = solution as Record<string, any> | undefined;
            return asRecord?.fsPath ?? asRecord?.path ?? undefined;
        } catch {
            return undefined;
        }
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        this.stopPromotionPolling();
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }
        this.controlServer?.onOp(undefined);
        this.status?.dispose();
        this.status = undefined;
        this.lag?.dispose();
        this.lag = undefined;
        // Unregister before stopping the servers so no other window can pick
        // this entry up and try to forward into a closing extension host.
        this.registry.unregister();
        if (this.mcpServer) {
            await this.mcpServer.stop().catch(err => logger.error('Error stopping MCP server', err));
            this.mcpServer = undefined;
        }
        if (this.controlServer) {
            await this.controlServer.stop().catch(err => logger.error('Error stopping control server', err));
            this.controlServer = undefined;
        }
        const teardown = this.options.serialTeardown ?? defaultSerialTeardown;
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, SERIAL_TEARDOWN_MS); });
        try {
            await Promise.race([teardown(), bound]);
        } catch (err) {
            logger.warn(`Failed to clean up serial backends on shutdown: ${err}`);
        } finally {
            if (timer) { clearTimeout(timer); }
        }
    }
}
