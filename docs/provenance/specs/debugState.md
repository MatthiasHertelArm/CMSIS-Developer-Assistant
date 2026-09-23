# Spec: src/debugState.ts

An in-process value object for "where is the debugger now": whether a session is active, the launch configuration, the current source location with a few following lines, the DAP frame and thread ids, the top frame's name, the call stack and the window's breakpoints. `DebuggingExecutor.getCurrentDebugState` fills one from the active VS Code debug session and a DAP `stackTrace` request. `DebuggingHandler` turns it into the text that MCP tools return: the full JSON form when a session comes up (`start_debugging`, `cmsis_action` `load_and_debug` / `attach`), the compact JSON form after every step, continue, pause and `wait_for_stop`. The module also renders a breakpoint's modifiers (condition, log message, hit condition, disabled) as a short suffix, shared by `list_breakpoints` and the breakpoint strings in the state. It imports nothing, in particular not `vscode`, so it stays unit-testable outside the extension host.

Note: `docs/architecture/debugState.md` is itself DebugMCP-derived and partly stale (it calls the class immutable and describes a before/after polling use that no longer exists). Use this spec, not that page.

## External contract

Types are contract; parameter names are free.

```ts
export interface StackFrame {
    name: string;
    source?: string;
    line?: number;
    column?: number;
    frameId?: number;
}

export interface BreakpointModifiers {
    condition?: string;
    logMessage?: string;
    hitCondition?: string;
    enabled?: boolean;
}

export function formatBreakpointModifiers(bp: BreakpointModifiers): string;

export class DebugState {
    sessionActive: boolean;
    fileFullPath: string | null;
    fileName: string | null;
    currentLine: number | null;
    currentLineContent: string | null;
    nextLines: string[];
    frameId: number | null;
    threadId: number | null;
    frameName: string | null;
    stackTrace: StackFrame[];
    configurationName: string | null;
    breakpoints: string[];

    constructor();
    reset(): void;
    hasValidContext(): boolean;
    hasLocationInfo(): boolean;
    hasFrameName(): boolean;
    updateContext(frameId: number, threadId: number): void;
    updateLocation(fileFullPath: string, fileName: string, currentLine: number, currentLineContent: string, nextLines: string[]): void;
    updateFrameName(frameName: string | null): void;
    updateStackTrace(stackTrace: StackFrame[]): void;
    updateConfigurationName(configurationName: string | null): void;
    updateBreakpoints(breakpoints: string[]): void;
    clone(): DebugState;
    toString(): string;
    toCompactString(options: { includeBreakpoints: boolean; maxFrames?: number }): string;
}
```

All twelve fields are public and writable; callers assign some of them directly.

| Export | Used by |
| --- | --- |
| `DebugState` | `src/debuggingExecutor.ts`: constructs one per `getCurrentDebugState`, assigns `sessionActive` directly, calls `updateConfigurationName`, `updateContext`, `updateFrameName`, `updateStackTrace`, `updateLocation`, `updateBreakpoints`, reads `frameId` and `threadId`. `src/debuggingHandler.ts`: constructs an empty one when reading the state fails, reads `breakpoints`, `frameName`, `fileName`, `currentLine`, `currentLineContent`, calls `toString()` and `toCompactString({ includeBreakpoints })` (never passes `maxFrames`). `src/index.ts` re-exports it (no importer uses that re-export). Tests: `src/test/debugState.test.ts`, `src/test/debuggingHandler.test.ts` (the latter assigns `sessionActive`, `fileName`, `fileFullPath`, `currentLine`, `frameName` directly). |
| `StackFrame` | `src/debuggingExecutor.ts` (builds `{ name, source, line, column }` per DAP frame), `src/debuggingHandler.ts` (call-stack results), `src/core/faultTriage.ts` (`DiagnosisInput.frames`; reads `name`, `source`, `line`). |
| `BreakpointModifiers` | Not imported anywhere. It is the parameter type; `vscode.SourceBreakpoint` and `vscode.FunctionBreakpoint` are passed structurally. |
| `formatBreakpointModifiers` | `src/debuggingExecutor.ts` (the state's breakpoint strings), `src/debuggingHandler.ts` (`list_breakpoints` lines), `src/test/debuggingHandler.test.ts`. |

Unused outside the file: `reset`, `hasValidContext`, `hasLocationInfo`, `hasFrameName`, `clone`, and the `StackFrame.frameId` field (never set or read). Keep them.

## Behaviour

### Initial state and `reset()`

A new instance, and an instance after `reset()`: `sessionActive` false; `fileFullPath`, `fileName`, `currentLine`, `currentLineContent`, `frameId`, `threadId`, `frameName`, `configurationName` all `null`; `nextLines`, `stackTrace`, `breakpoints` new empty arrays.

### Setters

- `updateContext(frameId, threadId)` sets both ids.
- `updateLocation(fileFullPath, fileName, currentLine, currentLineContent, nextLines)` sets the four scalars and stores a copy of `nextLines`.
- `updateFrameName(name)` and `updateConfigurationName(name)` set the value as given, `null` included.
- `updateStackTrace(frames)` and `updateBreakpoints(list)` store a copy of the array.
- Copies are shallow: the frame objects are shared with the caller's array. Later changes to the caller's array itself do not affect the state.
- By convention the breakpoint strings are `<fileName>:<line>` plus the `formatBreakpointModifiers` suffix; the class does not check them.

### Predicates

- `hasValidContext()`: `sessionActive` is true and neither `frameId` nor `threadId` is `null` (an id of 0 counts as present).
- `hasLocationInfo()`: `fileName` and `currentLine` are both non-null; `sessionActive` is not consulted.
- `hasFrameName()`: `frameName` is non-null (an empty string counts as present).

### `clone()`

Returns a new `DebugState` with every field equal to this one's; the three arrays are new arrays with the same elements (frame objects shared).

### Frame rendering (both forms)

Each stack frame becomes the string `<name>:<line>`. When `line` is falsy (absent or 0), `?` stands in for it.

### `toString()` — full form

`JSON.stringify(obj, null, 2)`: two-space indentation, `\n` line breaks, no trailing newline, `null` kept as `null`, one array element per line, empty arrays as `[]`.

- `sessionActive` false: the object has the single key `sessionActive` (value `false`), whatever the other fields hold.
- `sessionActive` true: keys in exactly this order: `sessionActive`, `configurationName`, `stackTrace` (every frame, rendered as above), `breakpoints` (the strings as stored), `fileFullPath`, `fileName`, `currentLine`, `currentLineContent`, `nextLines`, `frameId`, `threadId`, `frameName`. Null fields are present with `null`.

### `toCompactString({ includeBreakpoints, maxFrames })` — compact form

Same JSON formatting as the full form.

- `sessionActive` false: exactly the same text as the full form (only `sessionActive: false`), whatever the options.
- `sessionActive` true: keys in exactly this order: `sessionActive` (`true`), `frameName`, `fileFullPath`, `currentLine`, `currentLineContent`, `nextLines`, `frameId`, `threadId`, `stackTrace`, then either `breakpoints` (the full list, when `includeBreakpoints` is true) or `breakpointsUnchanged` (a number: the length of the breakpoint list, when it is false). `configurationName` and `fileName` are left out.
- `maxFrames` defaults to 5 when omitted or `undefined`. If the stack has more than `maxFrames` frames, `stackTrace` holds the first `maxFrames` rendered frames followed by one overflow marker string that states how many frames were left out and points to `get_call_stack` (exact text below). Otherwise it holds all rendered frames and no marker.
- `maxFrames` of 0 gives a stack of only the marker (when there is at least one frame). No caller passes a value other than the default; negative or fractional values need not be matched.
- Whether the breakpoint list changed is the caller's decision (`DebuggingHandler` compares it with the list it last emitted); this class only follows the flag.

### `formatBreakpointModifiers(bp)`

Collects, in this fixed order, one part for each modifier that is present: the condition (when a non-empty string), the log message (when non-empty), the hit condition (when non-empty), and a "disabled" part only when `enabled` is exactly `false` (absent `enabled` is not disabled). With no parts the result is the empty string. Otherwise the result is a space, `[`, the parts joined by a comma and a space, and `]`. Values are inserted verbatim, without escaping.

## Agent- or user-visible text

The JSON forms are returned to MCP clients inside tool replies, and the modifier suffix appears in `list_breakpoints` and in the state's breakpoint strings. None of it is shared with DebugMCP except the JSON keys and the frame format, which are identifiers and formats. No `[REWORD]` strings.

- JSON keys, exact: `sessionActive`, `configurationName`, `stackTrace`, `breakpoints`, `fileFullPath`, `fileName`, `currentLine`, `currentLineContent`, `nextLines`, `frameId`, `threadId`, `frameName`, `breakpointsUnchanged`.
- Frame string, exact format: `<name>:<line>`, `<name>:?` when the line is missing or 0.
- Overflow marker, exact (Arm): `… <n> more — get_call_stack`, with U+2026 HORIZONTAL ELLIPSIS, U+2014 EM DASH and single spaces; `<n>` is the number of frames left out. Pinned by `src/test/debugState.test.ts` (`'… 7 more — get_call_stack'`) and described in `test/acceptance-ai-efficiency.md` row 2.3 and `docs/agent-resources/debug_instructions.md` (compact state description).
- Modifier parts, exact (Arm): `when: <condition>`, `log: <logMessage>`, `hits: <hitCondition>`, `disabled`; joined with `", "` and wrapped as `" [" … "]"`. Example: `" [when: n > 0, log: n={n}, hits: >5, disabled]"`. Pinned by `src/test/debuggingHandler.test.ts`.

Surface snapshot: no entry depends on this file. With no debug session no tool reply renders a `DebugState` (no `sessionActive` key occurs in any recorded reply), and `list_breakpoints` records only the empty-list reply.

## Known bugs to preserve

All of these: preserve (fixed separately later).

1. A frame whose line is 0 renders as `name:?`, the same as a frame without a line.
2. `formatBreakpointModifiers` does not escape: a condition or log message containing `", "` or `]` makes the suffix ambiguous.
3. `toCompactString` with a `maxFrames` of 0 returns a stack consisting only of the marker; negative or fractional values produce nonsensical counts. Unreachable today.
4. Copies are shallow: frame objects are shared between the caller, the state and its clones, so mutating a frame object after `updateStackTrace` changes the state.
5. `docs/architecture/debugState.md` is out of date (immutability, before/after polling, `clone()` for comparisons). Documentation only; it is rewritten in phase 4, not in this change.

## Test cases

Pinned by existing Arm-authored tests, which must pass unchanged:

1. Given an active state with a configuration name, frame and thread ids, a location with three next lines, a frame name, 12 frames named `f0`…`f11` on lines 100…111 and two breakpoints (one with a `[when: …]` suffix), when `toString()` is parsed, then its keys are, in order, `sessionActive`, `configurationName`, `stackTrace`, `breakpoints`, `fileFullPath`, `fileName`, `currentLine`, `currentLineContent`, `nextLines`, `frameId`, `threadId`, `frameName`; `stackTrace` has 12 entries; `breakpoints` equals the two strings as stored (`src/test/debugState.test.ts`).
2. Given the same state, when `toCompactString({ includeBreakpoints: true })` is parsed, then its keys are, in order, `sessionActive`, `frameName`, `fileFullPath`, `currentLine`, `currentLineContent`, `nextLines`, `frameId`, `threadId`, `stackTrace`, `breakpoints`; `fileFullPath` is the full path; `currentLine` is 42; `stackTrace` is `f0:100` … `f4:104` followed by `… 7 more — get_call_stack`; `breakpoints` equals the stored list.
3. Given the same state, when `toCompactString({ includeBreakpoints: false })` is parsed, then there is no `breakpoints` key and `breakpointsUnchanged` is 2.
4. Given a single frame `main` on line 1, when `toCompactString({ includeBreakpoints: true, maxFrames: 5 })` is parsed, then `stackTrace` is exactly `['main:1']`.
5. Given a new instance, when either form is produced, then it equals `JSON.stringify({ sessionActive: false }, null, 2)`.
6. Given 50 frames with long names and 6 breakpoints with conditions, when both forms are produced, then the compact form (without breakpoints) is shorter than a third of the full form.
7. Given `{ enabled: true }`, when formatted, then the result is `''` (`src/test/debuggingHandler.test.ts`).
8. Given `{ enabled: true, condition: 'i == 100' }`, then `' [when: i == 100]'`.
9. Given `{ enabled: true, logMessage: 'x={x}' }`, then `' [log: x={x}]'`.
10. Given `{ enabled: false, condition: 'n > 0', logMessage: 'n={n}', hitCondition: '>5' }`, then `' [when: n > 0, log: n={n}, hits: >5, disabled]'`.
11. Given `{}`, then `''`.

Recommended additions (not pinned today):

1. Given a frame without a line and a frame with line 0, when rendered in either form, then both show `name:?`.
2. Given arrays passed to `updateBreakpoints`, `updateStackTrace` and `updateLocation`, when the caller later pushes to those arrays, then the state's arrays are unchanged; given a clone, when the original's arrays are replaced or pushed to, then the clone's are unchanged.
3. Given a populated state, when `reset()` is called, then it serialises like a new instance and all fields equal the initial values.
4. Given `sessionActive` true, `frameId` 0 and `threadId` 1, when `hasValidContext()` is called, then it returns true; with `threadId` null it returns false.
5. Given exactly 5 frames, when the compact form is produced with the default `maxFrames`, then there is no marker; given 6, then 5 frames and `… 1 more — get_call_stack`.
6. Given an empty breakpoint list and `includeBreakpoints: true`, then `breakpoints` is `[]`; with `false`, then `breakpointsUnchanged` is 0.

## Constraints

- No imports at all: no `vscode`, no `logger` (the module logs nothing), no I/O. Plain TypeScript; serialisation with the standard `JSON.stringify(value, null, 2)` semantics.
- File header: the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`, without the Microsoft line (ignore the stale "File Header" section of AGENTS.md). Remove `src/debugState.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- TypeScript strict, ES2022, Node16 modules (CommonJS output); `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport` and `npm run test:surface` must pass.
