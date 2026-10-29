import type { DecisionAnswer } from "../domain/decision-model.js";

/**
 * The host's decision contract.
 *
 * The host owns this shape, and the plugin speaks it without knowing which
 * provider is behind it. Everything here is a translation: questions go out
 * in the host's form, answers come back in it, and the plugin's own answer
 * union is what the rest of the product sees.
 */

/** The host's own per-question limits. Exceeding one of them fails the whole request. */
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

export interface DecisionChoice {
  value: string | boolean;
  description?: string;
}

export interface DecisionLevel {
  label: string;
  description?: string;
}

export interface DecisionQuestionInput {
  type: "predicate" | "choice" | "score";
  name: string;
  instructions: string;
  choices?: DecisionChoice[];
  levels?: DecisionLevel[];
}

export interface DecisionRequest {
  model: { id: string; providerID: string };
  input: Array<{ type: "text"; text: string }>;
  questions: Array<Record<string, unknown>>;
}

/**
 * Checks a question set against the host's limits.
 *
 * The host rejects the whole request when one of them is exceeded, so the
 * check happens here where the failure can name the question.
 */
export function validateDecisionQuestions(questions: DecisionQuestionInput[]): string | undefined {
  if (questions.length === 0) return "a decision needs at least one question";
  const names = new Set<string>();
  for (const question of questions) {
    if (names.has(question.name)) return `duplicate question name ${question.name}`;
    names.add(question.name);
    if (question.type === "choice") {
      const options = question.choices ?? [];
      if (options.length === 0) return `question ${question.name} has no choices`;
      if (options.length > MAX_CHOICE_OPTIONS) {
        return `question ${question.name} has ${options.length} choices; the host accepts at most ${MAX_CHOICE_OPTIONS}`;
      }
    }
    if (question.type === "score") {
      const levels = question.levels ?? [];
      if (levels.length === 0) return `question ${question.name} has no levels`;
      if (levels.length > MAX_SCORE_LEVELS) {
        return `question ${question.name} has ${levels.length} levels; the host accepts at most ${MAX_SCORE_LEVELS}`;
      }
    }
  }
  return undefined;
}

/** Builds the host request. The state travels as one text part. */
export function buildDecisionRequest(input: {
  model: { id: string; providerID: string };
  state: string;
  questions: DecisionQuestionInput[];
}): DecisionRequest {
  return {
    model: input.model,
    input: [{ type: "text", text: input.state }],
    questions: input.questions.map((question) => {
      if (question.type === "choice") {
        return {
          type: "choice",
          name: question.name,
          instructions: question.instructions,
          choices: question.choices ?? [],
        };
      }
      if (question.type === "score") {
        return {
          type: "score",
          name: question.name,
          instructions: question.instructions,
          levels: question.levels ?? [],
        };
      }
      return { type: "predicate", name: question.name, instructions: question.instructions };
    }),
  };
}

interface HostAnswer {
  type?: string;
  name?: string;
  probability?: number;
  choice?: string | boolean;
  probabilities?: unknown;
  confidence?: number;
  score?: number;
  reason?: string;
  message?: string;
}

export interface NormalisedDecision {
  answers: DecisionAnswer[];
  usage: { input: number; output: number };
}

/**
 * Normalises what the host returned.
 *
 * An answer the plugin does not understand becomes an error answer, so an
 * unrecognised shape is never mistaken for a confident result.
 */
export function normaliseDecisionResult(raw: unknown): NormalisedDecision {
  const result = (raw ?? {}) as { answers?: unknown; tokens?: { input?: number; output?: number } };
  const rawAnswers = Array.isArray(result.answers) ? result.answers : [];
  const answers: DecisionAnswer[] = rawAnswers.map((entry) => normaliseAnswer(entry as HostAnswer));
  const usage = {
    input: typeof result.tokens?.input === "number" ? result.tokens.input : 0,
    output: typeof result.tokens?.output === "number" ? result.tokens.output : 0,
  };
  return { answers, usage };
}

function normaliseAnswer(answer: HostAnswer): DecisionAnswer {
  const name = String(answer.name ?? "");
  if (answer.type === "predicate" && typeof answer.probability === "number") {
    return { type: "predicate", name, probability: answer.probability };
  }
  if (answer.type === "choice" && typeof answer.choice !== "undefined" && typeof answer.confidence === "number") {
    return {
      type: "choice",
      name,
      choice: answer.choice,
      probabilities: probabilityRecord(answer.probabilities),
      confidence: answer.confidence,
    };
  }
  if (answer.type === "score" && typeof answer.score === "number" && typeof answer.confidence === "number") {
    return {
      type: "score",
      name,
      score: answer.score,
      probabilities: levelProbabilities(answer.probabilities),
      confidence: answer.confidence,
    };
  }
  return {
    type: "error",
    name,
    reason: String(answer.reason ?? "the host returned an answer the plugin does not understand"),
    ...(answer.message ? { message: String(answer.message) } : {}),
  };
}

function probabilityRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as Array<{ value?: string | boolean; probability?: number }>) {
    if (typeof entry.probability !== "number") continue;
    out[String(entry.value ?? "")] = entry.probability;
  }
  return out;
}

function levelProbabilities(raw: unknown): Array<{ value: number; label: string; probability: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ value: number; label: string; probability: number }> = [];
  for (const entry of raw as Array<{ value?: number; label?: string; probability?: number }>) {
    if (typeof entry.probability !== "number") continue;
    out.push({ value: typeof entry.value === "number" ? entry.value : 0, label: String(entry.label ?? ""), probability: entry.probability });
  }
  return out;
}
