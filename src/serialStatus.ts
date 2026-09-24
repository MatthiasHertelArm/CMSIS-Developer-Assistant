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
 * The user's handle on a serial port an agent holds (#49). Nothing in VS Code
 * said who held a port the Serial Monitor could not open. While the window's
 * owned port is held, a status-bar item of its own shows it — next to, and
 * apart from, the window's role item (#16) — and its click runs Release
 * Serial Port, which releases the port with the reason `user`. The item
 * exists only while a port is held; a five-second tick keeps the idle time
 * in its tooltip current. The texts come from src/core/serialText.ts.
 */

import * as vscode from 'vscode';
import { SerialController, serialController } from './core/serialController';
import { renderSerialHold, SerialHoldView } from './core/serialText';

/** The command behind the item's click; contributed in package.json. */
export const RELEASE_SERIAL_PORT_COMMAND = 'cmsis-developer-assistant.releaseSerialPort';

const PRODUCT = 'CMSIS Developer Assistant';
const STATUS_ITEM_ID = 'cmsis-developer-assistant.serial';
/** Just right of the window's role item, which has 100. */
const STATUS_PRIORITY = 99;
/** How often the times in the tooltip are brought up to date. */
const TICK_MS = 5_000;

/** The status-bar item of the window's held serial port. */
export class SerialStatus implements vscode.Disposable {
    private item: vscode.StatusBarItem | undefined;
    private ticker: ReturnType<typeof setInterval> | undefined;
    private shown: SerialHoldView | undefined;
    private readonly listening: { dispose(): void };

    constructor(private readonly controller: SerialController, private readonly now: () => number = Date.now) {
        this.listening = controller.onDidChange(() => this.render());
        this.render();
    }

    /** What the item shows now; undefined while no port is held and the item is hidden. */
    view(): SerialHoldView | undefined {
        return this.shown;
    }

    /** Bring the item up to date: shown with the held port, hidden without one. */
    render(): void {
        const hold = this.controller.hold();
        if (hold === undefined) {
            this.hide();
            return;
        }
        const view = renderSerialHold(hold, this.now());
        const item = this.item ?? this.create();
        if (this.shown?.text !== view.text) {
            item.text = view.text;
        }
        if (this.shown?.tooltip !== view.tooltip) {
            item.tooltip = view.tooltip;
        }
        this.shown = view;
        item.show();
        if (this.ticker === undefined) {
            this.ticker = setInterval(() => this.render(), TICK_MS);
            // A tick is never a reason to keep a process alive.
            this.ticker.unref();
        }
    }

    dispose(): void {
        this.listening.dispose();
        this.hide();
        this.item?.dispose();
        this.item = undefined;
    }

    private create(): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(STATUS_ITEM_ID, vscode.StatusBarAlignment.Right, STATUS_PRIORITY);
        item.name = `${PRODUCT}: serial port`;
        item.command = RELEASE_SERIAL_PORT_COMMAND;
        this.item = item;
        return item;
    }

    private hide(): void {
        this.item?.hide();
        this.shown = undefined;
        if (this.ticker !== undefined) {
            clearInterval(this.ticker);
            this.ticker = undefined;
        }
    }
}

/**
 * Release Serial Port: the user takes the port back from the agent, whatever
 * its rule. Confirms with an information message; the path released, if any.
 */
export function releaseSerialPort(controller: SerialController = serialController): string | undefined {
    const released = controller.releaseForUser();
    void vscode.window.showInformationMessage(released
        ? `${PRODUCT}: ${released} released. The agent is told when it next uses the port.`
        : `${PRODUCT}: no agent holds a serial port in this window.`);
    return released;
}

/** At activation, in every window: the item and the command. */
export function registerSerialHandle(context: vscode.ExtensionContext, controller: SerialController = serialController): void {
    context.subscriptions.push(
        new SerialStatus(controller),
        vscode.commands.registerCommand(RELEASE_SERIAL_PORT_COMMAND, () => releaseSerialPort(controller)),
    );
}
