# Spec: src/utils/workspaceRegistry.ts

This is a file-based registry of the CMSIS Developer Assistant windows running on this machine for this user's temp directory. Each window writes one small JSON file that says how to reach its control server (port and token), which workspace folders it has open, and whether it holds a debug session. The router reads all the files to decide which window a tool call belongs to. Every read also prunes entries whose process is gone or that stopped refreshing. The module also formats the one-line description of a window that agents see in window listings and routing errors, and it exports the process-liveness probe that other modules reuse.

## External contract

### Exports

```ts
export interface WindowRegistration {
    pid: number;
    controlPort: number;
    controlToken: string;
    workspaceFolders: string[];
    name: string;
    updatedAt: number;
    hasActiveSession?: boolean;
    activeConfigurationName?: string;
    cmsisProject?: string;
}

export type ResolutionReason = 'path' | 'pinned' | 'cached' | 'active-session' | 'only-window';

export function isProcessAlive(pid: number): boolean;

export type LivenessCheck = (pid: number) => boolean;

export class WorkspaceRegistry {
    constructor(pid?: number, registryDir?: string, isAlive?: LivenessCheck);
    register(reg: Omit<WindowRegistration, 'pid' | 'updatedAt'>): void;
    heartbeat(): void;
    unregister(): void;
    list(): WindowRegistration[];
    findByPath(targetPath: string): WindowRegistration | undefined;
    findSoleActiveSession(): WindowRegistration | undefined;
    findSoleWindow(): WindowRegistration | undefined;
    findByPid(pid: number): WindowRegistration | undefined;
    findByWorkspaceFolder(folder: string): WindowRegistration | undefined;
    isLive(entry: WindowRegistration): boolean;
}

export function describeWindow(entry: WindowRegistration): string;
```

- The constructor parameters default to `process.pid`, the default registry directory (see Registry file format) and `isProcessAlive`. All three are positional; tests and the transport harness pass them in this order.
- Users:
  - `src/windowCoordinator.ts`:
    - `new WorkspaceRegistry()`, or an injected instance through `CoordinatorOptions.registry`, whose type is `WorkspaceRegistry`.
    - `register(...)` on every publish.
    - `heartbeat()` every 20 s (`HEARTBEAT_MS`).
    - `unregister()` in `dispose()`, before the servers stop.
    - It passes the instance to `RoutingDebuggingHandler`.
  - `src/routingDebuggingHandler.ts` uses `WindowRegistration`, `ResolutionReason`, `describeWindow`, `list`, `findByPath`, `findByPid`, `findByWorkspaceFolder`, `findSoleActiveSession`, `findSoleWindow` and `isLive`.
  - `src/utils/skillInstaller.ts` uses `isProcessAlive` as its default liveness check when it sweeps other processes' staging directories.
  - `src/test/windowCoordinator.test.ts` calls `new WorkspaceRegistry(process.pid, dir)`.
  - `src/test/routing.test.ts` calls `new WorkspaceRegistry(process.pid, dir, isAlive)` with a stub check.
  - `src/test/workspaceRegistry.test.ts`.
  - `test/transport/surface-snapshot.js` calls `new WorkspaceRegistry(3999001, dir, pid => live.has(pid))`.
  - `test/transport/two-window-routing.js` calls `new WorkspaceRegistry(pid, dir, () => true)`, then `list()`, and reads `hasActiveSession`, `workspaceFolders` and `name`. Both harnesses load `out/src/utils/workspaceRegistry.js`.
- No other module imports `LivenessCheck`. Keep it exported, because it types the constructor parameter.

### Registry file format

This is a cross-version contract. Windows running different versions read each other's files, so keep every item exactly.

- **Directory:** `path.join(os.tmpdir(), 'cmsis-developer-assistant-registry')` unless a directory is injected. Writers create it on demand, recursively, with no explicit mode.
- **File name:** `window-<pid>.json`, where `<pid>` is the pid given to the constructor (normally `process.pid`). One file per window.
- **Content:** a single UTF-8 JSON object, written compactly (no indentation, no trailing newline).
  - Required fields:
    - `pid`: number.
    - `controlPort`: number, the port of the window's control server.
    - `controlToken`: string, sent back verbatim in `x-cmsis-developer-assistant-token`.
    - `workspaceFolders`: string array of absolute file-system paths, possibly empty.
    - `name`: string.
    - `updatedAt`: number, milliseconds since the epoch.
  - Optional fields: `hasActiveSession` (boolean), `activeConfigurationName` (string), `cmsisProject` (string). An optional field whose value is undefined is left out.
  - Key order is not significant. Current writers emit the registration's fields in the order given, then `pid`, then `updatedAt`.
  - Readers must accept unknown extra fields and pass them through untouched. Future versions may add fields, for example the `_note` field of #19.
- **Identity:** the `pid` field inside the file identifies the window, not the file name. Every file named `window-*.json` is read as a registration, whatever sits between the prefix and `.json`. The tests rely on this: they write `window-alpha.json`, `window-nested.json` and so on.
- **Atomic write:** writers go through `writeFileAtomicSync` from `src/utils/atomicFile.ts`, so a reader never sees a torn file. That function writes a temp file named `<file>.<writer pid>.<8 lowercase hex>.tmp` in the same directory, then renames it over the target. `isTempPath` recognises these names.
- **Refresh:** the owning window rewrites its file with a fresh `updatedAt` every 20 s (`HEARTBEAT_MS`, in `src/windowCoordinator.ts`). It also re-registers when a debug session starts or ends and when the workspace folders change.
- **Staleness:** `STALE_MS` = 60 000 ms. An entry is stale when `now − updatedAt > 60 000`.
- **Pruning on read:** every `list()` applies these rules to each directory entry, in directory-listing order (no sorting):
  1. A temp-file name (`isTempPath`) is never listed. It is deleted when its mtime is more than 60 s old, and left alone otherwise. This check comes before the name filter in rule 2.
  2. A name that does not start with `window-` or does not end with `.json` is ignored and not deleted.
  3. A file that cannot be read or parsed, or whose parsed value cannot be inspected (for example JSON `null`), is skipped. It is deleted only when its mtime is more than 60 s old, because a fresh one may be a peer's write in flight. If the mtime cannot be read, the file is not deleted.
  4. An entry whose `pid` fails the liveness check is deleted. This applies to the reader's own pid too.
  5. A stale entry whose `pid` is not the reader's own pid is deleted, even when the process is alive (see Known bugs). The reader's own entry is never pruned for staleness.
  6. Every other entry is returned as parsed, with no schema validation.
- Deleting a file that has already gone (a peer pruned it first) is silently ignored.

## Behaviour

### isProcessAlive

`isProcessAlive(pid)` probes the pid with signal 0 through `process.kill(pid, 0)`:

- It returns `true` when the probe succeeds.
- It returns `true` when the probe fails with code `EPERM`, because the process exists but belongs to someone else.
- It returns `false` on any other failure.

There is no special handling of pid values; they behave as `process.kill` makes them behave.

### Constructor

The constructor stores the pid, the directory, the liveness check and the path of its own file, `<dir>/window-<pid>.json`. It has no file-system side effects.

### register

- `register(reg)` creates the directory recursively (no mode).
- It builds the entry from all fields of `reg`, plus `pid` = the constructor pid and `updatedAt` = `Date.now()`. These two override any same-named field of `reg`.
- It writes the entry atomically as compact JSON and remembers it as this window's current registration.
- On any failure it logs an error (text 1) with the error and does not throw. The remembered registration changes only when the write succeeds.

### heartbeat

- `heartbeat()` does nothing (no directory, no file, no log) if this instance has no remembered registration: never registered, or unregistered since.
- Otherwise it creates the directory recursively again, updates the remembered registration's `updatedAt` to `Date.now()` (in memory, even if the write then fails), and writes the remembered registration atomically.
- It never reads the file back. A registration that a peer deleted by mistake therefore reappears on the next beat.
- On failure it logs an error (text 2) and does not throw.

### unregister

`unregister()` forgets the remembered registration and deletes this window's file. A missing file is ignored. It never throws.

### list

`list()` returns the live registrations, applying the pruning rules above as a side effect.

- If the directory cannot be read (for example it does not exist yet), `list()` returns `[]` and does not throw.
- The order is the order in which `fs.readdirSync` returns the names. Do not sort: the listing order is visible in `list_debug_windows`, and it decides ties in `findByPath` and `findByPid`.
- Every finder below calls `list()` once, so each finder call also prunes.

### findByPath

`findByPath(targetPath)` finds the window whose workspace folder most deeply contains the path.

- **Normalisation**, applied to the target and to every folder:
  1. `path.resolve`. A relative path therefore resolves against the extension host's working directory.
  2. On `win32` only, lower-case the result.
  3. Strip every trailing `/` or `\`. The root `/` therefore normalises to the empty string.
- **Containment:** a folder contains the target when the normalised target equals the normalised folder, or starts with the normalised folder followed by `path.sep`, or starts with it followed by `/`. `/w/blinky-old/x` is therefore not inside `/w/blinky`.
- **Choice:** scan the entries in `list()` order, and each entry's folders in order. The entry with the longest containing normalised folder wins. A later folder must be strictly longer to replace the current best, so on a tie the first one seen wins.
- **Fallback:** when no folder contains the target, and exactly one live entry exists, and that entry has zero workspace folders, return it. Only a window with no folder open can be chosen for a path it does not contain. Otherwise return `undefined`.

### findSoleActiveSession

`findSoleActiveSession()` returns the one live entry with a truthy `hasActiveSession`. When there are none, or more than one, it returns `undefined` and never guesses.

### findSoleWindow

`findSoleWindow()` returns the only live entry. When there are zero entries, or two or more, it returns `undefined`.

### findByPid

`findByPid(pid)` returns the first live entry whose `pid` equals the argument, or `undefined`.

### findByWorkspaceFolder

`findByWorkspaceFolder(folder)` is exactly `findByPath(folder)`, including the folderless fallback. It therefore accepts the folder itself or any path inside it.

### isLive

`isLive(entry)` returns `true` when `findByPid(entry.pid)` finds an entry whose `controlPort` equals `entry.controlPort`.

- Nothing else is compared: not the token, the folders or `updatedAt`.
- A window that restarted with a new port is therefore not live under its old registration.

### describeWindow

`describeWindow(entry)` returns one line whose parts are joined by ` | ` (space, vertical bar, space):

1. `pid=<pid>`
2. The workspace folders joined by a comma and a space, or `(no folder open)` when the list is empty.
3. Only when `hasActiveSession` is truthy: `debugging`, followed by `: <activeConfigurationName>` when that name is non-empty.
4. Only when `cmsisProject` is non-empty: `cmsis=<cmsisProject>`.

`name`, `controlPort` and the token never appear. Examples:

```text
pid=4242 | /proj/blinky
pid=4242 | (no folder open)
pid=4242 | /proj/a, /proj/b | debugging: AppKit-E8 Debug | cmsis=/proj/blinky/blinky.csolution.yml
pid=4242 | /proj/blinky | debugging
```

### ResolutionReason

The type has no behaviour here. The router tags each routing decision with one of its values, and the value appears in the router's log line.

## Agent- or user-visible text

The `describeWindow` output reaches agents through `list_debug_windows`, `select_debug_window` and every routing error. Its literals are `pid=`, the part separator (space, vertical bar, space), the folder separator (comma, space), `(no folder open)`, `debugging`, the configuration separator (colon, space) and `cmsis=`, as specified above. The tests assert `/pid=4242/`, `/no folder open/`, `/debugging: AppKit-E8 Debug/` and `/cmsis=\/proj\/blinky\/blinky\.csolution\.yml/`. None of these literals is shared with DebugMCP.

Log lines go to the output channel through `logger.error(message, error)`:

1. [REWORD] Registering this window's entry failed. The current wording matches DebugMCP's apart from the product name.
2. `Failed to refresh CMSIS Developer Assistant registry entry`. The heartbeat write failed.

## Known bugs to preserve

Each item below: preserve (fixed separately later). The rewrite must not change any of them.

1. **`list()` deletes stale entries of live processes** (#14). An entry older than 60 s is deleted by the first peer that reads it, even though its pid is alive. This hides a wedged router whose extension host stopped refreshing. The heartbeat heals the entry only if the owner recovers.
2. **File and directory modes** (#19).
   - The directory is created without a mode, and `writeFileAtomicSync` writes without one, so the umask decides: typically 0755 and 0644. The plaintext `controlToken` is then readable by other local users wherever `os.tmpdir()` is shared.
   - The directory name is not per-user.
   - Nothing checks the directory's ownership, or whether it is a symlink.
   - Keep calling `writeFileAtomicSync` with no mode option.

## Test cases

These cases live in `src/test/workspaceRegistry.test.ts`, suite "Workspace registry".

- **Fixture:**
  - Each test gets a fresh temp directory (`fs.mkdtempSync` under `os.tmpdir()`), removed in teardown.
  - Registries are created as `new WorkspaceRegistry(pid, dir)` with the real liveness check, unless a case says otherwise.
  - A `register` helper fills `controlPort` (a distinct number per call, from 40000), `controlToken`, `workspaceFolders: []` and `name`, with per-test overrides.
  - "Write an entry directly" means writing a `WindowRegistration` with `pid: process.pid` and `updatedAt: Date.now()` into `window-<label>.json` without going through `register`.

### Registration and pruning

1. **Round trip.**
   - Given a registry for `process.pid` that registered folder `/proj/blinky`,
   - when `list()` is called,
   - then it returns exactly one entry, with `pid === process.pid` and `workspaceFolders` deep-equal to `['/proj/blinky']`.
2. **Unregister.**
   - Given a registered window,
   - when `unregister()` is called,
   - then `list()` returns `[]`.
3. **Dead process.**
   - Given a registry for pid 999 999 (assumed not to exist) that registered, and a registry for `process.pid` that registered,
   - when the second one lists,
   - then only `process.pid` is returned, and the dead entry is pruned.
4. **A fresh torn file survives.**
   - Given a file `window-123.json` containing `{"pid": 1` (not valid JSON) and a registered window,
   - when `list()` is called,
   - then it returns one entry, and `window-123.json` still exists.
5. **An old torn file is pruned.**
   - Given `window-123.json` containing `not json at all`, with mtime and atime set 120 s in the past, and a registered window,
   - when `list()` is called,
   - then it returns one entry, and the file is gone.
6. **Atomic write, and a heartbeat that heals.**
   - Given a registered window,
   - then no `*.tmp` file is left in the directory.
   - When its own file is deleted and `heartbeat()` is called, then `list()` returns one entry whose `updatedAt` is at least the value first written.
   - Given a registry for `process.pid + 1` that never registered, when it calls `heartbeat()`, then no `window-<process.pid + 1>.json` exists.
7. **Temp files of a crashed writer.**
   - Given `window-77.json.77.deadbeef.tmp` with its mtime 120 s in the past, `window-78.json.78.cafebabe.tmp` fresh, and a registered window,
   - when `list()` is called,
   - then it returns one entry (temp files are never listed), the stale temp file is gone and the fresh one remains.

### findByPath cases

1. **Inside a folder.**
   - Given a window registered with folder `<dir>/blinky`,
   - when `findByPath('<dir>/blinky/src/main.c')` is called,
   - then it returns that window.
2. **Deepest folder wins.**
   - Given a registered window with folder `<dir>/work`, and an entry named `nested` written directly with folder `<dir>/work/blinky` and the same pid,
   - when `findByPath('<dir>/work/blinky/main.c')` is called,
   - then it returns the entry named `nested`.
3. **Separator-aware prefix.**
   - Given a window with folder `<dir>/blinky`,
   - when `findByPath('<dir>/blinky-old/main.c')` is called,
   - then it returns `undefined`.
4. **No match.**
   - Given a window with folder `<dir>/blinky`,
   - when `findByPath('/somewhere/else/main.c')` is called,
   - then it returns `undefined`.
5. **Sole folderless fallback.**
   - Given exactly one window, registered with no folders,
   - when `findByPath('/anything.c')` is called,
   - then it returns that window.

### Routing helpers

In these cases the entries are written directly, all with `pid: process.pid` and distinct ports.

1. **The sole active session is found.**
   - Given entry `idle` (`hasActiveSession: false`) and entry `busy` (`hasActiveSession: true`),
   - when `findSoleActiveSession()` is called,
   - then it returns `busy`.
2. **Two active sessions: no guess.**
   - Given two entries, both with `hasActiveSession: true`,
   - when `findSoleActiveSession()` is called,
   - then it returns `undefined`.
3. **No active session.**
   - Given one entry with `hasActiveSession: false`,
   - when `findSoleActiveSession()` is called,
   - then it returns `undefined`.
4. **findSoleWindow.**
   - Given one entry `only`, then `findSoleWindow()` returns it.
   - After a second entry is written, it returns `undefined`.
5. **isLive follows the port.**
   - Given entry `w` with port 42008, then `isLive(entry)` is `true`.
   - When `window-w.json` is rewritten with port 49999, then `isLive` of the original entry is `false`.

### describeWindow cases

The base entry for these cases is pid 4242, folders `['/proj/blinky']`, name `blinky`.

1. **pid and folders.** The output matches `/pid=4242/` and `/\/proj\/blinky/`.
2. **Folderless.** With `workspaceFolders: []`, the output matches `/no folder open/`.
3. **Active session.** With `hasActiveSession: true` and `activeConfigurationName: 'AppKit-E8 Debug'`, the output matches `/debugging: AppKit-E8 Debug/`.
4. **CMSIS project.** With `cmsisProject: '/proj/blinky/blinky.csolution.yml'`, the output matches `/cmsis=\/proj\/blinky\/blinky\.csolution\.yml/`.

### Transport harness dependencies

These tests are not rewritten, but they must stay green.

- `test/transport/surface.snapshot.json`:
  - Shape `routed-no-window`: an existing empty registry directory must make `list()` return `[]`. Every routed tool, `list_debug_windows` and `select_debug_window` then produce the no-window texts.
  - Shape `routed-one-worker`:
    - The harness itself writes a file `window-3999002.json` with only the six required fields.
    - With the injected liveness check it must be listed.
    - `findByPath('/nonexistent/main.c')` must return `undefined`, because the sole window has a folder.
    - `describeWindow` must render `pid=<n> | <tmp>`.
- `test/transport/two-window-routing.js`:
  - Two registries with pids 600001 and 600002 share one directory, and `list()` returns both.
  - A folder name containing `😀` must survive the JSON file round trip.
  - After a republish, exactly one entry has `hasActiveSession`, with `workspaceFolders[0]` equal to that folder.
  - `describeWindow` renders `debugging: AppKit-E8 Debug`.
  - `unregister()` in `dispose()` must remove the router's entry.

## Constraints

- Node APIs, synchronous throughout:
  - `fs`: `mkdirSync` with `recursive`, `readdirSync`, `readFileSync`, `statSync().mtimeMs`, `unlinkSync`.
  - `os.tmpdir()`, `path` (`resolve`, `join`, `sep`), `process.kill(pid, 0)` and `process.platform`.
- Every public method is synchronous and none of them throws.
- Write through `writeFileAtomicSync`, and recognise temp files with `isTempPath` from `src/utils/atomicFile.ts`. Do not implement a second temp-file scheme.
- Log through `logger` from `src/utils/logger` (`error(message, error)`), never `console`.
- File header: the Arm Apache-2.0 block comment exactly as in lines 1–15 of `src/core/toolRun.ts`, with no Microsoft line. The rewritten `src/test/workspaceRegistry.test.ts` takes the same header and uses the mocha TDD interface (`suite`, `test`, `setup`, `teardown`) like every file in `src/test`.
- Remove `src/utils/workspaceRegistry.ts` and `src/test/workspaceRegistry.test.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change.
- Acceptance: `npm run compile`, `npm run lint`, `npm test` and both transport harnesses pass, and `npm run provenance:check -- --gate` passes (at most 3 shared non-trivial lines per file).
