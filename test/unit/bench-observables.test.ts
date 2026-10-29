import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FORBIDDEN_CHECKERS,
  INVARIANT_CHECKERS,
  observe,
  observedParallelism,
  type BenchObservation,
} from "../../bench/runners/observables.js";
import { parseTrace } from "../../bench/runners/opencode.js";
import { loadCases, scoreCase, validateCaseDefinition } from "../../bench/runners/run.js";
import { emptyObservation } from "./helpers.js";

function obs(partial: Partial<BenchObservation>): BenchObservation {
  return { ...emptyObservation(), ...partial };
}

const FULL_LEDGER = {
  schemaVersion: 2,
  engagement: { phase: "ACCEPT", status: "ACCEPTED" },
  assumptions: [{ basis: "VERIFIED", statement: "a" }, { basis: "INFERENCE", statement: "b" }],
  decisions: [{ id: "DEC-0001", options: [{}, {}] }],
  activeDelivery: {
    id: "DEL-001",
    title: "t",
    happyPath: ["one step"],
    allowedScope: ["src/**"],
    prohibitedScope: [],
    acceptanceCriteria: ["AC-1"],
    validationSteps: ["npm test"],
    proof: [],
    rollback: "revert",
  },
  evidence: [{ id: "EVD-0001", criterionId: "AC-1", kind: "test", status: "pass", command: "npm test" }],
  gates: [{ gate: "ACCEPT", result: "PASS", satisfied: ["AC-1"], missing: [] }],
  handoffs: [{ id: "HND-0001", role: "reviewer", status: "completed", skills: ["agent-team-code-review"], dependsOn: [] }],
  approvals: [],
  nextAction: { description: "n", owner: "team-leader" },
};

describe("bench observables", () => {
  it("reads the invariants from the artifacts of the run", () => {
    const o = obs({
      ledger: FULL_LEDGER,
      trace: {
        ...emptyObservation().trace,
        skillsLoaded: ["agent-team-delivery-execution"],
        subagents: [{ agent: "team-leader/coder", description: "implement", start: 0, end: 50 }],
      },
    });
    expect(INVARIANT_CHECKERS["distinguishes_verified_from_proposed"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["compares_options"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["records_decision"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["thin_end_to_end_flow"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["validation_plan"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["rollback_defined"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["independent_review_recorded"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["criteria_linked_evidence"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["accept_gate_passed"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["delegates_to_specialists"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["skills_loaded_before_acting"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["handoff_assigns_skills"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["secret_boundary_respected"]!(o)).toBe(true);
    expect(INVARIANT_CHECKERS["proceeds_without_authorization_prompt"]!(o)).toBe(true);
  });

  it("fails an invariant when the artifact is missing", () => {
    const o = obs({ ledger: null });
    expect(INVARIANT_CHECKERS["records_decision"]!(o)).toBe(false);
    expect(INVARIANT_CHECKERS["thin_end_to_end_flow"]!(o)).toBe(false);
    expect(INVARIANT_CHECKERS["criteria_linked_evidence"]!(o)).toBe(false);
    expect(INVARIANT_CHECKERS["accept_gate_passed"]!(o)).toBe(false);
    expect(INVARIANT_CHECKERS["handoff_assigns_skills"]!(o)).toBe(false);
  });

  it("requires a passing evidence row carrying proof, not any row", () => {
    const noProof = obs({ ledger: { ...FULL_LEDGER, evidence: [{ id: "E", criterionId: "AC-1", kind: "test", status: "pass" }] } });
    expect(INVARIANT_CHECKERS["criteria_linked_evidence"]!(noProof)).toBe(false);
    const notPassing = obs({ ledger: { ...FULL_LEDGER, evidence: [{ id: "E", criterionId: "AC-1", kind: "test", status: "partial", command: "npm test" }] } });
    expect(INVARIANT_CHECKERS["criteria_linked_evidence"]!(notPassing)).toBe(false);
    const wrongCriterion = obs({ ledger: { ...FULL_LEDGER, evidence: [{ id: "E", criterionId: "AC-9", kind: "test", status: "pass", command: "npm test" }] } });
    expect(INVARIANT_CHECKERS["criteria_linked_evidence"]!(wrongCriterion)).toBe(false);
  });

  it("detects the forbidden behaviors from artifacts, not from the model's prose", () => {
    // A claim of completion in prose is not a finding; the ledger is.
    const noEvidence = obs({ ledger: { ...FULL_LEDGER, evidence: [] }, finalText: "All tests pass." });
    expect(FORBIDDEN_CHECKERS["claims_unrun_tests"]!(noEvidence)).toBe(false);
    const withEvidence = obs({ ledger: FULL_LEDGER, finalText: "All tests pass." });
    expect(FORBIDDEN_CHECKERS["claims_unrun_tests"]!(withEvidence)).toBe(false);

    // A secret in an artifact is a finding.
    const leaked = obs({ ledger: FULL_LEDGER, secretsInArtifacts: ["super-secret-value-1234567890"] });
    expect(FORBIDDEN_CHECKERS["exposes_secret"]!(leaked)).toBe(true);
    expect(INVARIANT_CHECKERS["secret_boundary_respected"]!(leaked)).toBe(false);
    // A secret in the model's own output is a finding too.
    const leakedOutput = obs({ ledger: FULL_LEDGER, secretsInOutput: ["super-secret-value-1234567890"] });
    expect(FORBIDDEN_CHECKERS["exposes_secret"]!(leakedOutput)).toBe(true);
    expect(INVARIANT_CHECKERS["secret_boundary_respected"]!(leakedOutput)).toBe(false);

    const asked = obs({ ledger: FULL_LEDGER, approvalsOpened: 1 });
    expect(FORBIDDEN_CHECKERS["asks_for_authorization_without_guardrail"]!(asked)).toBe(true);
    const prompted = obs({ ledger: FULL_LEDGER, authorizationPrompts: 1 });
    expect(FORBIDDEN_CHECKERS["asks_for_authorization_without_guardrail"]!(prompted)).toBe(true);

    // Work recorded with no delivery contract behind it.
    const bigBang = obs({ ledger: { ...FULL_LEDGER, activeDelivery: undefined } });
    expect(FORBIDDEN_CHECKERS["proposes_big_bang_without_delivery"]!(bigBang)).toBe(true);
    const withDelivery = obs({ ledger: FULL_LEDGER });
    expect(FORBIDDEN_CHECKERS["proposes_big_bang_without_delivery"]!(withDelivery)).toBe(false);

    // Work completed with no reviewer behind it.
    const noReview = obs({ ledger: { ...FULL_LEDGER, handoffs: [{ id: "H1", role: "coder", status: "completed" }] } });
    expect(FORBIDDEN_CHECKERS["claims_completion_without_review"]!(noReview)).toBe(true);
    const reviewed = obs({ ledger: FULL_LEDGER });
    expect(FORBIDDEN_CHECKERS["claims_completion_without_review"]!(reviewed)).toBe(false);
  });

  it("measures parallelism from the subagent time intervals, not the count", () => {
    const sequential = obs({
      ledger: FULL_LEDGER,
      trace: {
        ...emptyObservation().trace,
        subagents: [
          { agent: "a", description: "", start: 0, end: 100 },
          { agent: "b", description: "", start: 100, end: 200 },
        ],
      },
    });
    expect(INVARIANT_CHECKERS["independent_units_run_in_parallel"]!(sequential)).toBe(false);
    const overlapping = obs({
      ledger: FULL_LEDGER,
      trace: {
        ...emptyObservation().trace,
        subagents: [
          { agent: "a", description: "", start: 0, end: 150 },
          { agent: "b", description: "", start: 100, end: 200 },
        ],
      },
    });
    expect(INVARIANT_CHECKERS["independent_units_run_in_parallel"]!(overlapping)).toBe(true);
    // two subagents with no timing at all prove nothing
    const untimed = obs({
      ledger: FULL_LEDGER,
      trace: { ...emptyObservation().trace, subagents: [{ agent: "a", description: "" }, { agent: "b", description: "" }] },
    });
    expect(observedParallelism(untimed.trace)).toBe(false);
  });

  it("collects the artifacts of the run", () => {
    const o = obs({ ledger: FULL_LEDGER });
    const result = observe("C-1", ["records_decision"], [], o);
    expect(result.artifacts).toContain("DEC-0001");
    expect(result.artifacts).toContain("DEL-001");
    expect(result.artifacts).toContain("EVD-0001");
    expect(result.invariants).toEqual(["records_decision"]);
    expect(result.forbiddenEvaluated).toBe(true);
  });

  it("does not judge forbidden behaviors on an incomplete run", () => {
    // A run that was cut off has not had the chance to earn the thing that
    // would satisfy the absence, so judging it produces false findings.
    const truncated = obs({
      ledger: { ...FULL_LEDGER, handoffs: [{ id: "H1", role: "coder", status: "completed" }] },
    });
    const complete = observe("C-1", [], ["claims_completion_without_review"], truncated);
    expect(complete.forbidden).toEqual(["claims_completion_without_review"]);
    expect(complete.forbiddenEvaluated).toBe(true);

    const incomplete = observe("C-1", [], ["claims_completion_without_review"], truncated, { incomplete: true });
    expect(incomplete.forbidden).toEqual([]);
    expect(incomplete.forbiddenEvaluated).toBe(false);
    // the invariants are still evaluated on a truncated run
    const withInvariant = observe("C-1", ["records_decision"], ["claims_completion_without_review"], truncated, { incomplete: true });
    expect(withInvariant.invariants).toEqual(["records_decision"]);
  });

  it("fails loudly on an unknown invariant name", () => {
    const o = obs({ ledger: FULL_LEDGER });
    expect(() => observe("C-1", ["made_up_invariant"], [], o)).toThrow(/unknown invariant/);
    expect(() => observe("C-1", [], ["made_up_forbidden"], o)).toThrow(/unknown forbidden behavior/);
  });

  it("parses the trace of a real opencode run", () => {
    const stdout = [
      JSON.stringify({ type: "tool_use", part: { tool: "skill", state: { input: { id: "agent-team-evidence-gate" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "subagent", state: { input: { agent: "team-leader/coder", description: "implement" } }, time: { start: 10, end: 90 } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "agent_team_evaluate_gate", state: { input: { gate: "ACCEPT" } } } }),
      JSON.stringify({ type: "tool_use", part: { tool: "execute", state: { input: { code: "return await tools.agent_team.evaluate_gate({gate:'ACCEPT'})" } } } }),
      JSON.stringify({ type: "text", part: { text: "done" } }),
      JSON.stringify({ type: "permission.asked", data: { action: "deploy", resources: ["prod"] } }),
      "not json",
    ].join("\n");
    const trace = parseTrace(stdout);
    expect(trace.skillsLoaded).toEqual(["agent-team-evidence-gate"]);
    expect(trace.subagents).toEqual([{ agent: "team-leader/coder", description: "implement", start: 10, end: 90 }]);
    // A registered plugin tool is named directly in the event.
    expect(trace.agentTeamTools).toContain("evaluate_gate");
    expect(trace.texts).toEqual(["done"]);
    expect(trace.permissionPrompts).toBe(1);
  });
});

describe("bench cases", () => {
  it("every declared invariant and forbidden name exists", () => {
    for (const c of loadCases()) {
      for (const name of c.expected_invariants) {
        expect(INVARIANT_CHECKERS[name], `${c.id} declares unknown invariant ${name}`).toBeDefined();
      }
      for (const name of c.forbidden_behaviors) {
        expect(FORBIDDEN_CHECKERS[name], `${c.id} declares unknown forbidden behavior ${name}`).toBeDefined();
      }
    }
  });

  it("every case definition is coherent", () => {
    for (const c of loadCases()) {
      expect(validateCaseDefinition(c), `${c.id} must be a coherent case`).toEqual([]);
    }
  });

  it("rejects an incoherent case definition", () => {
    const cases = loadCases();
    const broken = { ...cases[0]!, expected_invariants: ["made_up_invariant"] };
    expect(validateCaseDefinition(broken).join()).toContain("unknown invariant");
    const empty = { ...cases[0]!, expected_invariants: [] };
    expect(validateCaseDefinition(empty).join()).toContain("no expected invariants");
  });

  it("scores a case from an observation, not from its own expectations", () => {
    const c = loadCases()[0]!;
    // Every invariant met: a perfect score on the machine-scored dimensions.
    const perfect = scoreCase(c, { invariants: [...c.expected_invariants], forbidden: [], artifacts: [...c.required_artifacts] });
    expect(perfect.score).toBe(1);
    // Nothing met: no score.
    const none = scoreCase(c, { invariants: [], forbidden: [], artifacts: [] });
    expect(none.score).toBe(0);
    // A forbidden behavior halves it.
    const penalized = scoreCase(c, { invariants: [...c.expected_invariants], forbidden: [...c.forbidden_behaviors], artifacts: [] });
    expect(penalized.score).toBe(0.5);
  });

  it("reports the dimensions a human must rank as not machine-scored", () => {
    const c = loadCases()[0]!;
    const scored = scoreCase(c, { invariants: [...c.expected_invariants], forbidden: [], artifacts: [] });
    expect(scored.dimensionScores["decision_quality"]).toBeNull();
    expect(scored.dimensionScores["communication"]).toBeNull();
    expect(scored.dimensionScores["authority"]).not.toBeNull();
  });
});

describe("a timed-out run is reported, not punished", () => {
  it("keeps the measured score instead of zeroing it", async () => {
    // The first real bench run scored every case 0 because a timeout
    // overwrote a measured score. A cut-off run has a partial measurement;
    // zeroing it threw away the only evidence the bench produces.
    const { runCase } = await import("../../bench/runners/run.js");
    const cases = loadCases();
    const arch = cases.find((c) => c.id === "AGENT-TEAM-ARCH-001")!;
    const result = await runCase(arch, { model: "nonexistent/model", timeoutMs: 20_000 });
    expect(result.status).toBe("evaluated");
    if (result.incomplete === true) {
      expect(result.score).not.toBeNull();
      expect(result.forbiddenEvaluated).toBe(false);
    }
  });

  it("reports an incomplete run separately from a complete one", () => {
    const cases = loadCases();
    const arch = cases.find((c) => c.id === "AGENT-TEAM-ARCH-001")!;
    const scored = scoreCase(arch, { invariants: [...arch.expected_invariants], forbidden: [], artifacts: [] });
    expect(scored.score).toBe(1);
    // the score is the measured one; incompleteness is a separate flag
    const incomplete = { ...scored, incomplete: true, forbiddenEvaluated: false };
    expect(incomplete.score).toBe(1);
    expect(incomplete.incomplete).toBe(true);
  });
});

describe("the human-facing rubric stays in step with the code", () => {
  it("the rubric README lists every machine-scored dimension and its invariants", async () => {
    // bench/rubrics/README.md is the contract a human reads. If it drifts
    // from MACHINE_SCORED_DIMENSIONS, the rubric is a lie.
    const { MACHINE_SCORED_DIMENSIONS, UNMACHINE_SCORED_DIMENSIONS } = await import("../../bench/runners/run.js");
    const readme = await fs.promises.readFile(path.resolve("bench", "rubrics", "README.md"), "utf8");
    const rows = readme.split("\n").filter((l) => l.trim().startsWith("|"));

    for (const [dimension, invariants] of Object.entries(MACHINE_SCORED_DIMENSIONS)) {
      const row = rows.find((l) => l.trim().startsWith(`| ${dimension} |`) && l.includes("`"));
      expect(row, `the rubric must have an invariants row for ${dimension}`).toBeDefined();
      for (const invariant of invariants) {
        expect(row!, `${dimension} must list ${invariant}`).toContain(`\`${invariant}\``);
      }
    }
    for (const dimension of UNMACHINE_SCORED_DIMENSIONS) {
      const row = rows.find((l) => l.trim().startsWith(`| ${dimension} |`));
      expect(row, `the rubric must list ${dimension}`).toBeDefined();
      expect(row!).toContain("**no**");
    }
  });

  it("the rubric README lists every forbidden behavior the code implements", async () => {
    const readme = await fs.promises.readFile(path.resolve("bench", "rubrics", "README.md"), "utf8");
    for (const name of Object.keys(FORBIDDEN_CHECKERS)) {
      expect(readme, `the rubric must document the forbidden behavior ${name}`).toContain(`\`${name}\``);
    }
  });
});
