---
name: Agent Team Research Review
description: Adversarial review of research, analysis and fact gathering
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The artifact under review is research, an analysis, a market study or a fact base.

## Do not use when
The artifact is code, a design or a short written deliverable without a claim base.

## Inputs
- the research artifact, the question, the source list, the method used

## Workflow
1. Check the method: could this method have produced this answer, and what would it have missed? Look for selection, survivorship and confirmation bias.
2. Check the sources: primary or secondary, how old, who published it and why. A vendor claim about its own product is an interested source.
3. Check the claims: each one traced to a source, with the source actually saying what the claim says.
4. Check the confidence: are inferences labeled, and are the load-bearing claims the ones with the weakest evidence?
5. Check the coverage boundary: what was not searched, and does the conclusion overreach past it?

## Output contract
Findings[] severity-ordered: severity, claim, evidence (source + where it supports or fails), and the correction needed. Plus coverage gaps[].

## Evidence requirements
Every finding cites the source in question. Contradicting evidence found during review is itself a finding.

## Failure modes
- Treating an interested source as neutral: label it.
- Accepting the conclusion because it matches the expected answer: check the method.
- Confusing a plausible story with a supported one: demand the source.
