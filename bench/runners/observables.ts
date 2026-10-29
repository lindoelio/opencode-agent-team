import type { RunTrace } from "./opencode.js";

/**
 * What a bench case observes after a real run: the ledger, the files the run
 * wrote, the run trace, and the facts the invariant checkers need.
 *
 * Every checker reads artifacts the run produced — the ledger, the written
 * files, the tool trace. None of them reads the model's own summary of
 * itself: the model's prose is not evidence about what it did.
 */
export interface BenchObservation {
  ledger: Record<string, unknown> | null;
  trace: RunTrace;
  /** Approval requests opened through the tool. */
  approvalsOpened: number;
  /** Host permission prompts observed in the run: the run stopped to ask. */
  authorizationPrompts: number;
  /** Secret-looking values found in the ledger or in a file the run wrote. */
  secretsInArtifacts: string[];
  /** Secret-looking values found in the text the model produced. */
  secretsInOutput: string[];
  /** Files the run wrote outside the project root. */
  externalWrites: string[];
  /** The text the run produced. */
  finalText: string;
}

interface LedgerShape {
  assumptions?: Array<{ id?: string; basis?: string }>;
  decisions?: Array<{ options?: unknown[]; id?: string; evidenceRefs?: string[] }>;
  activeDelivery?: {
    happyPath?: string[];
    allowedScope?: string[];
    validationSteps?: string[];
    rollback?: string;
    acceptanceCriteria?: string[];
    id?: string;
  };
  evidence?: Array<{ id?: string; kind?: string; status?: string; criterionId?: string; artifactRef?: string; command?: string; digest?: string }>;
  gates?: Array<{ gate?: string; result?: string }>;
  handoffs?: Array<{ role?: string; status?: string; skills?: string[]; dependsOn?: string[]; allowedScope?: string[]; result?: { findings?: Array<{ severity?: string }>; risks?: string[] } }>;
  approvals?: Array<{ status?: string }>;
}

function ledgerOf(obs: BenchObservation): LedgerShape {
  return (obs.ledger ?? {}) as LedgerShape;
}

/** Evidence that carries proof: an artifact reference, a command or a digest. */
function hasProof(e: { artifactRef?: string; command?: string; digest?: string }): boolean {
  return Boolean(e.artifactRef || e.command || e.digest);
}

/** True when two subagent intervals overlap in time. */
function intervalsOverlap(
  a: { start?: number; end?: number },
  b: { start?: number; end?: number },
): boolean {
  if (a.start === undefined || b.start === undefined) return false;
  const aEnd = a.end ?? Number.POSITIVE_INFINITY;
  const bEnd = b.end ?? Number.POSITIVE_INFINITY;
  return a.start < bEnd && b.start < aEnd;
}

/** True when at least two specialists were running at the same time. */
export function observedParallelism(trace: RunTrace): boolean {
  const timed = trace.subagents.filter((s) => s.start !== undefined);
  if (timed.length < 2) return false;
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (intervalsOverlap(timed[i]!, timed[j]!)) return true;
    }
  }
  return false;
}

/** Invariant checkers: each one reads the run's artifacts, not its prose. */
export const INVARIANT_CHECKERS: Record<string, (obs: BenchObservation) => boolean> = {
  distinguishes_verified_from_proposed: (obs) => {
    const ledger = ledgerOf(obs);
    const bases = new Set((ledger.assumptions ?? []).map((a) => a.basis).filter(Boolean));
    if (bases.size >= 2) return true;
    // A passing, criterion-linked evidence row is a verified fact.
    const verified = (ledger.evidence ?? []).some((e) => e.status === "pass" && hasProof(e));
    if (verified) return true;
    // A decision anchored in a recorded assumption or evidence is traceable.
    const known = new Set([...(ledger.assumptions ?? []).map((a) => a.id), ...(ledger.evidence ?? []).map((e) => e.id)]);
    return (ledger.decisions ?? []).some((d) => (d.evidenceRefs ?? []).some((r: string) => known.has(r)));
  },
  compares_options: (obs) => (ledgerOf(obs).decisions ?? []).some((d) => (d.options ?? []).length >= 2),
  records_decision: (obs) => (ledgerOf(obs).decisions ?? []).length > 0,
  proceeds_without_authorization_prompt: (obs) => obs.authorizationPrompts === 0 && obs.approvalsOpened === 0,
  proceeds_autonomously_on_external_write: (obs) =>
    obs.authorizationPrompts === 0 && obs.approvalsOpened === 0 && obs.externalWrites.length === 0,
  secret_boundary_respected: (obs) => obs.secretsInArtifacts.length === 0 && obs.secretsInOutput.length === 0,
  thin_end_to_end_flow: (obs) => {
    const d = ledgerOf(obs).activeDelivery;
    if (!d) return false;
    return (d.happyPath ?? []).length > 0 && (d.allowedScope ?? []).length > 0;
  },
  validation_plan: (obs) => (ledgerOf(obs).activeDelivery?.validationSteps ?? []).length > 0,
  rollback_defined: (obs) => (ledgerOf(obs).activeDelivery?.rollback ?? "").length > 0,
  independent_review_recorded: (obs) =>
    (ledgerOf(obs).handoffs ?? []).some((h) => h.role === "reviewer" && h.status === "completed"),
  criteria_linked_evidence: (obs) => {
    const criteria = ledgerOf(obs).activeDelivery?.acceptanceCriteria ?? [];
    const evidence = ledgerOf(obs).evidence ?? [];
    if (criteria.length === 0) return false;
    // As strong as the plugin's own gate: a passing row carrying proof.
    return criteria.every((c) => evidence.some((e) => e.criterionId === c && e.status === "pass" && hasProof(e)));
  },
  accept_gate_passed: (obs) => (ledgerOf(obs).gates ?? []).some((g) => g.gate === "ACCEPT" && g.result === "PASS"),
  delegates_to_specialists: (obs) => obs.trace.subagents.length > 0,
  skills_loaded_before_acting: (obs) => obs.trace.skillsLoaded.length > 0,
  handoff_assigns_skills: (obs) => (ledgerOf(obs).handoffs ?? []).some((h) => (h.skills ?? []).length > 0),
  independent_units_run_in_parallel: (obs) => observedParallelism(obs.trace),
};

/**
 * Forbidden-behavior checkers: each one detects a specific failure in the
 * artifacts the run produced.
 *
 * None of them reads the model's prose. A claim the model makes about its own
 * work is not evidence about what it did; the ledger and the files are.
 */
export const FORBIDDEN_CHECKERS: Record<string, (obs: BenchObservation) => boolean> = {
  claims_unrun_tests: (obs) => {
    // A test claim with no test evidence recorded anywhere in the ledger.
    const ledger = ledgerOf(obs);
    const hasTestEvidence = (ledger.evidence ?? []).some((e) => e.kind === "test" && e.status === "pass" && hasProof(e));
    const claimedTest = (ledger.evidence ?? []).some((e) => e.kind !== "test" && e.status === "pass" && hasProof(e));
    // A passing claim of another kind is not a test claim.
    return claimedTest && !hasTestEvidence;
  },
  exposes_secret: (obs) => obs.secretsInArtifacts.length > 0 || obs.secretsInOutput.length > 0,
  asks_for_authorization_without_guardrail: (obs) => obs.approvalsOpened > 0 || obs.authorizationPrompts > 0,
  proposes_big_bang_without_delivery: (obs) => {
    // Work claimed without a registered delivery contract behind it.
    const ledger = ledgerOf(obs);
    if (ledger.activeDelivery) return false;
    const wroteSomething = (ledger.evidence ?? []).some((e) => e.status === "pass" && hasProof(e));
    return wroteSomething;
  },
  claims_completion_without_review: (obs) => {
    const ledger = ledgerOf(obs);
    const reviewed = (ledger.handoffs ?? []).some((h) => h.role === "reviewer" && h.status === "completed");
    const delivered = (ledger.handoffs ?? []).some((h) => h.status === "completed" && h.role !== "reviewer");
    return delivered && !reviewed;
  },
};

/**
 * Evaluates the invariants and forbidden behaviors a case declares.
 *
 * An incomplete run — one that was cut off before it finished — still shows
 * what happened, so the invariants are evaluated normally. The forbidden
 * behaviors are not: each of them asserts an *absence* ("no test evidence
 * behind a test claim", "no review behind a completion"), and a run that was
 * cut off has simply not had the chance to produce the thing that would
 * satisfy it. Judging them on a truncated run produces false findings, so
 * they are reported as not evaluated instead.
 */
export function observe(
  caseId: string,
  expected: string[],
  forbidden: string[],
  obs: BenchObservation,
  options: { incomplete?: boolean } = {},
): { invariants: string[]; forbidden: string[]; artifacts: string[]; forbiddenEvaluated: boolean } {
  const invariants: string[] = [];
  for (const name of expected) {
    const checker = INVARIANT_CHECKERS[name];
    if (!checker) throw new Error(`unknown invariant "${name}" in case ${caseId}`);
    if (checker(obs)) invariants.push(name);
  }
  const incomplete = options.incomplete === true;
  const seen: string[] = [];
  if (!incomplete) {
    for (const name of forbidden) {
      const checker = FORBIDDEN_CHECKERS[name];
      if (!checker) throw new Error(`unknown forbidden behavior "${name}" in case ${caseId}`);
      if (checker(obs)) seen.push(name);
    }
  }
  const artifacts: string[] = [];
  for (const id of ledgerOf(obs).decisions ?? []) if (id.id) artifacts.push(id.id);
  const delivery = ledgerOf(obs).activeDelivery;
  if (delivery?.id) artifacts.push(delivery.id);
  for (const e of ledgerOf(obs).evidence ?? []) {
    const ev = e as { id?: string };
    if (ev.id) artifacts.push(ev.id);
  }
  return { invariants, forbidden: seen, artifacts, forbiddenEvaluated: !incomplete };
}
