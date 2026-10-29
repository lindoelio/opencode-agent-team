import { describe, expect, it } from "vitest";
import { AGENT_TEAM_COMMANDS } from "../../src/catalog/commands.js";
import { SKILL_IDS, loadSkillContents, frontmatterName, frontmatterDescription } from "../../src/catalog/skills.js";
import { AGENT_TEMPLATES, loadTemplates } from "../../src/catalog/agents.js";

describe("registration contracts", () => {
  it("exposes the documented command set", () => {
    const names = AGENT_TEAM_COMMANDS.map((c) => c.name);
    for (const expected of [
      "agent-team/start",
      "agent-team/discover",
      "agent-team/thesis",
      "agent-team/decide",
      "agent-team/plan",
      "agent-team/execute",
      "agent-team/review",
      "agent-team/deliver",
      "agent-team/status",
      "agent-team/why",
      "agent-team/guard",
      "agent-team/setup",
      "agent-team/doctor",
      "agent-team/export",
    ]) {
      expect(names).toContain(expected);
    }
    // Every command carries a name, a description and a prompt.
    for (const command of AGENT_TEAM_COMMANDS) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.prompt.length).toBeGreaterThan(0);
    }
  });

  it("registers every skill id against a loadable SKILL.md", async () => {
    const contents = await loadSkillContents();
    for (const id of SKILL_IDS) {
      const md = contents.get(id);
      expect(md, `${id} must have a SKILL.md`).toBeDefined();
      expect(frontmatterName(md!).length).toBeGreaterThan(0);
      expect(frontmatterDescription(md!).length).toBeGreaterThan(0);
    }
  });

  it("registers every agent template against a loadable file", async () => {
    const templates = await loadTemplates();
    for (const template of AGENT_TEMPLATES) {
      const content = templates.get(template.targetRel);
      expect(content, `${template.targetRel} must be loadable`).toBeDefined();
      expect(content!.startsWith("---"), `${template.targetRel} frontmatter must start at byte 0`).toBe(true);
      expect(content).toContain("mode:");
    }
  });
});
