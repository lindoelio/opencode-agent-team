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
3. Exactly one active delivery at a time. Split before proceeding if the scope does not fit.
4. Register it with `agent_team_define_delivery`. The tool persists the contract as the active delivery and writes `.agent-team/deliveries/DEL-###.yaml`. Until the delivery is registered, the VERIFY, REVIEW and ACCEPT gates have no criteria and cannot pass.

## Output contract
Delivery Contract `DEL-###`: id, title, userOutcome, entryState, happyPath[], inScope[], outOfScope[], allowedScope[], prohibitedScope[], acceptanceCriteria[], validationSteps[], proof[], risks[], rollback, owner, status.

## Evidence requirements
Validation steps + real-path proof + rollback plan are required, never optional.

## Failure modes
- Big-bang scope: split before proceeding.
- A delivery that only proves the backend or only proves the screen when the flow needs both: extend it.
- Acceptance criteria that cannot be checked: rewrite them as observable criteria.
