import { describe, expect, it } from "vitest";
import { canTransitionPhase, canTransitionStatus } from "../../src/domain/state-machine.js";

describe("state machine", () => {
  it("allows canonical forward steps", () => {
    expect(canTransitionPhase("INTENT", "DISCOVER")).toBe(true);
    expect(canTransitionPhase("PLAN", "EXECUTE")).toBe(true);
    expect(canTransitionPhase("VERIFY", "REVIEW")).toBe(true);
    expect(canTransitionPhase("ACCEPT", "DELIVER")).toBe(true);
  });
  it("rejects forward jumps", () => {
    expect(canTransitionPhase("INTENT", "PLAN")).toBe(false);
    expect(canTransitionPhase("DISCOVER", "EXECUTE")).toBe(false);
  });
  it("allows documented backward returns", () => {
    expect(canTransitionPhase("VERIFY", "EXECUTE")).toBe(true);
    expect(canTransitionPhase("REVIEW", "VERIFY")).toBe(true);
  });
  it("handles work status terminal + reopen", () => {
    expect(canTransitionStatus("IN_PROGRESS", "FAILED")).toBe(true);
    expect(canTransitionStatus("VERIFYING", "BLOCKED")).toBe(true);
    expect(canTransitionStatus("FAILED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionStatus("DELIVERED", "FAILED")).toBe(false);
    expect(canTransitionStatus("DRAFT", "READY")).toBe(true);
  });
  it("allows the phase-derived progression and refuses to skip a reachable status", () => {
    // INTENT is DRAFT and DISCOVER is IN_PROGRESS: one phase step, two status
    // steps, because no phase produces READY.
    expect(canTransitionStatus("DRAFT", "IN_PROGRESS")).toBe(true);
    expect(canTransitionStatus("IN_PROGRESS", "VERIFYING")).toBe(true);
    // skipping a reachable status is refused
    expect(canTransitionStatus("DRAFT", "VERIFYING")).toBe(false);
    expect(canTransitionStatus("ACCEPTED", "DELIVERED")).toBe(false);
    // a status never goes backwards silently
    expect(canTransitionStatus("REVIEWING", "IN_PROGRESS")).toBe(false);
  });
});
