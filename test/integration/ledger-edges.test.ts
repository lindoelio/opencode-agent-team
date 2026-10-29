import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalize, computeEventHash, GENESIS_HASH, verifyChain } from "../../src/ledger/events.js";
import { migrateUnknown } from "../../src/ledger/migrations.js";
import { createRuntime } from "../../src/runtime.js";
import { runDoctor } from "../../src/doctor/report.js";
import { executeState } from "../../src/tools/state.js";
import { executeAssumption } from "../../src/tools/assumption.js";
import { executeApproval } from "../../src/tools/approval.js";
import { executeDelivery } from "../../src/tools/delivery.js";

/**
 * The edges of the ledger and the doctor: a tampered chain, a migrated v1
 * state, a host whose catalog cannot be read, and the optional fields every
 * tool accepts.
 */

describe("the hash chain", () => {
  it("canonicalizes a payload deterministically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(JSON.stringify({ b: 1, a: 2 }));
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(undefined)).toBe("null");
  });

  it("detects a truncated or tampered chain", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "EVT-1",
      sequence: 0,
      timestamp: "t",
      projectId: "P",
      engagementId: "E",
      sessionIdHash: "h",
      actor: "a",
      type: "x",
      payload: {},
      previousHash: GENESIS_HASH,
    };
    const first = { ...base, hash: computeEventHash(base) };
    expect(verifyChain([first]).ok).toBe(true);
    // a tampered payload breaks the chain
    expect(verifyChain([{ ...first, payload: { changed: true } }]).ok).toBe(false);
    expect(verifyChain([{ ...first, previousHash: "wrong" }]).ok).toBe(false);
    // a broken chain reports where it broke
    expect(verifyChain([{ ...first, hash: "wrong" }]).badIndex).toBe(0);
    // an empty chain is valid
    expect(verifyChain([]).ok).toBe(true);
  });
});

describe("the v1 to v2 migration", () => {
  it("migrates a v1 state file in place and keeps a backup", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-migrate-"));
    const v1 = {
      schemaVersion: 1,
      revision: 3,
      project: { id: "PRJ-1", canonicalDirectoryHash: "h" },
      engagement: { id: "ENG-1", createdAt: "t", updatedAt: "t", status: "DRAFT", phase: "INTENT" },
      outcome: "O",
      actors: [],
      constraints: [],
      nonGoals: [],
      guardrails: [],
      assumptions: [{ id: "ASM-0001", statement: "s", basis: "INFERENCE", confidence: "low", impact: "i" }],
      decisions: [],
      risks: [],
      gates: [{ gate: "REVIEW", result: "PASS", claim: "c", satisfied: [], missing: [], failed: [], waivers: [], nextAction: "n", evaluatedAt: "t" }],
      evidence: [],
      approvals: [],
      handoffs: [{ id: "HND-0001", role: "verifier", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s" }],
      nextAction: { description: "n", owner: "team-leader" },
    };
    fs.mkdirSync(path.join(root, ".agent-team"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-team", "state.json"), JSON.stringify(v1));
    const { readState } = await import("../../src/ledger/store.js");
    const migrated = await readState(root);
    expect(migrated?.schemaVersion).toBe(2);
    // the v1 role name becomes the v2 one
    expect(migrated?.handoffs[0]?.role).toBe("reviewer");
    // the v1 gate name becomes the v2 one
    expect(migrated?.gates[0]?.gate).toBe("REVIEW");
    // a backup of the pre-migration file exists
    const backups = path.join(root, ".agent-team", "setup-backups");
    expect(fs.existsSync(backups)).toBe(true);
  });

  it("refuses an unknown schema version", () => {
    expect(() => migrateUnknown({ schemaVersion: 99 })).toThrow(/backup required/i);
  });
});

describe("the doctor on a host it cannot read fully", () => {
  it("degrades when the model catalog cannot be read and an effort is configured", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const noop = async () => ({ dispose: async () => {} });
    const ctx = {
      options: {},
      location: { project: { canonical: root } },
      app: { version: "2.0.10" },
      model: { list: async () => { throw new Error("catalog down"); } },
      generate: { text: async () => ({ text: "ok" }) },
      tool: { list: async () => [], transform: async () => ({ dispose: async () => {} }), hook: noop },
      command: { transform: async () => ({ dispose: async () => {} }) },
      skill: { transform: async () => ({ dispose: async () => {} }) },
      session: { hook: noop },
      agent: { list: async () => [{ id: "team-leader" }] },
      storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
      permission: { hook: noop },
    } as never;
    const runtime = createRuntime(ctx, {
      profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false,
      autonomy: { mode: "guarded", askBefore: ["deploy prod"] },
      model: { reasoningEffort: "high" },
    } as never);
    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === "Model catalog")!.status).toBe("FAIL");
    expect(report.checks.find((c) => c.name === "Reasoning effort")!.status).toBe("DEGRADED");
    const autonomy = report.checks.find((c) => c.name === "Autonomy")!;
    expect(autonomy.detail).toContain("guarded");
    expect(autonomy.detail).toContain("deploy prod");
  });
});

describe("the optional fields every tool accepts", () => {
  const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

  function runtimeFor(root: string): ReturnType<typeof createRuntime> {
    return createRuntime(
      { location: { project: { canonical: root } }, options: {} } as never,
      { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false, autonomy: { mode: "yolo", askBefore: [] } } as never,
    );
  }

  it("assumption accepts a validation and source references", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-optional-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const asm = JSON.parse(
      (
        await executeAssumption(
          runtime,
          { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "low", impact: "i", validation: "v", sourceRefs: ["src/a.ts"] },
          leader,
        )
      ).content,
    );
    expect(asm.id).toBe("ASM-0001");
  });

  it("approval accepts an expiry and a rollback", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-optional-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const opened = JSON.parse(
      (
        await executeApproval(
          runtime,
          {
            action: "open", expectedRevision: 0, category: "release", requestedAction: "publish",
            resources: ["npm"], reason: "why", risks: ["r"], rollback: "unpublish",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          leader,
        )
      ).content,
    );
    expect(opened.id).toBe("APR-0001");
    const { readState } = await import("../../src/ledger/store.js");
    const state = await readState(root);
    expect(state?.approvals[0]?.expiresAt).toBeDefined();
    expect(state?.approvals[0]?.rollback).toBe("unpublish");
  });

  it("delivery accepts the full contract", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-optional-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse(
      (
        await executeDelivery(
          runtime,
          {
            expectedRevision: 0, title: "T", userOutcome: "u", entryState: "e",
            happyPath: ["a"], inScope: ["i"], outOfScope: ["o"],
            allowedScope: ["src/**"], prohibitedScope: ["src/secret.ts"],
            acceptanceCriteria: ["AC-1"], validationSteps: ["npm test"],
            proof: [{ kind: "functional", claim: "c", ref: "r" }],
            risks: ["risk"], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
          },
          leader,
        )
      ).content,
    );
    expect(out.id).toBe("DEL-001");
    const doc = fs.readFileSync(path.join(root, ".agent-team", "deliveries", "DEL-001.yaml"), "utf8");
    expect(doc).toContain("entry_state:");
    expect(doc).toContain("kind: functional");
    expect(doc).toContain("owner: team-leader");
  });
});
