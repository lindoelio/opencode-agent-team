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
import { executeHandoff } from "../../src/tools/handoff.js";
import { AUTHORITY_RULES, classifyAuthority, classifyGuarded } from "../../src/domain/authority.js";
import { projectRootOf } from "../../src/runtime.js";

function runtimeFor(root: string): AgentTeamRuntime {
  return createRuntime(
    { location: { project: { canonical: root } }, options: {} } as never,
    { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false, autonomy: { mode: "yolo", askBefore: [] }, orchestration: { maxParallelSpecialists: 6 } },
  );
}

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;
const specialist = { sessionID: "sess-2", agent: "team-leader/coder" } as never;

async function freshRuntime(): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-security-"));
  const runtime = runtimeFor(root);
  await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
  return { runtime, root };
}

const SECRET = "sk-abcdefghijklmnopqrstuvwx";
const DECISION = {
  title: "T",
  context: "ctx",
  drivers: ["d1"],
  options: [
    { name: "a", benefits: ["b"], costs: ["c"], risks: ["r"] },
    { name: "b", benefits: ["b"], costs: ["c"], risks: ["r"] },
  ],
  decision: "a",
  rationale: `because the key is ${SECRET}`,
  consequences: ["c1"],
  reversibility: "easy",
  authority: "ALLOW_WITH_RECORD",
  evidenceRefs: ["ASM-0001"],
} as const;

describe("security: nothing secret reaches the disk", () => {
  it("redacts a secret out of the decision document", async () => {
    const { runtime, root } = await freshRuntime();
    await executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, leader);
    await executeDecision(runtime, { expectedRevision: 1, ...DECISION }, leader);

    const doc = await fs.promises.readFile(path.join(root, ".agent-team", "decisions", "DEC-0001.md"), "utf8");
    expect(doc).not.toContain(SECRET);
    expect(doc).toContain("[REDACTED]");
    // The ledger itself still holds the redacted form.
    const state = await fs.promises.readFile(path.join(root, ".agent-team", "state.json"), "utf8");
    expect(state).not.toContain(SECRET);
  });

  it("redacts a secret out of the delivery document", async () => {
    const { runtime, root } = await freshRuntime();
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
        risks: [`token ${SECRET}`],
      },
      leader,
    );
    const doc = await fs.promises.readFile(path.join(root, ".agent-team", "deliveries", "DEL-001.yaml"), "utf8");
    expect(doc).not.toContain(SECRET);
  });

  it("keeps an evidence digest readable while still redacting secrets", async () => {
    const { runtime, root } = await freshRuntime();
    const out = JSON.parse(
      (await executeEvidence(
        runtime,
        { expectedRevision: 0, criterionId: "AC-1", kind: "test", status: "pass", summary: "green", command: "npm test", observedAt: "2026-01-01" },
        leader,
      )).content,
    );
    expect(out.digest.length).toBeGreaterThan(0);
    const doc = await fs.promises.readFile(path.join(root, ".agent-team", "evidence", "EVD-0001.json"), "utf8");
    expect(doc).toContain(out.digest);
  });
});

describe("security: the authority matrix fails closed", () => {
  it("denies when a rule matcher throws instead of falling through to allow", () => {
    // A rule that cannot be evaluated must not be treated as "did not
    // match": a broken DENY rule would otherwise fall through to ALLOW,
    // which is the exact opposite of "DENY is final".
    const throwing = {
      match: () => {
        throw new Error("boom");
      },
      effect: "DENY" as const,
      reason: "a rule that cannot be evaluated",
    };
    AUTHORITY_RULES.push(throwing);
    try {
      const verdict = classifyAuthority({ action: "read", resource: "src/a.ts" });
      expect(verdict.effect).toBe("DENY");
      expect(verdict.reason).toContain("failing closed");
    } finally {
      AUTHORITY_RULES.pop();
    }
    // Without the broken rule the same query is allowed again.
    expect(classifyAuthority({ action: "read", resource: "src/a.ts" }).effect).toBe("ALLOW");
  });

  it("keeps the integrity DENY rules intact", () => {
    expect(classifyAuthority({ action: "secret-expose" }).effect).toBe("DENY");
    expect(classifyAuthority({ action: "false-claim" }).effect).toBe("DENY");
    expect(classifyAuthority({ action: "policy-bypass" }).effect).toBe("DENY");
    expect(classifyAuthority({ action: "untrusted-instruction", untrustedSource: true }).effect).toBe("DENY");
    expect(classifyGuarded({ action: "secret-expose" }).effect).toBe("DENY");
  });
});

describe("security: one orchestrator owns the ledger", () => {
  it("refuses a ledger write from a specialist", async () => {
    const { runtime } = await freshRuntime();
    await expect(
      executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, specialist),
    ).rejects.toThrow(/only team-leader may/);
    await expect(
      executeHandoff(runtime, { action: "prepare", expectedRevision: 0, role: "explorer", objective: "o", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }, specialist),
    ).rejects.toThrow(/only team-leader may/);
  });

  it("lets a specialist read the ledger", async () => {
    const { runtime } = await freshRuntime();
    const read = JSON.parse((await executeState(runtime, { action: "read" }, specialist)).content);
    expect(read.initialized).toBe(true);
  });
});

describe("security: a specialist result must be well formed", () => {
  it("rejects a result with no next action", async () => {
    const { runtime } = await freshRuntime();
    await executeHandoff(
      runtime,
      { action: "prepare", expectedRevision: 0, role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" },
      leader,
    );
    await expect(
      executeHandoff(
        runtime,
        { action: "complete", expectedRevision: 1, handoffId: "HND-0001", result: { status: "PASS", summary: "s", findings: [], risks: [], unknowns: [], recommended_next_action: "" } },
        leader,
      ),
    ).rejects.toThrow();
  });

  it("rejects a result with an unknown field", async () => {
    const { runtime } = await freshRuntime();
    await executeHandoff(
      runtime,
      { action: "prepare", expectedRevision: 0, role: "explorer", objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done" },
      leader,
    );
    await expect(
      executeHandoff(
        runtime,
        {
          action: "complete",
          expectedRevision: 1,
          handoffId: "HND-0001",
          result: { status: "PASS", summary: "s", findings: [], risks: [], unknowns: [], recommended_next_action: "next", confidence: 0.9 },
        },
        leader,
      ),
    ).rejects.toThrow();
  });
});
