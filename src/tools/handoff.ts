import { HandoffInputSchema, SpecialistResultSchema } from "../domain/schemas.js";
import { buildPacket, renderPacketPrompt, risksFromResult, HANDOFF_ROLES } from "../domain/handoff.js";
import { skillsForSpecialist } from "../catalog/skills.js";
import { appendEvent  } from "../ledger/store.js";
import { handoffId } from "../util/ids.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

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

const UNIT_REQUIRED = [
  "role",
  "objective",
  "context",
  "allowedScope",
  "prohibitedScope",
  "questions",
  "requiredEvidence",
  "stopCondition",
] as const;

export const HANDOFF_TOOL = {
  name: "handoff",
  description:
    "Prepare/complete/cancel a bounded specialist handoff. Use `prepareWave` to book a whole independent wave in one call: it costs one ledger revision instead of one per unit, which is what keeps the leader's revision stable while the wave runs. `prepare` returns the prompt packet; it does not fake execution. Only team-leader may call this tool: specialists report their result and the leader records it.",
  input: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["prepare", "prepareWave", "complete", "cancel"] },
      expectedRevision: { type: "number" },
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
      units: { type: "array", items: { type: "object", properties: UNIT_PROPERTIES, required: [...UNIT_REQUIRED], additionalProperties: false } },
      handoffId: { type: "string" },
      result: { type: "object" },
      reason: { type: "string" },
    },
    required: ["action", "expectedRevision"],
    additionalProperties: false,
  },
} as const;

/** The next free handoff number, safe even if ids were ever removed from the log. */
function nextHandoffNumber(existing: string[]): number {
  return (
    existing.reduce((max, id) => {
      const n = Number.parseInt(id.replace(/^HND-/, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1
  );
}

export async function executeHandoff(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = HandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid handoff input: ${parsed.error.message}`);
  const input = parsed.data;
  const { projectRoot, current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "prepare, complete or cancel handoffs");

  if (input.action === "prepare" || input.action === "prepareWave") {
    const units =
      input.action === "prepare"
        ? [
            {
              role: input.role,
              objective: input.objective,
              context: input.context,
              allowedScope: input.allowedScope,
              prohibitedScope: input.prohibitedScope,
              questions: input.questions,
              requiredEvidence: input.requiredEvidence,
              stopCondition: input.stopCondition,
              skills: input.skills,
              dependsOn: input.dependsOn,
            },
          ]
        : input.units;

    // Every delegated specialist is a separate process with a real memory
    // cost. The budget is enforced here, not left to the model's judgement:
    // an unbounded fan-out can exhaust the host.
    const budget = runtime.options.orchestration?.maxParallelSpecialists ?? 6;
    const inFlight = current.handoffs.filter((h) => h.status === "prepared");
    if (inFlight.length + units.length > budget) {
      const stale = inFlight.map((h) => `${h.id}:${h.role}`).join(", ") || "none";
      throw new Error(
        `parallel specialist budget exhausted: ${inFlight.length} of ${budget} handoffs are still prepared and this call needs ${units.length} more. Complete or cancel one before preparing another (still prepared: ${stale}). Raise the limit with the orchestration.maxParallelSpecialists plugin option`,
      );
    }
    const firstNumber = nextHandoffNumber(current.handoffs.map((h) => h.id));
    const prepared = units.map((unit, index) => {
      const id = handoffId(firstNumber + index);
      // Skills default to the procedures the role owns. The leader may
      // override, but a handoff never reaches a specialist without its skill set.
      const skills = unit.skills ?? [...skillsForSpecialist(unit.role)];
      return {
        id,
        role: unit.role,
        objective: unit.objective,
        context: unit.context,
        allowedScope: unit.allowedScope,
        prohibitedScope: unit.prohibitedScope,
        questions: unit.questions,
        requiredEvidence: unit.requiredEvidence,
        stopCondition: unit.stopCondition,
        skills,
        dependsOn: unit.dependsOn ?? [],
        status: "prepared" as const,
      };
    });
    const next = await appendEvent(ctx, "handoff.prepared", { ids: prepared.map((p) => p.id) }, (s) => ({
      ...s,
      handoffs: [...s.handoffs, ...prepared],
    }));
    const packets = prepared.map((record) =>
      buildPacket({
        id: record.id,
        role: record.role,
        objective: record.objective,
        context: record.context,
        allowedScope: record.allowedScope,
        prohibitedScope: record.prohibitedScope,
        questions: record.questions,
        requiredEvidence: record.requiredEvidence,
        stopCondition: record.stopCondition,
        skills: record.skills,
        dependsOn: record.dependsOn,
      }),
    );
    // `prepare` keeps its single-unit contract (`id` + `packet`); the plural
    // fields are always present so a wave and a unit are read the same way.
    const first = packets[0];
    return toolOk({
      id: first ? prepared[0]!.id : undefined,
      packet: first,
      ids: prepared.map((p) => p.id),
      packets,
      prompt: packets.map((p) => renderPacketPrompt(p)).join("\n\n"),
      revision: next.revision,
      parallelBudget: { max: budget, inFlight: inFlight.length + prepared.length },
    });
  }

  if (input.action === "complete") {
    const existing = current.handoffs.find((h) => h.id === input.handoffId);
    if (!existing) throw new Error(`unknown handoff ${input.handoffId}`);
    if (existing.status !== "prepared") throw new Error(`handoff ${input.handoffId} already ${existing.status}`);
    // A malformed result is refused rather than stored verbatim: the gate
    // reads findings and risks out of it, so an incomplete result would make
    // the gate read an empty report as "nothing found".
    const result = SpecialistResultSchema.parse(input.result);
    const newRisks = risksFromResult(result, current.risks.length + 1);
    const next = await appendEvent(ctx, "handoff.completed", { id: input.handoffId, status: result.status }, (s) => ({
      ...s,
      handoffs: s.handoffs.map((h) => (h.id === input.handoffId ? { ...h, status: "completed" as const, result } : h)),
      // The risks a specialist reported become ledger risks, so the
      // projection's critical_risks is fed by the work instead of staying empty.
      risks: [...s.risks, ...newRisks.filter((r) => !s.risks.some((existing) => existing.statement === r.statement))],
    }));
    return toolOk({ id: input.handoffId, revision: next.revision, risks: newRisks.length });
  }
  const existing = current.handoffs.find((h) => h.id === input.handoffId);
  if (!existing) throw new Error(`unknown handoff ${input.handoffId}`);
  const next = await appendEvent(ctx, "handoff.cancelled", { id: input.handoffId, reason: input.reason }, (s) => ({
    ...s,
    handoffs: s.handoffs.map((h) => (h.id === input.handoffId ? { ...h, status: "cancelled" as const } : h)),
  }));
  return toolOk({ id: input.handoffId, revision: next.revision });
}
