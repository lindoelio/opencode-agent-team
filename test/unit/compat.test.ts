import { describe, expect, it } from "vitest";
import {
  describeHostCapabilities,
  hostHasRequiredSurface,
  hostVersionAtLeast,
  hostVersionSupport,
  MINIMUM_HOST_VERSION,
  parseHostVersion,
  resolveDecisionGenerator,
  resolveSessionLauncher,
  resolveShellSurface,
  resolveTextGenerator,
  SUPPORTED_HOST_LINES,
  SUPPORTED_SDK_RANGE,
  UnsupportedHostError,
  UPDATE_HOST_MESSAGE,
} from "../../src/compat/host.js";

/**
 * The plugin requires OpenCode 2.2.0 or newer. The version is one signal; the
 * child-session surface is the one the team runtime actually needs, so it is
 * detected rather than assumed.
 */

function ctxFor(line: "2.2" | "newer"): unknown {
  const text = async (input: unknown) => ({ text: `ok:${JSON.stringify(input)}` });
  if (line === "2.2") {
    return { experimental: { generate: { text } }, generate: { text: async () => ({ text: "deprecated" }) } };
  }
  return { experimental: { generate: { text } } };
}

describe("host compatibility", () => {
  it("accepts 2.2.0 and every newer version", () => {
    expect(hostVersionSupport("2.2.0")).toBe("supported");
    expect(hostVersionSupport("2.2.7")).toBe("supported");
    expect(hostVersionSupport("2.3.0")).toBe("supported");
    expect(hostVersionSupport("3.0.0")).toBe("supported");
    expect(hostVersionAtLeast("2.2.0")).toBe(true);
  });

  it("rejects every version below 2.2.0", () => {
    expect(hostVersionSupport("2.0.10")).toBe("unsupported");
    expect(hostVersionSupport("2.1.4")).toBe("unsupported");
    expect(hostVersionSupport("1.19.5")).toBe("unsupported");
    expect(hostVersionSupport("unknown")).toBe("unknown");
    expect(hostVersionSupport("")).toBe("unknown");
  });

  it("parses a version with a leading v and a suffix", () => {
    expect(parseHostVersion("v2.1.4")).toMatchObject({ major: 2, minor: 1, patch: 4, support: "unsupported" });
    expect(parseHostVersion("2.2.0-beta.1")).toMatchObject({ major: 2, minor: 2, patch: 0, support: "supported" });
  });

  it("declares the floor and the SDK range", () => {
    expect([...SUPPORTED_HOST_LINES]).toEqual(["2.2"]);
    expect(MINIMUM_HOST_VERSION).toBe("2.2.0");
    expect(SUPPORTED_SDK_RANGE).toBe(">=2.2.0 <2.3.0");
    expect(UPDATE_HOST_MESSAGE).toContain("2.2.0");
  });

  it("prefers experimental.generate and falls back to the deprecated surface", async () => {
    const generator = resolveTextGenerator(ctxFor("2.2"));
    const result = await generator.text({ prompt: "hi" });
    expect(String((result as { text: string }).text)).toContain("ok:");
    expect(String((result as { text: string }).text)).not.toContain("deprecated");
  });

  it("fails loudly when the host exposes no generation surface", () => {
    expect(() => resolveTextGenerator({})).toThrow(UnsupportedHostError);
    expect(() => resolveTextGenerator({ experimental: { generate: {} } })).toThrow(/no text-generation surface/);
  });

  it("resolves the child-session surface by feature detection", () => {
    const create = async () => ({});
    const prompt = async () => ({});
    expect(resolveSessionLauncher({ session: { create, prompt } }).available).toBe(true);
    expect(resolveSessionLauncher({ session: { create } }).available).toBe(false);
    expect(resolveSessionLauncher({ session: { prompt } }).available).toBe(false);
    expect(resolveSessionLauncher({}).available).toBe(false);
  });

  it("exposes the archive surface only when the host can archive", async () => {
    const create = async () => ({ id: "ses_child" });
    const prompt = async () => ({});
    const plain = resolveSessionLauncher({ session: { create, prompt } });
    expect(plain.launcher?.archive).toBeUndefined();

    const calls: unknown[] = [];
    const updating = resolveSessionLauncher({
      session: {
        create,
        prompt,
        update: async (input: unknown) => {
          calls.push(input);
        },
      },
    });
    expect(updating.launcher?.archive).toBeDefined();
    await updating.launcher!.archive!("ses_child");
    expect(calls).toEqual([{ sessionID: "ses_child", archived: true }]);
  });

  it("resolves a shell surface only when the host exposes one", () => {
    expect(resolveShellSurface({ session: { shell: async () => ({}) } }).available).toBe(true);
    expect(resolveShellSurface({ shell: { run: async () => ({}) } }).available).toBe(true);
    expect(resolveShellSurface({}).available).toBe(false);
  });

  it("reports the host API surface and detects a missing required surface", () => {
    const complete = {
      experimental: { generate: {} },
      credential: {},
      permission: { assert: () => {} },
      session: { hook: () => {}, create: () => {} },
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

  it("fails the required surface when session.create is missing", () => {
    const noCreate = {
      experimental: { generate: {} },
      session: { hook: () => {} },
      tool: { hook: () => {} },
      command: { transform: () => {} },
      skill: { transform: () => {} },
      storage: {},
      model: { list: () => {} },
      agent: { list: () => {} },
    };
    expect(hostHasRequiredSurface(noCreate)).toBe(false);
    expect(describeHostCapabilities(noCreate).some((l) => l.includes("session.create"))).toBe(true);
  });

  it("resolves the decision surface when the host exposes one", async () => {
    const decisions = async (input: unknown) => ({ answers: [{ type: "predicate", name: "q", probability: 0.9 }], echoed: input });
    const surface = resolveDecisionGenerator({ experimental: { generate: { decisions } } });
    expect(surface.available).toBe(true);
    const result = (await surface.generator!.decisions({ model: { id: "m", providerID: "p" } })) as { answers: unknown[] };
    expect(result.answers).toHaveLength(1);
  });

  it("reports a host without the decision surface as unavailable rather than failing", () => {
    expect(resolveDecisionGenerator({}).available).toBe(false);
    expect(resolveDecisionGenerator({ experimental: { generate: {} } }).available).toBe(false);
    expect(resolveDecisionGenerator({ experimental: { generate: { decisions: "not a function" } } }).available).toBe(false);
  });

  it("never requires the decision surface, so a host without it still passes the preflight", () => {
    const withoutDecisions = {
      experimental: { generate: { text: () => {} } },
      session: { hook: () => {}, create: () => {} },
      tool: { hook: () => {} },
      command: { transform: () => {} },
      skill: { transform: () => {} },
      storage: {},
      model: { list: () => {} },
      agent: { list: () => {} },
    };
    expect(hostHasRequiredSurface(withoutDecisions)).toBe(true);
    expect(describeHostCapabilities(withoutDecisions).some((l) => l.startsWith("MISSING REQUIRED"))).toBe(false);
    expect(describeHostCapabilities(withoutDecisions)).not.toContain("present: experimental.generate.decisions");
  });
});
