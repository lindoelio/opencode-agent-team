import { SpecialistResultSchema, SpecialistRoleSchema, type RiskRef, type SpecialistResult } from "./schemas.js";

export const HANDOFF_ROLES = SpecialistRoleSchema.options;
export type HandoffRole = (typeof HANDOFF_ROLES)[number];

export interface HandoffPacket {
  handoff_id: string;
  role: HandoffRole;
  objective: string;
  context: string[];
  scope: { allowed: string[]; prohibited: string[] };
  questions_to_answer: string[];
  required_evidence: string[];
  /** Skills the specialist must load before acting. */
  skills: string[];
  /** Handoff ids that must complete before this one can start. */
  depends_on: string[];
  output_schema: "SpecialistResult@1";
  stop_condition: string;
}

export function buildPacket(input: {
  id: string;
  role: HandoffRole;
  objective: string;
  context: string[];
  allowedScope: string[];
  prohibitedScope: string[];
  questions: string[];
  requiredEvidence: string[];
  stopCondition: string;
  skills?: string[];
  dependsOn?: string[];
}): HandoffPacket {
  return {
    handoff_id: input.id,
    role: input.role,
    objective: input.objective,
    context: input.context,
    scope: { allowed: input.allowedScope, prohibited: input.prohibitedScope },
    questions_to_answer: input.questions,
    required_evidence: input.requiredEvidence,
    skills: input.skills ?? [],
    depends_on: input.dependsOn ?? [],
    output_schema: "SpecialistResult@1",
    stop_condition: input.stopCondition,
  };
}

export function renderPacketPrompt(p: HandoffPacket): string {
  return [
    `You are team-leader/${p.role}. Bounded handoff ${p.handoff_id}.`,
    `Objective: ${p.objective}`,
    `Allowed scope: ${p.scope.allowed.join(", ") || "(none)"}`,
    `Prohibited scope: ${p.scope.prohibited.join(", ") || "(none)"}`,
    `Questions to answer: ${p.questions_to_answer.join(" | ") || "(none)"}`,
    `Required evidence: ${p.required_evidence.join(" | ") || "(none)"}`,
    `Load skills first: ${p.skills.join(", ") || "(none specified — pick the ones inside your specialty)"}`,
    ...(p.depends_on.length > 0 ? [`Wait for these handoffs to complete before starting: ${p.depends_on.join(", ")}`] : []),
    `Stop when: ${p.stop_condition}`,
    `Return SpecialistResult@1 JSON: status PASS|FAIL|BLOCKED|ADVISORY, summary, findings[{severity,claim,evidence}], risks, unknowns, recommended_next_action.`,
    `Act autonomously; do not ask for authorization unless a registered guardrail covers the action.`,
    `You may launch built-in OpenCode helper agents (e.g. explore, general); never create team-leader/* agents. Do not claim completion without evidence.`,
  ].join("\n");
}

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
