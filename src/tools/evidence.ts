import { SubmitEvidenceInputSchema, type JudgmentBlock } from "../domain/schemas.js";
import { computeVerdict, statusForVerdict, type DecisionAnswer } from "../domain/decision-model.js";
import { findHeldDecisionForProject, type HeldDecision } from "../decision/cache.js";
import { appendEvent, writeEvidenceDoc } from "../ledger/store.js";
import { evidenceId } from "../util/ids.js";
import { sha256Hex } from "../util/hash.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import { openLedger } from "./ledger.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export const EVIDENCE_TOOL = {
  name: "submit_evidence",
  description: "Submit criterion-linked evidence (pass requires artifact, command digest, or source ref)",
  input: {
    type: "object",
    properties: {
      expectedRevision: { type: "number" },
      criterionId: { type: "string" },
      kind: { type: "string", enum: ["test", "runtime", "visual", "source", "review", "release", "document", "metric", "judgment"] },
      status: { type: "string", enum: ["pass", "fail", "partial", "skipped"] },
      summary: { type: "string" },
      artifactRef: { type: "string" },
      command: { type: "string" },
      digest: { type: "string" },
      observedAt: { type: "string" },
      limitations: { type: "array", items: { type: "string" } },
      decisionId: { type: "string" },
      judgment: { type: "object" },
    },
    required: ["expectedRevision", "criterionId", "kind", "status", "summary", "observedAt"],
    additionalProperties: false,
  },
} as const;

export async function executeEvidence(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> {
  const parsed = SubmitEvidenceInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid evidence input: ${parsed.error.message}`);
  const input = parsed.data;
  const isJudgement = input.kind === "judgment";
  if (!isJudgement && input.status === "pass" && !input.artifactRef && !input.command && !input.digest) {
    throw new Error("pass requires artifactRef, command, or digest (exit code alone is not evidence)");
  }
  const { projectRoot, current, ctx } = await openLedger(runtime, tool, input.expectedRevision, "submit evidence");
  // Refuse evidence for unknown criterion unless the delivery declares it — prevents unlinked claims.
  const criteria = current.activeDelivery?.acceptanceCriteria ?? [];
  if (criteria.length > 0 && !criteria.includes(input.criterionId)) {
    throw new Error(`unknown criterionId ${input.criterionId}; active delivery declares: ${criteria.join(", ")}`);
  }
  const id = evidenceId(current.evidence.length + 1);

  if (isJudgement) {
    const block = resolveJudgement(projectRoot, input);
    const digest = sha256Hex(JSON.stringify({ criterionId: input.criterionId, judgment: block }));
    const record = {
      id,
      criterionId: input.criterionId,
      kind: "judgment" as const,
      status: statusForVerdict(block.verdict),
      summary: `decision ${block.decisionId} for criterion ${block.criterion}: ${block.verdict}`,
      digest,
      observedAt: input.observedAt,
      limitations: input.limitations ?? [],
      judgment: block,
    };
    const next = await appendEvent(ctx, "decision.evaluated", { id, criterionId: input.criterionId, verdict: block.verdict, decisionId: block.decisionId }, (s) => ({
      ...s,
      evidence: [...s.evidence, record],
    }));
    await writeEvidenceDoc(projectRoot, id, record);
    return toolOk({ id, revision: next.revision, digest, verdict: block.verdict, verified: block.verified });
  }

  const digest = input.digest ?? (input.command ? sha256Hex(`${input.command}\n${input.summary}`.slice(0, 4000)) : undefined);
  const record = {
    id,
    criterionId: input.criterionId,
    kind: input.kind,
    status: input.status,
    summary: input.summary.slice(0, 2000),
    artifactRef: input.artifactRef,
    command: input.command?.slice(0, 500),
    digest,
    observedAt: input.observedAt,
    limitations: input.limitations ?? [],
  };
  const next = await appendEvent(ctx, "evidence.submitted", { id, criterionId: input.criterionId, status: input.status }, (s) => ({
    ...s,
    evidence: [...s.evidence, record],
  }));
  await writeEvidenceDoc(projectRoot, id, record);
  return toolOk({ id, revision: next.revision, digest });
}

/**
 * The block a judgement row records.
 *
 * The plugin's own record of the decision wins whenever it has one. When it
 * does not — another OpenCode server, or a restart — the block the specialist
 * reported is accepted and the row is marked unverified, so a reader can tell
 * which rows were checked against the plugin's own execution.
 */
function resolveJudgement(
  projectRoot: string,
  input: { decisionId?: string; judgment?: JudgmentBlock; criterionId: string },
): JudgmentBlock {
  if (!input.decisionId) {
    throw new Error("a judgement row names the decision it records: decisionId is required");
  }
  const held = findHeldDecisionForProject(projectRoot, input.decisionId);
  if (held) {
    if (held.criterion !== input.criterionId) {
      throw new Error(`decision ${input.decisionId} was executed for criterion ${held.criterion}, not ${input.criterionId}`);
    }
    const block = blockFromHeld(held);
    return { ...block, ...recomputed(block) };
  }
  if (!input.judgment) {
    throw new Error(`decision ${input.decisionId} is not one this plugin executed; report the block the specialist produced`);
  }
  if (input.judgment.decisionId !== input.decisionId) {
    throw new Error("the reported block names a different decision");
  }
  if (input.judgment.criterion !== input.criterionId) {
    throw new Error("the reported block names a different criterion");
  }
  return { ...input.judgment, ...recomputed(input.judgment), verified: false };
}

/**
 * The verdict, recomputed from the answers.
 *
 * The verdict is never taken from the caller, not even on the path where the
 * caller supplies the block: a caller that reported a satisfied verdict for
 * answers that do not reach the thresholds would otherwise write a record that
 * contradicts itself.
 */
function recomputed(block: JudgmentBlock): { verdict: JudgmentBlock["verdict"] } {
  return { verdict: computeVerdict(block.answers.map(domainAnswer), block.thresholds) };
}

/** The plugin's own answer shape, from the recorded one. */
function domainAnswer(answer: JudgmentBlock["answers"][number]): DecisionAnswer {
  if (answer.type === "predicate" && typeof answer.probability === "number") {
    return { type: "predicate", name: answer.name, probability: answer.probability };
  }
  if (answer.type === "choice" && answer.choice !== undefined && typeof answer.confidence === "number") {
    return { type: "choice", name: answer.name, choice: answer.choice, probabilities: answer.optionProbabilities ?? {}, confidence: answer.confidence };
  }
  if (answer.type === "score" && typeof answer.levelScore === "number" && typeof answer.confidence === "number") {
    return { type: "score", name: answer.name, score: answer.levelScore, probabilities: answer.levelProbabilities ?? [], confidence: answer.confidence };
  }
  return { type: "error", name: answer.name, reason: answer.reason ?? "the answer carries no result" };
}

function blockFromHeld(held: HeldDecision): JudgmentBlock {
  return {
    model: held.model.ref,
    answers: held.answers.map((answer) => {
      if (answer.type === "predicate") return { name: answer.name, type: answer.type, probability: answer.probability };
      if (answer.type === "choice") {
        return {
          name: answer.name,
          type: answer.type,
          choice: answer.choice,
          confidence: answer.confidence,
          optionProbabilities: answer.probabilities,
        };
      }
      if (answer.type === "score") {
        return {
          name: answer.name,
          type: answer.type,
          confidence: answer.confidence,
          levelScore: answer.score,
          levelProbabilities: answer.probabilities,
        };
      }
      return { name: answer.name, type: answer.type, reason: answer.reason, ...(answer.message ? { reason: answer.reason } : {}) };
    }),
    role: held.role,
    use: held.use,
    thresholds: held.thresholds,
    criterion: held.criterion,
    decisionId: held.id,
    verdict: held.verdict,
    verified: true,
    stateDigest: held.stateDigest,
    rationale: held.rationale,
    elapsedMs: held.elapsedMs,
    usage: held.usage,
  };
}
