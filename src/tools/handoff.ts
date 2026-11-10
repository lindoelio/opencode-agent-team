import { HandoffInputSchema } from "../domain/schemas.js";
import { appendEvent } from "../ledger/store.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import { launchWave, type LaunchUnit } from "../orchestrator/launch.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

import { HANDOFF_ROLES } from "../domain/handoff.js";

const UNIT_PROPERTIES = {
  role: { type: "string", enum: [...HANDOFF_ROLES] },
  objective: { type: "string" },
  context: { type: "array", items: { type: "string" } },
  allowedScope: { type: "array", items: { type: "string" }, minItems: 1 },
  prohibitedScope: { type: "array", items: { type: "string" } },
  questions: { type: "array", items: { type: "string" } },
  requiredEvidence: { type: "array", items: { type: "string" } },
  stopCondition: { type: "string" },
  skills: { type: "array", items: { type: "string" } },
  dependsOn: { type: "array", items: { type: "string" } },
} as const;

export const HANDOFF_TOOL = {
  name: "handoff",
  description:
    "Launch a bounded wave of specialists. One child session is created per unit and bound to the leader, the role, and the allowed scope. The call returns without waiting; completion arrives as a session event. A prompt packet is not a handoff.",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["launch", "cancel"] },
      expectedRevision: { type: "number" },
      units: { type: "array", items: { type: "object", properties: UNIT_PROPERTIES, required: ["role", "objective", "context", "allowedScope", "prohibitedScope", "questions", "requiredEvidence", "stopCondition"], additionalProperties: false } },
      handoffId: { type: "string" },
      reason: { type: "string" },
    },
    required: ["action", "expectedRevision"],
    additionalProperties: false,
  },
} as const;

export async function executeHandoff(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = HandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid handoff input: ${parsed.error.message}`);
  const input = parsed.data;

  if (input.action === "prepare" || input.action === "prepareWave") {
    throw new Error("a prompt packet is not a handoff; call agent_team_handoff with action: \"launch\"");
  }
  if (input.action === "complete") {
    throw new Error("only the launched specialist session may report; call agent_team_report from that session");
  }
  if (input.action === "launch") {
    const { current } = await openLedger(runtime, tool, input.expectedRevision, "launch a wave");
    const leaderSessionID = String((tool as unknown as { sessionID?: string }).sessionID ?? "unknown");
    return launchWave(runtime, { units: input.units as LaunchUnit[], expectedRevision: current.revision, leaderSessionID });
  }

  const { current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "cancel a handoff");
  const existing = current.handoffs.find((h) => h.id === input.handoffId);
  if (!existing) throw new Error(`unknown handoff ${input.handoffId}`);
  const next = await appendEvent(ctx, "handoff.cancelled", { id: input.handoffId, reason: input.reason }, (s) => ({
    ...s,
    handoffs: s.handoffs.map((h) => (h.id === input.handoffId ? { ...h, status: "cancelled" as const } : h)),
  }));
  return toolOk({ id: input.handoffId, revision: next.revision });
}
