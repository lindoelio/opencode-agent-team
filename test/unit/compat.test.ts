import { describe, expect, it } from "vitest";
import {
  describeHostCapabilities,
  hostHasRequiredSurface,
  hostVersionSupport,
  parseHostVersion,
  resolveTextGenerator,
  SUPPORTED_HOST_LINES,
  SUPPORTED_SDK_RANGE,
  UnsupportedHostError,
} from "../../src/compat/host.js";

/**
 * The plugin supports the OpenCode 2.0.x, 2.1.x and 2.2.x lines. The one
 * API that changed across them is the generation surface: `ctx.generate` is
 * the full API on 2.0.x/2.1.x and deprecated on 2.2.x, where
 * `ctx.experimental.generate` is the full API. The plugin resolves it by
 * feature detection, never by version number.
 */

function ctxFor(line: "2.0" | "2.1" | "2.2"): unknown {
  const text = async (input: unknown) => ({ text: `ok:${JSON.stringify(input)}` });
  if (line === "2.2") {
    return { experimental: { generate: { text } }, generate: { text: async () => ({ text: "deprecated" }) } };
  }
  return { generate: { text } };
}

describe("host compatibility", () => {
  it("classifies every supported host line as supported", () => {
    expect(hostVersionSupport("2.0.10")).toBe("supported");
    expect(hostVersionSupport("2.0.32")).toBe("supported");
    expect(hostVersionSupport("2.1.0")).toBe("supported");
    expect(hostVersionSupport("2.1.4")).toBe("supported");
    expect(hostVersionSupport("2.2.0")).toBe("supported");
  });

  it("classifies an unsupported or unparsable version honestly", () => {
    expect(hostVersionSupport("1.19.5")).toBe("unsupported");
    expect(hostVersionSupport("2.3.0")).toBe("unsupported");
    expect(hostVersionSupport("3.0.0")).toBe("unsupported");
    expect(hostVersionSupport("unknown")).toBe("unknown");
    expect(hostVersionSupport("")).toBe("unknown");
  });

  it("parses a version with a leading v and a suffix", () => {
    expect(parseHostVersion("v2.1.4")).toMatchObject({ major: 2, minor: 1, patch: 4, support: "supported" });
    expect(parseHostVersion("2.2.0-beta.1")).toMatchObject({ major: 2, minor: 2, patch: 0 });
  });

  it("declares the supported lines and the SDK range", () => {
    expect([...SUPPORTED_HOST_LINES]).toEqual(["2.0", "2.1", "2.2"]);
    expect(SUPPORTED_SDK_RANGE).toBe(">=2.0.10 <2.3.0");
  });

  it("resolves the generator on 2.0.x and 2.1.x", async () => {
    for (const line of ["2.0", "2.1"] as const) {
      const generator = resolveTextGenerator(ctxFor(line));
      const result = await generator.text({ prompt: "hi" });
      expect(String((result as { text: string }).text)).toContain("ok:");
    }
  });

  it("prefers experimental.generate on 2.2.x over the deprecated ctx.generate", async () => {
    const generator = resolveTextGenerator(ctxFor("2.2"));
    const result = await generator.text({ prompt: "hi" });
    expect(String((result as { text: string }).text)).toContain("ok:");
    expect(String((result as { text: string }).text)).not.toContain("deprecated");
  });

  it("fails loudly when the host exposes no generation surface", () => {
    expect(() => resolveTextGenerator({})).toThrow(UnsupportedHostError);
    expect(() => resolveTextGenerator({ experimental: { generate: {} } })).toThrow(/no text-generation surface/);
  });

  it("reports the host API surface and detects a missing required surface", () => {
    const complete = {
      experimental: { generate: {} },
      credential: {},
      permission: { assert: () => {} },
      session: { hook: () => {} },
      tool: { hook: () => {} },
      command: { transform: () => {} },
      skill: { transform: () => {} },
      storage: {},
      model: { list: () => {} },
      agent: { list: () => {} },
    };
    expect(hostHasRequiredSurface(complete)).toBe(true);
    expect(describeHostCapabilities(complete).some((l) => l.startsWith("MISSING REQUIRED"))).toBe(false);

    const incomplete = { ...complete, storage: undefined };
    expect(hostHasRequiredSurface(incomplete)).toBe(false);
    expect(describeHostCapabilities(incomplete).some((l) => l.includes("MISSING REQUIRED"))).toBe(true);
  });
});
