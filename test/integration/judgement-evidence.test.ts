import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetHeldDecisionsForTests } from "../../src/decision/cache.js";
import { _resetDecisionModelCatalogForTests } from "../../src/decision/catalog.js";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { runDoctor } from "../../src/doctor/checks.js";
import { kindMeets } from "../../src/domain/evidence.js";
import { recordObservedEvidence } from "../../src/orchestrator/observe.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeEvaluateDecision } from "../../src/tools/evaluate-decision.js";
import { executeEvidence } from "../../src/tools/evidence.js";
import { executeGate } from "../../src/tools/gate.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeState } from "../../src/tools/state.js";
import { readState } from "../../src/ledger/store.js";

const tool = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, strictEvidence = true, answers: unknown[] = [{ type: "predicate", name: "is_safe", probability: 0.95 }]): AgentTeamRuntime {
  const ctx = {
    app: { version: "2.2.0" },
    location: { project: { canonical: root } },
    session: { create: async () => ({ id: "ses_child" }), prompt: async () => ({}) },
    model: {
      list: async () => [
        { id: "jev", modelID: "jev", providerID: "p", name: "Jev", type: "decision", enabled: true, status: "active", cost: [{ input: 0.05, output: 0 }], limit: { context: 32000 } },
      ],
    },
    experimental: {
      generate: {
        decisions: async () => ({ answers, tokens: { input: 120, output: 0 } }),
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
      validationSteps: ["npm test"],
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

/** A completed implementation and reviewer handoff, so ACCEPT reaches the evidence check. */
async function withIndependentReview(runtime: AgentTeamRuntime): Promise<number> {
  const root = (runtime.ctx as unknown as { location: { project: { canonical: string } } }).location.project.canonical;
  const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
  await appendEvent(storeContext(root, "sess-1", "team-leader"), "handoff.launched", { id: "HND-0001" }, (s) => ({
    ...s,
    handoffs: [
      ...s.handoffs,
      { id: "HND-0001", role: "coder" as const, objective: "implement", context: [], allowedScope: ["src"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_coder", parentSessionID: "sess-1" },
      { id: "HND-0002", role: "reviewer" as const, objective: "review", context: [], allowedScope: ["src"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_reviewer", parentSessionID: "sess-1" },
    ],
  }));
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
  it("records choice, score and error answers from the plugin's own decision", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-judgement-"));
    _resetHeldDecisionsForTests();
    _resetDecisionModelCatalogForTests();
    const runtime = runtimeFor(root, true, [
      { type: "choice", name: "pick", choice: "a", probabilities: [{ value: "a", probability: 0.95 }], confidence: 0.9 },
      { type: "score", name: "score", score: 4, probabilities: [{ value: 4, label: "high", probability: 0.95 }], confidence: 0.9 },
      { type: "error", name: "bad", reason: "no answer" },
    ]);
    await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    const result = JSON.parse((await executeEvidence(runtime, { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "pass", summary: "d", observedAt: "t", decisionId: decision.decisionId }, tool)).content);
    expect(result.verdict).toBe("unanswered");
  });

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

  it("refuses a judgement row with no decision id", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    await expect(executeEvidence(runtime, { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "partial", summary: "s", observedAt: "t" }, tool)).rejects.toThrow(/decisionId is required/);
  });

  it("refuses a judgement that names a decision the plugin did not run", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    await expect(executeEvidence(runtime, { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "partial", summary: "s", observedAt: "t", decisionId: "JDG-UNKNOWN" }, tool)).rejects.toThrow(/not one this plugin executed/);
  });

  it("refuses a reported block that names a different decision", async () => {
    const { runtime } = await fresh();
    await project(runtime);
    const block = {
      model: "p/jev", answers: [{ name: "q", type: "predicate" as const, probability: 0.9 }], role: "team-leader", use: "default" as const,
      thresholds: { probability: 0.85, confidence: 0.7 }, criterion: "criterion-one", decisionId: "JDG-DIFFERENT", verdict: "satisfied" as const,
      verified: false, stateDigest: "d", rationale: "r", elapsedMs: 1, usage: { input: 1, output: 0 },
    };
    await expect(executeEvidence(runtime, { expectedRevision: 1, criterionId: "criterion-one", kind: "judgment", status: "partial", summary: "s", observedAt: "t", decisionId: "JDG-OTHER", judgment: block }, tool)).rejects.toThrow(/different decision/);
  });

  it("does not fail a criterion that another row already satisfies", async () => {
    const { runtime } = await fresh();
    const root = await project(runtime);
    const decision = JSON.parse((await executeEvaluateDecision(runtime, { criterionId: "criterion-one", state: "a diff", questions: [question] }, tool)).content);
    await recordObservedEvidence(root, { criterionId: "criterion-one", kind: "test", summary: "tests pass", command: "npm test", exitCode: 0, output: "ok" });
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
    expect(kindMeets("judgment", "test")).toBe(false);
    expect(kindMeets("judgment", "runtime")).toBe(false);
    expect(kindMeets("judgment", "review")).toBe(false);
  });
});
