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

/**
 * The rows the gate and projection algebra may read.
 *
 * A failed run of a check is an observation of that check at a point in time,
 * not a property of the criterion forever. Without this filter, one failed
 * run poisons the criterion even after a later observed pass of the same
 * command proves it — and a delivery that was fixed could never recover. The
 * effective set keeps, per (criterion, command), the newest row, with one
 * exception: an observed pass outranks any later unobserved row, because a
 * plugin-recorded observation cannot be un-proven by a typed claim. Rows
 * without a command (typed fail/partial submissions) are never superseded by
 * observation — only a recorded waiver relaxes them.
 */
export function effectiveEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  const latest = new Map<string, EvidenceRef>();
  for (const row of evidence) {
    const key = `${row.criterionId}\u0000${row.command ?? ""}`;
    const current = latest.get(key);
    if (!current) {
      latest.set(key, row);
      continue;
    }
    if (row.observedAt < current.observedAt) continue;
    // An observed row is stronger than a typed one: a later typed claim never
    // un-proves an observed pass (or an observed fail).
    if (current.observed === true && row.observed !== true) continue;
    latest.set(key, row);
  }
  return [...latest.values()];
}
