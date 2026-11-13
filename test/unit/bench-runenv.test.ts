import { describe, expect, it } from "vitest";
import { isolatedConfigHome, runEnv } from "../../bench/runners/opencode.js";

describe("the measured run environment", () => {
  it("isolates the global config so a globally installed plugin cannot join the run", () => {
    const env = runEnv("/tmp/ws-1");
    expect(env.PWD).toBe("/tmp/ws-1");
    expect(env.XDG_CONFIG_HOME).toBe(isolatedConfigHome());
    expect(env.XDG_CONFIG_HOME).not.toBe(process.env.XDG_CONFIG_HOME);
    // Credentials live in the data home: moving it would log the run out.
    expect(env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("lets a caller point a run at a specific configuration on purpose", () => {
    expect(runEnv("/tmp/ws-1", { XDG_CONFIG_HOME: "/custom" }).XDG_CONFIG_HOME).toBe("/custom");
  });
});
