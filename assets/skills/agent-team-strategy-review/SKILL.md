---
name: Agent Team Strategy Review
description: Adversarial review of a decision, plan, thesis or proposal
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The artifact under review is a decision, a plan, a product thesis, a proposal or a priority call.

## Do not use when
The artifact is code, a design or a research report without a decision attached.

## Inputs
- the decision or plan, its drivers, the alternatives considered, the acceptance criteria

## Workflow
1. Check the framing: does the decision answer the problem that was actually stated, or a narrower one that is easier to solve?
2. Check the alternatives: were the real options considered, or only a strawman and the chosen path? A decision with one option is not a decision.
3. Check the assumptions: which ones are load-bearing, which are unverified, and what changes if each fails? Name the one whose failure invalidates the plan.
4. Check the reversibility and the blast radius: what does this cost if it is wrong, and how hard is it to undo?
5. Check the evidence: is the recommendation grounded in observed facts, or in the author's preference?

## Output contract
Findings[] severity-ordered: severity, claim, evidence (driver, assumption or source), consequence if wrong, and the smallest correction. Plus the single biggest risk.

## Evidence requirements
Every finding points at a driver, an assumption, an option or a piece of evidence. A philosophical objection is a note, not a finding.

## Failure modes
- Re-deciding the choice: review the quality of the decision, not your preference.
- Ignoring an assumption because the plan feels right: name it.
- Accepting a single-option decision: demand the alternatives.
