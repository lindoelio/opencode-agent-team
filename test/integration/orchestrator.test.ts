import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { executeState } from "../../src/tools/state.js";
import { executeDelivery } from "../../src/tools/delivery.js";
import { executeHandoff } from "../../src/tools/handoff.js";
import { readState } from "../../src/ledger/store.js";
import { registerOrchestrator, reconcileRunning, SETTLE_GRACE_MS } from "../../src/orchestrator/launch.js";

const leader = { sessionID: "sess-1", agent: "team-leader" } as never;

interface EventSource {
  push(event: unknown): void;
  /** True once the subscriber has consumed every pushed event. */
  drained(): boolean;
  subscribe: (input: { signal?: AbortSignal }) => AsyncIterable<unknown>;
}

function controllableEvents(): EventSource {
  const queue: unknown[] = [];
  let resolveNext: ((result: IteratorResult<unknown>) => void) | null = null;
  let pushed = 0;
  let consumed = 0;
  const iterator: AsyncIterator<unknown> = {
    next: () => {
      if (queue.length > 0) {
        consumed += 1;
        return Promise.resolve({ value: queue.shift(), done: false });
      }
      return new Promise((resolve) => {
        resolveNext = (result) => {
          if (result.done !== true) consumed += 1;
          resolve(result);
        };
      });
    },
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    push(event: unknown) {
      pushed += 1;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    drained: () => consumed >= pushed,
    subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }),
  };
}

function runtimeFor(root: string, events: EventSource, get: unknown): AgentTeamRuntime {
  let n = 0;
  return createRuntime(
    {
      app: { version: "2.2.0" },
      location: { project: { canonical: root } },
      session: {
        create: async () => ({ id: `ses_child_${++n}` }),
        prompt: async () => ({}),
        synthetic: async () => ({}),
        get,
      },
      event: { subscribe: events.subscribe },
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

const UNIT = {
  role: "explorer" as const,
  objective: "map the domain",
  context: ["src/board.ts holds the flow"],
  allowedScope: ["src/**"],
  prohibitedScope: [],
  questions: ["q?"],
  requiredEvidence: ["glossary"],
  stopCondition: "mapped",
};

async function launched(root: string) {
  const events = controllableEvents();
  const runtime = runtimeFor(root, events, async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID, status: "idle" } }));
  await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
  const out = JSON.parse((await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT, { ...UNIT, role: "coder" as const, skills: ["agent-team-writing-review"] }] }, leader)).content);
  return { runtime, events, out };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Flushes real I/O turns without depending on faked timers. */
async function eventually(check: () => Promise<boolean>, attempts = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

describe("the child prompt", () => {  it("delivers the unit context, the report shape, and the role boundary", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const { runtime, out } = await launched(root);
    // explorer: read-only, no helper permission, context delivered
    const explorerPrompt = out.prompts[0] as string;
    expect(explorerPrompt).toContain("Context:");
    expect(explorerPrompt).toContain("- src/board.ts holds the flow");
    expect(explorerPrompt).toContain("You cannot launch helper agents");
    expect(explorerPrompt).not.toContain("You may launch built-in OpenCode helper agents");
    expect(explorerPrompt).toContain("Report shape (SpecialistResult@1, strict)");
    // The primary procedure follows the skill the leader declared, not the
    // role's default: this coder unit was booked with the writing-review skill.
    const coderPrompt = out.prompts[1] as string;
    expect(coderPrompt).toContain("You may launch built-in OpenCode helper agents");
    expect(coderPrompt).toContain("Primary procedure (embedded):");
    expect(coderPrompt).toContain("agent-team-writing-review");
    expect(coderPrompt).toContain("claim chain");
    await runtime.ctx.event.subscribe({} as never);
  });

  it("embeds nothing for a role that owns no procedure", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const events = controllableEvents();
    const runtime = runtimeFor(root, events, async () => ({}));
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    // The designer owns no skill: its direction procedure lives in the agent
    // template, so the child prompt must not invent one.
    const out = JSON.parse(
      (
        await executeHandoff(
          runtime,
          { action: "launch", expectedRevision: 0, units: [{ ...UNIT, role: "designer" as const }] },
          leader,
        )
      ).content,
    );
    expect(out.prompts[0]).toContain("Skills (load with the skill tool when the task matches; the primary procedure is embedded below): (none)");
    expect(out.prompts[0]).not.toContain("Primary procedure (embedded):");
  });
});

describe("observation from the host event stream", () => {
  it("records a declared check from the host's shell-ended event", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const events = controllableEvents();
    const runtime = runtimeFor(root, events, async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }));
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeDelivery(
      runtime,
      {
        expectedRevision: 0,
        title: "T",
        userOutcome: "U",
        happyPath: ["h"],
        allowedScope: ["src/**"],
        acceptanceCriteria: ["AC-1"],
        validationSteps: [{ criterionId: "AC-1", command: "node --test test/board.node-test.mjs" }],
        rollback: "revert",
      },
      leader,
    );
    const reg = await registerOrchestrator(runtime);
    events.push({
      type: "session.shell.ended",
      data: {
        sessionID: "ses_child_1",
        shell: { id: "sh_1", status: "exited", command: "node --test test/board.node-test.mjs", cwd: root, exit: 0 },
        output: { output: "5 pass", cursor: 0, size: 6, truncated: false },
      },
    });
    expect(await eventually(async () => (await readState(root))?.evidence.some((e) => e.criterionId === "AC-1" && e.observed === true && e.status === "pass") === true)).toBe(true);
    await reg.dispose();
  });
});

describe("settling a booked session", () => {
  it("waits out the grace period before a booked handoff is marked failed on idle", async () => {
    // Only the settle timer is faked: the ledger I/O still needs real turns.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const { runtime, events, out } = await launched(root);
    const child = out.sessions[0].sessionID as string;
    const reg = await registerOrchestrator(runtime);
    events.push({ type: "session.idle", data: { sessionID: child } });
    // Wait until the subscriber consumed the event and armed the timer before
    // advancing the clock, otherwise the timer is armed after the last tick.
    expect(await eventually(async () => events.drained())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect((await readState(root))?.handoffs[0]?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(SETTLE_GRACE_MS - 1);
    expect((await readState(root))?.handoffs[0]?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    expect(await eventually(async () => (await readState(root))?.handoffs[0]?.status === "failed")).toBe(true);
    await reg.dispose();
  });

  it("settles immediately on an explicit execution failure", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const { runtime, events, out } = await launched(root);
    const reg = await registerOrchestrator(runtime);
    events.push({ type: "session.execution.failed", data: { sessionID: out.sessions[0].sessionID } });
    expect(await eventually(async () => events.drained())).toBe(true);
    expect(await eventually(async () => (await readState(root))?.handoffs[0]?.status === "failed")).toBe(true);
    await reg.dispose();
  });

  it("reconciles on reload: a long-idle session fails, a fresh one stays booked", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const events = controllableEvents();
    const idleAt = Date.now() - SETTLE_GRACE_MS - 1000;
    const runtime = runtimeFor(root, events, async ({ sessionID }: { sessionID: string }) => ({ data: { time: { idle: idleAt }, id: sessionID } }));
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT] }, leader);
    await reconcileRunning(runtime);
    expect((await readState(root))?.handoffs[0]?.status).toBe("failed");

    const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const fresh = runtimeFor(root2, controllableEvents(), async ({ sessionID }: { sessionID: string }) => ({ data: { time: { idle: Date.now() }, id: sessionID } }));
    await executeState(fresh, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(fresh, { action: "launch", expectedRevision: 0, units: [UNIT] }, leader);
    await reconcileRunning(fresh);
    expect((await readState(root2))?.handoffs[0]?.status).toBe("running");
  });

  it("settles when the session cannot be read at all", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const events = controllableEvents();
    const runtime = runtimeFor(root, events, async () => {
      throw new Error("gone");
    });
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT] }, leader);
    await reconcileRunning(runtime);
    expect((await readState(root))?.handoffs[0]?.status).toBe("failed");
  });

  it("keeps the ledger when the host cannot show a synthetic notice", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-orch-"));
    const events = controllableEvents();
    const runtime = runtimeFor(root, events, async () => {
      throw new Error("gone");
    });
    (runtime.ctx.session as unknown as { synthetic: () => Promise<void> }).synthetic = async () => {
      throw new Error("no synthetic surface");
    };
    await executeState(runtime, { action: "initialize", outcome: "O" }, leader);
    await executeHandoff(runtime, { action: "launch", expectedRevision: 0, units: [UNIT] }, leader);
    await reconcileRunning(runtime);
    expect((await readState(root))?.handoffs[0]?.status).toBe("failed");
  });
});
