# Test quality: the type system, tests from the specification, properties and the mutation score

Proposed 2026-11-25, against `release/2.9.4` at `dfe7887` with the Stryker
set-up of the same day (`stryker.config.mjs`, the script `test:mutation`, two
test fixes, on a branch of its own). It plans the pipeline the four findings
below ask for. Decided 2026-11-25: 1A, 2A, 3C, 4A, 5A, 6A, 7A; decision 3
differs from the recommendation, the mutation run stays local. Implemented:
decision 7, with the set-up, and pilot 1 of step 3 (see Pilot 1). Sizes as
in the other proposals: S under a day, M a few days, L a week or more.

## Problem

Four findings on tests for code that AI agents write, brought by the user on
2026-11-25 as a summary of recent studies:

1. **The oracle problem.** Tests written against the existing implementation
   do not only miss its bugs: they write the wrong behaviour into the suite and
   drop the tests that would show it. Expected values must come from the
   specification or the requirement, tests and implementation from separate
   contexts, and the assertions must be reviewed by a human.
2. **Mutation score, not coverage.** Suites with full coverage were measured
   that caught a few per cent of the mutants. For TypeScript the tool is
   StrykerJS; handing surviving mutants back to the model is the
   best-evidenced improvement loop.
3. **Property-based tests beside the examples.** Example tests miss the edge
   cases; a fifth of generated solutions failed property checks outright.
   In TypeScript: fast-check.
4. **The type system as the first test layer.** Most compiler errors in
   generated TypeScript are type errors, and agents reach for `any` about nine
   times as often as people do. So `strict`, `no-explicit-any` and the
   `no-unsafe-*` rules as a gate, and run-time validation at the boundaries.

The pipeline the summary derives: `tsc --strict` and lint as a hard gate;
tests from the specification, before or independent of the implementation;
fast-check for invariants, parsers and state machines; Stryker on the changed
code with a threshold in CI; human review of the assertions, not of the test
code around them.

## Current state, measured 2026-11-25

**Types and lint.** `tsconfig.json` has `strict` on and `tsc --noEmit` runs
in `npm run build`. `eslint.config.mjs` has five rules, all `warn`, none
type-aware, so `npm run lint` cannot fail; AGENTS.md says so and asks for a
clean output anyway. The sources outside `src/test/` use `any` in 26 places
of 11 files, most of them `src/utils/sessionStateTracker.ts` (8),
`src/debuggingExecutor.ts` (4), `src/executor/contract.ts` (3) and
`src/core/peripheralReader.ts` (3); one `eslint-disable`. Run-time
validation with zod exists at one boundary, the input schema of every MCP
tool (five files). The other boundaries are typed by assertion: the replies of
DAP requests, the answers of CMSIS Solution's API version 3
(`src/core/solutionApi.ts` detects the methods by name and trusts their
shapes, with five `as` assertions), the YAML files the CMSIS tools write
(`js-yaml` in `src/core/cmsisTarget.ts`), the control channel between
windows (`src/core/opTable.ts`, one assertion), the rows of the knowledge
index (`src/core/knowledge/store.ts`, one) and the DAP replies in
`src/debuggingExecutor.ts` (two); `src/core/svdParser.ts` checks its XML by
hand, without an assertion. Counted by grep, not read in depth.

**Tests.** 1 802 unit tests in 104 test files (283 mocha suites) run in the VS Code host
(`npm test`); 1 670 of them also run headlessly in Node with the `vscode` stub
of the transport harness, as CONTRIBUTING.md describes; six suites need more
of VS Code than the stub offers (`Disposable.from`, `LogLevel`,
`Uri.joinPath`). Three behaviour oracles pin what an agent sees
(`surface.snapshot.json`, `dap-scenarios.snapshot.json`,
`config-scenarios.snapshot.json`); they are regression pins by design and are
updated only for an intended change, named in the commit. Specifications
exist: the 17 component specs of the rewrite in `docs/provenance/specs/`, and
the proposals with their recorded decisions, each with a "Tests and
acceptance" section. Coverage goes to QLTY without a threshold.

**Mutation score.** Stryker runs since today (`npm run test:mutation`,
`stryker.config.mjs`): the sandbox copy of the checkout (about 90 MB), the
headless suites against the files of `src/core/` (103 files, 27 900 lines, 3 of
them import `vscode`). First measurement, `src/core/faultDecoder.ts`:
200 mutants, 146 killed, 54 survived, score 73 %, 2 minutes with 15 workers,
two runs identical. 84 of the 200 are static mutants (the fault tables at
module level), each tested with every suite, and 39 of them survive: 23
description texts, 8 flag names and 8 whole table rows, which no test reads
as such (the tests decode registers and look at the flags). In the first
runs a watcher test of the document service failed under the load of the
workers and killed 33 mutants by mistake; its suite is left out, and two
other tests were made safe for parallel workers. A suite that is to judge
mutants must pass in parallel with itself. The whole of `src/core/` has
29 509 mutants (dry run of 2026-11-25); at the rate of `faultDecoder.ts` that
is about five hours with 15 workers, and the run has not been made. With
everything instrumented the code is slower, and the stress test of
`symptomPattern.test.ts` ("overlapping quantifiers cannot stall a match")
passed its 2 s worker deadline; it now skips itself under instrumentation
(decision 7), since a test with a wall-clock limit cannot judge mutants.

**Properties.** None; fast-check is not installed.

**CI.** Lint, compile, build, `npm test` under xvfb, the transport tests;
Node from `engines` (22), which Stryker needs.

## The pipeline

### Step 1: the type system and lint as a hard gate (S, then M)

- `lint` becomes `eslint src --max-warnings 0`: CI and `pretest` fail on a
  warning, the rules stay as they are written. AGENTS.md's sentence about
  warnings changes.
- `@typescript-eslint/no-explicit-any` is added. The 26 places are fixed:
  `unknown` with a check where a value comes from outside, a narrowing
  function at the one boundary where VS Code's API hands out `any` (the result
  of a DAP `customRequest`), so that the `any` does not spread into the
  executor's contract.
- The type-aware rules `no-unsafe-assignment`, `-member-access`, `-call`,
  `-return` and `-argument` need `parserOptions.projectService`; lint then
  type-checks and takes longer (to be measured; it runs before every
  `npm test`). Introduced as `warn`, counted, fixed, then `error`.
- Run-time validation at the boundaries, one per release, in this order: the
  answers of CMSIS Solution's API version 3 (the seam every `cmsis_*` tool
  stands on), the YAML files of the CMSIS tools, DAP replies, the control
  channel, SVD, the knowledge index. zod is a dependency already; the schema
  of an answer is also its documentation.

Gate: `npm run lint` exits 1 on a planted `any`; the measured lint time.

### Step 2: expected values from the specification (S)

A rule for AGENTS.md, in a new section "Writing tests":

- The expected value of an assertion comes from a source outside the code
  under test: the decision of a proposal, the component spec, the Arm or CMSIS
  document (read through the documentation tools), a measurement on a real
  target. The test names the source. When implementation and expectation
  disagree, the test stays red and the disagreement is reported; the
  expectation changes only with its source.
- A test written from the implementation's output is a regression pin and
  says so. The snapshot oracles are that by design; their `--update` is named
  in the commit with the reason, and the diff of a snapshot is reviewed like
  an assertion.
- Tests and implementation come from separate contexts: the "Tests and
  acceptance" section of a proposal is the test specification, each line a
  test name; the tests are written from it in a session or worktree of their
  own, the implementation in another, and a reviewer reads the assertions
  against the proposal. The repository works with worktrees per branch
  already, so this costs a convention, not a tool.

### Step 3: property-based tests with fast-check (M)

`fast-check` as a devDependency (MIT, no run-time dependency); its properties
run inside the mocha suites, with the seed printed on a failure and a small
`numRuns` in the VS Code host. Three pilots, each measured by its module's
mutation score before and after:

1. `src/core/faultDecoder.ts`: for any 32-bit register value, every set bit
   appears exactly once among the decoded flags, under the bit name the Arm
   architecture reference manual gives it (the CFSR, HFSR and DFSR tables,
   read through the documentation tools, never from the module's own table:
   a property that reads the table it tests survives every table mutant),
   and no other flag does; zero names no fault.
2. `src/core/svdParser.ts` with `svdLookup.ts`: an SVD generated from a model
   (peripherals, registers, fields within the register width) parses back to
   the model; the field masks of a register never overlap; a lookup by name
   and one by address agree.
3. `src/utils/markerBlock.ts` and `src/utils/secretRedaction.ts`: inserting a
   block and removing it is the identity on any text, inserting twice equals
   inserting once; a secret never appears in the redacted output, and
   redacting twice changes nothing.

Further candidates, after the pilots: `src/core/textBudget.ts` (the output
fits the budget and is a prefix of the input), `src/core/gdbDialect.ts`
(parsing of GDB replies), `src/core/buildInfo/mapFile.ts` and `elf.ts`
(parsers over generated inputs), `src/core/problemCodes.ts`,
`src/core/opTable.ts`; and, as model-based tests with fast-check's commands,
the state machines `src/core/serialLease.ts`, `src/cmsisJobTracker.ts`,
`src/utils/sessionStateTracker.ts` and `src/core/gdbPortReservations.ts`.
The rule afterwards: a parser, a decoder or a state machine gets a property
test beside its examples.

### Step 4: the mutation score on changed code, with a threshold (M)

The set-up of 2026-11-25 is the base.

- **Baseline first.** One run over the whole of `src/core/`, overnight
  (`--ignoreStatic` for a quick first pass, the full run after), and the score
  of every module into a table of this proposal. The threshold comes from
  that data, not from a guess.
- **No CI job** (decision 3C): the run stays local. The threshold is the
  baseline table, which the loop below reads; a module whose score falls
  below its baseline entry is a finding of the review, not of a job. The
  pull-request job sketched here (Linux, headless, Node 22, `--mutate` over
  the changed files of `src/core/`, `thresholds.break` as the gate) stays as
  the option for a later decision.
- **The loop with the agent**, a rule in AGENTS.md: after a change under
  `src/core/`, run `test:mutation -- --mutate <file>`, read the survivors in
  `reports/mutation/mutation.json`, and for each either write a test whose
  expected value comes from the specification (step 2) or state why the mutant
  is equivalent. Never a test that asserts the current output in order to kill
  a mutant: that is the oracle problem in a new form.
- **Scope.** The stub `test/transport/vscode-stub.js` gets `Disposable.from`,
  `LogLevel` and `Uri.joinPath`, so that the six excluded suites run headlessly
  and `src/debuggingHandler.ts`, `src/handler/` and `src/utils/` can be
  mutated too; the modules outside `src/core/` that import no `vscode`
  (`debugState`, `debugMCPServer`, `controlServer`, `routingDebuggingHandler`,
  `docService/emulator`, `utils/*`) can be added at once. A suite joins only
  when it passes in parallel with itself; the document service's watcher test
  is the open case.
- **Tests with a wall-clock limit** step aside under instrumentation
  (`'__stryker__' in globalThis`) instead of their suite being left out, so
  that the module's other tests keep judging its mutants; done on 2026-11-25
  for the stress test of `symptomPattern.test.ts`.
- **The TypeScript checker of Stryker** (`@stryker-mutator/typescript-checker`)
  marks a mutant that does not compile instead of counting it as survived; it
  is not installed. With step 1 more mutants are type errors, so it comes with
  step 1, at the cost of one type check per mutant.

### Step 5: review of the assertions (S)

- The pull-request template's checklist: "Assertions reviewed against the
  specification or proposal they come from; snapshot updates named in the
  commit with the reason"; the box "covered by unit tests" adds "and the
  mutation score of the changed module did not fall".
- A helper `scripts/assertion-diff.ts`, optional: prints the changed
  `assert.*` and `fc.property` lines of a diff with the names of their tests,
  so the review reads the assertions and not the scaffolding.

## Pilot 1, done 2026-11-25: `faultDecoder.ts`

- The bit model of the five status registers was transcribed by hand from
  the Armv8-M manual DDI0553B.z (CFSR p.1477, MMFSR p.1740-1741, BFSR
  p.1467-1469, UFSR p.1897-1899, HFSR p.1671-1672, DFSR p.1529-1530) and the
  Armv7-M manual DDI0403E.e (p.609-610, p.613, p.699), both read through the
  documentation tools; the Armv7-M manual was fetched into the document
  service that day. CMSIS Core 6.3.0 gives the `MMARVALID` spelling the
  decoder keeps, where Armv8-M says `MMFARVALID`.
- The first property found a gap in the code, not in the tests: `DFSR.PMU`,
  bit 5, the PMU counter overflow debug event of Armv8.1-M, was not decoded;
  fast-check's counterexample was `{DFSR: 32}`. The test stayed red, as step 2
  asks, until the row was added in a commit of its own with a changelog line.
- Scores, `--mutate src/core/faultDecoder.ts`, measured on the final code
  (203 mutants, the PMU row included) with the tests selected by name: the
  suite as it was, 72.4 % (147 killed, 56 survived); with the three properties
  from the manuals added, 83.3 % (169 killed), so the specification bought 22
  of the 56; with the pins as well (the class precedence, BFAR first, the
  report layout, the three examples, the line of every bit), 99.5 % (202
  killed), the same in three runs. Before any of it, at `dfe7887`, the module
  had 200 mutants and 73 %.
- The one survivor is equivalent: the default `exclude = []` of `has()` is
  used only by callers that pass no list, so `["Stryker was here"]` excludes
  nothing that exists. It is reported here, not silenced in the source.
- Side result: `symptomPattern.ts` with its suite back in the run (decision
  7) scores 87.9 % (426 of 506 killed, 19 timeouts, 61 survived), from 58.5 %
  without it.
- Cost: not measured. The manuals were seven register pages of two
  documents, read through the documentation tools.

## Order

1. Step 1, the lint gate with `no-explicit-any` (S); the type-aware rules and
   the first boundary follow (M).
2. Step 2 and step 5, the rules and the template (S).
3. Step 4, the baseline run (machine time) and the loop rule (S).
4. Step 3, the three pilots (M), measured against the baseline.
5. The stub extension and the wider mutation scope (S to M).

## Decisions for you

1. **Lint as a gate.** A: `--max-warnings 0` with the rules as written, plus
   `no-explicit-any` (recommended). B: switch every rule to `error`. C: leave
   the lint as it is.
2. **Type-aware rules.** A: the five `no-unsafe-*` rules, `warn` until the
   count is fixed, then `error`, if lint stays under about 30 s (recommended).
   B: not now.
3. **Stryker in CI.** A: a pull-request job over the changed files of
   `src/core/` with `thresholds.break` from the baseline (recommended).
   B: a nightly full run that reports and never fails. C: local only, as today.
   Decided: C.
4. **fast-check pilots.** A: the three named (recommended). B: `faultDecoder`
   alone. C: not now.
5. **The oracle rule.** A: the rule in AGENTS.md, the proposal's acceptance
   section as test specification and the template's checkbox (recommended).
   B: the rule alone. C: A, and separate sessions for tests and implementation
   as a requirement, not a convention.
6. **The stub extension**, so that the handler layer can be mutated. A: yes,
   with step 4 (recommended, S). B: later.
7. **The stress test under instrumentation.** A: the test skips itself when
   Stryker's instrumentation is loaded, and its suite returns to the mutation
   run (recommended, S). B: the suite stays out, and the symptom pattern
   module is judged by the knowledge search suites alone: they cover 416 of
   its 506 mutants (90 uncovered, 120 survived, score 58.5 %, measured
   2026-11-25). Decided: A, implemented the same day.

## Tests and acceptance

- A planted `any` in `src/` turns `npm run lint` and the CI lint job red.
- `faultDecoder.ts` reaches at least 90 % with the properties of pilot 1 and
  a decision on the 23 description texts. Done 2026-11-25: 99.5 %, the texts
  pinned by a test that says so, see Pilot 1.
- Two runs of `test:mutation` over the same file give the same survivors, as
  they do today.
- The baseline table of step 4 is in this proposal, with the date of the run.

## Out of scope

- The suites of the VS Code host stay as they are; `npm test` is unchanged.
- A coverage threshold at QLTY: the mutation score replaces coverage as the
  measure, as finding 2 asks.
- Mutation of `src/extension.ts` and the window routing, which need VS Code.
