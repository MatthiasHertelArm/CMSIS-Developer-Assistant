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

// Minimal `vscode` stub so out/*.js modules that import it can be loaded
// outside the extension host. Only what the unit tests touch is real.
const Module = require('module');
const path = require('path');

/** An event with real listeners: tests may fire it; `vscode.Event` shape. */
function emitter() {
    const listeners = new Set();
    return {
        event: (fn) => { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
        fire: (e) => { for (const l of [...listeners]) { l(e); } },
    };
}

const taskEvents = {
    start: emitter(), processStart: emitter(), processEnd: emitter(), end: emitter(),
};

/** Every status-bar item made through the stub, in creation order; tests read their text and tooltip. */
const statusBarItems = [];

/** A status-bar item that only keeps what is assigned to it. */
function createStatusBarItem(id, alignment, priority) {
    const item = {
        id, alignment, priority, name: undefined, text: '', tooltip: undefined, command: undefined,
        visible: false, disposed: false,
        show() { item.visible = true; },
        hide() { item.visible = false; },
        dispose() { item.disposed = true; item.visible = false; },
    };
    statusBarItems.push(item);
    return item;
}

const stub = {
    Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
    Position: class { constructor(line, ch) { this.line = line; this.character = ch; } },
    Location: class { constructor(uri, range) { this.uri = uri; this.range = { start: range }; } },
    SourceBreakpoint: class {
        constructor(location, enabled, condition, hitCondition, logMessage) {
            Object.assign(this, { location, enabled, condition, hitCondition, logMessage });
        }
    },
    FunctionBreakpoint: class {},
    Breakpoint: class {},
    debug: { breakpoints: [], addBreakpoints() {}, removeBreakpoints() {},
             activeStackItem: undefined, activeDebugSession: undefined,
             onDidChangeActiveStackItem: () => ({ dispose() {} }),
             onDidStartDebugSession: () => ({ dispose() {} }),
             onDidTerminateDebugSession: () => ({ dispose() {} }),
             onDidChangeActiveDebugSession: () => ({ dispose() {} }) },
    window: { activeTextEditor: undefined, showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
              createOutputChannel: () => ({
                  appendLine() {}, append() {}, replace() {}, clear() {}, show() {}, hide() {},
                  dispose() {},
                  // LogOutputChannel surface — the logger calls these directly.
                  trace() {}, debug() {}, info() {}, warn() {},
                  error(...a) { console.error('[ext]', ...a); },
              }),
              createStatusBarItem,
              // Tests install `pickAnswer(items, options)`; without one the pick is dismissed.
              showQuickPick: async (items, options) => (stub.pickAnswer ? stub.pickAnswer(await items, options) : undefined) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    // A theme colour keeps only its id, which tests read back.
    ThemeColor: class { constructor(id) { this.id = id; } },
    statusBarItems,
    pickAnswer: undefined,
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }), workspaceFolders: [],
                 name: undefined,
                 getWorkspaceFolder(uri) {
                     return stub.workspace.workspaceFolders.find((f) => String(uri.fsPath).startsWith(f.uri.fsPath));
                 },
                 onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
                 openTextDocument: async () => { throw new Error('not stubbed'); } },
    extensions: { getExtension: () => undefined },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    // Tests install per-command answers in `commandHandlers`; unknown
    // commands resolve to undefined, as an absent extension would.
    commandHandlers: {},
    commands: {
        executeCommand: async (command, ...args) => stub.commandHandlers[command]?.(...args),
        registerCommand: () => ({ dispose() {} }),
    },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    // No task runs here: the four task events (fired through `taskEvents`),
    // no executions, and no task VS Code could list or run.
    tasks: {
        taskExecutions: [],
        onDidStartTask: taskEvents.start.event,
        onDidStartTaskProcess: taskEvents.processStart.event,
        onDidEndTaskProcess: taskEvents.processEnd.event,
        onDidEndTask: taskEvents.end.event,
        fetchTasks: async () => [],
        executeTask: async () => { throw new Error('tasks are not stubbed'); },
    },
    taskEvents,
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') { return 'vscode'; }
    return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub };

module.exports = stub;
