import type { AgentTeamOptions } from "../options.js";

export interface ResolvedModelOptions {
  model?: { providerID: string; id: string; variant?: string };
  reasoningEffort?: string;
  maxTokens?: number;
}

/**
 * Effective model options for a role. Nothing is returned unless the user
 * configured it: with no configuration the OpenCode harness default model,
 * reasoning effort and output budget apply untouched.
 */
export function resolveModelOptions(options: AgentTeamOptions, role: string): ResolvedModelOptions {
  const cfg = options.model;
  if (!cfg) return {};
  const out: ResolvedModelOptions = {};
  if (cfg.providerID && cfg.modelID) out.model = { providerID: cfg.providerID, id: cfg.modelID };
  const effort = cfg.roleReasoningEffort?.[role] ?? cfg.reasoningEffort;
  if (effort) out.reasoningEffort = effort;
  if (cfg.maxTokens) out.maxTokens = cfg.maxTokens;
  return out;
}

/** Reasoning efforts the user configured, deduplicated. Empty when nothing was configured. */
export function configuredReasoningEfforts(options: AgentTeamOptions): string[] {
  const cfg = options.model;
  if (!cfg) return [];
  const all = [cfg.reasoningEffort, ...Object.values(cfg.roleReasoningEffort ?? {})];
  return [...new Set(all.filter((e): e is string => typeof e === "string" && e.length > 0))];
}
