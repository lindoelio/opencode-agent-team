import { EvaluateGateInputSchema } from "../domain/schemas.js";
import { evaluateAcceptGate, gateRecordFor, independentReviewCheck } from "../domain/gates.js";
import { appendEvent  } from "../ledger/store.js";
import { sha256Hex } from "../util/hash.js";
import { changedPaths, snapshotScope } from "../orchestrator/digest.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const GATE_TOOL = {
  name: "evaluate_gate",
  description: "Deterministically evaluate a gate from ledger state (result computed by plugin, not chosen by model). REVIEW and ACCEPT require a completed team-leader/reviewer handoff.",
  input: {
    type: "object",
    properties: {
      gate: { type: "string", enum: ["INTENT", "DISCOVERY", "PLAN", "VERIFY", "REVIEW", "ACCEPT", "DELIVER"] },
      claim: { type: "string" },
      expectedRevision: { type: "number" },
    },
    required: ["gate", "expectedRevision"],
    additionalProperties: false,
  },
} as const;

export async function executeGate(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = EvaluateGateInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid gate input: ${parsed.error.message}`);
  const input = parsed.data;
  const { projectRoot, current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "evaluate a gate");

  const criteria = current.activeDelivery?.acceptanceCriteria ?? [];
  const findings = current.handoffs.flatMap((h) => {
    const r = h.result as { findings?: Array<{ severity: string }> } | undefined;
    return r?.findings ?? [];
  });
  const pendingApprovals = current.approvals.filter((a) => a.status === "pending").map((a) => a.id);
  const highImpactLowConfidence = current.assumptions.some((a) => a.confidence === "low");
  // A digest of the delivery contract as it stands. The ACCEPT gate records
  // it and the DELIVER gate compares it, so a delivery cannot be quietly
  // changed between being accepted and being promoted.
  const contractDigest = current.activeDelivery ? sha256Hex(JSON.stringify(current.activeDelivery)) : undefined;
  const tree = current.activeDelivery ? snapshotScope(projectRoot, current.activeDelivery.allowedScope) : undefined;
  const treeDigest = tree?.digest;
  const changed = changedPaths(current.activeDelivery?.baselineFiles, tree?.files ?? {});
  // Independent review is mechanical, not advisory: REVIEW/ACCEPT require a
  // completed team-leader/reviewer handoff that covers every implementation
  // handoff and every product path that changed. Self-review never passes.
  const review = independentReviewCheck(current.handoffs, changed);
  const independentReview = review.satisfied;

  let result;
  if ((input.gate === "REVIEW" || input.gate === "ACCEPT") && !independentReview) {
    result = { result: "FAIL" as const, satisfied: [] as string[], missing: ["independent-review"], failed: [] as string[], waivers: [] as string[], nextAction: `Prepare a team-leader/reviewer handoff via agent_team_handoff, complete it with evidence, then re-evaluate (${review.reason})` };
  } else if (criteria.length === 0 && (input.gate === "VERIFY" || input.gate === "REVIEW" || input.gate === "ACCEPT")) {
    // No active delivery, nothing to verify: fail honestly instead of passing vacuously.
    result = { result: "FAIL" as const, satisfied: [] as string[], missing: ["active-delivery"], failed: [] as string[], waivers: [] as string[], nextAction: "Define an active delivery first" };
  } else if (input.gate === "ACCEPT" || input.gate === "VERIFY" || input.gate === "REVIEW") {
    result = evaluateAcceptGate({
      criteria,
      evidence: current.evidence,
      findings: findings.map((f) => ({ severity: f.severity })),
      blockedBy: current.nextAction.blockedBy,
      // `strictEvidence` is the only knob on evidence strength, and it never
      // relaxes the proof requirement: it only decides whether a `partial`
      // row carrying proof can satisfy a criterion.
      acceptPartial: runtime.options.strictEvidence === false,
      criterionKinds: current.activeDelivery?.criterionKinds,
      decisions: current.decisions,
    });
    // High-impact low-confidence assumptions block ACCEPT until waived.
    if (input.gate === "ACCEPT" && highImpactLowConfidence && result.result === "PASS") {
      result = { ...result, result: "FAIL" as const, missing: [...result.missing, "open-assumptions"], nextAction: "Validate or explicitly waive low-confidence high-impact assumptions" };
    }
  } else if (input.gate === "DELIVER") {
    const accept = [...current.gates].reverse().find((g) => g.gate === "ACCEPT");
    if (!accept || accept.result !== "PASS") {
      result = { result: "FAIL" as const, satisfied: [], missing: ["ACCEPT PASS required"], failed: [], waivers: [], nextAction: "Pass ACCEPT before DELIVER" };
    } else if (pendingApprovals.length > 0) {
      result = { result: "BLOCKED" as const, satisfied: [], missing: pendingApprovals, failed: [], waivers: [], nextAction: `Await approvals: ${pendingApprovals.join(", ")}` };
    } else if (!accept.contractDigest || !accept.treeDigest) {
      // A pre-change ACCEPT has no file digest. It cannot authorize delivery.
      result = { result: "FAIL" as const, satisfied: [], missing: ["acceptance-digests"], failed: [], waivers: [], nextAction: "Re-run ACCEPT so the accepted file and contract digests are recorded" };
    } else if (accept.contractDigest !== contractDigest) {
      // The delivery changed after it was accepted. Promoting a contract that
      // nobody accepted is exactly the failure this gate exists to catch.
      result = { result: "FAIL" as const, satisfied: [], missing: ["unchanged-contract"], failed: [], waivers: [], nextAction: "The delivery contract changed after it was accepted; re-run VERIFY and ACCEPT against the current contract" };
    } else if (accept.treeDigest !== treeDigest) {
      // The files changed after acceptance. The contract is not the artifact.
      result = { result: "FAIL" as const, satisfied: [], missing: ["unchanged-artifact"], failed: [], waivers: [], nextAction: "The accepted files changed; re-run VERIFY and ACCEPT against the current tree" };
    } else {
      result = { result: "PASS" as const, satisfied: ["accept-pass", "approvals-clear"], missing: [], failed: [], waivers: [], nextAction: "Promote the verified artifact" };
    }
  } else {
    // INTENT/DISCOVERY/PLAN: structural checks with honest satisfied lists.
    const checks: Array<{ id: string; ok: boolean }> = [{ id: "outcome", ok: current.outcome.length > 0 }];
    const engagementClass = current.engagementClass ?? "change";
    if (input.gate === "DISCOVERY" || (input.gate === "PLAN" && engagementClass !== "fix")) {
      checks.push({ id: "discovery-records", ok: current.assumptions.length + current.decisions.length > 0 });
    }
    if (input.gate === "PLAN") checks.push({ id: "active-delivery", ok: current.activeDelivery !== undefined });
    const missing = checks.filter((c) => !c.ok).map((c) => c.id);
    const satisfied = checks.filter((c) => c.ok).map((c) => c.id);
    result = missing.length === 0
      ? { result: "PASS" as const, satisfied, missing: [], failed: [], waivers: [], nextAction: "Proceed" }
      : { result: "FAIL" as const, satisfied, missing, failed: [], waivers: [], nextAction: `Provide: ${missing.join(", ")}` };
  }

  const record = gateRecordFor(input.gate, input.claim ?? "", result, input.gate === "ACCEPT" ? contractDigest : undefined);
  if (input.gate === "ACCEPT" && treeDigest) record.treeDigest = treeDigest;
  const next = await appendEvent(ctx, "gate.evaluated", { gate: input.gate, result: result.result }, (s) => ({
    ...s,
    gates: [...s.gates, record],
  }));
  return toolOk({ ...result, revision: next.revision });
}
