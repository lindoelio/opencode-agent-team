import { describe, expect, it } from "vitest";
import { kindMeets, evidenceSatisfiesCriterion } from "../../src/domain/evidence.js";
import { REPORT_SHAPE_LINE, handoffsRunInParallel, validateResult } from "../../src/domain/handoff.js";
import { gateRecordFor, decisionsTraceable } from "../../src/domain/gates.js";
import { statusForPhase, validatePhaseTransition } from "../../src/domain/state-machine.js";
import { needsMigration, migrateUnknown, CURRENT_SCHEMA_VERSION, migrateV1toV2 } from "../../src/ledger/migrations.js";
import { project, renderProjectionYaml } from "../../src/ledger/projection.js";
import { containsSecret } from "../../src/ledger/redaction.js";
import type { AgentTeamProjectStateV2 } from "../../src/domain/schemas.js";

function baseState(): AgentTeamProjectStateV2 {
  return {
    schemaVersion: 4,
    engagementClass: "change",
    revision: 3,
    project: { id: "PRJ-X", canonicalDirectoryHash: "h" },
    engagement: { id: "ENG-X", createdAt: "t", updatedAt: "t", status: "VERIFYING", phase: "VERIFY" },
    outcome: "Ship the delivery",
    actors: ["user"],
    constraints: ["c1"],
    nonGoals: [],
    guardrails: [],
    assumptions: [{ id: "ASM-0001", statement: "s", basis: "INFERENCE", confidence: "low", impact: "i", sourceRefs: [] }],
    decisions: [{ id: "DEC-0001", title: "t", context: "c", drivers: ["d"], options: [{ name: "a", benefits: [], costs: [], risks: [] }, { name: "b", benefits: [], costs: [], risks: [] }], decision: "a", rationale: "r", consequences: [], reversibility: "easy", authority: "ALLOW", evidenceRefs: [], createdAt: "t" }],
    risks: [{ id: "R-1", statement: "risk!", severity: "critical" }],
    gates: [{ gate: "VERIFY", result: "FAIL", claim: "c", satisfied: [], missing: ["AC-1"], failed: [], waivers: [], nextAction: "n", evaluatedAt: "t" }],
    evidence: [],
    approvals: [{ id: "APR-0001", category: "release", requestedAction: "publish", resources: ["npm"], reason: "r", risks: [], status: "pending", createdAt: "t" }],
    waivers: [],
    handoffs: [],
    nextAction: { description: "Verify the delivery", owner: "team-leader/reviewer" },
  };
}

describe("domain extras", () => {
  it("bounds evidence by the declared kind", () => {
    expect(kindMeets("test", "test")).toBe(true);
    expect(kindMeets("visual", "test")).toBe(false);
    expect(kindMeets("runtime", "test")).toBe(true);
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "AC-1", kind: "test", status: "pass", summary: "s", command: "npm test", observedAt: "t", observed: true, limitations: [] })).toBe(true);
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "AC-1", kind: "test", status: "pass", summary: "s", observedAt: "t", limitations: [] })).toBe(false);
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "AC-1", kind: "test", status: "skipped", summary: "s", command: "npm test", observedAt: "t", limitations: [] })).toBe(false);
  });
  it("publishes one canonical report shape and validates results", () => {
    expect(REPORT_SHAPE_LINE).toContain("recommended_next_action");
    expect(REPORT_SHAPE_LINE).toContain("critical|high|medium|low|note");
    expect(() => validateResult({ status: "PASS", summary: "", findings: [], risks: [], unknowns: [], recommended_next_action: "x" })).toThrow();
    expect(() => validateResult({ status: "PASS", summary: "s", findings: [], risks: [], unknowns: [], recommended_next_action: "" })).toThrow();
    validateResult({ status: "ADVISORY", summary: "s", findings: [], risks: [], unknowns: [], recommended_next_action: "x" });
  });
  it("reads parallelism from the wave a booking belongs to", () => {
    expect(handoffsRunInParallel([{ wave: "WV-001" }, { wave: "WV-001" }])).toBe(true);
    expect(handoffsRunInParallel([{ wave: "WV-001" }, { wave: "WV-002" }])).toBe(false);
    expect(handoffsRunInParallel([{ wave: "WV-001" }])).toBe(false);
    // A handoff booked before waves existed carries no id and proves nothing.
    expect(handoffsRunInParallel([{}, {}])).toBe(false);
    expect(handoffsRunInParallel([])).toBe(false);
  });
  it("records gates and checks decision traceability", () => {
    const rec = gateRecordFor("ACCEPT", "done", { result: "PASS", satisfied: ["AC-1"], missing: [], failed: [], waivers: [], nextAction: "go" });
    expect(rec.gate).toBe("ACCEPT");
    expect(rec.evaluatedAt.length).toBeGreaterThan(0);
    expect(decisionsTraceable(baseState().decisions)).toBe(true);
    expect(decisionsTraceable([{ ...baseState().decisions[0]!, rationale: "" }])).toBe(false);
  });
  it("maps phases to statuses and rejects bad transitions", () => {
    expect(statusForPhase("INTENT")).toBe("DRAFT");
    expect(statusForPhase("VERIFY")).toBe("VERIFYING");
    expect(statusForPhase("REVIEW")).toBe("REVIEWING");
    expect(statusForPhase("ACCEPT")).toBe("ACCEPTED");
    expect(statusForPhase("DELIVER")).toBe("DELIVERY_READY");
    expect(statusForPhase("EXECUTE")).toBe("IN_PROGRESS");
    expect(() => validatePhaseTransition("INTENT", "PLAN")).toThrow();
    validatePhaseTransition("VERIFY", "VERIFY");
  });
  it("handles migrations", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    expect(needsMigration(4)).toBe(false);
    expect(needsMigration(3)).toBe(true);
    expect(needsMigration(2)).toBe(true);
    expect(needsMigration(1)).toBe(true);
    expect(migrateUnknown(baseState())).toEqual(baseState());
    expect(() => migrateUnknown({ schemaVersion: 9 })).toThrow();
    expect(() => migrateUnknown(null)).toThrow();
  });
  it("migrates a v1 state to the domain-neutral v2 vocabulary", () => {
    const v1 = {
      ...baseState(),
      schemaVersion: 1,
      engagement: { ...baseState().engagement, phase: "IMPLEMENT", status: "RELEASE_READY" },
      activeSlice: {
        id: "SLICE-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: ["i"], outOfScope: ["o"], allowedFiles: ["src/a.ts"], prohibitedFiles: ["src/b.ts"],
        acceptanceCriteria: ["AC-1"], validationCommands: ["npm test"], runtimeProof: ["flow works"],
        visualProof: ["screenshot"], risks: [], rollback: "revert", owner: "agent-team", status: "IN_PROGRESS",
      },
      gates: [{ gate: "SLICE", result: "PASS", claim: "c", satisfied: [], missing: [], failed: [], waivers: [], nextAction: "n", evaluatedAt: "t" }],
      handoffs: [{ id: "HND-0001", role: "builder", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", status: "prepared" }],
      modelProfile: { providerID: "opencode", modelID: "muse-spark-1.3", defaultVariant: "high", status: "READY" },
    };
    const v2 = migrateV1toV2(v1);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.engagement.phase).toBe("EXECUTE");
    expect(v2.engagement.status).toBe("DELIVERY_READY");
    expect(v2.activeDelivery?.id).toBe("SLICE-001");
    expect(v2.activeDelivery?.allowedScope).toEqual(["src/a.ts"]);
    expect(v2.activeDelivery?.prohibitedScope).toEqual(["src/b.ts"]);
    expect(v2.activeDelivery?.validationSteps).toEqual(["npm test"]);
    expect(v2.activeDelivery?.proof.map((p) => p.kind)).toEqual(["functional", "presentation"]);
    expect(v2.gates[0]?.gate).toBe("PLAN");
    expect(v2.handoffs[0]?.role).toBe("coder");
    expect(v2.handoffs[0]?.skills).toEqual([]);
    expect(v2.handoffs[0]?.dependsOn).toEqual([]);
    expect((v2 as Record<string, unknown>)["modelProfile"]).toBeUndefined();
    expect((v2 as Record<string, unknown>)["activeSlice"]).toBeUndefined();
  });
  it("projects compact state", () => {
    const p = project(baseState());
    expect(p.phase).toBe("VERIFY");
    expect(p.revision).toBe(3);
    expect(p.open_assumptions).toHaveLength(1);
    expect(p.decisions).toEqual(["DEC-0001"]);
    expect(p.pending_approvals).toHaveLength(1);
    expect(p.critical_risks).toHaveLength(1);
    expect(p.handoffs_completed).toEqual([]);
    expect(p.handoffs_open).toEqual([]);
    expect(p.missing_independent_review).toBe(true);
    const yaml = renderProjectionYaml(p);
    expect(yaml).toContain("phase: VERIFY");
    expect(yaml).toContain("revision: 3");
    expect(yaml).toContain("missing_independent_review: true");
    const reviewed = project({ ...baseState(), handoffs: [
      { id: "HND-0001", role: "coder", objective: "o", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed", sessionID: "ses_coder" },
      { id: "HND-0002", role: "reviewer", objective: "o", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed", sessionID: "ses_reviewer" },
    ] });
    expect(reviewed.missing_independent_review).toBe(false);
    expect(reviewed.handoffs_completed).toEqual(["HND-0001:coder", "HND-0002:reviewer"]);
    expect(renderProjectionYaml(reviewed)).toContain("missing_independent_review: false");
    const noDelivery = project({ ...baseState(), activeDelivery: undefined });
    expect(noDelivery.active_delivery).toBeUndefined();
  });
  it("lists criterion gaps with the observed flag", () => {
    const state = baseState();
    state.activeDelivery = {
      id: "DEL-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
      inScope: [], outOfScope: [], allowedScope: ["src/**"], prohibitedScope: [],
      acceptanceCriteria: ["AC-1", "AC-2"], validationSteps: [{ criterionId: "AC-1", command: "npm test" }], proof: [],
      risks: [], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
    };
    state.evidence = [
      { id: "E1", criterionId: "AC-1", kind: "test", status: "pass", summary: "s", command: "npm test", observedAt: "t", observed: true, limitations: [] },
    ];
    const p = project(state);
    expect(p.criteria).toEqual(["AC-1: satisfied (observed)", "AC-2: missing"]);
  });
  it("derives ready and blocked handoffs from the dependency graph", () => {
    const wave = project({
      ...baseState(),
      handoffs: [
        { id: "HND-0001", role: "explorer", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
        { id: "HND-0002", role: "coder", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: ["HND-0003"], status: "prepared" },
        { id: "HND-0003", role: "worker", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "prepared" },
      ],
    });
    expect(wave.handoffs_ready).toEqual(["HND-0003:worker"]);
    expect(wave.handoffs_blocked).toEqual(["HND-0002:coder (needs HND-0003)"]);
    expect(renderProjectionYaml(wave)).toContain("handoffs_ready: [HND-0003:worker]");
  });
  it("detects secrets", () => {
    expect(containsSecret({ api_key: "x" })).toBe(true);
    expect(containsSecret("Bearer abcdefghijklmnop")).toBe(true);
    expect(containsSecret({ note: "hello world" })).toBe(false);
  });
});
