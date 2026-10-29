---
name: Agent Team Research Workflow
description: Gather and synthesize facts with traceable sources
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The unit is research, investigation, fact gathering, market or competitive analysis.

## Do not use when
The answer is already recorded in the ledger or the codebase.

## Inputs
- question, sources available, time budget

## Workflow
1. Write the question precisely: what would change if the answer were yes, and what if it were no.
2. Prefer primary sources (the actual document, the actual dataset, the actual person) over summaries of them. Record where each fact came from.
3. Separate what the source says from what you conclude. Never blend them.
4. Note what you could not find, and what you did not look for.
5. Prefer a structured source over a page when one exists.

## Output contract
Findings[] (claim, source, date, confidence) + synthesis + open questions[] + coverage gaps[].

## Evidence requirements
Every factual claim carries a source. A claim with no source is an inference and must be labeled as one.

## Failure modes
- Citing a search snippet as the source: open the source.
- Conflicting sources reported as agreement: report the conflict.
- Coverage presented as exhaustiveness: state the coverage boundary.
