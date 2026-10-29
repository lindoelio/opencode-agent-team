import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeAssumption } from "../../src/tools/assumption.js";
import { executeDecision } from "../../src/tools/decision.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeEvidence } from "../../src/tools/evidence.js";
import { executeApproval } from "../../src/tools/approval.js";
import { runDoctor } from "../../src/doctor/report.js";

/**
 * The branches that decide what happens when something is missing, absent or
 * refused. These paths are the ones a user hits when the plugin does not
 * behave the way the README says, so they are asserted explicitly.
 */

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, options: Record<string, unknown> = {}): AgentTeamRuntime {
  return createRuntime(
    { location: { project: { canonical: root } }, options: {} } as never,
    {
      profile: "public",
      strictEvidence: true,
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6 },
      ...options,
    },
  );
}

async function freshRoot(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-branches-"));
}

describe("optional inputs and absent defaults", () => {
  it("state: initialize without the optional fields, and read an uninitialized ledger", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    const before = JSON.parse((await executeState(runtime, { action: "read" }, leader)).content);
    expect(before.initialized).toBe(false);
    const init = JSON.parse((await executeState(runtime, { action: "initialize", outcome: "O" }, leader)).content);
    expect(init.initialized).toBe(true);
    expect(init.state.actors).toEqual([]);
    expect(init.state.constraints).toEqual([]);
    expect(init.state.nonGoals).toEqual([]);
  });

  it("state: initialize accepts the optional fields", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    const init = JSON.parse(
      (
        await executeState(
          runtime,
          { action: "initialize", outcome: "O", actors: ["a"], constraints: ["c"], nonGoals: ["n"], acceptance: ["x"] },
          leader,
        )
      ).content,
    );
    expect(init.state.actors).toEqual(["a"]);
    expect(init.state.constraints).toEqual(["c"]);
    expect(init.state.nonGoals).toEqual(["n"]);
  });

  it("state: transition to an explicit terminal status, and reopen it only through IN_PROGRESS", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const failed = JSON.parse(
      (
        await executeState(
          runtime,
          { action: "transition", expectedRevision: 0, to: "DISCOVER", reason: "r", nextAction: "n", status: "FAILED" },
          leader,
        )
      ).content,
    );
    expect(failed.state.engagement.status).toBe("FAILED");
    // A terminal status is reopened only back to IN_PROGRESS, which is what
    // the phase-derived status already is.
    const reopened = JSON.parse(
      (
        await executeState(
          runtime,
          { action: "transition", expectedRevision: 1, to: "DISCOVER", reason: "retrying", nextAction: "n" },
          leader,
        )
      ).content,
    );
    expect(reopened.state.engagement.status).toBe("IN_PROGRESS");
    // An illegal explicit status is refused.
    await expect(
      executeState(
        runtime,
        { action: "transition", expectedRevision: 2, to: "FRAME", reason: "r", nextAction: "n", status: "DELIVERED" },
        leader,
      ),
    ).rejects.toThrow(/invalid status transition/);
  });

  it("guard: add, remove and clear", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const added = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 0, add: ["deploy prod"] }, leader)).content);
    expect(added.guardrails).toEqual(["deploy prod"]);
    const removed = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 1, remove: ["deploy prod"] }, leader)).content);
    expect(removed.guardrails).toEqual([]);
    const cleared = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 2, clear: true }, leader)).content);
    expect(cleared.guardrails).toEqual([]);
    const guarded = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 3, mode: "guarded" }, leader)).content);
    expect(guarded.mode).toBe("guarded");
  });

  it("assumption and evidence: the optional fields default cleanly", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const asm = JSON.parse(
      (
        await executeAssumption(
          runtime,
          { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" },
          leader,
        )
      ).content,
    );
    expect(asm.id).toBe("ASM-0001");
    const evd = JSON.parse(
      (
        await executeEvidence(
          runtime,
          { expectedRevision: 1, criterionId: "AC-1", kind: "source", status: "pass", summary: "s", artifactRef: "f", observedAt: "t" },
          leader,
        )
      ).content,
    );
    expect(evd.id).toBe("EVD-0001");
    expect(evd.digest).toBeUndefined();
  });

  it("delivery: the optional fields default cleanly", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse(
      (
        await executeDelivery(
          runtime,
          {
            expectedRevision: 0,
            title: "T",
            userOutcome: "u",
            happyPath: ["a"],
            allowedScope: ["src/**"],
            acceptanceCriteria: ["AC-1"],
            validationSteps: ["npm test"],
            rollback: "revert",
          },
          leader,
        )
      ).content,
    );
    expect(out.id).toBe("DEL-001");
    const doc = fs.readFileSync(path.join(root, ".agent-team", "deliveries", "DEL-001.yaml"), "utf8");
    expect(doc).toContain("in_scope:");
    expect(doc).toContain("out_of_scope:");
    expect(doc).toContain("risks:");
    expect(doc).toContain('user_outcome: "u"');
  });

  it("decision and approval: the optional fields default cleanly", async () => {
    const root = await freshRoot();
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, leader);
    const dec = JSON.parse(
      (
        await executeDecision(
          runtime,
          {
            expectedRevision: 1,
            title: "T",
            context: "c",
            drivers: ["d"],
            options: [
              { name: "a", benefits: [], costs: [], risks: [] },
              { name: "b", benefits: [], costs: [], risks: [] },
            ],
            decision: "a",
            rationale: "r",
            consequences: ["c"],
            reversibility: "easy",
            authority: "ALLOW",
            evidenceRefs: ["ASM-0001"],
          },
          leader,
        )
      ).content,
    );
    expect(dec.id).toBe("DEC-0001");
    const opened = JSON.parse(
      (
        await executeApproval(
          runtime,
          { action: "open", expectedRevision: 2, category: "release", requestedAction: "publish", resources: ["npm"], reason: "why", risks: [] },
          leader,
        )
      ).content,
    );
    expect(opened.id).toBe("APR-0001");
    expect(opened.expiresAt).toBeUndefined();
  });
});

describe("the doctor reports what it found", () => {
  /** The surfaces the plugin registers against. A host missing one cannot run it. */
  function hostCtx(root: string, version: string, extra: Record<string, unknown> = {}): never {
    const noop = async () => ({ dispose: async () => {} });
    return {
      options: {},
      location: { project: { canonical: root } },
      app: { version },
      model: { list: async () => [{ id: "m", providerID: "p", variants: [] }] },
      generate: { text: async () => ({ text: "ok" }) },
      tool: { list: async () => [{ id: "agent_team_state" }], transform: async () => ({ dispose: async () => {} }), hook: noop },
      command: { transform: async () => ({ dispose: async () => {} }) },
      skill: { transform: async () => ({ dispose: async () => {} }) },
      session: { hook: noop },
      agent: { list: async () => [{ id: "team-leader" }] },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
      permission: { hook: noop },
      ...extra,
    } as never;
  }

  it("marks an unsupported host version as DEGRADED and names it", async () => {
    const root = await freshRoot();
    const report = await runDoctor(createRuntime(hostCtx(root, "1.19.5"), runtimeFor(root).options));
    const version = report.checks.find((c) => c.name === "OpenCode")!;
    expect(version.status).toBe("DEGRADED");
    expect(version.detail).toContain("1.19.5");
  });

  it("marks every supported host version as PASS", async () => {
    for (const version of ["2.0.10", "2.1.4", "2.2.0"]) {
      const root = await freshRoot();
      const report = await runDoctor(createRuntime(hostCtx(root, version), runtimeFor(root).options));
      expect(report.checks.find((c) => c.name === "OpenCode")!.status, version).toBe("PASS");
    }
  });

  it("reports the API surface and prefers the 2.2.x generation path", async () => {
    const root = await freshRoot();
    const ctx = hostCtx(root, "2.2.0", {
      experimental: { generate: { text: async () => ({ text: "ok" }) } },
      generate: { text: async () => ({ text: "deprecated" }) },
    });
    const report = await runDoctor(createRuntime(ctx, runtimeFor(root).options));
    const surface = report.checks.find((c) => c.name === "Host API surface")!;
    expect(surface.status).toBe("PASS");
    expect(surface.detail).toContain("experimental.generate");
    // the 2.2.x generator is used, not the deprecated one
    const generation = report.checks.find((c) => c.name === "Text generation")!;
    expect(generation.status).toBe("PASS");
    expect(generation.detail).toBe("ok");
  });

  it("fails the host surface when a required surface is missing", async () => {
    const root = await freshRoot();
    const ctx = hostCtx(root, "2.0.10", { skill: undefined });
    const report = await runDoctor(createRuntime(ctx, runtimeFor(root).options));
    const surface = report.checks.find((c) => c.name === "Host API surface")!;
    expect(surface.status).toBe("FAIL");
    expect(surface.detail).toContain("MISSING REQUIRED");
  });

  it("reports a configured reasoning effort that the catalog does not offer", async () => {
    const root = await freshRoot();
    const ctx = hostCtx(root, "2.0.10", { model: { list: async () => [{ id: "m", providerID: "p", variants: [{ id: "low" }] }] } });
    const runtime = createRuntime(ctx, runtimeFor(root, { model: { reasoningEffort: "high" } }).options);
    const report = await runDoctor(runtime);
    const effort = report.checks.find((c) => c.name === "Reasoning effort")!;
    expect(effort.status).toBe("FAIL");
    expect(effort.detail).toContain("high");
  });
});
