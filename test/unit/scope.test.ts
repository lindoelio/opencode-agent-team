import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globalConfigDir, resolveScope } from "../../src/bootstrap/scope.js";

describe("the scope", () => {
  it("resolves the project scope into the project's own directories", () => {
    const scope = resolveScope({ kind: "project", projectRoot: "/tmp/proj", env: {} });
    expect(scope.agentsDir).toBe(path.join("/tmp/proj", ".opencode", "agents"));
    expect(scope.configFile).toBe(path.join("/tmp/proj", "opencode.jsonc"));
    expect(scope.backupDir).toBe(path.join("/tmp/proj", ".agent-team", "setup-backups"));
    expect(scope.resolve(".opencode/agents/team-leader.md")).toBe(path.join("/tmp/proj", ".opencode", "agents", "team-leader.md"));
    expect(scope.resolve(".agent-team/README.md")).toBe(path.join("/tmp/proj", ".agent-team", "README.md"));
    expect(scope.resolve("src/index.ts")).toBeNull();
  });

  it("prefers an injected configuration directory over the host's convention", () => {
    const scope = resolveScope({
      kind: "global",
      projectRoot: "/tmp/proj",
      injectedConfigDir: "/tmp/injected",
      env: { XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" },
    });
    expect(scope.configDir).toBe("/tmp/injected");
    expect(scope.globalConfigDir).toBe("/tmp/injected");
    expect(scope.agentsDir).toBe(path.join("/tmp/injected", "agents"));
    expect(scope.backupDir).toBe(path.join("/tmp/injected", ".agent-team", "setup-backups"));
  });

  it("follows the configuration home variable when nothing is injected", () => {
    const scope = resolveScope({ kind: "global", projectRoot: "/tmp/proj", env: { XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" } });
    expect(scope.configDir).toBe(path.join("/tmp/xdg", "opencode"));
    expect(scope.globalConfigDir).toBe(path.join("/tmp/xdg", "opencode"));
    expect(scope.resolve(".opencode/agents/team-leader.md")).toBe(path.join("/tmp/xdg", "opencode", "agents", "team-leader.md"));
  });

  it("falls back to the home directory's own configuration directory", () => {
    const scope = resolveScope({ kind: "global", projectRoot: "/tmp/proj", env: { HOME: "/tmp/home" } });
    expect(scope.configDir).toBe(path.join("/tmp/home", ".config", "opencode"));
    expect(globalConfigDir({ HOME: "/tmp/home" })).toBe(path.join("/tmp/home", ".config", "opencode"));
  });

  it("writes no ledger readme in the global scope", () => {
    const scope = resolveScope({ kind: "global", projectRoot: "/tmp/proj", injectedConfigDir: "/tmp/injected", env: {} });
    expect(scope.resolve(".agent-team/README.md")).toBeNull();
  });

  it("writes the JSON-with-comments file when both names exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-scope-"));
    fs.writeFileSync(path.join(dir, "opencode.json"), "{}");
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
    const scope = resolveScope({ kind: "global", projectRoot: dir, injectedConfigDir: dir, env: {} });
    expect(scope.configFile).toBe(path.join(dir, "opencode.jsonc"));
  });

  it("creates the JSON file when the directory holds neither name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-scope-"));
    const scope = resolveScope({ kind: "global", projectRoot: dir, injectedConfigDir: dir, env: {} });
    expect(scope.configFile).toBe(path.join(dir, "opencode.json"));
  });
});
