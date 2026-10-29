import type { EvidenceRef } from "./schemas.js";

/** CLAIM strength ≤ EVIDENCE strength. Maps evidence kinds to the claims they support. */
const SUPPORTS: Record<EvidenceRef["kind"], string[]> = {
  test: ["covered units pass", "types compile"],
  runtime: ["request was accepted", "rendered state observed"],
  visual: ["rendered state observed"],
  source: ["source inspected"],
  review: ["independent review completed"],
  release: ["release candidate passed defined checks"],
  document: ["artifact exists", "document produced"],
  metric: ["number moved", "metric measured"],
  /**
   * A judgement supports no canonical claim. Its acceptance comes from the
   * operator policy alone, and it never satisfies a criterion.
   */
  judgment: [],
};

const FORBIDDEN: Array<{ evidence: EvidenceRef["kind"]; claim: RegExp; reason: string }> = [
  { evidence: "test", claim: /end.?to.?end|integration.*healthy|production.*ready/i, reason: "unit tests do not prove integration/production" },
  { evidence: "runtime", claim: /delivery completed|backend.*correct|no defects/i, reason: "single response does not prove async completion" },
  { evidence: "visual", claim: /backend.*correct|api.*correct/i, reason: "screenshot does not prove backend" },
  { evidence: "review", claim: /production.*healthy|deployed/i, reason: "review is not deploy proof" },
];

/**
 * A claim that this kind of evidence may not support at all.
 *
 * Unlike `claimSupported`, which answers "does this kind of evidence back
 * this canonical claim", this answers "is this claim forbidden for this kind
 * of evidence" — the case where the claim is stronger than the evidence can
 * ever be, such as proving production health from unit tests.
 */
export function forbiddenClaim(kind: EvidenceRef["kind"], claim: string): string | undefined {
  for (const f of FORBIDDEN) {
    if (f.evidence === kind && f.claim.test(claim)) return f.reason;
  }
  return undefined;
}

export function claimSupported(kind: EvidenceRef["kind"], claim: string): { ok: boolean; reason?: string } {
  const forbidden = forbiddenClaim(kind, claim);
  if (forbidden) return { ok: false, reason: forbidden };
  const supported = SUPPORTS[kind] ?? [];
  if (supported.some((s) => claim.toLowerCase().includes(s))) return { ok: true };
  // Conservative default: unknown claims need explicit review evidence.
  return { ok: false, reason: `claim exceeds ${kind} evidence strength` };
}

export function evidenceSatisfiesCriterion(e: EvidenceRef): boolean {
  if (e.status !== "pass") return false;
  // A judgement is a record, not a proof. Excluding it here is what keeps it
  // from satisfying a criterion through the generic path.
  if (e.kind === "judgment") return false;
  return Boolean(e.artifactRef || e.command || e.digest);
}
