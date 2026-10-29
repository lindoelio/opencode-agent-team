<div align="center">

# OpenCode Agent Team

**Turn ambiguous goals into verified deliveries — reviewed adversarially, with the ledger to prove it.**

[![CI](https://img.shields.io/github/actions/workflow/status/lindoelio/opencode-agent-team/ci.yml?label=CI&style=flat-square)](https://github.com/lindoelio/opencode-agent-team/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-2563eb?style=flat-square)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-2.0%20%7C%202.1%20%7C%202.2-8b5cf6?style=flat-square)](https://opencode.ai/docs)
[![SDK](https://img.shields.io/badge/%40opencode%2Fplugin-%3E%3D2.0.10%20%3C2.3.0-8b5cf6?style=flat-square)](https://www.npmjs.com/package/@opencode/plugin)
[![Node](https://img.shields.io/badge/node-%3E%3D22-5fa04e?style=flat-square)](https://nodejs.org)

</div>

---

**Agent Team Method** is a versioned, evidence-driven operating system for
[OpenCode](https://opencode.ai) 2.x. Not a persona. Not a prompt bundle.

One accountable orchestrator (`team-leader`), nine specialists, a decision
ledger, and deterministic evidence gates.

| | |
|---|---|
| **Orchestrator** | `team-leader` — the single human interface and the single ledger owner |
| **Specialists** | 9 roles: explorer, product, architect, designer, coder, worker, reviewer, security, release |
| **Model** | **No pin** — agents inherit the OpenCode harness default |
| **Runtime** | OpenCode `2.0.x`, `2.1.x`, `2.2.x` — no fork, no remote service, telemetry off |
| **State** | `.agent-team/` — event-sourced, with a compact projection injected into every session |
| **Orchestration** | Delegation by default, parallel waves inside a bounded budget |
| **Domain** | Any company, startup or founder context — not only code |

---

## Contents

- [Why](#why)
- [The loop](#the-loop)
- [The roster](#the-roster)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Tools](#tools)
- [The ledger](#the-ledger)
- [Autonomy and guardrails](#autonomy-and-guardrails)
- [Calibrated decisions](#calibrated-decisions)
- [Configuration](#configuration)
- [Models](#models)
- [Compatibility](#compatibility)
- [What is verified](#what-is-verified)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

---

## Why

An agent that says "done" is cheap. An agent that can *prove* it did what it
claimed is the scarce thing.

Most agent workflows fail the same way: the work happens, the summary is
optimistic, and nothing in the system can tell the difference between "the
tests pass" and "I believe the tests pass". The result is a delivery nobody
can audit, and a claim that is exactly as strong as the model's mood.

Agent Team replaces the summary with a **ledger** and the model's opinion with
**deterministic gates**:

- Every material claim is linked to a **criterion** and to **evidence** that
  carries proof — an artifact reference, a command, or a digest. A summary is
  not evidence.
- Every gate result is **computed by the plugin from ledger state**. The model
  supplies the claim; the gate decides. A model cannot mark its own work
  `PASS`.
- `CLAIM strength ≤ EVIDENCE strength`. Unit tests cannot claim production
  health, and the gate refuses the claim that says they can.
- Review must be **independent**: a `team-leader/reviewer` handoff whose scope
  actually covers the implementation it reviewed. Self-review never passes.
- Delivery requires **same-artifact identity**: the `ACCEPT` gate records a
  digest of the contract it judged, and `DELIVER` refuses a contract that
  changed afterwards.

The result is an agent team that is autonomous *and* accountable, and a project
that can answer "how do you know?" with a file.

## The loop

```text
INTENT → DISCOVER → FRAME → DECIDE → PLAN → EXECUTE → VERIFY → REVIEW → ACCEPT → DELIVER
```

Ten phases. Forward steps move one phase at a time; declared backward edges let
the loop return to an earlier phase when discovery or verification invalidates
a later assumption. Seven of them are gated — `FRAME`, `DECIDE` and `EXECUTE`
are not.

| Gate | What it demands |
|---|---|
| `INTENT` | An outcome is recorded. |
| `DISCOVERY` | Assumptions and decisions exist. |
| `PLAN` | An active Delivery Contract is registered. |
| `VERIFY` | An active delivery exists, and every acceptance criterion has a passing, criterion-linked evidence row carrying proof. |
| `REVIEW` | An independent reviewer handoff completed over the implementation's scope; no critical or high findings. |
| `ACCEPT` | Same as `VERIFY`, plus no low-confidence assumption left open, plus traceable decisions, plus `CLAIM ≤ EVIDENCE`. |
| `DELIVER` | A passing `ACCEPT`, no pending approval, and a delivery contract whose digest still matches. |

A gate result is `PASS`, `FAIL` or `BLOCKED`. `BLOCKED` means *waiting*, not
*failing*: a pending approval blocks the `DELIVER` gate without failing it.

## The roster

Ten agents. One is the orchestrator; nine are specialists it books work for.

| Agent | Role |
|---|---|
| `team-leader` | Accountable orchestrator. Plans the delivery as a dependency graph and books each independent wave in one call. Owns the ledger. |
| `team-leader/explorer` | Read-only discovery of codebase, domain and current state. No edits, no shell, no helper agents. |
| `team-leader/product` | Problem, actor, value, priorities. |
| `team-leader/architect` | 2–4 options with reversibility and blast radius. |
| `team-leader/designer` | Visual direction, UX states, visual evidence plan. |
| `team-leader/coder` | Implements one bounded unit of code inside the active delivery. |
| `team-leader/worker` | Generalist executor: research, written deliverables, analysis, content, ops, admin, data. |
| `team-leader/reviewer` | Adversarial independent review of **any** artifact, with a review skill per artifact type. |
| `team-leader/security` | Threat review for secrets, irreversible and sensitive actions. Reports locations, never values. |
| `team-leader/release` | Promotion with artifact identity and rollback. |

Every agent carries an explicit `## Skills` block, and the plugin injects the
same skill map into its system prompt at runtime — skill awareness is
deterministic, not remembered. A test compares the two, so the roster and the
skill map cannot drift apart silently.

**18 skills** ship with the plugin, each one a procedure with an output
contract: intent framing, domain discovery, structured investigation,
architecture decision, delivery scope, delivery execution, general execution,
research workflow, writing execution, code review, design review, writing
review, research review, strategy review, safe autonomy, evidence gate,
delivery contract, and calibrated decision.

## Install

Agent Team is an OpenCode plugin. It installs from GitHub, from npm, or from a
local checkout.

```bash
# From GitHub — pin to a release tag (recommended)
opencode plugin add github:lindoelio/opencode-agent-team#v0.5.0

# …or track the default branch
opencode plugin add github:lindoelio/opencode-agent-team

# From npm
opencode plugin add @lindoelio/opencode-agent-team

# From a local checkout
opencode plugin add ./path/to/opencode-agent-team
```

Then reload the server so the plugin is picked up:

```bash
opencode service restart
```

`opencode plugin list` shows what is installed; `opencode plugin update` moves
unpinned installs forward. Exact npm versions and full Git commit hashes stay
pinned; unpinned Git and npm plugins are checked for updates on restart.

**Requirements:** Node.js 22 or newer, and an OpenCode 2.x host with at least
one model connected. Agent Team pins no model and will never substitute one.

## Quick start

```bash
cd /path/to/project
opencode
```

Then, in the session:

```text
/agent-team/setup --apply --scope project --set-default
/agent-team/doctor
/agent-team/start Ship a dark-mode toggle to the settings screen
```

`/agent-team/setup` is explicit and project-scoped by default. With `--apply` it
writes the ten agent templates into `.opencode/agents/`, sets `default_agent` to
`team-leader` in `opencode.jsonc`, and preserves anything you have edited — a
modified file is reported as *drifted* and never overwritten. Without `--apply`
it prints the diff and writes nothing, which is the right way to look before
you change a project.

| Flag | Effect |
|---|---|
| *(none)* | Dry run. Prints the file and config diff and writes nothing. |
| `--apply` | Writes immediately. No extra confirmation. |
| `--scope project` | Default. Writes to `.opencode/agents/` and merges `opencode.jsonc`. |
| `--scope global` | Writes to `~/.config/opencode/agents/`. Project config is left alone. |
| `--set-default` | Sets `default_agent: "team-leader"`. Implied by `--apply --scope project` unless `--no-default`. |
| `--no-default` | Installs the roster without changing the default agent. |
| `--update` | Refreshes the files that are already installed and managed. It does not create the files a newer version of the plugin introduced. |

Then drive the loop:

```text
/agent-team/start       INTENT      — state the outcome, actors, constraints, acceptance
/agent-team/discover    DISCOVER    — delegate read-only discovery; classify what is verified
/agent-team/thesis      FRAME       — the product thesis: for whom, what value, versus what
/agent-team/decide      DECIDE      — assumptions first, then a Decision Record with options
/agent-team/plan        PLAN        — exactly one active Delivery Contract
/agent-team/execute     EXECUTE     — decompose, delegate, build; never mark PASS
/agent-team/review      REVIEW      — independent adversarial review
/agent-team/deliver     DELIVER     — evaluate and promote the verified artifact
```

Ask the system about itself at any point:

```text
/agent-team/status      — verdict first, then phase, gate, evidence, risks
/agent-team/why         — the recorded rationale behind a decision
/agent-team/guard       — the guardrails currently in force, and how to change them
/agent-team/decisions   — available decision models, thresholds in force, judgements recorded
/agent-team/export      — the sanitized bundles the ledger can produce
/agent-team/doctor      — preflight: host, plugin, models, tools, storage
```

These are questions you can ask at any point, whatever phase the engagement is
in. The [Commands](#commands) section below splits all fifteen into the ones
that drive the loop and the ones that answer directly.

## Commands

Fifteen commands, registered with the host.

**The loop** — these re-enter the session with a structured prompt:

| Command | Phase | What it does |
|---|---|---|
| `/agent-team/start` | INTENT | Initializes or resumes the engagement; extracts outcome, actors, constraints, non-goals and acceptance; records safe assumptions. |
| `/agent-team/discover` | DISCOVER | Delegates discovery to `team-leader/explorer`; classifies every conclusion as `VERIFIED` / `USER_STATED` / `OBSERVED_PATTERN` / `INFERENCE` / `PROPOSAL` / `UNKNOWN`. |
| `/agent-team/thesis` | FRAME | Delegates to `team-leader/product`; produces the thesis, the non-goals, the riskiest assumptions and the first proof. |
| `/agent-team/decide` | DECIDE | Records the assumptions behind a choice first, then a Decision Record with 2–4 options, trade-offs, reversibility and blast radius. `--critical` runs the architect and security lenses in parallel. |
| `/agent-team/plan` | PLAN | Registers exactly one active Delivery Contract: scope, acceptance criteria, validation steps, proof and rollback. |
| `/agent-team/execute` | EXECUTE | Decomposes the delivery into bounded units and launches every independent unit of the wave in parallel. |
| `/agent-team/review` | REVIEW | Delegates to an independent `team-leader/reviewer` with the matching review skill; runs `team-leader/security` in parallel on risk triggers. |
| `/agent-team/deliver` | DELIVER | Delegates to `team-leader/release`: pins the artifact identity, confirms the delivered artifact equals the verified one, then promotes autonomously. |
| `/agent-team/why` | — | Explains the current decision from the recorded rationale, alternatives, evidence and later changes. Never reconstructs private chain-of-thought. |

**Lifecycle** — these execute inside the plugin and answer in the session:

| Command | What it does |
|---|---|
| `/agent-team/setup` | Plans, applies or updates the native agent files and the project config. |
| `/agent-team/doctor` | Twelve preflight checks: host version, host API surface, plugin version, autonomy policy, model catalog, decision models, reasoning effort, text generation, tool registration, structured output, native specialists, storage. |
| `/agent-team/status` | Verdict-first answer from the state projection. Never dumps the raw event log. |
| `/agent-team/guard` | Shows or edits guardrails. The only source of authorization prompts. `--add`, `--remove`, `--clear`, `--mode`. |
| `/agent-team/decisions` | Lists the decision models the host exposes, the thresholds in force and the judgement rows recorded. |
| `/agent-team/export` | Lists the sanitized bundles the ledger can produce (status, decision-log, evidence, delivery-readiness, retrospective). Bundle generation is not implemented yet — the command reports the names and writes nothing. |

## Tools

Nine tools, registered under the `agent_team` namespace. Every input schema is
**closed** (`additionalProperties: false`) and validated with Zod; a test asserts
the closure of all nine and pins the declared enums to the canonical domain
enums.

| Tool | Purpose |
|---|---|
| `agent_team_state` | Initialize, read, transition or register guardrails for the engagement. |
| `agent_team_record_assumption` | Record a material assumption with epistemic basis, confidence and impact. |
| `agent_team_record_decision` | Record a Decision Record with options, trade-offs, reversibility and authority. |
| `agent_team_submit_evidence` | Submit criterion-linked evidence. A `pass` requires an artifact reference, a command or a digest. |
| `agent_team_evaluate_gate` | Evaluate one of the seven gates **from ledger state**. The result is computed, never chosen. |
| `agent_team_request_approval` | Open or resolve a scoped, expiring approval. Only needed when a guardrail fires. |
| `agent_team_handoff` | Prepare, complete or cancel a bounded specialist handoff. `prepareWave` books a whole wave in one call and one revision. |
| `agent_team_define_delivery` | Register the active Delivery Contract. Exactly one delivery is active at a time. |
| `agent_team_evaluate_decision` | Ask a decision model typed questions about a piece of evidence and get a calibrated verdict. |

**The leader owns the ledger.** Only `team-leader` writes assumptions,
decisions, evidence, gates and handoffs. A specialist returns a
`SpecialistResult@1` and the leader records it. This is what makes "one
accountable orchestrator" mechanical rather than conventional — and it removes
the revision contention parallel specialists would otherwise create.

**Writes are checked against the handoff's scope.** A write outside
`allowedScope`, or inside `prohibitedScope`, is refused by the tool-audit hook
rather than silently accepted.

**The parallel budget is enforced by the tool.** Every delegated specialist is
a separate process with a real memory cost, so
`orchestration.maxParallelSpecialists` (default `6`) bounds how many may run at
once. It bounds concurrency, not the size of a delivery: independent work still
runs in parallel, in bounded waves.

## The ledger

State is event-sourced and lives in the project directory:

```text
.agent-team/
  README.md               # what this directory is
  state.json              # the current projection
  ledger/events.jsonl     # append-only, hash-chained event log
  decisions/              # DEC-0001.md — human-readable ADRs
  deliveries/             # DEL-001.yaml — Delivery Contracts
  evidence/               # EVD-0001.json, and artifacts/
  judgements/             # JDG-XXXXXXXX.json — one per executed decision
  approvals/              # APR-0001 — scoped, expiring approvals
  exports/                # sanitized bundles
  setup-backups/          # backups written by setup and by state migrations
```

`state.json` is derived. `ledger/events.jsonl` is the source of truth. Every
event carries `sequence`, `previousHash` and `hash`, where the hash covers the
canonical event body. The chain is verified before every append; **a broken
chain refuses the write rather than repairing itself.**

Writes go through one protocol, in one place:

1. **Parse** the raw input with the tool's Zod schema.
2. **Open the ledger** — assert the caller is the ledger owner, assert the
   engagement exists, and assert `expectedRevision` still matches. A stale
   revision is refused: this is optimistic concurrency, and it is what keeps
   parallel specialists from clobbering each other.
3. **Append** — redact, extend the hash chain, write the event log and the new
   projection atomically.

Two paths deliberately skip step 2: initializing the engagement (there is no
revision yet to check) and `/agent-team/guard`, where the operator changes the
autonomy policy through the command rather than the leader acting through the
ledger.

A compact projection of the full state is rendered as YAML and injected into
every Agent Team session. It is what the leader reads; the event log is what
the system audits. The projection exposes `handoffs_ready` and
`handoffs_blocked`, so the leader knows what to launch now and what to wait
for.

## Autonomy and guardrails

**YOLO by default.** Agent Team executes autonomously — deploys, releases,
production changes, destructive operations and external writes do not require
approval. This is a deliberate product decision, not an oversight: a human in
the loop on every action defeats the method.

Authorization prompts happen in exactly two situations:

1. You registered a guardrail (`autonomy.askBefore`, or `/agent-team/guard`).
2. You opted into `autonomy.mode: "guarded"`.

Integrity rules that prevent secret exposure, false completion claims,
prompt-injection obedience and specialist-created `team-leader/*` trees are
**never** asked about — they are refused.

| Setting | Effect |
|---|---|
| `autonomy.mode: "yolo"` *(default)* | ALLOW baseline, including external, destructive and production actions. Nothing is asked. |
| `autonomy.askBefore: ["deploy production"]` | Matching actions require explicit authorization. Plain text or regex, matched case-insensitively against `"<action> <resources>"`. |
| `autonomy.mode: "guarded"` | Legacy opt-in: ask before external, destructive and outside-delivery actions. |
| `orchestration.maxParallelSpecialists` *(default `6`)* | How many specialists may run at the same time. |
| `strictEvidence` *(default `true`)* | When `true`, only a `pass` evidence row carrying proof satisfies a criterion. When `false`, a `partial` row carrying proof also does. A summary-only row never satisfies a criterion in either mode. |

`DENY` is final, and it cannot be weakened by a hook, a guardrail edit, an
option change or a model instruction. The authority matrix also **fails
closed**: a rule whose matcher throws is treated as `DENY`, not as "did not
match", so a broken denial rule can never fall through to `ALLOW`.

Asking you to *clarify* a materially outcome-changing ambiguity is not an
authorization prompt, and it is never suppressed.

## Calibrated decisions

Agent Team can ask a **decision model** — Jev, Clef, Laya, GPT-6 Luna and the
rest of the System One family — a bounded, typed question about a piece of
evidence, and get back a calibrated probability instead of a paragraph of
prose. The plugin discovers whatever decision models your OpenCode already
exposes, so there is no vendor to configure: connect OpenRouter, Cloudflare
Workers AI or the Vercel AI Gateway and the models are there.

A judgement is a **first pass**. It tells a specialist where to look and
whether to escalate, in tens of milliseconds. It never approves anything: a
judgement evidence row satisfies no acceptance criterion, supports no gate
claim, and cannot weaken a gate. Every deterministic gate, authority rule and
denial rule is exactly as it was.

The verdict algebra is explicit:

| Verdict | When |
|---|---|
| `satisfied` | Every answer reached its thresholds. |
| `escalate` | Some answer did not reach its thresholds. |
| `unanswered` | There were no answers, or any answer was an error. An unanswered question is never a negative answer. |

A judgement row never carries `pass` or `fail`, so it can satisfy nothing and
fail nothing.

| Use | Probability | Confidence |
|---|---|---|
| `default` | 0.85 | 0.70 |
| `review` | 0.90 | 0.75 |
| `security` | 0.95 | 0.85 |
| `release` | 0.92 | 0.80 |

The role's own use is a **floor**: a call may name a stricter use, never a
looser one. The effective threshold is the component-wise maximum of the role's
threshold and the requested use's threshold.

Before the shared state is sent, it is redacted with the shared redactor and
screened for instructions that would redirect the judgement. A state carrying
such an instruction is refused, not sanitised silently.

## Configuration

Options live under the plugin's `plugins` entry in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@lindoelio/opencode-agent-team",
      "options": {
        "strictEvidence": true,
        "orchestration": { "maxParallelSpecialists": 6 },
        "autonomy": {
          "mode": "yolo",
          "askBefore": ["deploy production", "delete .*\\.env$"]
        }
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `profile` | `"public" \| "private"` | `"public"` | Accepted for forward compatibility. It has no runtime effect today. |
| `strictEvidence` | `boolean` | `true` | Whether a `partial` evidence row carrying proof may satisfy a criterion. |
| `projectState` | `string` | `".agent-team"` | Directory the ledger is written to. |
| `telemetry` | `boolean` | `false` | Cannot be enabled — the plugin throws if you set it to `true`. |
| `autonomy.mode` | `"yolo" \| "guarded"` | `"yolo"` | The autonomy baseline. |
| `autonomy.askBefore` | `string[]` | `[]` | Guardrails. Plain text or regex. |
| `orchestration.maxParallelSpecialists` | `1…32` | `6` | Concurrent specialists. |
| `model.providerID` | `string` | — | Pin every Agent Team agent to one provider. |
| `model.modelID` | `string` | — | Pin every Agent Team agent to one model. |
| `model.reasoningEffort` | `string` | — | Reasoning effort for every agent. |
| `model.roleReasoningEffort` | `Record<string,string>` | — | Per-role reasoning effort, keyed by agent id. Wins over `model.reasoningEffort`. |
| `model.maxTokens` | `number` | — | Output token budget for Agent Team agents. |
| `decision.mode` | `"off" \| "auto" \| "required"` | `"auto"` | `auto` uses a decision model when the host exposes one; `required` fails the step that asked when none is available; `off` refuses every decision. |
| `decision.model` | `string` | — | A pinned decision model, as `provider/model`. |
| `decision.thresholds` | `Record<use, {probability, confidence}>` | built-in table | Per-use threshold overrides. |
| `decision.timeoutMs` | `number` | `10000` | How long one decision request may take. |
| `decision.unavailable` | `"escalate" \| "abort"` | `"escalate"` | What happens when the capability is on but no decision can be served. |

## Models

**Agent Team pins no model.** Agent templates carry no `model:` key and the
plugin injects no reasoning effort or token budget unless you configure one,
so the OpenCode harness default applies.

To pin your own, configure it in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@lindoelio/opencode-agent-team",
      "options": {
        "model": {
          "providerID": "anthropic",
          "modelID": "claude-sonnet-4-5",
          "reasoningEffort": "high"
        }
      }
    }
  ]
}
```

…or edit `model:` directly in `.opencode/agents/team-leader.md` — setup
preserves your edit as *drifted* and never overwrites it.

`/agent-team/doctor` reports the model catalog, verifies that a configured
reasoning effort actually resolves in it, and confirms that simple text
generation works on the harness default model. It never substitutes a model on
your behalf.

## Compatibility

| Host line | Supported | Notes |
|---|---|---|
| OpenCode `2.0.x` | yes | The baseline. `@opencode/plugin >= 2.0.10` |
| OpenCode `2.1.x` | yes | Adds `ctx.credential`; the plugin does not depend on it |
| OpenCode `2.2.x` | yes | Moves the generation API to `ctx.experimental.generate`; the plugin resolves it by feature detection, so it works on all three lines |
| Anything else | degraded | `/agent-team/doctor` reports the detected version and marks it `DEGRADED`. The plugin does not brick a future host. |

The plugin uses `@opencode/plugin` at runtime only for `Plugin.define`, which is
the identity function on every supported line; the only other import from it is
the `ToolContext` type. Everything else it consumes — commands, skills, tools,
session hooks, permission hooks, storage, models and agents — has a stable shape
across the three lines.

**The host surface is detected, not versioned.** Surfaces that are absent from
the oldest supported typings are read through an `unknown` view with feature
detection, the way `resolveTextGenerator` in `src/compat/host.ts` does. A
surface that appears in a future host line will not break the plugin.

`/agent-team/doctor` reports the host version *and* the actual host API
surface, so a compatibility problem is visible without reading the source.

## What is verified

Stated plainly, because a README that lists only strengths is not useful.

| Surface | How it is verified |
|---|---|
| Tool inputs are closed and their enums are canonical | A test asserts closure for all 9 tools and pins the declared enums — role, gate, evidence kind, work status — to the canonical domain enums |
| The authority matrix | Unit tests over every rule, including that a rule which throws fails closed to `DENY` |
| The gate algebra | Unit tests over pass/fail/partial/skipped/waived/blocked, the claim-strength check and decision traceability |
| The ledger | Real filesystems: hash chain, tamper detection, atomic writes, redaction, the lock timeout, concurrent appends |
| Path containment | Real symlink and traversal tests |
| Handoff scope enforcement | A tool call is refused when it leaves the handoff's scope |
| The host compatibility matrix | `npm run compat:check` and a CI matrix build and test the plugin against `@opencode/plugin` 2.0.10, 2.1.4 and 2.2.0 |
| The bench case definitions | Dry mode validates every case and fails on an unknown invariant name |
| The published JSON Schemas | A test regenerates them from the Zod source and fails on drift |
| Coverage | Enforced thresholds: 98% statements, 98% lines, 98% functions, 87% branches. Below that, `npm run verify` fails. |

**What is *not* machine-verified: how well a model behaves.** The end-to-end
suite and the model bench are opt-in because they spend real model budget, and
they are the only things that say anything about the method's behavioural
claims. Run them before you trust a claim about the method itself.

The recorded real-model runs are in
[`bench/results/2026-10-28-real-runs.md`](bench/results/2026-10-28-real-runs.md)
— including the three bugs the first run found in the bench harness itself.

## Repository layout

```text
src/            plugin implementation (bootstrap, catalog, compat, decision, domain, doctor, hooks, ledger, tools, util)
assets/agents/  versioned native agent templates materialized by /agent-team/setup
assets/skills/  18 skills, each one a procedure with an output contract
schemas/        published JSON Schemas (state-v2, event-v1, specialist-result-v1), generated from the Zod source of truth
bench/          AgentTeamBench: cases, rubrics, runner, recorded results
test/           unit, integration, security, snapshots and opt-in e2e
fixtures/       clean-project and sample-task-board
```

There is no build step. The package exports `./src/index.ts` and the OpenCode
host loads the TypeScript source directly — one artifact, no drift between what
is tested and what is published.

The published JSON Schemas are generated from `src/domain/schemas.ts` with
`npm run schemas:generate`. A test fails if the files on disk drift from the
source, so a schema can never quietly stop describing the ledger.

## Development

```bash
npm ci
npm run verify          # typecheck → test:coverage → bench → pack:check. The gate.
npm run schemas:generate # after any Zod schema change
npm run compat:check    # builds and tests against SDK 2.0.10, 2.1.4 and 2.2.0
```

`npm run verify` is the whole definition of done. It is the same gate CI runs.

Two suites spend real model budget and are opt-in:

```bash
npm run test:e2e      # real-model journeys against the opencode CLI (AGENT_TEAM_E2E=1)
npm run bench:model   # AgentTeamBench scored on real runs (AGENT_TEAM_BENCH=1)
```

`npm run bench` without a model **validates every case definition** and reports
`not-evaluated` — it never scores a case 0 for the absence of a model. An
unknown invariant name or an incoherent case fails the run, so a typo cannot
pass CI unnoticed.

Full guidance lives in one place each: [CONTRIBUTING.md](CONTRIBUTING.md) for
the workflow, [STYLEGUIDE.md](STYLEGUIDE.md) for code style,
[TESTING.md](TESTING.md) for the testing strategy,
[ARCHITECTURE.md](ARCHITECTURE.md) for the system structure, and
[SECURITY.md](SECURITY.md) for the integrity rules.

## Security

Autonomy is the default; accountability is not optional.

- **Secret redaction runs before every write.** The ledger, the decision
  documents, the delivery contracts, the judgement records and the evidence
  records are all redacted before they reach the disk, so a secret pasted into
  a rationale does not survive in a file.
- **Path traversal and symlink escape are refused.** Every write stays inside
  the project root and is atomic.
- **Prompt injection is contained, not merely tagged.** Instruction-shaped
  content in the input is quarantined: the agent is told it was seen, and a
  tool call carrying that instruction is refused.
- **The authority matrix fails closed.** A rule that cannot be evaluated denies
  rather than allowing.
- **Delivery requires same-artifact identity** between verify and promote. The
  `ACCEPT` gate records a digest of the delivery contract it judged, and the
  `DELIVER` gate refuses a contract that changed after it was accepted.
- **The plugin opens no network connection of its own.** The only URLs in
  `src/` are the JSON Schema `$id` and the `$schema` dialect. A decision
  request leaves the machine through the host's own decision surface, exactly
  as every other model call does.

`DENY` is final.

To report a vulnerability, use the repository's **private security advisory
flow** — do not open a public issue. See [SECURITY.md](SECURITY.md) for the
supported versions, the full control list and the known limitations.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it
covers the prerequisites, the `npm run verify` gate, the checklists that apply
to changes in specific surfaces, the changelog policy and the release process.

## License

MIT — see [LICENSE](LICENSE).
