import type { DecisionRef, EvidenceRef, GateRef, HandoffRef } from "./schemas.js";
import { evidenceSatisfiesCriterion, forbiddenClaim } from "./evidence.js";
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
  /** The claim made at this gate, checked against the evidence kind behind it. */
  claim?: string;
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
    if (evs.some((e) => e.status === "fail")) {
      failed.push(c);
      continue;
    }
    // pass requires verifiable artifact/command/digest
    const passing = evs.filter((e) => {
      if (e.status === "pass") return evidenceSatisfiesCriterion(e);
      if (acceptPartial && e.status === "partial") return Boolean(e.artifactRef || e.command || e.digest);
      return false;
    });
    if (passing.length > 0) satisfied.push(c);
    else missing.push(c);
  }
  const blocking = input.findings.some((f) => f.severity === "critical" || f.severity === "high");
  if (input.blockedBy && input.blockedBy.length > 0 && failed.length === 0 && missing.length > 0) {
    return { result: "BLOCKED", satisfied, missing, failed, waivers, nextAction: `Resolve blocker: ${input.blockedBy[0]}` };
  }
  if (failed.length > 0 || blocking) {
    return { result: "FAIL", satisfied, missing, failed, waivers, nextAction: failed.length > 0 ? `Fix failed criteria: ${failed.join(", ")}` : "Resolve critical/high review findings" };
  }
  // CLAIM ≤ EVIDENCE: the claim must not be stronger than the evidence behind
  // it. A gate claiming production health on the strength of unit tests is
  // refused, however many criterion-linked rows it carries.
  const claimProblem = input.claim ? forbiddenClaimIn(input.evidence, input.claim) : undefined;
  if (claimProblem) {
    missing.push("claim-evidence-strength");
    return { result: "FAIL", satisfied, missing, failed, waivers, nextAction: `Weaken the claim or strengthen the evidence: ${claimProblem}` };
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

/** The first evidence kind that may not support the claim. */
function forbiddenClaimIn(evidence: EvidenceRef[], claim: string): string | undefined {
  for (const e of evidence) {
    if (e.status !== "pass") continue;
    const reason = forbiddenClaim(e.kind, claim);
    if (reason) return reason;
  }
  return undefined;
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
export function independentReviewCheck(handoffs: HandoffRef[]): ReviewCheck {
  const reviewer = handoffs.find((h) => h.role === "reviewer" && h.status === "completed");
  if (!reviewer) {
    return { satisfied: false, reason: "no completed team-leader/reviewer handoff" };
  }
  const implementations = handoffs.filter((h) => IMPLEMENTATION_ROLES.has(h.role) && h.status === "completed");
  if (implementations.length === 0) {
    return { satisfied: true, reason: "reviewer handoff completed; no implementation handoff to cross-check" };
  }
  if (reviewer.allowedScope.length === 0) {
    return { satisfied: false, reason: "the reviewer handoff has no allowed scope, so it cannot be shown to have reviewed the implementation" };
  }
  const covered = implementations.some((impl) => scopeOverlaps(reviewer.allowedScope, impl.allowedScope));
  if (!covered) {
    return { satisfied: false, reason: "the reviewer handoff does not cover the scope of the implementation it reviewed" };
  }
  return { satisfied: true, reason: "reviewer handoff completed over the implementation's scope" };
}
