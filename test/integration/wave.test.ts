import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { recordObservedEvidence } from "../../src/orchestrator/observe.js";
import { executeGate } from "../../src/tools/gate.js";
import { readState } from "../../src/ledger/store.js";
import { project } from "../../src/ledger/projection.js";

/**
 * A wave is booked in one call and therefore costs one ledger revision.
 * That is what keeps the leader's revision stable while the wave is in
 * flight — the whole point of the parallel budget.
 */

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    { location: { project: { canonical: root } }, options: {}, app: { version: "2.2.0" }, session: { create: async () => ({ id: `ses_child_${++n}` }), prompt: async () => ({}) } } as never,
    {
      profile: "public",
      strictEvidence: true,
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] },
    },
  );
}

async function freshRuntime(): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-wave-"));
  const runtime = runtimeFor(root);
  await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
  return { runtime, root };
}

const UNIT = {
  role: "explorer" as const,
  objective: "map the domain",
  context: ["ctx"],
  allowedScope: ["src/**"],
  prohibitedScope: ["src/secret.ts"],
  questions: ["q?"],
  requiredEvidence: ["glossary"],
  stopCondition: "mapped",
};

describe("booking a wave", () => {
  it("launches every unit in one call and one revision", async () => {
    const { runtime, root } = await freshRuntime();
    const before = (await readState(root))!.revision;
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "launch",
            expectedRevision: before,
            units: [
              UNIT,
              { ...UNIT, role: "worker" as const, objective: "write the memo", allowedScope: ["docs/**"] },
            ],
          },
          leader,
        )
      ).content,
    );
    expect(out.ids).toEqual(["HND-0001", "HND-0002"]);
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions[0].sessionID).toMatch(/^ses_/);
    expect(out.prompts[0]).toContain("HND-0001");
    expect(out.prompts[1]).toContain("HND-0002");
    expect(out.revision).toBe(before + 1);
    expect(out.parallelBudget.running).toBe(2);
  });

  it("gives every unit its own session and its role's skills", async () => {
    const { runtime, root } = await freshRuntime();
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "launch",
            expectedRevision: 0,
            units: [
              { ...UNIT, skills: ["agent-team-domain-discovery"] },
              { ...UNIT, role: "worker" as const, objective: "write", allowedScope: ["docs/**"] },
            ],
          },
          leader,
        )
      ).content,
    );
    expect(out.sessions[0].sessionID).not.toBe(out.sessions[1].sessionID);
    const state = await readState(root);
    expect(state?.handoffs[0]?.skills).toEqual(["agent-team-domain-discovery"]);
    expect(state?.handoffs[1]?.skills.length).toBeGreaterThan(0);
  });

  it("refuses a wave that would exceed the parallel budget", async () => {
    const { runtime } = await freshRuntime();
    await expect(
      executeHandoff(
        runtime,
        {
          action: "launch",
          expectedRevision: 0,
          units: Array.from({ length: 7 }, (_, i) => ({ ...UNIT, objective: `unit ${i}` })),
        },
        leader,
      ),
    ).rejects.toThrow(/parallel specialist budget exhausted/);
  });

  it("counts a wave against the budget together with what is already running", async () => {
    const { runtime, root } = await freshRuntime();
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT, UNIT, UNIT, UNIT, UNIT] }, leader);
    const rev = (await readState(root))!.revision;
    await expect(
      executeHandoff(runtime, { action: "launch", expectedRevision: rev, units: [UNIT, UNIT] }, leader),
    ).rejects.toThrow(/parallel specialist budget exhausted/);
    const ok = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: rev, units: [UNIT] }, leader)).content);
    expect(ok.ids).toEqual(["HND-0006"]);
  });

  it("keeps a running wave in the projection as open", async () => {
    const { runtime, root } = await freshRuntime();
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT, { ...UNIT, role: "worker" as const, allowedScope: ["docs/**"] }] }, leader);
    const state = await readState(root);
    const projection = project(state!);
    expect(projection.handoffs_open).toEqual(["HND-0001:explorer", "HND-0002:worker"]);
    expect(projection.handoffs_ready).toEqual([]);
  });

  it("excludes a cancelled handoff from the running count", async () => {
    const { runtime, root } = await freshRuntime();
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: Array.from({ length: 6 }, (_, i) => ({ ...UNIT, objective: `unit ${i}` })) }, leader);
    let rev = (await readState(root))!.revision;
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: rev, units: [UNIT] }, leader)).rejects.toThrow(/budget exhausted/);
    await executeHandoff(runtime, { action: "cancel", expectedRevision: rev, handoffId: "HND-0001", reason: "not needed" }, leader);
    rev = (await readState(root))!.revision;
    const ok = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: rev, units: [UNIT] }, leader)).content);
    expect(ok.ids).toEqual(["HND-0007"]);
  });

  it("refuses a wave from a specialist", async () => {
    const { runtime } = await freshRuntime();
    const specialist = { sessionID: "s", agent: "team-leader/coder" } as never;
    await expect(
      executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT] }, specialist),
    ).rejects.toThrow(/only team-leader may/);
  });

  it("refuses a wave with no units", async () => {
    const { runtime } = await freshRuntime();
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [] }, leader)).rejects.toThrow(/invalid handoff input/);
  });
});

describe("a delivery cannot change after it was accepted", () => {
  async function acceptedDelivery(): Promise<{ runtime: AgentTeamRuntime; root: string }> {
    const { runtime, root } = await freshRuntime();
    const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "delivery.defined", { id: "DEL-001" }, (s) => ({
      ...s,
      activeDelivery: {
        id: "DEL-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: [], outOfScope: [], allowedScope: ["src/a.ts"], prohibitedScope: [],
        acceptanceCriteria: ["AC-1"], validationSteps: ["npm test"], proof: [],
        risks: [], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
      },
    }));
    return { runtime, root };
  }

  async function acceptIt(runtime: AgentTeamRuntime, root: string): Promise<number> {
    const { readState, storeContext, appendEvent } = await import("../../src/ledger/store.js");
    let rev = (await readState(root))!.revision;
    await recordObservedEvidence(root, { criterionId: "AC-1", kind: "test", summary: "green", command: "npm test", exitCode: 0, output: "ok" });
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "handoff.launched", { id: "HND-0001" }, (s) => ({
      ...s,
      handoffs: [
        ...s.handoffs,
        { id: "HND-0001", role: "coder" as const, objective: "implement", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_coder", parentSessionID: "sess-1" },
        { id: "HND-0002", role: "reviewer" as const, objective: "review", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_reviewer", parentSessionID: "sess-1" },
      ],
    }));
    rev = (await readState(root))!.revision;
    const accept = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "done", expectedRevision: rev }, leader)).content);
    expect(accept.result).toBe("PASS");
    return accept.revision;
  }

  it("refuses to deliver a contract that changed after ACCEPT", async () => {
    const { runtime, root } = await acceptedDelivery();
    const { readState, storeContext, appendEvent } = await import("../../src/ledger/store.js");
    const rev = await acceptIt(runtime, root);
    // the accepted gate recorded the contract it judged
    const accepted = (await readState(root))!.gates.find((g) => g.gate === "ACCEPT")!;
    expect(accepted.contractDigest).toBeDefined();

    // the delivery changes afterwards
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "delivery.defined", { id: "DEL-001" }, (s) => ({
      ...s,
      activeDelivery: { ...s.activeDelivery!, acceptanceCriteria: ["AC-1", "AC-2"] } as typeof s.activeDelivery,
    }));
    const after = (await readState(root))!.revision;
    const deliver = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: after }, leader)).content);
    expect(deliver.result).toBe("FAIL");
    expect(deliver.missing).toContain("unchanged-contract");
  });

  it("refuses to deliver a file tree that changed after ACCEPT", async () => {
    const { runtime, root } = await acceptedDelivery();
    const rev = await acceptIt(runtime, root);
    await fs.promises.mkdir(path.join(root, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(root, "src", "a.ts"), "changed after acceptance");
    const deliver = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: rev }, leader)).content);
    expect(deliver.result).toBe("FAIL");
    expect(deliver.missing).toContain("unchanged-artifact");
  });

  it("delivers an unchanged contract", async () => {
    const { runtime, root } = await acceptedDelivery();
    const rev = await acceptIt(runtime, root);
    const deliver = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: rev }, leader)).content);
    expect(deliver.result).toBe("PASS");
  });
});
