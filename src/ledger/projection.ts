import type { AgentTeamProjectStateV2 } from "../domain/schemas.js";
import { effectiveEvidence } from "../domain/evidence.js";
import { independentReviewCheck } from "../domain/gates.js";

export interface StateProjection {
  phase: string;
  engagement_class: string;
  route: string;
  outcome: string;
  active_delivery?: string | undefined;
  material_constraints: string[];
  open_assumptions: string[];
  decisions: string[];
  gate_status: Record<string, string>;
  criteria: string[];
  critical_risks: string[];
  pending_approvals: string[];
  guardrails: string[];
  autonomy_mode: string;
  handoffs_completed: string[];
  handoffs_open: string[];
  /** Running handoffs with their child session ids. */
  handoffs_running: string[];
  /** Prepared handoffs whose dependencies are all complete: launch these now. */
  handoffs_ready: string[];
  /** Prepared handoffs still waiting on a dependency: do not launch yet. */
  handoffs_blocked: string[];
  missing_independent_review: boolean;
  /** Why the independent review is missing, or what satisfied it. */
  independent_review_status: string;
  next_action: string;
  revision: number;
  /** Waiver targets in force, newest first. */
  waivers: string[];
  /** How many completed handoffs were capped out of the projection. */
  earlier_handoffs: number;
  /** How many decisions were capped out of the projection. */
  earlier_decisions: number;
}

/** The most recent `count` entries, in ledger order, plus the overflow count. */
function recent(list: string[], count: number): { items: string[]; overflow: number } {
  const items = list.slice(-count);
  return { items, overflow: Math.max(0, list.length - items.length) };
}

export function project(state: AgentTeamProjectStateV2): StateProjection {
  const review = independentReviewCheck(state.handoffs);
  const completed = state.handoffs.filter((h) => h.status === "completed").map((h) => `${h.id}:${h.role}`);
  const open = state.handoffs.filter((h) => h.status === "prepared" || h.status === "running").map((h) => `${h.id}:${h.role}`);
  const completedIds = new Set(state.handoffs.filter((h) => h.status === "completed").map((h) => h.id));
  const ready: string[] = [];
  const blocked: string[] = [];
  for (const h of state.handoffs) {
    if (h.status !== "prepared") continue;
    const pending = h.dependsOn.filter((dep) => !completedIds.has(dep));
    if (pending.length === 0) ready.push(`${h.id}:${h.role}`);
    else blocked.push(`${h.id}:${h.role} (needs ${pending.join(", ")})`);
  }
  // Cap the unbounded lists: a long engagement must not outgrow the context
  // window of a small model, which would degrade the projection unevenly
  // across models. The counts keep the leader aware that the list is capped.
  const finished = recent(completed, 12);
  const decided = recent(state.decisions.map((d) => d.id), 10);
  const waived = new Set(state.waivers.map((w) => w.target));
  return {
    phase: state.engagement.phase,
    engagement_class: state.engagementClass ?? "change",
    route: state.route
      ? `route: ${state.route.engagementClass}; names_file_and_symptom: ${state.route.namesFileAndSymptom}; risk: ${state.route.riskSignal}${state.route.model ? `; model: ${state.route.model}` : ""}${state.route.overridden === true ? "; overridden" : ""}`
      : "route: not recorded",
    outcome: state.outcome,
    active_delivery: state.activeDelivery?.id,
    material_constraints: state.constraints.slice(0, 8),
    open_assumptions: state.assumptions
      .filter((a) => a.confidence === "low")
      .map((a) => `${a.id}: ${a.statement}`.slice(0, 200)),
    decisions: decided.items,
    gate_status: Object.fromEntries(state.gates.slice(-6).map((g) => [g.gate.toLowerCase(), g.result])),
    criteria: (state.activeDelivery?.acceptanceCriteria ?? []).map((criterion) => {
      // The same effective set the gate reads: a failed run stops poisoning
      // the criterion once a later observed pass of the same check exists.
      // A waived criterion says so instead of showing the fail a waiver
      // already relaxed.
      const rows = effectiveEvidence(state.evidence.filter((e) => e.criterionId === criterion && e.kind !== "judgment"));
      if (waived.has(criterion)) return `${criterion}: waived`;
      if (rows.some((e) => e.status === "fail")) return `${criterion}: failed`;
      const pass = rows.find((e) => e.status === "pass" && e.observed === true);
      if (pass) return `${criterion}: satisfied (observed)`;
      return `${criterion}: missing`;
    }),
    critical_risks: state.risks
      .filter((r) => r.severity === "critical" || r.severity === "high")
      .map((r) => r.statement.slice(0, 200))
      .slice(0, 8),
    pending_approvals: state.approvals.filter((a) => a.status === "pending").map((a) => `${a.id}:${a.requestedAction}`),
    guardrails: state.guardrails.slice(0, 20),
    autonomy_mode: state.autonomyMode ?? "yolo",
    handoffs_completed: finished.items,
    handoffs_open: open,
    handoffs_running: state.handoffs.filter((h) => h.status === "running").map((h) => `${h.id}:${h.role}:${h.sessionID ?? "no-session"}`),
    handoffs_ready: ready,
    handoffs_blocked: blocked,
    missing_independent_review: !review.satisfied,
    independent_review_status: review.reason,
    next_action: state.nextAction.description,
    revision: state.revision,
    waivers: [...state.waivers].reverse().map((w) => w.target),
    earlier_handoffs: finished.overflow,
    earlier_decisions: decided.overflow,
  };
}

export function renderProjectionYaml(p: StateProjection): string {
  const lines = [
    `phase: ${p.phase}`,
    `engagement_class: ${p.engagement_class}`,
    `${p.route}`,
    `outcome: ${JSON.stringify(p.outcome.slice(0, 300))}`,
    ...(p.active_delivery ? [`active_delivery: ${p.active_delivery}`] : []),
    `material_constraints: ${JSON.stringify(p.material_constraints)}`,
    `open_assumptions: ${JSON.stringify(p.open_assumptions)}`,
    `decisions: [${p.decisions.join(", ")}]`,
    ...(p.earlier_decisions > 0 ? [`earlier_decisions: ${p.earlier_decisions}`] : []),
    `gate_status: ${JSON.stringify(p.gate_status)}`,
    `criteria: ${JSON.stringify(p.criteria)}`,
    `critical_risks: ${JSON.stringify(p.critical_risks)}`,
    `pending_approvals: ${JSON.stringify(p.pending_approvals)}`,
    `waivers: ${JSON.stringify(p.waivers)}`,
    `autonomy: ${p.autonomy_mode}`,
    `guardrails: ${JSON.stringify(p.guardrails)}`,
    `handoffs_completed: [${p.handoffs_completed.join(", ")}]`,
    ...(p.earlier_handoffs > 0 ? [`earlier_handoffs: ${p.earlier_handoffs}`] : []),
    `handoffs_open: [${p.handoffs_open.join(", ")}]`,
    `handoffs_running: [${p.handoffs_running.join(", ")}]`,
    `handoffs_ready: [${p.handoffs_ready.join(", ")}]`,
    `handoffs_blocked: [${p.handoffs_blocked.join(", ")}]`,
    `missing_independent_review: ${p.missing_independent_review ? "true" : "false"} — ${p.independent_review_status}`,
    `next_action: ${JSON.stringify(p.next_action.slice(0, 300))}`,
    `revision: ${p.revision}`,
  ];
  return lines.join("\n");
}
