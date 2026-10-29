import { RecordAssumptionInputSchema } from "../domain/schemas.js";
import { appendEvent  } from "../ledger/store.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const ASSUMPTION_TOOL = {
  name: "record_assumption",
  description: "Record a material assumption with epistemic basis, confidence, and impact",
  input: {
    type: "object",
    properties: {
      expectedRevision: { type: "number" },
      statement: { type: "string" },
      basis: { type: "string", enum: ["USER_STATED", "OBSERVED_PATTERN", "INFERENCE", "PROPOSAL"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      impact: { type: "string" },
      validation: { type: "string" },
      sourceRefs: { type: "array", items: { type: "string" } },
    },
    required: ["expectedRevision", "statement", "basis", "confidence", "impact"],
    additionalProperties: false,
  },
} as const;

export async function executeAssumption(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = RecordAssumptionInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid assumption input: ${parsed.error.message}`);
  const input = parsed.data;
  const { projectRoot, current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "record an assumption");
  const id = `ASM-${String(current.assumptions.length + 1).padStart(4, "0")}`;
  const next = await appendEvent(ctx, "assumption.recorded", { id, ...input }, (s) => ({
    ...s,
    assumptions: [...s.assumptions, { id, statement: input.statement, basis: input.basis, confidence: input.confidence, impact: input.impact, validation: input.validation, sourceRefs: input.sourceRefs ?? [] }],
  }));
  return toolOk({ id, revision: next.revision });
}
