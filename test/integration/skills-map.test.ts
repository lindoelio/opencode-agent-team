import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SKILL_IDS, ROLE_SKILLS, roleSkillsBlock, skillsForRole } from "../../src/catalog/skills.js";
import { AGENT_TEMPLATES, loadTemplates } from "../../src/catalog/agents.js";
import { HANDOFF_ROLES } from "../../src/domain/handoff.js";

const AGENT_ROOT = path.resolve("assets", "agents");

function agentBody(rel: string): string {
  return fs.readFileSync(path.join(AGENT_ROOT, rel), "utf8");
}

/** Skill ids mentioned in the `## Skills` block of an agent markdown. */
function skillsDeclaredIn(rel: string): string[] {
  const body = agentBody(rel);
  const start = body.indexOf("## Skills");
  if (start === -1) return [];
  const block = body.slice(start);
  return [...block.matchAll(/`(agent-team-[a-z-]+)`/g)].map((m) => m[1]!);
}

describe("skill map consistency", () => {
  it("every registered skill belongs to at least one role", () => {
    const assigned = new Set(Object.values(ROLE_SKILLS).flat());
    for (const id of SKILL_IDS) {
      expect(assigned.has(id)).toBe(true);
    }
    for (const id of assigned) {
      expect(SKILL_IDS).toContain(id);
    }
  });

  it("every role in the skill map has an agent template", async () => {
    const templates = await loadTemplates();
    for (const role of Object.keys(ROLE_SKILLS)) {
      const key = role === "team-leader" ? ".opencode/agents/team-leader.md" : `.opencode/agents/${role}.md`;
      expect(templates.get(key)).toBeDefined();
    }
  });

  it("the agent markdown and the runtime skill map agree", () => {
    for (const role of Object.keys(ROLE_SKILLS)) {
      const rel = role === "team-leader" ? "team-leader.md" : `team-leader/${role.replace("team-leader/", "")}.md`;
      const declared = skillsDeclaredIn(rel).sort();
      expect(declared).toEqual([...skillsForRole(role)].sort());
    }
  });

  it("the handoff roster matches the agent roster", () => {
    const agentRoles = AGENT_TEMPLATES.map((t) => (t.id === "team-leader" ? "team-leader" : t.id.replace("team-leader/", ""))).filter((r) => r !== "team-leader");
    expect([...HANDOFF_ROLES].sort()).toEqual([...agentRoles].sort());
  });

  it("the injected skill block names every skill of the role", () => {
    const block = roleSkillsBlock("team-leader/reviewer");
    expect(block).toContain("Skills available to team-leader/reviewer");
    for (const id of skillsForRole("team-leader/reviewer")) {
      expect(block).toContain(id);
    }
    expect(roleSkillsBlock("team-leader/unknown")).toBe("");
  });
});
