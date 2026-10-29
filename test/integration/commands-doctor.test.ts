import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/runtime.js";
import { runDoctor, renderDoctorReport } from "../../src/doctor/report.js";
import { registerCommands } from "../../src/catalog/command-registration.js";
import { registerSkills } from "../../src/catalog/skill-registration.js";
import { SKILL_IDS } from "../../src/catalog/skills.js";
import { initializeState } from "../../src/ledger/store.js";
import plugin from "../../src/index.js";

const OPTS = { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false } as never;

function baseCtx(root: string, overrides: Record<string, unknown> = {}): never {
  return {
    options: {},
    location: { project: { canonical: root } },
    app: { version: "2.0.10" },
    model: { list: async () => [{ providerID: "opencode", id: "muse-spark-1.3" }], reload: async () => {} },
    generate: { text: async () => ({ text: "doctor-ok" }) },
    tool: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => [{ id: "agent_team_state" }, { id: "agent_team_record_assumption" }, { id: "agent_team_record_decision" }, { id: "agent_team_submit_evidence" }, { id: "agent_team_evaluate_gate" }, { id: "agent_team_evaluate_decision" }, { id: "agent_team_request_approval" }, { id: "agent_team_handoff" }, { id: "agent_team_define_delivery" }], hook: async () => ({ dispose: async () => {} }) },
    agent: { list: async () => [{ id: "team-leader" }] },
    storage: (() => {
      const data = new Map<string, unknown>();
      return {
        set: async (k: string, v: unknown) => { data.set(k, v); },
        get: async (k: string) => data.get(k),
        remove: async (k: string) => { data.delete(k); },
        scan: async () => ({ entries: [], next: undefined }),
      };
    })(),
    command: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => [] },
    skill: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => [] },
    session: { hook: async () => ({ dispose: async () => {} }), synthetic: async () => {}, prompt: async () => {}, generate: async () => ({ text: "" }) },
    permission: { hook: async () => ({ dispose: async () => {} }), list: async () => [], get: async () => undefined, reply: async () => {} },
    ...overrides,
  } as never;
}

describe("doctor", () => {
  it("reports PASS on a healthy runtime", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const runtime = createRuntime(baseCtx(root), OPTS);
    const report = await runDoctor(runtime);
    expect(report.verdict).toBe("PASS");
    expect(report.opencodeVersion).toBe("2.0.10");
    const text = renderDoctorReport(report);
    expect(text).toContain("Agent Team Doctor — PASS");
    expect(text).toContain("Recommended action");
  });
  it("reports FAIL when model and storage are unavailable", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const ctx = baseCtx(root, {
      model: { list: async () => [] },
      generate: { text: async () => { throw new Error("provider down"); } },
      tool: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => [], hook: async () => ({ dispose: async () => {} }) },
      agent: { list: async () => { throw new Error("no agents"); } },
      storage: { set: async () => { throw new Error("disk full"); }, get: async () => undefined, remove: async () => {} },
    });
    const runtime = createRuntime(ctx, OPTS);
    const report = await runDoctor(runtime);
    expect(report.verdict).toBe("FAIL");
    expect(report.checks.find((c) => c.name === "Model catalog")?.status).toBe("FAIL");
  });
  it("degrades on wrong OpenCode version", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const runtime = createRuntime(baseCtx(root, { app: { version: "1.0.0" } }), OPTS);
    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === "OpenCode")?.status).toBe("DEGRADED");
  });
  it("handles catalog failures and missing specialists", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const noCatalog = createRuntime(baseCtx(root, { model: { list: async () => { throw new Error("offline"); } } }), OPTS);
    const r1 = await runDoctor(noCatalog);
    expect(r1.checks.find((c) => c.name === "Model catalog")?.status).toBe("FAIL");
    const noAgents = createRuntime(baseCtx(root, { agent: { list: async () => [] } }), OPTS);
    const r2 = await runDoctor(noAgents);
    expect(r2.checks.find((c) => c.name === "Native specialists")?.status).toBe("DEGRADED");
    const noTools = createRuntime(baseCtx(root, { tool: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => { throw new Error("tools down"); }, hook: async () => ({ dispose: async () => {} }) } }), OPTS);
    const r3 = await runDoctor(noTools);
    expect(r3.checks.find((c) => c.name === "Tool registration")?.status).toBe("FAIL");
  });
  it("pins no model and checks configured reasoning efforts against the catalog", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const runtime = createRuntime(baseCtx(root), OPTS);
    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === "Model catalog")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.name === "Reasoning effort")?.status).toBe("PASS");
    expect(report.checks.find((c) => c.name === "Reasoning effort")?.detail).toContain("harness default");
    const configured = createRuntime(baseCtx(root), { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false, model: { reasoningEffort: "ultra" } } as never);
    const r2 = await runDoctor(configured);
    expect(r2.checks.find((c) => c.name === "Reasoning effort")?.status).toBe("FAIL");
    expect(r2.checks.find((c) => c.name === "Reasoning effort")?.detail).toContain("ultra");
  });
});

describe("command handlers", () => {
  async function captureCommands(root: string, rootOverride?: string): Promise<{ defs: Array<{ name: string; execute: (input: never) => Promise<void> }>; sent: string[] }> {
    const defs: Array<{ name: string; execute: (input: never) => Promise<void> }> = [];
    const sent: string[] = [];
    const ctx = baseCtx(rootOverride ?? root, {
      command: {
        transform: async (cb: (e: unknown) => void) => {
          cb({ add: (d: { name: string; execute: (input: never) => Promise<void> }) => defs.push(d) });
          return { dispose: async () => {} };
        },
        reload: async () => {},
        list: async () => [],
      },
      session: {
        hook: async () => ({ dispose: async () => {} }),
        synthetic: async ({ text }: { text: string }) => { sent.push(text); },
        prompt: async ({ text }: { text: string }) => { sent.push(`PROMPT:${text}`); },
      },
    });
    const runtime = createRuntime(ctx, OPTS);
    await registerCommands(runtime);
    return { defs, sent };
  }

  it("setup --plan dry-runs, status handles empty state, export previews", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    expect(defs).toHaveLength(15);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --plan" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Dry run only");
    const status = defs.find((d) => d.name === "agent-team/status")!;
    await status.execute({ sessionID: "s", prompt: { text: "/agent-team/status" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("no engagement yet");
    const exp = defs.find((d) => d.name === "agent-team/export")!;
    await exp.execute({ sessionID: "s", prompt: { text: "/agent-team/export" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("choose bundle");
  });
  it("setup --apply writes agents and status reflects state", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    await initializeState({ projectRoot: root, sessionId: "s", actor: "team-leader", outcome: "Win" });
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope project" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Agent Team setup applied");
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8")).toContain("You are Team Leader");
    const status = defs.find((d) => d.name === "agent-team/status")!;
    await status.execute({ sessionID: "s", prompt: { text: "/agent-team/status" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Verdict: INTENT / DRAFT");
  });
  it("global setup plans without writing, doctor command runs", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --plan --scope global" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Agent Team setup plan");
    const doctor = defs.find((d) => d.name === "agent-team/doctor")!;
    await doctor.execute({ sessionID: "s", prompt: { text: "/agent-team/doctor" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Agent Team Doctor");
  });
  it("guard command reports and edits guardrails deterministically", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    await initializeState({ projectRoot: root, sessionId: "s", actor: "team-leader", outcome: "Win" });
    const { defs, sent } = await captureCommands(root);
    const guard = defs.find((d) => d.name === "agent-team/guard")!;
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("asks nothing by default");
    await guard.execute({ sessionID: "s", prompt: { text: '/agent-team/guard --add "deploy produção"' }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain('"deploy produção"');
    const { readState } = await import("../../src/ledger/store.js");
    const state = await readState(root);
    expect(state?.guardrails).toEqual(["deploy produção"]);
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard --clear" }, delivery: "steer" } as never);
    expect((await readState(root))?.guardrails).toEqual([]);
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard --mode guarded" }, delivery: "steer" } as never);
    expect((await readState(root))?.autonomyMode).toBe("guarded");
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard --mode nope" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Invalid --mode");
  });
  it("loop commands forward structured prompts", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const start = defs.find((d) => d.name === "agent-team/start")!;
    await start.execute({ sessionID: "s", prompt: { text: "agent-team/start build a board" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("PROMPT:");
    // slash-prefixed text that is not this command falls through untouched
    await start.execute({ sessionID: "s", prompt: { text: "/something-else entirely" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("something-else");
  });
  it("registers every skill with autoinvoke off", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const added: Array<{ id: string; autoinvoke: boolean }> = [];
    const ctx = baseCtx(root, {
      skill: {
        transform: async (cb: (e: unknown) => void) => {
          cb({ add: (d: { id: string; autoinvoke: boolean }) => added.push(d), list: () => [], get: () => undefined, update: () => {}, remove: () => {} });
          return { dispose: async () => {} };
        },
        reload: async () => {},
        list: async () => [],
      },
    });
    await registerSkills(createRuntime(ctx, OPTS));
    expect(added.length).toBe(SKILL_IDS.length);
    expect(added.every((a) => a.autoinvoke === false)).toBe(true);
    for (const skill of added) expect(skill.id.length).toBeGreaterThan(0);
  });
  it("plugin entry sets up and disposes cleanly", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    expect(plugin.id).toBe("lindoelio.agent-team");
    const disposed: string[] = [];
    const tracking = (name: string) => async (...args: unknown[]) => {
      if (name === "tool" || name === "command" || name === "skill") {
        (args[0] as (e: unknown) => void)({ add: () => {}, namespace: () => {}, list: () => [], get: () => undefined, update: () => {}, remove: () => {}, default: () => {} });
      } else {
        // hook(name, callback): invoke the callback with an empty event (errors swallowed)
        const cb = args.find((a) => typeof a === "function") as ((e: never) => unknown) | undefined;
        if (cb) await Promise.resolve(cb({} as never)).catch(() => {});
      }
      return { dispose: async () => { disposed.push(name); } };
    };
    const ctx = baseCtx(root, {
      tool: { transform: tracking("tool"), reload: async () => {}, list: async () => [], hook: tracking("tool-hook") },
      command: { transform: tracking("command"), reload: async () => {}, list: async () => [] },
      skill: { transform: tracking("skill"), reload: async () => {}, list: async () => [] },
      session: { hook: tracking("session"), synthetic: async () => {}, prompt: async () => {} },
      permission: { hook: tracking("permission") },
    });
    const cleanup = await plugin.setup(ctx);
    expect(disposed).toHaveLength(0);
    expect(typeof cleanup).toBe("function");
    await (cleanup as () => Promise<void>)();
    expect(disposed.length).toBeGreaterThanOrEqual(4);
  });
});
