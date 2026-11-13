---
name: Agent Team Delivery Execution
description: Execute the active delivery phase by phase, unit by unit, with checks
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The active delivery is READY or IN_PROGRESS.

## Do not use when
There is no active delivery.

## Inputs
- active delivery contract, current state projection

## Workflow
1. Refuse unregistered scope creep. Anything outside `allowedScope` is recorded as a scope change before it is touched.
2. Decompose the delivery into bounded units. Units that do not depend on each other run in parallel with non-overlapping ownership.
3. Delegate bounded ownership to `team-leader/coder` for code units and to `team-leader/worker` for everything else. Put the references the unit needs in its `context` — it is delivered in the specialist's prompt, not only in the ledger.
4. When moving to REVIEW, book `team-leader/reviewer` with an `allowedScope` that covers every implementation handoff's scope and every changed path — the gate mechanically refuses a review that does not. Declare the review skill that matches the artifact (`agent-team-code-review`, `agent-team-design-review`, `agent-team-writing-review`, `agent-team-research-review`, `agent-team-strategy-review`) as the first entry of the unit's `skills`; the child prompt embeds it.
5. Run local checks during construction, not only at the end.
6. Move the delivery to VERIFYING. Never self-mark PASS.

## Output contract
Phase checklist + changes made + execution record (commands run, artifacts produced, gaps left open).

## Evidence requirements
Changed files and test outputs, with no broader claim than what was proven.

## Failure modes
- A second equivalent failure: trigger strategy review, do not blindly retry.
- Two units writing the same artifact: assign ownership before launching them.
- Scope growth without a record: stop and record it first.
