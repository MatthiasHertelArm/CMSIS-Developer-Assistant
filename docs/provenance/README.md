# Rewrite of the DebugMCP-derived code (issue #53)

This folder records how the files that still derived from [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) (MIT) were replaced by independently written code. It is the evidence for dropping the Microsoft copyright line from each file.

## Method

Each file goes through two separate roles:

1. **Specification ("dirty room").** One engineer reads the old file, its tests, its callers and the docs, and writes a behaviour specification into [specs/](specs/):
   - The spec contains the external contract (exports and their types), the observable behaviour, the exact agent-visible text, known bugs to preserve and the test cases to pin.
   - It contains no implementation code.
   - Visible strings that are still shared with DebugMCP are not quoted. They are marked `[REWORD]` with their meaning, so that the implementer phrases them anew.
2. **Implementation ("clean room").** A different engineer writes the new file from the spec alone.
   - The old file and its compiled output are removed from the working tree first.
   - The implementer does not read the old version through git, `out/`, `dist/`, an installed VSIX, the DebugMCP repository, or the DebugMCP-derived architecture docs.
   - The implementer may read everything Arm-authored in the repository.

Every rewrite commit is then checked:

- **Behaviour-neutral.** `npm test`, `npm run test:transport` and `npm run test:surface` pass, and `node test/transport/dap-scenarios.js` replays 28 scripted debug sessions (every tool reply plus the adapter traffic). Either snapshot may change only where a `[REWORD]` string was rephrased, and those changes are listed in the commit message.
- **Independent.** `npm run provenance:check -- --gate` reports at most three shared non-trivial lines for the rewritten file against DebugMCP `148cbb9a`, the last upstream state this project synced with.
- **Header.** The file carries the Arm Apache-2.0 header only and leaves the list in [src/test/provenance.test.ts](../../src/test/provenance.test.ts).

Known bugs are preserved on purpose, so that each rewrite is reviewable as behaviour-neutral. They are fixed afterwards in their own commits (#11, #12, #13, #46, #47 and the GDB `-exec` passthrough).

## Results

"Shared" counts the distinct non-trivial lines of a file that occur anywhere in DebugMCP's history: any text file, any commit up to `148cbb9a`. "Before" is measured at the rewrite base `951530e` (`npm run provenance:check -- --at 951530e`), "after" on the rewritten file. The remaining matches are declarations dictated by the exported names, for example `export class DebugState {`.

| File | Shared before | Shared after | Spec |
|---|---:|---:|---|
| `src/index.ts` | 8 | 1 | [index.md](specs/index.md) |
| `src/utils/logger.ts` | 53 | 3 | [logger.md](specs/logger.md) |
| `src/debugState.ts` | 86 | 2 | [debugState.md](specs/debugState.md) |
| `src/utils/secretRedaction.ts` | 102 | 0 | [secretRedaction.md](specs/secretRedaction.md) |
| `src/test/secretRedaction.test.ts` | 93 | 1 | [secretRedaction.md](specs/secretRedaction.md) |
| `src/test/extension.test.ts` | 9 | 0 | [extension-test.md](specs/extension-test.md) |
| `src/controlServer.ts` | 33 | 3 | [controlServer.md](specs/controlServer.md) |
| `src/utils/workspaceRegistry.ts` | 58 | 3 | [workspaceRegistry.md](specs/workspaceRegistry.md) |
| `src/routingDebuggingHandler.ts` | 20 | 3 | [routingDebuggingHandler.md](specs/routingDebuggingHandler.md) |
| `src/test/routing.test.ts` | 10 | 3 | [routingDebuggingHandler.md](specs/routingDebuggingHandler.md) |
| `src/test/workspaceRegistry.test.ts` | 6 | 2 | [workspaceRegistry.md](specs/workspaceRegistry.md) |
