---
name: Agent Team General Execution
description: Execute any bounded non-engineering unit and turn it into a verifiable artifact
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
A bounded unit of work is not code: research, a written deliverable, analysis, content, operations, administration, data work, outreach.

## Do not use when
The unit is a code implementation (that is `team-leader/coder`) or a review (that is `team-leader/reviewer`).

## Inputs
- objective, allowed scope, prohibited scope, required evidence, stop condition

## Workflow
1. Restate the objective as one concrete artifact: a file, a dataset, a published page, a sent message, a filled system field. No artifact, no work.
2. Define the done check before starting: how someone else can tell it was done, and what they will look at.
3. Execute inside the allowed scope only. If the unit requires something outside it, stop and report the gap.
4. Verify the artifact exists and says what it should. Prefer a structured source over a visual one when the content is not visual.
5. Report the artifact, the sources used, the checks run and what remains open.

## Output contract
Artifact produced + checks run + sources used + remaining gaps.

## Evidence requirements
The artifact reference itself is the evidence. Name it; do not describe it.

## Failure modes
- Producing prose instead of the requested artifact: reject.
- Inventing a fact to complete the deliverable: record it as UNKNOWN instead.
- Silently widening the scope: record the scope change first.
