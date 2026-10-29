/**
 * The pure logic of the decision capability.
 *
 * Everything here is a function of its arguments: no host access, no
 * filesystem, no clock. The domain owns the vocabulary of a decision — its
 * answers, its thresholds, its verdict and the rule that selects a model — so
 * that the gate algebra and the tool can both use it without importing a
 * host-facing module.
 */

/** The threshold sets a decision can be held to. */
export const DECISION_USES = ["default", "review", "security", "release"] as const;
export type DecisionUse = (typeof DECISION_USES)[number];

/** The minimums one use demands: a probability and a confidence. */
export interface DecisionThresholds {
  probability: number;
  confidence: number;
}

/** The answers a decision model can return. */
export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string | boolean; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; name: string; score: number; probabilities: Array<{ value: number; label: string; probability: number }>; confidence: number }
  | { type: "error"; name: string; reason: string; message?: string };

/** What the Agent Team computed from the answers. Never the model's own word. */
export type DecisionVerdict = "satisfied" | "unanswered" | "escalate";

/** The built-in thresholds. An operator overrides them per use. */
export const DECISION_THRESHOLDS: Record<DecisionUse, DecisionThresholds> = {
  default: { probability: 0.85, confidence: 0.7 },
  review: { probability: 0.9, confidence: 0.75 },
  security: { probability: 0.95, confidence: 0.85 },
  release: { probability: 0.92, confidence: 0.8 },
};

/** The use each role is held to. Every other role takes the default set. */
const ROLE_USES: Record<string, DecisionUse> = {
  "team-leader": "default",
  "team-leader/reviewer": "review",
  "team-leader/security": "security",
  "team-leader/release": "release",
};

export function useForRole(role: string): DecisionUse {
  return ROLE_USES[role] ?? "default";
}

export function thresholdsFor(
  use: DecisionUse,
  configured: Partial<Record<DecisionUse, DecisionThresholds>> = {},
): DecisionThresholds {
  return configured[use] ?? DECISION_THRESHOLDS[use];
}

/**
 * The use whose thresholds are in force.
 *
 * The built-in sets are totally ordered, so the effective thresholds always
 * belong to exactly one of them.
 */
export function effectiveUse(
  role: string,
  requested?: DecisionUse,
  configured: Partial<Record<DecisionUse, DecisionThresholds>> = {},
): DecisionUse {
  const roleUse = useForRole(role);
  const effective = effectiveThresholds(role, requested, configured);
  const candidates: DecisionUse[] = requested ? [roleUse, requested] : [roleUse];
  for (const use of candidates) {
    const thresholds = thresholdsFor(use, configured);
    if (thresholds.probability === effective.probability && thresholds.confidence === effective.confidence) return use;
  }
  return roleUse;
}

/**
 * The thresholds a decision is judged against.
 *
 * The role's use is a floor: a call may name a stricter use, never a looser
 * one, so the effective threshold is the component-wise maximum of the two.
 */
export function effectiveThresholds(
  role: string,
  requested?: DecisionUse,
  configured: Partial<Record<DecisionUse, DecisionThresholds>> = {},
): DecisionThresholds {
  const roleThresholds = thresholdsFor(useForRole(role), configured);
  const requestedThresholds = requested ? thresholdsFor(requested, configured) : roleThresholds;
  return {
    probability: Math.max(roleThresholds.probability, requestedThresholds.probability),
    confidence: Math.max(roleThresholds.confidence, requestedThresholds.confidence),
  };
}

/** Whether one answer reaches the thresholds. */
export function answerSatisfied(answer: DecisionAnswer, thresholds: DecisionThresholds): boolean {
  switch (answer.type) {
    case "predicate":
      return answer.probability >= thresholds.probability;
    case "choice": {
      const probability = answer.probabilities[String(answer.choice)] ?? 0;
      return probability >= thresholds.probability && answer.confidence >= thresholds.confidence;
    }
    case "score": {
      const top = answer.probabilities.reduce<{ probability: number } | undefined>(
        (best, level) => (best === undefined || level.probability > best.probability ? level : best),
        undefined,
      );
      return (top?.probability ?? 0) >= thresholds.probability && answer.confidence >= thresholds.confidence;
    }
    case "error":
      return false;
  }
}

/**
 * The verdict of a decision.
 *
 * `unanswered` when any question was refused or errored — an unanswered
 * question is never a negative answer. `satisfied` only when every answer
 * reaches the thresholds. `escalate` otherwise.
 */
export function computeVerdict(answers: DecisionAnswer[], thresholds: DecisionThresholds): DecisionVerdict {
  if (answers.length === 0) return "unanswered";
  if (answers.some((answer) => answer.type === "error")) return "unanswered";
  return answers.every((answer) => answerSatisfied(answer, thresholds)) ? "satisfied" : "escalate";
}

/**
 * The evidence status a verdict implies.
 *
 * A judgement never carries `pass` or `fail`: it satisfies nothing and fails
 * nothing, so no existing mechanism can read it as proof or as a blocker.
 */
export function statusForVerdict(verdict: DecisionVerdict): "partial" | "skipped" {
  return verdict === "unanswered" ? "skipped" : "partial";
}

/** A decision model the host offers. */
export interface DecisionCandidate {
  providerID: string;
  id: string;
  /** `provider/model`, when the reader knows it. */
  ref?: string;
  name: string;
  costPerMillionInput?: number;
  contextLimit?: number;
  enabled: boolean;
  status: string;
}

export interface DecisionRejection {
  model: string;
  reason: string;
}

export interface DecisionSelection {
  model: DecisionCandidate;
  rationale: string;
  rejected: DecisionRejection[];
}

export interface DecisionSelectionFailure {
  error: string;
  rejected: DecisionRejection[];
}

/** A conservative token estimate: four characters per token is close enough to refuse a model that cannot hold the state. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The one decision model to use, chosen deterministically.
 *
 * Disabled and non-active candidates are dropped first. An operator pin wins
 * among the survivors — but a pinned model whose context cannot hold the
 * evidence is refused rather than used, because the failure it causes is a
 * confident judgement about a truncated state.
 */
export function selectDecisionModel(
  candidates: DecisionCandidate[],
  input: { pinned?: string; evidenceTokens: number },
): DecisionSelection | DecisionSelectionFailure {
  const rejected: DecisionRejection[] = [];
  const name = (candidate: DecisionCandidate) => `${candidate.providerID}/${candidate.id}`;
  const active = candidates.filter((candidate) => {
    if (!candidate.enabled) {
      rejected.push({ model: name(candidate), reason: "disabled" });
      return false;
    }
    if (candidate.status !== "active") {
      rejected.push({ model: name(candidate), reason: `status ${candidate.status}` });
      return false;
    }
    return true;
  });

  if (input.pinned) {
    const pinned = active.find((candidate) => name(candidate) === input.pinned);
    if (!pinned) {
      rejected.push({ model: input.pinned, reason: "not in the active catalog" });
      return { error: `pinned decision model ${input.pinned} is not available`, rejected };
    }
    if (pinned.contextLimit !== undefined && pinned.contextLimit < input.evidenceTokens) {
      rejected.push({ model: name(pinned), reason: `context ${pinned.contextLimit} below the ${input.evidenceTokens} tokens of evidence` });
      return { error: `pinned decision model ${input.pinned} cannot hold the evidence`, rejected };
    }
    return {
      model: pinned,
      rationale: `pinned by the operator to ${name(pinned)}`,
      rejected,
    };
  }

  const fitting = active.filter((candidate) => {
    if (candidate.contextLimit !== undefined && candidate.contextLimit < input.evidenceTokens) {
      rejected.push({ model: name(candidate), reason: `context ${candidate.contextLimit} below the ${input.evidenceTokens} tokens of evidence` });
      return false;
    }
    return true;
  });
  if (fitting.length === 0) {
    return { error: "no decision model can hold the evidence", rejected };
  }
  const ordered = [...fitting].sort((a, b) => {
    const price = (a.costPerMillionInput ?? Number.MAX_SAFE_INTEGER) - (b.costPerMillionInput ?? Number.MAX_SAFE_INTEGER);
    if (price !== 0) return price;
    const context = (b.contextLimit ?? 0) - (a.contextLimit ?? 0);
    if (context !== 0) return context;
    return name(a).localeCompare(name(b));
  });
  const chosen = ordered[0]!;
  const skipped = ordered.slice(1).map((candidate) => ({ model: name(candidate), reason: "a cheaper candidate with enough context was available" }));
  return {
    model: chosen,
    rationale: `cheapest active candidate with enough context (${chosen.contextLimit ?? "unknown"} tokens)`,
    rejected: [...rejected, ...skipped],
  };
}
