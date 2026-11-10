import type { EvidenceRef } from "./schemas.js";

export type EvidenceKind = EvidenceRef["kind"];

/**
 * The kinds that meet a declared minimum.
 *
 * This is a partial order, not a score. Visual and test are incomparable: a
 * screenshot does not prove a unit test, and a unit test does not prove a
 * rendered state. Judgment meets nothing. The table replaces the old
 * free-text claim regex, which both missed paraphrases and let one weak row
 * veto a legitimate claim.
 */
const MEETS: Record<EvidenceKind, readonly EvidenceKind[]> = {
  document: ["document"],
  source: ["source"],
  test: ["test"],
  visual: ["visual"],
  runtime: ["runtime", "test"],
  review: ["review"],
  metric: ["metric"],
  release: ["release", "runtime", "test"],
  judgment: [],
};

/** True when a row of `actual` kind meets a criterion declaring `required`. */
export function kindMeets(actual: EvidenceKind, required: EvidenceKind): boolean {
  return MEETS[actual].includes(required);
}

/**
 * True when a pass row can satisfy a criterion. A judgment never can, and an
 * unobserved row never can: the whole point of the contract is that the plugin
 * ran the check. A prior schema's pass has `observed` absent and is refused.
 */
export function evidenceSatisfiesCriterion(e: EvidenceRef, required?: EvidenceKind): boolean {
  if (e.status !== "pass") return false;
  if (e.kind === "judgment") return false;
  if (e.observed !== true) return false;
  if (!e.artifactRef && !e.command && !e.digest) return false;
  return required ? kindMeets(e.kind, required) : true;
}
