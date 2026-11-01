import { z } from "zod";
import { DECISION_USES, type DecisionThresholds as DecisionThresholdSet, type DecisionUse as DecisionUseName } from "./domain/decision-model.js";

export const AutonomySchema = z.object({
  /**
   * `yolo` (default): ALLOW is the baseline for external, destructive, and
   * production actions; the agent asks only when a user-registered guardrail
   * matches. `guarded`: the legacy opt-in behavior (ask before external,
   * destructive, or outside-delivery actions).
   */
  mode: z.enum(["yolo", "guarded"]).default("yolo"),
  /**
   * User-declared guardrails: plain substrings or regular expressions matched
   * case-insensitively against `"<action> <resources>"`. A match elevates the
   * action to ASK. Empty by default — nothing is asked.
   */
  askBefore: z.array(z.string()).default([]),
});

/**
 * Optional model overrides. Every field is optional and the whole block is
 * optional: with no configuration the OpenCode harness default model,
 * reasoning effort and output budget apply. The plugin never pins, replaces
 * or falls back to a model on its own.
 */
export const ModelOptionsSchema = z.object({
  /** Pin every Agent Team agent to one model (`provider/model`). */
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  /** Reasoning effort applied to every Agent Team agent. */
  reasoningEffort: z.string().optional(),
  /** Per-role reasoning effort keyed by agent id (e.g. `team-leader/reviewer`). Wins over `reasoningEffort`. */
  roleReasoningEffort: z.record(z.string(), z.string()).optional(),
  /** Output token budget for Agent Team agents. */
  maxTokens: z.number().int().positive().optional(),
});

export const OrchestrationSchema = z.object({
  /**
   * Maximum specialists running at the same time. Every delegated specialist
   * is a separate process with a real memory cost (hundreds of MB), so an
   * unbounded fan-out can exhaust the host. The leader may still run every
   * independent unit in parallel — it just does it in bounded waves.
   */
  maxParallelSpecialists: z.number().int().min(1).max(32).default(6),
});

/** How the decision capability behaves. `off` refuses every decision. */
export const DecisionModeSchema = z.enum(["off", "auto", "required"]);

/** The threshold sets a decision can be held to. */
export const DecisionUseSchema = z.enum(DECISION_USES);

/** The minimums one use demands: a probability and a confidence, both in [0,1]. */
export const DecisionThresholdsSchema = z.object({
  probability: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});

export const DecisionOptionsSchema = z.object({
  /**
   * `auto` (the default) uses a decision model when the host exposes one and
   * does nothing when it does not. `required` fails the step that asked for
   * a decision when none is available. `off` refuses every decision.
   */
  mode: DecisionModeSchema.default("auto"),
  /** A pinned decision model, as `provider/model`. Every decision runs on it. */
  model: z.string().optional(),
  /** Per-use thresholds, overriding the built-in table. */
  thresholds: z.partialRecord(DecisionUseSchema, DecisionThresholdsSchema).default({}),
  /** How long one decision request may take. */
  timeoutMs: z.number().int().positive().default(10000),
  /**
   * What happens when the capability is on but a decision cannot be served:
   * `escalate` hands the case back to the language model or the operator,
   * `abort` fails the step.
   */
  unavailable: z.enum(["escalate", "abort"]).default("escalate"),
});

export const AgentTeamOptionsSchema = z.object({
  profile: z.enum(["public", "private"]).default("public"),
  strictEvidence: z.boolean().default(true),
  projectState: z.string().default(".agent-team"),
  model: ModelOptionsSchema.optional(),
  telemetry: z.boolean().default(false),
  autonomy: AutonomySchema.default({ mode: "yolo", askBefore: [] }),
  orchestration: OrchestrationSchema.default({ maxParallelSpecialists: 6 }),
  decision: DecisionOptionsSchema.optional(),
});
export type AgentTeamOptions = z.infer<typeof AgentTeamOptionsSchema>;
export type AutonomyOptions = z.infer<typeof AutonomySchema>;
export type ModelOptions = z.infer<typeof ModelOptionsSchema>;
export type OrchestrationOptions = z.infer<typeof OrchestrationSchema>;
export type DecisionUse = DecisionUseName;
export type DecisionThresholds = DecisionThresholdSet;
export type DecisionOptions = z.infer<typeof DecisionOptionsSchema>;

/** The decision options an unconfigured installation runs with. */
export const DECISION_DEFAULTS: DecisionOptions = DecisionOptionsSchema.parse({});

/**
 * The options an unconfigured installation runs with, as a configuration file
 * records them.
 *
 * The global scope writes these rather than the options of the session that
 * happened to run the setup: a project that configures the plugin must not
 * export its settings to every project on the machine.
 */
export function defaultAgentTeamOptions(): Record<string, unknown> {
  const parsed = AgentTeamOptionsSchema.parse({});
  return { ...parsed, telemetry: false };
}

/**
 * The effective decision options. The block is optional in the configuration,
 * so every consumer resolves it through here rather than repeating the
 * fallback.
 */
export function decisionOptions(options: AgentTeamOptions): DecisionOptions {
  return options.decision ?? DECISION_DEFAULTS;
}

export function parseOptions(raw: unknown): AgentTeamOptions {
  const parsed = AgentTeamOptionsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`invalid agent-team options: ${parsed.error.message}`);
  if (parsed.data.telemetry === true) {
    throw new Error("telemetry must remain false");
  }
  return parsed.data;
}
