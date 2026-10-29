import { z } from "zod";

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

export const AgentTeamOptionsSchema = z.object({
  profile: z.enum(["public", "private"]).default("public"),
  strictEvidence: z.boolean().default(true),
  projectState: z.string().default(".agent-team"),
  model: ModelOptionsSchema.optional(),
  telemetry: z.boolean().default(false),
  autonomy: AutonomySchema.default({ mode: "yolo", askBefore: [] }),
  orchestration: OrchestrationSchema.default({ maxParallelSpecialists: 6 }),
});
export type AgentTeamOptions = z.infer<typeof AgentTeamOptionsSchema>;
export type AutonomyOptions = z.infer<typeof AutonomySchema>;
export type ModelOptions = z.infer<typeof ModelOptionsSchema>;
export type OrchestrationOptions = z.infer<typeof OrchestrationSchema>;

export function parseOptions(raw: unknown): AgentTeamOptions {
  const parsed = AgentTeamOptionsSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`invalid agent-team options: ${parsed.error.message}`);
  if (parsed.data.telemetry === true) {
    throw new Error("telemetry must remain false in v0.1");
  }
  return parsed.data;
}
