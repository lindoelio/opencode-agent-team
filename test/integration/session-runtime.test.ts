import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, projectRootOf, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeReport } from "../../src/tools/report.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { registerToolAuditHooks } from "../../src/hooks/tool-audit.js";
import { observeDeliveryChecks } from "../../src/orchestrator/observe.js";
import { settleSession } from "../../src/orchestrator/launch.js";
import { readState } from "../../src/ledger/store.js";

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, shellOutput = "ok", shellExit = 0): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    {
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: {
        create: async () => ({ id: `ses_child_${++n}` }),
        prompt: async () => ({}),
        synthetic: async () => ({}),
        get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, status: "idle" } }),
        shell: async () => ({ exitCode: shellExit, output: shellOutput }),
      },
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
    {
      profile: "public",
      strictEvidence: true,
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] },
    } as never,
  );
}

const captured: { before?: (e: unknown) => unknown } = {};

async function fresh(): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-runtime-"));
  return { runtime: runtimeFor(root), root };
}

describe("the specialist runtime", () => {
  it("launches a session, accepts its report, and rejects a foreign report", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    const child = { sessionID: out.sessions[0].sessionID, agent: "team-leader/explorer" } as never;
    const foreign = { sessionID: "ses_foreign", agent: "team-leader/explorer" } as never;
    const result = { status: "PASS", summary: "mapped", findings: [], risks: [], unknowns: [], recommended_next_action: "plan" };
    await expect(executeReport(runtime, { result }, foreign)).rejects.toThrow(/no running handoff/);
    const report = JSON.parse((await executeReport(runtime, { result }, child)).content);
    expect(report.status).toBe("PASS");
    const state = await readState(root);
    expect(state?.handoffs[0]?.status).toBe("completed");
    expect(state?.handoffs[0]?.sessionID).toBe(out.sessions[0].sessionID);
  });

  it("fails a booking whose session ends without a report", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    await settleSession(runtime, out.sessions[0].sessionID);
    const state = await readState(root);
    expect(state?.handoffs[0]?.status).toBe("failed");
  });

  it("denies a leader product edit while a delivery is active", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: ["npm test"],
      rollback: "revert",
    }, leader);
    await registerToolAuditHooks(runtime);
    await expect(captured.before!({ tool: "write", agent: "team-leader", sessionID: "sess-1", input: { path: path.join(root, "src/a.ts") } })).rejects.toThrow(/cannot edit/);
    await expect(captured.before!({ tool: "write", agent: "team-leader", sessionID: "sess-1", input: { path: path.join(root, ".agent-team/notes.md") } })).resolves.toBeUndefined();
  });

  it("records an allowlisted check through the host shell", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: ["npm test"],
      rollback: "revert",
    }, leader);
    const state = await readState(root);
    const recorded = await observeDeliveryChecks(runtime, root, state!.activeDelivery!);
    expect(recorded).toBe(1);
    const after = await readState(root);
    expect(after?.evidence.some((e) => e.criterionId === "AC-1" && e.observed === true && e.command === "npm test")).toBe(true);
  });

  it("does not run a check outside the allowlist", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: ["npm test"],
      rollback: "revert",
    }, leader);
    const state = await readState(root);
    const delivery = { ...state!.activeDelivery!, validationSteps: ["rm -rf /"] };
    const recorded = await observeDeliveryChecks(runtime, root, delivery);
    expect(recorded).toBe(0);
    expect(projectRootOf(runtime.ctx)).toBe(root);
  });
});
