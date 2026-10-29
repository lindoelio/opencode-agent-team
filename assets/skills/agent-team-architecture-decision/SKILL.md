---
name: Agent Team Architecture Decision
description: Make a material technical choice with an explicit Decision Record
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
Material technical choice with trade-offs.

## Do not use when
Trivial or fully reversible local choice.

## Inputs
- drivers, constraints, options

## Workflow
1. List 2-4 viable options with benefits/costs/risks.
2. Score reversibility (easy/moderate/hard/irreversible) and blast radius.
3. Recommend one; note the guardrail (if any) that would require authorization.
4. Persist via agent_team_record_decision.

## Output contract
Decision Record DEC-####.

## Evidence requirements
Unknowns and evidenceRefs explicit. A high-impact choice can be widened by running the architect and security lenses in parallel as separate handoffs; the plugin pins no reasoning effort, so the breadth comes from the lenses, not from a second pass at a higher effort.

## Failure modes
- Single-option decision: expand or justify why alternatives are infeasible.
