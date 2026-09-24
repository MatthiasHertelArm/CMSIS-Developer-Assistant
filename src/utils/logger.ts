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
 * The extension's one logging sink: a VS Code log output channel shown in the
 * Output view. Every module logs through the exported `logger`; nothing written
 * here reaches an MCP client.
 *
 * Two filters apply in sequence: this module drops entries below its own
 * minimum level (DEBUG unless `setLogLevel` changes it), and the channel then
 * applies the level the user picked for it in VS Code (Info by default;
 * "Set Log Level…" in the Output view). A debug entry the channel would drop
 * is not even rendered. Only what the user can act on is a warning or an
 * error; routine outcomes — an expected refusal, a fallback taken, a wait
 * that ran out and was answered — are `info` or `debug`.
 *
 * The problem journal (#48) hooks in twice: every `error` entry also goes to
 * the sink `setErrorSink` installs, and `problem` writes the journal's own
 * `[problem #N]` lines at debug level, which never reach that sink.
 */

import * as vscode from 'vscode';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

/** Receives the message and detail of every `error` entry. */
export type ErrorSink = (message: string, detail: unknown) => void;

/** The name users pick in the Output view's channel list. */
const OUTPUT_CHANNEL_NAME = 'CMSIS Developer Assistant';

/** Put on the line after an error's message, in front of its stack. */
const STACK_HEADING = 'Captured stack: ';

/** `vscode.LogLevel.Debug`, as a number, so no enum is read where the API is stubbed. */
const CHANNEL_LEVEL_DEBUG = 2;

/** How much of PATH `logEnvironment` shows. */
const PATH_PREVIEW_CHARS = 200;

/**
 * The text appended after "message: " for a truthy detail. An `Error` gives
 * its message and, when present, its stack; anything else is pretty JSON,
 * or its `String()` form when it cannot be serialised (cycles, BigInt).
 */
function renderDetail(detail: unknown): string {
    if (detail instanceof Error) {
        const stack = typeof detail.stack === 'string' && detail.stack.length > 0
            ? `\n${STACK_HEADING}${detail.stack}`
            : '';
        return detail.message + stack;
    }
    let json: string | undefined;
    try {
        json = JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
    // Functions and symbols serialise to undefined; say so literally.
    return `${json}`;
}

/** An environment variable's value, or the word `undefined` when unset or empty. */
function envValue(name: string): string {
    return process.env[name] || 'undefined';
}

export class Logger {
    private static shared: Logger | undefined;

    private readonly channel: vscode.LogOutputChannel;
    private threshold: LogLevel = LogLevel.DEBUG;
    private errorSink: ErrorSink | undefined;
    /** True while the sink runs, so that an error it logs does not come back to it. */
    private sinking = false;

    private constructor() {
        this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
    }

    static getInstance(): Logger {
        Logger.shared ??= new Logger();
        return Logger.shared;
    }

    debug(message: string, error?: unknown): void {
        this.write(LogLevel.DEBUG, message, error);
    }

    info(message: string, error?: unknown): void {
        this.write(LogLevel.INFO, message, error);
    }

    warn(message: string, error?: unknown): void {
        this.write(LogLevel.WARN, message, error);
    }

    error(message: string, error?: unknown): void {
        this.write(LogLevel.ERROR, message, error);
        const sink = this.errorSink;
        if (!sink || this.sinking) {
            return;
        }
        this.sinking = true;
        try {
            sink(message, error);
        } catch {
            // The sink is a side channel; the entry is written.
        } finally {
            this.sinking = false;
        }
    }

    /** Hands every later `error` entry to `sink` as well; undefined removes it. */
    setErrorSink(sink: ErrorSink | undefined): void {
        this.errorSink = sink;
    }

    /**
     * A line of the problem journal, at debug level whatever its severity:
     * the journal is what agents and "Copy Recent Problems" read, and its
     * mirror shows only when the channel's level is Debug. It never reaches
     * the error sink.
     */
    problem(line: string): void {
        this.write(LogLevel.DEBUG, line, undefined);
    }

    /** Change the minimum level; the confirmation passes the new filter like any entry. */
    setLogLevel(level: LogLevel): void {
        this.threshold = level;
        this.info(`Logging threshold changed to ${LogLevel[level]}`);
    }

    /** One entry per fact about the host, between two banners. Called once at activation. */
    logSystemInfo(): void {
        const facts: Array<[string, string]> = [
            ['VS Code release', vscode.version],
            ['Operating system', process.platform],
            ['Processor architecture', process.arch],
            ['Node.js runtime', process.version],
            ['Extension host PID', String(process.pid)],
        ];
        this.info('==== Extension host details ====');
        for (const [label, value] of facts) {
            this.info(`${label}: ${value}`);
        }
        this.info('==== End of extension host details ====');
    }

    /** The home and profile variables and the start of PATH, between two banners. */
    logEnvironment(): void {
        this.info('==== Selected environment variables ====');
        for (const name of ['HOME', 'USERPROFILE', 'APPDATA']) {
            this.info(`${name}: ${envValue(name)}`);
        }
        // The ellipsis is appended whether or not anything was cut.
        this.info(`PATH: ${envValue('PATH').slice(0, PATH_PREVIEW_CHARS)}...`);
        this.info('==== End of selected environment variables ====');
    }

    /** Whether the channel's own level lets debug entries through; true where it has none (a stub). */
    private channelShowsDebug(): boolean {
        const level = (this.channel as { logLevel?: number }).logLevel;
        return typeof level !== 'number' || level <= CHANNEL_LEVEL_DEBUG;
    }

    /** Reveal the channel in the Output view, taking focus. */
    show(): void {
        this.channel.show();
    }

    private write(level: LogLevel, message: string, detail: unknown): void {
        if (level < this.threshold || (level === LogLevel.DEBUG && !this.channelShowsDebug())) {
            return;
        }
        const entry = detail ? `${message}: ${renderDetail(detail)}` : message;
        switch (level) {
            case LogLevel.DEBUG:
                this.channel.debug(entry);
                break;
            case LogLevel.INFO:
                this.channel.info(entry);
                break;
            case LogLevel.WARN:
                this.channel.warn(entry);
                break;
            case LogLevel.ERROR:
                this.channel.error(entry);
                break;
        }
    }
}

export const logger: Logger = Logger.getInstance();
