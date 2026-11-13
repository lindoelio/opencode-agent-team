import { SpecialistResultSchema, SpecialistRoleSchema, type RiskRef, type SpecialistResult } from "./schemas.js";

export const HANDOFF_ROLES = SpecialistRoleSchema.options;
export type HandoffRole = (typeof HANDOFF_ROLES)[number];

/**
 * Roles whose contract forbids editing. They may not spawn a helper agent
 * either: a helper could edit or shell, which would make the role's read-only
 * contract unenforceable. The context hook denies the subagent tool and the
 * child prompt states the same boundary — one set, so the three cannot
 * disagree.
 */
export const READ_ONLY_ROLES: ReadonlySet<HandoffRole> = new Set([
  "explorer",
  "product",
  "architect",
  "reviewer",
  "security",
]);

/**
 * The canonical specialist report shape.
 *
 * It travels in every child prompt: the strict schema is only discoverable
 * through a failed tool call otherwise, which costs a weak model a turn that
 * a strong model never spends. One line, one shape, every role.
 */
export const REPORT_SHAPE_LINE =
  "Report shape (SpecialistResult@1, strict): { status: PASS|FAIL|BLOCKED|ADVISORY, summary, " +
  "findings[{severity: critical|high|medium|low|note, claim, evidence[]}], risks[], unknowns[], recommended_next_action }. " +
  "Call agent_team_report with it and stop; do not return the result as prose for the leader to copy.";

/**
 * Validates a specialist result against the closed `SpecialistResult@1`
 * shape. The gate reads findings and risks out of this record, so an
 * incomplete result would make the gate read an empty report as "nothing
 * found". Rejecting it at the boundary is the point.
 */
export function validateResult(result: unknown): SpecialistResult {
  const parsed = SpecialistResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`invalid specialist result: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * True when at least one wave carried two or more units.
 *
 * The wave id is the ledger's own record of what was booked together, so
 * parallelism is measured from the artifact rather than from the host's
 * subagent trace — which the wave API does not produce. A handoff booked
 * before waves existed carries no id and is not counted either way.
 */
export function handoffsRunInParallel(handoffs: ReadonlyArray<{ wave?: string }>): boolean {
  const perWave = new Map<string, number>();
  for (const h of handoffs) {
    if (!h.wave) continue;
    perWave.set(h.wave, (perWave.get(h.wave) ?? 0) + 1);
  }
  for (const count of perWave.values()) {
    if (count >= 2) return true;
  }
  return false;
}

const SEVERITY_RANK: Record<string, number> = { note: 0, low: 1, medium: 2, high: 3, critical: 4 };
const CRITICAL_RANK = SEVERITY_RANK["critical"] ?? 4;
const HIGH_RANK = SEVERITY_RANK["high"] ?? 3;

/**
 * Turns the risks a specialist reported into ledger risk records, so the
 * projection's `critical_risks` is fed by the work instead of staying empty.
 * The severity is the strongest severity the same result reported: a risk
 * that travels with a critical finding is critical.
 */
export function risksFromResult(result: SpecialistResult, startIndex: number): RiskRef[] {
  const strongest = result.findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] ?? 0), 0);
  const severity = strongest >= CRITICAL_RANK ? "critical" : strongest >= HIGH_RANK ? "high" : "medium";
  return result.risks.map((statement, index) => ({
    id: `RSK-${String(startIndex + index).padStart(4, "0")}`,
    statement,
    severity,
  }));
}
