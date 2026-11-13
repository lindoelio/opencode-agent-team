import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeGate } from "../../src/tools/gate.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { observeDeclaredCheck } from "../../src/orchestrator/observe.js";
import { initializeState, readState } from "../../src/ledger/store.js";
import { registerContextHook, capabilityNotices, _resetNoticedForTests } from "../../src/hooks/context.js";

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

function runtimeFor(root: string, ctxExtra: Record<string, unknown> = {}): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    {
      location: { project: { canonical: root } },
      options: {},
      app: { version: "2.2.0" },
      session: {
        create: async () => ({ id: `ses_child_${++n}` }),
        prompt: async () => ({}),
        get: async () => ({ data: {} }),
        hook: async () => ({ dispose: async () => {} }),
        ...((ctxExtra["session"] as object) ?? {}),
      },
      ...ctxExtra,
    } as never,
    {
      profile: "public",
      projectState: ".agent-team",
      telemetry: false,
      autonomy: { mode: "yolo", askBefore: [] },
      orchestration: { maxParallelSpecialists: 6, allowedCheckPrefixes: [] },
    } as never,
  );
}

const CHECK = "node --test test/board.node-test.mjs";

/** A runtime whose context hook is captured instead of registered with a host. */
function hookRuntime(root: string, captured: Array<(e: never) => unknown>, ctxExtra: Record<string, unknown> = {}): AgentTeamRuntime {
  return runtimeFor(root, {
    ...ctxExtra,
    session: {
      hook: async (_name: string, cb: (e: never) => unknown) => {
        captured.push(cb);
        return { dispose: async () => {} };
      },
      ...(ctxExtra["session"] as object ?? {}),
    },
  });
}


async function deliveryWith(root: string, runtime: AgentTeamRuntime): Promise<void> {
  await executeState(runtime, { action: "initialize", outcome: "Ship it" }, leader);
  await executeDelivery(
    runtime,
    {
      expectedRevision: 0,
      title: "T",
      userOutcome: "U",
      happyPath: ["h"],
      allowedScope: ["src/**"],
      acceptanceCriteria: ["AC-1"],
      validationSteps: [{ criterionId: "AC-1", command: CHECK }],
      rollback: "revert",
    },
    leader,
  );
}

describe("observation without a host shell surface", () => {
  it("records the host-reported exit code of a declared check as observed evidence", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await deliveryWith(root, runtime);
    const recorded = await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "3 pass", cwd: root });
    expect(recorded).toBe(1);
    const state = await readState(root);
    const row = state!.evidence[0]!;
    expect(row.observed).toBe(true);
    expect(row.status).toBe("pass");
    expect(row.command).toBe(CHECK);
    // the gate now has something to read
    const gate = JSON.parse((await executeGate(runtime, { gate: "VERIFY", expectedRevision: state!.revision }, leader)).content);
    expect(gate.result).toBe("PASS");
  });

  it("records a failing check as a fail, and a later pass supersedes it", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await deliveryWith(root, runtime);
    await observeDeclaredCheck(root, { command: CHECK, exitCode: 1, output: "red", cwd: root });
    let state = await readState(root);
    let gate = JSON.parse((await executeGate(runtime, { gate: "VERIFY", expectedRevision: state!.revision }, leader)).content);
    expect(gate.result).toBe("FAIL");
    await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "green", cwd: root });
    state = await readState(root);
    gate = JSON.parse((await executeGate(runtime, { gate: "VERIFY", expectedRevision: state!.revision }, leader)).content);
    expect(gate.result).toBe("PASS");
  });

  it("ignores a command nobody declared, a check run outside the project, and a repeat pass", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await deliveryWith(root, runtime);
    expect(await observeDeclaredCheck(root, { command: "npm test", exitCode: 0, output: "ok", cwd: root })).toBe(0);
    expect(await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "ok", cwd: os.tmpdir() })).toBe(0);
    expect(await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "ok", cwd: root })).toBe(1);
    // an observed pass is not recorded twice
    expect(await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "ok", cwd: root })).toBe(0);
  });

  it("records nothing when there is no active delivery", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    expect(await observeDeclaredCheck(root, { command: CHECK, exitCode: 0, output: "ok", cwd: root })).toBe(0);
  });
});

describe("declared skills", () => {
  it("drops an unknown skill id, keeps the wave, and says so", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "launch",
            expectedRevision: 0,
            units: [
              {
                role: "reviewer",
                objective: "review it",
                context: [],
                allowedScope: ["src/**"],
                prohibitedScope: [],
                questions: [],
                requiredEvidence: ["findings"],
                stopCondition: "reviewed",
                skills: ["code-review-hardening"],
              },
            ],
          },
          leader,
        )
      ).content,
    );
    // The wave is not lost to a typo, and the note names the mistake.
    expect(out.ids).toEqual(["HND-0001"]);
    expect(out.note).toContain("ignored unknown skill ids: code-review-hardening");
    expect(out.note).toContain("agent-team-code-review");
    // The handoff carries the role's own procedures, so the child prompt
    // embeds a real one instead of nothing.
    const state = await readState(root);
    expect(state!.handoffs[0]!.skills).toContain("agent-team-code-review");
    expect(out.prompts[0]).toContain("Primary procedure (embedded):");
  });

  it("keeps the valid skills a unit declared", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    const runtime = runtimeFor(root);
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          {
            action: "launch",
            expectedRevision: 0,
            units: [
              {
                role: "reviewer",
                objective: "review the design",
                context: [],
                allowedScope: ["docs/**"],
                prohibitedScope: [],
                questions: [],
                requiredEvidence: ["findings"],
                stopCondition: "reviewed",
                skills: ["agent-team-design-review", "not-a-skill"],
              },
            ],
          },
          leader,
        )
      ).content,
    );
    const state = await readState(root);
    expect(state!.handoffs[0]!.skills).toEqual(["agent-team-design-review"]);
    // The embedded procedure follows the declared skill, not the role default.
    expect(out.prompts[0]).toContain("state coverage");
  });
});

describe("capability notices", () => {
  it("states a degraded host capability once per session", async () => {
    _resetNoticedForTests();
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-obs-"));
    await initializeState({ projectRoot: root, sessionId: "s", actor: "team-leader", outcome: "O" });
    // no shell surface, no decision surface
    const runtime = runtimeFor(root);
    const notices = capabilityNotices(runtime);
    expect(notices.some((n) => n.includes("no shell surface"))).toBe(true);
    expect(notices.some((n) => n.includes("no decision surface"))).toBe(true);

    const captured: Array<(e: never) => unknown> = [];
    const reg = await registerContextHook(hookRuntime(root, captured));
    const first = { agent: "team-leader", sessionID: "sess-a", system: [] as unknown[], options: {}, tools: {} } as never;
    await captured[0]!(first);
    const firstTexts = (first as unknown as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    expect(firstTexts).toContain("Agent Team host capability: the plugin has no shell surface");
    // the same session is not told twice
    const second = { agent: "team-leader", sessionID: "sess-a", system: [] as unknown[], options: {}, tools: {} } as never;
    await captured[0]!(second);
    const secondTexts = (second as unknown as { system: Array<{ text: string }> }).system.map((s) => s.text).join("\n");
    expect(secondTexts).not.toContain("Agent Team host capability");
    // a host with a shell surface has nothing to report about it
    const withShell = runtimeFor(root, { shell: { run: async () => ({ exitCode: 0, output: "" }) } });
    expect(capabilityNotices(withShell).some((n) => n.includes("no shell surface"))).toBe(false);
    await reg.dispose();
    _resetNoticedForTests();
  });
});
