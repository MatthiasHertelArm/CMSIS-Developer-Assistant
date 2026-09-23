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
 * What the debugging handler takes from its surroundings apart from the
 * executor: a clock, VS Code's focused stack frame, task process events and
 * the workspace folders.
 *
 * The default reads VS Code at the moment of each call, never at load time,
 * so the transport harness can swap parts of its `vscode` stub between
 * scenarios. Unit tests hand the handler their own host instead: a scaled
 * clock turns a 60 s fence or an 8 s session wait into milliseconds, and a
 * task end can be fired by hand.
 */

import * as vscode from 'vscode';

/** The two task events the CMSIS task waiter listens to (`vscode.tasks` has both). */
export interface TaskFeed {
    onDidStartTaskProcess: vscode.Event<vscode.TaskProcessStartEvent>;
    onDidEndTaskProcess: vscode.Event<vscode.TaskProcessEndEvent>;
}

export interface HandlerHost {
    /** Milliseconds on the handler's clock. */
    now(): number;
    /** Resolves after `ms` on that clock. */
    sleep(ms: number): Promise<void>;
    /** Calls `fire` once after `ms`; the returned function cancels it. */
    startTimer(ms: number, fire: () => void): () => void;
    /** The frame id of the focused stack item when that item is a frame (not a thread). */
    focusedFrameId(): number | undefined;
    /** Task process events. Only the build-class CMSIS actions ask for them. */
    taskFeed(): TaskFeed;
    /** The open workspace folders, in VS Code's order. */
    workspaceFolders(): readonly vscode.WorkspaceFolder[];
    /** `vscode.workspace.findFiles`. */
    findFiles(include: string, exclude: string, maxResults: number): Thenable<vscode.Uri[]>;
}

/** The real thing: Node timers and the VS Code API, looked up per call. */
export const VSCODE_HOST: HandlerHost = {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((wake) => {
        setTimeout(wake, ms);
    }),
    startTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
    },
    focusedFrameId: () => {
        const item = vscode.debug.activeStackItem;
        return item !== undefined && 'frameId' in item ? item.frameId : undefined;
    },
    taskFeed: () => vscode.tasks,
    workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
    findFiles: (include, exclude, maxResults) => vscode.workspace.findFiles(include, exclude, maxResults),
};
