import type { DecisionRef, EvidenceRef, GateRef, HandoffRef } from "./schemas.js";
import { evidenceSatisfiesCriterion, type EvidenceKind } from "./evidence.js";
import { scopeOverlaps } from "./scope.js";

export interface GateResult {
  result: "PASS" | "FAIL" | "BLOCKED";
  satisfied: string[];
  missing: string[];
  failed: string[];
  waivers: string[];
  nextAction: string;
}

export function evaluateAcceptGate(input: {
  criteria: string[];
  evidence: EvidenceRef[];
  findings: Array<{ severity: string }>;
  waivers?: string[];
  blockedBy?: string[];
  /**
   * When false (the default), a criterion is satisfied only by a `pass` row
   * that carries proof. When true, a `partial` row that carries proof also
   * satisfies it. A summary-only row never satisfies a criterion in either
   * mode: the proof requirement is an integrity rule and does not relax.
   */
  acceptPartial?: boolean;
  /**
   * The minimum evidence kind each criterion requires, keyed by criterion id.
   * Absence means any observed non-judgment kind may satisfy it.
   */
  criterionKinds?: Record<string, EvidenceKind>;
  /** The decisions the engagement rests on. Each must be traceable. */
  decisions?: DecisionRef[];
}): GateResult {
  const waivers = input.waivers ?? [];
  const acceptPartial = input.acceptPartial === true;
  const byCriterion = new Map<string, EvidenceRef[]>();
  for (const e of input.evidence) {
    const list = byCriterion.get(e.criterionId) ?? [];
    list.push(e);
    byCriterion.set(e.criterionId, list);
  }
  const satisfied: string[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const c of input.criteria) {
    if (waivers.includes(c)) continue;
    const evs = byCriterion.get(c) ?? [];
    // A judgement is a record, not a proof: it neither satisfies nor fails a
    // criterion, so every branch below ignores it.
    if (evs.some((e) => e.kind !== "judgment" && e.status === "fail")) {
      failed.push(c);
      continue;
    }
    // pass requires verifiable artifact/command/digest, and a kind that meets
    // the criterion's declared minimum.
    const required = input.criterionKinds?.[c];
    const passing = evs.filter((e) => {
      if (e.kind === "judgment") return false;
      if (e.status === "pass") return evidenceSatisfiesCriterion(e, required);
      // Partial never satisfies, even when strictness is relaxed. Relaxing it
      // would make "I ran part of the check" a pass without observation.
      return false;
    });
    if (passing.length > 0) satisfied.push(c);
    else missing.push(c);
  }
  const blocking = input.findings.some((f) => f.severity === "critical" || f.severity === "high");
  // The gate no longer reads a free-text claim. Evidence strength is the
  // declared kind on the criterion, and observation is the proof requirement.
  if (input.blockedBy && input.blockedBy.length > 0 && failed.length === 0 && missing.length > 0) {
    return { result: "BLOCKED", satisfied, missing, failed, waivers, nextAction: `Resolve blocker: ${input.blockedBy[0]}` };
  }
  if (failed.length > 0 || blocking) {
    return { result: "FAIL", satisfied, missing, failed, waivers, nextAction: failed.length > 0 ? `Fix failed criteria: ${failed.join(", ")}` : "Resolve critical/high review findings" };
  }
  // A decision with no recorded basis is a preference. Every decision the
  // engagement rests on must carry drivers, real options and a rationale.
  if (input.decisions && input.decisions.length > 0 && !decisionsTraceable(input.decisions)) {
    missing.push("traceable-decisions");
    return { result: "FAIL", satisfied, missing, failed, waivers, nextAction: "Give every decision drivers, at least two options and a rationale" };
  }
  if (missing.length > 0) {
    return { result: "FAIL", satisfied, missing, failed, waivers, nextAction: `Provide evidence for: ${missing.join(", ")}` };
  }
  return { result: "PASS", satisfied, missing, failed, waivers, nextAction: "Promote per release contract" };
}

export function gateRecordFor(gate: GateRef["gate"], claim: string, result: GateResult, contractDigest?: string): GateRef {
  return {
    gate,
    result: result.result,
    claim,
    satisfied: result.satisfied,
    missing: result.missing,
    failed: result.failed,
    waivers: result.waivers,
    nextAction: result.nextAction,
    evaluatedAt: new Date().toISOString(),
    ...(contractDigest ? { contractDigest } : {}),
  };
}

export function decisionsTraceable(decisions: DecisionRef[]): boolean {
  return decisions.every((d) => d.drivers.length > 0 && d.options.length >= 2 && d.rationale.length > 0);
}

/** Roles that produce the implementation a reviewer has to check. */
const IMPLEMENTATION_ROLES = new Set(["coder", "worker"]);

export interface ReviewCheck {
  satisfied: boolean;
  reason: string;
}

/**
 * Whether the review was independent.
 *
 * "A completed reviewer handoff exists" is too weak on its own: the leader
 * could point a reviewer at nothing and the gate would pass. The reviewer
 * must also have been pointed at the work: when an implementation handoff
 * was completed, the reviewer's scope must overlap it. Without that, a
 * reviewer can rubber-stamp a delivery it never looked at.
 */
export function independentReviewCheck(handoffs: HandoffRef[], changedPaths: string[] = []): ReviewCheck {
  const reviewers = handoffs.filter((h) => h.role === "reviewer" && h.status === "completed");
  if (reviewers.length === 0) {
    return { satisfied: false, reason: "no completed team-leader/reviewer handoff" };
  }
  const failedReviewer = reviewers.find((h) => {
    const status = (h.result as { status?: string } | undefined)?.status;
    return status === "FAIL" || status === "BLOCKED";
  });
  if (failedReviewer) {
    return { satisfied: false, reason: `reviewer ${failedReviewer.id} reported ${(failedReviewer.result as { status?: string }).status}` };
  }
  const reviewer = reviewers.find((h) => h.allowedScope.length > 0) ?? reviewers[0]!;
  const implementations = handoffs.filter((h) => IMPLEMENTATION_ROLES.has(h.role) && h.status === "completed");
  if (implementations.length === 0 && changedPaths.length === 0) {
    return { satisfied: false, reason: "the delivery has no implementation to review" };
  }
  if (reviewer.allowedScope.length === 0) {
    return { satisfied: false, reason: "the reviewer handoff has no allowed scope, so it cannot be shown to have reviewed the implementation" };
  }
  // Independence is unprovable without the session ids. Fail closed.
  if (!reviewer.sessionID) {
    return { satisfied: false, reason: "the reviewer handoff has no session id, so independence cannot be shown" };
  }
  if (implementations.some((h) => !h.sessionID)) {
    return { satisfied: false, reason: "an implementation handoff has no session id, so independence cannot be shown" };
  }
  const authorSessions = new Set(implementations.map((h) => h.sessionID).filter((id): id is string => Boolean(id)));
  if (authorSessions.has(reviewer.sessionID)) {
    return { satisfied: false, reason: "the reviewer session is the session that wrote the implementation" };
  }
  for (const impl of implementations) {
    if (!scopeOverlaps(reviewer.allowedScope, impl.allowedScope)) {
      return { satisfied: false, reason: `the reviewer handoff does not cover the scope of ${impl.id}` };
    }
  }
  for (const path of changedPaths) {
    if (!scopeOverlaps(reviewer.allowedScope, [path])) {
      return { satisfied: false, reason: `the reviewer handoff does not cover the changed path ${path}` };
    }
  }
  return { satisfied: true, reason: "reviewer handoff completed over every implementation and changed path" };
}
