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
const CHECK = "node --test test/board.node-test.mjs";

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
          if (name === "execute.after") (captured.after = cb);
          return { dispose: async () => {} };
        },
      },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
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

const captured: { before?: (e: unknown) => unknown; after?: (e: unknown) => unknown } = {};

/**
 * A runtime that records the archive calls and reports whether the host
 * honoured them, so the settle-time archiving can be asserted.
 */
function archivableRuntime(
  root: string,
  updates: unknown[],
  opts: { takesEffect?: boolean; archiveChildSessions?: boolean } = {},
): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    {
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: {
        create: async () => ({ id: `ses_child_${++n}` }),
        prompt: async () => ({}),
        synthetic: async () => ({}),
        get: async ({ sessionID }: { sessionID: string }) => ({
          data: { id: sessionID, time: opts.takesEffect === false ? {} : { archived: Date.now() } },
        }),
        update: async (input: unknown) => {
          updates.push(input);
        },
      },
      tool: { transform: async () => ({ dispose: async () => {} }), list: async () => [], hook: async () => ({ dispose: async () => {} }) },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
    } as never,
    {
      profile: "public",
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: {
        maxParallelSpecialists: 6,
        allowedCheckPrefixes: [],
        archiveChildSessions: opts.archiveChildSessions ?? true,
      },
    } as never,
  );
}

function reportedEvents(root: string, type: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(root, ".agent-team", "ledger", "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event["type"] === type)
    .map((event) => (event["payload"] ?? {}) as Record<string, unknown>);
}

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

  it("archives the specialist session when its report lands", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-runtime-"));
    const updates: unknown[] = [];
    const runtime = archivableRuntime(root, updates);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    const child = out.sessions[0].sessionID;
    await executeReport(runtime, { result: { status: "PASS", summary: "mapped", findings: [], risks: [], unknowns: [], recommended_next_action: "plan" } }, { sessionID: child, agent: "team-leader/explorer" } as never);
    expect(updates).toEqual([{ sessionID: child, archived: true }]);
    expect(reportedEvents(root, "handoff.reported").at(-1)?.["archive"]).toBe("applied");
  });

  it("reports a host that silently ignores the archive instead of pretending", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-runtime-"));
    const updates: unknown[] = [];
    const runtime = archivableRuntime(root, updates, { takesEffect: false });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    await executeReport(runtime, { result: { status: "PASS", summary: "mapped", findings: [], risks: [], unknowns: [], recommended_next_action: "plan" } }, { sessionID: out.sessions[0].sessionID, agent: "team-leader/explorer" } as never);
    expect(updates).toHaveLength(1);
    expect(reportedEvents(root, "handoff.reported").at(-1)?.["archive"]).toBe("failed");
  });

  it("archives a failed booking when it settles, and honours the off switch", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-runtime-"));
    const updates: unknown[] = [];
    const runtime = archivableRuntime(root, updates);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse((await executeHandoff(runtime, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    await settleSession(runtime, out.sessions[0].sessionID);
    expect(updates).toEqual([{ sessionID: out.sessions[0].sessionID, archived: true }]);

    const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-runtime-"));
    const offUpdates: unknown[] = [];
    const off = archivableRuntime(root2, offUpdates, { archiveChildSessions: false });
    await executeState(off, { action: "initialize", outcome: "O" }, leader);
    const out2 = JSON.parse((await executeHandoff(off, {
      action: "launch",
      expectedRevision: 0,
      units: [{ role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }],
    }, leader)).content);
    await settleSession(off, out2.sessions[0].sessionID);
    expect(offUpdates).toEqual([]);
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
      validationSteps: [{ criterionId: "AC-1", command: "npm test" }],
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
      validationSteps: [{ criterionId: "AC-1", command: "npm test" }],
      rollback: "revert",
    }, leader);
    const state = await readState(root);
    const recorded = await observeDeliveryChecks(runtime, root, state!.activeDelivery!);
    expect(recorded).toBe(1);
    const after = await readState(root);
    expect(after?.evidence.some((e) => e.criterionId === "AC-1" && e.observed === true && e.command === "npm test")).toBe(true);
  });

  it("records a declared check from the completed shell tool result", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: [{ criterionId: "AC-1", command: CHECK }],
      rollback: "revert",
    }, leader);
    await registerToolAuditHooks(runtime);
    await captured.after!({
      tool: "shell",
      status: "completed",
      id: "t1",
      agent: "team-leader/coder",
      sessionID: "child-1",
      input: { command: CHECK, workdir: root },
      result: { metadata: { exit: 0 }, content: [{ type: "text", text: "5 pass" }] },
    });
    const state = await readState(root);
    const row = state?.evidence[0];
    expect(row?.criterionId).toBe("AC-1");
    expect(row?.status).toBe("pass");
    expect(row?.observed).toBe(true);
    expect(row?.command).toBe(CHECK);
  });

  it("records a failed shell result and ignores a non-team session", async () => {
    const { runtime, root } = await fresh();
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(runtime, {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: [{ criterionId: "AC-1", command: CHECK }],
      rollback: "revert",
    }, leader);
    await registerToolAuditHooks(runtime);
    await captured.after!({
      tool: "shell",
      status: "completed",
      id: "t1",
      agent: "team-leader/coder",
      sessionID: "child-1",
      input: { command: CHECK, workdir: root },
      result: { metadata: { exit: 1 }, content: [{ type: "text", text: "1 fail" }] },
    });
    let state = await readState(root);
    expect(state?.evidence[0]?.status).toBe("fail");
    expect(state?.evidence[0]?.observed).toBe(true);
    // a user session running the same command is not the agent team's evidence
    await captured.after!({
      tool: "shell",
      status: "completed",
      id: "t2",
      agent: "build",
      sessionID: "user-session",
      input: { command: CHECK, workdir: root },
      result: { metadata: { exit: 0 }, content: [{ type: "text", text: "5 pass" }] },
    });
    state = await readState(root);
    expect(state?.evidence).toHaveLength(1);
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
      validationSteps: [{ criterionId: "AC-1", command: "npm test" }],
      rollback: "revert",
    }, leader);
    const state = await readState(root);
    const delivery = { ...state!.activeDelivery!, validationSteps: [{ criterionId: "AC-1", command: "rm -rf /" }] };
    const recorded = await observeDeliveryChecks(runtime, root, delivery);
    expect(recorded).toBe(0);
    expect(projectRootOf(runtime.ctx)).toBe(root);
  });
});
