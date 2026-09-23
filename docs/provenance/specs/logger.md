# Spec: src/utils/logger.ts

The extension's single logging sink. It owns one VS Code log output channel, writes entries at four severities with an optional error detail appended, filters by a process-wide minimum level, and offers two diagnostic dumps (system information, selected environment variables) plus a way to reveal the channel. Every other module logs through the exported `logger` instance (AGENTS.md: use `logger`, not `console.log`). Nothing the logger writes reaches an MCP client; the only audience is a user who opens the Output view.

## External contract

Types are contract; parameter names are free.

```ts
export enum LogLevel { DEBUG = 0, INFO = 1, WARN = 2, ERROR = 3 }

export class Logger {
    private constructor();
    static getInstance(): Logger;
    debug(message: string, error?: any): void;
    info(message: string, error?: any): void;
    warn(message: string, error?: any): void;
    error(message: string, error?: any): void;
    setLogLevel(level: LogLevel): void;
    logSystemInfo(): void;
    logEnvironment(): void;
    show(): void;
}

export const logger: Logger;
```

- `LogLevel` is an ordinary numeric TypeScript enum (so it has the reverse mapping, `LogLevel[1] === 'INFO'`). The numeric values are contract.
- The `error?: any` parameter may be typed `error?: unknown` instead; every call site still compiles.
- The constructor stays non-public so the singleton cannot be bypassed.

Importers (all import `logger`, none imports `Logger` or `LogLevel`):

| Importer | Members used |
| --- | --- |
| `src/extension.ts` | `info`, `warn`, `error`, `logSystemInfo` |
| `src/packDocsCommands.ts` | `info`, `show` |
| `src/debugMCPServer.ts` | `debug`, `info`, `warn`, `error` |
| `src/packDocsHost.ts` | `debug`, `info`, `warn` |
| `src/debuggingExecutor.ts` | `debug`, `warn` |
| `src/utils/sessionStateTracker.ts` | `debug`, `info` |
| `src/controlServer.ts`, `src/windowCoordinator.ts`, `src/utils/agentConfigurationManager.ts` | `info`, `warn`, `error` |
| `src/debuggingHandler.ts`, `src/core/serialController.ts` | `info`, `warn` |
| `src/routingDebuggingHandler.ts`, `src/utils/toolchainPackRoot.ts` | `info` |
| `src/core/serialMonitorBridge.ts` | `warn` |
| `src/utils/workspaceRegistry.ts` | `error` |
| `src/test/provenance.test.ts` | lists the path in its allowlist only |

Unused outside the file: `Logger` (class name), `LogLevel`, `Logger.getInstance`, `setLogLevel`, `logEnvironment`. Keep them exported.

Call sites pass the optional second argument as a caught exception or an `err` from an event (for example `logger.error('MCP HTTP server error', err)`).

## Behaviour

### Instance and channel

- One `Logger` instance per loaded copy of the module. `Logger.getInstance()` always returns it, and `logger` is that same instance (`Logger.getInstance() === logger`).
- The instance is created when the module is first evaluated (the `logger` export forces it), not lazily on the first log call.
- Creating the instance creates exactly one output channel through `vscode.window.createOutputChannel(<name>, { log: true })`, that is a `LogOutputChannel`. The name is in "Agent- or user-visible text" below. The channel is never disposed.
- The minimum level starts at `LogLevel.INFO`.

### `debug`, `info`, `warn`, `error`

- An entry is written only when the method's level is greater than or equal to the current minimum level (DEBUG 0 < INFO 1 < WARN 2 < ERROR 3). Otherwise the call does nothing.
- A written entry is exactly one call to the channel method of the same severity (`debug`, `info`, `warn`, `error` on the `LogOutputChannel`) with exactly one string argument. The channel adds timestamp and severity itself.
- The string is the message alone when the second argument is falsy (`undefined`, `null`, `0`, `''`, `false`, `NaN`). When it is truthy, the string is the message, a colon, one space, then the rendering of the detail:
  - A value that is `instanceof Error`: its `message`; then, only when its `stack` is a non-empty string, a line break, the stack-trace label (see below) and the full `stack` text.
  - Any other value: `JSON.stringify(value, null, 2)` (pretty JSON, two-space indentation). If that throws (circular structure, BigInt), `String(value)` instead. If it returns `undefined` (function, symbol), the text `undefined` appears.
- There is no further guard: in the rare case that the `String(value)` fallback itself throws (a circular object without a prototype), the exception propagates to the caller.

### `setLogLevel(level)`

- Sets the minimum level, then writes one INFO entry confirming the change that names the new level by its enum member name (`DEBUG`, `INFO`, `WARN` or `ERROR`). The entry goes through the normal filter after the change, so it is written only when the new level is DEBUG or INFO.

### `logSystemInfo()`

Writes seven separate INFO entries, in this order: an opening banner; the VS Code version (`vscode.version`); the platform (`process.platform`); the CPU architecture (`process.arch`); the Node.js version (`process.version`); the extension host process id (`process.pid`); a closing banner. Each value line is a label followed by the value. Called once from `activate()` right after the first log line.

### `logEnvironment()`

Writes six separate INFO entries, in this order: an opening banner; `HOME`, `USERPROFILE` and `APPDATA`, each as `NAME: value`; `PATH` as `PATH:`, one space, at most the first 200 characters of its value and then `...` (always appended, whether or not anything was cut); a closing banner. A variable that is unset or empty prints the word `undefined` in place of its value (for `PATH`: `PATH: undefined...`). No caller exists today.

### `show()`

Reveals the channel in the Output view by calling the channel's `show()` with no argument (so focus moves to the panel). Used by the documentation commands before they log a block.

## Agent- or user-visible text

None of this reaches an MCP client. It appears in the VS Code Output view.

- Channel name, exact (Arm-chosen; users select it in the Output view): `CMSIS Developer Assistant`
- Separator between message and error detail, exact: a colon followed by one space.
- [REWORD] Label that introduces the stack trace on the line after the error message.
- [REWORD] Confirmation that the log level changed, followed by the level's enum name. The enum names `DEBUG`, `INFO`, `WARN`, `ERROR` are identifiers and stay exact.
- `logSystemInfo` entries, in order:
  1. [REWORD] Opening banner of the system-information block.
  2. [REWORD] Label for the VS Code version, followed by the value.
  3. [REWORD] Label for the operating-system platform, followed by the value.
  4. [REWORD] Label for the CPU architecture, followed by the value.
  5. [REWORD] Label for the Node.js version, followed by the value.
  6. [REWORD] Label for the extension host's process id, followed by the value.
  7. [REWORD] Closing banner of the system-information block.
- `logEnvironment` entries, in order:
  1. [REWORD] Opening banner of the environment block.
  2. `HOME: <value>`, `USERPROFILE: <value>`, `APPDATA: <value>`, `PATH: <value>...` (environment variable names exact; the fallback word `undefined` and the `...` suffix exact).
  3. [REWORD] Closing banner of the environment block.

Surface snapshot (`test/transport/surface.snapshot.json`): no entry contains logger text. Every shape loads the logger (all server modules import it); under `test/transport/vscode-stub.js` the stub channel prints `error` entries to stderr with an `[ext]` prefix, which the snapshot does not record.

## Known bugs to preserve

All of these: preserve (fixed separately later).

1. `debug()` is dead code in practice: the minimum level starts at INFO and nothing calls `setLogLevel`, so the debug entries written by `debugMCPServer.ts`, `packDocsHost.ts`, `debuggingExecutor.ts` and `sessionStateTracker.ts` never reach the channel, even when the user raises the channel's own log level to Debug or Trace in VS Code (two independent filters).
2. The `setLogLevel` confirmation is itself an INFO entry written after the change, so it is invisible when the new level is WARN or ERROR.
3. The rendering of an `Error` repeats the message: V8's `stack` already begins with `<name>: <message>`.
4. A string detail is JSON-quoted (`logger.error('x', 'boom')` writes `x: "boom"`); an error-like plain object (for example a DAP error body) is dumped as multi-line JSON; an `Error` from another realm is not `instanceof Error` and renders as `{}`; a function or symbol detail renders as `undefined`.
5. Falsy details are dropped silently: `logger.warn('x', 0)` writes `x`.
6. `logEnvironment` appends `...` to `PATH` even when nothing was cut, and prints `undefined` for empty variables. The method has no caller.
7. The output channel is created at module load, also in contexts that never log (unit tests, transport tests).

## Test cases

No existing test pins the logger. Recommended characterization tests (optional), run in plain Node: require `test/transport/vscode-stub.js`, replace its `window.createOutputChannel` with a recorder before the first `require` of `out/src/utils/logger.js`, then:

1. Given a fresh load of the module, when it is evaluated, then exactly one channel is created, named `CMSIS Developer Assistant`, with options `{ log: true }`.
2. Given the default level, when `logger.debug('a')` is called, then no channel method is called.
3. Given the default level, when `logger.info('a')` is called, then the channel's `info` is called once with `'a'`.
4. Given an `Error('boom')` with a stack, when `logger.warn('a', err)` is called, then the channel's `warn` receives one string that starts with `a: boom`, followed by a line break, the stack label and the stack.
5. Given a plain object `{ code: 1 }`, when `logger.error('a', obj)` is called, then the string is `a:`, one space and the object's two-space pretty JSON.
6. Given an object that references itself, when `logger.error('a', obj)` is called, then the string is `a: [object Object]`.
7. Given the detail `0`, when `logger.info('a', 0)` is called, then the string is `a`.
8. Given `setLogLevel(LogLevel.DEBUG)`, when `logger.debug('a')` is called, then it is written; given `setLogLevel(LogLevel.ERROR)`, then no confirmation is written and `info`/`warn` are dropped while `error` is written. Restore INFO afterwards.
9. When `logger.show()` is called, then the channel's `show` is called with no argument.
10. `Logger.getInstance()` returns `logger`.

## Constraints

- VS Code API: `vscode.window.createOutputChannel(name, { log: true })` and, on the returned `LogOutputChannel`, only `debug`, `info`, `warn`, `error` and `show`; `vscode.version` inside `logSystemInfo` only. Touch no other `vscode` member, at load time or later: the transport tests load the compiled module under `test/transport/vscode-stub.js`, whose channel offers only `trace`, `debug`, `info`, `warn`, `error`, `show` and the plain output-channel methods (`append`, `appendLine`, `replace`, `clear`, `hide`, `dispose`), and which has no `version`.
- Node: `process.platform`, `process.arch`, `process.version`, `process.pid`, `process.env`.
- This module is the one exception to "log via `src/utils/logger`"; it must not use `console`.
- File header: the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`, without the Microsoft line (ignore the "File Header" section of AGENTS.md, which is stale). Remove `src/utils/logger.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- TypeScript strict, ES2022, Node16 modules (CommonJS output); `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport` and `npm run test:surface` must pass.
