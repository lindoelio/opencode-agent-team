import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSetupPlan, type SetupOptions } from "../../src/bootstrap/plan.js";
import { applySetupPlan } from "../../src/bootstrap/apply.js";
import { withHeader } from "../../src/bootstrap/jsonc.js";
import { resolveScope, type Scope } from "../../src/bootstrap/scope.js";

function scopeFor(root: string, kind: "project" | "global" = "project"): Scope {
  return resolveScope({ kind, projectRoot: root, injectedConfigDir: path.join(root, "global-config"), env: {} });
}

function optionsFor(scope: Scope, extra: Partial<SetupOptions> = {}): SetupOptions {
  return {
    scope,
    decisions: { setDefault: false, leaderTitle: undefined },
    pending: [],
    updateOnly: false,
    pluginPackage: "@lindoelio/opencode-agent-team@0.1.3",
    pluginOptions: {},
    includePluginOptions: false,
    ...extra,
  };
}

describe("setup bootstrap", () => {
  it("plans then applies without overwriting user content", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const scope = scopeFor(root);
    const plan = await buildSetupPlan(optionsFor(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    expect(plan.files.some((f) => f.path === ".opencode/agents/team-leader.md" && f.action === "create")).toBe(true);
    const result = await applySetupPlan(optionsFor(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    expect(result.created.length).toBeGreaterThan(5);
    // the project scope records the leader as the default agent
    const config = JSON.parse(await fs.promises.readFile(path.join(root, "opencode.jsonc"), "utf8")) as { default_agent?: string };
    expect(config.default_agent).toBe("team-leader");
    // Second apply keeps; user edit is preserved.
    const agentPath = path.join(root, ".opencode", "agents", "team-leader.md");
    await fs.promises.writeFile(agentPath, "USER EDITED — not managed\n");
    const result2 = await applySetupPlan(optionsFor(scope, { updateOnly: true }));
    const content = await fs.promises.readFile(agentPath, "utf8");
    expect(content).toContain("USER EDITED");
    expect(result2.skipped.join()).toContain(".opencode/agents/team-leader.md");
  });
  it("refreshes installed files under --update without creating the ones that are missing", async () => {
    // `--update` is documented as a refresh of the installed roster. If it
    // created missing files too, it would be indistinguishable from `--apply`
    // and the flag would mean nothing.
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = optionsFor(scopeFor(root));
    const applied = await applySetupPlan(base);
    expect(applied.created.length).toBeGreaterThan(0);

    // A file a newer plugin version introduced is not installed yet.
    const missing = path.join(root, ".opencode", "agents", "team-leader", "newcomer.md");
    await fs.promises.rm(path.join(root, ".opencode", "agents", "team-leader", "coder.md"));

    const plan = await buildSetupPlan({ ...base, updateOnly: true });
    expect(plan.files.some((f) => f.path === ".opencode/agents/team-leader/coder.md" && f.action === "create")).toBe(false);
    expect(plan.warnings.join()).toContain(".opencode/agents/team-leader/coder.md");

    const result = await applySetupPlan({ ...base, updateOnly: true });
    expect(result.created).toEqual([]);
    expect(result.warnings.join()).toContain(".opencode/agents/team-leader/coder.md");
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.join(root, ".opencode", "agents", "team-leader.md"))).toBe(true);
  });
  it("lets the user pin a model in an agent file without the setup overwriting it", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = optionsFor(scopeFor(root));
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
    const base = optionsFor(scopeFor(root));
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
    expect(applied.removed.join()).toContain(".opencode/agents/agent-team.md");
    expect(applied.removed.join()).toContain(".opencode/agents/agent-team/verifier.md");
    expect(applied.removed.join()).not.toContain(".opencode/agents/agent-team/builder.md");
    // the removed files are gone, the edited one survives, the new roster is in place
    await expect(fs.promises.access(path.join(root, ".opencode", "agents", "agent-team.md"))).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "agent-team", "builder.md"), "utf8")).toContain("MY OWN AGENT");
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8")).toContain("You are Team Leader");
    // the removal is backed up before it happens
    expect(applied.backups.length).toBeGreaterThan(0);
  });
  it("updates intact managed files and writes the global configuration", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setup-"));
    const base = optionsFor(scopeFor(root));
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
    // the global scope installs the roster in the global configuration
    // directory and writes the global configuration file
    const globalScope = scopeFor(root, "global");
    const global = await applySetupPlan(optionsFor(globalScope, { includePluginOptions: true }));
    expect(global.created.length).toBeGreaterThan(5);
    expect(global.configChanged).toBe(true);
    expect(global.created.join()).toContain(path.join("global-config", "agents", "team-leader.md"));
    // and writes nothing outside the global configuration directory
    expect(global.created.join()).not.toContain(path.join(root, ".agent-team"));
  });
});
