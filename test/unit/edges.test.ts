import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathAllowed, pathInScope, pathProhibited, scopeOverlaps } from "../../src/domain/scope.js";
import { evaluateAcceptGate, independentReviewCheck } from "../../src/domain/gates.js";
import { forbiddenClaim, claimSupported, evidenceSatisfiesCriterion } from "../../src/domain/evidence.js";
import { validatePhaseTransition, canTransitionStatus, statusForPhase } from "../../src/domain/state-machine.js";
import { risksFromResult, validateResult } from "../../src/domain/handoff.js";
import { parseOptions } from "../../src/options.js";
import { skillDisplayName, frontmatterName, frontmatterDescription } from "../../src/catalog/skills.js";
import { parseCommandArgs } from "../../src/catalog/commands.js";

/**
 * The remaining branches: scope matching edge cases, the gate's claim and
 * traceability checks, and the option and catalog parsers.
 */

describe("scope matching, the awkward cases", () => {
  it("matches a bare subtree pattern", () => {
    expect(pathInScope("anything/at/all.ts", "/**")).toBe(true);
    expect(pathInScope("src/a.ts", "./src/**")).toBe(true);
  });

  it("treats a plain directory as covering its files", () => {
    expect(pathInScope("docs/notes.md", "docs")).toBe(true);
    expect(pathInScope("docs/nested/notes.md", "docs")).toBe(true);
    expect(pathInScope("docsx/notes.md", "docs")).toBe(false);
  });

  it("matches an exact path only", () => {
    expect(pathInScope("src/board.ts", "src/board.ts")).toBe(true);
    expect(pathInScope("src/board.tsx", "src/board.ts")).toBe(false);
    expect(pathInScope("", "src/**")).toBe(false);
  });

  it("detects prohibited paths", () => {
    expect(pathProhibited("src/secret.ts", ["src/**"])).toBe(true);
    expect(pathProhibited("src/secret.ts", [])).toBe(false);
  });

  it("detects overlap between a subtree and a plain path", () => {
    expect(scopeOverlaps(["src/**"], ["src/a.ts"])).toBe(true);
    expect(scopeOverlaps(["src/a.ts"], ["src/**"])).toBe(true);
    expect(scopeOverlaps(["docs/**"], ["src/a.ts"])).toBe(false);
    expect(scopeOverlaps(["src/a.ts"], ["src/b.ts"])).toBe(false);
    expect(scopeOverlaps(["src/a.ts"], ["src/a.ts/b.ts"])).toBe(true);
    expect(scopeOverlaps(["src/**"], ["src/**"])).toBe(true);
  });

  it("allows everything when no scope is declared", () => {
    expect(pathAllowed("anything.ts", [])).toBe(true);
  });
});

describe("the gate's claim and traceability checks", () => {
  const evidence = [
    { id: "E", criterionId: "AC-1", kind: "test" as const, status: "pass" as const, summary: "s", command: "npm test", observedAt: "t", limitations: [] },
  ];

  it("refuses a claim the evidence kind cannot support", () => {
    const result = evaluateAcceptGate({
      criteria: ["AC-1"],
      evidence,
      findings: [],
      claim: "production ready",
    });
    expect(result.result).toBe("FAIL");
    expect(result.missing).toContain("claim-evidence-strength");
    expect(result.nextAction).toContain("Weaken the claim");
  });

  it("accepts a claim the evidence kind can support", () => {
    const result = evaluateAcceptGate({ criteria: ["AC-1"], evidence, findings: [], claim: "the flow works" });
    expect(result.result).toBe("PASS");
  });

  it("refuses an untraceable decision", () => {
    const result = evaluateAcceptGate({
      criteria: ["AC-1"],
      evidence,
      findings: [],
      decisions: [{ id: "D", title: "t", context: "c", drivers: [], options: [{ name: "a", benefits: [], costs: [], risks: [] }], decision: "a", rationale: "r", consequences: [], reversibility: "easy", authority: "ALLOW", evidenceRefs: [], createdAt: "t" }],
    });
    expect(result.result).toBe("FAIL");
    expect(result.missing).toContain("traceable-decisions");
  });

  it("accepts a partial row only when partial evidence is allowed", () => {
    const partial = [{ ...evidence[0]!, status: "partial" as const }];
    expect(evaluateAcceptGate({ criteria: ["AC-1"], evidence: partial, findings: [] }).result).toBe("FAIL");
    expect(evaluateAcceptGate({ criteria: ["AC-1"], evidence: partial, findings: [], acceptPartial: true }).result).toBe("PASS");
  });

  it("blocks when a blocker is present and nothing has failed", () => {
    const result = evaluateAcceptGate({ criteria: ["AC-1"], evidence: [], findings: [], blockedBy: ["waiting on a credential"] });
    expect(result.result).toBe("BLOCKED");
    expect(result.nextAction).toContain("waiting on a credential");
  });
});

describe("the evidence strength helpers", () => {
  it("names the reason a claim is forbidden for a kind", () => {
    expect(forbiddenClaim("test", "the service is end to end healthy")).toBeDefined();
    expect(forbiddenClaim("test", "the flow works")).toBeUndefined();
    expect(claimSupported("test", "the flow works").ok).toBe(false);
    expect(claimSupported("test", "covered units pass").ok).toBe(true);
  });

  it("requires proof for a passing evidence row", () => {
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "C", kind: "test", status: "pass", summary: "s", observedAt: "t", limitations: [] })).toBe(false);
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "C", kind: "test", status: "pass", summary: "s", digest: "d", observedAt: "t", limitations: [] })).toBe(true);
  });
});

describe("the state machine edges", () => {
  it("refuses an invalid phase transition", () => {
    expect(() => validatePhaseTransition("INTENT", "PLAN")).toThrow(/invalid phase transition/);
  });

  it("refuses an illegal status transition", () => {
    expect(canTransitionStatus("DELIVERED", "IN_PROGRESS")).toBe(false);
  });

  it("maps every phase to a status", () => {
    for (const phase of ["INTENT", "DISCOVER", "FRAME", "DECIDE", "PLAN", "EXECUTE", "VERIFY", "REVIEW", "ACCEPT", "DELIVER"] as const) {
      expect(statusForPhase(phase).length).toBeGreaterThan(0);
    }
  });
});

describe("the specialist result", () => {
  it("rejects a result that does not match the closed shape", () => {
    expect(() => validateResult({ status: "PASS", summary: "s", findings: [], risks: [], unknowns: [] })).toThrow(/invalid specialist result/);
  });

  it("maps a reported risk to a ledger risk with the strongest finding severity", () => {
    const risks = risksFromResult(
      { status: "FAIL", summary: "s", findings: [{ severity: "critical", claim: "c", evidence: [] }], risks: ["the API leaks"], unknowns: [], recommended_next_action: "n" },
      1,
    );
    expect(risks).toHaveLength(1);
    expect(risks[0]?.severity).toBe("critical");
    expect(risks[0]?.id).toBe("RSK-0001");
  });

  it("defaults a risk with no severe finding to medium", () => {
    const risks = risksFromResult(
      { status: "ADVISORY", summary: "s", findings: [{ severity: "note", claim: "c", evidence: [] }], risks: ["watch this"], unknowns: [], recommended_next_action: "n" },
      5,
    );
    expect(risks[0]?.severity).toBe("medium");
    expect(risks[0]?.id).toBe("RSK-0005");
  });
});

describe("the option and catalog parsers", () => {
  it("rejects telemetry and keeps the defaults", () => {
    expect(() => parseOptions({ telemetry: true })).toThrow(/telemetry/);
    const options = parseOptions({});
    expect(options.autonomy?.mode).toBe("yolo");
    expect(options.orchestration?.maxParallelSpecialists).toBe(6);
    expect(options.strictEvidence).toBe(true);
  });

  it("derives a display name and falls back on a missing frontmatter", () => {
    expect(skillDisplayName("agent-team-delivery-scope")).toBe("Agent Team Delivery Scope");
    expect(skillDisplayName("something-else")).toBe("Agent Team Something Else");
    expect(frontmatterName("no frontmatter")).toBe("Agent Team Skill");
    expect(frontmatterDescription("no frontmatter")).toBe("");
  });

  it("parses command arguments, including quoted values", () => {
    const parsed = parseCommandArgs("--add 'deploy production' --clear --mode=guarded");
    expect(parsed.flags.has("add")).toBe(true);
    expect(parsed.flags.has("clear")).toBe(true);
    expect(parsed.get("add")).toBe("deploy production");
    expect(parsed.get("mode")).toBe("guarded");
    expect(parsed.positional).toEqual([]);
  });
});

describe("the independent review check", () => {
  it("names the reason when no reviewer has run", () => {
    expect(independentReviewCheck([]).reason).toContain("no completed");
  });

  it("refuses a reviewer with no scope when work was implemented", () => {
    const check = independentReviewCheck([
      { id: "H1", role: "coder", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
      { id: "H2", role: "reviewer", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", skills: [], dependsOn: [], status: "completed" },
    ]);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toContain("no allowed scope");
  });
});

describe("the file layout the plugin owns", () => {
  it("keeps every ledger document inside the project root", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-layout-"));
    const { writeDecisionDoc } = await import("../../src/ledger/store.js");
    // a relative id that climbs out of the project root is refused
    await expect(writeDecisionDoc(root, "../../../escape", "x")).rejects.toThrow(/escapes project root/);
    // an id that stays inside a subdirectory is fine
    const abs = await writeDecisionDoc(root, "DEC-0001", "x");
    expect(abs.startsWith(root)).toBe(true);
  });
});
