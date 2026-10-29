---
name: Agent Team Code Review
description: Adversarial review of a code artifact
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
The artifact under review is code.

## Do not use when
The artifact is a design, a written deliverable, research or a strategy.

## Inputs
- the changed code, the acceptance criteria, the delivery contract

## Workflow
1. Establish what the code claims to do, then look for the path where it does something else: the empty input, the concurrent call, the partial failure, the retry, the timezone, the null.
2. Check the boundaries: input validation, error paths, resource cleanup, concurrency, idempotency, secrets in logs.
3. Check the tests: do they cover the failure path, or only the happy path? A passing suite that never exercises the error branch proves nothing about it.
4. Check the contract against reality: does the code actually satisfy the acceptance criteria, or does the test suite merely claim to?
5. Prefer reading the diff over reading a summary. Run the checks when the environment allows it.

## Output contract
Findings[] severity-ordered: severity, claim, evidence (file:line, command output or artifact ref), what breaks, and the smallest fix.

## Evidence requirements
Every finding cites a file and line, a command output, or a reproducible input. A suspicion without a reproduction is a note, not a finding.

## Failure modes
- Style commentary dressed as a defect: separate it into notes.
- Assuming the intent without reading the contract: read it.
- Accepting a green suite as proof: check what the suite exercises.
