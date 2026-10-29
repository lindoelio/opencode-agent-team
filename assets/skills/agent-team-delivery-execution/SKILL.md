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
3. Delegate bounded ownership to `team-leader/coder` for code units and to `team-leader/worker` for everything else.
4. Run local checks during construction, not only at the end.
5. Move the delivery to VERIFYING. Never self-mark PASS.

## Output contract
Phase checklist + changes made + execution record (commands run, artifacts produced, gaps left open).

## Evidence requirements
Changed files and test outputs, with no broader claim than what was proven.

## Failure modes
- A second equivalent failure: trigger strategy review, do not blindly retry.
- Two units writing the same artifact: assign ownership before launching them.
- Scope growth without a record: stop and record it first.
