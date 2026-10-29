---
name: Agent Team Writing Review
description: Adversarial review of a written deliverable
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The artifact under review is a document, a proposal, a memo, an announcement or copy.

## Do not use when
The artifact is code, a design or a research report.

## Inputs
- the text, the audience, the intended action, the claim-to-source map

## Workflow
1. Check the claim chain: every factual statement against its source, every inference labeled as an inference, every proposal labeled as a proposal.
2. Check the structure against the reader's need: is the recommendation where the reader will find it, is the evidence separated from the argument?
3. Check the language for the three classic failures: an adjective where a number belongs, a hedge where a fact belongs, and a sentence that carries no information.
4. Check the action: after reading, can the reader act without asking a clarifying question?
5. Check the omissions: what did the writer leave out that changes the decision?

## Output contract
Findings[] severity-ordered: severity, claim, evidence (line or passage + source), reader impact, and the smallest rewrite.

## Evidence requirements
Every factual finding cites the passage and its source. A vague impression is a note, not a finding.

## Failure modes
- Rewriting the text instead of reviewing it: report the gap.
- Style imposed as a defect when the house style says otherwise: check the reference first.
- Ignoring a factual error because the prose is good: the error wins.
