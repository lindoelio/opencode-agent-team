# OpenCode Agent Team

> **Agent Team turns ambiguous goals into verified deliveries, reviewed adversarially, with the ledger to prove it.**

**YOLO by default.** Agent Team executes autonomously — deploys, releases,
production changes, destructive operations and external writes do not require
approval. Authorization prompts happen only when you register a guardrail
(`autonomy.askBefore` in the plugin options or `/agent-team/guard`), or when
you opt into `autonomy.mode: "guarded"`. Integrity rules that prevent secret
exposure, false completion claims, prompt-injection obedience, and
specialist-created `team-leader/*` trees remain enforced and are never asked —
they are simply refused.

**Agent Team Method** as a versioned, evidence-driven operating system for
OpenCode 2.x. Not a persona. Not a prompt bundle. One accountable orchestrator
(`team-leader`), a specialist team, a decision ledger, and deterministic
evidence gates.

- Team Leader: `team-leader` (the single human interface and the single orchestrator)
- Model: **no pin** — the agents inherit the OpenCode harness default model
- Runtime: OpenCode `2.0.x`, `2.1.x` or `2.2.x`, no fork, no remote service, telemetry off
- State: `.agent-team/` event-sourced, with a compact projection injected into every session
- Orchestration: delegation by default, parallel waves within a bounded budget
- Domain: any company, startup or founder context — not only code

## Install (pinned)

```bash
# 1. Install a pinned revision
opencode plugin add github:lindoelio/opencode-agent-team#v0.4.0

# 2. Reload the local server
opencode service restart

# 3. Inside your project
cd /path/to/project
opencode

# 4. Materialize native agents (explicit, project-scoped by default)
/agent-team/setup --scope project --set-default

# 5. Preflight before first use
/agent-team/doctor

# 6. Start
/agent-team/start <desired outcome>
```

## Compatibility

| Host line | Supported | Notes |
|---|---|---|
| OpenCode `2.0.x` | yes | The baseline. `@opencode/plugin >= 2.0.10` |
| OpenCode `2.1.x` | yes | Adds `ctx.credential`; the plugin does not depend on it |
| OpenCode `2.2.x` | yes | Moves the generation API to `ctx.experimental.generate`; the plugin resolves it by feature detection, so it works on all three lines |
| Anything else | degraded | `/agent-team/doctor` reports the detected version and marks it `DEGRADED`. The plugin does not brick a future host. |

The plugin uses `@opencode/plugin` only for `Plugin.define`, which is the
identity function on every supported line. Everything else it consumes —
commands, skills, tools, session hooks, permission hooks, storage, models and
agents — has a stable shape across the three lines.

`/agent-team/doctor` reports the host version and the **actual host API
surface**, so a compatibility problem is visible without reading the source.

## Loop

```text
INTENT → DISCOVER → FRAME → DECIDE → PLAN → EXECUTE → VERIFY → REVIEW → ACCEPT → DELIVER
```

Every material claim needs criterion-linked evidence. `CLAIM strength ≤ EVIDENCE strength`.
A plan is not implementation; a passing build is not production proof.

## Team

| Agent | Role |
|---|---|
| `team-leader` | Accountable orchestrator. Plans the delivery as a dependency graph and books each independent wave in one call. |
| `team-leader/explorer` | Read-only discovery of codebase, domain and current state. |
| `team-leader/product` | Problem, actor, value, priorities. |
| `team-leader/architect` | 2-4 options with reversibility and blast radius. |
| `team-leader/designer` | Visual direction, UX states, visual evidence plan. |
| `team-leader/coder` | Implements one bounded unit of code. |
| `team-leader/worker` | Generalist executor: research, written deliverables, analysis, content, ops, admin, data. |
| `team-leader/reviewer` | Adversarial independent review of **any** artifact, with a review skill per artifact type. |
| `team-leader/security` | Threat review for secrets, irreversible and sensitive actions. |
| `team-leader/release` | Promotion with artifact identity and rollback. |

Every agent carries an explicit `## Skills` block, and the plugin injects the
same skill map into its system prompt at runtime — skill awareness is
deterministic, not remembered.

## Orchestration

- `team-leader` delegates bounded work by default and books independent
  handoffs in parallel, within `orchestration.maxParallelSpecialists`
  (default 6). Every specialist is a separate process with a real memory
  cost, so the budget is enforced by the tool, not by good intentions.
- `agent_team_handoff` with `action: "prepareWave"` books a whole wave in
  **one** call and therefore **one** ledger revision. That is what keeps the
  leader's revision stable while a wave is in flight.
- **The leader owns the ledger.** Only `team-leader` writes assumptions,
  decisions, evidence, gates and handoffs. A specialist reports its result and
  the leader records it. This is what makes "one accountable orchestrator"
  mechanical rather than conventional — and it removes the revision contention
  that parallel specialists would otherwise create.
- A specialist's writes are checked against the scope of its handoff: a write
  outside `allowedScope` or inside `prohibitedScope` is refused, not silently
  accepted.
- Specialists that write may launch built-in OpenCode helper agents
  (`explore`, `general`, …). Read-only specialists may not, because a helper
  could edit or shell. Only `team-leader` creates `team-leader/*` specialists.
- `handoffs_ready` and `handoffs_blocked` in the state projection tell the
  leader what to launch now and what to wait for.

## Autonomy and guardrails

| Setting | Effect |
|---|---|
| `autonomy.mode: "yolo"` (default) | ALLOW baseline, including external/destructive/production. Nothing is asked. |
| `autonomy.askBefore: ["deploy produção"]` | Matching actions require explicit authorization (plain text or regex). |
| `autonomy.mode: "guarded"` | Legacy opt-in: ask before external, destructive, and outside-delivery actions. |
| `orchestration.maxParallelSpecialists` (default 6) | How many specialists may run at the same time. It bounds how many run at once, not how many units a delivery holds. |
| `/agent-team/guard --add/--remove/--clear/--mode` | Same guardrails, registered per project in `.agent-team/` state. |
| `strictEvidence` (default `true`) | When `true`, only a `pass` evidence row carrying proof satisfies a criterion. When `false`, a `partial` row carrying proof also does. A summary-only row never satisfies a criterion in either mode. |

`DENY` is final and never weakened by hooks, guardrail edits or option
changes: secret exposure, unproven completion claims, instructions found in
untrusted content, and non-orchestrator creation of `team-leader/*` agents.
Asking for *authorization* is a policy event that happens only for a
registered guardrail; asking the user to *clarify* a materially
outcome-changing ambiguity is not an authorization prompt.

## Models

Agent Team pins **no** model. Agent templates carry no `model:` key and the
plugin injects no reasoning effort or token budget, so the OpenCode harness
default applies. To pin your own, either configure it in `opencode.jsonc`:

```jsonc
{
  "plugins": {
    "@lindoelio/opencode-agent-team": {
      "options": {
        "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-5", "reasoningEffort": "high" }
      }
    }
  }
}
```

or edit `model:` directly in `.opencode/agents/team-leader.md` — the setup
preserves your edit as drifted and never overwrites it.

## Layout

- `src/` — plugin implementation (options, bootstrap, catalog, compat, domain, ledger, hooks, tools, doctor, util)
- `assets/agents/` — versioned native agent templates materialized by `/agent-team/setup`
- `assets/skills/` — 17 lazy skills
- `schemas/` — published JSON Schemas (`state-v2`, `event-v1`, `specialist-result-v1`), generated from the Zod source of truth
- `bench/` — AgentTeamBench: cases, rubrics, runner
- `bench/results/` — recorded real-model runs, with what each one proved and what it exposed
- `fixtures/` — `clean-project`, `sample-task-board`
- `test/` — unit, integration, e2e (opt-in `AGENT_TEAM_E2E=1`), security, snapshots

The published JSON Schemas are generated from `src/domain/schemas.ts` with
`npm run schemas:generate`. A test fails if the files on disk drift from the
source, so a schema can never quietly stop describing the ledger.

## Development & Agentic Coding

```bash
npm ci
npm run verify          # typecheck + test:coverage (enforced thresholds) + bench + pack:check
npm run schemas:generate # regenerate the published JSON Schemas
```

Two suites spend real model budget and are opt-in:

```bash
npm run test:e2e      # real-model journeys against the opencode CLI (AGENT_TEAM_E2E=1)
npm run bench:model   # AgentTeamBench scored on real runs (AGENT_TEAM_BENCH=1)
```

`npm run bench` without a model **validates every case definition** and
reports `not-evaluated` — it never scores a case 0 for the absence of a model.
An unknown invariant name or an incoherent case fails the run, so a typo
cannot pass CI unnoticed.

## Verification

What is machine-verified today, stated plainly:

| Surface | How it is verified |
|---|---|
| Tool inputs are closed and match the Zod schema | A test compares the declared JSON Schema with the canonical Zod schema for all 8 tools |
| The authority matrix | Unit tests over every rule, including that a rule which throws fails closed to `DENY` |
| The gate algebra | Unit tests over pass/fail/partial/skipped/waived/blocked, the claim-strength check and decision traceability |
| The ledger | Real filesystems: hash chain, tamper detection, atomic writes, redaction, the lock timeout, concurrent appends |
| Path containment | Real symlink and traversal tests |
| Handoff scope enforcement | A tool-call is refused when it leaves the handoff's scope |
| The host compatibility matrix | `npm run compat:check` and a CI matrix build and test the plugin against `@opencode/plugin` 2.0.10, 2.1.4 and 2.2.0 |
| The bench case definitions | Dry mode validates every case and fails on an unknown invariant name |
| The published JSON Schemas | A test regenerates them from the Zod source and fails on drift |

What is **not** machine-verified: how well a model behaves. The e2e suite and
the model bench are opt-in because they spend real model budget, and they are
the only things that say anything about the method's behavioural claims. Run
them before you trust a claim about the method itself.

## Commands

`/agent-team/start`, `/agent-team/discover`, `/agent-team/thesis`, `/agent-team/decide`,
`/agent-team/plan`, `/agent-team/execute`, `/agent-team/review`, `/agent-team/deliver`,
`/agent-team/status`, `/agent-team/why`, `/agent-team/guard`, plus lifecycle
`/agent-team/setup`, `/agent-team/doctor`, `/agent-team/export`.

## Safety

Autonomy is the default; accountability is not optional. Scoped approvals with
expiry remain available for guardrail-triggered actions.

- **Secret redaction runs before every write.** The ledger, the decision
  documents, the delivery contracts and the evidence records are all redacted
  before they reach the disk, so a secret pasted into a rationale does not
  survive in a file.
- **Path traversal and symlink escape are refused.** Every write stays inside
  the project root and is atomic.
- **Prompt injection is contained, not merely tagged.** Instruction-shaped
  content in the input is quarantined: the agent is told it was seen, and a
  tool call carrying that instruction is refused.
- **The authority matrix fails closed.** A rule that cannot be evaluated
  denies rather than allowing.
- **Delivery requires same-artifact identity** between verify and promote.
  The ACCEPT gate records a digest of the delivery contract it judged, and
  the DELIVER gate refuses a contract that changed after it was accepted.
  The promoted artifact's identity itself is checked by the release
  specialist and reported as `release` evidence — the plugin does not run
  commands to re-derive it.

`DENY` is final.

## License

MIT — see `LICENSE`.
