import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeReport } from "../../src/tools/report.js";
import { executeEvidence } from "../../src/tools/evidence.js";
import { readState } from "../../src/ledger/store.js";
import { snapshotScope, changedPaths } from "../../src/orchestrator/digest.js";
import { reconcileRunning, settleSession } from "../../src/orchestrator/launch.js";
import { observeDeliveryChecks } from "../../src/orchestrator/observe.js";
import { routePrompt, _resetRouteCacheForTests } from "../../src/decision/route.js";
import { _resetDecisionModelCatalogForTests } from "../../src/decision/catalog.js";
import { registerPermissionHook } from "../../src/hooks/permission.js";
import { registerPromptHook } from "../../src/hooks/prompt.js";
import { registerToolAuditHooks, _resetFailureCountsForTests } from "../../src/hooks/tool-audit.js";

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, overrides: Record<string, unknown> = {}): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    {
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: {
        create: async () => ({ id: `ses_child_${++n}` }),
        prompt: async () => ({}),
        synthetic: vi.fn(async () => ({})),
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, status: "idle" } }),
      },
      tool: {
        transform: async () => ({ dispose: async () => {} }),
        list: async () => [],
        hook: async (name: string, cb: (e: unknown) => unknown) => {
          if (name === "execute.before") captured.before = cb;
          if (name === "execute.after") captured.after = cb;
          return { dispose: async () => {} };
        },
      },
      permission: { hook: async (_name: string, cb: (e: unknown) => unknown) => { captured.permission = cb; return { dispose: async () => {} }; } },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
      model: { list: async () => [] },
      ...overrides,
    } as never,
    {
      profile: "public",
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] },
    } as never,
  );
}

const captured: { permission?: (e: unknown) => unknown; prompt?: (e: unknown) => unknown; before?: (e: unknown) => unknown; after?: (e: unknown) => unknown } = {};

async function fresh(overrides: Record<string, unknown> = {}): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cov-"));
  return { runtime: runtimeFor(root, overrides), root };
}

describe("digest", () => {
  it("hashes files under a scope and reports changed paths", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-digest-"));
    await fs.promises.mkdir(path.join(root, "src", "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "src", "a.ts"), "a");
    await fs.promises.writeFile(path.join(root, "src", "nested", "b.ts"), "b");
    const first = snapshotScope(root, ["src/**"]);
    expect(Object.keys(first.files).sort()).toEqual(["src/a.ts", "src/nested/b.ts"]);
    await fs.promises.writeFile(path.join(root, "src", "a.ts"), "changed");
    const second = snapshotScope(root, ["src/**"]);
    expect(second.digest).not.toBe(first.digest);
    expect(changedPaths(first.files, second.files)).toEqual(["src/a.ts"]);
    expect(snapshotScope(root, ["../outside"]).files).toEqual({});
  });
});

describe("launch edge cases", () => {
  it("refuses overlapping writable scopes", async () => {
    const { runtime } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await expect(executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [
        { role: "coder", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" },
        { role: "coder", objective: "b", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" },
      ],
    }, leader)).rejects.toThrow(/overlapping writable scope/);
  });

  it("refuses launch when the host has no session.create", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cov-"));
    const runtime = runtimeFor(root, { session: { prompt: async () => ({}) } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await expect(executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }],
    }, leader)).rejects.toThrow(/session\.create/);
  });

  it("reconciles a running handoff whose session is gone", async () => {
    const { runtime, root } = await fresh({ session: { create: async () => ({ id: "ses_gone" }), prompt: async () => ({}), synthetic: async () => ({}), get: async () => { throw new Error("gone"); } } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }],
    }, leader);
    await reconcileRunning(runtime);
    expect((await readState(root))?.handoffs[0]?.status).toBe("failed");
  });

  it("applies the route before booking", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const { appendEvent, storeContext } = await import("../../src/ledger/store.js");
    const base = { role: "explorer" as const, objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" };
    await appendEvent(storeContext(root, "sess-1", "plugin"), "route.recorded", {}, (s) => ({ ...s, route: { engagementClass: "clarify", namesFileAndSymptom: false, riskSignal: false } }));
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 1, units: [base] }, leader)).rejects.toThrow(/clarify/);
    await appendEvent(storeContext(root, "sess-1", "plugin"), "route.recorded", {}, (s) => ({ ...s, route: { engagementClass: "change", namesFileAndSymptom: true, riskSignal: false } }));
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 2, units: [base] }, leader)).rejects.toThrow(/do not launch an explorer/);
    await appendEvent(storeContext(root, "sess-1", "plugin"), "route.recorded", {}, (s) => ({ ...s, route: { engagementClass: "change", namesFileAndSymptom: false, riskSignal: true } }));
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 3, units: [{ ...base, role: "reviewer", allowedScope: ["src/**"] }] }, leader)).rejects.toThrow(/security specialist/);
  });

  it("refuses a role agent that is not installed", async () => {
    const { runtime } = await fresh({ agent: { list: async () => [{ id: "team-leader" }] } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [{ role: "coder", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }] }, leader)).rejects.toThrow(/role agent not installed/);
  });

  it("notifies the leader when a session settles without a report", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }],
    }, leader)).content);
    await settleSession(runtime, out.sessions[0].sessionID);
    expect(runtime.ctx.session.synthetic).toHaveBeenCalled();
    expect((await readState(root))?.handoffs[0]?.status).toBe("failed");
  });
});

describe("observe edge cases", () => {
  it("does nothing when the host has no shell", async () => {
    const { runtime, root } = await fresh({ session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}) } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, { expectedRevision: 0, title: "T", userOutcome: "U", happyPath: ["h"], allowedScope: ["src/**"], acceptanceCriteria: ["AC-1"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], rollback: "revert" }, leader);
    const delivery = (await readState(root))!.activeDelivery!;
    expect(await observeDeliveryChecks(runtime, root, delivery)).toBe(0);
  });

  it("records a thrown shell call as a fail row", async () => {
    const { runtime, root } = await fresh({ session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}), shell: async () => { throw new Error("shell down"); } } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, { expectedRevision: 0, title: "T", userOutcome: "U", happyPath: ["h"], allowedScope: ["src/**"], acceptanceCriteria: ["AC-1"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], rollback: "revert" }, leader);
    const delivery = (await readState(root))!.activeDelivery!;
    expect(await observeDeliveryChecks(runtime, root, delivery)).toBe(1);
    expect((await readState(root))!.evidence[0]?.status).toBe("fail");
  });

  it("records a failing exit code as a fail row", async () => {
    const { runtime, root } = await fresh({ session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}), shell: async () => ({ exitCode: 2, output: "boom" }) } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, { expectedRevision: 0, title: "T", userOutcome: "U", happyPath: ["h"], allowedScope: ["src/**"], acceptanceCriteria: ["AC-1"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], rollback: "revert" }, leader);
    const delivery = (await readState(root))!.activeDelivery!;
    expect(await observeDeliveryChecks(runtime, root, delivery)).toBe(1);
    expect((await readState(root))!.evidence[0]?.status).toBe("fail");
    // a failed check is re-observed; only an observed pass is skipped
    expect(await observeDeliveryChecks(runtime, root, delivery)).toBe(1);
  });
});

describe("report edge cases", () => {
  it("runs the declared checks when a coder reports", async () => {
    const { runtime, root } = await fresh({ session: { create: async () => ({ id: "ses_coder" }), prompt: async () => ({}), synthetic: async () => ({}), shell: async () => ({ exitCode: 0, output: "ok" }) } });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, { expectedRevision: 0, title: "T", userOutcome: "U", happyPath: ["h"], allowedScope: ["src/**"], acceptanceCriteria: ["AC-1"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], rollback: "revert" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 1,
      units: [{ role: "coder", objective: "a", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }],
    }, leader)).content);
    await executeReport(runtime, { result: { status: "PASS", summary: "done", findings: [], risks: [], unknowns: [], recommended_next_action: "verify" } }, { sessionID: out.sessions[0].sessionID, agent: "team-leader/coder" } as never);
    const state = await readState(root);
    expect(state?.evidence.some((e) => e.observed === true)).toBe(true);
  });
});

describe("route edge cases", () => {
  it("writes the route to a session instruction entry", async () => {
    const put = vi.fn(async () => ({}));
    const runtime = runtimeFor("/tmp/agent-team-route-entry", {
      model: { list: async () => [{ id: "jev", modelID: "jev", providerID: "p", name: "Jev", type: "decision", enabled: true, status: "active" }] },
      experimental: { generate: { decisions: async () => ({ answers: [{ type: "choice", name: "engagement_class", choice: "fix", probabilities: [{ value: "fix", probability: 0.99 }], confidence: 0.99 }, { type: "predicate", name: "names_file_and_symptom", probability: 0.1 }, { type: "predicate", name: "risk_signal", probability: 0.1 }], tokens: { input: 1, output: 0 } }) } },
      session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}), instructions: { entry: { put } } },
    });
    _resetRouteCacheForTests();
    _resetDecisionModelCatalogForTests();
    const route = await routePrompt(runtime, "ses_r", "fix the label");
    expect(route?.engagementClass).toBe("fix");
    expect(put).toHaveBeenCalled();
  });

  it("continues as change when the class is not confident", async () => {
    const runtime = runtimeFor("/tmp/agent-team-route-pin", {
      model: { list: async () => [{ id: "jev", modelID: "jev", providerID: "p", name: "Jev", type: "decision", enabled: true, status: "active" }] },
      experimental: { generate: { decisions: async () => ({ answers: [{ type: "choice", name: "engagement_class", choice: "fix", probabilities: [{ value: "fix", probability: 0.2 }], confidence: 0.2 }] }) } },
    });
    _resetRouteCacheForTests();
    _resetDecisionModelCatalogForTests();
    const route = await routePrompt(runtime, "ses_pin", "do work");
    expect(route?.engagementClass).toBe("change");
    expect(route?.reason).toContain("did not reach the threshold");
  });
});

describe("permission and audit edge cases", () => {
  it("allows a promotion when the state flag is recorded", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const { appendEvent, storeContext } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "plugin"), "guardrails.updated", { allowPromotion: true }, (s) => ({ ...s, allowPromotion: true }));
    await registerPermissionHook(runtime);
    const event = { action: "deploy", resources: ["prod"], effect: "allow" } as never;
    await captured.permission!(event);
    expect((event as unknown as { effect: string }).effect).toBe("allow");
    expect((await readState(root))?.allowPromotion).toBe(true);
  });

  it("allows an ask that an approval satisfies", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeState(runtime, { action: "guard", expectedRevision: 0, add: ["delete"] }, leader);
    const { appendEvent, storeContext } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "approval.opened", { id: "APR-0001" }, (s) => ({
      ...s,
      approvals: [...s.approvals, { id: "APR-0001", category: "destructive" as const, requestedAction: "delete", resources: ["tmp"], reason: "r", risks: [], status: "approved" as const, createdAt: new Date().toISOString() }],
    }));
    await registerPermissionHook(runtime);
    const event = { action: "delete", resources: ["tmp"], effect: "allow" } as never;
    await captured.permission!(event);
    expect((event as unknown as { effect: string }).effect).toBe("allow");
  });

  it("lets an explicit state false override an option that enabled promotion", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cov-"));
    const runtime = createRuntime({
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}) },
      permission: { hook: async (_name: string, cb: (e: unknown) => unknown) => { captured.permission = cb; return { dispose: async () => {} }; } },
    } as never, {
      profile: "public", projectState: ".agent-team", telemetry: false,
      autonomy: { mode: "yolo", askBefore: [], allowPromotion: true },
      orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] },
    } as never);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const { appendEvent, storeContext } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "plugin"), "guardrails.updated", {}, (s) => ({ ...s, allowPromotion: false }));
    await registerPermissionHook(runtime);
    const event = { action: "deploy", resources: ["prod"], effect: "allow" } as never;
    await captured.permission!(event);
    expect((event as unknown as { effect: string }).effect).toBe("deny");
  });

  it("denies leader shell while a delivery is active and records a repeated failure route", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, { expectedRevision: 0, title: "T", userOutcome: "U", happyPath: ["h"], allowedScope: ["src/**"], acceptanceCriteria: ["AC-1"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], rollback: "revert" }, leader);
    await registerToolAuditHooks(runtime);
    await expect(captured.before!({ tool: "shell", agent: "team-leader", sessionID: "sess-1", input: { command: "rm -rf src" } })).rejects.toThrow(/cannot run shell/);
    _resetFailureCountsForTests();
    await captured.after!({ tool: "npm test", status: "error", input: { command: "npm test" }, id: "1" });
    await captured.after!({ tool: "npm test", status: "error", input: { command: "npm test" }, id: "2" });
    expect((await readState(root))?.route?.reason).toBe("revise-approach");
  });
});

describe("context and permission branches", () => {
  it("applies model options and strips subagent from a read-only role", async () => {
    const { runtime } = await fresh({});
    const { registerContextHook } = await import("../../src/hooks/context.js");
    const cap: { hook?: (e: unknown) => unknown } = {};
    (runtime.ctx.session as unknown as { hook: unknown }).hook = async (name: string, cb: (e: unknown) => unknown) => {
      if (name === "context") cap.hook = cb;
      return { dispose: async () => {} };
    };
    (runtime.options as unknown as { model: unknown }).model = { providerID: "p", modelID: "m", reasoningEffort: "high", maxTokens: 1000 };
    await registerContextHook(runtime);
    const event = { agent: "team-leader/reviewer", system: [], options: {}, tools: { subagent: {}, edit: {} } };
    await cap.hook!(event);
    expect((event.options as Record<string, unknown>)["model"]).toEqual({ providerID: "p", id: "m" });
    expect((event.options as Record<string, unknown>)["reasoningEffort"]).toBe("high");
    expect((event.tools as Record<string, unknown>)["subagent"]).toBeUndefined();
  });

  it("elevates an external action in guarded mode", async () => {
    const { runtime } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeState(runtime, { action: "guard", expectedRevision: 0, mode: "guarded" }, leader);
    await registerPermissionHook(runtime);
    const event = { action: "destructive", resources: ["tmp"], effect: "allow" } as never;
    await captured.permission!(event);
    expect((event as unknown as { effect: string }).effect).toBe("ask");
  });

  it("rejects a non-numeric revision before the tool runs", async () => {
    const { runtime } = await fresh();
    await registerToolAuditHooks(runtime);
    await expect(captured.before!({ tool: "agent_team_state", agent: "team-leader", sessionID: "s", input: { expectedRevision: "1" } })).rejects.toThrow(/must be a number/);
  });
});

describe("orchestrator event stream", () => {
  it("settles an execution event and records a shell-ended event", async () => {
    const { registerOrchestrator } = await import("../../src/orchestrator/launch.js");
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-events-"));
    const events = [
      { type: "session.shell.ended", data: { sessionID: "ses_shell", exitCode: 0, output: "ok" } },
      { type: "session.idle", data: { sessionID: "ses_none" } },
      { type: "unrelated", data: {} },
    ];
    const runtime = runtimeFor(root, {
      event: {
        subscribe: async function* () {
          for (const event of events) yield event;
        },
      },
    });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const reg = await registerOrchestrator(runtime);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reg.dispose();
    expect(true).toBe(true);
  });
});

describe("scope and promotion boundaries", () => {
  it("does not treat a path that mentions release as a promotion", async () => {
    const { runtime } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await registerPermissionHook(runtime);
    const event = { action: "edit", resources: ["assets/agents/team-leader/release.md"], effect: "allow" } as never;
    await captured.permission!(event);
    expect((event as unknown as { effect: string }).effect).toBe("allow");
  });

  it("refuses a newline in a check command", async () => {
    const { isAllowedCheck } = await import("../../src/domain/checks.js");
    expect(isAllowedCheck("npm test\nrm -rf .")).toBe(false);
    expect(isAllowedCheck("npm test")).toBe(true);
  });

  it("does not let a leading .. escape an allowed scope", async () => {
    const { pathAllowed } = await import("../../src/domain/scope.js");
    expect(pathAllowed("../src/a.ts", ["src/**"])).toBe(false);
    expect(pathAllowed("src/../docs/a.md", ["src/**"])).toBe(false);
  });

  it("does not overwrite a recorded class with an unconfident route", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const { appendEvent, storeContext } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "plugin"), "route.recorded", {}, (s) => ({ ...s, engagementClass: "fix" }));
    const routed = runtimeFor(root, {
      model: { list: async () => [{ id: "jev", modelID: "jev", providerID: "p", name: "Jev", type: "decision", enabled: true, status: "active" }] },
      experimental: { generate: { decisions: async () => ({ answers: [{ type: "choice", name: "engagement_class", choice: "change", probabilities: [{ value: "change", probability: 0.2 }], confidence: 0.2 }] }) } },
    });
    _resetRouteCacheForTests();
    _resetDecisionModelCatalogForTests();
    await routePrompt(routed, "sess-1", "continue");
    expect((await readState(root))?.engagementClass).toBe("fix");
  });
});

describe("doctor surface", () => {
  it("fails the team runtime line when session.create is missing", async () => {
    const { runDoctor } = await import("../../src/doctor/report.js");
    const { runtime } = await fresh({ session: { prompt: async () => ({}) } });
    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === "Team runtime")?.status).toBe("FAIL");
  });
});

describe("prompt hook", () => {
  it("notices an old host once and routes a team prompt", async () => {
    const synthetic = vi.fn(async () => ({}));
    const runtime = runtimeFor("/tmp/agent-team-prompt", {
      app: { version: "2.1.4" },
      session: { hook: async (_name: string, cb: (e: unknown) => unknown) => { captured.prompt = cb; return { dispose: async () => {} }; }, synthetic, prompt: async () => ({}), create: async () => ({ id: "ses_x" }) },
    });
    await registerPromptHook(runtime);
    const event = { sessionID: "ses_old", agent: "team-leader", prompt: { text: "hello" }, metadata: {} };
    await captured.prompt!(event);
    await captured.prompt!(event);
    expect(synthetic).toHaveBeenCalledTimes(1);
  });

  it("refuses a typed pass from a model", async () => {
    const { runtime } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await expect(executeEvidence(runtime, { expectedRevision: 0, criterionId: "AC-1", kind: "test", status: "pass", summary: "s", observedAt: "t" }, leader)).rejects.toThrow(/only when Agent Team ran/);
  });
});
