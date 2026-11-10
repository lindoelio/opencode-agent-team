import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateUnknown, migrateV2toV3, needsMigration } from "../../src/ledger/migrations.js";
import { risksFromResult, validateResult } from "../../src/domain/handoff.js";
import { snapshotScope } from "../../src/orchestrator/digest.js";
import { evidenceSatisfiesCriterion, kindMeets } from "../../src/domain/evidence.js";

describe("schema 3 migration", () => {
  it("defaults the class and keeps a prior pass unobserved", () => {
    const migrated = migrateV2toV3({
      schemaVersion: 2,
      revision: 0,
      project: { id: "P", canonicalDirectoryHash: "h" },
      engagement: { id: "E", createdAt: "t", updatedAt: "t", status: "DRAFT", phase: "INTENT" },
      outcome: "O", actors: [], constraints: [], nonGoals: [], guardrails: [], assumptions: [], decisions: [], risks: [], gates: [], approvals: [], handoffs: [],
      evidence: [{ id: "EVD-1", criterionId: "AC-1", kind: "test", status: "pass", summary: "s", command: "npm test", observedAt: "t" }],
      nextAction: { description: "n", owner: "team-leader" },
    });
    expect(migrated.engagementClass).toBe("change");
    expect(migrated.evidence[0]?.observed).toBe(false);
  });

  it("returns a version 3 state unchanged and refuses an unknown one", () => {
    const state = { schemaVersion: 3 };
    expect(migrateUnknown(state)).toBe(state);
    expect(needsMigration(2)).toBe(true);
    expect(needsMigration(3)).toBe(false);
    expect(() => migrateUnknown({ schemaVersion: 7 })).toThrow(/unsupported/);
  });
});

describe("specialist results", () => {
  it("maps the strongest finding to the risk severity", () => {
    const risks = risksFromResult({
      status: "PASS", summary: "s", unknowns: [], recommended_next_action: "n",
      findings: [{ severity: "critical", claim: "c", evidence: ["e"] }],
      risks: ["one", "two"],
    }, 1);
    expect(risks.map((r) => r.severity)).toEqual(["critical", "critical"]);
  });

  it("rejects a result outside the closed shape", () => {
    expect(() => validateResult({ status: "PASS" })).toThrow();
  });
});

describe("ledger guard branches", () => {
  it("refuses a specialist, a missing state, and a stale revision", async () => {
    const { executeAssumption } = await import("../../src/tools/assumption.js");
    const { executeState } = await import("../../src/tools/state.js");
    const { createRuntime } = await import("../../src/runtime.js");
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-ledger-branch-"));
    const runtime = createRuntime({
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: { create: async () => ({ id: "ses_x" }), prompt: async () => ({}) },
    } as never, { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false } as never);
    const leader = { sessionID: "s", agent: "team-leader" } as never;
    const specialist = { sessionID: "s", agent: "team-leader/coder" } as never;
    await expect(executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, specialist)).rejects.toThrow(/only team-leader/);
    await expect(executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, leader)).rejects.toThrow(/not initialized/);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await expect(executeAssumption(runtime, { expectedRevision: 9, statement: "s", basis: "INFERENCE", confidence: "medium", impact: "i" }, leader)).rejects.toThrow(/stale revision/);
  });
});

describe("v1 migration defaults", () => {
  it("fills the collections a minimal v1 state lacks", () => {
    const migrated = migrateUnknown({
      schemaVersion: 1,
      revision: 0,
      project: { id: "P", canonicalDirectoryHash: "h" },
      engagement: { id: "E", createdAt: "t", updatedAt: "t", status: "DRAFT", phase: "INTENT" },
      outcome: "O",
      nextAction: { description: "n", owner: "team-leader" },
    }) as { schemaVersion: number; evidence: unknown[]; handoffs: unknown[]; activeDelivery?: unknown };
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.evidence).toEqual([]);
    expect(migrated.handoffs).toEqual([]);
    expect(migrated.activeDelivery).toBeUndefined();
  });
});

describe("digest edge cases", () => {
  it("hashes a plain file scope and ignores a missing path", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-digest-extra-"));
    await fs.promises.writeFile(path.join(root, "a.ts"), "a");
    expect(Object.keys(snapshotScope(root, ["a.ts"]).files)).toEqual(["a.ts"]);
    expect(snapshotScope(root, ["missing.ts"]).files).toEqual({});
  });
});

describe("evidence kind table", () => {
  it("covers the partial order", () => {
    expect(kindMeets("release", "test")).toBe(true);
    expect(kindMeets("review", "runtime")).toBe(false);
    expect(kindMeets("document", "document")).toBe(true);
    expect(evidenceSatisfiesCriterion({ id: "E", criterionId: "C", kind: "judgment", status: "pass", summary: "s", digest: "d", observedAt: "t", limitations: [] })).toBe(false);
  });
});
