import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managedHeader, checksumOf, isManaged, planManagedFiles, stripHeader, withHeader, mergeProjectConfig, backupFile } from "../../src/bootstrap/jsonc.js";
import { MANAGED_AGENT_FILES, AGENT_TEAM_METHOD_VERSION, AGENT_TEMPLATE_VERSION } from "../../src/bootstrap/managed-files.js";
import { buildSetupPlan, renderPlanText, fileIsManagedOrMissing, resolveTargetAbs } from "../../src/bootstrap/plan.js";

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
  it("plans create/keep/update/drift states", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-plan-"));
    const templates = new Map([[".opencode/agents/team-leader.md", "---\nmode: primary\n---\nbody\n"]]);
    let files = await planManagedFiles(root, templates, "1");
    expect(files[0]!.action).toBe("create");
    await fs.promises.mkdir(path.join(root, ".opencode", "agents"), { recursive: true });
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1"));
    files = await planManagedFiles(root, templates, "1");
    expect(files[0]!.action).toBe("keep");
    // user content without marker is never touched
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), "USER EDIT");
    files = await planManagedFiles(root, templates, "1");
    expect(files[0]!.action).toBe("keep-drifted");
    // drifted managed content is never overwritten silently
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1").replace("body", "tampered"));
    files = await planManagedFiles(root, templates, "1");
    expect(files[0]!.action).toBe("keep-drifted");
    // newer template triggers managed update
    await fs.promises.writeFile(path.join(root, ".opencode", "agents", "team-leader.md"), withHeader("---\nmode: primary\n---\nbody\n", "1"));
    const v2 = new Map([[".opencode/agents/team-leader.md", "---\nmode: primary\n---\nbody v2\n"]]);
    files = await planManagedFiles(root, v2, "2");
    expect(files[0]!.action).toBe("update-managed");
  });
  it("merges project config safely", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    // empty dir: creates config
    let m = await mergeProjectConfig({ projectRoot: root, setDefault: true, pluginPackage: "pkg@1", pluginOptions: { a: 1 }, includePluginOptions: true });
    expect(m.changed).toBe(true);
    expect(m.after).toContain('"default_agent": "team-leader"');
    await fs.promises.writeFile(m.path, m.after);
    // idempotent second merge
    m = await mergeProjectConfig({ projectRoot: root, setDefault: true, pluginPackage: "pkg@1", pluginOptions: { a: 1 }, includePluginOptions: true });
    expect(m.changed).toBe(false);
    // preserves comments and appends second plugin
    await fs.promises.writeFile(m.path, `{\n  // user comment\n  "default_agent": "build"\n}\n`);
    m = await mergeProjectConfig({ projectRoot: root, setDefault: false, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: true });
    expect(m.after).toContain("// user comment");
    expect(m.after).toContain("pkg@1");
    // divergent plugins array: appends without duplicating
    await fs.promises.writeFile(m.path, `{\n  "plugins": ["other-pkg", { "package": "pkg@1", "options": {} }]\n}\n`);
    m = await mergeProjectConfig({ projectRoot: root, setDefault: false, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: true });
    expect(m.changed).toBe(false);
    await fs.promises.writeFile(m.path, `{\n  "plugins": ["other-pkg"]\n}\n`);
    m = await mergeProjectConfig({ projectRoot: root, setDefault: false, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: true });
    expect(m.changed).toBe(true);
    expect(m.after).toContain("other-pkg");
    expect(m.after).toContain("pkg@1");
    // parse errors fail closed
    await fs.promises.writeFile(m.path, "{ invalid jsonc !!!");
    await expect(mergeProjectConfig({ projectRoot: root, setDefault: true, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false })).rejects.toThrow();
  });
  it("updates the plugin entry in place instead of duplicating it", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-jsonc-"));
    const opts = { projectRoot: root, setDefault: false, pluginPackage: "@lindoelio/opencode-agent-team@0.3.0", pluginOptions: { a: 1 }, includePluginOptions: true };
    // a previous version is already installed: the entry is updated, not duplicated
    await fs.promises.writeFile(path.join(root, "opencode.jsonc"), `{\n  "plugins": [{ "package": "@lindoelio/opencode-agent-team@0.2.0", "options": { "autonomy": { "askBefore": ["deploy"] } } }]\n}\n`);
    let m = await mergeProjectConfig(opts);
    expect(m.changed).toBe(true);
    let entries = (JSON.parse(m.after) as { plugins: Array<{ package: string; options: Record<string, unknown> }> }).plugins;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.package).toBe("@lindoelio/opencode-agent-team@0.3.0");
    // the user's own options are preserved
    expect(entries[0]!.options).toEqual({ autonomy: { askBefore: ["deploy"] } });
    // a local checkout path is preserved: no second entry, no unreachable spec
    await fs.promises.writeFile(path.join(root, "opencode.jsonc"), `{\n  "plugins": ["/Users/x/Projects/opencode-agent-team"]\n}\n`);
    m = await mergeProjectConfig(opts);
    let local = (JSON.parse(m.after) as { plugins: string[] }).plugins;
    expect(local).toHaveLength(1);
    expect(local[0]).toBe("/Users/x/Projects/opencode-agent-team");
    // a bare string spec for the same package is upgraded in place
    await fs.promises.writeFile(path.join(root, "opencode.jsonc"), `{\n  "plugins": ["@lindoelio/opencode-agent-team"]\n}\n`);
    m = await mergeProjectConfig(opts);
    let bare = (JSON.parse(m.after) as { plugins: string[] }).plugins;
    expect(bare).toHaveLength(1);
    expect(bare[0]).toBe("@lindoelio/opencode-agent-team@0.3.0");
  });
  it("backs up files with timestamp", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-backup-"));
    const target = path.join(root, "opencode.jsonc");
    await fs.promises.writeFile(target, "{}");
    const dest = await backupFile(root, target);
    expect(dest).toContain(".agent-team/setup-backups/");
    expect(await fs.promises.readFile(dest, "utf8")).toBe("{}");
    const missing = await backupFile(root, path.join(root, "nope.json"));
    expect(missing).toContain(".missing");
  });
  it("builds setup plans for project and global scopes", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-setupplan-"));
    const plan = await buildSetupPlan({ scope: "project", setDefault: true, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false });
    expect(plan.root).toBe(root);
    expect(plan.files.length).toBeGreaterThan(5);
    expect(renderPlanText(plan)).toContain("Agent Team setup plan");
    const global = await buildSetupPlan({ scope: "global", setDefault: false, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false, homeDir: root });
    expect(global.warnings.join()).toContain("global");
    expect(renderPlanText(global)).toContain("warning:");
    // unreadable config degrades to a warning instead of throwing
    await fs.promises.writeFile(path.join(root, "opencode.jsonc"), "{ broken !!!");
    const broken = await buildSetupPlan({ scope: "project", setDefault: true, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false });
    expect(broken.warnings.join()).toContain("config merge unavailable");
    expect(resolveTargetAbs(root, ".opencode/agents/team-leader.md", "global")).toContain(path.join(".config", "opencode"));
    expect(resolveTargetAbs(root, ".opencode/agents/team-leader.md", "project")).toBe(path.join(root, ".opencode/agents/team-leader.md"));
    expect(await fileIsManagedOrMissing(path.join(root, "missing.md"))).toBe(true);
  });
  it("installs agent templates without pinning any model", async () => {
    const { buildSetupPlan } = await import("../../src/bootstrap/plan.js");
    const { applySetupPlan } = await import("../../src/bootstrap/apply.js");
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-nopins-"));
    const plan = await buildSetupPlan({ scope: "project", setDefault: false, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false });
    expect(plan.warnings.join()).not.toContain("model remap");
    const applied = await applySetupPlan({ scope: "project", setDefault: false, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false });
    expect(applied.created.join()).toContain(".opencode/agents/team-leader.md");
    const agent = await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8");
    expect(agent).not.toContain("model:");
    expect(agent.startsWith("---\n")).toBe(true);
    // second plan reuses the installed template and reports keep
    const again = await buildSetupPlan({ scope: "project", setDefault: false, updateOnly: false, projectRoot: root, pluginPackage: "pkg@1", pluginOptions: {}, includePluginOptions: false });
    expect(again.files.find((f) => f.path === ".opencode/agents/team-leader.md")?.action).toBe("keep");
  });
});
