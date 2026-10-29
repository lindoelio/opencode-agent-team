export const AGENT_TEAM_METHOD_VERSION = "1";
export const AGENT_TEMPLATE_VERSION = "1";

export const MANAGED_AGENT_FILES = [
  ".opencode/agents/team-leader.md",
  ".opencode/agents/team-leader/explorer.md",
  ".opencode/agents/team-leader/product.md",
  ".opencode/agents/team-leader/architect.md",
  ".opencode/agents/team-leader/designer.md",
  ".opencode/agents/team-leader/coder.md",
  ".opencode/agents/team-leader/worker.md",
  ".opencode/agents/team-leader/reviewer.md",
  ".opencode/agents/team-leader/security.md",
  ".opencode/agents/team-leader/release.md",
  ".agent-team/README.md",
] as const;

/**
 * Agent files installed by earlier versions of the plugin. They are removed on
 * setup so a project never ends up with two rosters: the stale one still
 * carries the old primary prompt, the old role names and a pinned model, and
 * it would sit outside the `team-leader/*` orchestration boundary.
 *
 * Only files that still carry the managed marker are touched; a file the user
 * edited is preserved.
 */
export const LEGACY_MANAGED_AGENT_FILES = [
  ".opencode/agents/agent-team.md",
  ".opencode/agents/agent-team/explorer.md",
  ".opencode/agents/agent-team/product.md",
  ".opencode/agents/agent-team/architect.md",
  ".opencode/agents/agent-team/designer.md",
  ".opencode/agents/agent-team/builder.md",
  ".opencode/agents/agent-team/verifier.md",
  ".opencode/agents/agent-team/worker.md",
  ".opencode/agents/agent-team/security.md",
  ".opencode/agents/agent-team/release.md",
] as const;

