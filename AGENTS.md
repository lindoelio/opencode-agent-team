# AGENTS.md

Working notes for OpenCode sessions in this repo.

## What this is

`@lindoelio/opencode-agent-team` — a single npm package implementing an OpenCode
2.x plugin ("Agent Team Method"). Not a monorepo, no workspaces: one package, one `src/`.

- `src/` — plugin source. `src/index.ts` is the entrypoint (`Plugin.define` → registers
  commands, skills, tools, hooks).
- `assets/` — runtime *data*, not code: `agents/` (10 markdown templates), `skills/<id>/SKILL.md`,
  `templates/`. Materialized into a consumer project by `/agent-team/setup`.
- `schemas/` — **generated output**. Edit the Zod source in `src/domain/schemas.ts`, then
  `npm run schemas:generate`. Never hand-edit `schemas/*.json`.
- `bench/` — AgentTeamBench: cases, rubric, runner. `bench/results/` = recorded real-model runs.
- `test/` — mirrors `src/` (unit / integration / security / snapshots / e2e).
- `fixtures/` — sample projects for the bench and e2e. `fixtures/**/*.test.ts` is also
  collected by vitest.

## Commands

```bash
npm run verify          # typecheck → test:coverage → bench → pack:check. The gate.
npm run typecheck       # tsc --noEmit
npx vitest run          # all tests
npx vitest run test/unit test/integration          # the suites CI runs per SDK line
npx vitest run test/unit/gates.test.ts             # one file
npm run schemas:generate # after any Zod schema change
npm run bench           # dry mode: validates case definitions only, never scores
npm run compat:check    # builds + tests against SDK 2.0.10, 2.1.4, 2.2.0
```

Order matters in one place only: a schema change without regenerating fails the drift test,
and a coverage drop fails the thresholds. Both surface in `npm run verify`.

### Opt-in suites (real CLI + real model budget)

```bash
npm run test:e2e     # AGENT_TEAM_E2E=1; needs the `opencode` CLI on PATH
npm run bench:model  # AGENT_TEAM_BENCH=1; scores the method against a real model
```

`test/e2e/*` skips itself unless `AGENT_TEAM_E2E=1` **and** `opencode` is on PATH. A skipped
e2e suite is an environment condition, not a bug to fix.

## Agent Constraints

**Coverage gates are tight and enforced.** `vitest.config.ts` fails `test:coverage` below
98% statements/lines/functions and 87% branches (currently ~98.2 statements, ~88.1 branches).
New code without a test breaks `npm run verify`. See [TESTING.md](TESTING.md).

**`tsx` is not a dependency.** `npm run schemas:generate`, `npm run compat:check` and the
`npm run bench` fallback all shell out to `npx tsx`, which downloads on first use — they need
network. The `node --experimental-strip-types` prefix in the `bench` script does **not** work
here (source imports use `.js` specifiers that don't resolve to `.ts` files); the `npx tsx`
fallback is the real path.

**The redactor destroys keys matching `/token/i`** (also `secret`, `password`, `api_key`,
`authorization`, `bearer`). `redactUnknown` in `src/ledger/redaction.ts` replaces the *value*
of any matching key, so a field named `inputTokens` silently becomes `"[REDACTED]"` before it
reaches disk. Name usage counters `input` / `output`. See [SECURITY.md](SECURITY.md).

**Every ledger document write goes through `writeLedgerDocument` in `src/ledger/store.ts`.**
That is where redaction happens. Writing a new document type any other way bypasses
redaction — that was a real leak fixed in 0.4.0. The one exception is the setup
backup directory — `.agent-team/setup-backups/` in a project and
`<globalConfigDir>/.agent-team/setup-backups/` in the global scope — which copies a file the
user already has in plaintext; it is a backup, not a ledger document, and it is deliberately
byte-for-byte.

**Host APIs must compile on three SDK lines.** `npm run compat:check` builds and tests against
`@opencode/plugin` 2.0.10, 2.1.4 and 2.2.0. Surfaces absent from the older typings (e.g.
`ctx.experimental.generate`, 2.2.x only) must be read through an `unknown` view with feature
detection, like `resolveTextGenerator` in `src/compat/host.ts`. Never assume a host surface
exists at compile time.

**Never spawn the `opencode` CLI from a unit or integration test.** A real run creates a
real session in the developer's own OpenCode store; a run against a model that does not
exist leaves a failed session behind (`Model unavailable: <provider>/<model>`) and shows up
as an error in the developer's own session list. The CLI belongs to `test/e2e/` and to the
model bench, both opt-in. Extract the rule under test into a pure function instead.

**`src/doctor/checks.ts` hardcodes the tool count** (`${n}/9 agent_team_* tools`), and
`test/integration/contracts.test.ts` hardcodes the tool names, the command count and the
skill count. Adding or renaming any of them means updating both in the same commit. The
same test pins the declared enums of the state, handoff, gate and evidence tools to the
canonical domain enums — a tool's JSON Schema that omits a field its handler reads makes
that field unreachable through a host that validates inputs.

**Never hardcode the plugin version.** `packageVersion()` in `src/catalog/agents.ts` reads
the shipped `package.json`. A hardcoded version drifts on every release, and a stale one
writes the wrong plugin spec into a consumer's `opencode.jsonc`.

**Agent templates and the runtime skill map must agree.** `ROLE_SKILLS` in
`src/catalog/skills.ts` is compared against the `## Skills` block of each
`assets/agents/**/*.md` by `test/integration/skills-map.test.ts`. Adding a skill to a role
means editing both. Templates must start with `---\n` at byte 0 and must **not** contain the
`AGENT-TEAM-MANAGED` marker — it is appended only at apply time.

**Relative imports carry a `.js` extension** even though the file on disk is `.ts`
(`NodeNext` resolution requires it), and `verbatimModuleSyntax` is on, so type-only imports
need `import type`. Declare functions with `export function`, not `export const fn = () => {}`.
Details: [STYLEGUIDE.md](STYLEGUIDE.md).

**A tool is one file in `src/tools/`**: an `XXX_TOOL` const frozen with `as const` (a
compile-time type assertion, not `Object.freeze`) with a closed input schema, plus an
`executeXxx(runtime, rawInput, tool)` function, registered in `src/tools/index.ts`.
Ledger writes go through `appendEvent(...)` via `openLedger(...)`, which enforces
`expectedRevision` and refuses a writer who is not `team-leader`. Details:
[ARCHITECTURE.md](ARCHITECTURE.md).

### Code comments

Add a comment only when it is highly necessary to explain non-obvious intent, a workaround,
or a critical constraint. This codebase has a house style for it: a comment states the
*failure the guard prevents*, not what the next line does.

```ts
// Good — names the failure this rule exists for.
// The authority matrix fails closed. A rule whose matcher throws is not
// treated as "did not match". Treating it that way would let a broken DENY
// rule fall through to ALLOW, which is the exact opposite of "DENY is final".

// Bad — restates the code.
// Increment the counter.
```

When you delete code, delete its comment with it. A comment describing behaviour that no
longer exists is worse than no comment.

## Behavioral Guidelines

1. **Think Before Coding.** Don't assume. Don't hide confusion. Surface tradeoffs. If a
   requirement in this repo is ambiguous, the ambiguity is usually a missing decision, not
   a detail you should invent.
2. **Simplicity First.** Minimum code that solves the problem. Nothing speculative. Ask
   yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.
3. **Surgical Changes.** Touch only what you must. Clean up only your own mess.
4. **Goal-Driven Execution.** Strong success criteria let you loop independently. Weak
   criteria ("make it work") require clarification. Here the success criteria are concrete:
   `npm run verify` passes, the invariants listed in [TESTING.md](TESTING.md) still hold, and
   a claim is never stronger than the evidence you can point at (CLAIM ≤ EVIDENCE).

## Mandatory Self-Review Gate (Pre-Handoff)

Before marking any task as complete or handing it off to a reviewer agent, you are strictly
required to run an internal self-audit and cleanup cycle. Never deliver your raw first draft.

Pause, inspect your work against the 4 pillars below, and fix any issues immediately:

1. **Zero Execution Debris (Clean Up Your Tracks):** Delete all temporary files, scratchpads,
   one-off test scripts, logs, or unrequested summary notes created to aid your reasoning
   during execution. Leave only the requested final artifacts behind.
2. **Clean Replacement (Forward-Only):** When modifying existing work (including your own
   output from earlier steps), replace the old version completely. Leave no dead code,
   orphaned text, unnecessary backward-compatibility layers, or "just-in-case" fallbacks
   unless explicitly instructed to do so.
3. **Cohesion & Reuse:** Ensure you have not duplicated logic, patterns, or content that
   already exists in the current workspace. Reuse established modules, styles, and conventions
   rather than reinventing them locally.
4. **Target the Source of Truth:** Verify that your changes and validations/tests target the
   primary source files directly — never compiled, transpiled, generated, or secondary
   outputs. In this repo that means `src/domain/schemas.ts` rather than `schemas/*.json`,
   and `src/` rather than anything under `.agent-team/`.

**Handoff Rule:** If you detect any violation of the points above during your check, fix it
silently within your current loop. Only conclude your turn or invoke the next agent once all 4
checks pass cleanly.

## Where to look

Detailed guidance lives in one place each: [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow, [STYLEGUIDE.md](STYLEGUIDE.md) for code style, [TESTING.md](TESTING.md) for
the testing strategy, [ARCHITECTURE.md](ARCHITECTURE.md) for the system structure,
and [SECURITY.md](SECURITY.md) for the integrity rules and the reporting process.
[README.md](README.md) is the product itself.

- `.agent-team/` is runtime state and is gitignored — here and in consumer projects. It is
  generated, never edited by hand, and never a source of truth.
- `bench/rubrics/README.md` is the human-facing rubric and must stay in step with
  `MACHINE_SCORED_DIMENSIONS` in `bench/runners/run.ts` and the checker names in
  `bench/runners/observables.ts`. An unknown invariant name fails the dry bench run.
- `.specs/changes/<slug>/` holds local planning notes. It is untracked and not part of the
  published package — treat it as a hint about work in progress, not as repository
  documentation.
