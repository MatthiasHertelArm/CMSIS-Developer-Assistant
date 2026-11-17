# Timing reference: CMSIS Solution API version 3

How long the calls of CMSIS Solution's API version 3 take, compared with reading
`.cmsis/tools-environment.yml` and with the hidden commands they replace. Written
for the decision in 2.9.1 phase 4.3: should the tools environment come from the
API (`getToolsEnvironment`) instead of the file, and when.

## How it is measured

`runner.js` starts a VS Code in an isolated profile: its own extensions folder
(copies of the extensions it is given), its own user data, and a copy of the
workspace. Neither the user's VS Code nor the project is changed. `probe/run.js`
runs inside it as extension tests:

1. CMSIS Solution is activated and `getApi(3)` taken.
2. The first `getToolsEnvironment()` and `getToolchains()` of the window are timed
   ("cold").
3. The probe waits for the solution to load (`getSolutionFile`).
4. It runs `environment-manager.reactivate` on the workspace's
   `vcpkg-configuration.json` (what `cmsis_action activate_environment` does), and
   times a `getToolsEnvironment()` issued 200 ms into it.
5. Each call below is then repeated 40 times in a row ("warm"); median, p95 and
   maximum are recorded.
6. The API's environment text is compared with the file. Only lengths and tool
   names are recorded, never the text, since it can hold expanded secrets.

Run 1 to 3 had no step 4; run 4 and 5 had it. The results are under
[`results/`](results/).

## Reference, 2026-11-16

Setup: MacBook (Apple silicon), macOS, VS Code 1.146.0 (the test build of this
repository), CMSIS Solution nightly `1.72.1-86-20261109`, Arm Environment Manager
1.26.0, CMSIS Debugger 1.10.1. Workspace: a copy of a micro:bit Blinky
(`vcpkg-configuration.json`: CMSIS-Toolbox, Arm Compiler 6, CMake, Ninja); every
vcpkg artefact was already in `~/.vcpkg`, so nothing was downloaded.

### Warm calls (40 in a row, ms)

| Call | Median | p95 | Max |
|---|---|---|---|
| file: `fs.readFileSync(tools-environment.yml)` | 0.023–0.037 | 0.033–0.145 | 0.15 |
| file: `fs.promises.readFile(tools-environment.yml)` | 0.12–0.49 | 0.16–7.4 | 11.5 |
| API `getToolsEnvironment()` | 0.77–1.99 | 1.07–2.4 | 6.6 |
| API `getToolchains()` | 0.075–0.13 | 0.10–0.16 | 0.26 |
| API `getCbuildRunFile()` | 0.058–0.083 | 0.08–0.19 | 0.28 |
| command `cmsis-csolution.getCbuildRunFile` | 0.054–0.082 | 0.07–0.15 | 0.17 |
| API `getActiveTarget()` | 0.105–0.14 | 0.22–0.38 | 0.55 |
| command `cmsis-csolution.getActiveTargetSet` | 0.10–0.14 | 0.13–0.22 | 0.70 |
| API `getTargets()` | 0.000–0.003 | 0.004–0.018 | 0.10 |
| API `getDebuggers()` | 5.8–9.5 | 8.7–17.3 | 23.6 |

Ranges span the five runs.

### Cold and during activation (ms)

| Moment | Time |
|---|---|
| First `getToolsEnvironment()` of the window: it activates the Environment Manager | 187–332 |
| First `getToolchains()` right after | 0.2–0.5 |
| `getToolsEnvironment()` issued 200 ms into `environment-manager.reactivate` | 2.3 |
| `environment-manager.reactivate` itself, artefacts cached | 41–47 |

## What it says

- **Warm, the API costs about 1 ms, the file 0.03 to 0.5 ms.** The API is 2 to 50
  times slower than the file, but still about a millisecond: no reason to avoid it
  for speed.
- **The first call of a window costs 0.2 to 0.33 s**, because it activates the
  Environment Manager. Later calls do not.
- **The getters of version 3 cost what the hidden commands cost.** They delegate to
  the same commands (measured equal within 0.03 ms).
- **`getDebuggers()` reads `debug-adapters.yml` on every call** (6 to 10 ms).
- **The API can be *less* complete than the file.** In the fresh profile the
  Environment Manager did not activate the project's vcpkg tools by itself. For 180 s
  (run 1 to 3) `getToolchains()` answered `[]`, and `getToolsEnvironment()` listed
  only pyOCD, CMSIS-Toolbox and GDB with 3 PATH entries. The file, written by an
  earlier conversion, listed Arm Compiler 6, CMake and Ninja with 7. After
  `environment-manager.reactivate` the API listed 6 tools and 6 PATH entries, and
  CMSIS Solution rewrote the file to the same text. A rule "API and file differ:
  take the API" would have chosen the poorer environment in runs 1 to 3.

## Not covered

- A reactivation that downloads artefacts. The wait inside `getToolsEnvironment()`
  (`waitUntilReady`) lasts as long as the download; here everything was cached, and
  the call 200 ms into the reactivation answered in 2.3 ms because the reactivation
  had already finished after about 45 ms.
- The user's own profile. There the Environment Manager may activate the project's
  tools at start, and the cold numbers may differ.
- Windows and Linux.
- The board. None of these calls touches the target.
