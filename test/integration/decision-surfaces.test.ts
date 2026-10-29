import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetDecisionModelCatalogForTests } from "../../src/decision/catalog.js";
import { runDoctor } from "../../src/doctor/checks.js";
import { registerContextHook } from "../../src/hooks/context.js";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";

interface Captured {
  sessionHooks: Record<string, Array<(e: never) => unknown>>;
}

function mockCtx(root: string, cap: Captured, decisionModels: unknown[], surface = true): never {
  const sessionHook = async (name: string, cb: (e: never) => unknown) => {
    (cap.sessionHooks[name] ??= []).push(cb);
    return { dispose: async () => {} };
  };
  return {
    options: {},
    app: { version: "2.2.0" },
    location: { project: { canonical: root } },
    session: { hook: sessionHook, synthetic: async () => {}, prompt: async () => {} },
    tool: { transform: async () => ({ dispose: async () => {} }), list: async () => [], hook: async () => ({ dispose: async () => {} }) },
    model: { list: async () => decisionModels, reload: async () => {} },
    agent: { list: async () => [{ id: "team-leader" }] },
    experimental: { generate: surface ? { decisions: async () => ({ answers: [] }) } : {} },
    storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
  } as never;
}

const DECISION_MODEL = {
  id: "jev",
  modelID: "jev",
  providerID: "openrouter",
  name: "Jev",
  type: "decision",
  enabled: true,
  status: "active",
  cost: [{ input: 0.042, output: 0 }],
  limit: { context: 262144 },
};

async function fresh(decisionModels: unknown[], surface = true): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-surfaces-"));
  _resetDecisionModelCatalogForTests();
  const cap: Captured = { sessionHooks: {} };
  const runtime = createRuntime(mockCtx(root, cap, decisionModels, surface), {
    profile: "public",
    strictEvidence: true,
    projectState: ".agent-team",
    telemetry: false,
    autonomy: { mode: "yolo", askBefore: [] },
    orchestration: { maxParallelSpecialists: 6 },
  } as never);
  return { runtime, root };
}

describe("the decision transparency surfaces", () => {
  it("reports the decision models in the doctor, without failing the preflight", async () => {
    const { runtime } = await fresh([DECISION_MODEL, { id: "chat", modelID: "chat", providerID: "openrouter", name: "Chat", type: "chat" }]);
    const report = await runDoctor(runtime);
    const line = report.checks.find((c) => c.name === "Decision models");
    expect(line).toBeTruthy();
    expect(line!.status).toBe("PASS");
    expect(line!.detail).toContain("1 decision model(s) available");
    expect(line!.detail).toContain("openrouter/jev");
  });

  it("reports the capability as unavailable without changing the verdict", async () => {
    const { runtime } = await fresh([], false);
    const report = await runDoctor(runtime);
    const line = report.checks.find((c) => c.name === "Decision models");
    expect(line!.status).toBe("PASS");
    expect(line!.detail).toContain("no decision surface");
    // The decision check is informational: it never degrades the preflight.
    const decisionChecks = report.checks.filter((c) => c.name === "Decision models");
    expect(decisionChecks.every((c) => c.status === "PASS")).toBe(true);
  });

  it("injects the decision block into the session context of a team role", async () => {
    const { runtime } = await fresh([DECISION_MODEL]);
    const cap: Captured = { sessionHooks: {} };
    const hooked = createRuntime(mockCtx((runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical, cap, [DECISION_MODEL]), runtime.options);
    const reg = await registerContextHook(hooked);
    const cbs = cap.sessionHooks["context"]!;
    const leader = { agent: "team-leader", system: [] as unknown[], options: {}, tools: {} } as never;
    await cbs[0]!(leader);
    const text = (leader as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    expect(text).toContain("Decision models:");
    expect(text).toContain("openrouter/jev");
    expect(text).toContain("Thresholds in force:");
    expect(text).toContain("never approves a criterion");
    await reg.dispose();
  });

  it("gives the reviewer a stricter threshold than the leader in the context block", async () => {
    const { runtime } = await fresh([DECISION_MODEL]);
    const root = (runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical;
    const cap: Captured = { sessionHooks: {} };
    const hooked = createRuntime(mockCtx(root, cap, [DECISION_MODEL]), runtime.options);
    const reg = await registerContextHook(hooked);
    const cbs = cap.sessionHooks["context"]!;
    const leader = { agent: "team-leader", system: [] as unknown[], options: {}, tools: {} } as never;
    const reviewer = { agent: "team-leader/reviewer", system: [] as unknown[], options: {}, tools: {} } as never;
    await cbs[0]!(leader);
    await cbs[0]!(reviewer);
    const leaderText = (leader as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    const reviewerText = (reviewer as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    expect(leaderText).toContain("probability >= 0.85");
    expect(reviewerText).toContain("probability >= 0.9");
    await reg.dispose();
  });

  it("leaves a machine with no decision model exactly as it was", async () => {
    const { runtime } = await fresh([]);
    const cap: Captured = { sessionHooks: {} };
    const root = (runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical;
    const hooked = createRuntime(mockCtx(root, cap, []), runtime.options);
    const reg = await registerContextHook(hooked);
    const cbs = cap.sessionHooks["context"]!;
    const leader = { agent: "team-leader", system: [] as unknown[], options: {}, tools: {} } as never;
    await cbs[0]!(leader);
    const text = (leader as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    expect(text).toContain("0 available");
    expect(text).toContain("never approves a criterion");
    await reg.dispose();
  });
});
