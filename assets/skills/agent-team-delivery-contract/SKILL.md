---
name: Agent Team Delivery Contract
description: Prepare and execute a promotion with artifact identity and rollback
slash: false
metadata:
  opencode/autoinvoke: false
---

## Use when
A release, deploy, tag, publication or launch happens.

## Do not use when
The change is local-only and never leaves the workspace.

## Inputs
- target, artifact, registered guardrails

## Workflow
1. Pin the target and the artifact identity (SHA/checksum). Confirm the promoted artifact is the verified artifact.
2. Confirm migrations, secret handling, rollback, observability and known limitations.
3. Execute the promotion autonomously (tag/push/publish/deploy). Pause only when a registered guardrail covers the action; then open a scoped approval.

## Output contract
Delivery contract + rollback plan + executed promotion evidence.

## Evidence requirements
Same-artifact identity between verification and promotion.

## Failure modes
- Rebuilding between verification and promotion without re-verifying: block.
- Asking for authorization without a registered guardrail: policy violation, not caution.
