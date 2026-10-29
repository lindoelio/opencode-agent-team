# Contributing

Thanks for working on Agent Team. This document covers the day-to-day workflow:
how to get the project running, what has to pass before a change lands, and which
document owns which kind of guidance.

For *what* the system is and how it is put together, read
[README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). For *how code should
look*, read [STYLEGUIDE.md](STYLEGUIDE.md). For *how it is tested*, read
[TESTING.md](TESTING.md).

## Prerequisites

| Requirement | Version | Source |
|---|---|---|
| Node.js | 22 or newer | `.nvmrc` (`22`), `engines.node` in `package.json` |
| npm | ships with Node 22 | `package-lock.json` pins the tree |

```bash
npm ci
```

`npm ci` is the install command, not `npm install` — the lockfile is the contract
and CI uses `npm ci`.

## Before you push

```bash
npm run verify
```

This is the same gate CI runs: `typecheck` → `test:coverage` → `bench` → `pack:check`.
It is the whole definition of "done" for a code change. If it fails locally it fails
in CI, so there is no value in pushing first.

Two commands need network access on first use because they shell out to `npx tsx`
(`tsx` is not a project dependency): `npm run schemas:generate` and
`npm run compat:check`. `npm run bench` falls back to the same path.

`npm run compat:check` is slow — it installs three SDK versions into temporary
directories and runs typecheck plus the unit and integration suites against each.
Run it before changing anything that touches the OpenCode plugin API. The CI
`verify` job does not run it, but the `sdk-matrix` job performs the equivalent
per-SDK typecheck and test.

## Repository structure

| Path | Contents |
|---|---|
| `src/` | Plugin implementation — the only place behaviour is defined |
| `assets/` | Agent templates, skill files and templates materialized into a consumer project |
| `schemas/` | Generated JSON Schemas — **never edited by hand** |
| `bench/` | AgentTeamBench: cases, rubric, runner, recorded results |
| `test/` | Test suites, mirroring `src/` |
| `fixtures/` | Sample projects used by the bench and the e2e suite |

## Git workflow

- `main` is the integration branch. CI runs on every push and pull request that
  targets `main`.
- A pull request is expected to pass `npm run verify` and the SDK matrix. There is
  no separate review checklist in the repository — the automated gate is the gate.
- Keep commits focused. The repository's history is small and deliberate
  (feature commits plus a release commit); the `CHANGELOG.md` entries are
  expected to match the commit's scope.

### Changes that have a checklist attached

These surfaces have an invariant that a test enforces. When you touch one, the
matching change belongs in the same commit:

| You changed | You must also |
|---|---|
| A Zod schema in `src/domain/schemas.ts` | Run `npm run schemas:generate` and commit `schemas/*.json` |
| The set of `agent_team_*` tools | Update the expected names and count in `test/integration/contracts.test.ts` **and** the count in `src/doctor/checks.ts` |
| A skill or a role's skill list | Update `ROLE_SKILLS` in `src/catalog/skills.ts` **and** the `## Skills` block of the matching `assets/agents/**/*.md` |
| An agent template | Keep the frontmatter starting at byte 0, and do not add the `AGENT-TEAM-MANAGED` marker — it is appended only at apply time |
| The bench rubric | Update `bench/rubrics/README.md` alongside `MACHINE_SCORED_DIMENSIONS` in `bench/runners/run.ts` and the checker names in `bench/runners/observables.ts` |

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Add an entry for any
user-visible change: a new tool, a new command, a changed gate rule, a changed
default. Fixes that change behaviour get an `### Fixed` entry that names the failure
that was possible before, not just the code that moved.

The changelog is the project's record of *why* something changed. When a fix closes a
real failure mode, the entry should read the way the existing entries do: what
breaks, and why it now cannot.

## Releasing

1. Update `version` in `package.json`.
2. Add the release section to `CHANGELOG.md`.
3. `npm run verify` must pass.
4. `npm pack --dry-run` (or `npm run pack:check`) — inspect the file list. The
   published package ships `src/`, `assets/` and `schemas/`; the plugin reads agent
   templates and skill files from disk at runtime, so a missing `assets/` entry
   breaks the installed plugin even though the tests pass.
5. `npm publish` — `publishConfig.access` is `public`.

## Documentation workflow

Each document has one owner. When you need to change guidance, change it in the
document that owns it rather than copying it elsewhere.

| Document | Owns |
|---|---|
| [AGENTS.md](AGENTS.md) | Repository context, commands, agent constraints, behavioural rules |
| [CONTRIBUTING.md](CONTRIBUTING.md) | This file: workflow, PR process, changelog, release |
| [STYLEGUIDE.md](STYLEGUIDE.md) | Naming, code style, language and framework patterns |
| [TESTING.md](TESTING.md) | Testing strategy, suites, how to run them |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System structure, boundaries, design decisions |
| [SECURITY.md](SECURITY.md) | Security policy, integrity rules, reporting process |
| [README.md](README.md) | The product: what it does, how to install it |

## Code comments

The comment policy for this codebase lives in
[AGENTS.md](AGENTS.md#code-comments) — the short version is that a comment states
the failure a guard prevents, not what the next line does.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `npx tsx` fails or hangs on first use | `tsx` is fetched on demand; the first run needs network access |
| `npm run bench` reports `not-evaluated` | Correct behaviour without `AGENT_TEAM_BENCH=1`; see [TESTING.md](TESTING.md) |
| The e2e suite skips itself | `AGENT_TEAM_E2E` is not `1`, or the `opencode` CLI is not on `PATH` |
| `schemas/*.json` is out of date | Run `npm run schemas:generate` |
| A tool is rejected as `stale revision` | The ledger revision moved; read the state again before writing |
| `npm run pack:check` shows a missing directory | `assets/` and `schemas/` must be in the published `files` list |
