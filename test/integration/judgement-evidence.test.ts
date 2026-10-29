import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetHeldDecisionsForTests } from "../../src/decision/cache.js";
import { _resetDecisionModelCatalogForTests } from "../../src/decision/catalog.js";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { runDoctor } from "../../src/doctor/checks.js";
import { claimSupported } from "../../src/domain/evidence.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeEvaluateDecision } from "../../src/tools/evaluate-decision.js";
import { executeEvidence } from "../../src/tools/evidence.js";
import { executeGate } from "../../src/tools/gate.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeState } from "../../src/tools/state.js";
import { readState } from "../../src/ledger/store.js";

const tool = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, strictEvidence = true): AgentTeamRuntime {
  const ctx = {
    app: { version: "2.2.0" },
    location: { project: { canonical: root } },
    model: {
      list: async () => [
        { id: "jev", modelID: "jev", providerID: "p", name: "Jev", type: "decision", enabled: true, status: "active", cost: [{ input: 0.05, output: 0 }], limit: { context: 32000 } },
      ],
    },
    experimental: {
      generate: {
        decisions: async () => ({ answers: [{ type: "predicate", name: "is_safe", probability: 0.95 }], tokens: { input: 120, output: 0 } }),
      },
    },
  } as never;
  return createRuntime(ctx, {
    profile: "public",
    strictEvidence,
    projectState: ".agent-team",
    telemetry: false,
    autonomy: { mode: "yolo", askBefore: [] },
    orchestration: { maxParallelSpecialists: 6 },
  } as never);
}

async function project(runtime: AgentTeamRuntime): Promise<string> {
  const root = (runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical;
  await executeState(runtime, { action: "initialize", outcome: "ship it" }, tool);
  await executeDelivery(
    runtime,
    {
      expectedRevision: 0,
      title: "Delivery",
      userOutcome: "a working flow",
      happyPath: ["one thin flow"],
      allowedScope: ["src"],
      acceptanceCriteria: ["criterion-one"],
      validationSteps: ["run the tests"],
      rollback: "revert",
    },
    tool,
  );
  return root;
}

async function revisionOf(runtime: AgentTeamRuntime): Promise<number> {
  const root = (runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical;
  const state = await readState(root);
  if (!state) throw new Error("state missing");
  return state.revision;
}

/** A completed reviewer handoff, so the ACCEPT gate reaches the evidence check. */
async function withIndependentReview(runtime: AgentTeamRuntime): Promise<number> {
  await executeHandoff(
    runtime,
    { action: "prepare", expectedRevision: await revisionOf(runtime), role: "reviewer", objective: "review the delivery", context: [], allowedScope: ["src"], prohibitedScope: [], questions: [], requiredEvidence: ["test output"], stopCondition: "findings listed" },
    tool,
  );
  await executeHandoff(
    runtime,
    { action: "complete", expectedRevision: await revisionOf(runtime), handoffId: "HND-0001", result: { status: "PASS", summary: "looks good", findings: [], risks: [], unknowns: [], recommended_next_action: "accept" } },
    tool,
  );
  return revisionOf(runtime);
}

async function fresh(strictEvidence = true): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-judgement-"));
  _resetHeldDecisionsForTests();
  _resetDecisionModelCatalogForTests();
  return { runtime: runtimeFor(root, strictEvidence), root };
}

const question = { type: "predicate" as const, name: "is_safe", instructions: "Is this safe?" };

describe("a judgement evidence row", () => {
  it("is recorded as a judgement row whose status is never passing or failing", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    const result = JSON.parse(
      (await executeEvidence(
        runtime,
        {
          expectedRevision: 1,
          criterionId: "criterion-one",
          kind: "judgment",
          status: "pass",
          summary: "a decision",
          observedAt: new Date().toISOString(),
          decisionId: decision.decisionId,
        },
        tool,
      )).content,
    );
    expect(result.verdict).toBe("satisfied");
    expect(result.verified).toBe(true);
    const row = JSON.parse(await fs.promises.readFile(path.join((runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical, ".agent-team", "evidence", `${result.id}.json`), "utf8"));
    expect(row.kind).toBe("judgment");
    expect(row.status).toBe("partial");
    expect(row.judgment.decisionId).toBe(decision.decisionId);
    expect(row.judgment.criterion).toBe("criterion-one");
  });

  it("satisfies no criterion, so the acceptance gate still fails it", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await executeEvidence(
      runtime,
      { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
      tool,
    );
    const revision = await withIndependentReview(runtime);
    const gate = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "the delivery is done", expectedRevision: revision }, tool)).content);
    expect(gate.result).toBe("FAIL");
    expect(gate.missing).toContain("criterion-one");
  });

  it("satisfies no criterion even when the strict-evidence setting is off", async () => {
    const { runtime } = await fresh(false);
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await executeEvidence(
      runtime,
      { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
      tool,
    );
    const revision = await withIndependentReview(runtime);
    const gate = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "the delivery is done", expectedRevision: revision }, tool)).content);
    expect(gate.result).toBe("FAIL");
    expect(gate.missing).toContain("criterion-one");
  });

  it("does not fail a criterion that another row already satisfies", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await executeEvidence(
      runtime,
      { expectedRevision: 1, criterionId: "criterion-one", kind: "test", status: "pass", summary: "tests pass", observedAt: new Date().toISOString(), command: "npm test" },
      tool,
    );
    await executeEvidence(
      runtime,
      { expectedRevision: 2, criterionId: "criterion-one", kind: "judgment", status: "fail", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
      tool,
    );
    const revision = await withIndependentReview(runtime);
    const gate = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "the delivery is done", expectedRevision: revision }, tool)).content);
    expect(gate.result).toBe("PASS");
    expect(gate.satisfied).toContain("criterion-one");
  });

  it("never refuses a claim on its own", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await executeEvidence(
      runtime,
      { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
      tool,
    );
    const revision = await withIndependentReview(runtime);
    const gate = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "the delivery is done", expectedRevision: revision }, tool)).content);
    expect(gate.missing).not.toContain("claim-evidence-strength");
  });

  it("refuses a judgement recorded against a different criterion", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await expect(
      executeEvidence(
        runtime,
        { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
        tool,
      ),
    ).resolves.toBeTruthy();
    // A decision executed for another criterion cannot be spent on this one.
    _resetHeldDecisionsForTests();
    await expect(
      executeEvidence(
        runtime,
        { expectedRevision: 2, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
        tool,
      ),
    ).rejects.toThrow(/not one this plugin executed/);
  });

  it("refuses a judgement row with no decision at all", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    await expect(
      executeEvidence(
        runtime,
        { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString() },
        tool,
      ),
    ).rejects.toThrow(/decisionId is required/);
  });
});

describe("a judgement row the plugin cannot verify", () => {
  it("accepts the block the specialist reported and marks it unverified", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    const reported = {
      model: "p/jev",
      answers: [{ name: "is_safe", type: "predicate", probability: 0.95 }],
      role: "team-leader/reviewer",
      use: "review",
      thresholds: { probability: 0.9, confidence: 0.75 },
      criterion: "criterion-one",
      decisionId: decision.decisionId,
      verdict: "satisfied" as const,
      verified: true,
      stateDigest: "abc",
      rationale: "cheapest candidate",
      elapsedMs: 10,
      usage: { input: 120, output: 0 },
    };
    // The plugin no longer holds the decision, as after a restart.
    _resetHeldDecisionsForTests();
    const result = JSON.parse(
      (await executeEvidence(
        runtime,
        { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId, judgment: reported },
        tool,
      )).content,
    );
    expect(result.verified).toBe(false);
    expect(result.verdict).toBe("satisfied");
  });

  it("refuses a reported block that names a different criterion", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    _resetHeldDecisionsForTests();
    await expect(
      executeEvidence(
        runtime,
        {
          expectedRevision: 1,
          criterionId: "criterion-one",
          kind: "judgment",
          status: "pass",
          summary: "a decision",
          observedAt: new Date().toISOString(),
          decisionId: "JDG-00000000",
          judgment: {
            model: "p/jev",
            answers: [],
            role: "team-leader/reviewer",
            use: "review",
            thresholds: { probability: 0.9, confidence: 0.75 },
            criterion: "other-criterion",
            decisionId: "JDG-00000000",
            verdict: "satisfied",
            verified: true,
            stateDigest: "abc",
            rationale: "r",
            elapsedMs: 1,
            usage: { input: 1, output: 0 },
          },
        },
        tool,
      ),
    ).rejects.toThrow(/different criterion/);
  });

  it("stores the answers and the counters, never the state itself", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "the raw artefact body", questions: [question] }, tool)).content);
    const result = JSON.parse(
      (await executeEvidence(
        runtime,
        { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
        tool,
      )).content,
    );
    const row = JSON.parse(await fs.promises.readFile(path.join((runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical, ".agent-team", "evidence", `${result.id}.json`), "utf8"));
    expect(JSON.stringify(row)).not.toContain("the raw artefact body");
    expect(row.judgment.usage).toEqual({ input: 120, output: 0 });
    expect(row.judgment.answers[0]).toMatchObject({ type: "predicate", probability: 0.95 });
    expect(row.judgment.stateDigest).toEqual(expect.any(String));
  });
});

describe("the judgement rows in the preflight", () => {
  it("reports how many judgement rows the project state holds", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await executeEvidence(
      runtime,
      { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: decision.decisionId },
      tool,
    );
    const report = await runDoctor(runtime);
    const line = report.checks.find((c) => c.name === "Decision models");
    expect(line!.detail).toContain("1 judgement row(s) recorded");
    expect(line!.status).toBe("PASS");
  });
});

describe("the verdict on a judgement row", () => {
  it("is recomputed from the answers, never taken from the caller", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    _resetHeldDecisionsForTests();
    const reported = {
      model: "p/jev",
      answers: [{ name: "is_safe", type: "predicate", probability: 0.2 }],
      role: "team-leader/reviewer",
      use: "review",
      thresholds: { probability: 0.9, confidence: 0.75 },
      criterion: "criterion-one",
      decisionId: "JDG-00000001",
      verdict: "satisfied" as const,
      verified: true,
      stateDigest: "abc",
      rationale: "r",
      elapsedMs: 1,
      usage: { input: 1, output: 0 },
    };
    const result = JSON.parse(
      (await executeEvidence(
        runtime,
        { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "a decision", observedAt: new Date().toISOString(), decisionId: "JDG-00000001", judgment: reported },
        tool,
      )).content,
    );
    // The caller claimed a satisfied verdict; the answers do not reach the
    // thresholds, so the plugin records an escalation instead.
    expect(result.verdict).toBe("escalate");
    expect(result.verified).toBe(false);
  });

  it("supports no canonical claim, whatever the claim says", () => {
    expect(claimSupported("judgment", "production healthy")).toEqual({ ok: false, reason: "claim exceeds judgment evidence strength" });
    expect(claimSupported("judgment", "deployed")).toEqual({ ok: false, reason: "claim exceeds judgment evidence strength" });
    expect(claimSupported("judgment", "end to end correctness")).toEqual({ ok: false, reason: "claim exceeds judgment evidence strength" });
  });
});
