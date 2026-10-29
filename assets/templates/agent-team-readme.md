# .agent-team

Agent Team project ledger. Machine-managed; edit via /agent-team commands and tools.

- `state.json` — canonical snapshot (revision-guarded).
- `ledger/events.jsonl` — append-only hash-chained events.
- `decisions/` — human-readable ADRs (`DEC-####.md`).
- `deliveries/` — Delivery Contracts (`DEL-###.yaml`).
- `evidence/` — evidence records + small sanitized artifacts.
- `approvals/` — approval requests (opt-in via guardrails; none by default).
- `exports/` — sanitized bundles.
