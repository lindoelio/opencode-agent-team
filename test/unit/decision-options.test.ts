import { describe, expect, it } from "vitest";
import { DECISION_DEFAULTS, decisionOptions, parseOptions } from "../../src/options.js";

describe("decision options", () => {
  it("defaults to the automatic mode with no thresholds", () => {
    const options = decisionOptions(parseOptions({}));
    expect(options.mode).toBe("auto");
    expect(options.thresholds).toEqual({});
    expect(options.unavailable).toBe("escalate");
    expect(options.timeoutMs).toBe(10000);
    expect(options.model).toBeUndefined();
  });

  it("keeps the block optional so an unconfigured installation is unchanged", () => {
    expect(parseOptions({}).decision).toBeUndefined();
    expect(decisionOptions(parseOptions({}))).toEqual(DECISION_DEFAULTS);
  });

  it("accepts a configured threshold set", () => {
    const options = decisionOptions(parseOptions({ decision: { mode: "required", thresholds: { review: { probability: 0.9, confidence: 0.8 } } } }));
    expect(options.mode).toBe("required");
    expect(options.thresholds.review).toEqual({ probability: 0.9, confidence: 0.8 });
  });

  it("pins a decision model", () => {
    expect(decisionOptions(parseOptions({ decision: { model: "openrouter/typesafe/jev-1.14" } })).model).toBe("openrouter/typesafe/jev-1.14");
  });

  it("rejects a threshold set that is not a known use", () => {
    expect(() => parseOptions({ decision: { thresholds: { bogus: { probability: 1, confidence: 1 } } } })).toThrow();
  });

  it("rejects a minimum outside the unit interval", () => {
    expect(() => parseOptions({ decision: { thresholds: { review: { probability: 2, confidence: 0.5 } } } })).toThrow();
    expect(() => parseOptions({ decision: { thresholds: { review: { probability: 0.5, confidence: -1 } } } })).toThrow();
  });

  it("rejects an unknown unavailable behaviour", () => {
    expect(() => parseOptions({ decision: { unavailable: "retry" } })).toThrow();
  });
});
