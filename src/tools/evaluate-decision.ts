import type { ToolContext } from "@opencode/plugin/promise/tool";
import { resolveDecisionGenerator } from "../compat/host.js";
import { holdDecision } from "../decision/cache.js";
import { chooseDecisionModel, decisionModelCatalog } from "../decision/catalog.js";
import { buildDecisionRequest, normaliseDecisionResult, validateDecisionQuestions } from "../decision/protocol.js";
import { screenDecisionState } from "../decision/screen.js";
import {
  computeVerdict,
  effectiveThresholds,
  effectiveUse,
  estimateTokens,
  statusForVerdict,
} from "../domain/decision-model.js";
import { EvaluateDecisionInputSchema } from "../domain/schemas.js";
import { readState, writeJudgementDoc } from "../ledger/store.js";
import { decisionOptions } from "../options.js";
import { projectRootOf, toolOk, type AgentTeamRuntime } from "../runtime.js";
import { sha256Hex } from "../util/hash.js";
import { judgementId } from "../util/ids.js";

export const EVALUATE_DECISION_TOOL = {
  name: "evaluate_decision",
  description:
    "Ask a decision model typed questions about a piece of evidence and get a calibrated verdict. The verdict routes the case; it never approves anything.",
  input: {
    type: "object",
    properties: {
      criterionId: { type: "string" },
      state: { type: "string" },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["predicate", "choice", "score"] },
            name: { type: "string" },
            instructions: { type: "string" },
            choices: {
              type: "array",
              items: {
                type: "object",
                properties: { value: {}, description: { type: "string" } },
                required: ["value"],
              },
            },
            levels: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label"],
              },
            },
          },
          required: ["type", "name", "instructions"],
        },
      },
      use: { type: "string", enum: ["default", "review", "security", "release"] },
      model: { type: "string" },
    },
    required: ["criterionId", "state", "questions"],
    additionalProperties: false,
  },
} as const;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the decision did not answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeEvaluateDecision(
  runtime: AgentTeamRuntime,
  rawInput: unknown,
  tool: ToolContext,
): Promise<{ content: string }> {
  const parsed = EvaluateDecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`invalid decision input: ${parsed.error.message}`);
  const input = parsed.data;
  const options = decisionOptions(runtime.options);
  if (options.mode === "off") {
    throw new Error("the decision capability is off; escalate this case to the language model or the operator");
  }

  const role = String((tool as unknown as { agent?: string })?.agent ?? "team-leader");
  const root = projectRootOf(runtime.ctx);

  // A decision with no criterion has nothing to bind to, and could be spent on
  // any criterion later.
  const state = await readState(root);
  const criteria = state?.activeDelivery?.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    throw new Error("the active delivery declares no acceptance criteria; a decision needs a criterion to bind to");
  }
  if (!criteria.includes(input.criterionId)) {
    throw new Error(`unknown criterionId ${input.criterionId}; active delivery declares: ${criteria.join(", ")}`);
  }

  const screened = screenDecisionState(input.state);
  if (screened.quarantined.length > 0) {
    throw new Error(
      `the state carries ${screened.quarantined.length} line(s) that would redirect a judgement; escalate this case instead`,
    );
  }

  const limitProblem = validateDecisionQuestions(input.questions);
  if (limitProblem) throw new Error(limitProblem);

  const surface = resolveDecisionGenerator(runtime.ctx);
  if (!surface.available) return noModel(options, "the host exposes no decision surface");
  const models = await decisionModelCatalog(runtime.ctx, root);
  if (models.length === 0) return noModel(options, "the active catalog holds no decision model");

  const selection = chooseDecisionModel(models, {
    pinned: options.model ?? input.model,
    evidenceTokens: estimateTokens(screened.state),
  });
  if ("error" in selection) return noModel(options, selection.error);

  const request = buildDecisionRequest({
    model: { id: selection.model.id, providerID: selection.model.providerID },
    state: screened.state,
    questions: input.questions,
  });

  const started = Date.now();
  let raw: unknown;
  try {
    raw = await withTimeout(surface.generator!.decisions(request), options.timeoutMs);
  } catch (err) {
    return escalate(options, `the decision model could not be reached: ${(err as Error).message}`);
  }
  const elapsedMs = Date.now() - started;

  const { answers, usage } = normaliseDecisionResult(raw);
  const thresholds = effectiveThresholds(role, input.use, options.thresholds);
  const verdict = computeVerdict(answers, thresholds);
  const use = effectiveUse(role, input.use, options.thresholds);
  const stateDigest = sha256Hex(screened.state);
  const id = judgementId();
  const model = {
    providerID: selection.model.providerID,
    id: selection.model.id,
    ref: selection.model.ref ?? `${selection.model.providerID}/${selection.model.id}`,
  };

  holdDecision({
    id,
    projectRoot: root,
    criterion: input.criterionId,
    role,
    use,
    thresholds,
    model,
    answers,
    verdict,
    stateDigest,
    rationale: selection.rationale,
    elapsedMs,
    usage,
  });

  await writeJudgementDoc(root, id, {
    decisionId: id,
    criterion: input.criterionId,
    role,
    use,
    thresholds,
    model,
    questions: input.questions,
    answers,
    verdict,
    verified: true,
    stateDigest,
    rationale: selection.rationale,
    elapsedMs,
    usage,
    rejected: selection.rejected,
  });

  return toolOk({
    available: true,
    decisionId: id,
    criterion: input.criterionId,
    role,
    use,
    model,
    verdict,
    status: statusForVerdict(verdict),
    thresholds,
    answers,
    questions: input.questions,
    usage,
    elapsedMs,
    stateDigest,
    rationale: selection.rationale,
  });
}

/**
 * No decision model can serve the request.
 *
 * In the required mode the step cannot be served at all, so it fails; in the
 * automatic mode the case escalates, because the point of a first pass is
 * that it can hand the work back.
 */
function noModel(options: ReturnType<typeof decisionOptions>, reason: string): { content: string } {
  if (options.mode === "required") {
    throw new Error(`decision unavailable: ${reason}`);
  }
  return escalate(options, reason);
}

/** The request could not be served. The configured behaviour decides what happens next. */
function escalate(options: ReturnType<typeof decisionOptions>, reason: string): { content: string } {
  if (options.unavailable === "abort") {
    throw new Error(`decision unavailable: ${reason}`);
  }
  return toolOk({ available: false, reason, nextAction: "escalate" });
}
