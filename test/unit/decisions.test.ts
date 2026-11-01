import { describe, expect, it } from "vitest";
import { resolveDecisions, type DecisionInput } from "../../src/bootstrap/decisions.js";

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    kind: "global",
    updateOnly: false,
    flags: new Set<string>(),
    leaderFileWritable: true,
    ...over,
  };
}

describe("the setup decisions", () => {
  it("never leaves the project scope with an unanswered decision", () => {
    const { decisions, pending } = resolveDecisions(input({ kind: "project" }));
    expect(pending).toEqual([]);
    expect(decisions.setDefault).toBe(true);
  });

  it("leaves the project's default agent alone when the no-default flag is present", () => {
    const { decisions } = resolveDecisions(input({ kind: "project", flags: new Set(["no-default"]) }));
    expect(decisions.setDefault).toBe(false);
  });

  it("leaves the default agent unanswered in the global scope until a flag settles it", () => {
    const { decisions, pending } = resolveDecisions(input());
    expect(decisions.setDefault).toBeUndefined();
    expect(pending).toContain("setDefault");
    const settled = resolveDecisions(input({ flags: new Set(["set-default"]) }));
    expect(settled.decisions.setDefault).toBe(true);
    expect(settled.pending).not.toContain("setDefault");
  });

  it("settles the default agent on the recorded value and leaves it alone", () => {
    const { decisions, pending } = resolveDecisions(input({ recordedDefaultAgent: "build" }));
    expect(decisions.setDefault).toBe(false);
    expect(pending).not.toContain("setDefault");
  });

  it("prefers the set-default flag over the no-default flag", () => {
    const { decisions } = resolveDecisions(input({ flags: new Set(["set-default", "no-default"]) }));
    expect(decisions.setDefault).toBe(true);
  });

  it("never changes the recorded default agent on a global update", () => {
    const { decisions, pending } = resolveDecisions(input({ updateOnly: true }));
    expect(decisions.setDefault).toBe(false);
    expect(pending).not.toContain("setDefault");
  });

  it("never lets the set-default flag reach the recorded value on a global update", () => {
    const { decisions } = resolveDecisions(input({ updateOnly: true, flags: new Set(["set-default"]) }));
    expect(decisions.setDefault).toBe(false);
  });

  it("never re-titles the leader on an update", () => {
    const { decisions } = resolveDecisions(input({ updateOnly: true, leaderTitle: "Outro Time", recordedTitle: "Meu Time" }));
    expect(decisions.leaderTitle).toBe("Meu Time");
  });

  it("falls back from the flag to the recorded title to the global title to the shipped label", () => {
    const flagged = resolveDecisions(input({ leaderTitle: "Meu Time" }));
    expect(flagged.decisions.leaderTitle).toBe("Meu Time");
    const recorded = resolveDecisions(input({ recordedTitle: "Meu Time" }));
    expect(recorded.decisions.leaderTitle).toBe("Meu Time");
    const inherited = resolveDecisions(input({ kind: "project", globalRecordedTitle: "Meu Time" }));
    expect(inherited.decisions.leaderTitle).toBe("Meu Time");
    const shipped = resolveDecisions(input({ kind: "project" }));
    expect(shipped.decisions.leaderTitle).toBeUndefined();
  });

  it("asks for the title in the global scope only while the leader file may be written", () => {
    const { pending } = resolveDecisions(input());
    expect(pending).toContain("leaderTitle");
    const edited = resolveDecisions(input({ leaderFileWritable: false }));
    expect(edited.pending).not.toContain("leaderTitle");
    const updating = resolveDecisions(input({ updateOnly: true }));
    expect(updating.pending).not.toContain("leaderTitle");
  });

  it("never inherits the global title into a leader file the plugin may not write", () => {
    const { decisions } = resolveDecisions(input({ kind: "project", globalRecordedTitle: "Meu Time", leaderFileWritable: false }));
    expect(decisions.leaderTitle).toBeUndefined();
  });

  it("resolves the same decision whatever the mode", () => {
    // The resolution takes no mode: the caller decides what to do with an
    // unanswered decision, and the decision itself is the same either way.
    for (const kind of ["global", "project"] as const) {
      const resolved = resolveDecisions(input({ kind }));
      expect(resolveDecisions(input({ kind })).decisions).toEqual(resolved.decisions);
      expect(resolveDecisions(input({ kind })).pending).toEqual(resolved.pending);
    }
    expect(resolveDecisions(input({ kind: "project" })).decisions.setDefault).toBe(true);
    expect(resolveDecisions(input({ kind: "global" })).pending).toContain("setDefault");
  });
});
