import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { E2E_RUNNABLE, E2E_TEST_TIMEOUT_MS, agentTeamToolNames, finalText, ledger, makeWorkspace, readFile, requireOpenCode, runAgent } from "./harness.js";
import { handoffsRunInParallel } from "../../src/domain/handoff.js";

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
        "Add a 'priority' field (high|normal|low, default normal) to tasks in src/board.ts, with a test. Use the Agent Team tools throughout: define the delivery, record the decision, delegate the implementation and the independent review, submit criterion-linked evidence, and evaluate the INTENT, PLAN, VERIFY, REVIEW and ACCEPT gates specifically. Declare the validation step(s) with the command exactly `node --test test/board.node-test.mjs` — this project runs offline with the Node test runner, so do not use npx/vitest or wrap the command in cd or a pipe — and have the specialist run that exact command.",
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      // The procedure is injected into the leader's context by phase, so a
      // `skill` tool call is not evidence of anything here; the ledger and the
      // files below are what the run has to prove.

      // it used the whole tool surface of the method. `submit_evidence` is
      // not required here: an observed check is recorded by the plugin, and
      // the tool exists for rows observation cannot produce.
      const tools = agentTeamToolNames(run);
      for (const expected of ["define_delivery", "handoff", "evaluate_gate"]) {
        expect(tools).toContain(expected);
      }

      // it delegated to the right specialists. A wave is booked through
      // agent_team_handoff and never appears as a host subagent call, so the
      // ledger is the artifact that records the delegation.
      const state = ledger(ws);
      expect(state).not.toBeNull();
      expect(state!.schemaVersion).toBe(4);
      const roles = state!.handoffs.map((h) => h.role);
      // Discovery is skipped only when the route allows it: a `fix` skips it
      // by design, and a `change` skips it only through a recorded override.
      // It is never silent.
      if (!roles.includes("explorer")) {
        const route = state!.route;
        const fixRoute = route?.engagementClass === "fix";
        const recordedOverride = route?.overridden === true && route.namesFileAndSymptom === true;
        expect(fixRoute || recordedOverride, "discovery was skipped without a fix route or a recorded override").toBe(true);
      }
      expect(roles.some((r) => r.includes("coder"))).toBe(true);
      expect(roles.some((r) => r.includes("reviewer"))).toBe(true);

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
      const tests = `${readFile(ws, "src/board.test.ts") ?? ""}\n${readFile(ws, "test/board.node-test.mjs") ?? ""}`;
      expect(tests).toMatch(/priority/i);

      // the final report is verdict-first, not a transcript
      const text = finalText(run);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/priority/i);
    } finally {
      await ws.cleanup();
    }
  }, E2E_TEST_TIMEOUT_MS);

  it("runs independent units in parallel instead of one at a time", async () => {
    requireOpenCode();
    const ws = await makeWorkspace("clean-project");
    try {
      const run = await runAgent(
        ws,
        "team-leader",
        "Produce two independent documents: write a short note about local-first software to docs/local-first.md and a short note about event-sourced systems to docs/event-sourcing.md. They are independent; do not wait for one to finish before starting the other. Delegate each one. If the Agent Team route requires discovery, book the explorer first; then book the two writers in a single wave.",
      );
      expect(run.timedOut).toBe(false);
      // two units were booked, and they were booked together: one wave, not a
      // queue. The wave id is the ledger's own record of what was booked in
      // one call — the host's subagent trace does not see the wave API.
      const state = ledger(ws);
      const handoffs = state?.handoffs ?? [];
      expect(handoffs.length).toBeGreaterThanOrEqual(2);
      expect(handoffsRunInParallel(handoffs)).toBe(true);
      // and the artifacts exist
      expect(readFile(ws, "docs/local-first.md") ?? "").not.toBe("");
      expect(readFile(ws, "docs/event-sourcing.md") ?? "").not.toBe("");
    } finally {
      await ws.cleanup();
    }
  }, E2E_TEST_TIMEOUT_MS);
});
