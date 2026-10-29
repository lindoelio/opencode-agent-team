import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve("assets", "agents");

function frontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(file, "utf8");
  // Frontmatter must start at byte 0 — a leading managed marker breaks OpenCode discovery.
  expect(text.startsWith("---\n")).toBe(true);
  const end = text.indexOf("\n---", 3);
  expect(end).toBeGreaterThan(0);
  const block = text.slice(4, end);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m && m[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

const SPECIALISTS = [
  "explorer",
  "product",
  "architect",
  "designer",
  "coder",
  "worker",
  "reviewer",
  "security",
  "release",
] as const;

describe("agent asset snapshots", () => {
  it("team-leader is the only primary agent with orchestrator permissions", () => {
    const fm = frontmatter(path.join(ROOT, "team-leader.md"));
    expect(fm["mode"]).toBe("primary");
    expect(fm["model"]).toBeUndefined();
    const body = fs.readFileSync(path.join(ROOT, "team-leader.md"), "utf8");
    expect(body).toContain('resource: "*"');
    expect(body).toContain("effect: allow");
    expect(body).not.toContain("effect: ask");
  });
  it("every specialist is a subagent that may launch built-ins but never team-leader/*", () => {
    for (const name of SPECIALISTS) {
      const fm = frontmatter(path.join(ROOT, "team-leader", `${name}.md`));
      expect(fm["mode"]).toBe("subagent");
      expect(fm["model"]).toBeUndefined();
      const body = fs.readFileSync(path.join(ROOT, "team-leader", `${name}.md`), "utf8");
      expect(body).toContain('resource: "*"');
      expect(body).toContain('resource: "team-leader/*"');
      expect(body).toContain("effect: deny");
      expect(body).not.toContain("effect: ask");
    }
  });
  it("a read-only role cannot spawn a helper that could edit", () => {
    // A role whose contract forbids editing must not be able to launch an
    // agent that can edit: the subagent permission is the escape hatch.
    for (const name of ["explorer", "product", "architect", "reviewer", "security"]) {
      const body = fs.readFileSync(path.join(ROOT, "team-leader", `${name}.md`), "utf8");
      expect(body, `${name} must not be allowed to spawn helpers`).not.toMatch(/action:\s*subagent\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/);
      expect(body).not.toContain("You may launch built-in OpenCode helper agents");
    }
    // a role that writes may still spawn helpers
    const coder = fs.readFileSync(path.join(ROOT, "team-leader", "coder.md"), "utf8");
    expect(coder).toMatch(/action:\s*subagent\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/);
  });
  it("no template grants an edit it also denies", () => {
    // product and architect may edit their own artifacts; the narrow grant
    // must be present alongside the blanket deny.
    for (const [name, allowed] of [
      ["product", ".agent-team/*"],
      ["architect", ".agent-team/decisions/*"],
    ] as const) {
      const body = fs.readFileSync(path.join(ROOT, "team-leader", `${name}.md`), "utf8");
      expect(body, `${name} must grant its own scope`).toContain(`resource: "${allowed}"`);
      expect(body).toContain("effect: allow");
      expect(body).toContain('resource: "*"');
      expect(body).toContain("effect: deny");
    }
  });
  it("the leader does not hardcode an .env read rule", () => {
    // The authority matrix is the single source of truth for what may be
    // read; a template rule would silently defeat guarded mode.
    const body = fs.readFileSync(path.join(ROOT, "team-leader.md"), "utf8");
    expect(body).not.toContain('resource: "*.env*"');
  });
  it("explorer and reviewer stay read-only, worker and coder can execute", () => {
    // These are permission assertions: what the harness enforces.
    const explorer = fs.readFileSync(path.join(ROOT, "team-leader", "explorer.md"), "utf8");
    expect(explorer).toContain('action: edit');
    expect(explorer).toContain('action: shell');
    expect(explorer).toContain("effect: deny");
    const reviewer = fs.readFileSync(path.join(ROOT, "team-leader", "reviewer.md"), "utf8");
    expect(reviewer).toContain('action: edit');
    expect(reviewer).toContain("effect: deny");
  });
  it("the templates say what their role contract says", () => {
    // These are wording assertions, not behaviour: they guard the prose a
    // model reads, so a rewrite cannot silently drop a rule.
    const explorer = fs.readFileSync(path.join(ROOT, "team-leader", "explorer.md"), "utf8");
    expect(explorer).toContain("Do not edit files. Do not run shells.");
    const reviewer = fs.readFileSync(path.join(ROOT, "team-leader", "reviewer.md"), "utf8");
    expect(reviewer).toContain("adversarial");
    expect(reviewer).toContain("Never review your own high-risk implementation");
    const worker = fs.readFileSync(path.join(ROOT, "team-leader", "worker.md"), "utf8");
    expect(worker).toContain("You are not team-leader/coder");
    const coder = fs.readFileSync(path.join(ROOT, "team-leader", "coder.md"), "utf8");
    expect(coder).toContain("Never mark PASS");
  });
  it("every agent declares an explicit skills block", () => {
    const files = [path.join(ROOT, "team-leader.md"), ...SPECIALISTS.map((n) => path.join(ROOT, "team-leader", `${n}.md`))];
    for (const file of files) {
      const body = fs.readFileSync(file, "utf8");
      expect(body).toContain("## Skills");
    }
    // A role with no skill says so, rather than leaving an empty block that
    // reads like an oversight.
    const designer = fs.readFileSync(path.join(ROOT, "team-leader", "designer.md"), "utf8");
    expect(designer).toContain("no separate skill");
  });
  it("templates stay pure (no marker); the marker is added trailing at apply time", () => {
    for (const f of [path.join(ROOT, "team-leader.md"), path.join(ROOT, "team-leader", "explorer.md")]) {
      const text = fs.readFileSync(f, "utf8");
      expect(text).not.toContain("AGENT-TEAM-MANAGED");
      expect(text.startsWith("---\n")).toBe(true);
    }
  });
});
