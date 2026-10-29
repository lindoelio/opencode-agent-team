# Security Policy

Agent Team executes real work on a real machine: it writes files, runs shell
commands, promotes releases and calls external services. Its security model is
part of the product, not an afterthought, and this document describes what the
plugin actually enforces today.

## Supported versions

| Version | Supported |
|---|---|
| `0.4.x` | Yes — security fixes on the latest `0.4` patch |

## Reporting a vulnerability

Use the repository's **private security advisory flow (GitHub Security
Advisories)**. Do not open a public issue for a suspected vulnerability.

Non-sensitive bugs and questions belong in the issue tracker:
<https://github.com/lindoelio/opencode-agent-team/issues>.

Include:

- the affected version or commit SHA
- the OpenCode version, the provider/model, and the OS
- reproduction steps with a minimal fixture — no secrets, no private data
- an impact assessment: what an attacker could read, write, or trigger

Receipt is acknowledged within three business days, and a fix plus an advisory
follows once the report is validated.

## Out of scope

- Social engineering, physical access, or a compromised user workstation.
- Vulnerabilities in OpenCode itself, in providers, or in third-party models.
  Report those upstream and link the issue here.

## Baseline controls

These are the guarantees the plugin enforces in code, and each one has a test.

### `DENY` is final

Four integrity rules may return `DENY`, and nothing weakens them — not a hook, not
a guardrail edit, not an option change, not a model instruction:

| Rule | Refuses |
|---|---|
| `secret-expose`, `policy-bypass` | Exposing a secret or bypassing a protection |
| `false-claim` | Claiming a test or deploy that was not proven |
| `untrusted-instruction` | Acting on an instruction found in untrusted content |
| `team-leader/*` delegation by a non-orchestrator | A specialist creating a sibling specialist |

`DENY` never asks the user. It refuses.

### The authority matrix fails closed

`src/domain/authority.ts` is an ordered rule list; the last matching rule wins.
A rule whose matcher throws is treated as `DENY`, not as "did not match" — a
broken `DENY` rule must never fall through to `ALLOW`.

### Secrets are redacted before every write

Redaction happens in one shared write path (`writeLedgerDocument` and
`appendEvent` in `src/ledger/store.ts`), so a new document type cannot bypass it
by omission. The redactor removes:

- **Values** matching a bearer token, `sk-…`, a GitHub token, a Slack token, or a
  PEM private key block
- **Object keys** matching `api_key`, `secret`, `token`, `password`, `passwd`,
  `authorization`, `bearer`, `private_key`, `client_secret`, `aws_secret`,
  `github_token`, `openai_key` or `anthropic_key`
- **Quoted strings of 32+ high-entropy characters**

**A field named `inputTokens` or `outputTokens` is destroyed** — the key matches
the `token` pattern and its value is replaced with `[REDACTED]`. Name usage
counters `input` and `output`.

### Path traversal and symlink escape are refused

`resolveInside` refuses a path outside the project root. `assertNoSymlinkEscape`
resolves the real path and refuses any symlink on an intermediate component that
leaves the root — the root itself is resolved first, so a symlinked ancestor
(`/tmp` on macOS) does not defeat the check. Every write is atomic: a temporary
file on the same volume, fsynced, then renamed.

### Prompt injection is contained, not merely tagged

The prompt hook detects instruction-shaped content in a session's input and
quarantines it. The quarantine has two consequences: the context hook tells the
agent that untrusted content was seen so it treats that content as data, and the
tool-audit hook **refuses a tool call whose input carries a quarantined
instruction**. Detection alone was not containment; the refusal is.

### Scope is enforced

A specialist's write outside its handoff's `allowedScope`, or inside its
`prohibitedScope`, is refused by the tool audit hook. The scope is echoed into the
packet the specialist receives, so the rule and the contract agree.

### The plugin makes no network calls

`src/` contains no HTTP client and no outbound connection of any kind. The only
URLs in the source are the JSON Schema `$id` base and the `$schema` dialect.
Telemetry is off by default and **cannot be enabled**: `parseOptions` throws if
`telemetry` is set to `true`. Nothing about a prompt, a path, a secret or a piece
of evidence leaves the machine.

## Autonomy and authorization

The default is autonomy: external, destructive, production, financial and legal
actions execute without a prompt. This is a deliberate product decision, not an
oversight.

Two mechanisms give the operator control, and they are the **only** sources of an
authorization prompt:

- `autonomy.askBefore` — substrings or regular expressions matched
  case-insensitively against `"<action> <resources>"`. A match elevates the
  action to `ASK`.
- `autonomy.mode: "guarded"` — a legacy opt-in that also asks before external,
  destructive and outside-delivery actions.

Guardrails can be registered per project with `/agent-team/guard` and are stored
in the project state. An action that was asked about is allowed afterwards only
by an exact, current, unexpired approval.

Asking the user to *clarify* a materially outcome-changing ambiguity is not an
authorization prompt and is never suppressed.

## Known limitations

Stated plainly, because a security document that only lists strengths is not
useful:

- **The redactor is pattern-based.** A secret that matches no key name, no value
  pattern and not the high-entropy heuristic is not scrubbed. Do not treat
  redaction as the only control against a secret in a file.
- **Model behaviour is not verified by the deterministic layer.** The gates,
  authority rules and denial rules are mechanical; whether a model reasons well
  is only observed by the opt-in end-to-end suite.
- **The ledger lock is per-process.** It serialises writes inside one OpenCode
  server. Across processes, the hash chain and the revision guard are the
  defence, and a broken chain fails closed.
- **The plugin trusts its host.** It runs with the host's permissions. A
  compromised OpenCode installation is out of scope.

## Obligations when you contribute

- **Never commit a secret.** Not in a test fixture, not in a sample `.env`, not
  in a bench case. The bench fixture `clean-project` seeds a fake credential
  precisely to prove the redaction path works.
- **Route new ledger document types through `writeLedgerDocument`.** Writing a
  file directly bypasses redaction. This was a real leak, fixed in 0.4.0.
- **Add a test with every new refusal path.** A denial rule without a test is an
  unverified guarantee; the authority matrix, the gate algebra and the scope
  checks are each covered rule by rule.
- **Do not widen a scope to make a test pass.** `allowedScope` and
  `prohibitedScope` are contracts with a specialist.
- **Do not add a network call to `src/`** without a deliberate decision recorded
  in [CHANGELOG.md](CHANGELOG.md). The plugin currently has none, and that is a
  property worth keeping.
- **Keep `DENY` final.** A new `ASK` may come from a guardrail; a new `DENY` may
  not be weakened, reordered away, or made conditional.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — where each control lives.
- [TESTING.md](TESTING.md) — the suites that prove the controls.
- [STYLEGUIDE.md](STYLEGUIDE.md) — how to write a tool that keeps its contract.
