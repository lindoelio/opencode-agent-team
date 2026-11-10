import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_HOST_MESSAGE } from "../../src/compat/host.js";
import {
  _resetHostNoticesForTests,
  assertSupportedHost,
  assertTeamRuntime,
  hostGate,
  shouldNoticeOldHost,
} from "../../src/orchestrator/host-gate.js";
import type { AgentTeamRuntime } from "../../src/runtime.js";

function runtime(version: string, session: Record<string, unknown> = {}): AgentTeamRuntime {
  return {
    ctx: {
      app: { version },
      session,
    } as never,
    options: {} as never,
  };
}

afterEach(() => _resetHostNoticesForTests());

describe("host gate", () => {
  it("accepts 2.2.0 and newer", () => {
    expect(hostGate(runtime("2.2.0")).versionSupported).toBe(true);
    expect(hostGate(runtime("2.2.7")).versionSupported).toBe(true);
    expect(() => assertSupportedHost(runtime("2.2.0"))).not.toThrow();
  });

  it("refuses a host below the floor with one sentence", () => {
    expect(hostGate(runtime("2.1.4")).versionSupported).toBe(false);
    expect(() => assertSupportedHost(runtime("2.1.4"))).toThrow(UPDATE_HOST_MESSAGE);
    expect(() => assertSupportedHost(runtime("2.0.10"))).toThrow(/2\.2\.0/);
  });

  it("refuses a launch when session.create is missing", () => {
    expect(() => assertTeamRuntime(runtime("2.2.0", { prompt: async () => ({}) }))).toThrow(/session\.create/);
    expect(() => assertTeamRuntime(runtime("2.2.0", { create: async () => ({}), prompt: async () => ({}) }))).not.toThrow();
  });

  it("notices an old host once per session", () => {
    const old = runtime("2.1.4");
    expect(shouldNoticeOldHost(old, "ses_a")).toBe(true);
    expect(shouldNoticeOldHost(old, "ses_a")).toBe(false);
    expect(shouldNoticeOldHost(old, "ses_b")).toBe(true);
    expect(shouldNoticeOldHost(runtime("2.2.0"), "ses_a")).toBe(false);
  });
});
