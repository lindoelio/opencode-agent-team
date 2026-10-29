---
name: Agent Team Writing Execution
description: Produce a written deliverable that fits its reader and its purpose
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The unit produces a document, a proposal, a memo, an announcement, a spec or copy.

## Do not use when
The unit is a code change or a review of someone else's text.

## Inputs
- audience, purpose, format, length, facts already established

## Workflow
1. Fix the reader and the action the text must produce. If the reader or the action is undefined, record it as an assumption instead of inventing it.
2. Draft the structure before the sentences: what comes first, what is evidence, what is recommendation.
3. Write in plain sentences. Cut every sentence that does not move the reader toward the action.
4. Mark every factual claim with its source reference, and every unverified claim as an assumption or an open question.
5. Read it once against the done check: could the reader act on this without asking you a question?

## Output contract
Written artifact + audience + intended action + claim-to-source map + open questions[].

## Evidence requirements
Factual claims are traceable; proposals are labeled as proposals.

## Failure modes
- Adjectives standing in for evidence: replace with the number, the source or the example.
- A structure that hides the recommendation: move it up.
- Unverified claims stated flatly: label them.
