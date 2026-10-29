import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initializeState, readState, appendEvent, storeContext, readEvents, writeDeliveryDoc, withLedgerLock } from "../../src/ledger/store.js";
import { verifyChain } from "../../src/ledger/events.js";

async function tmpRoot(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-ledger-"));
  return dir;
}

describe("ledger store", () => {
  it("initializes, appends with optimistic concurrency, and replays", async () => {
    const root = await tmpRoot();
    const s0 = await initializeState({ projectRoot: root, sessionId: "s1", actor: "agent-team", outcome: "Test outcome" });
    expect(s0.revision).toBe(0);
    const ctx = storeContext(root, "s1", "agent-team");
    const s1 = await appendEvent(ctx, "assumption.recorded", { id: "ASM-0001" }, (s) => ({ ...s, assumptions: [...s.assumptions, { id: "ASM-0001", statement: "s", basis: "INFERENCE" as const, confidence: "low" as const, impact: "i", sourceRefs: [] as string[] }] }));
    expect(s1.revision).toBe(1);
    const events = await readEvents(root);
    expect(verifyChain(events).ok).toBe(true);
    const reread = await readState(root);
    expect(reread?.assumptions).toHaveLength(1);
  });

  it("serializes concurrent appends so the revision stays consistent", async () => {
    const root = await tmpRoot();
    await initializeState({ projectRoot: root, sessionId: "s1", actor: "agent-team", outcome: "O" });
    const ctx = storeContext(root, "s1", "agent-team");
    // Two appends racing on the same ledger: the store's lock serializes
    // them, the chain stays intact and the revision advances exactly twice.
    const [a, b] = await Promise.all([
      appendEvent(ctx, "a", {}, (s) => ({ ...s })),
      appendEvent(ctx, "b", {}, (s) => ({ ...s })),
    ]);
    expect(a.revision).not.toBe(b.revision);
    const state = await readState(root);
    expect(state?.revision).toBe(2);
    const events = await readEvents(root);
    expect(events).toHaveLength(3);
    expect(verifyChain(events).ok).toBe(true);
  });

  it("fails closed when the ledger lock cannot be acquired", async () => {
    // The lock protects concurrent writes inside one server process. When it
    // cannot be taken the write fails loudly rather than interleaving.
    const key = "agent-team:test-lock";
    const held = withLedgerLock(key, async () => {
      await new Promise((r) => setTimeout(r, 150));
      return "done";
    });
    await expect(withLedgerLock(key, async () => "second", 20)).rejects.toThrow(/lock timeout/);
    expect(await held).toBe("done");
    // the lock is released afterwards
    expect(await withLedgerLock(key, async () => "after")).toBe("after");
  });

  it("redacts secrets before persistence", async () => {    const root = await tmpRoot();
    await initializeState({ projectRoot: root, sessionId: "s1", actor: "agent-team", outcome: "O" });
    const ctx = storeContext(root, "s1", "agent-team");
    await appendEvent(ctx, "x", { api_key: "supersecret", note: "Bearer abcdefghijklmnop" }, (s) => ({ ...s }));
    const raw = await fs.promises.readFile(path.join(root, ".agent-team", "ledger", "events.jsonl"), "utf8");
    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("abcdefghijklmnop");
  });

  it("redacts the initial projection, which is written outside appendEvent", async () => {
    // The engagement outcome is free text the leader composes. If it carries a
    // credential, the initial state.json must not keep it — and it must agree
    // with the event that records the same outcome.
    const root = await tmpRoot();
    await initializeState({
      projectRoot: root,
      sessionId: "s1",
      actor: "agent-team",
      outcome: "rotate the Bearer abcdefghijklmnopqrstuvwx credential",
    });
    const state = await fs.promises.readFile(path.join(root, ".agent-team", "state.json"), "utf8");
    expect(state).not.toContain("abcdefghijklmnopqrstuvwx");
    const events = await fs.promises.readFile(path.join(root, ".agent-team", "ledger", "events.jsonl"), "utf8");
    expect(events).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("returns empty events on fresh roots and writes delivery docs", async () => {
    const root = await tmpRoot();
    expect(await readEvents(root)).toEqual([]);
    await initializeState({ projectRoot: root, sessionId: "s1", actor: "agent-team", outcome: "O" });
    const again = await initializeState({ projectRoot: root, sessionId: "s1", actor: "agent-team", outcome: "O" });
    expect(again.outcome).toBe("O"); // idempotent: returns existing
    const doc = await writeDeliveryDoc(root, "DEL-001", "id: DEL-001\n");
    expect(doc).toContain("DEL-001.yaml");
    expect(await fs.promises.readFile(doc, "utf8")).toContain("DEL-001");
    // corrupt ledger fails closed (non-ENOENT rethrows, no silent replay)
    await fs.promises.writeFile(path.join(root, ".agent-team", "ledger", "events.jsonl"), "not json\n");
    await expect(readEvents(root)).rejects.toThrow();
  });

  it("migrates a v1 state file to v2 in place and backs up the original", async () => {
    const root = await tmpRoot();
    await fs.promises.mkdir(path.join(root, ".agent-team"), { recursive: true });
    const v1 = {
      schemaVersion: 1,
      revision: 4,
      project: { id: "PRJ-X", canonicalDirectoryHash: "h" },
      engagement: { id: "ENG-X", createdAt: "t", updatedAt: "t", status: "RELEASE_READY", phase: "IMPLEMENT" },
      outcome: "Ship it",
      actors: [],
      constraints: [],
      nonGoals: [],
      guardrails: [],
      assumptions: [],
      decisions: [],
      activeSlice: {
        id: "SLICE-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: [], outOfScope: [], allowedFiles: ["src/a.ts"], prohibitedFiles: ["src/b.ts"],
        acceptanceCriteria: ["AC-1"], validationCommands: ["npm test"], runtimeProof: ["flow works"], visualProof: [],
        risks: [], rollback: "revert", owner: "agent-team", status: "IN_PROGRESS",
      },
      risks: [],
      gates: [],
      evidence: [],
      approvals: [],
      handoffs: [{ id: "HND-0001", role: "verifier", objective: "o", context: [], allowedScope: [], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "s", status: "prepared" }],
      nextAction: { description: "n", owner: "agent-team" },
      modelProfile: { providerID: "opencode", modelID: "muse-spark-1.3", defaultVariant: "high", status: "READY" },
    };
    const statePath = path.join(root, ".agent-team", "state.json");
    await fs.promises.writeFile(statePath, JSON.stringify(v1, null, 2));
    const migrated = await readState(root);
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.engagement.phase).toBe("EXECUTE");
    expect(migrated?.engagement.status).toBe("DELIVERY_READY");
    expect(migrated?.activeDelivery?.allowedScope).toEqual(["src/a.ts"]);
    expect(migrated?.handoffs[0]?.role).toBe("reviewer");
    // the file on disk is rewritten as v2
    const onDisk = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(onDisk["schemaVersion"]).toBe(2);
    expect(onDisk["activeSlice"]).toBeUndefined();
    // and the pre-migration file is preserved
    const backups = await fs.promises.readdir(path.join(root, ".agent-team", "setup-backups"));
    expect(backups.length).toBeGreaterThan(0);
    const kept = JSON.parse(await fs.promises.readFile(path.join(root, ".agent-team", "setup-backups", backups[0]!, "state.v1.json"), "utf8")) as Record<string, unknown>;
    expect(kept["schemaVersion"]).toBe(1);
  });
});
