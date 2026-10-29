import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/runtime.js";
import { initializeState } from "../../src/ledger/store.js";
import { registerToolAuditHooks } from "../../src/hooks/tool-audit.js";
import { executeState } from "../../src/tools/state.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeGate } from "../../src/tools/gate.js";
import { pathAllowed, pathInScope, pathProhibited, scopeOverlaps } from "../../src/domain/scope.js";
import { independentReviewCheck } from "../../src/domain/gates.js";

const OPTS = { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false } as never;
const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

describe("scope matching", () => {
  it("matches a subtree pattern", () => {
    expect(pathInScope("src/board.ts", "src/**")).toBe(true);
    expect(pathInScope("src/deep/nested/x.ts", "src/**")).toBe(true);
    expect(pathInScope("docs/notes.md", "src/**")).toBe(false);
  });

  it("matches an exact path and a named directory", () => {
    expect(pathInScope("src/board.ts", "src/board.ts")).toBe(true);
    expect(pathInScope("docs/notes.md", "docs")).toBe(true);
    expect(pathInScope("docsx/notes.md", "docs")).toBe(false);
  });

  it("treats an empty scope as unconstrained", () => {
    expect(pathAllowed("anything/at/all.ts", [])).toBe(true);
  });

  it("detects a prohibited path", () => {
    expect(pathProhibited("src/secret.ts", ["src/secret.ts"])).toBe(true);
    expect(pathProhibited("src/board.ts", ["src/secret.ts"])).toBe(false);
  });

  it("detects overlapping scopes", () => {
    expect(scopeOverlaps(["src/**"], ["src/a.ts"])).toBe(true);
    expect(scopeOverlaps(["src/**"], ["docs/**"])).toBe(false);
    expect(scopeOverlaps(["src/a.ts"], ["src/a.ts"])).toBe(true);
  });
});

describe("handoff scope is enforced, not advisory", () => {
  async function setup(): Promise<{ root: string; runtime: ReturnType<typeof createRuntime>; before: (e: unknown) => unknown }> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-scope-"));
    const runtime = createRuntime(
      {
        options: {},
        location: { project: { canonical: root } },
        tool: {
          transform: async () => ({ dispose: async () => {} }),
          list: async () => [],
          hook: async (name: string, cb: (e: unknown) => unknown) => {
            if (name === "execute.before") (captured.before = cb);
            return { dispose: async () => {} };
          },
        },
        storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
      } as never,
      OPTS,
    );
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(
      runtime,
      {
        action: "prepare",
        expectedRevision: 0,
        role: "coder",
        objective: "implement the board",
        context: [],
        allowedScope: ["src/**"],
        prohibitedScope: ["src/secret.ts"],
        questions: [],
        requiredEvidence: [],
        stopCondition: "done",
      },
      leader,
    );
    await registerToolAuditHooks(runtime);
    if (!captured.before) throw new Error("the execute.before hook was not registered");
    return { root, runtime, before: captured.before };
  }

  const captured: { before?: (e: unknown) => unknown } = {};

  it("refuses a write outside the handoff's allowed scope", async () => {
    const { root, before } = await setup();
    await expect(before!({ tool: "write", agent: "team-leader/coder", sessionID: "s", input: { path: path.join(root, "docs/notes.md") } })).rejects.toThrow(/outside the allowed scope/);
  });

  it("refuses a write inside the prohibited scope", async () => {
    const { root, before } = await setup();
    await expect(before!({ tool: "write", agent: "team-leader/coder", sessionID: "s", input: { path: path.join(root, "src/secret.ts") } })).rejects.toThrow(/prohibited scope/);
  });

  it("allows a write inside the allowed scope", async () => {
    const { root, before } = await setup();
    await expect(before!({ tool: "write", agent: "team-leader/coder", sessionID: "s", input: { path: path.join(root, "src/board.ts") } })).resolves.toBeUndefined();
  });

  it("does not scope-check the leader", async () => {
    const { root, before } = await setup();
    await expect(before!({ tool: "write", agent: "team-leader", sessionID: "s", input: { path: path.join(root, "docs/notes.md") } })).resolves.toBeUndefined();
  });
});

describe("independent review", () => {
  it("requires a completed reviewer handoff", () => {
    const check = independentReviewCheck([]);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("no completed");
  });

  it("is satisfied by a reviewer handoff when nothing was implemented", () => {
    const check = independentReviewCheck([
      { id: "HND-0001", role: "reviewer", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
    ]);
    expect(check.satisfied).toBe(true);
  });

  it("refuses a reviewer that was not pointed at the implementation", () => {
    const check = independentReviewCheck([
      { id: "HND-0001", role: "coder", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
      { id: "HND-0002", role: "reviewer", objective: "o", context: [], allowedScope: ["docs/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
    ]);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("does not cover the scope");
  });

  it("accepts a reviewer that covers the implementation", () => {
    const check = independentReviewCheck([
      { id: "HND-0001", role: "coder", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
      { id: "HND-0002", role: "reviewer", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: ["HND-0001"], status: "completed" },
    ]);
    expect(check.satisfied).toBe(true);
  });
});
