import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "./agents.js";

export interface SkillDef {
  id: string;
  dirRel: string;
}

export const SKILL_IDS = [
  "agent-team-intent-framing",
  "agent-team-domain-discovery",
  "agent-team-structured-investigation",
  "agent-team-architecture-decision",
  "agent-team-delivery-scope",
  "agent-team-delivery-execution",
  "agent-team-general-execution",
  "agent-team-research-workflow",
  "agent-team-writing-execution",
  "agent-team-code-review",
  "agent-team-design-review",
  "agent-team-writing-review",
  "agent-team-research-review",
  "agent-team-strategy-review",
  "agent-team-safe-autonomy",
  "agent-team-evidence-gate",
  "agent-team-delivery-contract",
  "agent-team-calibrated-decision",
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

/**
 * Skills each role owns. The agent markdown files list the same skills in
 * prose; this map is the deterministic source that the context hook injects,
 * so the two cannot drift apart silently.
 */
export const ROLE_SKILLS: Record<string, readonly SkillId[]> = {
  "team-leader": [
    "agent-team-intent-framing",
    "agent-team-structured-investigation",
    "agent-team-architecture-decision",
    "agent-team-delivery-scope",
    "agent-team-delivery-execution",
    "agent-team-evidence-gate",
    "agent-team-safe-autonomy",
    "agent-team-delivery-contract",
    "agent-team-calibrated-decision",
  ],
  "team-leader/explorer": ["agent-team-domain-discovery", "agent-team-structured-investigation"],
  "team-leader/product": ["agent-team-intent-framing"],
  "team-leader/architect": ["agent-team-architecture-decision", "agent-team-domain-discovery"],
  "team-leader/designer": [],
  "team-leader/coder": ["agent-team-delivery-execution", "agent-team-structured-investigation"],
  "team-leader/worker": [
    "agent-team-general-execution",
    "agent-team-research-workflow",
    "agent-team-writing-execution",
    "agent-team-structured-investigation",
  ],
  "team-leader/reviewer": [
    "agent-team-code-review",
    "agent-team-design-review",
    "agent-team-writing-review",
    "agent-team-research-review",
    "agent-team-strategy-review",
    "agent-team-evidence-gate",
    "agent-team-calibrated-decision",
  ],
  "team-leader/security": ["agent-team-safe-autonomy", "agent-team-evidence-gate", "agent-team-calibrated-decision"],
  "team-leader/release": ["agent-team-delivery-contract", "agent-team-calibrated-decision"],
};

/** Skill ids a role may load. Unknown roles get nothing: no guessing. */
export function skillsForRole(role: string): readonly SkillId[] {
  return ROLE_SKILLS[role] ?? [];
}

/** Skill ids for a specialist, addressed by its short role name (`coder`, `worker`, ...). */
export function skillsForSpecialist(role: string): readonly SkillId[] {
  return ROLE_SKILLS[`team-leader/${role}`] ?? [];
}

/** Injected into the role's system prompt so skill awareness is deterministic, not remembered. */
export function roleSkillsBlock(role: string): string {
  const skills = skillsForRole(role);
  if (skills.length === 0) return "";
  return [
    `Skills available to ${role} — load with the skill tool before acting, and follow each output contract exactly:`,
    ...skills.map((id) => `- ${id}`),
  ].join("\n");
}

export async function loadSkillContents(): Promise<Map<string, string>> {
  const root = packageRoot();
  const out = new Map<string, string>();
  for (const id of SKILL_IDS) {
    const abs = path.join(root, "assets", "skills", id, "SKILL.md");
    const content = await fs.promises.readFile(abs, "utf8");
    out.set(id, content);
  }
  return out;
}

export function skillDisplayName(id: string): string {
  const m = id.match(/^agent-team-(.+)$/);
  const rest = (m?.[1] ?? id).split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
  return `Agent Team ${rest}`;
}

export async function skillDescriptions(): Promise<Array<{ id: string; description: string }>> {
  const contents = await loadSkillContents();
  const out: Array<{ id: string; description: string }> = [];
  for (const [id, md] of contents) {
    const d = md.match(/description:\s*(.+)/)?.[1]?.trim() ?? id;
    out.push({ id, description: d });
  }
  return out;
}

export function frontmatterName(content: string): string {
  return content.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "Agent Team Skill";
}

export function frontmatterDescription(content: string): string {
  return content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
}
