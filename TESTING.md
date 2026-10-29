# Testing

How this project is tested, and where a new test belongs.

## Strategy

The confidence in this codebase comes from three layers, weighted in that order.

**Integration tests are the main confidence layer.** The plugin's value is in the
behaviour that only appears when the ledger, the filesystem, the hook chain and the
tool registry work together — a hash chain that survives a truncated write, a
handoff scope that actually refuses an out-of-scope edit, a decision tool whose
declared input and Zod schema disagree. Those are exactly the failures unit tests
cannot see, so most of the suite lives in `test/integration/`.

**End-to-end tests cover the critical user journey.** The journey is: an operator
installs the plugin, runs `/agent-team/setup`, starts an engagement, delegates
work, and gets a gated delivery. `test/e2e/` drives the real `opencode` CLI against
a real model and asserts on the artifacts the run produced — the ledger, the files
on disk, the tool and subagent trace. It never treats the model's own account of
what it did as proof.

**Unit tests are secondary and selective.** They cover isolated, high-risk logic
where the surrounding system would obscure the failure: the authority matrix, the
gate algebra, the phase state machine, redaction, JSONC editing, host version
parsing.

The layer that is *not* automated is model behaviour. The e2e suite and the model
bench are opt-in because they spend real model budget, and they are the only things
that say anything about how well the method itself holds up. Run them before you
trust a claim about the method.

## Framework and configuration

Vitest 3.2, with the v8 coverage provider. Configuration is in `vitest.config.ts`:

```ts
include: ["test/**/*.test.ts", "fixtures/**/*.test.ts"]
coverage: {
  provider: "v8",
  include: ["src/**/*.ts"],
  thresholds: { statements: 98, lines: 98, functions: 98, branches: 87 },
}
```

Two consequences:

- **`fixtures/**/*.test.ts` is collected.** The fixture projects contain real
  Vitest tests, and they run as part of the suite.
- **Coverage thresholds are enforced and tight.** The current figures are
  ~98.2% statements and lines, 100% functions and ~88.1% branches, against
  thresholds of 98/98/98/87. New code without a test fails
  `npm run test:coverage`, and therefore `npm run verify`. This is deliberate:
  the integrity rules are the product, and untested branches in them are
  unverified guarantees.

## Running the tests

```bash
npx vitest run                            # everything
npx vitest run test/unit test/integration # the suites CI runs per SDK line
npx vitest run test/unit/gates.test.ts    # one file
npx vitest                                # watch mode
npm run test:coverage                     # with the enforced thresholds
npm run test:unit                         # test/unit
npm run test:integration                  # test/integration
npm run test:security                     # test/security
npm run test:snapshots                    # test/snapshots
```

### The opt-in suites

```bash
npm run test:e2e     # AGENT_TEAM_E2E=1
npm run bench:model  # AGENT_TEAM_BENCH=1
```

`test/e2e/*` **skips itself** unless `AGENT_TEAM_E2E=1` *and* the `opencode` CLI is
on `PATH`. A skipped e2e suite is an environment condition, not a failure and not
a bug to fix. The script sets a 25-minute per-test timeout and disables file
parallelism, because each test drives a real model against a real project.

`npm run bench` (no model) is a different thing and is safe to run anywhere: it
validates every bench case definition and reports each case as `not-evaluated`. It
never scores a case zero for the absence of a model, and an unknown invariant name
or an incoherent case fails the run — so a typo in the rubric cannot pass unnoticed.

## Layout

| Directory | Files | What belongs here |
|---|---|---|
| `test/unit/` | 19 | Isolated logic: authority matrix, gate algebra, state machine, redaction, JSONC, host compatibility, schema publication, decision algebra |
| `test/integration/` | 17 | The main confidence layer: tools against a ledger, hook behaviour, registration contracts, setup, scope enforcement, wave booking, decision surfaces |
| `test/security/` | 1 | Prompt-injection containment |
| `test/snapshots/` | 1 | Invariants of the agent templates (not Vitest snapshot files) |
| `test/e2e/` | 3 | Real CLI, real model, real project |
| `fixtures/` | 1 test file | Sample projects (`sample-task-board`, `clean-project`) used by the bench and the e2e suite |

`test/snapshots/agents.test.ts` is not a Vitest snapshot test. It asserts
structural invariants of `assets/agents/**/*.md` — that the frontmatter starts at
byte 0, that the leader is the only primary agent, that a read-only role cannot
spawn a helper that could edit, that no template grants an edit it also denies,
and that every template declares a `## Skills` block.

## What the integration layer proves

These are the guarantees that only a real filesystem and a real ledger can give:

- **The ledger.** The hash chain is canonical and detects a truncated or tampered
  event; writes are atomic; a v1 state file migrates in place and keeps a backup;
  an unknown schema version is refused; redaction runs on the way to disk; the
  per-process lock times out; concurrent appends do not corrupt the chain.
- **Path containment.** Symlink escape and traversal are refused against real
  symlinks, not simulated ones.
- **Handoff scope.** A write outside the handoff's `allowedScope`, or inside its
  `prohibitedScope`, is refused.
- **The tool contract.** Every tool input stays closed
  (`additionalProperties: false`), and the declared enums are pinned to the
  canonical domain enums — role, gate, evidence kind, work status — so a
  literal that drifts in one place fails here; every registered wrapper is
  invoked once and must fail with a domain error rather than a `TypeError`,
  which would mean the tool is wired to nothing.
- **The hooks.** The context hook injects the constitution, the state projection
  and the role contract, and strips the tools a read-only role must not see; the
  prompt hook redacts secrets and quarantines injection; the permission hook
  defaults to ALLOW, honours guardrails and approvals, and keeps DENY final; the
  retry hook retries only transient failures; the tool audit hook validates
  revisions and flags repeated failures.
- **Setup.** `setup --plan` writes nothing; `setup --apply` materializes the roster;
  a user-edited agent file is preserved and reported as drifted rather than
  overwritten.
- **The doctor.** A wrong host version is DEGRADED, a missing required host
  surface is FAIL, a configured reasoning effort absent from the catalog is FAIL.

## Conventions

- `describe` / `it`, with the test title naming the **property that is protected**,
  not the mechanism. See [STYLEGUIDE.md](STYLEGUIDE.md#tests).
- **Use real temporary directories and real files** for anything touching the
  ledger, the filesystem or path containment. Mocking the filesystem removes the
  property those tests exist to prove.
- A test that guards a fix for a specific past failure should say so in its title
  or a comment, so the reason survives the next refactor.
- **The unit and integration suites never spawn the `opencode` CLI.** A real run
  creates a real session in the developer's own OpenCode store, and a run pinned
  to a model that does not exist leaves a failed session behind
  (`Model unavailable: <provider>/<model>`) that surfaces as an error in the
  developer's own session list. The CLI belongs to `test/e2e/` and to the model
  bench, and both are opt-in. A bench rule that needs testing without a real
  run is extracted into a pure function and tested there.
- When you change a contract that a test hardcodes — the tool list, the command
  count, the skill count, the published schema files — update the test in the same
  commit. These are deliberate tripwires, not incidental assertions.

## Adding a test

| You are testing | Put it in |
|---|---|
| A pure function or a rule table | `test/unit/` |
| A tool, a hook, the ledger, or the filesystem | `test/integration/` |
| Injection, secret exposure, or a containment rule | `test/security/` |
| A property of the agent templates | `test/snapshots/` |
| A journey that needs a real model | `test/e2e/` (opt-in) |

## Coverage

`npm run test:coverage` is part of `npm run verify` and its thresholds are
enforced, so an uncovered branch is a build failure rather than a report. When you
add code:

- Prefer a test that exercises the branch over a test that asserts a constant.
- A branch that genuinely cannot be reached should be justified in a comment, not
  left silently uncovered.

## What is not machine-verified

- **Model behaviour.** Whether the agents reason well is only observed by the
  opt-in e2e suite and the model bench.
- **A future OpenCode host line.** The plugin degrades rather than bricks on an
  unknown host; `npm run compat:check` and the CI SDK matrix are what keep the
  three supported lines honest.
