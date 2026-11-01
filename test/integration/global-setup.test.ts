import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySetupPlan } from "../../src/bootstrap/apply.js";
import { buildSetupPlan, renderPlanText, type SetupOptions } from "../../src/bootstrap/plan.js";
import { resolveDecisions } from "../../src/bootstrap/decisions.js";
import { withHeader } from "../../src/bootstrap/jsonc.js";
import { inspectLeaderFile, LEADER_REL } from "../../src/bootstrap/templates.js";
import { resolveScope, type Scope } from "../../src/bootstrap/scope.js";

const AGENT_TEMPLATES = 10;

async function globalScope(): Promise<{ scope: Scope; root: string; configDir: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-global-"));
  const configDir = path.join(root, "config", "opencode");
  const scope = resolveScope({ kind: "global", projectRoot: root, injectedConfigDir: configDir, env: {} });
  return { scope, root, configDir };
}

function options(scope: Scope, extra: Partial<SetupOptions> = {}): SetupOptions {
  return {
    scope,
    decisions: { setDefault: false, leaderTitle: undefined },
    pending: [],
    updateOnly: false,
    pluginPackage: "@lindoelio/opencode-agent-team@0.6.0",
    pluginOptions: {},
    includePluginOptions: true,
    ...extra,
  };
}

describe("the global installation", () => {
  it("writes the roster into the global configuration directory and nothing else", async () => {
    const { scope, root, configDir } = await globalScope();
    const result = await applySetupPlan(options(scope));
    expect(result.created.length).toBe(AGENT_TEMPLATES);
    expect(await fs.promises.readFile(path.join(configDir, "agents", "team-leader.md"), "utf8")).toContain("You are Team Leader");
    expect(await fs.promises.readFile(path.join(configDir, "agents", "team-leader", "coder.md"), "utf8")).toContain("team-leader/coder");
    // nothing outside the global configuration directory
    expect(fs.existsSync(path.join(root, ".agent-team"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".opencode"))).toBe(false);
    // neither a skill file nor a command file
    expect(fs.existsSync(path.join(configDir, "skills"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "commands"))).toBe(false);
  });

  it("follows the configuration home variable", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-xdg-"));
    const scope = resolveScope({ kind: "global", projectRoot: root, env: { XDG_CONFIG_HOME: root, HOME: root } });
    expect(scope.configDir).toBe(path.join(root, "opencode"));
    const result = await applySetupPlan(options(scope));
    expect(result.created.join()).toContain(path.join(root, "opencode", "agents", "team-leader.md"));
  });

  it("agrees between the plan and the apply, and is idempotent", async () => {
    const { scope, configDir } = await globalScope();
    const plan = await buildSetupPlan(options(scope));
    expect(plan.files.length).toBe(AGENT_TEMPLATES);
    expect(plan.files.every((f) => f.action === "create")).toBe(true);
    expect(renderPlanText(plan)).toContain(path.join(configDir, "agents", "team-leader.md"));

    await applySetupPlan(options(scope));
    const second = await buildSetupPlan(options(scope));
    expect(second.files.every((f) => f.action === "keep")).toBe(true);
    expect(renderPlanText(second)).not.toContain("Dry run only");
  });

  it("plans the configuration change the apply writes, byte for byte", async () => {
    const { scope, configDir } = await globalScope();
    const plan = await buildSetupPlan(options(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    expect(plan.configDiff).toBeDefined();
    const planned = plan.configDiff!.split("+++ planned\n")[1];
    await applySetupPlan(options(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    expect(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")).toBe(planned);
  });

  it("says what the scope does not materialise", async () => {
    const { scope } = await globalScope();
    const plan = await buildSetupPlan(options(scope));
    expect(plan.warnings.join()).toContain(".agent-team/README.md");
    const applied = await applySetupPlan(options(scope));
    expect(applied.notMaterialised).toContain(".agent-team/README.md");
  });

  it("records the plugin in the global configuration without pinning it", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope));
    const config = JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")) as { plugins: Array<{ package: string }> };
    expect(config.plugins[0]!.package).toBe("@lindoelio/opencode-agent-team");
  });

  it("leaves an existing plugin entry exactly as it is", async () => {
    const { scope, configDir } = await globalScope();
    await fs.promises.mkdir(configDir, { recursive: true });
    const existing = `{\n  // user comment\n  "plugins": ["@lindoelio/opencode-agent-team"],\n  "model": "someone/else"\n}\n`;
    await fs.promises.writeFile(path.join(configDir, "opencode.json"), existing);
    const result = await applySetupPlan(options(scope));
    expect(result.configChanged).toBe(false);
    expect(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")).toBe(existing);
  });

  it("writes the JSON-with-comments file when the directory holds both names", async () => {
    const { scope, configDir } = await globalScope();
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(path.join(configDir, "opencode.json"), "{}");
    await fs.promises.writeFile(path.join(configDir, "opencode.jsonc"), "{}");
    const scoped = resolveScope({ kind: "global", projectRoot: configDir, injectedConfigDir: configDir, env: {} });
    await applySetupPlan(options(scoped));
    expect(JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.jsonc"), "utf8"))).toHaveProperty("plugins");
    expect(JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8"))).not.toHaveProperty("plugins");
  });

  it("backs the configuration file up before it changes it", async () => {
    const { scope, configDir } = await globalScope();
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(path.join(configDir, "opencode.json"), '{"model":"someone/else"}\n');
    const result = await applySetupPlan(options(scope));
    expect(result.configChanged).toBe(true);
    expect(result.backups.length).toBeGreaterThan(0);
    const backup = result.backups.find((b) => b.endsWith("opencode.json"))!;
    expect(backup).toContain(path.join(configDir, ".agent-team", "setup-backups"));
    expect(await fs.promises.readFile(backup, "utf8")).toBe('{"model":"someone/else"}\n');
  });

  it("leaves the directory untouched when the configuration file cannot be parsed", async () => {
    const { scope, configDir } = await globalScope();
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(path.join(configDir, "opencode.json"), "{ broken !!!");
    await expect(applySetupPlan(options(scope))).rejects.toThrow();
    expect(fs.existsSync(path.join(configDir, "agents"))).toBe(false);
  });

  it("a dry run writes nothing", async () => {
    const { scope, configDir } = await globalScope();
    const plan = await buildSetupPlan(options(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    expect(plan.configDiff).toBeDefined();
    expect(fs.existsSync(path.join(configDir, "agents"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "opencode.json"))).toBe(false);
  });

  it("records the default agent only when it was asked for", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    const config = JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")) as { default_agent?: string };
    expect(config.default_agent).toBe("team-leader");

    const other = await globalScope();
    await applySetupPlan(options(other.scope));
    const untouched = JSON.parse(await fs.promises.readFile(path.join(other.configDir, "opencode.json"), "utf8")) as { default_agent?: string };
    expect(untouched.default_agent).toBeUndefined();
  });

  it("leaves a recorded default agent of another kind alone", async () => {
    const { scope, configDir } = await globalScope();
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.writeFile(path.join(configDir, "opencode.json"), `{\n  "default_agent": "build"\n}\n`);
    const resolved = resolveDecisions({
      kind: "global",
      updateOnly: false,
      flags: new Set<string>(),
      recordedDefaultAgent: "build",
      leaderFileWritable: true,
    });
    expect(resolved.decisions.setDefault).toBe(false);
    await applySetupPlan(options(scope, { decisions: resolved.decisions }));
    const config = JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")) as { default_agent?: string };
    expect(config.default_agent).toBe("build");
  });

  it("installs the leader with the title it was given", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    const leader = await fs.promises.readFile(path.join(configDir, "agents", "team-leader.md"), "utf8");
    expect(leader).toContain("description: Meu Time — accountable orchestrator");
    expect(leader).toContain("title=Meu%20Time");
  });

  it("keeps the installed title through an update", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    const again = await applySetupPlan(options(scope, { updateOnly: true, decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    expect(again.updated).toEqual([]);
    expect(await fs.promises.readFile(path.join(configDir, "agents", "team-leader.md"), "utf8")).toContain("description: Meu Time — accountable orchestrator");
  });

  it("never re-titles the leader on an update", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    // The update resolves its decisions the way the command does: the
    // recorded title wins, because an update refreshes the roster and does not
    // re-title it.
    const leaderPath = scope.resolve(LEADER_REL)!;
    const state = await inspectLeaderFile(leaderPath);
    const resolved = resolveDecisions({
      kind: "global",
      updateOnly: true,
      flags: new Set(["leader-title"]),
      leaderTitle: "Outro Time",
      recordedTitle: state.title,
      leaderFileWritable: state.writable,
    });
    expect(resolved.decisions.leaderTitle).toBe("Meu Time");
    await applySetupPlan(options(scope, { updateOnly: true, decisions: resolved.decisions }));
    const leader = await fs.promises.readFile(path.join(configDir, "agents", "team-leader.md"), "utf8");
    expect(leader).toContain("description: Meu Time — accountable orchestrator");
    expect(leader).not.toContain("Outro Time");
  });

  it("never changes the recorded default agent on a global update", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope, { decisions: { setDefault: true, leaderTitle: undefined } }));
    const resolved = resolveDecisions({
      kind: "global",
      updateOnly: true,
      flags: new Set(["set-default"]),
      recordedDefaultAgent: "team-leader",
      leaderFileWritable: true,
    });
    expect(resolved.decisions.setDefault).toBe(false);
    await applySetupPlan(options(scope, { updateOnly: true, decisions: resolved.decisions }));
    const config = JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")) as { default_agent?: string };
    expect(config.default_agent).toBe("team-leader");
  });

  it("gives a project the title of the global roster", async () => {
    const { scope: globalScopeValue, configDir } = await globalScope();
    await applySetupPlan(options(globalScopeValue, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-project-"));
    const projectScope = resolveScope({ kind: "project", projectRoot: root, injectedConfigDir: configDir, env: {} });
    const globalLeader = await inspectLeaderFile(globalScopeValue.resolve(LEADER_REL)!);
    const resolved = resolveDecisions({
      kind: "project",
      updateOnly: false,
      flags: new Set<string>(),
      globalRecordedTitle: globalLeader.title,
      leaderFileWritable: true,
    });
    expect(resolved.decisions.leaderTitle).toBe("Meu Time");
    await applySetupPlan(options(projectScope, { decisions: resolved.decisions }));
    const leader = await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8");
    expect(leader).toContain("description: Meu Time — accountable orchestrator");
    expect(leader).toContain("title=Meu%20Time");
  });

  it("shows the title and the settling flags in the plan", async () => {
    const { scope } = await globalScope();
    const titled = await buildSetupPlan(options(scope, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    expect(renderPlanText(titled)).toContain("leader title: Meu Time");

    const pending = await buildSetupPlan(options(scope, { pending: ["setDefault", "leaderTitle"] }));
    const rendered = renderPlanText(pending);
    expect(rendered).toContain("--set-default | --no-default");
    expect(rendered).toContain('--leader-title "<title>"');
  });

  it("preserves a leader file the user edited", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope));
    const leaderPath = path.join(configDir, "agents", "team-leader.md");
    const edited = (await fs.promises.readFile(leaderPath, "utf8")).replace("You are Team Leader", "You are My Own Agent");
    await fs.promises.writeFile(leaderPath, edited);
    const specialistPath = path.join(configDir, "agents", "team-leader", "coder.md");
    const specialist = (await fs.promises.readFile(specialistPath, "utf8")).replace("You are team-leader/coder", "MY OWN CODER");
    await fs.promises.writeFile(specialistPath, specialist);
    const result = await applySetupPlan(options(scope, { decisions: { setDefault: false, leaderTitle: "Meu Time" } }));
    expect(result.skipped.join()).toContain("team-leader.md");
    expect(result.skipped.join()).toContain("coder.md");
    expect(await fs.promises.readFile(leaderPath, "utf8")).toContain("You are My Own Agent");
    expect(await fs.promises.readFile(specialistPath, "utf8")).toContain("MY OWN CODER");
  });

  it("creates nothing on an update and removes the previous-version roster", async () => {
    const { scope, configDir } = await globalScope();
    await applySetupPlan(options(scope));
    await fs.promises.mkdir(path.join(configDir, "agents", "agent-team"), { recursive: true });
    const legacy = "---\nmode: primary\n---\nold body\n";
    const managed = withHeader(legacy, "1");
    await fs.promises.writeFile(path.join(configDir, "agents", "agent-team.md"), managed);
    await fs.promises.writeFile(path.join(configDir, "agents", "agent-team", "verifier.md"), managed);
    const result = await applySetupPlan(options(scope, { updateOnly: true }));
    expect(result.created).toEqual([]);
    expect(result.removed.join()).toContain("agent-team.md");
    expect(fs.existsSync(path.join(configDir, "agents", "agent-team.md"))).toBe(false);
    // the current roster is still installed
    expect(fs.existsSync(path.join(configDir, "agents", "team-leader.md"))).toBe(true);
  });
});
