# Spec: src/index.ts

The barrel module of `src/`: it re-exports the debugging core classes and interfaces and the agent-configuration types under one import path. Two modules import the core classes through it with the directory specifier `'.'`, and the transport tests load its compiled form `out/src/index.js` to build a `DebuggingHandler` outside VS Code. It has no code or text of its own. It is not a package entry point: `package.json` `main` is `./dist/extension.js`, esbuild bundles it only because `src/debugMCPServer.ts` and `src/windowCoordinator.ts` import it, and `out/` is excluded from the VSIX.

## External contract

Ten names, re-exported unchanged from four modules. Kinds and aliases are contract; the five type-only names are erased at runtime.

| Exported name | Kind | Source module, original name | Imported through `index` by |
| --- | --- | --- | --- |
| `DebugState` | class | `./debugState`, same name | nobody |
| `DebuggingExecutor` | class | `./debuggingExecutor`, same name | `src/debugMCPServer.ts`, `src/windowCoordinator.ts`, `test/transport/surface-snapshot.js`, `test/transport/session-lifecycle.js` |
| `IDebuggingExecutor` | interface (type only) | `./debuggingExecutor`, same name | nobody |
| `ConfigurationManager` | class, alias | `./utils/debugConfigurationManager`, `DebugConfigurationManager` | `src/debugMCPServer.ts`, `src/windowCoordinator.ts`, both transport tests above |
| `IConfigurationManager` | interface (type only), alias | `./utils/debugConfigurationManager`, `IDebugConfigurationManager` | nobody |
| `DebuggingHandler` | class | `./debuggingHandler`, same name | `src/debugMCPServer.ts`, `src/windowCoordinator.ts`, both transport tests above |
| `IDebuggingHandler` | interface (type only) | `./debuggingHandler`, same name | `src/debugMCPServer.ts` |
| `AgentConfigurationManager` | class | `./utils/agentConfigurationManager`, same name | nobody (`src/extension.ts` imports the module directly) |
| `AgentInfo` | type alias (union, type only) | `./utils/agentConfigurationManager`, same name | nobody (`src/test/skillPrompt.test.ts` imports the module directly) |
| `MCPServerConfig` | interface (type only) | `./utils/agentConfigurationManager`, same name | nobody |

The in-repo importers use `import { … } from '.'` (in `src/debugMCPServer.ts` together with `IDebuggingHandler`). The transport tests use `require(path.join(OUT, 'index.js'))` and destructure `DebuggingExecutor`, `ConfigurationManager` and `DebuggingHandler`.

Unused through this module: `DebugState`, `IDebuggingExecutor`, `IConfigurationManager`, `AgentConfigurationManager`, `AgentInfo`, `MCPServerConfig`. Keep all ten ("same exports").

## Behaviour

- Pure re-export. No statements with effects of its own, no default export.
- The compiled CommonJS module exposes exactly five runtime properties: `DebugState`, `DebuggingExecutor`, `ConfigurationManager`, `DebuggingHandler`, `AgentConfigurationManager`, each identical (`===`) to the class in its source module.
- Loading it loads the four source modules and, transitively, their dependencies. That includes `src/utils/logger.ts`, which creates the output channel. No known behaviour depends on the order in which the four are loaded; there is no import cycle through this module.
- The type-only names may be re-exported with `export type` (behaviour-neutral; `tsconfig.json` does not set `isolatedModules` or `verbatimModuleSyntax`, so either form compiles).

## Agent- or user-visible text

None. No `[REWORD]` strings.

Surface snapshot: no entry holds text from this file, but every shape depends on it at runtime. All five shapes load `out/src/debugMCPServer.js`, whose default handler is built from `DebuggingExecutor`, `ConfigurationManager` and `DebuggingHandler` imported through `'.'`. The harness `test/transport/surface-snapshot.js` also requires `out/src/index.js` directly for the `all-groups` shape and for the worker behind `routed-one-worker`.

## Known bugs to preserve

All of these: preserve (fixed separately later).

1. The aliases `ConfigurationManager` and `IConfigurationManager` hide the real names `DebugConfigurationManager` and `IDebugConfigurationManager`, next to an unrelated `AgentConfigurationManager`.
2. Six of the ten exports have no importer.
3. Two production modules import from `'.'`, which works only because the file is named `index.ts` and the output is CommonJS. Keep the file name and location.

## Test cases

No test targets this file. It is pinned indirectly; these must keep passing:

1. Given `npm run compile`, when `src/debugMCPServer.ts` and `src/windowCoordinator.ts` import `DebuggingExecutor`, `ConfigurationManager`, `DebuggingHandler` (and the type `IDebuggingHandler`) from `'.'`, then the build succeeds.
2. Given `out/src/index.js` loaded in plain Node under `test/transport/vscode-stub.js`, when `DebuggingExecutor`, `ConfigurationManager` and `DebuggingHandler` are destructured from it, then `new DebuggingHandler(new DebuggingExecutor(), new ConfigurationManager(), 30)` constructs a handler (`test/transport/session-lifecycle.js` step 9, `test/transport/surface-snapshot.js`).
3. Given the rewritten file, when `npm run test:surface` runs, then the surface is byte-identical to `test/transport/surface.snapshot.json`.

Recommended addition (optional): given `out/src/index.js` loaded under the stub, when its own enumerable keys are listed, then they are exactly the five runtime names above, each `===` to the export of its source module.

## Constraints

- Keep the path `src/index.ts`.
- No imports other than the four source modules; no `vscode`, no `logger`.
- File header: the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`, without the Microsoft line (ignore the stale "File Header" section of AGENTS.md). Remove `src/index.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- TypeScript strict, ES2022, Node16 modules (CommonJS output); `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport` and `npm run test:surface` must pass.
