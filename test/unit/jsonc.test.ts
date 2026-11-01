import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managedHeader, checksumOf, isManaged, planManagedFiles, planStaleManagedFiles, stripHeader, withHeader, mergeConfig, backupFile } from "../../src/bootstrap/jsonc.js";
import { MANAGED_AGENT_FILES, AGENT_TEAM_METHOD_VERSION, AGENT_TEMPLATE_VERSION } from "../../src/bootstrap/managed-files.js";
import { buildSetupPlan, renderPlanText, type SetupOptions } from "../../src/bootstrap/plan.js";
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
    pluginPackage: "pkg@1",
    pluginOptions: {},
    includePluginOptions: false,
    ...extra,
  };
}

describe("bootstrap jsonc", () => {
  it("round-trips managed headers (trailing, frontmatter-safe)", () => {
    const body = "---\nmode: primary\n---\nhello\n";
    const stamped = withHeader(body, "1");
    expect(stamped.startsWith("---\n")).toBe(true);
    expect(stamped).toContain("AGENT-TEAM-MANAGED");
    const meta = isManaged(stamped);
    expect(meta?.version).toBe("1");
    expect(meta?.checksum).toBe(checksumOf(body));
    expect(stripHeader(stamped)).toBe(body);
    expect(isManaged("plain content")).toBeNull();
    expect(managedHeader("1", "abc")).toContain("abc");
    expect(MANAGED_AGENT_FILES.length).toBe(11);
    expect(AGENT_TEAM_METHOD_VERSION).toBe("1");
    expect(AGENT_TEMPLATE_VERSION).toBe("1");
  });
  it("plans create/keep/update/drift states", async () => {    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-plan-"));
    const scope = scopeFor(root);
    const templates = new Map([[".opencode/agents/team-leader.md", "---\nmode: primary\n---\nbody\n"]]);
    let files = await planManagedFiles(scope, templates, "1");
    expect(files[0]!.action).toBe("create");
    await fs.promises.mkdir(path.join(root, ".opencode", "agents"), { recursive: true });
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1"));
    files = await planManagedFiles(scope, templates, "1");
    expect(files[0]!.action).toBe("keep");
    // user content without marker is never touched
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), "USER EDIT");
    files = await planManagedFiles(scope, templates, "1");
    expect(files[0]!.action).toBe("keep-drifted");
    // drifted managed content is never overwritten silently
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1").replace("body", "tampered"));
    files = await planManagedFiles(scope, templates, "1");
    expect(files[0]!.action).toBe("keep-drifted");
    // newer template triggers managed update
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1"));
    const v2 = new Map([[".opencode/agents/team-leader.md", "---\nmode: primary\n---\nbody v2\n"]]);
    files = await planManagedFiles(scope, v2, "2");
    expect(files[0]!.action).toBe("update-managed");
    // a corrupted checksum over an intact body is a repair, not a drift
    await fs.promises.writeFile(
      path.join(root, ".opencode", "agents", "team-leader.md"),
      withHeader("---\nmode: primary\n---\nbody\n", "1").replace(/checksum=[0-9a-f]+/, "checksum=0000000000000000"),
    );
    files = await planManagedFiles(scope, templates, "1");
    expect(files[0]!.action).toBe("update-managed");
    expect(files[0]!.reason).toContain("repair header");
  });
  it("skips a previous-version candidate the scope does not hold", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-plan-"));
    const global = resolveScope({ kind: "global", projectRoot: root, injectedConfigDir: path.join(root, "global-config"), env: {} });
    const stale = await planStaleManagedFiles(global, [".agent-team/README.md", ".opencode/agents/agent-team.md"]);
    expect(stale).toEqual([]);
  });

  it("merges project config safely", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const configFile = path.join(root, "opencode.jsonc");
    const merge = (over: Partial<Parameters<typeof mergeConfig>[0]> = {}) =>
      mergeConfig({ configFile, setDefault: true, pluginPackage: "pkg@1", pluginOptions: { a: 1 }, includePluginOptions: true, repin: true, ...over });
    // empty dir: creates config
    let m = await merge();
    expect(m.changed).toBe(true);
    expect(m.after).toContain('"default_agent": "team-leader"');
    await fs.promises.writeFile(m.path, m.after);
    // idempotent second merge
    m = await merge();
    expect(m.changed).toBe(false);
    // preserves comments and appends second plugin
    await fs.promises.writeFile(m.path, `{\n  // user comment\n  "default_agent": "build"\n}\n`);
    m = await merge({ setDefault: false });
    expect(m.after).toContain("// user comment");
    expect(m.after).toContain("pkg@1");
    // divergent plugins array: appends without duplicating
    await fs.promises.writeFile(m.path, `{\n  "plugins": ["other-pkg", { "package": "pkg@1", "options": {} }]\n}\n`);
    m = await merge({ setDefault: false });
    expect(m.changed).toBe(false);
    await fs.promises.writeFile(m.path, `{\n  "plugins": ["other-pkg"]\n}\n`);
    m = await merge({ setDefault: false });
    expect(m.changed).toBe(true);
    expect(m.after).toContain("other-pkg");
    expect(m.after).toContain("pkg@1");
    // parse errors fail closed
    await fs.promises.writeFile(m.path, "{ invalid jsonc !!!");
    await expect(merge({ includePluginOptions: false })).rejects.toThrow();
  });
  it("updates the plugin entry in place instead of duplicating it", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const configFile = path.join(root, "opencode.jsonc");
    const opts = { configFile, setDefault: false, pluginPackage: "@lindoelio/opencode-agent-team@0.3.0", pluginOptions: { a: 1 }, includePluginOptions: true, repin: true };
    // a previous version is already installed: the entry is updated, not duplicated
    await fs.promises.writeFile(configFile, `{\n  "plugins": [{ "package": "@lindoelio/opencode-agent-team@0.2.0", "options": { "autonomy": { "askBefore": ["deploy"] } } }]\n}\n`);
    let m = await mergeConfig(opts);
    expect(m.changed).toBe(true);
    let entries = (JSON.parse(m.after) as { plugins: Array<{ package: string; options: Record<string, unknown> }> }).plugins;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.package).toBe("@lindoelio/opencode-agent-team@0.3.0");
    // the user's own options are preserved
    expect(entries[0]!.options).toEqual({ autonomy: { askBefore: ["deploy"] } });
    // a local checkout path is preserved: no second entry, no unreachable spec
    await fs.promises.writeFile(configFile, `{\n  "plugins": ["/Users/x/Projects/opencode-agent-team"]\n}\n`);
    m = await mergeConfig(opts);
    let local = (JSON.parse(m.after) as { plugins: string[] }).plugins;
    expect(local).toHaveLength(1);
    expect(local[0]).toBe("/Users/x/Projects/opencode-agent-team");
    // a bare string spec for the same package is upgraded in place
    await fs.promises.writeFile(configFile, `{\n  "plugins": ["@lindoelio/opencode-agent-team"]\n}\n`);
    m = await mergeConfig(opts);
    let bare = (JSON.parse(m.after) as { plugins: string[] }).plugins;
    expect(bare).toHaveLength(1);
    expect(bare[0]).toBe("@lindoelio/opencode-agent-team@0.3.0");
  });
  it("leaves an existing plugin entry unpinned in the global scope", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const configFile = path.join(root, "opencode.jsonc");
    const opts = { configFile, setDefault: false, pluginPackage: "@lindoelio/opencode-agent-team@0.3.0", pluginOptions: {}, includePluginOptions: true, repin: false };
    // an unpinned entry keeps tracking releases
    await fs.promises.writeFile(configFile, `{\n  "plugins": ["@lindoelio/opencode-agent-team"]\n}\n`);
    let m = await mergeConfig(opts);
    expect(m.changed).toBe(false);
    expect((JSON.parse(m.after) as { plugins: string[] }).plugins[0]).toBe("@lindoelio/opencode-agent-team");
    // a new entry in the global scope carries no version
    await fs.promises.writeFile(configFile, "{\n}\n");
    m = await mergeConfig(opts);
    expect((JSON.parse(m.after) as { plugins: Array<{ package: string }> }).plugins[0]!.package).toBe("@lindoelio/opencode-agent-team");
  });
  it("counts the deprecated plugin key as an existing record", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const configFile = path.join(root, "opencode.jsonc");
    const opts = { configFile, setDefault: false, pluginPackage: "@lindoelio/opencode-agent-team@0.3.0", pluginOptions: {}, includePluginOptions: true, repin: false };
    await fs.promises.writeFile(configFile, `{\n  "plugin": "@lindoelio/opencode-agent-team"\n}\n`);
    let m = await mergeConfig(opts);
    expect(m.changed).toBe(false);
    await fs.promises.writeFile(configFile, `{\n  "plugin": ["@lindoelio/opencode-agent-team"]\n}\n`);
    m = await mergeConfig(opts);
    expect(m.changed).toBe(false);
    // another package under the deprecated key does not count
    await fs.promises.writeFile(configFile, `{\n  "plugin": ["other-pkg"]\n}\n`);
    m = await mergeConfig(opts);
    expect(m.changed).toBe(true);
    expect((JSON.parse(m.after) as { plugins: Array<{ package: string }> }).plugins[0]!.package).toBe("@lindoelio/opencode-agent-team");
  });
  it("drops the comments inside the key it rewrites and keeps the others", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const configFile = path.join(root, "opencode.jsonc");
    await fs.promises.writeFile(configFile, `{\n  // top level comment\n  "plugins": [\n    // inner comment\n    "other-pkg"\n  ]\n}\n`);
    const merged = await mergeConfig({ configFile, setDefault: false, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: true, repin: true });
    expect(merged.after).toContain("// top level comment");
    expect(merged.after).not.toContain("// inner comment");
    expect(merged.after).toContain("other-pkg");
    expect(merged.after).toContain("pkg@1");
  });

  it("backs up files with timestamp", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-backup-"));
    const backupDir = path.join(root, ".agent-team", "setup-backups");
    const target = path.join(root, "opencode.jsonc");
    await fs.promises.writeFile(target, "{}");
    const dest = await backupFile(backupDir, target);
    expect(dest).toContain(".agent-team/setup-backups/");
    expect(await fs.promises.readFile(dest, "utf8")).toBe("{}");
    const missing = await backupFile(backupDir, path.join(root, "nope.json"));
    expect(missing).toContain(".missing");
  });
  it("builds setup plans for project and global scopes", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setupplan-"));
    const scope = scopeFor(root);
    const plan = await buildSetupPlan(optionsFor(scope));
    expect(plan.configDir).toBe(path.join(root, ".opencode"));
    expect(plan.files.length).toBeGreaterThan(5);
    expect(renderPlanText(plan)).toContain("Agent Team setup plan");
    const globalScope = scopeFor(root, "global");
    const global = await buildSetupPlan(optionsFor(globalScope));
    expect(renderPlanText(global)).toContain(path.join("global-config", "agents", "team-leader.md"));
    // the global scope writes no ledger readme
    expect(global.files.some((f) => f.path === ".agent-team/README.md")).toBe(false);
    // an unreadable configuration file stops the plan
    await fs.promises.writeFile(path.join(root, "opencode.jsonc"), "{ broken !!!");
    await expect(buildSetupPlan(optionsFor(scope))).rejects.toThrow();
  });
  it("installs agent templates without pinning any model", async () => {
    const { applySetupPlan } = await import("../../src/bootstrap/apply.js");
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-nopins-"));
    const scope = scopeFor(root);
    const plan = await buildSetupPlan(optionsFor(scope));
    expect(plan.warnings.join()).not.toContain("model remap");
    const applied = await applySetupPlan(optionsFor(scope));
    expect(applied.created.join()).toContain(".opencode/agents/team-leader.md");
    const agent = await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8");
    expect(agent).not.toContain("model:");
    expect(agent.startsWith("---\n")).toBe(true);
    // second plan reuses the installed template and reports keep
    const again = await buildSetupPlan(optionsFor(scope));
    expect(again.files.find((f) => f.path === ".opencode/agents/team-leader.md")?.action).toBe("keep");
  });
});
