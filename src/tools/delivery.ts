import { DefineDeliveryInputSchema } from "../domain/schemas.js";
import { appendEvent, writeDeliveryDoc  } from "../ledger/store.js";
import { deliveryId } from "../util/ids.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const DELIVERY_TOOL = {
  name: "define_delivery",
  description: "Register the active Delivery Contract: scope, acceptance criteria, validation steps, proof and rollback. Exactly one delivery is active at a time",
  input: {
    type: "object",
    properties: {
      expectedRevision: { type: "number" },
      title: { type: "string" },
      userOutcome: { type: "string" },
      entryState: { type: "string" },
      happyPath: { type: "array", items: { type: "string" } },
      inScope: { type: "array", items: { type: "string" } },
      outOfScope: { type: "array", items: { type: "string" } },
      allowedScope: { type: "array", items: { type: "string" } },
      prohibitedScope: { type: "array", items: { type: "string" } },
      acceptanceCriteria: { type: "array", items: { type: "string" } },
      validationSteps: { type: "array", items: { type: "string" } },      proof: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["functional", "presentation", "document", "metric"] },
            claim: { type: "string" },
            ref: { type: "string" },
          },
          required: ["kind", "claim", "ref"],
          additionalProperties: false,
        },
      },
      risks: { type: "array", items: { type: "string" } },
      rollback: { type: "string" },
      owner: { type: "string" },
      status: { type: "string" },
    },
    required: ["expectedRevision", "title", "userOutcome", "happyPath", "allowedScope", "acceptanceCriteria", "validationSteps", "rollback"],
    additionalProperties: false,
  },
} as const;

export async function executeDelivery(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = DefineDeliveryInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid delivery input: ${parsed.error.message}`);
  const input = parsed.data;
  const { projectRoot, current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "define the active delivery");
  const id = deliveryId((current.activeDelivery ? Number(current.activeDelivery.id.split("-")[1] ?? "0") : 0) + 1);
  const record = {
    id,
    title: input.title,
    userOutcome: input.userOutcome,
    entryState: input.entryState ?? "",
    happyPath: input.happyPath ?? [],
    inScope: input.inScope ?? [],
    outOfScope: input.outOfScope ?? [],
    allowedScope: input.allowedScope ?? [],
    prohibitedScope: input.prohibitedScope ?? [],
    acceptanceCriteria: input.acceptanceCriteria,
    validationSteps: input.validationSteps ?? [],
    proof: input.proof ?? [],
    risks: input.risks ?? [],
    rollback: input.rollback,
    owner: input.owner ?? ctx.actor,
    status: input.status ?? "READY",
  };
  const next = await appendEvent(ctx, "delivery.defined", { id, title: input.title }, (s) => ({
    ...s,
    activeDelivery: record,
  }));
  await writeDeliveryDoc(projectRoot, id, renderDeliveryYaml(record));
  return toolOk({ id, revision: next.revision });
}

function renderDeliveryYaml(d: {
  id: string;
  title: string;
  userOutcome: string;
  entryState: string;
  happyPath: string[];
  inScope: string[];
  outOfScope: string[];
  allowedScope: string[];
  prohibitedScope: string[];
  acceptanceCriteria: string[];
  validationSteps: string[];
  proof: Array<{ kind: string; claim: string; ref: string }>;
  risks: string[];
  rollback: string;
  owner: string;
  status: string;
}): string {
  const lines = [
    `id: ${d.id}`,
    `title: ${JSON.stringify(d.title)}`,
    `user_outcome: ${JSON.stringify(d.userOutcome)}`,
    `entry_state: ${JSON.stringify(d.entryState)}`,
    `happy_path:`,
    ...d.happyPath.map((h) => `  - ${JSON.stringify(h)}`),
    `in_scope:`,
    ...d.inScope.map((h) => `  - ${JSON.stringify(h)}`),
    `out_of_scope:`,
    ...d.outOfScope.map((h) => `  - ${JSON.stringify(h)}`),
    `allowed_scope:`,
    ...d.allowedScope.map((h) => `  - ${JSON.stringify(h)}`),
    `prohibited_scope:`,
    ...d.prohibitedScope.map((h) => `  - ${JSON.stringify(h)}`),
    `acceptance_criteria:`,
    ...d.acceptanceCriteria.map((h) => `  - ${JSON.stringify(h)}`),
    `validation_steps:`,
    ...d.validationSteps.map((h) => `  - ${JSON.stringify(h)}`),
    `proof:`,
    ...d.proof.map((p) => `  - kind: ${p.kind}\n    claim: ${JSON.stringify(p.claim)}\n    ref: ${JSON.stringify(p.ref)}`),
    `risks:`,
    ...d.risks.map((h) => `  - ${JSON.stringify(h)}`),
    `rollback: ${JSON.stringify(d.rollback)}`,
    `owner: ${d.owner}`,
    `status: ${d.status}`,
  ];
  return `${lines.join("\n")}\n`;
}
