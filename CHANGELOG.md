# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-29

### Added

- **Calibrated decision models.** Agent Team can now ask a decision model —
  Jev, Clef, Laya, GPT-6 Luna and the rest of the System One family — a
  bounded question about a piece of evidence and get back a calibrated
  probability instead of a paragraph of prose. The plugin discovers whatever
  decision models the host already exposes, so there is no vendor to
  configure and no client in `src/`: connect OpenRouter, Cloudflare Workers
  AI or the Vercel AI Gateway and the models are there. A judgement is a
  **first pass** — it routes a specialist and escalates when unsure — and it
  never approves anything. A judgement evidence row satisfies no acceptance
  criterion, supports no gate claim, and cannot weaken a gate; the existing
  gates, authority rules and denial rules are untouched.
- **`agent_team_evaluate_decision`** asks the typed questions (`predicate`,
  `choice`, `score`), screens the shared state for instructions that would
  redirect a judgement, redacts it, selects a model deterministically, and
  records the verdict, the thresholds and the cost.
- **`/agent-team/decisions`** lists the available decision models, the
  thresholds in force and the judgement rows recorded. `/agent-team/doctor`
  now reports the decision surface as an informational line, so a host
  without it degrades the capability without failing the preflight.
- **`agent-team-calibrated-decision`** teaches the reviewer, the security
  specialist and the release specialist when a bounded question is worth
  asking, and how to report a judgement back to the leader.

### Changed

- **The plugin still makes no network call of its own.** A decision request
  leaves the machine through the host's own decision surface, exactly as
  every other model call does. The egress statement in [SECURITY.md](SECURITY.md)
  is qualified accordingly, and the redaction limitation that already applied
  to prompts is recorded there too.

### Fixed

- **A secret in the engagement outcome survived in `state.json`.** The initial
  projection is written by `initializeState`, not through `appendEvent`, so it
  never went through the redactor — while the event recording the same outcome
  did. A credential typed into the outcome therefore survived verbatim on disk
  until the first subsequent write scrubbed it. The initial projection now
  applies the same redactor as every other write.
- **`--update` did nothing.** Its condition in the apply path was identical to
  the unconditional check next to it, so the flag was indistinguishable from
  `--apply` and the promise it made — refresh what is installed — was never
  kept. It now refreshes the installed, managed files and leaves the files a
  newer version introduced uninstalled, in the dry-run plan and in the apply
  alike.
- **The setup plan and the setup apply could target different roots.** The
  plan resolved the global root from `HOME` and the apply from `homedir()`, so
  with `HOME` unset the dry run described a different directory than the apply
  wrote to. Both now resolve it the same way.
- **Setup wrote the wrong plugin version into the consumer's config.** The
  version was hardcoded as `@0.3.0` while the package was already at `0.4.0`,
  so `/agent-team/setup` pointed a project at a release two versions behind.
  The version is now read from the shipped manifest (`packageVersion()`), which
  is the same source the doctor reports.
- **`FAILED` and `BLOCKED` were unreachable through a validating host.** The
  `agent_team_state` tool's declared JSON Schema did not list the `status`
  property, while its handler and its Zod schema both accepted it — and the
  schema is closed. A host that validates tool inputs rejected the field, so
  the status override the 0.4.0 release added could not actually be used. The
  schema now declares it, and a test pins the declared enum to
  `WorkStatusSchema`.
- **The setup command advertised a flag that did not exist.** Its own prompt
  text promised `--remove`, which no code path implemented. The claim is gone;
  the prompt text is now the help the user actually gets.
- **The export command named two different bundles.** The command description
  said `delivery-readiness` and the message it printed said
  `release-readiness`. They now agree.
- **The end-to-end suite asserted a skill that no longer exists.** The
  designer's test expected `agent-team-design-direction` to be loaded, but that
  skill was folded into the agent template in 0.4.0 and the designer owns no
  skill. The assertion could never pass.
- **The documentation had drifted from the code.** The README described 8 tools,
  17 skills and 14 commands (the real numbers are 9, 18 and 15), showed a
  `plugins` configuration shape that OpenCode does not accept, and documented a
  `--remove` flag that was never implemented. The other guidelines quoted stale
  coverage figures, stale test-suite counts, a tool count the doctor had moved
  past, and a rubric weight table that matched no case. All of it is now
  checked against the code.

## [0.4.0] - 2026-10-28

### Added

- **OpenCode 2.0.x, 2.1.x and 2.2.x are supported.** The SDK pin is widened
  and the host range is declared in `peerDependencies`. `/agent-team/doctor`
  now reports the host version *and* the real host API surface, instead of
  accepting only `2.0.*` — which meant a perfectly working OpenCode 2.1 or
  2.2 install was reported as `DEGRADED`.
- **`agent_team_handoff prepareWave`** books a whole independent wave in one
  call and therefore one ledger revision, instead of one per unit. This is
  what keeps the leader's revision stable while a wave is in flight.
- **Handoff scope is enforced.** A specialist's write outside its
  `allowedScope`, or inside its `prohibitedScope`, is refused by the tool
  audit hook instead of being silently accepted.
- **A delivery could be changed after it was accepted.** The ACCEPT gate now
  records a digest of the delivery contract it judged, and the DELIVER gate
  refuses a contract that changed afterwards. Promoting something nobody
  accepted is exactly the failure the gate exists to catch.
- **The published JSON Schemas are generated** from the Zod source of truth
  (`npm run schemas:generate`). The hand-written copies had drifted: they
  typed the key collections as bare `{"type":"object"}`, so they could never
  detect the drift they existed to prevent, and no code read them. A test now
  fails if they drift.
- **CLAIM ≤ EVIDENCE is enforced at the gate.** A gate that claims something
  its evidence cannot support — production health from unit tests, for
  instance — is refused, and the gate says why.
- **`state.risks` is fed by the work.** The risks a specialist reported
  become ledger risks, so `critical_risks` in the projection and
  `/agent-team/status` are no longer permanently empty.
- **`FAILED` and `BLOCKED` are reachable.** An engagement status can be set
  explicitly on a transition instead of being derived from the phase alone.

### Fixed

- **Secrets reached the disk.** `writeDecisionDoc` and `writeDeliveryDoc`
  wrote their files with no redaction, so a secret pasted into a decision
  rationale was scrubbed from `state.json` and `events.jsonl` but written
  verbatim into `.agent-team/decisions/DEC-0001.md`. Redaction now happens in
  one shared write path, so a new document type cannot bypass it.
- **The authority matrix failed open.** A rule whose matcher threw was
  treated as "did not match", so a broken `DENY` rule fell through to
  `ALLOW`. It now fails closed to `DENY`.
- **Prompt injection was detected but never contained.** The prompt hook
  tagged untrusted content and nothing read the tag. The instruction is now
  quarantined, the agent is told it was seen, and a tool call carrying that
  instruction is refused.
- **A specialist result was stored unvalidated.** `handoff complete` persisted
  any result verbatim, including a malformed one, so the gate could read an
  empty report as "nothing found". The result is now validated against the
  closed `SpecialistResult@1` shape before it is stored.
- **A review could be rubber-stamped.** The REVIEW and ACCEPT gates required
  only that *a* reviewer handoff existed. They now require that the
  reviewer's scope covers the implementation it reviewed.
- **The bench could not fail.** Dry mode never validated the case
  definitions, so a typo in an invariant name passed CI and only exploded in
  model mode. Dry mode now validates every case and exits non-zero on a
  broken one.
- **A timed-out bench run scored zero and was judged for things it never had
  the chance to do.** The first real recorded run exposed both: a timeout
  overwrote a measured score with `0`, and the forbidden-behavior checkers
  were evaluated on truncated runs — each of them asserts an *absence*, which
  a cut-off run has not earned. A run that was cut off now keeps its
  measured score, is reported as `incomplete`, has its forbidden behaviors
  left unjudged, and is excluded from the mean. The per-case timeout was
  also raised from 15 to 40 minutes: a case drives the whole operating loop,
  and the model iterates when a gate refuses.
- **The bench read the model's prose.** Three of the five forbidden-behaviour
  checkers regexed the model's own output while the harness documented
  itself as artifact-only. Every checker is now artifact-based, and the
  security case scans the files the run wrote — a model that leaked the API
  key into `NOTES.md` used to score a perfect 1.0.
- **Parallelism was never measured.** The checker asserted a subagent count,
  which a strictly sequential run satisfies. It now requires two specialists
  to have overlapped in time, measured from the run trace.
- **The rubric was never applied.** The declared weights were ignored by the
  scorer. The score is now the weighted average over the dimensions that can
  be scored from artifacts; `decision_quality` and `communication` are
  reported as `null` rather than given a number nobody computed.
- **Tests asserted less than their names promised.** The concurrency test
  tested no concurrency, a security test passed silently when its fixture
  was missing, one end-to-end assertion could never fail, and the case
  definitions were duplicated in a YAML file nothing read.

### Changed

- **The SDK dependency is now a range.** `@opencode/plugin` is declared as
  `>=2.0.10 <2.3.0` instead of pinned to one release, so the installed SDK is
  always one the plugin supports. The redundant `peerDependencies` entry was
  removed: npm drops it in favour of `dependencies` and warns on every
  install.
- **The compatibility check swaps the SDK instead of resolving it.** A fresh
  `npm install @opencode/plugin@X` drags in the whole provider-SDK tree, and
  that tree is currently not installable: every published SDK requires an
  `@aws-sdk/core` range (`^3.978.7`) that the registry does not satisfy —
  the highest published version is `3.978.6`. The check now swaps the SDK
  package into the tree and compiles and tests against that SDK's own
  typings, which is what the check is actually for, and it no longer depends
  on a transitive resolution that has nothing to do with this plugin.

- **Only `team-leader` writes the ledger.** Specialists report their result
  and the leader records it. This makes "one accountable orchestrator"
  mechanical rather than conventional, and it removes the revision contention
  that parallel specialists created: no specialist can advance the ledger
  revision underneath the leader.
  *Breaking:* a workflow where a specialist recorded evidence directly now
  has the leader commit that result.
- **Read-only specialists can no longer launch helper agents.** A role whose
  contract forbids editing could previously spawn an agent that could edit.
- **The phantom calibration feature is gone.** The `twin-calibration` skill
  and the `/agent-team/calibrate` command described a tool, a state field and
  an activation path that did not exist. The command count is now 14.
- **Four thin skills were folded into the roles that own them.**
  `product-thesis`, `design-direction`, `operational-readiness` and
  `retrospective` were three-step stubs; their procedures now live in the
  agent templates that use them, and the skill count is now 17. The five
  review skills were kept: a reviewer loads exactly one of them, so their
  per-artifact checklists are the valuable part and there is no context cost
  to consolidating them.
- **`strictEvidence` is real.** It decides whether a `partial` evidence row
  carrying proof may satisfy a criterion. It never relaxes the proof
  requirement.
- **The autonomy policy is stated once.** It lives in the
  `agent-team-safe-autonomy` skill; the other roles refer to it instead of
  restating it with drift.
- **`team-leader.md` no longer hardcodes an `.env` read rule**, which
  silently defeated guarded mode's `ASK` for the same path.

## [0.3.0] - 2026-10-24

### Fixed

- **Parallel delegation had no ceiling.** Every delegated specialist is a
  separate process holding hundreds of megabytes, and nothing bounded how many
  could run at once. A leader that over-delegated could exhaust the host's
  memory. `agent_team_handoff prepare` now refuses to exceed
  `orchestration.maxParallelSpecialists` (default 6): the budget is enforced by
  the tool, not left to the model's judgement. The budget bounds how many run
  at once, not how many units a delivery holds — the delivery still runs
  independent work in parallel, in bounded waves.
- **An interrupted test run orphaned every child process.** The end-to-end
  harness killed only the direct child, so the specialist processes it had
  spawned survived and accumulated across the session, driving the machine
  into swap-less memory exhaustion. Runs are now spawned in their own process
  group and the group is killed on timeout, error and interpreter exit.

### Fixed

- **A decision could be recorded with no basis.** `agent_team_record_decision`
  accepted a decision whose `evidenceRefs` cited nothing, so the ledger could
  hold a preference with no recorded epistemics. It now requires at least one
  existing assumption or evidence id and refuses otherwise, with an error that
  says what to record first.
- **A handoff could reach a specialist with no procedures.** The `skills` field
  was whatever the caller passed, which in practice was often nothing. It now
  defaults to the procedures the role owns (`ROLE_SKILLS`), and the leader can
  still override. The default is persisted in the ledger, so the handoff record
  shows what the specialist was told to load.
- **The delivery could never be registered.** No tool wrote `activeDelivery`, so
  the `PLAN` gate always failed and `VERIFY`, `REVIEW` and `ACCEPT` always
  failed with `active-delivery` missing — the acceptance criteria those gates
  read from the delivery were never reachable. Added
  `agent_team_define_delivery`, which registers the active Delivery Contract
  and writes `.agent-team/deliveries/DEL-###.yaml`. (The same gap existed in
  v1 as `activeSlice`.)
- **Setup overwrote managed files the user had edited.** `buildSetupPlan`
  reported `keep-drifted` but `applySetupPlan` wrote the file anyway. The
  apply now honors the drift.
- **Setup duplicated the plugin entry in `opencode.jsonc`.** A version bump
  appended a second entry for the same package, loading two copies of the
  plugin — and, before publication, a 404 from the registry. The entry is now
  matched by package name and updated in place; a local checkout path is
  preserved untouched.
- **The previous roster was never cleaned up.** After the rename, a project
  kept `agent-team.md` and `agent-team/*` beside the new `team-leader/*`:
  two primaries, stale role names, a pinned model, and specialists outside the
  `team-leader/*` orchestration boundary. Setup now removes the
  previous-version files (with a backup) and preserves any the user edited.
- The `submit_evidence` JSON schema was out of sync with its Zod schema: the
  `document` and `metric` kinds were missing.

### Changed (breaking)

- **The team leader is `team-leader`.** The primary agent id moved from
  `agent-team` to `team-leader`, and every specialist moved to the
  `team-leader/<role>` namespace. The orchestration boundary `DENY` in
  `src/domain/authority.ts` now matches `team-leader/*`, and
  `default_agent` is set to `team-leader` by `/agent-team/setup`. The plugin id
  (`lindoelio.agent-team`), the tool namespace (`agent_team`) and the command
  namespace (`/agent-team/*`) are unchanged.
- **No model ownership.** Agent templates no longer carry a `model:` key and the
  context hook no longer injects `reasoningEffort` or `maxTokens`, so the
  OpenCode harness default applies. `options.model` became optional with no
  defaults (`providerID`, `modelID`, `reasoningEffort`, `roleReasoningEffort`,
  `maxTokens`). The `--remap-model` setup flag, the model-remap persistence and
  the doctor's `ModelRemediation` were removed: there is no pin to remediate.
  The doctor now verifies model *resolution* instead of model presence.
- **Domain-neutral ledger (schema v2).** `SLICE`/`IMPLEMENT`/`RELEASE` became
  `PLAN`/`EXECUTE`/`DELIVER`; `RELEASE_READY`/`RELEASED` became
  `DELIVERY_READY`/`DELIVERED`; `activeSlice` became `activeDelivery` with
  `allowedScope`, `prohibitedScope`, `validationSteps` and a structured
  `proof[]` (`functional`, `presentation`, `document`, `metric`); the slice
  directory became `.agent-team/deliveries/`. A forward-only v1 → v2 migration
  runs on read and backs the old file up before rewriting it.
- **Roster reshaped.** `builder` became `coder` (code only), `verifier` became
  `reviewer` (adversarial review of any artifact), and a new `worker` was added
  as the generalist executor for research, written deliverables, analysis,
  content, operations and administration.
- **Commands renamed inside the same namespace.** `/agent-team/slice`,
  `/agent-team/build` and `/agent-team/release` became `/agent-team/plan`,
  `/agent-team/execute` and `/agent-team/deliver`.
- **The reviewer is adversarial.** It tries to prove the work wrong before
  accepting it, treats missing evidence as a finding, and never reviews its own
  high-risk implementation.

### Added

- `agent_team_define_delivery` — the eighth tool. Registers the active
  Delivery Contract (scope, acceptance criteria, validation steps, proof,
  rollback) and writes `deliveries/DEL-###.yaml`. The contract now requires a
  happy path, an allowed scope, validation steps and a rollback: a delivery
  without a path or a boundary is refused at the contract, not at the gate.
- **AgentTeamBench became a real validator.** `bench/runners/opencode.ts` drives
  the `opencode` CLI and captures what happened; `bench/runners/observables.ts`
  scores 16 invariants and 5 forbidden behaviors from the artifacts the run
  produced (the ledger, the files, the tool trace) rather than from the model's
  self-report. `npm run bench:model` scores the cases against a real model and
  exits non-zero when a case regresses. `npm run bench` now reports
  `not-evaluated` with a `null` score instead of a misleading 0.
- **A real end-to-end suite.** `test/e2e/` drives the `opencode` CLI against a
  throwaway project: the leader takes a delivery from intent to ACCEPT with
  delegation, criterion-linked evidence and independent review; independent
  units run in parallel; each specialist works on its own — including `worker`,
  `designer`, `security` and `release`, which had never been exercised against
  a model; and the discipline checks (no completion claim without evidence,
  untrusted file content treated as data) hold. The seven
  `expect(true).toBe(true)` placeholders are gone. Nine journeys, all green
  against a real model.
- 8 new skills: `agent-team-general-execution`, `agent-team-research-workflow`,
  `agent-team-writing-execution`, `agent-team-code-review`,
  `agent-team-design-review`, `agent-team-writing-review`,
  `agent-team-research-review`, `agent-team-strategy-review`. Skill count is now
  22.
- Explicit skill awareness for every agent: a `## Skills` block in each agent
  template, a `ROLE_SKILLS` map injected by the context hook, and a `skills[]`
  field on the handoff packet so the leader assigns skills per handoff.
- Parallel coordination primitives: `dependsOn` edges on handoffs and
  `handoffs_ready` / `handoffs_blocked` in the state projection, so the leader
  launches exactly the unblocked wave.
- `agent-team-structured-investigation` (renamed from
  `agent-team-api-first-investigation`), `agent-team-delivery-scope` (from
  `agent-team-vertical-slice`), `agent-team-delivery-execution` (from
  `agent-team-spec-build-validate`) and `agent-team-delivery-contract` (from
  `agent-team-release-contract`).
- `document` and `metric` evidence kinds.

### Removed

- `src/catalog/model-profile.ts` and the pinned `ROLE_VARIANT` map, replaced by
  `src/catalog/model-options.ts` with opt-in resolution.
- The `--remap-model` setup flag and `.agent-team/setup.json` model-remap state.

## [0.2.0] - 2026-09-21

### Changed (breaking)

- **YOLO is the default.** `ALLOW` is now the baseline for external writes,
  deploys, releases, tags, publication, production/billing/permission changes,
  financial/legal actions and destructive operations. The permission hook no
  longer elevates `allow` to `ask`. Authorization prompts happen only when a
  user-registered guardrail matches (`autonomy.askBefore` or `/agent-team/guard`) or
  when `autonomy.mode: "guarded"` is explicitly set.
- **No concurrency cap.** The `max 3 concurrent handoffs` guard is removed;
  `agent-team` is instructed to delegate by default and run independent handoffs in
  parallel. SPEC concurrency limits (default 2 / max 3) are gone.
- **Nested helper agents allowed.** Specialists may launch built-in OpenCode
  helper agents (`explore`, `general`, …). Only `agent-team` may create `agent-team/*`
  specialists; that boundary remains a final `DENY`.
- `.env`/credentials reads are `ALLOW` by default (redaction before persistence
  is unchanged).
- Agent templates no longer carry `ask` permissions for `git push`, `git tag`,
  `external_directory`, or `.env` reads.

### Added

- `autonomy` plugin option: `{ mode: "yolo" | "guarded", askBefore: string[] }`.
- `guardrails` + `autonomyMode` in project state, `agent_team_state` action
  `guard` (add/remove/clear/mode), and `/agent-team/guard` command.
- `matchesGuardrail` (plain text or regex, case-insensitive) in the Authority
  Matrix; `classifyGuarded` preserves the legacy opt-in behavior.
- Doctor reports the effective autonomy policy.
- 15th command (`/agent-team/guard`); bench cases and rubrics updated for the
  autonomy-first policy.

### Kept

- Integrity `DENY` rules remain final: secret exposure, unproven completion
  claims, instructions from untrusted content, and `agent-team/*` orchestration by
  non-orchestrators.

## [0.1.3] - 2026-09-19

### Added

- Explicit model remediation: `/agent-team/doctor` reports `DEGRADED` (instead of a
  bare `FAIL`) when the pinned model is missing but a same-family equivalent
  exists, with an exact `remediation` instruction. `/agent-team/setup --apply
  --remap-model <provider/model>` rewrites pinned agent `model:` refs
  (variants preserved, frontmatter intact) after explicit confirmation and
  records the choice in `.agent-team/setup.json`, which later plans reapply so
  updates never silently revert it. No silent fallback, ever.

## [0.1.2] - 2026-09-19

### Added

- REVIEW and ACCEPT gates now require a completed `agent-team/verifier` handoff:
  self-verification fails with `missing: ["independent-verifier-review"]`.
- State projection now reports `handoffs_completed`, `handoffs_open`, and
  `missing_independent_review` (with the gate consequence spelled out), so the
  primary agent sees the delegation gap in every context injection.

## [0.1.1] - 2026-09-19

### Fixed

- **Parallel delegation had no ceiling.** Every delegated specialist is a
  separate process holding hundreds of megabytes, and nothing bounded how many
  could run at once. A leader that over-delegated could exhaust the host's
  memory. `agent_team_handoff prepare` now refuses to exceed
  `orchestration.maxParallelSpecialists` (default 6): the budget is enforced by
  the tool, not left to the model's judgement. The budget bounds how many run
  at once, not how many units a delivery holds — the delivery still runs
  independent work in parallel, in bounded waves.
- **An interrupted test run orphaned every child process.** The end-to-end
  harness killed only the direct child, so the specialist processes it had
  spawned survived and accumulated across the session, driving the machine
  into swap-less memory exhaustion. Runs are now spawned in their own process
  group and the group is killed on timeout, error and interpreter exit.

### Fixed

- Skill registration used a `location` key; `Skill.Info` requires an absolute
  `path`. The server disabled the plugin after the transform failure. Skills now
  resolve `assets/skills/<id>/SKILL.md` inside the installed package, with a
  regression test asserting the registered shape.

## [0.1.0] - 2026-09-19

### Added

- Initial public draft implementation of OpenCode Agent Team.
- Primary agent `agent-team` + 8 specialists (`explorer`, `product`, `architect`,
  `designer`, `builder`, `verifier`, `security`, `release`) materialized by
  `/agent-team/setup` as native OpenCode Markdown agents.
- 14 commands (`start`, `discover`, `thesis`, `decide`, `slice`, `build`,
  `review`, `release`, `status`, `why`, `calibrate`, plus `setup`, `doctor`,
  `export`) registered via `ctx.command.transform`.
- 14 lazy skills (`agent-team-intent-framing` … `agent-team-twin-calibration`).
- 7 tools in the `agent_team` namespace (`agent_team_state`, `agent_team_record_assumption`,
  `agent_team_record_decision`, `agent_team_submit_evidence`, `agent_team_evaluate_gate`,
  `agent_team_request_approval`, `agent_team_handoff`) with closed JSON schemas.
- Project ledger `.agent-team/` (event-sourced `state.json` + `ledger/events.jsonl`
  with hash chaining, atomic writes, optimistic revision, redaction).
- Authority Matrix + `permission.evaluate` semantic enforcement.
- Session hooks (`prompt`, `context`, `compaction`, `retry`) and tool audit
  hooks (`execute.before`/`execute.after`).
- `/agent-team/doctor` model preflight for `opencode/muse-spark-1.3` and reasoning
  variants `low`/`medium`/`high`/`xhigh`/`max`.
- `fixtures/sample-task-board` vertical-slice fixture + `VS-001` flow.
- AgentTeamBench case schema, rubrics, and runner skeleton.
- OpenCode `2.0.10` compatibility. No fork, no remote service, no telemetry.
