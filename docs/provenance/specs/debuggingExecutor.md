# Spec: src/debuggingExecutor.ts

`src/debuggingExecutor.ts` is the only layer that talks to VS Code's debug API and, through `DebugSession.customRequest`, to the Debug Adapter Protocol (DAP) of the active debug session. `DebuggingHandler` (`src/debuggingHandler.ts`) calls it for every MCP debug tool: starting and stopping sessions, run control, breakpoints and GDB-native breakpoints and logpoints, stack, threads, variables and expression evaluation, and the Arm Cortex-M reads (memory, core registers, DWT cycle counter, fault status registers, peripheral registers) plus a verified target reset. It returns data or plain strings; the handler turns them into tool results. The module also owns `SERVER_VERSION`, the version string the whole extension reports. The rewrite must be behaviour-neutral: same exports, same DAP requests with the same arguments in the same order, same fallbacks, same timeouts, and the same visible text except the strings marked `[REWORD]`.

## External contract

### Exports and their users

| Export | Kind | Used by |
|---|---|---|
| `DebuggingExecutor` | class | `src/index.ts` (re-export). Constructed in `src/debugMCPServer.ts` (single-window default: `new DebuggingExecutor(hardwareTimeouts)`), `src/windowCoordinator.ts` (`new DebuggingExecutor(options.hardwareTimeouts)`), `test/transport/surface-snapshot.js` and `test/transport/session-lifecycle.js` (`new DebuggingExecutor()` from `out/src/index.js`, under `test/transport/vscode-stub.js`) |
| `IDebuggingExecutor` | interface | `src/debuggingHandler.ts` (constructor parameter), `src/index.ts` (re-export), `src/test/debuggingHandler.test.ts` (a partial fake cast to it) |
| `HardwareTimeouts` | interface | `src/debugMCPServer.ts` and `src/windowCoordinator.ts` (as `Partial<HardwareTimeouts>`) |
| `SERVER_VERSION` | `const string` | `src/debugMCPServer.ts` (MCP `initialize` `serverInfo.version`), `src/extension.ts` (version of the `McpHttpServerDefinition`), `src/packDocsHost.ts` (HTTP user agent `cmsis-developer-assistant/<version>`), and `getDiagnostics()` in this file |
| `DEFAULT_HARDWARE_TIMEOUTS` | `const HardwareTimeouts` | no importer today; keep the export |
| `SessionState`, `SessionStatus` | type, interface | no importer; the handler consumes the shape structurally |
| `DapThread` | interface | no importer; handler consumes structurally |
| `ResetOutcome` | interface | no importer; structurally identical to `ResetOutcomeView` in `src/core/resetAssist.ts`, which `renderResetOutcome` takes |
| `ExecutorDiagnostics` | interface | no importer; handler consumes structurally |

All ten names stay exported from the module path `src/debuggingExecutor.ts` (compiled `out/src/debuggingExecutor.js`). They may be declared in other new modules and re-exported. Parameter names, member order and doc comments are not part of the contract. Member names, parameter order, optionality, parameter types and return types are.

### Exported types and constants

```ts
export interface HardwareTimeouts {
    dapRequestMs: number;
    memoryReadMs: number;
}
export const DEFAULT_HARDWARE_TIMEOUTS: HardwareTimeouts; // { dapRequestMs: 10000, memoryReadMs: 30000 }
export const SERVER_VERSION: string;                       // '2.3.10' today

export type SessionState = 'no-session' | 'initializing' | 'running' | 'stopped' | 'unresponsive';
export interface SessionStatus {
    state: SessionState;
    sessionName: string | null;
    sessionType: string | null;
    configurationName: string | null;
    dapResponsive: boolean;
    dapProbeMs: number | null;
    detail?: string;
}
export interface DapThread {
    id: number;
    name: string;
    topFrame?: StackFrame;             // StackFrame from src/debugState.ts
}
export interface ResetOutcome {
    serverKind: GdbServerKind;         // from src/core/resetAssist.ts
    methodsTried: ResetMethod[];       // from src/core/resetAssist.ts
    commandsIssued: string[];
    replies: string[];
    verified: boolean;
    verificationDetail: string;
    haltedByUs: boolean;
    resumed: boolean;
}
export interface ExecutorDiagnostics {
    serverVersion: string;
    liveSessionCount: number;
    liveSessionNames: string[];
    hasVscodeActiveSession: boolean;
}
```

`SERVER_VERSION` equals the `version` in `package.json` (2.3.10 on this branch). The release recipe edits the literal in `src/debuggingExecutor.ts` together with `npm version`, so the literal stays in this file. `test/transport/surface.snapshot.json` pins it through the `get_session_status` text (`serverVersion=2.3.10`) and the `cmsis_action` no-solution text. The rewrite does not change its value.

### IDebuggingExecutor

```ts
export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: vscode.DebugConfiguration): Promise<boolean>;
    startDebuggingByName(workingDirectory: string, configurationName: string): Promise<boolean>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(timeoutMs?: number): Promise<void>;
    stepInto(timeoutMs?: number): Promise<void>;
    stepOut(timeoutMs?: number): Promise<void>;
    continue(timeoutMs?: number): Promise<void>;
    pause(timeoutMs?: number): Promise<void>;
    waitForStop(timeoutMs?: number): Promise<StopWaitResult | { kind: 'already-stopped'; reason: string | null }>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number, options?: { condition?: string; logMessage?: string }): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    setBreakpointViaGdb(fileFullPath: string, line: number, timeoutMs?: number, condition?: string): Promise<string>;
    setLogpointViaGdb(fileFullPath: string, line: number, format: string, args: string[], timeoutMs?: number): Promise<string>;
    setBreakpointConditionViaGdb(breakpointNumber: number, condition: string, timeoutMs?: number): Promise<string>;
    clearBreakpointViaGdb(fileFullPath: string, line: number, timeoutMs?: number): Promise<string>;
    clearAllBreakpointsViaGdb(timeoutMs?: number): Promise<string>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any>;
    evaluateExpression(expression: string, frameId: number, timeoutMs?: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    readMemory(address: string, length: number, timeoutMs?: number): Promise<Buffer>;
    readMemoryWord(address: string, timeoutMs?: number): Promise<number>;
    writeMemoryWord(address: string, value: number, timeoutMs?: number): Promise<void>;
    resetTarget(options: { method?: 'auto' | ResetMethod; halt?: boolean; timeoutMs?: number }): Promise<ResetOutcome>;
    readCoreRegisters(timeoutMs?: number, names?: string[]): Promise<Record<string, string>>;
    readCycleCounter(timeoutMs?: number): Promise<{ cycles: number; enabledNow: boolean; present: boolean }>;
    readPeripheralRegister(peripheral: string, register?: string, timeoutMs?: number): Promise<string>;
    getFaultInfo(timeoutMs?: number): Promise<string>;
    readFaultRegisters(timeoutMs?: number): Promise<FaultRegisters>;
    readExceptionFrame(stackPointer: number, timeoutMs?: number): Promise<Buffer>;
    getDeviceInfo(): Promise<string>;
    checkTargetConnection(): Promise<string>;
    hasDebugSession(): boolean;
    getSessionStatus(): Promise<SessionStatus>;
    getDiagnostics(): ExecutorDiagnostics;
    getThreads(timeoutMs?: number): Promise<DapThread[]>;
    getCallStack(threadId?: number, levels?: number, timeoutMs?: number): Promise<StackFrame[]>;
    getVariablesForFrame(frameId: number, scope?: 'local' | 'global' | 'all', timeoutMs?: number): Promise<any>;
    armStopWaiter(timeoutMs: number): Promise<StopWaitResult>;
}
```

`StopWaitResult` comes from `src/utils/sessionStateTracker.ts`, `FaultRegisters` from `src/core/faultDecoder.ts`, `DebugState` and `StackFrame` from `src/debugState.ts`. The class `DebuggingExecutor` implements the interface and has a constructor `(timeouts?: Partial<HardwareTimeouts>)`. On the class, `getCurrentDebugState`'s parameter defaults to 3 and `getCallStack`'s `levels` defaults to 50.

### Methods the handler calls

`DebuggingHandler` calls every method except `readMemoryWord`, `writeMemoryWord` and `getActiveSession`, which are used only inside this file (or not at all) but stay in the interface. The handler relies on these facts about the executor:

- `hasDebugSession()` is synchronous and issues no DAP traffic.
- `armStopWaiter()` is not `async`: with no session it throws synchronously, before the handler issues the execution request.
- `getSessionStatus()` and `checkTargetConnection()` never reject.
- Errors are `Error` objects (the handler renders `err.message`, or the error through `${error}`). `HardwareTimeoutError` from `src/utils/timeout.ts` keeps its class where this spec says it propagates, because `handleCheckTargetConnection` and others test `instanceof HardwareTimeoutError`.
- `readCoreRegisters` values are GDB strings or the placeholders `<timeout>` / `<unavailable>`; the handler treats a leading `<` as "no value".

### Other modules this file relies on

- `src/utils/sessionStateTracker.ts` (Arm): `resolveActiveSession`, `isSessionStopped`, `getStoppedReason`, `getLiveSessionCount`, `getLiveSessionNames`, `waitForStopEvent` (never rejects; clamps its timeout to 100–60 000 ms), type `StopWaitResult`.
- `src/utils/timeout.ts` (Arm): `customRequestWithTimeout(session, command, args, ms)` (timeout label `DAP <command>`), `withTimeout(label, ms, task)`, `HardwareTimeoutError`.
- `src/core/resetAssist.ts` (Arm): `buildResetCommands`, `detectGdbServerKind`, `replyLooksUnsupported`, `unsupportedResetDetail`, types `GdbServerKind`, `ResetMethod`.
- `src/core/dwt.ts` (Arm): `DWT_ADDRESSES` (`DEMCR` `'0xE000EDFC'`, `DWT_CTRL` `'0xE0001000'`, `DWT_CYCCNT` `'0xE0001004'`), `DEMCR_TRCENA` (bit 24), `DWT_CTRL_CYCCNTENA` (bit 0), `DWT_CTRL_NOCYCCNT` (bit 28).
- `src/core/faultDecoder.ts` (Arm): `FAULT_REGISTER_ADDRESSES` (CFSR `'0xE000ED28'` … AFSR `'0xE000ED3C'`), `FAULT_REGISTER_BLOCK` (`'0xE000ED28'`, 24 bytes), `faultRegistersFromBlock`, `decodeFaultRegisters`, type `FaultRegisters`.
- `src/core/peripheralReader.ts` (Arm): `tryReadPeripheralViaExtension(peripheral, register?)`, `readPeripheralViaMemory(session, peripheral, register?, frameId?, dapTimeoutMs?)`.
- `src/debugState.ts`: class `DebugState` with public fields `sessionActive`, `configurationName`, `frameId`, `threadId`, `frameName`, `stackTrace`, `fileFullPath`, `fileName`, `currentLine`, `currentLineContent`, `nextLines`, `breakpoints` (defaults: `false`, `null`, empty arrays); interface `StackFrame { name; source?; line?; column?; frameId? }`; `formatBreakpointModifiers(bp)` (returns `''` or a suffix such as `" [when: x > 3]"`).
- `src/utils/logger.ts`: singleton `logger` with `debug`, `info`, `warn`, `error`, each `(message: string, error?: any)`.

## Behaviour

### Conventions used below

- **The session** is `resolveActiveSession()` evaluated at the start of the call: VS Code's focused session, else the most recently started session the tracker saw in this window. "No session" means it returned `undefined`. Unless stated otherwise, a method that needs a session rejects with S1 [REWORD] when there is none, before any DAP traffic.
- **The focused stack item** is `vscode.debug.activeStackItem`. It is not checked against the session.
- **Thread id**: the focused stack item's `threadId` when the item has one (thread or frame), else `1`.
- **Budgets.** `cap(t, fallback)`: when `t` is `undefined`, `null`, not finite, or ≤ 0 → `fallback`; else `min(t, 60000)`. No lower bound.
  - DAP budget: `cap(timeoutMs, dapRequestMs)`.
  - Overall budget: `cap(timeoutMs, memoryReadMs)`.
  - Probe budget: `min(dapRequestMs, 3000)`; no override.
  - Snapshot budget: `dapRequestMs`; no override.
  - Stop-wait budget: `cap(timeoutMs, 60000)`, then clamped by `waitForStopEvent`.
  - When a method passes its DAP budget into another public method as that method's `timeoutMs`, the callee derives both its budgets from that value.
- **DAP request** means `customRequestWithTimeout(session, command, args, budget)`. On expiry it rejects with `HardwareTimeoutError` labelled `DAP <command>`. Argument keys are listed below in the order they are written today.
- **Overall fence** means `withTimeout(label, budget, task)`, which rejects with `HardwareTimeoutError` carrying the label. Labels: `readMemory`, `readCoreRegisters`, `readCycleCounter`, `readPeripheralRegister`, `readFaultRegisters`.
- **Frame lookup** means taking a state snapshot (`getCurrentDebugState` with 0 look-ahead lines) and using its `frameId`. This issues the snapshot's `stackTrace` request whenever the focused stack item is a frame. `frameOpt` is `{ frameId }` when the snapshot has a frame id, else empty: the key is omitted, never sent as `null`.
- **Address normalisation**: an address string starting with `0x` or `0X` is used unchanged; otherwise `0x` is prefixed, so `'20000000'` becomes `'0x20000000'` (always read as hex). No case change, no padding.
- **Wrapping**: "wrapped as X" means the method catches any error and rejects with a new `Error` whose message is X, a colon, a space, and the JavaScript string conversion of the caught value. For an `Error` that is `<name>: <message>`, for example `Error: …`, `TypeError: …` or `HardwareTimeoutError: …`. The wrapper is a plain `Error`, so the timeout class is lost.
- `${name}` in quoted texts marks an interpolated value.

### Construction

- `new DebuggingExecutor(timeouts?)`: the effective timeouts are the defaults `{ dapRequestMs: 10000, memoryReadMs: 30000 }` overlaid with the keys present in `timeouts` (object-spread semantics). No argument means defaults.
- Construction and module load touch no VS Code API. The module must load, and `new DebuggingExecutor()` must succeed, under `test/transport/vscode-stub.js`.
- Callers pass the settings `cmsis-developer-assistant.dapRequestTimeoutMs` (default 10000, minimum 500) and `memoryReadTimeoutMs` (default 30000, minimum 1000) from `src/extension.ts`.

### Session lifecycle

**`startDebugging(workingDirectory, config)`**

- Folder: `vscode.workspace.getWorkspaceFolder(Uri.file(workingDirectory))`, possibly `undefined`, passed through as is.
- Returns the boolean of `vscode.debug.startDebugging(folder, config)`.
- Any error is wrapped as S2 [REWORD].

**`startDebuggingByName(workingDirectory, configurationName)`**

1. Resolve the workspace folder, first match wins:
   1. No open folders → none.
   2. `vscode.workspace.getWorkspaceFolder(Uri.file(workingDirectory))`.
   3. Path match: strip any trailing run of `/` or `\` from `workingDirectory` and from each folder's `uri.fsPath`. In folder order, match when the two are equal, when the directory starts with folder + `/`, or when the folder starts with directory + `/`. Only `/` is a separator here, and the comparison is case-sensitive.
   4. Exactly one open folder → that folder.
   5. Else none.
2. None → throw S4. Its folder list is the open folders' `fsPath`s joined with a comma and a space, or `(none)`.
3. Return the boolean of `vscode.debug.startDebugging(folder, configurationName)`: the name string, so VS Code resolves it from `launch.json`.
4. Any error, including S4, is wrapped as S3.

**`stopDebugging(session?)`**

- Target: the argument when given, else the session. With a target → `vscode.debug.stopDebugging(target)`. Without one → resolve with nothing done.
- Errors are wrapped as S5 [REWORD].

**`restart()`**

- Runs the VS Code command `workbench.action.debug.restart` with no arguments.
- No session check, no timeout; it acts on VS Code's focused session.
- Errors are wrapped as S6 [REWORD]. See KB2.

**`hasDebugSession()`**: synchronous; `true` when there is a session. No DAP traffic.

**`getActiveSession()`**: returns the session or `undefined`.

### Readiness, status and diagnostics

**`hasActiveSession(): Promise<boolean>`**

1. No session → `false`.
2. DAP `threads`, args `{}`, probe budget.
   - Timeout → `logger.warn` L1, then `false`.
   - Other error → `logger.debug` L2 with the error, then `false`.
3. Success → `isSessionStopped(session)`. The threads reply is not inspected.

**`getSessionStatus(): Promise<SessionStatus>`** never rejects.

- No session → exactly `{ state: 'no-session', sessionName: null, sessionType: null, configurationName: null, dapResponsive: false, dapProbeMs: null }`, with no `detail` key.
- Otherwise the base fields are `sessionName: session.name`, `sessionType: session.type ?? null`, `configurationName: session.configuration?.name ?? null`. Take a wall-clock timestamp, then send DAP `threads`, args `{}`, probe budget:
  - Timeout → base + `state: 'unresponsive'`, `dapResponsive: false`, `dapProbeMs: null`, `detail` S25 (with the probe budget in ms).
  - Other error → base + `state: 'initializing'`, `dapResponsive: false`, `dapProbeMs: null`, `detail` S26 (with the error's `message`, or `String(err)` for non-Errors).
  - Success → `dapProbeMs` is the elapsed whole milliseconds; `state` is `'stopped'` when `isSessionStopped(session)`, else `'running'`; `dapResponsive: true`; `detail` is S27 when stopped and `getStoppedReason` is non-null, else `undefined` (key present, value `undefined`).

**`checkTargetConnection(): Promise<string>`** calls `getSessionStatus()` once and never rejects.

- `no-session` → S28, alone.
- Otherwise lines joined with `\n`:
  1. S29 (`type=unknown` when the session type is null).
  2. S30, only when a configuration name exists.
  3. By state:
     - `unresponsive` → S31, then the status `detail` when set.
     - `initializing` → S32, then the `detail` when set.
     - `running` → S33, then S34.
     - `stopped` → S33, then S35. The stop reason is not shown.

**`getDiagnostics(): ExecutorDiagnostics`** is synchronous and sends no DAP traffic.

- `serverVersion`: `SERVER_VERSION`.
- `liveSessionCount`: `getLiveSessionCount()`.
- `liveSessionNames`: `getLiveSessionNames()`.
- `hasVscodeActiveSession`: `vscode.debug.activeDebugSession !== undefined`. This is the one place that reads VS Code's focused session directly.

### Run control

**`stepOver`, `stepInto`, `stepOut`, `continue`, `pause` (each `(timeoutMs?)`)**

| Method | DAP command | UI fallback command |
|---|---|---|
| `stepOver` | `next` | `workbench.action.debug.stepOver` |
| `stepInto` | `stepIn` | `workbench.action.debug.stepInto` |
| `stepOut` | `stepOut` | `workbench.action.debug.stepOut` |
| `continue` | `continue` | `workbench.action.debug.continue` |
| `pause` | `pause` | `workbench.action.debug.pause` |

1. No session → reject S1 [REWORD]; nothing sent.
2. DAP request, args `{ threadId }` (thread id convention), DAP budget. The response body is ignored.
3. `HardwareTimeoutError` → rethrow unchanged.
4. Any other failure → run the UI fallback command with no arguments and resolve. The DAP error is discarded. If the command itself rejects, that rejection propagates unwrapped. See KB1.
5. The method does not wait for a stop; the handler arms `armStopWaiter` first.

**`armStopWaiter(timeoutMs)`** is synchronous, not `async`.

- No session → throws S1 [REWORD] synchronously.
- Else returns `waitForStopEvent(session, cap(timeoutMs, 60000))`. It never reports "already stopped".

**`waitForStop(timeoutMs?)`**

- No session → reject S1 [REWORD].
- `isSessionStopped(session)` → resolve `{ kind: 'already-stopped', reason: getStoppedReason(session) }`.
- Else → `waitForStopEvent(session, cap(timeoutMs, 60000))`.
- Issues no DAP traffic.

### Breakpoints in the VS Code model

**`addBreakpoint(uri, line, options?)`**

- Creates one `vscode.SourceBreakpoint` with:
  - location `new vscode.Location(uri, new vscode.Position(line - 1, 0))`: a Position, not a Range, because the transport stub's `Location` stores its second argument as `range.start`;
  - `enabled` `true`;
  - `condition` `options?.condition`;
  - `hitCondition` `undefined`;
  - `logMessage` `options?.logMessage`.
- Adds it with `vscode.debug.addBreakpoints([bp])`.
- No duplicate check and no session check.
- Errors are wrapped as S7 [REWORD].

**`removeBreakpoint(uri, line)`**

- Selects the entries of `vscode.debug.breakpoints` that are `instanceof vscode.SourceBreakpoint`, whose `location.uri.toString()` equals `uri.toString()` and whose `location.range.start.line === line - 1`.
- Calls `vscode.debug.removeBreakpoints(selected)` only when the selection is non-empty.
- Errors are wrapped as S8 [REWORD].

**`getBreakpoints()`**: returns `vscode.debug.breakpoints` itself, all kinds.

**`clearAllBreakpoints()`**: synchronous. When `vscode.debug.breakpoints` is non-empty, removes all of them (function breakpoints included) in one `removeBreakpoints` call. Errors propagate unwrapped.

### GDB passthrough, breakpoints and logpoints

All GDB-native operations go through one private helper, `gdb(command, timeoutMs?)`, in this order:

1. No session → reject S1 [REWORD].
2. Frame lookup.
3. DAP `evaluate`, args `{ expression: '-exec ' + command, context: 'repl', ...frameOpt }`, DAP budget. See KB3.
4. Success → `raw` is the reply's `result` (or `''` when absent), converted to a string and trimmed; `errored` is false.
5. `HardwareTimeoutError` → rethrow.
6. Any other error → `raw` is the error's `message` (or `String(err)`), trimmed; `errored` is true. The helper does not reject.

The public GDB methods return `raw` only and ignore `errored` (KB4). A missing "Breakpoint N at" echo is not a failure here; the handler classifies the text.

| Method | GDB command sent (after the `-exec` prefix and one space) |
|---|---|
| `setBreakpointViaGdb(file, line, timeoutMs?, condition?)` | `break ${file}:${line}`, followed, when `condition` is non-empty after trimming, by a space, `if`, a space and the trimmed condition |
| `setLogpointViaGdb(file, line, format, args, timeoutMs?)` | `dprintf ${file}:${line},"${format}"`, followed, when `args` is non-empty, by `,` and the arguments joined with `,` |
| `setBreakpointConditionViaGdb(n, condition, timeoutMs?)` | `condition ${n} ${condition}` (condition untrimmed) |
| `clearBreakpointViaGdb(file, line, timeoutMs?)` | `clear ${file}:${line}` |
| `clearAllBreakpointsViaGdb(timeoutMs?)` | `delete` |

Paths and expressions are inserted verbatim: no quoting and no escaping. The handler escapes `format` already. The handler calls these methods without `timeoutMs`, so the DAP budget is `dapRequestMs`.

### State snapshot

**`getCurrentDebugState(numNextLines = 3): Promise<DebugState>`** never rejects in practice. Any failure is logged (L3) and the partly filled state is returned.

1. Start from a fresh `DebugState`.
2. When there is a session:
   1. `sessionActive = true`; `configurationName = session.configuration.name ?? null`.
   2. When the focused stack item has a `frameId`: `frameId` and `threadId` come from it. Then DAP `stackTrace`, args `{ threadId: <that threadId>, startFrame: 0, levels: 50 }`, snapshot budget (the caller's timeout does not apply). The request goes to the session even when the item belongs to another session.
      - Non-empty `stackFrames`: `frameName` = first frame's `name`, or `null` when empty. `stackTrace` = every frame as a `StackFrame`: `name` (or `unknown`, S38), `source` (`source.path`, else `source.name`, else `undefined`), `line` and `column` (each `undefined` when 0 or absent), and no `frameId`.
      - Empty or missing `stackFrames` → frame fields stay at their defaults.
      - Any error, timeouts included → log L4, `frameName = null`, `stackTrace = []`. Nothing rethrown.
   3. The location comes from the DAP top frame, never from the active text editor. When the top frame has a truthy `source.path` and a numeric `line`, open `vscode.workspace.openTextDocument(Uri.file(path))`:
      - `currentLine`: the DAP line, unclamped.
      - `fileFullPath`: the path.
      - `fileName`: the last path segment, split on `/` or `\`, or `''`.
      - `currentLineContent`: the trimmed text of line `clamp(line - 1, 0, lineCount - 1)`.
      - `nextLines`: the next non-empty trimmed lines after it, up to `numNextLines`, stopping at the end of the file.
      - When the document cannot be opened (assembly, ROM, no source) → log L5 and leave the location unset.
3. Always, session or not: `breakpoints` = each `SourceBreakpoint` in `vscode.debug.breakpoints` as `${fileName}:${line}${formatBreakpointModifiers(bp)}`. Here `fileName` is the last segment of `location.uri.fsPath` split on `/` or `\` (or `unknown`, S39) and `line` is `range.start.line + 1`. Other breakpoint kinds are skipped.

When a snapshot is taken only for a frame lookup, today's implementation also opens the top frame's source document and discards the result. That has no visible effect and may be dropped. The `stackTrace` request may not be dropped.

### Stack, threads, variables, evaluate

**`getCallStack(threadId?, levels = 50, timeoutMs?)`**

- No session → reject S1 [REWORD].
- DAP `stackTrace`, args `{ threadId: <given, else the thread id convention>, startFrame: 0, levels }`, DAP budget. Errors, timeouts included, propagate unwrapped.
- Result: `response?.stackFrames ?? []`, each mapped to a `StackFrame`: `name` (or `unknown`), `source` (`path`, else `name`, else `undefined`), `line` and `column` (`undefined` when falsy). `frameId` is set to the frame's `id` only when that is not `undefined`; otherwise the key is absent.

**`getThreads(timeoutMs?)`**

1. No session → reject S1 [REWORD].
2. DAP `threads`, args `{}`, DAP budget. Errors propagate.
3. Result list: for every entry of `response?.threads ?? []`, `{ id, name: t.name ?? 'thread-' + id }` (S37). An empty name stays empty.
4. Top frames for the first 32 threads only, in list order, in batches of 4. The requests of one batch are issued together; the next batch starts when the whole batch has settled.
   - Each request: DAP `stackTrace`, args `{ threadId: t.id, startFrame: 0, levels: 1 }`, DAP budget.
   - The first frame, when present, becomes `topFrame` with the `StackFrame` mapping above, without `frameId`.
   - Any error, timeouts included, leaves that thread without `topFrame`.
5. All threads are returned, including those beyond the first 32.

**`getVariables(frameId, scope?, timeoutMs?)`** and its alias **`getVariablesForFrame(frameId, scope?, timeoutMs?)`**

1. No session → S1 [REWORD], wrapped (step 5).
2. DAP `scopes`, args `{ frameId }`, DAP budget. A missing reply or no scopes → resolve `{ scopes: [] }`.
3. Filter by `name`, lower-cased: `'local'` keeps names containing `local`; `'global'` keeps names containing `global`; `'all'` or `undefined` keeps all.
4. For each kept scope, one at a time in order: DAP `variables`, args `{ variablesReference }`, DAP budget.
   - Success: the scope object gets `variables` = the reply's `variables`, or `[]`.
   - Any error, timeouts included: `variables = []` and `error` = the error message.
   - The scope objects returned by the adapter are extended in place.
5. Resolve `{ scopes: <kept scopes> }`. Any error from steps 1–3 is wrapped as S9 [REWORD].

**`evaluateExpression(expression, frameId, timeoutMs?)`**

- No session → S1 [REWORD], wrapped.
- DAP `evaluate`, args `{ expression, frameId, context: 'repl' }`, DAP budget. The expression is passed verbatim, including an agent's own `-exec …`.
- Resolves the raw reply body unchanged (the handler reads `result` and `type`).
- Any error, timeouts included, is wrapped as S10 [REWORD].

### Memory

**GDB word ladder** (private; `hexAddr`, DAP budget, optional `frameOpt`).

1. Without a `frameOpt`, do a frame lookup first.
2. Try the strategies in order and stop at the first that yields a number. A `HardwareTimeoutError` from any strategy is rethrown at once, with no further strategies tried. Any other error, an empty `result`, or an unparsable one moves to the next strategy.
   1. DAP `evaluate`, args `{ expression: '*(unsigned int*)' + hexAddr, context: 'watch', ...frameOpt }`. Parse the trimmed `result`: when it starts with `0x` or `0X`, as a hex integer, else as a decimal integer. Leading-integer parsing, so trailing text is ignored; NaN means unparsable. See KB15.
   2. DAP `evaluate`, args `{ expression: '-exec x/1xw ' + hexAddr, context: 'repl', ...frameOpt }`. The value is the first hex literal (lower-case `0x` prefix) that directly follows a `:` and optional whitespace; GDB prints `0x20000000:\t0x12345678`.
   3. DAP `evaluate`, args `{ expression: '-exec print/x *(unsigned int*)' + hexAddr, context: 'repl', ...frameOpt }`. The value is the first hex literal (lower-case `0x` prefix) anywhere in `result`; GDB prints `$1 = 0x12345678`.
3. When all three fail → reject S11.

This ladder resembles `readWord` in `src/core/peripheralReader.ts` but is not the same. It has a third strategy, never starts with `readMemory`, and has different error text. The peripheral path keeps using `readWord`, and this ladder keeps its own behaviour.

**`readMemoryWord(address, timeoutMs?)`**

1. No session → reject S1 [REWORD].
2. Normalise the address.
3. DAP `readMemory`, args `{ memoryReference: addr, count: 4 }`, DAP budget. With `data`, return the first 4 decoded (base64) bytes as an unsigned little-endian 32-bit value.
4. `HardwareTimeoutError` → rethrow.
5. Any other failure → the GDB word ladder for `addr` with the DAP budget and no `frameOpt`. Failures here include a rejection, a reply without `data` (internal S14), and fewer than 4 decoded bytes.
6. There is no overall fence.

**`readMemory(address, length, timeoutMs?)`**

1. No session → reject S1 [REWORD], before the fence.
2. Normalise the address. Everything below runs inside the overall fence labelled `readMemory`, with the overall budget.
3. DAP `readMemory`, args `{ memoryReference: addr, count: length }`, DAP budget. With truthy `data`, return the decoded bytes as they are, even when there are fewer than `length` (KB9).
4. No `data` → internal failure S13, which is caught and leads to the fallback like any other non-timeout error.
5. `HardwareTimeoutError` → rethrow.
6. Fallback for any other failure:
   1. One frame lookup. When it finds no frame, the ladder repeats the lookup for each word.
   2. For word `w` from 0 to `ceil(length / 4) - 1`, one after the other: run the GDB word ladder at `addr + 4w`. The addition is arbitrary precision; the address is lower-case hex with `0x` and no padding, and is not wrapped at 2^32. The ladder uses the DAP budget.
   3. Each word contributes 4 bytes, little-endian.
   4. The first word that fails rejects the whole call; no partial result.
   5. Return the first `length` bytes.
   6. An address `BigInt` cannot parse rejects with its `SyntaxError`.

**`writeMemoryWord(address, value, timeoutMs?)`**

1. No session → reject S1 [REWORD].
2. Normalise the address.
3. DAP `writeMemory`, args `{ memoryReference: addr, data: <base64 of the 4 little-endian bytes of value >>> 0> }`, DAP budget. The reply is ignored.
4. `HardwareTimeoutError` → rethrow.
5. Any other error → GDB passthrough `set {unsigned int}${addr} = ${value >>> 0}`, the value in decimal, with the DAP budget. The reply is ignored completely.
6. Read back with `readMemoryWord(addr, <DAP budget>)`. When `readBack >>> 0 !== value >>> 0` → reject S12, both values as 8-digit lower-case hex.

**`readExceptionFrame(stackPointer, timeoutMs?)`** calls `readMemory('0x' + (stackPointer >>> 0) in lower-case hex without padding, 32, <DAP budget>)`. The nested call's overall budget therefore equals the DAP budget.

### Core registers

**`readCoreRegisters(timeoutMs?, names?)`**

1. No session → reject S1 [REWORD].
2. Register list: `names` when non-empty, else these 23, in this order:

   ```text
   r0 r1 r2 r3 r4 r5 r6 r7 r8 r9 r10 r11 r12 sp lr pc xpsr msp psp control faultmask basepri primask
   ```

3. Frame lookup, outside the fence.
4. Overall fence labelled `readCoreRegisters`, overall budget:
   - Send one DAP `evaluate` per register at the same time, issued in list order: args `{ expression: '$' + name, context: 'watch', ...frameOpt }`, DAP budget.
   - Each value is the reply's `result` as is: a string, possibly with GDB annotations, or `undefined` when the reply has none.
   - A register whose request times out gets `<timeout>` (S23). Any other error, including a missing reply body, gives `<unavailable>` (S24).
5. Resolve an object keyed by register name, in list order. When the fence expires, the whole call rejects with the `readCoreRegisters` timeout.

Known callers: `read_core_registers` (all 23), the timeout-recovery path (`5000`, `['pc', 'lr']`), and `diagnose_fault` (`sp lr pc xpsr msp psp control msplim psplim`).

### DWT cycle counter

**`readCycleCounter(timeoutMs?)`**

1. No session → reject S1 [REWORD].
2. Overall fence labelled `readCycleCounter`, overall budget. Every nested read and write gets the DAP budget.
   1. `demcr = readMemoryWord(DEMCR)`. When bit 24 (TRCENA) is clear → `writeMemoryWord(DEMCR, (demcr | TRCENA) >>> 0)`.
   2. `ctrl = readMemoryWord(DWT_CTRL)`. When bit 28 (NOCYCCNT) is set → resolve `{ present: false, cycles: 0, enabledNow: false }`.
   3. When bit 0 (CYCCNTENA) is clear → `writeMemoryWord(DWT_CTRL, (ctrl | 1) >>> 0)` and `enabledNow = true`; otherwise `enabledNow = false`.
   4. `cycles = readMemoryWord(DWT_CYCCNT) >>> 0`. Resolve `{ present: true, cycles, enabledNow }`.
3. Errors propagate, including S12 from a write that did not stick.

### Target reset

**`resetTarget({ method?, halt?, timeoutMs? }): Promise<ResetOutcome>`**

1. No session → reject S1 [REWORD].
2. `leaveHalted` is `halt !== false`; the DAP budget comes from `timeoutMs`.
3. `serverKind` = `detectGdbServerKind` over the text `${config.target?.server ?? ''} ${config.debugger?.name ?? ''} ${session.name}`, where `config` is `session.configuration ?? {}`. That gives `pyocd`, `jlink` or `unknown`.
4. Initial outcome: empty `methodsTried`, `commandsIssued` and `replies`; `verified: false`; `verificationDetail: 'not attempted'` (S19); `haltedByUs: false`; `resumed: false`.
5. Halt first when the target is running (`!isSessionStopped(session)`):
   1. `pause(<DAP budget>)`: DAP `pause` with the UI fallback of KB1; a timeout rejects `resetTarget`.
   2. Then `waitForStopEvent(session, 5000)`, armed only after the pause settled (KB6).
   3. When that is not `stopped` → `verificationDetail` S20; resolve the outcome at once, with no reset commands sent.
   4. Else `haltedByUs = true`.
6. Methods: `['system', 'core', 'hardware']` when `method` is missing or `'auto'`, else `[method]`.
7. For each method at index `i`:
   1. Append it to `methodsTried`.
   2. Commands: `buildResetCommands(serverKind, method, true)`. The halting form is always used, whatever `halt` says.
      - pyOCD and unknown servers: `monitor reset halt <method>`.
      - J-Link: `monitor halt`, then `monitor reset 0` (system and hardware) or `monitor reset 1` (core).
   3. Every command of the method is sent in order through the GDB passthrough with the DAP budget:
      - append the command to `commandsIssued`;
      - append the raw reply, or `<no echo from adapter>` (S22) when empty, to `replies`;
      - when `replyLooksUnsupported(raw)` is true, mark the method unsupported but still send the remaining commands of that method.
   4. Unsupported → `verificationDetail = unsupportedResetDetail(method, methods.length - 1 - i)`; next method, with no wait and no verification.
   5. `waitForStopEvent(session, 3000)`, armed after the commands. `ended` → `verificationDetail` S21; resolve at once with no resume. `stopped` and `timeout` both continue.
   6. Wait a fixed 500 ms.
   7. Verify against the vector table (below). `verificationDetail` = its detail. When verified → `verified = true` and stop trying methods.
8. After the loop, when verified and not `leaveHalted` → `continue(<DAP budget>)` (DAP `continue` with the UI fallback), then `resumed = true`. An unverified target is never resumed.
9. Resolve the outcome. Timeouts from the passthrough, pause or continue reject the call.

**Verification against the vector table** (private; DAP budget). Hex rendering is `0x` plus 8 lower-case hex digits of the value `>>> 0`.

1. Vector table base: `readMemoryWord('0xE000ED08')` (VTOR; this exact spelling). A non-zero value → base = `value & 0xFFFFFF80`, unsigned. Zero → base 0. Any error, timeout included → base 0, silently (KB11).
2. Reset vector: `readMemoryWord(hex(base + 4))`, for example `'0x00000004'` or `'0x08000004'`, with bit 0 cleared, unsigned.
3. PC (private; DAP budget):
   1. No session → S1 [REWORD].
   2. Frame lookup.
   3. DAP `evaluate`, args `{ expression: '$pc', context: 'watch', ...frameOpt }`.
   4. The value is the first `0x…` hex literal in `String(result ?? '')`. Symbol annotations such as `0x080001a0 <Reset_Handler+4>` are tolerated.
   5. No hex literal → error S15, quoting the result or `<empty>`.
   6. Bit 0 is cleared, unsigned.
4. `verified` is `pc === resetVector`; detail S17 when verified, else S18.
5. Any error in steps 2–3 → `{ verified: false, detail: S16 }`, S16 carrying the error's `message`. Errors are never rethrown from verification.

### Peripheral registers

**`readPeripheralRegister(peripheral, register?, timeoutMs?)`**

1. `tryReadPeripheralViaExtension(peripheral, register)` runs first, before any session check (KB13). A non-null result is returned as is.
2. No session → reject S1 [REWORD].
3. Frame lookup, outside the fence.
4. Inside the overall fence labelled `readPeripheralRegister` with the overall budget, return `readPeripheralViaMemory(session, peripheral, register, <snapshot frameId, possibly null>, <DAP budget>)`.

Today `src/core/peripheralReader.ts` and `src/core/faultDecoder.ts` are loaded lazily with a dynamic `import()` at call time. There is no import cycle and no observable difference, so static imports are acceptable.

### Fault registers

**`readFaultRegisters(timeoutMs?)`** has no session check of its own. Everything runs inside the overall fence labelled `readFaultRegisters`, with the overall budget:

1. Block read: `readMemory('0xE000ED28', 24, <DAP budget>)`, so the nested `readMemory` gets the DAP budget as its overall budget as well (KB10).
   - At least 24 bytes → resolve `faultRegistersFromBlock(block)`.
   - A shorter block → go to step 2.
   - `HardwareTimeoutError` → rethrow, with no word-by-word attempt.
   - Other errors → go to step 2.
2. Word by word, one after the other: `readMemoryWord` with the DAP budget at CFSR `0xE000ED28`, HFSR `0xE000ED2C`, DFSR `0xE000ED30`, MMFAR `0xE000ED34`, BFAR `0xE000ED38`, AFSR `0xE000ED3C`, spelled exactly as in `FAULT_REGISTER_ADDRESSES`. Errors propagate.
3. Resolve `{ CFSR, HFSR, DFSR, MMFAR, BFAR, AFSR }`.

With no session, the block read fails (and is swallowed), and the first `readMemoryWord` rejects with S1 [REWORD].

**`getFaultInfo(timeoutMs?)`** resolves `decodeFaultRegisters(await readFaultRegisters(timeoutMs))`. Errors propagate.

### Device info

**`getDeviceInfo()`**

- No session → reject S1 [REWORD]. No DAP traffic.
- Output: the text block S36, from `session.configuration`. Rows in this order: `Session name` (the session name), `Debug type` (`config.type`, else `<unknown>`), `Program` (`config.program`, else `<unknown>`), `GDB` (`config.gdb`, else `<default>`), `Server` (`config.target?.server`, else `<unknown>`), `Port` (`config.target?.port`, else `<unknown>`).
- One more row, `cbuild-run`, only when `config.cmsis?.cbuildRunFile` is truthy.
- Fallbacks apply to any falsy value. Values are converted with template-string semantics, so a numeric port prints as digits.

### DAP request inventory

| Command | Arguments, in key order | Budget | Issued by |
|---|---|---|---|
| `next`, `stepIn`, `stepOut`, `continue`, `pause` | `threadId` | DAP | run control; `pause` and `continue` also from `resetTarget` |
| `threads` | none (`{}`) | probe | `hasActiveSession`, `getSessionStatus` |
| `threads` | none (`{}`) | DAP | `getThreads` |
| `stackTrace` | `threadId`, `startFrame: 0`, `levels: 50` | snapshot | state snapshot, frame lookup |
| `stackTrace` | `threadId`, `startFrame: 0`, `levels: 1` | DAP | `getThreads`, first 32 threads, batches of 4 |
| `stackTrace` | `threadId`, `startFrame: 0`, `levels` | DAP | `getCallStack` |
| `scopes` | `frameId` | DAP | `getVariables` |
| `variables` | `variablesReference` | DAP | `getVariables`, per kept scope |
| `evaluate` | `expression`, `frameId`, `context: 'repl'` | DAP | `evaluateExpression` |
| `evaluate` | `expression: '-exec …'`, `context: 'repl'`, optional `frameId` | DAP | GDB passthrough; ladder strategies 2–3 |
| `evaluate` | `expression`, `context: 'watch'`, optional `frameId` | DAP | ladder strategy 1, `$pc`, `$<register>` |
| `readMemory` | `memoryReference`, `count` | DAP, inside the overall fence where stated | `readMemory`, `readMemoryWord` |
| `writeMemory` | `memoryReference`, `data` (base64) | DAP | `writeMemoryWord` |

No other DAP commands are sent. The remaining VS Code calls are:

- `vscode.debug.startDebugging`, `stopDebugging`, `addBreakpoints`, `removeBreakpoints`, and the `breakpoints`, `activeStackItem` and `activeDebugSession` properties;
- `vscode.workspace.getWorkspaceFolder`, `workspaceFolders` and `openTextDocument`;
- `vscode.commands.executeCommand` with the six `workbench.action.debug.*` ids above.

### Constants

| Constant | Value |
|---|---|
| Default `dapRequestMs` / `memoryReadMs` | 10000 / 30000 |
| Per-call cap for any `timeoutMs` override | 60000 |
| Probe budget cap (`threads` readiness probe) | 3000 |
| Stop-wait fallback when no valid `timeoutMs` | 60000 |
| Snapshot `stackTrace` depth | 50 |
| `getThreads` top-frame threads / batch size | 32 / 4 |
| Default `getCallStack` depth | 50 |
| Default snapshot look-ahead lines | 3 |
| Reset: halt wait / post-command stop wait / settle delay | 5000 / 3000 / 500 ms |
| VTOR address / table-base mask / Thumb-bit mask | `0xE000ED08` / `0xFFFFFF80` / `0xFFFFFFFE` |
| Fault register block | `0xE000ED28`, 24 bytes |
| Exception frame read | 32 bytes |

## Agent- or user-visible text

These texts reach an MCP client through the handler, usually inside a handler prefix such as `Error in '<tool>': …`, or a test. Unless marked otherwise they must stay byte-identical. `[REWORD]` marks text still shared with DebugMCP: phrase it anew with the same meaning. A wrapper keeps its structure: new prefix, a colon and a space, then the stringified cause. No test or code matches any `[REWORD]` text (checked: `src/`, `test/`, `scripts/`, agent docs, `surface.snapshot.json`), so rewording keeps the surface snapshot byte-identical.

### Errors

| Id | Text | Raised by |
|---|---|---|
| S1 | [REWORD] The operation needs a debug session and none is active in this window. A short sentence without a trailing period, used as an error message | every session-requiring method |
| S2 | [REWORD] Wrapper: starting the debug session failed, followed by `: ${error}` | `startDebugging` |
| S3 | `Failed to start debugging with configuration '${configurationName}': ${error}` | `startDebuggingByName` |
| S4 | `No VS Code workspace folder matches workingDirectory '${workingDirectory}'. Open workspace folders: ${folders}. launch.json is resolved relative to an open workspace folder — open the project folder (the one containing .vscode/launch.json) in this VS Code window.` | `startDebuggingByName` (then wrapped in S3) |
| S5 | [REWORD] Wrapper: stopping the debug session failed, followed by `: ${error}` | `stopDebugging` |
| S6 | [REWORD] Wrapper: restarting the debug session failed, followed by `: ${error}` | `restart` |
| S7 | [REWORD] Wrapper: adding the breakpoint failed, followed by `: ${error}` | `addBreakpoint` |
| S8 | [REWORD] Wrapper: removing the breakpoint failed, followed by `: ${error}` | `removeBreakpoint` |
| S9 | [REWORD] Wrapper: reading the variables failed, followed by `: ${error}` | `getVariables`, `getVariablesForFrame` |
| S10 | [REWORD] Wrapper: evaluating the expression failed, followed by `: ${error}` | `evaluateExpression` |
| S11 | `Failed to read memory at ${hexAddr} — all GDB strategies exhausted` | GDB word ladder |
| S12 | `Write to ${addr} did not stick (wrote 0x${written}, read back 0x${readBack})` (both 8 lower-case hex digits) | `writeMemoryWord` |
| S13 | `No data returned for address ${addr} (${unreadableBytes ?? length} unreadable bytes)`. Internal: always caught by the fallback, never visible; may be dropped | `readMemory` |
| S14 | `No data returned`. Internal, as S13 | `readMemoryWord` |
| S15 | `could not parse PC from '${result}'`, where `result` is the reply's `result` or `<empty>`; visible only inside S16 | PC read |

The timeout labels `readMemory`, `readCoreRegisters`, `readCycleCounter`, `readPeripheralRegister`, `readFaultRegisters` and `DAP <command>` appear in `HardwareTimeoutError` messages (`Hardware operation '<label>' timed out after <n>ms. …`, text owned by `src/utils/timeout.ts`) and stay exact.

### Status and result text

| Id | Text | Where |
|---|---|---|
| S16 | `verification reads failed: ${message}` | `ResetOutcome.verificationDetail` |
| S17 | `PC=${pc} matches the reset vector (${resetVector}, vector table at ${base})` | same |
| S18 | `PC=${pc} does NOT match the reset vector ${resetVector} (vector table at ${base})` | same |
| S19 | `not attempted` | same (initial value) |
| S20 | `could not halt the target to issue the reset (pause did not stop it within 5 s)` | same |
| S21 | `debug session ended during the reset` | same |
| S22 | `<no echo from adapter>` | `ResetOutcome.replies` entry |
| S23 | `<timeout>` | `readCoreRegisters` value |
| S24 | `<unavailable>` | `readCoreRegisters` value |
| S25 | `DAP threads probe timed out after ${probeMs}ms — probe/target may be hung.` | `SessionStatus.detail` |
| S26 | `DAP threads probe failed: ${message}` | `SessionStatus.detail` |
| S27 | `Stopped reason: ${reason}` | `SessionStatus.detail` |
| S28 | `No active debug session.` (with the period; pinned by the surface snapshot for `check_target_connection`) | `checkTargetConnection` |
| S29 | `Session: ${sessionName} (type=${sessionType})`, with `unknown` for a null type | `checkTargetConnection` |
| S30 | `Configuration: ${configurationName}` | `checkTargetConnection` |
| S31 | `DAP probe: TIMEOUT — probe/target unresponsive` | `checkTargetConnection` |
| S32 | `DAP probe: FAILED — adapter likely still initializing` | `checkTargetConnection` |
| S33 | `DAP probe: OK (${dapProbeMs}ms)` | `checkTargetConnection` |
| S34 | `Target state: running — DAP reads (memory/registers/variables) will be rejected until the target stops.` | `checkTargetConnection` |
| S35 | `Target state: stopped — full inspection is available.` | `checkTargetConnection` |
| S36 | device info block, below | `getDeviceInfo` |
| S37 | `thread-${id}` | `DapThread.name` default |
| S38 | `unknown` | `StackFrame.name` default (snapshot, `getCallStack`, `getThreads` top frame) |
| S39 | `unknown` | file-name default in `DebugState.breakpoints` |

S36 is a header line and one line per row, each ending in `\n` (including the last):

```text
=== Debug Session Info ===
  Session name: <session name>
  Debug type: <config.type or <unknown>>
  Program: <config.program or <unknown>>
  GDB: <config.gdb or <default>>
  Server: <config.target.server or <unknown>>
  Port: <config.target.port or <unknown>>
  cbuild-run: <config.cmsis.cbuildRunFile, only when set>
```

Each row is two spaces, the key, a colon, a space, and the value. The words `<unknown>` and `<default>` are literal.

S38 and S39 come from lines shared with DebugMCP, but they are one-word placeholders, not expressive text. Changing them would change `get_call_stack`, `get_threads` and the compact state. Keep the word and write the surrounding code independently.

`ResetOutcome` also carries texts from `src/core/resetAssist.ts` (`unsupportedResetDetail`, the monitor commands); those stay owned by that module.

### Identifiers (never reworded)

- DAP commands: `next`, `stepIn`, `stepOut`, `continue`, `pause`, `threads`, `stackTrace`, `scopes`, `variables`, `evaluate`, `readMemory`, `writeMemory`.
- DAP contexts: `repl`, `watch`.
- VS Code commands: `workbench.action.debug.stepOver`, `.stepInto`, `.stepOut`, `.continue`, `.pause`, `.restart`.
- GDB command texts: the `-exec` prefix with its trailing space; `break`, `if`, `dprintf`, `condition`, `clear`, `delete`, `set {unsigned int}…`, `x/1xw`, `print/x *(unsigned int*)…`, `*(unsigned int*)…`, `$pc`, `$<register>`.
- Register names in the default list.
- Session-state names: `no-session`, `initializing`, `running`, `stopped`, `unresponsive`.
- `already-stopped`.
- Addresses as spelled in this spec.

### Log lines (extension log only, not agent-visible)

| Id | Level | Text |
|---|---|---|
| L1 | warn | `hasActiveSession: threads probe timed out — probe or target may be unresponsive`. Arm text; keep |
| L2 | debug | `hasActiveSession: threads probe failed`, with the error. Arm text; keep |
| L3 | any | [REWORD] Reading the debug state failed (with the error). Today a `console.log`; use `logger` |
| L4 | any | [REWORD] Reading the stack trace for the state failed (with the error). As L3 |
| L5 | any | [REWORD] The top frame's source document could not be opened (with the error). As L3 |

## Known bugs to preserve

Each item: preserve (fixed separately later). Characterization tests pin the current behaviour, and the fix commits change those tests.

- **KB1: UI-command fallbacks, #13.** `stepOver`, `stepInto`, `stepOut`, `continue` and `pause` answer any non-timeout DAP failure by running `workbench.action.debug.<op>`. That command acts on VS Code's focused session, which may differ from the session. When GDB refused because the target is running, the command repeats the refused operation and VS Code shows the error toast. The executor's call resolves with the DAP error discarded, and the handler then waits for a stop that never comes. The same path is reached from `resetTarget`'s halt and resume and from the handler's timeout-recovery pause.
- **KB2: restart through the UI, #13.** `restart()` always runs `workbench.action.debug.restart`. It checks no run state and acts on the focused session.
- **KB3: the `-exec` prefix.** GDB commands are sent as a REPL `evaluate` of `-exec <cmd>`: the passthrough for `break`, `dprintf`, `condition`, `clear`, `delete`, `set {unsigned int}` and `monitor reset …`, and memory-ladder strategies 2 and 3. cdt-gdb-adapter 2.9.1, the adapter behind the CMSIS Debugger, runs REPL input as a GDB CLI command only when it starts with `>`. Everything else is evaluated as a C expression, and a failure comes back as the generic `Error: could not evaluate expression`. On `gdbtarget` these commands therefore do not reach GDB. Keep the exact prefix, the `repl` context and the optional `frameId`. See `docs/proposals/README.md` (GDB commands never reach GDB) and `docs/proposals/13-target-running-toasts.md`.
- **KB4: `errored` ignored.** The passthrough tells an adapter error apart from a reply, but no caller uses that:
  - the five GDB breakpoint methods return only the text;
  - `writeMemoryWord` ignores the `set` reply entirely and relies on the read-back;
  - `resetTarget` judges only the raw text with `replyLooksUnsupported`.
- **KB5: vacuous reset verification.** A reset counts as verified when the PC equals the reset vector afterwards. That also holds when the target was already halted at the reset vector, for example straight after a load, even though the commands did not reach GDB (KB3).
- **KB6: stop waiters armed late in `resetTarget`.** The 5 s halt wait is armed after `pause` returns, so a `stopped` event during the pause round trip is missed and the reset reports S20 although the target halted. The 3 s post-command wait is armed after the commands; this only costs time.
- **KB7: focus, not session.** Thread and frame ids come from VS Code's focused stack item even when the DAP request goes to a different session (the focus-elsewhere fallback of `resolveActiveSession`). Thread id defaults to 1.
- **KB8: a state snapshot inside every frame lookup.** Every GDB command, PC read, register read, peripheral read and memory-ladder fallback first takes a full snapshot: a 50-level `stackTrace` with `dapRequestMs`.
  - The caller's `timeoutMs` does not apply to that request, and it lies outside the overall fence of `readCoreRegisters` and `readPeripheralRegister`.
  - A hung probe adds up to `dapRequestMs` before the real request is sent. A snapshot timeout is swallowed.
- **KB9: short `readMemory` replies accepted.** A DAP reply with `data` is returned even when shorter than `length`; `unreadableBytes` is then ignored.
- **KB10: nested fault read budget.** `readFaultRegisters` passes the per-request budget to `readMemory`, which uses it as its overall budget too. When the block's GDB fallback needs longer, the `readMemory` timeout aborts `get_fault_info` without trying the word-by-word path.
- **KB11: VTOR failures hidden.** Any VTOR read failure, a timeout included, silently selects vector table base 0.
- **KB12: `/`-only folder matching.** The path-prefix step of `startDebuggingByName` knows only `/` as a separator and compares case-sensitively. Windows paths rely on VS Code's own lookup or on the single-folder fallback.
- **KB13: Peripheral Inspector before the session check.** `readPeripheralRegister` asks the Peripheral Inspector extension before checking for a session.
- **KB14: variable timeouts flattened.** A `scopes` timeout reaches the caller as a plain `Error` (S9 wrapper), no longer a `HardwareTimeoutError`. Per-scope `variables` timeouts become `scope.error`.
- **KB15: loose ladder parsing.** Strategy 1 accepts any leading integer: decimal, negative, or followed by an annotation. The value is not masked to 32 bits. Fallback word addresses are not wrapped at 2^32.

## Test cases

### Existing tests that must keep passing unchanged

1. `src/test/debuggingHandler.test.ts`, suite "Execution commands wait for the DAP stopped event": the handler drives a fake `IDebuggingExecutor`. This pins the method names `hasDebugSession`, `hasActiveSession`, `getSessionStatus`, `continue`, `stepOver`, `stepInto`, `stepOut`, `pause`, `armStopWaiter` (returns a promise, called before the request), `getCurrentDebugState` and `readCoreRegisters(5000, ['pc', 'lr'])` returning a name-to-string record.
2. `src/test/resetAssist.test.ts`, `src/test/faultDecoder.test.ts`, `src/test/peripheralReader.test.ts`, `src/test/timeout.test.ts` pin the Arm helpers this file must delegate to, unchanged.
3. `src/test/windowCoordinator.test.ts` constructs the executor inside the extension host through `WindowCoordinator` with `hardwareTimeouts: {}`.
4. `src/test/provenance.test.ts`: remove `'src/debuggingExecutor.ts'` from `DERIVED_FILES` in the same change. The second test fails otherwise.
5. `npm run test:transport` (`test/transport/session-lifecycle.js`): the compiled module loads under `vscode-stub.js`, and `new DebuggingExecutor()` works there.
6. `npm run test:surface`: `surface.snapshot.json` stays byte-identical. It pins S28 for `check_target_connection`; the no-session `SessionStatus` (`State: no-session`, `DAP responsive: false`); `getDiagnostics` (`serverVersion=2.3.10, liveSessionsInThisWindow=0, vscodeActiveDebugSession=undefined`); and the empty-model breakpoint paths (`No breakpoints to clear`, `No breakpoint found at …`, `No breakpoints currently set`).
7. `test/realboard/run.ts` on a probe board, plus the FVP corstone-blinky fixture, for the DAP path.

### Characterization cases to add

Add these as a Node harness next to the transport tests (for example `test/transport/executor-characterization.js`). It loads `vscode-stub.js`, then `out/src/debuggingExecutor.js`, and sets:

- `stub.debug.activeDebugSession` to a fake `{ id, name, type, configuration, customRequest(command, args) }` that records every call and answers from a script;
- `stub.debug.activeStackItem` to `{ session, threadId, frameId }`, or `undefined`;
- `stub.commandHandlers[...]`, plus `stub.debug.startDebugging`, `stopDebugging` and `registerDebugAdapterTrackerFactory` where a case needs them.

For DAP events, call `registerSessionStateTracker({ subscriptions: [] })` from `out/src/utils/sessionStateTracker.js` with the stub's factory captured, and feed `{ type: 'event', event: 'stopped' | 'continued' | 'terminated', body }` to the tracker of the fake session. Without events, `isSessionStopped` follows the stack item: a frame item of the same session means stopped.

Run the harness against the pre-rewrite build: on the base commit in CI, or by someone other than the implementer. It then characterises today's behaviour. `[REWORD]` texts are asserted by kind (rejects, wrapper prefix plus cause), not by wording.

Run control:

1. Given a frame item with `threadId: 7`, when `stepOver()`, then exactly one request `next {threadId: 7}` and no UI command. Given no stack item, `{threadId: 1}`.
2. Given `customRequest('next')` rejects `Error('Cannot execute this command while the target is running')`, when `stepOver()`, then `workbench.action.debug.stepOver` runs once and the call resolves. The same holds for `stepIn`, `stepOut`, `continue` and `pause` with their commands (KB1).
3. Given a session that never answers, when `stepOver(50)`, then it rejects with `HardwareTimeoutError` (`timeoutMs` 50, `operation` `DAP next`) and no UI command runs. With `stepOver(0)`, `stepOver(-1)` or `stepOver(NaN)` and `dapRequestMs` 80, the timeout is 80. With `dapRequestMs` 90000 and no override, it is 90000; with an override of 90000 it is 60000.
4. Given no session, when `armStopWaiter(1000)`, then it throws synchronously. `stepOver()` and `waitForStop()` reject.
5. Given a frame item of the session and no tracker events, when `waitForStop()`, then it resolves `{ kind: 'already-stopped', reason: null }`. Given a tracker `continued` event, a later `stopped` event with reason `breakpoint` resolves `{ kind: 'stopped', reason: 'breakpoint', threadId }`.
6. When `restart()`, then `workbench.action.debug.restart` runs, with or without a session.

Session and status:

1. Given workspace folders `/w/a` and `/w/b`, when `startDebuggingByName('/w/a/', 'Cfg')`, then `startDebugging` receives folder `/w/a` and the string `'Cfg'`. `'/w'` matches `/w/a` (the first folder); `'/x'` with two folders rejects with S3 containing S4 and `Open workspace folders: /w/a, /w/b`; no folders gives `(none)`; `'/x'` with one folder uses that folder.
2. Given no session, `getSessionStatus()` resolves the exact no-session object without a `detail` key, and `checkTargetConnection()` resolves S28.
3. Given `dapRequestMs` 200 and `threads` never answering, `getSessionStatus()` resolves `unresponsive` with detail S25 (`200ms`), and `checkTargetConnection()` includes S31 and that detail. Given `threads` rejecting `Error('boom')`: `initializing`, detail `DAP threads probe failed: boom`, S32.
4. Given `threads` answering and a frame item of the session, `getSessionStatus()` is `stopped` with `dapResponsive: true` and a numeric `dapProbeMs`. The check text is `Session: <name> (type=<type>)`, `Configuration: <name>`, S33, S35. When stopped via a tracker event with reason `step`, `detail` is `Stopped reason: step`.
5. `hasActiveSession()`: no session gives `false` with no request; a `threads` timeout (probe budget `min(dapRequestMs, 3000)`) gives `false`; an error gives `false`; success gives `isSessionStopped`.
6. `getDiagnostics()` returns `SERVER_VERSION`, the tracker's live-session count and names, and whether `activeDebugSession` is set. `SERVER_VERSION` equals the `package.json` version.

Breakpoints and GDB:

1. `addBreakpoint(uri, 12, { condition: 'x > 3' })` adds one `SourceBreakpoint` at position line 11, column 0, `enabled: true`, `condition: 'x > 3'`, `hitCondition: undefined`, `logMessage: undefined`. `removeBreakpoint(uri, 12)` removes exactly the source breakpoints with the same URI string and start line 11. It makes no `removeBreakpoints` call when none match.
2. Given a frame item (frameId 5), `setBreakpointViaGdb('/w/main.c', 42, undefined, '  x > 3 ')` sends, in order, `stackTrace {threadId, startFrame: 0, levels: 50}` and then `evaluate {expression: '-exec break /w/main.c:42 if x > 3', context: 'repl', frameId: 5}`. Given no stack item: no `stackTrace`, and no `frameId` key.
3. Reply `{ result: ' Breakpoint 2 at 0x8000100: file main.c, line 42. \n' }` → returns the trimmed text. A rejection `Error(' could not evaluate expression ')` → resolves `'could not evaluate expression'`. A hang → `HardwareTimeoutError`.
4. `setLogpointViaGdb('/w/m.c', 7, 'n=%d\\n', ['n', 'p->x'])` sends `-exec dprintf /w/m.c:7,"n=%d\n",n,p->x`; with `[]`, no trailing comma part. `setBreakpointConditionViaGdb(3, 'i == 2')` → `-exec condition 3 i == 2`; `clearBreakpointViaGdb` → `-exec clear <file>:<line>`; `clearAllBreakpointsViaGdb` → `-exec delete`.
5. `getCurrentDebugState()` with breakpoints on `/w/src/main.c` line 12 (condition `x`) and a function breakpoint → `breakpoints` is `['main.c:12 [when: x]']`. With a frame item and a `stackTrace` reply whose top frame is `{ name: 'main', source: { path: '/w/src/main.c' }, line: 40 }` → `frameName: 'main'`, `currentLine: 40`, `fileName: 'main.c'`. When `openTextDocument` rejects (stub default) → the location stays null, and the call still resolves.

Memory:

1. `readMemory('20000000', 8)` sends `readMemory {memoryReference: '0x20000000', count: 8}`, and a base64 reply of 8 bytes resolves those bytes. A 4-byte reply is returned as 4 bytes (KB9).
2. Given `readMemory` rejecting and watch evaluates answering `'0x04030201'` and `'0x08070605'`, `readMemory('0x20000000', 6)` resolves bytes `01 02 03 04 05 06`. The ladder addresses are `0x20000000` and `0x20000004`, and requests go word by word.
3. Ladder: watch `garbage` then `x/1xw` `'0x20000000:\t0x000000ff'` → 255. Only `print/x` answering `'$1 = 0x10'` → 16. All failing → rejects S11 for `0x20000000`. A strategy-1 timeout → `HardwareTimeoutError` and no further request.
4. `readMemory` with every request hanging, `memoryReadMs` 100 and `dapRequestMs` 1000 → rejects with the `readMemory` label after about 100 ms.
5. `writeMemoryWord('0xE000EDFC', 0x01000000)`: `writeMemory {memoryReference: '0xE000EDFC', data: 'AAAAAQ=='}`, then the read-back `readMemory`. When `writeMemory` rejects: `-exec set {unsigned int}0xE000EDFC = 16777216`, then the read-back. A read-back of 0 rejects `Write to 0xE000EDFC did not stick (wrote 0x01000000, read back 0x00000000)`.
6. `readCycleCounter()` with DEMCR 0 and DWT_CTRL 0 writes DEMCR `0x01000000`, reads DWT_CTRL, writes `0x00000001`, reads CYCCNT, and resolves `{ present: true, enabledNow: true }`. With DWT_CTRL bit 28 set → `{ present: false, cycles: 0, enabledNow: false }` and no CYCCNT read.

Registers and faults:

1. `readCoreRegisters()` issues 23 `evaluate {expression: '$r0' …, context: 'watch'}` requests before any answers, in list order. One hang gives `<timeout>`, one rejection gives `<unavailable>`, and the key order is the list order. `readCoreRegisters(5000, ['pc', 'lr'])` sends exactly two.
2. `readFaultRegisters()` with a 24-byte `readMemory` reply for `0xE000ED28` → one request and decoded values. With a 20-byte reply → six `readMemory` requests, `count` 4, at `0xE000ED28`, `0xE000ED2C`, `0xE000ED30`, `0xE000ED34`, `0xE000ED38`, `0xE000ED3C`, in that order.
3. `readExceptionFrame(0x20001000)` → `readMemory {memoryReference: '0x20001000', count: 32}`.

Reset:

1. pyOCD session (`configuration.target.server` contains `pyocd`), stopped, `method: 'auto'`, empty passthrough replies, VTOR `0`, word at `0x00000004` `0x08000101`, `$pc` `'0x08000100 <Reset_Handler>'` → `commandsIssued ['monitor reset halt system']`, `replies ['<no echo from adapter>']`, `methodsTried ['system']`, `verified: true`, and detail S17 with `0x08000100` and base `0x00000000`.
2. J-Link session, `method: 'core'` → commands `monitor halt`, `monitor reset 1`. A reply `Unknown monitor command` → detail `unsupportedResetDetail('core', 0)`, no stop wait and no verification.
3. `auto` with the PC never at the reset vector → methods `system, core, hardware`, `verified: false`, last detail S18, no `continue` even with `halt: false`.
4. Running target: `pause` is sent before any monitor command. With no `stopped` event within 5 s → detail S20, no commands issued, `haltedByUs: false`.
5. Verified with `halt: false` → a DAP `continue` after verification and `resumed: true`. A tracker `terminated` event during the 3 s wait → detail S21.
6. VTOR `0x08000000` → the reset vector read at `0x08000004`. The VTOR request uses the exact reference `0xE000ED08`. An unparsable `$pc` reply `xyz` → detail `verification reads failed: could not parse PC from 'xyz'`.

Threads, stack, variables, evaluate, device info:

1. Forty threads, one unnamed → 40 results, the unnamed one named `thread-<id>`. Exactly 32 `stackTrace {levels: 1}` requests, never more than 4 outstanding. A failing `stackTrace` leaves that `topFrame` undefined.
2. `getCallStack()` with no stack item → `stackTrace {threadId: 1, startFrame: 0, levels: 50}`. Frames without `id` have no `frameId` key; an empty name gives `unknown`; `source` is `path`, else `name`.
3. `getVariables(3, 'local')` with scopes `Locals`, `Globals` and `Registers` → one `variables` request, for `Locals`. A rejected `variables` → `variables: []` and `error`. An empty `scopes` reply → `{ scopes: [] }`. A `scopes` timeout rejects a plain `Error` whose message contains `HardwareTimeoutError:`.
4. `evaluateExpression('x', 4)` sends `evaluate {expression: 'x', frameId: 4, context: 'repl'}` and resolves the reply body unchanged.
5. `getDeviceInfo()` with configuration `{ type: 'gdbtarget', program: 'a.elf', target: { server: 'pyocd', port: 3333 }, cmsis: { cbuildRunFile: 'x.cbuild-run.yml' } }` and session name `S` → exactly the S36 block with `GDB: <default>` and a `cbuild-run` row.

## Constraints

- **Header.** The file starts with the Arm Apache-2.0 block used by `src/core/toolRun.ts` (lines 1–15: `Copyright 2026 Arm Limited` and the Apache licence notice). It has no Microsoft line. Any new module split out of it gets the same header.
- **Provenance.** `npm run provenance:check -- --gate` allows at most three non-trivial lines of `src/debuggingExecutor.ts` identical to DebugMCP `148cbb9a`'s file of the same path. Interface member lines are the likeliest collisions. Parameter names are free, and the contract types may be declared in a new module and re-exported from this path. Remove the `DERIVED_FILES` entry in `src/test/provenance.test.ts`.
- **Sources.** Do not consult the old file, `out/`, `dist/`, git history, an installed VSIX, DebugMCP, or `docs/architecture/debuggingExecutor.md`, which is DebugMCP-derived. Arm-authored modules, tests and proposals are allowed.
- **DAP access.** DAP traffic goes only through `customRequestWithTimeout` and `withTimeout` from `src/utils/timeout.ts`. Never call `session.customRequest` directly or add retries. `HardwareTimeoutError` propagates as its own class wherever this spec says it is rethrown.
- **Session access.** Resolve the session only with `resolveActiveSession()`; only `getDiagnostics` reads `vscode.debug.activeDebugSession`. Use `isSessionStopped`, `getStoppedReason` and `waitForStopEvent` for run state and waits. Add no event listeners of your own.
- **Arm helpers.** Use the reset dialect, DWT constants, fault layout and peripheral path from `src/core/resetAssist.ts`, `src/core/dwt.ts`, `src/core/faultDecoder.ts` and `src/core/peripheralReader.ts` unchanged. Do not duplicate them.
- **Stub compatibility.** No VS Code API use at module load or in the constructor. Paths the surface snapshot exercises must use only what `test/transport/vscode-stub.js` provides: build a `Location` from a `Position` (the stub has no `Range`), and check breakpoint kinds with `instanceof vscode.SourceBreakpoint`.
- **Logging.** Log through `logger` from `src/utils/logger.ts`; no `console.log`. Log text is not contract except L1 and L2, which are kept.
- **Style.** `import * as vscode from 'vscode'`; imports ordered vscode, then external packages, then internal modules. TypeScript strict, ES2022, Node16 modules. Keep `npm run lint` and `npm run compile` clean. Add no new runtime dependencies. Internal structure and module boundaries are free, for example a separate `src/core/gdbMemory.ts` for the ladder as codebase review item 3.4 proposes, provided the ladder behaviour above is kept.
- **Acceptance.** `npm test`, `npm run test:transport`, `npm run test:surface` (byte-identical), the characterization harness above, `test/realboard/run.ts` on a probe board, and the provenance gate.
