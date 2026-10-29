import type { AgentTeamRuntime } from "../runtime.js";
import { ASSUMPTION_TOOL, executeAssumption } from "./assumption.js";
import { DECISION_TOOL, executeDecision } from "./decision.js";
import { EVIDENCE_TOOL, executeEvidence } from "./evidence.js";
import { GATE_TOOL, executeGate } from "./gate.js";
import { APPROVAL_TOOL, executeApproval } from "./approval.js";
import { HANDOFF_TOOL, executeHandoff } from "./handoff.js";
import { AGENT_TEAM_STATE_TOOL, executeState } from "./state.js";
import { DELIVERY_TOOL, executeDelivery } from "./delivery.js";
import { EVALUATE_DECISION_TOOL, executeEvaluateDecision } from "./evaluate-decision.js";

export async function registerTools(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const registration = await runtime.ctx.tool.transform((editor: any) => {
    editor.namespace({ name: "agent_team", description: "Agent Team Method ledger, gates, and orchestration tools" });
    editor.add({
      name: AGENT_TEAM_STATE_TOOL.name,
      description: AGENT_TEAM_STATE_TOOL.description,
      input: AGENT_TEAM_STATE_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeState(runtime, input, tool as never) as never,
    });
    editor.add({
      name: ASSUMPTION_TOOL.name,
      description: ASSUMPTION_TOOL.description,
      input: ASSUMPTION_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeAssumption(runtime, input, tool as never) as never,
    });
    editor.add({
      name: DECISION_TOOL.name,
      description: DECISION_TOOL.description,
      input: DECISION_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeDecision(runtime, input, tool as never) as never,
    });
    editor.add({
      name: EVIDENCE_TOOL.name,
      description: EVIDENCE_TOOL.description,
      input: EVIDENCE_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeEvidence(runtime, input, tool as never) as never,
    });
    editor.add({
      name: GATE_TOOL.name,
      description: GATE_TOOL.description,
      input: GATE_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeGate(runtime, input, tool as never) as never,
    });
    editor.add({
      name: APPROVAL_TOOL.name,
      description: APPROVAL_TOOL.description,
      input: APPROVAL_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeApproval(runtime, input, tool as never) as never,
    });
    editor.add({
      name: HANDOFF_TOOL.name,
      description: HANDOFF_TOOL.description,
      input: HANDOFF_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeHandoff(runtime, input, tool as never) as never,
    });
    editor.add({
      name: DELIVERY_TOOL.name,
      description: DELIVERY_TOOL.description,
      input: DELIVERY_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeDelivery(runtime, input, tool as never) as never,
    });
    editor.add({
      name: EVALUATE_DECISION_TOOL.name,
      description: EVALUATE_DECISION_TOOL.description,
      input: EVALUATE_DECISION_TOOL.input as never,
      options: { namespace: "agent_team" },
      execute: async (input: any, tool: any) => executeEvaluateDecision(runtime, input, tool as never) as never,
    });
  });
  return { dispose: () => registration.dispose() };
}
