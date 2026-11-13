import { SpecialistResultSchema } from "../domain/schemas.js";
import { risksFromResult } from "../domain/handoff.js";
import { appendEvent, readState, storeContext, STATE_NOT_INITIALIZED } from "../ledger/store.js";
import { projectRootOf, toolOk, type AgentTeamRuntime } from "../runtime.js";
import { assertSupportedHost } from "../orchestrator/host-gate.js";
import { observeDeliveryChecks } from "../orchestrator/observe.js";
import { archiveSettledSession } from "../orchestrator/launch.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const REPORT_TOOL = {
  name: "report",
  description:
    "The specialist exit. Only the session launched for a running handoff may call it. It records SpecialistResult@1 against that handoff; prose returned to the leader is not a report.",
  input: {
    type: "object",
    properties: {
      result: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["PASS", "FAIL", "BLOCKED", "ADVISORY"] },
          summary: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["critical", "high", "medium", "low", "note"] },
                claim: { type: "string" },
                evidence: { type: "array", items: { type: "string" } },
              },
              required: ["severity", "claim", "evidence"],
              additionalProperties: false,
            },
          },
          risks: { type: "array", items: { type: "string" } },
          unknowns: { type: "array", items: { type: "string" } },
          recommended_next_action: { type: "string" },
        },
        required: ["status", "summary", "findings", "risks", "unknowns", "recommended_next_action"],
        additionalProperties: false,
      },
    },
    required: ["result"],
    additionalProperties: false,
  },
} as const;

export async function executeReport(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  assertSupportedHost(runtime);
  const input = rawInput as { result?: unknown };
  const parsed = SpecialistResultSchema.safeParse(input?.result);
  if (!parsed.success) throw new Error(`invalid specialist result: ${parsed.error.message}`);
  const result = parsed.data;
  const sessionID = String((tool as unknown as { sessionID?: string }).sessionID ?? "");
  if (!sessionID) throw new Error("a report must come from a launched specialist session");

  const projectRoot = projectRootOf(runtime.ctx);
  const state = await readState(projectRoot);
  if (!state) throw new Error(STATE_NOT_INITIALIZED);
  const handoff = state.handoffs.find((h) => h.sessionID === sessionID && h.status === "running");
  if (!handoff) {
    throw new Error(
      "this session has no running handoff; a report is recorded only from the session launched for one. A direct session has nothing to report to — answer in this session.",
    );
  }

  const newRisks = risksFromResult(result, state.risks.length + 1);
  // The session has settled, so archiving now sticks: the thread list drops
  // the specialist the moment its report lands. Best-effort and verified; the
  // outcome travels in the event so an operator can tell whether the host
  // honoured it.
  const archive = await archiveSettledSession(runtime, sessionID).catch(() => ({ status: "failed" as const, reason: "archive check failed" }));
  const next = await appendEvent(storeContext(projectRoot, "plugin", "plugin"), "handoff.reported", {
    id: handoff.id,
    status: result.status,
    archive: archive.status,
    ...(archive.reason ? { archiveReason: archive.reason } : {}),
  }, (s) => ({
    ...s,
    handoffs: s.handoffs.map((h) => (h.id === handoff.id ? { ...h, status: "completed" as const, result } : h)),
    risks: [...s.risks, ...newRisks.filter((r) => !s.risks.some((existing) => existing.statement === r.statement))],
    nextAction: { description: `${handoff.id} reported ${result.status}`, owner: "team-leader" },
  }));

  if (handoff.role === "coder" || handoff.role === "worker") {
    const delivery = next.activeDelivery;
    if (delivery) await observeDeliveryChecks(runtime, projectRoot, delivery, handoff.parentSessionID ?? sessionID).catch(() => {});
  }

  if (handoff.parentSessionID) {
    try {
      await runtime.ctx.session.synthetic({
        sessionID: handoff.parentSessionID,
        text: `${handoff.id} (${handoff.role}) reported ${result.status}: ${result.summary.slice(0, 200)}`,
      } as never);
    } catch {
      // The ledger is the record; the notice is best-effort.
    }
  }

  return toolOk({ id: handoff.id, revision: next.revision, status: result.status, risks: newRisks.length });
}
