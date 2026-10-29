import { AgentTeamStateInputSchema } from "../domain/schemas.js";
import { validatePhaseTransition, canTransitionStatus, statusForPhase } from "../domain/state-machine.js";
import { initializeState, readState, appendEvent } from "../ledger/store.js";
import { projectRootOf, toolOk, type AgentTeamRuntime } from "../runtime.js";
import { assertLedgerOwner } from "./authority.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const AGENT_TEAM_STATE_TOOL = {
  name: "state",
  description:
    "Initialize, read, transition, or register guardrails for the Agent Team engagement (optimistic revision, state machine validated). Guardrails are the only mechanism that makes Agent Team ask before an action; the default is autonomous execution.",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "initialize", "transition", "guard"] },
      outcome: { type: "string" },
      actors: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      nonGoals: { type: "array", items: { type: "string" } },
      acceptance: { type: "array", items: { type: "string" } },
      expectedRevision: { type: "number" },
      to: { type: "string" },
      reason: { type: "string" },
      nextAction: { type: "string" },
      status: {
        type: "string",
        enum: [
          "DRAFT",
          "READY",
          "IN_PROGRESS",
          "VERIFYING",
          "REVIEWING",
          "ACCEPTED",
          "DELIVERY_READY",
          "DELIVERED",
          "FAILED",
          "BLOCKED",
          "CANCELLED",
        ],
      },
      mode: { type: "string", enum: ["yolo", "guarded"] },
      add: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
      clear: { type: "boolean" },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

export async function executeState(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = AgentTeamStateInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid agent_team_state input: ${parsed.error.message}`);
  const input = parsed.data;
  const projectRoot = projectRootOf(runtime.ctx);
  const sessionId = String((tool as unknown as { sessionID?: string }).sessionID ?? "unknown");
  const agent = String((tool as unknown as { agent?: string }).agent ?? "team-leader");

  if (input.action === "read") {
    const state = await readState(projectRoot);
    if (!state) return toolOk({ initialized: false, hint: "run agent_team_state initialize via /agent-team/start" });
    return toolOk({ initialized: true, state });
  }
  if (input.action === "initialize") {
    assertLedgerOwner(tool, "initialize the engagement");
    const state = await initializeState({
      projectRoot,
      sessionId,
      actor: agent,
      outcome: input.outcome,
      ...(input.actors ? { actors: input.actors } : {}),
      ...(input.constraints ? { constraints: input.constraints } : {}),
      ...(input.nonGoals ? { nonGoals: input.nonGoals } : {}),
      ...(input.acceptance ? { acceptance: input.acceptance } : {}),
    });
    return toolOk({ initialized: true, state });
  }
  const { current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "transition the engagement or change its guardrails");

  if (input.action === "guard") {
    const next = await appendEvent(ctx, "guardrails.updated", {
      mode: input.mode,
      add: input.add ?? [],
      remove: input.remove ?? [],
      clear: input.clear === true,
    }, (s) => {
      let guardrails = [...s.guardrails];
      if (input.clear === true) guardrails = [];
      if (input.remove && input.remove.length > 0) guardrails = guardrails.filter((g) => !input.remove!.includes(g));
      if (input.add && input.add.length > 0) guardrails = [...new Set([...guardrails, ...input.add])];
      return { ...s, guardrails, ...(input.mode ? { autonomyMode: input.mode } : {}) };
    });
    return toolOk({
      guardrails: next.guardrails,
      mode: next.autonomyMode ?? runtime.options.autonomy?.mode ?? "yolo",
      note: next.guardrails.length === 0 && (next.autonomyMode ?? runtime.options.autonomy?.mode ?? "yolo") === "yolo"
        ? "No guardrails: Agent Team asks nothing and executes autonomously."
        : "Matching actions now require explicit authorization.",
      revision: next.revision,
    });
  }

  // transition
  validatePhaseTransition(current.engagement.phase, input.to);
  // The status normally follows the phase, but it is still a transition and
  // must be legal: a terminal status is reopened only back to IN_PROGRESS,
  // and a delivered engagement is never silently reopened.
  let nextStatus = statusForPhase(input.to);
  if (nextStatus !== current.engagement.status && !canTransitionStatus(current.engagement.status, nextStatus)) {
    throw new Error(`invalid status transition: ${current.engagement.status} -> ${nextStatus}`);
  }
  // An explicit status is how a leader marks an engagement FAILED or
  // BLOCKED: those are reachable from any active phase but are not a phase
  // of their own.
  if (input.status && input.status !== nextStatus) {
    if (!canTransitionStatus(current.engagement.status, input.status)) {
      throw new Error(`invalid status transition: ${current.engagement.status} -> ${input.status}`);
    }
    nextStatus = input.status;
  }
  const next = await appendEvent(ctx, "phase.transitioned", { from: current.engagement.phase, to: input.to, reason: input.reason }, (s) => ({
    ...s,
    engagement: { ...s.engagement, phase: input.to, status: nextStatus },
    nextAction: { description: input.nextAction, owner: "team-leader" },
  }));
  return toolOk({ state: next });
}
