import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSetupPlan } from "../../src/bootstrap/plan.js";
import { applySetupPlan } from "../../src/bootstrap/apply.js";
import { withHeader } from "../../src/bootstrap/jsonc.js";

describe("setup bootstrap", () => {
  it("plans then applies without overwriting user content", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const plan = await buildSetupPlan({
      scope: "project",
      setDefault: true,
      updateOnly: false,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.1.3",
      pluginOptions: { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false },
      includePluginOptions: false,
    });
    expect(plan.files.some((f) => f.path === ".opencode/agents/team-leader.md" && f.action === "create")).toBe(true);
    const result = await applySetupPlan({
      scope: "project",
      setDefault: true,
      updateOnly: false,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.1.3",
      pluginOptions: { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false },
      includePluginOptions: false,
    });
    expect(result.created.length).toBeGreaterThan(5);
    // Second apply keeps; user edit is preserved.
    const agentPath = path.join(root, ".opencode", "agents", "team-leader.md");
    await fs.promises.writeFile(agentPath, "USER EDITED — not managed\n");
    const result2 = await applySetupPlan({
      scope: "project",
      setDefault: false,
      updateOnly: true,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.1.3",
      pluginOptions: {},
      includePluginOptions: false,
    });
    const content = await fs.promises.readFile(agentPath, "utf8");
    expect(content).toContain("USER EDITED");
    expect(result2.skipped.join()).toContain(".opencode/agents/team-leader.md");
  });
  it("lets the user pin a model in an agent file without the setup overwriting it", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = {
      scope: "project" as const,
      setDefault: false,
      updateOnly: false,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.3.0",
      pluginOptions: {},
      includePluginOptions: false,
    };
    await applySetupPlan(base);
    const agentPath = path.join(root, ".opencode", "agents", "team-leader.md");
    const original = await fs.promises.readFile(agentPath, "utf8");
    const pinned = original.replace("---\n", "---\nmodel: anthropic/claude-sonnet-4-5\n");
    expect(pinned).not.toBe(original);
    await fs.promises.writeFile(agentPath, pinned);
    // The file drifts from the managed template, so setup keeps the user's pin.
    const plan = await buildSetupPlan(base);
    expect(plan.files.find((f) => f.path === ".opencode/agents/team-leader.md")?.action).toBe("keep-drifted");
    const applied = await applySetupPlan(base);
    expect(applied.skipped.join()).toContain(".opencode/agents/team-leader.md");
    const after = await fs.promises.readFile(agentPath, "utf8");
    expect(after).toContain("model: anthropic/claude-sonnet-4-5");
  });
  it("removes the previous-version roster and keeps a file the user edited", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = {
      scope: "project" as const,
      setDefault: true,
      updateOnly: false,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.3.0",
      pluginOptions: {},
      includePluginOptions: false,
    };
    // A project installed with the previous version of the plugin.
    await fs.promises.mkdir(path.join(root, ".opencode", "agents", "agent-team"), { recursive: true });
    const legacy = "---\nmode: primary\n---\nold body\n";
    const legacyManaged = withHeader(legacy, "1");
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "agent-team.md"), legacyManaged);
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "agent-team", "verifier.md"), legacyManaged);
    // One file the user edited after the install.
    const edited = withHeader("---\nmode: primary\n---\nMY OWN AGENT\n", "1").replace(/checksum=[0-9a-f]+/, "checksum=0000000000000000");
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "agent-team", "builder.md"), edited);

    const plan = await buildSetupPlan(base);
    const removals = plan.files.filter((f) => f.action === "remove-managed").map((f) => f.path);
    expect(removals).toContain(".opencode/agents/agent-team.md");
    expect(removals).toContain(".opencode/agents/agent-team/verifier.md");
    // the edited file is never a removal candidate
    expect(removals).not.toContain(".opencode/agents/agent-team/builder.md");
    expect(plan.files.find((f) => f.path === ".opencode/agents/agent-team/builder.md")?.action).toBe("keep-drifted");

    const applied = await applySetupPlan(base);
    expect(applied.removed).toContain(".opencode/agents/agent-team.md");
    expect(applied.removed).toContain(".opencode/agents/agent-team/verifier.md");
    expect(applied.removed).not.toContain(".opencode/agents/agent-team/builder.md");
    // the removed files are gone, the edited one survives, the new roster is in place
    await expect(fs.promises.access(path.join(root, ".opencode", "agents", "agent-team.md"))).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "agent-team", "builder.md"), "utf8")).toContain("MY OWN AGENT");
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8")).toContain("You are Team Leader");
    // the removal is backed up before it happens
    expect(applied.backups.length).toBeGreaterThan(0);
  });
  it("updates intact managed files and skips config on global scope", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = {
      scope: "project" as const,
      setDefault: false,
      updateOnly: false,
      projectRoot: root,
      pluginPackage: "@lindoelio/opencode-agent-team@0.1.3",
      pluginOptions: {},
      includePluginOptions: false,
    };
    await applySetupPlan(base);
    // corrupt a managed header checksum: body matches the template, so apply repairs it (update path)
    const agentPath2 = path.join(root, ".opencode", "agents", "team-leader.md");
    const applied = await fs.promises.readFile(agentPath2, "utf8");
    expect(applied).toContain("AGENT-TEAM-MANAGED");
    await fs.promises.writeFile(agentPath2, applied.replace(/checksum=[0-9a-f]+/, "checksum=0000000000000000"));
    const again = await applySetupPlan(base);
    expect(again.updated.join()).toContain(".opencode/agents/team-leader.md");
    const repaired = await fs.promises.readFile(agentPath2, "utf8");
    expect(repaired).not.toContain("0000000000000000");
    // global scope never touches project config and honors homeDir
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-home-"));
    const global = await applySetupPlan({ ...base, scope: "global", homeDir: home });
    expect(global.created.length).toBeGreaterThan(5);
    expect(global.configChanged).toBe(false);
  });
});
