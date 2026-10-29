import { describe, expect, it } from "vitest";
import { parseOptions } from "../../src/options.js";

describe("options", () => {
  it("applies defaults", () => {
    const o = parseOptions({});
    expect(o.profile).toBe("public");
    expect(o.strictEvidence).toBe(true);
    expect(o.projectState).toBe(".agent-team");
    expect(o.model).toBeUndefined();
    expect(o.telemetry).toBe(false);
  });
  it("keeps user model configuration optional and unopinionated", () => {
    expect(parseOptions({ model: { providerID: "anthropic", modelID: "claude-x" } }).model).toEqual({ providerID: "anthropic", modelID: "claude-x" });
    expect(parseOptions({ model: { roleReasoningEffort: { "team-leader/reviewer": "high" } } }).model?.roleReasoningEffort).toEqual({ "team-leader/reviewer": "high" });
  });
  it("rejects telemetry:true (v0.1 invariant)", () => {
    expect(() => parseOptions({ telemetry: true })).toThrow();
  });
  it("rejects invalid shapes", () => {
    expect(() => parseOptions({ profile: "team" })).toThrow();
    expect(() => parseOptions({ model: { providerID: 42 } })).toThrow();
  });
  it("accepts private profile", () => {
    expect(parseOptions({ profile: "private" }).profile).toBe("private");
  });
});
