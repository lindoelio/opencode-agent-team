import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeEvidence } from "../../src/tools/evidence.js";
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
  return createRuntime(
    { location: { project: { canonical: root } }, options: {} } as never,
    {
      profile: "public",
      strictEvidence: true,
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6 },
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
  it("prepares every unit in one call and one revision", async () => {
    const { runtime } = await freshRuntime();
    const before = (await readState(path.join(runtime.ctx.location.project!.canonical)))!.revision;
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "prepareWave",
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
    expect(out.packets).toHaveLength(2);
    expect(out.prompt).toContain("HND-0001");
    expect(out.prompt).toContain("HND-0002");
    // one revision bump for the whole wave
    expect(out.revision).toBe(before + 1);
    expect(out.parallelBudget.inFlight).toBe(2);
  });

  it("gives every unit its own id and its role's skills", async () => {
    const { runtime } = await freshRuntime();
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "prepareWave",
            expectedRevision: 0,
            units: [
              { ...UNIT, skills: ["agent-team-domain-discovery"] },
              { ...UNIT, role: "worker" as const, objective: "write" },
            ],
          },
          leader,
        )
      ).content,
    );
    expect(out.packets[0].skills).toEqual(["agent-team-domain-discovery"]);
    // the second unit defaults to the skills its role owns
    expect(out.packets[1].skills.length).toBeGreaterThan(0);
  });

  it("refuses a wave that would exceed the parallel budget", async () => {
    const { runtime } = await freshRuntime();
    await expect(
      executeHandoff(
        runtime,
        {
          action: "prepareWave",
          expectedRevision: 0,
          units: Array.from({ length: 7 }, (_, i) => ({ ...UNIT, objective: `unit ${i}` })),
        },
        leader,
      ),
    ).rejects.toThrow(/parallel specialist budget exhausted/);
  });

  it("counts a wave against the budget together with what is already in flight", async () => {
    const { runtime } = await freshRuntime();
    await executeHandoff(runtime, { action: "prepareWave", expectedRevision: 0, units: [UNIT, UNIT, UNIT, UNIT, UNIT] }, leader);
    // five are in flight; a wave of two would exceed six
    await expect(
      executeHandoff(runtime, { action: "prepareWave", expectedRevision: 1, units: [UNIT, UNIT] }, leader),
    ).rejects.toThrow(/parallel specialist budget exhausted/);
    // a wave of one fits
    const ok = JSON.parse((await executeHandoff(runtime, { action: "prepareWave", expectedRevision: 1, units: [UNIT] }, leader)).content);
    expect(ok.ids).toEqual(["HND-0006"]);
  });

  it("keeps a wave's units in the projection as ready to launch", async () => {
    const { runtime, root } = await freshRuntime();
    await executeHandoff(runtime, { action: "prepareWave", expectedRevision: 0, units: [UNIT, { ...UNIT, role: "worker" as const }] }, leader);
    const state = await readState(root);
    const projection = project(state!);
    expect(projection.handoffs_ready).toEqual(["HND-0001:explorer", "HND-0002:worker"]);
    expect(projection.handoffs_blocked).toEqual([]);
  });

  it("excludes a cancelled handoff from the in-flight count", async () => {
    const { runtime } = await freshRuntime();
    await executeHandoff(runtime, { action: "prepareWave", expectedRevision: 0, units: Array.from({ length: 6 }, (_, i) => ({ ...UNIT, objective: `unit ${i}` })) }, leader);
    // the budget is full
    await expect(executeHandoff(runtime, { action: "prepareWave", expectedRevision: 1, units: [UNIT] }, leader)).rejects.toThrow(/budget exhausted/);
    // cancelling one frees a slot
    await executeHandoff(runtime, { action: "cancel", expectedRevision: 1, handoffId: "HND-0001", reason: "not needed" }, leader);
    const ok = JSON.parse((await executeHandoff(runtime, { action: "prepareWave", expectedRevision: 2, units: [UNIT] }, leader)).content);
    expect(ok.ids).toEqual(["HND-0007"]);
  });

  it("refuses a wave from a specialist", async () => {
    const { runtime } = await freshRuntime();
    const specialist = { sessionID: "s", agent: "team-leader/coder" } as never;
    await expect(
      executeHandoff(runtime, { action: "prepareWave", expectedRevision: 0, units: [UNIT] }, specialist),
    ).rejects.toThrow(/only team-leader may/);
  });

  it("refuses a wave with no units", async () => {
    const { runtime } = await freshRuntime();
    await expect(executeHandoff(runtime, { action: "prepareWave", expectedRevision: 0, units: [] }, leader)).rejects.toThrow(/invalid handoff input/);
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
    const { readState } = await import("../../src/ledger/store.js");
    let rev = (await readState(root))!.revision;
    await executeEvidence(runtime, { expectedRevision: rev, criterionId: "AC-1", kind: "test", status: "pass", summary: "green", command: "npm test", observedAt: "t" }, leader);
    rev = (await readState(root))!.revision;
    await executeHandoff(runtime, { action: "prepare", expectedRevision: rev, role: "reviewer", objective: "review", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" }, leader);
    rev = (await readState(root))!.revision;
    await executeHandoff(runtime, { action: "complete", expectedRevision: rev, handoffId: "HND-0001", result: { status: "PASS", summary: "ok", findings: [], risks: [], unknowns: [], recommended_next_action: "accept" } }, leader);
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

  it("delivers an unchanged contract", async () => {
    const { runtime, root } = await acceptedDelivery();
    const rev = await acceptIt(runtime, root);
    const deliver = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: rev }, leader)).content);
    expect(deliver.result).toBe("PASS");
  });
});
