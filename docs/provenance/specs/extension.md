# Spec: src/extension.ts

The VS Code entry point. `activate` wires the extension together, in this order:

- reads the settings that are fixed per activation;
- registers the debug-session trackers;
- creates the agent/skill manager and applies the skill selection;
- creates the documentation handlers and their commands;
- starts this window's `WindowCoordinator`, which becomes the MCP router or a worker;
- registers the MCP server definition for in-editor Copilot;
- migrates agent configurations;
- watches settings and workspace folders;
- registers the three agent/skill commands;
- schedules the first-run setup or the monthly skill nudge.

`deactivate` shuts the coordinator down so the window leaves the shared registry before the host exits. Everything the file calls lives in other modules; this file owns only the order, the settings snapshot and the user-facing wiring.

## External contract

```ts
export async function activate(context: vscode.ExtensionContext): Promise<void>;
export async function deactivate(): Promise<void>;
```

No other export.

- **VS Code:** `package.json` `main` is `./dist/extension.js`, the esbuild bundle of this file (see `build-config.md`).
- **`test/transport/packaged-vsix.js`:** requires the packaged bundle after `test/transport/vscode-stub.js` and checks that both exports are functions. Loading the module must therefore not call any `vscode` API; only imports and module-level state may run at load time. Nothing imports this file.

Contribution points that must match `package.json` exactly:

| Kind | Identifier | Registered here? |
|---|---|---|
| command | `cmsis-developer-assistant.configure` (title *Configure Agents and Skills*) | yes |
| command | `cmsis-developer-assistant.selectSkills` (*Select Agent Skills*) | yes |
| command | `cmsis-developer-assistant.resetPopupState` (*Reset Popup State*, hidden from the palette by `menus.commandPalette` `when: false`) | yes |
| command | `cmsis-developer-assistant.listTargetDocs`, `.indexTargetDocs`, `.importUserDoc`, `.openUserDocsFolder`, `.openPackDocsPanel` | no, `registerPackDocsCommands` (called from here) |
| `mcpServerDefinitionProviders` | id `cmsis-developer-assistant`, label *CMSIS Developer Assistant* | yes |
| `activationEvents` | `onStartupFinished`, `onDebug` (plus the implicit command activations) | n/a |

Collaborators and the calls made on them:

- `logger` (`src/utils/logger`): `info`, `warn`, `error`, `logSystemInfo`.
- `SERVER_VERSION` (`src/debuggingExecutor.ts`).
- `registerSessionStateTracker(context)` (`src/utils/sessionStateTracker.ts`).
- `registerToolchainPackRootInvalidation(context)` (`src/utils/toolchainPackRoot.ts`).
- `clearSvdCache()` (`src/core/svdParser.ts`).
- `readPackDocsGates()`, which returns `{ packDocsEnabled, buildInfoEnabled }`, and `createPackDocsHandlers(context, timeoutInSeconds)`, which returns `{ docs, build }` (`src/packDocsHost.ts`).
- `registerPackDocsCommands(context, handlers)` (`src/packDocsCommands.ts`).
- `new WindowCoordinator(options: CoordinatorOptions)` with `start(context)`, `getEndpoint()`, `isRouter()` and `dispose()` (`src/windowCoordinator.ts`).
- `AgentConfigurationManager` (see `agentConfigurationManager.md`).

## Behaviour

### Module state

Two module-level references survive between `activate` and `deactivate`: the coordinator, and the agent configuration manager. Both are `null` before activation.

### Settings read once per activation

Section `cmsis-developer-assistant`. The fallback is passed to `get` and matters only if the contributed default is missing:

| Key | Fallback | Use |
|---|---|---|
| `timeoutInSeconds` | `60` (contributed default `180`) | manager, documentation handlers, coordinator |
| `serverPort` | `3001` | manager, coordinator |
| `dapRequestTimeoutMs` | `10000` | coordinator `hardwareTimeouts.dapRequestMs` |
| `memoryReadTimeoutMs` | `30000` | coordinator `hardwareTimeouts.memoryReadMs` |
| `telemetry.jsonlPath` | `''` | resolved, then `serverOptions.telemetry.jsonlPath` |
| `serial.enabled` | `true` | `serverOptions.serialEnabled` |
| `packDocs.enabled`, `buildInfo.enabled` | from `readPackDocsGates()` | `serverOptions.packDocsEnabled`, `.buildInfoEnabled` |

Telemetry path resolution works on the trimmed setting:

- Empty: off (`undefined`).
- An absolute path: used as is.
- A relative path: joined onto the first workspace folder's `fsPath`. With no workspace folder, a warning is logged and the result is off.

### `activate(context)` sequence

Awaited steps are awaited in this order. Every disposable goes into `context.subscriptions`.

1. Log that the extension is active, then log the system information (`logger.logSystemInfo()`).
2. Read the settings above. Log each of timeout, port, DAP timeout and memory-read timeout. Log the telemetry path when it is set, a note when serial tools are disabled, and one line with the documentation and build-artefact gate states.
3. `registerSessionStateTracker(context)`, then `registerToolchainPackRootInvalidation(context)`.
4. Subscribe to `vscode.debug.onDidTerminateDebugSession`; every terminated session calls `clearSvdCache()`.
5. Create `new AgentConfigurationManager(context, timeoutInSeconds, serverPort)` and store it.
6. Await `syncSkills('activation')`. An exception is logged, and activation continues.
7. `packDocs = createPackDocsHandlers(context, timeoutInSeconds)`, then `registerPackDocsCommands(context, packDocs)`. This runs in every window, router or worker.
8. If `vscode.extensions.getExtension('arm.cmsis-pack-docs')` is defined, log the duplicate-extension warning and show the same text with `showWarningMessage` (not awaited).
9. **Start the coordinator.** Inside one try/catch:
   1. Log that the coordinator is starting.
   2. Construct the coordinator and store it in module state before starting it, with these options:

      ```text
      { port: serverPort, timeoutInSeconds,
        hardwareTimeouts: { dapRequestMs, memoryReadMs },
        serverOptions: { serialEnabled, packDocsEnabled, buildInfoEnabled, telemetry: { jsonlPath } },
        packDocs }
      ```

   3. Await `coordinator.start(context)`.
   4. `endpoint = coordinator.getEndpoint()`, which is always the router URL `http://localhost:<serverPort>`, in every window.
   5. `manager.updatePort(serverPort)`.
   6. Log the role (`router` when `isRouter()`, else `worker`) and the endpoint.
   7. In the router window only, show the "server running" information message (not awaited).
   8. Register `vscode.lm.registerMcpServerDefinitionProvider('cmsis-developer-assistant', provider)`. `provideMcpServerDefinitions()` returns a one-element array: `new vscode.McpHttpServerDefinition('CMSIS Developer Assistant', vscode.Uri.parse(endpoint + '/mcp'), undefined, SERVER_VERSION)`. The URI is computed once. There is no change event and no `resolveMcpServerDefinition`. Workers register the same router URL. Log the registration.

   On any exception, log it and show the initialization error message (not awaited). No provider is registered, and the stored coordinator stays for `deactivate`.
10. Await `migrateExistingConfigurations()`. An exception is logged.
11. **Configuration listener** (`onDidChangeConfiguration`, async handler; its steps run in this order):
    1. If the event affects `cmsis-developer-assistant.installedSkills` or `cmsis-developer-assistant.aiSkills.enabled`, await `syncSkills('setting changed')`.
    2. If it affects `cmsis-developer-assistant.packDocs` (the prefix, so any `packDocs.*` key), call `packDocs.docs.refreshSettings()`.
    3. `portChanged` means the event affects `cmsis-developer-assistant.serverPort`. `gateChanged` means it affects `cmsis-developer-assistant.packDocs.enabled` or `cmsis-developer-assistant.buildInfo.enabled`. If neither is true, stop.
    4. Show an information message with one button, `Reload Window`, and await it. The port message wins when both changed. If the button is chosen, execute `workbench.action.reloadWindow`.
12. **Workspace-folders listener** (`onDidChangeWorkspaceFolders`): await `syncSkills('workspace folders changed')`.
13. Register the three commands:
    - `configure` awaits `runSetupFlow()`.
    - `selectSkills` awaits `showSkillSelectionDialog()`.
    - `resetPopupState` awaits `resetPopupState()`, then shows the reset confirmation (not awaited).

    Each handler does nothing if no manager exists.
14. Schedule a one-shot timer of **2000 ms**. When it fires:
    - If `shouldShowPopup()` resolves `true`, await `runSetupFlow()`.
    - Otherwise await `maybePromptForSkills()`.

    An exception is logged. The timer is never cancelled.
15. Log that activation succeeded. `activate` resolves `undefined` (no API object).

### `deactivate()`

1. Log that the extension is deactivating.
2. If a coordinator is stored, await `coordinator.dispose()`. A rejection is logged and swallowed. Then clear the reference.
3. Log that deactivation is complete. The manager is not touched.

## Agent- or user-visible text

`[REWORD]` strings: **1**. The others are quoted exactly. *(near-shared)* marks DebugMCP sentences with the product name swapped, which are kept verbatim here.

- Information message, router only: `CMSIS Developer Assistant server running on ${endpoint}`, where the endpoint is `http://localhost:<port>` *(near-shared)*.
- Error message: `[REWORD]` "the MCP server could not be initialized: <error>". The error is rendered as `String(error)`.
- Warning (also logged): `CMSIS Developer Assistant: the experimental "CMSIS Pack Docs" extension is also installed. Its tools are now built into this extension (settings cmsis-developer-assistant.packDocs.enabled / buildInfo.enabled); uninstall it so agents do not see the same tool names twice.`
- Port reload message: `CMSIS Developer Assistant: the server port setting changed. Reload the window to restart the MCP server on the new port.`
- Gate reload message: `CMSIS Developer Assistant: the documentation / build-artefact tool setting changed. Reload the window so the next agent connection sees the new tool list.`
- Button: `Reload Window`.
- Reset confirmation: `CMSIS Developer Assistant popup state has been reset.` *(near-shared)*
- MCP server definition label: `CMSIS Developer Assistant`, with version `SERVER_VERSION`. This is a server name shown in VS Code's MCP view; treat it as an identifier.
- **Log events** (wording free, not contract): activation start and success; the system information; each setting value; the telemetry path; serial disabled; the gates; a skill-sync error; the duplicate extension; coordinator starting; role and endpoint; provider registered; initialization failure; migration error; the setup or nudge error; deactivation start and end; coordinator dispose error; a relative telemetry path without a folder. `test/realboard/README.md` tells humans to read the port from the "server running" toast; keep that toast.

## Known bugs to preserve

All of these are preserved here and fixed separately later.

1. The in-code fallback for `timeoutInSeconds` is `60`, not the contributed `180`.
2. **Missing reload prompts.** `serial.enabled`, `telemetry.jsonlPath`, `timeoutInSeconds`, `dapRequestTimeoutMs` and `memoryReadTimeoutMs` are read once, but changing them shows no reload prompt; only the port and the two gates do. Every open window shows its own prompt.
3. The skill sync is awaited before the coordinator starts, so copying skills delays the MCP server.
4. **No recovery from a failed start.** When `coordinator.start` throws there is no retry and no MCP definition provider. Agent migration still runs with the configured port, and the half-started coordinator is disposed only at `deactivate`.
5. `updatePort(serverPort)` re-sets the value the manager already has, so it is a no-op kept for the contract.
6. The 2 s setup timer is not cleared by `deactivate`.
7. The async listeners have no catch; an exception from them is an unhandled rejection.
8. The duplicate-extension warning appears on every activation of every window.
9. A non-string `telemetry.jsonlPath` value makes activation throw at the trim.

## Test cases

Characterization tests (`src/test/extension.test.ts` may be replaced; it only holds a sample test). Where the extension host makes a case hard, the implementer may move the logic into small internal helpers with injected dependencies (settings reader, coordinator factory, manager) and test those. The public exports stay as above.

1. Given `package.json`, the ids `cmsis-developer-assistant.configure`, `.selectSkills` and `.resetPopupState` are contributed commands, `resetPopupState` is hidden from the palette, and `mcpServerDefinitionProviders[0].id` is `cmsis-developer-assistant`.
2. Given the built extension activated in the test host, `vscode.commands.getCommands(true)` contains the three commands and the five pack-docs commands.
3. Given the packaged VSIX, `node test/transport/packaged-vsix.js <vsix>` reports "the bundle loads and exports activate/deactivate".
4. **Telemetry path resolution:**
   - `''` and `'   '` are off.
   - `' /abs/t.jsonl '` gives `/abs/t.jsonl`.
   - `rel/t.jsonl` with a first folder `/w` gives `/w/rel/t.jsonl`.
   - `rel/t.jsonl` with no folder is off, and one warning is logged.
5. **Settings snapshot:** given the settings above, the coordinator receives exactly `{ port, timeoutInSeconds, hardwareTimeouts: { dapRequestMs, memoryReadMs }, serverOptions: { serialEnabled, packDocsEnabled, buildInfoEnabled, telemetry: { jsonlPath } }, packDocs }`, and the manager receives `(context, timeoutInSeconds, serverPort)`.
6. **Ordering:**
   - `syncSkills('activation')` settles before `coordinator.start` is called.
   - `migrateExistingConfigurations` runs after the start settles, whether it succeeded or failed.
   - The commands are registered after migration.
   - The timer fires 2000 ms later.
7. **Provider:** given a successful start, `provideMcpServerDefinitions()` returns one `McpHttpServerDefinition` with the label `CMSIS Developer Assistant`, the URI `http://localhost:<serverPort>/mcp` and the version `SERVER_VERSION`. The result is the same for a router and for a worker.
8. **Toasts:** a router shows the "server running" message with the endpoint, and a worker shows nothing.
9. **Failed start:** given `coordinator.start` rejects, then:
   - the initialization error message is shown;
   - no provider is registered;
   - migration still runs;
   - `deactivate()` disposes that coordinator.
10. **Configuration events:**
    - `installedSkills` or `aiSkills.enabled` leads to `syncSkills('setting changed')`, with no prompt.
    - `packDocs.extractor` leads to `refreshSettings()`, with no prompt.
    - `serverPort` shows the port message.
    - `buildInfo.enabled` or `packDocs.enabled` shows the gate message; `packDocs.enabled` also refreshes.
    - Port and gate changing together shows the port message.
    - `serial.enabled` does nothing.
    - Choosing `Reload Window` executes `workbench.action.reloadWindow`.
11. A workspace-folder change leads to `syncSkills('workspace folders changed')`.
12. **Timer:** when `shouldShowPopup()` is `true`, `runSetupFlow()` runs and `maybePromptForSkills` does not; when it is `false`, the reverse. An exception is logged, not thrown.
13. **Commands:** `resetPopupState` awaits `manager.resetPopupState()`, then shows `CMSIS Developer Assistant popup state has been reset.` `configure` awaits `runSetupFlow()` and `selectSkills` awaits `showSkillSelectionDialog()`.
14. **`deactivate`:**
    - It awaits `dispose()`.
    - A rejected `dispose()` is logged and `deactivate` still resolves.
    - A second `deactivate()` logs again but disposes nothing.
15. `npm run test:transport` and `npm run test:surface` pass unchanged.

## Constraints

- **VS Code APIs** (engine `^1.109.0`):
  - `workspace`: `getConfiguration`, `onDidChangeConfiguration` / `affectsConfiguration`, `onDidChangeWorkspaceFolders`, `workspaceFolders`.
  - `debug.onDidTerminateDebugSession`, `extensions.getExtension`.
  - `window`: `showInformationMessage`, `showWarningMessage`, `showErrorMessage`.
  - `commands`: `registerCommand`, `executeCommand`.
  - `lm.registerMcpServerDefinitionProvider`, `McpHttpServerDefinition`, `Uri.parse`.
- **Node:** `path` (`isAbsolute`, `join`).
- **Logging:** `logger` from `src/utils/logger` only. Log text is not contract.
- **File header:** the Arm Apache-2.0 block as in `src/core/toolRun.ts`, with no Microsoft line. Remove `src/extension.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- **Provenance gate:** at most 3 identical trimmed non-trivial lines against DebugMCP (`npm run provenance:check -- --gate`). Command ids and setting keys are fixed; the helper structure, variable names and the order of independent statements within one step are free.
- **Path and dependencies:** keep the path `src/extension.ts`, which is the esbuild entry point, and keep the module free of dependencies beyond those listed.
