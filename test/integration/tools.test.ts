import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeAssumption } from "../../src/tools/assumption.js";
import { executeDecision } from "../../src/tools/decision.js";
import { executeEvidence } from "../../src/tools/evidence.js";
import { executeGate } from "../../src/tools/gate.js";
import { executeApproval } from "../../src/tools/approval.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { readState } from "../../src/ledger/store.js";
import { projectRootOf } from "../../src/runtime.js";
import { recordObservedEvidence } from "../../src/orchestrator/observe.js";

function runtimeFor(root: string): AgentTeamRuntime {
  return createRuntime(
    { location: { project: { canonical: root } }, options: {}, app: { version: "2.2.0" }, session: { create: async () => ({ id: "ses_child" }), prompt: async () => ({}) } } as never,
    { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false, autonomy: { mode: "yolo", askBefore: [] }, orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] } },
  );
}

function projectRootOfRuntime(runtime: AgentTeamRuntime): string {
  return projectRootOf(runtime.ctx);
}

async function readStateSafe(runtime: AgentTeamRuntime): Promise<number> {
  const state = await readState(projectRootOfRuntime(runtime));
  if (!state) throw new Error("state missing");
  return state.revision;
}

const tool = { sessionID: "sess-1", agent: "team-leader" } as never;

async function freshRuntime(): Promise<{ runtime: AgentTeamRuntime; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-tools-"));
  return { runtime: runtimeFor(root), root };
}

const DECISION_BASE = {
  title: "T",
  context: "ctx",
  drivers: ["d1"],
  options: [
    { name: "a", benefits: ["b"], costs: ["c"], risks: ["r"] },
    { name: "b", benefits: ["b"], costs: ["c"], risks: ["r"] },
  ],
  decision: "a",
  rationale: "because",
  consequences: ["c1"],
  reversibility: "easy",
  authority: "ALLOW_WITH_RECORD",
  evidenceRefs: ["ASM-0001"],
} as const;

describe("agent-team tools end to end", () => {
  it("state: read uninitialized, initialize, read, transition, stale + invalid guards", async () => {
    const { runtime } = await freshRuntime();
    expect(JSON.parse((await executeState(runtime, { action: "read" }, tool)).content).initialized).toBe(false);
    const init = JSON.parse((await executeState(runtime, { action: "initialize", outcome: "Win", actors: ["u"] }, tool)).content);
    expect(init.state.revision).toBe(0);
    const read = JSON.parse((await executeState(runtime, { action: "read" }, tool)).content);
    expect(read.state.outcome).toBe("Win");
    await expect(executeState(runtime, { action: "transition", expectedRevision: 99, to: "DISCOVER", reason: "r", nextAction: "n" }, tool)).rejects.toThrow(/stale revision/);
    await expect(executeState(runtime, { action: "transition", expectedRevision: 0, to: "DELIVER", reason: "r", nextAction: "n" }, tool)).rejects.toThrow(/invalid phase transition/);
    const moved = JSON.parse((await executeState(runtime, { action: "transition", expectedRevision: 0, to: "DISCOVER", reason: "start", nextAction: "discover" }, tool)).content);
    expect(moved.state.engagement.phase).toBe("DISCOVER");
    await expect(executeState(runtime, { action: "nope" }, tool)).rejects.toThrow();
  });
  it("state guard: registers guardrails and mode without touching default autonomy", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const initial = JSON.parse((await executeState(runtime, { action: "read" }, tool)).content);
    expect(initial.state.guardrails).toEqual([]);
    const added = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 0, add: ["deploy produção"] }, tool)).content);
    expect(added.guardrails).toEqual(["deploy produção"]);
    expect(added.mode).toBe("yolo");
    expect(added.note).toContain("require explicit authorization");
    const removed = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 1, remove: ["deploy produção"], mode: "guarded" }, tool)).content);
    expect(removed.guardrails).toEqual([]);
    expect(removed.mode).toBe("guarded");
    expect(removed.note).toContain("require explicit authorization");
    const cleared = JSON.parse((await executeState(runtime, { action: "guard", expectedRevision: 2, add: ["x"], mode: "yolo" }, tool)).content);
    expect(cleared.mode).toBe("yolo");
    await expect(executeState(runtime, { action: "guard", expectedRevision: 0, add: ["y"] }, tool)).rejects.toThrow(/stale/);
  });
  it("assumption: records and enforces revision", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const res = JSON.parse((await executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "low", impact: "blocks accept" }, tool)).content);
    expect(res.id).toBe("ASM-0001");
    await expect(executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "INFERENCE", confidence: "low", impact: "i" }, tool)).rejects.toThrow(/stale/);
    await expect(executeAssumption(runtime, { expectedRevision: 1, statement: "", basis: "INFERENCE", confidence: "low", impact: "i" }, tool)).rejects.toThrow();
  });
  it("decision: persists record + markdown doc, and refuses an unanchored one", async () => {
    const { runtime, root } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    // a decision that cites nothing that exists is refused
    await expect(executeDecision(runtime, { expectedRevision: 0, ...DECISION_BASE, evidenceRefs: ["ASM-9999"] }, tool)).rejects.toThrow(/must cite at least one existing assumption/);
    await executeAssumption(runtime, { expectedRevision: 0, statement: "s", basis: "OBSERVED_PATTERN", confidence: "medium", impact: "i" }, tool);
    const res = JSON.parse((await executeDecision(runtime, { expectedRevision: 1, ...DECISION_BASE }, tool)).content);
    expect(res.id).toBe("DEC-0001");
    const doc = await fs.promises.readFile(path.join(root, ".agent-team", "decisions", "DEC-0001.md"), "utf8");
    expect(doc).toContain("# DEC-0001: T");
    await expect(executeDecision(runtime, { expectedRevision: 1, ...DECISION_BASE }, tool)).rejects.toThrow(/stale/);
  });
  it("evidence: refuses a typed pass and records an observed check", async () => {
    const { runtime, root } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    await expect(executeEvidence(runtime, { expectedRevision: 0, criterionId: "AC-1", kind: "test", status: "pass", summary: "s", observedAt: "t" }, tool)).rejects.toThrow(/only when Agent Team ran the check/);
    const ok = await recordObservedEvidence(root, { criterionId: "AC-1", kind: "test", summary: "green", command: "npm test", exitCode: 0, output: "ok" });
    expect(ok.id).toMatch(/^EVD-/);
    expect(ok.observed).toBe(true);
    expect(ok.digest?.length).toBeGreaterThan(0);
    const state = await readState(root);
    expect(state?.evidence.some((e) => e.id === ok.id && e.observed === true)).toBe(true);
  });
  it("evidence: accepts any criterion when no delivery declares criteria", async () => {
    const { runtime, root } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    // Without a delivery there are no declared criteria, so any criterion id
    // is accepted: the gate has nothing to link the evidence to.
    const ok = await recordObservedEvidence(root, { criterionId: "WHATEVER", kind: "source", summary: "s", command: "grep -q x src/a.ts", exitCode: 0, output: "x" });
    expect(ok.id).toMatch(/^EVD-/);
  });
  it("evidence: rejects an unknown criterion when the delivery declares criteria", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
    const root = projectRootOfRuntime(runtime);
    const planted = await appendEvent(storeContext(root, "sess-1", "team-leader"), "delivery.defined", { id: "DEL-001" }, (s) => ({
      ...s,
      activeDelivery: {
        id: "DEL-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: [], outOfScope: [], allowedScope: ["src/a.ts"], prohibitedScope: [],
        acceptanceCriteria: ["AC-1"], validationSteps: ["npm test"], proof: [],
        risks: [], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
      },
    }));
    // A criterion the delivery does not declare is refused.
    await expect(
      executeEvidence(runtime, { expectedRevision: planted.revision, criterionId: "AC-999", kind: "source", status: "partial", summary: "s", artifactRef: "f", observedAt: "t" }, tool),
    ).rejects.toThrow(/unknown criterionId/);
    // A declared criterion is accepted as a partial row.
    const ok = JSON.parse((await executeEvidence(runtime, { expectedRevision: planted.revision, criterionId: "AC-1", kind: "source", status: "partial", summary: "s", artifactRef: "f", observedAt: "t" }, tool)).content);
    expect(ok.id).toMatch(/^EVD-/);
  });
  it("gate: evaluates INTENT/PLAN/VERIFY/ACCEPT/DELIVER from ledger", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const intent = JSON.parse((await executeGate(runtime, { gate: "INTENT", claim: "ready", expectedRevision: 0 }, tool)).content);
    expect(intent.result).toBe("PASS");
    expect(intent.satisfied).toContain("outcome");
    const plan = JSON.parse((await executeGate(runtime, { gate: "PLAN", claim: "planned", expectedRevision: 1 }, tool)).content);
    expect(plan.result).toBe("FAIL"); // no active delivery
    expect(plan.missing).toContain("active-delivery");
    // VERIFY with no delivery fails honestly instead of passing vacuously
    const verifyEmpty = JSON.parse((await executeGate(runtime, { gate: "VERIFY", claim: "v", expectedRevision: 2 }, tool)).content);
    expect(verifyEmpty.result).toBe("FAIL");
    expect(verifyEmpty.missing).toContain("active-delivery");
    // plant an active delivery, then low-confidence assumption blocks ACCEPT
    const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
    const root = projectRootOfRuntime(runtime);
    const planted = await appendEvent(storeContext(root, "sess-1", "team-leader"), "delivery.defined", { id: "DEL-001" }, (s) => ({
      ...s,
      activeDelivery: {
        id: "DEL-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: [], outOfScope: [], allowedScope: ["src/a.ts"], prohibitedScope: [],
        acceptanceCriteria: ["AC-1"], validationSteps: ["npm test"], proof: [],
        risks: [], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
      },
    }));
    await executeAssumption(runtime, { expectedRevision: planted.revision, statement: "risky", basis: "INFERENCE", confidence: "low", impact: "high" }, tool);
    const afterAsm = await readStateSafe(runtime);
    await recordObservedEvidence(root, { criterionId: "AC-1", kind: "test", summary: "s", command: "npm test", exitCode: 0, output: "ok" });
    const afterEvd = await readStateSafe(runtime);
    const verify = JSON.parse((await executeGate(runtime, { gate: "VERIFY", claim: "v", expectedRevision: afterEvd }, tool)).content);
    expect(verify.result).toBe("PASS");
    // ACCEPT without independent review fails on the review requirement first
    const acceptNoReview = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "done", expectedRevision: verify.revision }, tool)).content);
    expect(acceptNoReview.result).toBe("FAIL");
    expect(acceptNoReview.missing).toContain("independent-review");
    // REVIEW likewise requires the reviewer handoff
    const reviewNoReview = JSON.parse((await executeGate(runtime, { gate: "REVIEW", claim: "r", expectedRevision: acceptNoReview.revision }, tool)).content);
    expect(reviewNoReview.result).toBe("FAIL");
    expect(reviewNoReview.missing).toContain("independent-review");
    // plant a completed implementation and reviewer: ACCEPT reaches the evidence/assumption checks
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "handoff.launched", { id: "HND-0001" }, (s) => ({
      ...s,
      handoffs: [
        ...s.handoffs,
        { id: "HND-0001", role: "coder" as const, objective: "implement", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_coder", parentSessionID: "sess-1" },
        { id: "HND-0002", role: "reviewer" as const, objective: "review", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_reviewer", parentSessionID: "sess-1" },
      ],
    }));
    let rev = await readStateSafe(runtime);
    const review = JSON.parse((await executeGate(runtime, { gate: "REVIEW", claim: "r", expectedRevision: rev }, tool)).content);
    expect(review.result).toBe("PASS");
    const accept = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "done", expectedRevision: review.revision }, tool)).content);
    expect(accept.result).toBe("FAIL");
    expect(accept.missing.join()).toContain("open-assumptions");
    const release = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: accept.revision }, tool)).content);
    expect(release.result).toBe("FAIL"); // ACCEPT never passed
    await expect(executeGate(runtime, { gate: "ACCEPT", claim: "x", expectedRevision: 0 }, tool)).rejects.toThrow(/stale/);
  });
  it("release: BLOCKED on pending approvals, PASS when clear", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
    const root = projectRootOfRuntime(runtime);
    const planted = await appendEvent(storeContext(root, "sess-1", "team-leader"), "delivery.defined", { id: "DEL-001" }, (s) => ({
      ...s,
      activeDelivery: {
        id: "DEL-001", title: "t", userOutcome: "u", entryState: "e", happyPath: ["h"],
        inScope: [], outOfScope: [], allowedScope: ["src/a.ts"], prohibitedScope: [],
        acceptanceCriteria: ["AC-1"], validationSteps: ["npm test"], proof: [],
        risks: [], rollback: "revert", owner: "team-leader", status: "IN_PROGRESS",
      },
    }));
    await recordObservedEvidence(root, { criterionId: "AC-1", kind: "test", summary: "green", command: "npm test", exitCode: 0, output: "ok" });
    let rev = await readStateSafe(runtime);
    // ACCEPT requires the independent review even with green evidence
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "handoff.launched", { id: "HND-0001" }, (s) => ({
      ...s,
      handoffs: [
        ...s.handoffs,
        { id: "HND-0001", role: "coder" as const, objective: "implement", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_coder", parentSessionID: "sess-1" },
        { id: "HND-0002", role: "reviewer" as const, objective: "review", context: [], allowedScope: ["src/a.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_reviewer", parentSessionID: "sess-1" },
      ],
    }));
    rev = await readStateSafe(runtime);
    const accept = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "done", expectedRevision: rev }, tool)).content);
    expect(accept.result).toBe("PASS");
    rev = accept.revision;
    const opened = JSON.parse((await executeApproval(runtime, { action: "open", expectedRevision: rev, category: "release", requestedAction: "publish", resources: ["npm"], reason: "ship", risks: [] }, tool)).content);
    const blocked = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: opened.revision }, tool)).content);
    expect(blocked.result).toBe("BLOCKED");
    expect(blocked.missing).toContain("APR-0001");
    await executeApproval(runtime, { action: "resolve", expectedRevision: blocked.revision, approvalId: "APR-0001", decision: "approved", userMessageId: "m1" }, tool);
    rev = await readStateSafe(runtime);
    const released = JSON.parse((await executeGate(runtime, { gate: "DELIVER", claim: "ship", expectedRevision: rev }, tool)).content);
    expect(released.result).toBe("PASS");
  });
  it("approval: open/resolve lifecycle with user-message proof", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const opened = JSON.parse((await executeApproval(runtime, { action: "open", expectedRevision: 0, category: "release", requestedAction: "publish", resources: ["npm"], reason: "ship it", risks: ["r"] }, tool)).content);
    expect(opened.id).toBe("APR-0001");
    await expect(executeApproval(runtime, { action: "resolve", expectedRevision: 1, approvalId: "APR-0001", decision: "approved", userMessageId: "" }, tool)).rejects.toThrow(/userMessageId/);
    await expect(executeApproval(runtime, { action: "resolve", expectedRevision: 1, approvalId: "APR-9999", decision: "approved", userMessageId: "m1" }, tool)).rejects.toThrow(/unknown approval/);
    const resolved = JSON.parse((await executeApproval(runtime, { action: "resolve", expectedRevision: 1, approvalId: "APR-0001", decision: "approved", userMessageId: "msg-1" }, tool)).content);
    expect(resolved.status).toBe("approved");
    await expect(executeApproval(runtime, { action: "resolve", expectedRevision: 2, approvalId: "APR-0001", decision: "approved", userMessageId: "msg-2" }, tool)).rejects.toThrow(/already approved/);
  });
  it("handoff: launch/cancel with guards", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const specialist = { sessionID: "s", agent: "team-leader/coder" } as never;
    const base = { role: "explorer" as const, objective: "map", context: ["c"], allowedScope: ["src/**"], prohibitedScope: [], questions: ["q?"], requiredEvidence: ["tree"], stopCondition: "done" };
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [base] }, specialist)).rejects.toThrow(/only team-leader/);
    const p1 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [base] }, tool)).content);
    expect(p1.ids).toEqual(["HND-0001"]);
    expect(p1.sessions[0].sessionID).toMatch(/^ses_/);
    expect(p1.prompts[0]).toContain("HND-0001");
    // a packet is not a handoff
    await expect(executeHandoff(runtime, { action: "prepare", expectedRevision: 1, ...base } as never, tool)).rejects.toThrow(/prompt packet is not a handoff/);
    const cancelled = JSON.parse((await executeHandoff(runtime, { action: "cancel", expectedRevision: 1, handoffId: "HND-0001", reason: "dup" }, tool)).content);
    expect(cancelled.id).toBe("HND-0001");
    await expect(executeHandoff(runtime, { action: "cancel", expectedRevision: 2, handoffId: "HND-9999", reason: "x" }, tool)).rejects.toThrow(/unknown handoff/);
  });
  it("handoff: carries the assigned skills and the dependency graph", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const root = projectRootOfRuntime(runtime);
    const w1 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [{ role: "explorer", objective: "map the domain", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: ["glossary"], stopCondition: "mapped", skills: ["agent-team-domain-discovery"] }] }, tool)).content);
    expect(w1.prompts[0]).toContain("agent-team-domain-discovery");
    const w2 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 1, units: [{ role: "worker", objective: "draft the memo", context: [], allowedScope: ["docs/**"], prohibitedScope: [], questions: [], requiredEvidence: ["file"], stopCondition: "drafted", skills: ["agent-team-general-execution", "agent-team-writing-execution"] }] }, tool)).content);
    expect(w2.ids).toEqual(["HND-0002"]);
    const w3 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 2, units: [{ role: "reviewer", objective: "review both", context: [], allowedScope: ["src/**", "docs/**"], prohibitedScope: [], questions: [], requiredEvidence: ["findings"], stopCondition: "reviewed", skills: ["agent-team-code-review"], dependsOn: ["HND-0001", "HND-0002"] }] }, tool)).content);
    expect(w3.prompts[0]).toContain("Wait for these handoffs to complete");
    const { readState } = await import("../../src/ledger/store.js");
    const state = await readState(root);
    expect(state?.handoffs[2]?.dependsOn).toEqual(["HND-0001", "HND-0002"]);
    expect(state?.handoffs[0]?.skills).toEqual(["agent-team-domain-discovery"]);
  });
  it("handoff: refuses to exceed the parallel specialist budget", async () => {
    const { runtime, root } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const base = { role: "explorer" as const, objective: "map", context: [], allowedScope: ["src/**"], prohibitedScope: [], questions: [], requiredEvidence: ["tree"], stopCondition: "done" };
    for (let i = 0; i < 6; i++) {
      const res = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: i, units: [{ ...base, objective: `unit ${i}` }] }, tool)).content);
      expect(res.ids).toEqual([`HND-000${i + 1}`]);
    }
    await expect(executeHandoff(runtime, { action: "launch", expectedRevision: 6, units: [base] }, tool)).rejects.toThrow(/parallel specialist budget exhausted/);
    await executeHandoff(runtime, { action: "cancel", expectedRevision: 6, handoffId: "HND-0001", reason: "free a slot" }, tool);
    const again = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 7, units: [base] }, tool)).content);
    expect(again.ids).toEqual(["HND-0007"]);
    void root;
  });
  it("handoff: defaults the skills to the role's own procedures", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    const base = { role: "worker" as const, objective: "write the brief", context: [], allowedScope: ["docs/**"], prohibitedScope: [], questions: [], requiredEvidence: ["file"], stopCondition: "written" };
    const p1 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [base] }, tool)).content);
    expect(p1.prompts[0]).toContain("agent-team-general-execution");
    const p2 = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 1, units: [{ ...base, objective: "write the second brief", allowedScope: ["notes/**"], skills: ["agent-team-writing-execution"] }] }, tool)).content);
    expect(p2.ids).toEqual(["HND-0002"]);
    const { readState } = await import("../../src/ledger/store.js");
    const state = await readState(projectRootOfRuntime(runtime));
    expect(state?.handoffs[0]?.skills.length).toBeGreaterThan(0);
    expect(state?.handoffs[1]?.skills).toEqual(["agent-team-writing-execution"]);
  });
  it("delivery: registers the active contract and unblocks the gates", async () => {
    const { runtime } = await freshRuntime();
    await executeState(runtime, { action: "initialize", outcome: "O" }, tool);
    // without a delivery the PLAN gate fails
    const planNoDelivery = JSON.parse((await executeGate(runtime, { gate: "PLAN", claim: "p", expectedRevision: 0 }, tool)).content);
    expect(planNoDelivery.result).toBe("FAIL");
    expect(planNoDelivery.missing).toContain("active-delivery");
    // registering the delivery makes it pass and gives the gates their criteria
    await executeAssumption(runtime, { expectedRevision: planNoDelivery.revision, statement: "task creation takes a title today", basis: "OBSERVED_PATTERN", confidence: "medium", impact: "the signature must widen" }, tool);
    const decision = JSON.parse((await executeDecision(runtime, {
      expectedRevision: planNoDelivery.revision + 1,
      title: "Typed priority",
      context: "task creation",
      drivers: ["reversibility"],
      options: [
        { name: "optional field", benefits: ["simple"], costs: [], risks: [] },
        { name: "priority enum", benefits: ["explicit"], costs: [], risks: [] },
      ],
      decision: "priority enum",
      rationale: "explicit",
      consequences: ["board owns priority"],
      reversibility: "easy",
      authority: "ALLOW",
      evidenceRefs: ["ASM-0001"],
    }, tool)).content);
    const defined = JSON.parse((await executeDelivery(runtime, {
      expectedRevision: decision.revision,
      title: "Ship the task priority field",
      userOutcome: "a task can carry a priority",
      entryState: "board without priority",
      happyPath: ["add task", "read priority"],
      inScope: ["src/board.ts"],
      outOfScope: ["auth"],
      allowedScope: ["src/board.ts"],
      prohibitedScope: ["src/auth.ts"],
      acceptanceCriteria: ["AC-1", "AC-2"],
      validationSteps: ["npm test"],
      proof: [{ kind: "functional", claim: "priority is stored", ref: "board flow test" }],
      risks: [],
      rollback: "revert src/board.ts",
      owner: "team-leader",
      status: "READY",
    }, tool)).content);
    expect(defined.id).toBe("DEL-001");
    const rev = defined.revision;
    // the contract is on disk
    const root = projectRootOfRuntime(runtime);
    const yaml = await fs.promises.readFile(path.join(root, ".agent-team", "deliveries", "DEL-001.yaml"), "utf8");
    expect(yaml).toContain("acceptance_criteria");
    expect(yaml).toContain("AC-1");
    // the PLAN gate passes now
    const plan = JSON.parse((await executeGate(runtime, { gate: "PLAN", claim: "p", expectedRevision: rev }, tool)).content);
    expect(plan.result).toBe("PASS");
    // evidence for an undeclared criterion is refused
    await expect(executeEvidence(runtime, { expectedRevision: plan.revision, criterionId: "AC-9", kind: "test", status: "partial", summary: "s", command: "npm test", observedAt: "t" }, tool)).rejects.toThrow(/unknown criterionId/);
    // observed checks for the declared criteria are accepted
    await recordObservedEvidence(root, { criterionId: "AC-1", kind: "test", summary: "green", command: "npm test", exitCode: 0, output: "ok" });
    await recordObservedEvidence(root, { criterionId: "AC-2", kind: "source", summary: "reads it", command: "grep -q x src/board.ts", exitCode: 0, output: "x" });
    let rev2 = await readStateSafe(runtime);
    // VERIFY passes with the criteria satisfied
    const verify = JSON.parse((await executeGate(runtime, { gate: "VERIFY", claim: "v", expectedRevision: rev2 }, tool)).content);
    expect(verify.result).toBe("PASS");
    // REVIEW needs an independent reviewer handoff
    const reviewNoReview = JSON.parse((await executeGate(runtime, { gate: "REVIEW", claim: "r", expectedRevision: verify.revision }, tool)).content);
    expect(reviewNoReview.result).toBe("FAIL");
    expect(reviewNoReview.missing).toContain("independent-review");
    const { storeContext, appendEvent } = await import("../../src/ledger/store.js");
    await appendEvent(storeContext(root, "sess-1", "team-leader"), "handoff.launched", { id: "HND-0001" }, (s) => ({
      ...s,
      handoffs: [
        ...s.handoffs,
        { id: "HND-0001", role: "coder" as const, objective: "implement", context: [], allowedScope: ["src/board.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_coder", parentSessionID: "sess-1" },
        { id: "HND-0002", role: "reviewer" as const, objective: "review", context: [], allowedScope: ["src/board.ts"], prohibitedScope: [], questions: [], requiredEvidence: [], stopCondition: "done", skills: [], dependsOn: [], status: "completed" as const, sessionID: "ses_reviewer", parentSessionID: "sess-1" },
      ],
    }));
    rev2 = await readStateSafe(runtime);
    const review = JSON.parse((await executeGate(runtime, { gate: "REVIEW", claim: "r", expectedRevision: rev2 }, tool)).content);
    expect(review.result).toBe("PASS");
    const accept = JSON.parse((await executeGate(runtime, { gate: "ACCEPT", claim: "done", expectedRevision: review.revision }, tool)).content);
    expect(accept.result).toBe("PASS");
    expect(accept.satisfied).toEqual(["AC-1", "AC-2"]);
  });
});
