---
name: Agent Team Design Review
description: Adversarial review of a design, interface or visual direction
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The artifact under review is a design, an interface, a visual direction or a UX flow.

## Do not use when
The artifact is code with no surface, or a written deliverable.

## Inputs
- the design artifact, references, the states it must cover, the evidence plan

## Workflow
1. Check the state coverage: loading, empty, error, partial and permission-denied. A direction that only shows the happy state is incomplete.
2. Check the flow against the real path: can someone complete the task with the stated states, or does the design assume data that does not exist yet?
3. Check accessibility and legibility: contrast, focus order, target size, text alternatives, reduced motion.
4. Check consistency with the rest of the product and with the stated references. Divergence is a decision, not a detail.
5. Check the evidence plan: what will be captured, when, and by whom. A design with no proof plan cannot be accepted.

## Output contract
Findings[] severity-ordered: severity, claim, evidence (screen, state, reference), impact on the user, and the smallest fix.

## Evidence requirements
Every finding points at a screen, a state or a reference. Aesthetic preference without a stated goal is a note, not a finding.

## Failure modes
- Reviewing only the happy path: enumerate the other states.
- Rewriting the design instead of reviewing it: report the gap and let the designer decide.
- Blocking on taste: judge against the stated direction and references.
