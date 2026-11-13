import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { E2E_RUNNABLE, E2E_TEST_TIMEOUT_MS, agentTeamToolNames, ledger, makeWorkspace, requireOpenCode, runAgent } from "./harness.js";

/**
 * The calibrated decision path against a real decision model.
 *
 * The chat model drives the session; JEV answers the bounded question. The
 * assertion is on the plugin's own judgement document, not on prose: the
 * decision id, the model that answered, the criterion it was bound to and the
 * verdict are all artifacts.
 */
/** The decision model the journey pins; set AGENT_TEAM_E2E_DECISION_MODEL for the paid one. */
const DECISION_MODEL = process.env["AGENT_TEAM_E2E_DECISION_MODEL"] ?? "opencode/jev-1.13-free";

describe.skipIf(!E2E_RUNNABLE)("calibrated decision model (real model)", () => {
  it("asks JEV a bounded question and records the judgement", async () => {
    requireOpenCode();
    const ws = await makeWorkspace("sample-task-board", {}, {
      decision: { mode: "auto", model: DECISION_MODEL },
    });
    try {
      const run = await runAgent(
        ws,
        "team-leader",
        "Define a delivery with exactly one acceptance criterion: 'the board lists tasks'. " +
          "Declare one validation step for it with the command 'node --test test/board.node-test.mjs'. " +
          "Then ask the decision model one bounded predicate question about whether src/board.ts satisfies that criterion, " +
          "using agent_team_evaluate_decision with criterionId exactly 'the board lists tasks'. " +
          "Submit the judgement as evidence for the criterion. Write the decision id and its verdict to NOTES.md.",
      );
      expect(run.timedOut).toBe(false);
      expect(agentTeamToolNames(run)).toContain("define_delivery");
      expect(agentTeamToolNames(run)).toContain("evaluate_decision");

      // The plugin's own record of the decision, not the model's summary.
      const dir = path.join(ws.root, ".agent-team", "judgements");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
      expect(files.length).toBeGreaterThan(0);
      const doc = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), "utf8")) as {
        model?: { ref?: string } | string;
        criterion?: string;
        verdict?: string;
        decisionId?: string;
      };
      const model = typeof doc.model === "string" ? doc.model : doc.model?.ref;
      expect(model).toContain("jev");
      expect(doc.criterion).toBe("the board lists tasks");
      expect(["satisfied", "escalate", "unanswered"]).toContain(doc.verdict);
      expect(doc.decisionId).toBeTruthy();

      // The judgement above is the required proof. The router has its own
      // short budget and may legitimately degrade to no route; when it did
      // answer, it used the pinned decision model.
      const state = ledger(ws) as { route?: { model?: string } } | null;
      if (state?.route?.model) expect(state.route.model).toContain("jev");
    } finally {
      await ws.cleanup();
    }
  }, E2E_TEST_TIMEOUT_MS);
});
