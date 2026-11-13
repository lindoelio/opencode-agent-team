import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { _resetShellResultsForTests, parseShellEnded, recordShellEnded, runHostShell } from "../../src/orchestrator/shell.js";

afterEach(() => _resetShellResultsForTests());

function runtimeWith(ctx: Record<string, unknown>): AgentTeamRuntime {
  return createRuntime({ app: { version: "2.2.0" }, location: { project: { canonical: "/tmp/shell" } }, ...ctx } as never, { profile: "public", projectState: ".agent-team", telemetry: false } as never);
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

describe("the host's shell-ended event", () => {
  it("reads the command, the exit code, the output and the cwd", () => {
    const facts = parseShellEnded({
      type: "session.shell.ended",
      data: {
        shell: { id: "sh_1", status: "exited", command: "node --test test/board.node-test.mjs", cwd: "/tmp/proj", exit: 0 },
        output: { output: "3 pass", cursor: 0, size: 6, truncated: false },
        sessionID: "ses_child_1",
      },
    });
    expect(facts).toEqual({
      sessionID: "ses_child_1",
      command: "node --test test/board.node-test.mjs",
      exitCode: 0,
      output: "3 pass",
      cwd: "/tmp/proj",
    });
  });

  it("treats a clean exit without a code as a success and a timeout as a failure", () => {
    const exited = parseShellEnded({ type: "session.shell.ended", data: { shell: { status: "exited", command: "npm test" }, output: { output: "" }, sessionID: "s" } });
    expect(exited?.exitCode).toBe(0);
    const timedOut = parseShellEnded({ type: "session.shell.ended", data: { shell: { status: "timeout", command: "npm test" }, output: { output: "" }, sessionID: "s" } });
    expect(timedOut?.exitCode).toBe(1);
  });

  it("refuses an event it cannot attribute: no command, no session, or another type", () => {
    expect(parseShellEnded({ type: "session.idle", data: { shell: { command: "npm test" }, sessionID: "s" } })).toBeUndefined();
    expect(parseShellEnded({ type: "session.shell.ended", data: { shell: { command: "" }, sessionID: "s" } })).toBeUndefined();
    expect(parseShellEnded({ type: "session.shell.ended", data: { shell: { command: "npm test" } } })).toBeUndefined();
    expect(parseShellEnded(undefined)).toBeUndefined();
  });

  it("falls back to the envelope's session id", () => {
    const facts = parseShellEnded({ type: "session.shell.ended", sessionID: "ses_x", data: { shell: { status: "exited", command: "npm test", exit: 0 }, output: { output: "" } } });
    expect(facts?.sessionID).toBe("ses_x");
  });
});
