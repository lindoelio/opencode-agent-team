# Recorded cross-model bench runs

A single-model run says what one model did. A matrix run says whether the
method travels: the same cases, scored per model, with the spread as the
measurement.

Record a run here with the report `AGENT_TEAM_BENCH_MODELS` produced
(`bench-scores.json`, `mode: "model-matrix"`).

## Template

```markdown
## <date> — <plugin version> — opencode <host version>

**Command:** `AGENT_TEAM_BENCH_MODELS="<model-a>,<model-b>" npm run bench:model`

| Model | Mean | Cases completed |
|---|---|---|
| `<model-a>` | _ | _ |
| `<model-b>` | _ | _ |

**Mean spread:** _ (the mean of the per-case score spreads)

| Case | `<model-a>` | `<model-b>` | Spread |
|---|---|---|---|
| `AGENT-TEAM-ARCH-001` | _ | _ | _ |
| `AGENT-TEAM-SEC-001` | _ | _ | _ |
| `AGENT-TEAM-DELIVERY-001` | _ | _ | _ |
| `AGENT-TEAM-DECISION-001` | _ | _ | _ |

### What the spread shows

_Which cases changed outcome across models, and which invariant moved. A case
that scores 1.0 everywhere is a case the enforcement carries; a case that
splits is a prompt-only convention that still needs a mechanism._

### What it does not show

_decision_quality and communication are human-scored. The matrix measures the
machine-scored dimensions only._
```

A missing model on a case is reported as `null`, never as a zero: an absent
run is not evidence of failure.
