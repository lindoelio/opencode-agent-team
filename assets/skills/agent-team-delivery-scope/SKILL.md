---
name: Agent Team Delivery Scope
description: Define the smallest end-to-end delivery that proves the active product thesis
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
Broad scope or a milestone needs its first provable delivery.

## Do not use when
A delivery is already active and unverified.

## Inputs
- thesis, constraints, current inventory

## Workflow
1. Choose one thin end-to-end flow: a real user or a real operator gets a real outcome from start to finish. Neither a half-surface nor a half-pipeline.
2. Set the scope: `allowedScope` (files, channels, pages, processes, accounts this delivery may touch), `prohibitedScope` (what it must never touch), `acceptanceCriteria[]`, `validationSteps[]`, `proof[]`, and the rollback path.
3. Bind every validation step to the criterion it proves by `criterionId` — never by position. Declare one step per criterion: a criterion without its own step can never receive observed evidence.
4. Every step's command must start with an allowed check prefix (`npm test`, `pytest`, `cargo test`, `go test`, `git diff`, ...). The refusal message lists the effective set; extend it with `orchestration.allowedCheckPrefixes` instead of inventing a command.
5. Exactly one active delivery at a time. Split before proceeding if the scope does not fit.
6. Register it with `agent_team_define_delivery`. The tool persists the contract as the active delivery and writes `.agent-team/deliveries/DEL-###.yaml`. Until the delivery is registered, the VERIFY, REVIEW and ACCEPT gates have no criteria and cannot pass.

## Canonical shape

```yaml
acceptanceCriteria:
  - "the settings screen renders the toggle and persists its state"
  - "the toggle round-trips through a reload"
validationSteps:
  - criterionId: "the settings screen renders the toggle and persists its state"
    command: "npm test"
  - criterionId: "the toggle round-trips through a reload"
    command: "npx vitest run test/unit/settings.test.ts"
```

Two criteria, two steps, each one bound. The same shape for a handoff wave: one unit per independent scope, `context` carrying the references the specialist needs, and the review skill declared in `skills` for a reviewer unit.

## Output contract
Delivery Contract `DEL-###`: id, title, userOutcome, entryState, happyPath[], inScope[], outOfScope[], allowedScope[], prohibitedScope[], acceptanceCriteria[], validationSteps[], proof[], risks[], rollback, owner, status.

## Evidence requirements
Validation steps + real-path proof + rollback plan are required, never optional.

## Failure modes
- Big-bang scope: split before proceeding.
- A delivery that only proves the backend or only proves the screen when the flow needs both: extend it.
- Acceptance criteria that cannot be checked: rewrite them as observable criteria.
- A criterion with no declared step, or a step bound to an undeclared criterion: registration refuses it; fix the pairing before the delivery exists.
