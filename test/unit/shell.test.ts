import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { _resetShellResultsForTests, recordShellEnded, runHostShell } from "../../src/orchestrator/shell.js";

afterEach(() => _resetShellResultsForTests());

function runtimeWith(ctx: Record<string, unknown>): AgentTeamRuntime {
  return createRuntime({ app: { version: "2.2.0" }, location: { project: { canonical: "/tmp/shell" } }, ...ctx } as never, { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false } as never);
}

describe("host shell", () => {
  it("returns undefined when the host exposes no shell", async () => {
    expect(await runHostShell(runtimeWith({}), { sessionID: "s", command: "npm test" })).toBeUndefined();
  });

  it("accepts a synchronous result from the location shell", async () => {
    const runtime = runtimeWith({ shell: { run: async () => ({ exitCode: 0, stdout: "ok" }) } });
    expect(await runHostShell(runtime, { sessionID: "s", command: "npm test" })).toEqual({ exitCode: 0, output: "ok" });
  });

  it("accepts a synchronous result from the session shell", async () => {
    const runtime = runtimeWith({ session: { shell: async () => ({ code: 2, output: "boom" }) } });
    expect(await runHostShell(runtime, { sessionID: "s", command: "npm test" })).toEqual({ exitCode: 2, output: "boom" });
  });

  it("waits for the shell-ended event when the call returns void", async () => {
    const runtime = runtimeWith({ session: { shell: async () => undefined } });
    const pending = runHostShell(runtime, { sessionID: "ses_shell", command: "npm test" });
    setTimeout(() => recordShellEnded("ses_shell", { exitCode: 0, output: "event ok" }), 10);
    await expect(pending).resolves.toEqual({ exitCode: 0, output: "event ok" });
  });

  it("normalises an unknown exit code to a failure", async () => {
    const runtime = runtimeWith({ shell: { run: async () => ({ output: "no code" }) } });
    expect((await runHostShell(runtime, { sessionID: "s", command: "npm test" }))?.exitCode).toBe(1);
  });
});
