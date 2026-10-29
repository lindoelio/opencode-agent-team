import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTemplates, AGENT_TEMPLATES, packageVersion } from "../../src/catalog/agents.js";
import { loadSkillContents, skillDisplayName, skillDescriptions, frontmatterName, frontmatterDescription, SKILL_IDS } from "../../src/catalog/skills.js";
import { enabledCases, loadCases, scoreCase, runBench } from "../../bench/runners/run.js";

describe("catalog extras", () => {
  it("loads all agent templates with frontmatter", async () => {
    const t = await loadTemplates();
    expect(t.size).toBe(AGENT_TEMPLATES.length + 1); // + .agent-team/README
    expect(t.get(".opencode/agents/team-leader.md")).toContain("mode: primary");
    expect(t.get(".opencode/agents/team-leader/worker.md")).toContain("mode: subagent");
  });
  it("reads the plugin version from the shipped manifest, never from a literal", () => {
    // A hardcoded version drifts on every release and writes the wrong plugin
    // spec into a consumer's config, so the manifest is the only source.
    expect(packageVersion()).toBe(
      (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string }).version,
    );
  });
  it("reports an unknown version rather than throwing when the manifest cannot be read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-version-"));
    try {
      expect(packageVersion(root)).toBe("unknown");
      fs.writeFileSync(path.join(root, "package.json"), "{ not json");
      expect(packageVersion(root)).toBe("unknown");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x" }));
      expect(packageVersion(root)).toBe("unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("loads skills and derives names", async () => {
    const contents = await loadSkillContents();
    expect(contents.size).toBe(SKILL_IDS.length);
    expect(skillDisplayName("agent-team-delivery-scope")).toBe("Agent Team Delivery Scope");
    const descs = await skillDescriptions();
    expect(descs).toHaveLength(SKILL_IDS.length);
    const first = [...contents.values()][0]!;
    expect(frontmatterName(first).length).toBeGreaterThan(0);
    expect(frontmatterDescription(first).length).toBeGreaterThan(0);
    expect(frontmatterName("no frontmatter")).toBe("Agent Team Skill");
    expect(frontmatterDescription("no frontmatter")).toBe("");
  });
  it("scores bench cases from an observation, not from the case's own expectations", async () => {
    // The scorer is exercised against synthetic observations, never against
    // the case definition it is supposed to judge.
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(3);
    const arch = cases.find((c) => c.id === "AGENT-TEAM-ARCH-001")!;
    const good = scoreCase(arch, { invariants: [...arch.expected_invariants], forbidden: [], artifacts: [...arch.required_artifacts] });
    expect(good.score).toBe(1);
    expect(good.artifactsPresent).toHaveLength(1);
    const bad = scoreCase(arch, { invariants: [...arch.expected_invariants], forbidden: [...arch.forbidden_behaviors], artifacts: [] });
    expect(bad.score).toBe(0.5);
    expect(bad.forbiddenSeen.length).toBeGreaterThan(0);
    const none = scoreCase(arch, { invariants: [], forbidden: [], artifacts: [] });
    expect(none.score).toBe(0);
    const results = await runBench();
    // One result per enabled case. A case that needs a decision model is
    // kept out unless the bench is told to use decision models.
    expect(results).toHaveLength(enabledCases().length);
    expect(results.every((r) => r.status === "not-evaluated")).toBe(true);
  });
});
