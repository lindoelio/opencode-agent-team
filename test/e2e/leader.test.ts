import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { E2E_RUNNABLE, agentTeamToolNames, finalText, ledger, makeWorkspace, readFile, requireOpenCode, runAgent, subagentRoles } from "./harness.js";
import { observedParallelism } from "../../bench/runners/observables.js";

/**
 * The team leader, end to end against a real model: a real delivery, real
 * delegation, real evidence, and the gates all the way to ACCEPT.
 */
describe.skipIf(!E2E_RUNNABLE)("team leader end to end (real model)", () => {
  it("drives a delivery from intent to an accepted, independently reviewed outcome", async () => {
    requireOpenCode();
    const ws = await makeWorkspace("sample-task-board");
    try {
      const run = await runAgent(
        ws,
        "team-leader",
        "Add a 'priority' field (high|normal|low, default normal) to tasks in src/board.ts, with a test. Use the Agent Team tools throughout: define the delivery, record the decision, delegate the implementation and the independent review, submit criterion-linked evidence, and evaluate the gates.",
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      // the leader loaded procedures before acting
      expect(run.trace.skillsLoaded.length).toBeGreaterThan(0);
      expect(run.trace.skillsLoaded).toContain("agent-team-delivery-execution");

      // it used the whole tool surface of the method
      const tools = agentTeamToolNames(run);
      for (const expected of ["define_delivery", "handoff", "submit_evidence", "evaluate_gate"]) {
        expect(tools).toContain(expected);
      }

      // it delegated to the right specialists
      const roles = subagentRoles(run);
      expect(roles.some((r) => r.includes("explorer"))).toBe(true);
      expect(roles.some((r) => r.includes("coder"))).toBe(true);
      expect(roles.some((r) => r.includes("reviewer"))).toBe(true);

      const state = ledger(ws);
      expect(state).not.toBeNull();
      expect(state!.schemaVersion).toBe(2);

      // the delivery is registered and complete
      const delivery = state!.activeDelivery;
      expect(delivery).toBeDefined();
      expect(delivery!.id).toBe("DEL-001");
      expect(delivery!.happyPath.length).toBeGreaterThan(0);
      expect(delivery!.allowedScope.length).toBeGreaterThan(0);
      expect(delivery!.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(delivery!.validationSteps.length).toBeGreaterThan(0);
      expect(delivery!.rollback.length).toBeGreaterThan(0);

      // every handoff carries the skills the specialist must load
      expect(state!.handoffs.length).toBeGreaterThan(0);
      for (const h of state!.handoffs) {
        expect(h.skills.length).toBeGreaterThan(0);
      }
      // the review depends on the implementation it reviews
      const reviewer = state!.handoffs.find((h) => h.role === "reviewer");
      expect(reviewer).toBeDefined();
      expect(reviewer!.status).toBe("completed");
      expect(reviewer!.dependsOn.length).toBeGreaterThan(0);

      // every acceptance criterion has criterion-linked evidence
      for (const criterion of delivery!.acceptanceCriteria) {
        const ev = state!.evidence.find((e) => e.criterionId === criterion);
        expect(ev, `no evidence for criterion: ${criterion}`).toBeDefined();
        expect(ev!.status).toBe("pass");
        expect(Boolean(ev!.command ?? ev!.artifactRef)).toBe(true);
      }

      // the gates passed, all the way
      const gates = Object.fromEntries(state!.gates.map((g) => [g.gate, g.result]));
      expect(gates["INTENT"]).toBe("PASS");
      expect(gates["PLAN"]).toBe("PASS");
      expect(gates["VERIFY"]).toBe("PASS");
      expect(gates["REVIEW"]).toBe("PASS");
      expect(gates["ACCEPT"]).toBe("PASS");

      // and the work is real
      const board = readFile(ws, "src/board.ts") ?? "";
      expect(board).toMatch(/priority/i);
      const tests = readFile(ws, "src/board.test.ts") ?? "";
      expect(tests).toMatch(/priority/i);

      // the final report is verdict-first, not a transcript
      const text = finalText(run);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/priority/i);
    } finally {
      await ws.cleanup();
    }
  }, 1_500_000);

  it("runs independent units in parallel instead of one at a time", async () => {
    requireOpenCode();
    const ws = await makeWorkspace("clean-project");
    try {
      const run = await runAgent(
        ws,
        "team-leader",
        "Produce two independent documents: write a short note about local-first software to docs/local-first.md and a short note about event-sourced systems to docs/event-sourcing.md. They are independent; do not wait for one to finish before starting the other. Delegate each one.",
      );
      expect(run.timedOut).toBe(false);
      // more than one specialist was spawned
      expect(run.trace.subagents.length).toBeGreaterThanOrEqual(2);
      // and they really overlapped in time: a wave, not a queue
      expect(observedParallelism(run.trace)).toBe(true);
      // and the artifacts exist
      expect(readFile(ws, "docs/local-first.md") ?? "").not.toBe("");
      expect(readFile(ws, "docs/event-sourcing.md") ?? "").not.toBe("");
    } finally {
      await ws.cleanup();
    }
  }, 1_200_000);
});
