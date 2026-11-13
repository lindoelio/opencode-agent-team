import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/runtime.js";
import type { AgentTeamOptions } from "../../src/options.js";
import { runDoctor, renderDoctorReport } from "../../src/doctor/report.js";
import { registerCommands } from "../../src/catalog/command-registration.js";
import { registerSkills } from "../../src/catalog/skill-registration.js";
import { SKILL_IDS } from "../../src/catalog/skills.js";
import { initializeState } from "../../src/ledger/store.js";
import plugin from "../../src/index.js";

const OPTS = { profile: "public", projectState: ".agent-team", telemetry: false } as never;

function baseCtx(root: string, overrides: Record<string, unknown> = {}): never {
  return {
    options: {},
    location: { project: { canonical: root } },
    app: { version: "2.2.0" },
    model: { list: async () => [{ providerID: "opencode", id: "muse-spark-1.3" }], reload: async () => {} },
    generate: { text: async () => ({ text: "doctor-ok" }) },
    tool: { transform: async () => ({ dispose: async () => {} }), reload: async () => {}, list: async () => [{ id: "agent_team_state" }, { id: "agent_team_record_assumption" }, { id: "agent_team_record_decision" }, { id: "agent_team_submit_evidence" }, { id: "agent_team_evaluate_gate" }, { id: "agent_team_evaluate_decision" }, { id: "agent_team_request_approval" }, { id: "agent_team_handoff" }, { id: "agent_team_define_delivery" }, { id: "agent_team_report" }], hook: async () => ({ dispose: async () => {} }) },
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
    session: { hook: async () => ({ dispose: async () => {} }), synthetic: async () => {}, prompt: async () => {}, create: async () => ({ id: "ses_child" }), shell: async () => ({ exitCode: 0, output: "ok" }), generate: async () => ({ text: "" }) },
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
    expect(report.opencodeVersion).toBe("2.2.0");
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
  it("fails on a host below the floor", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-doctor-"));
    const runtime = createRuntime(baseCtx(root, { app: { version: "2.1.4" } }), OPTS);
    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === "OpenCode")?.status).toBe("FAIL");
    expect(report.verdict).toBe("FAIL");
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
    const configured = createRuntime(baseCtx(root), { profile: "public", projectState: ".agent-team", telemetry: false, model: { reasoningEffort: "ultra" } } as never);
    const r2 = await runDoctor(configured);
    expect(r2.checks.find((c) => c.name === "Reasoning effort")?.status).toBe("FAIL");
    expect(r2.checks.find((c) => c.name === "Reasoning effort")?.detail).toContain("ultra");
  });
});

describe("command handlers", () => {
  async function captureCommands(root: string, rootOverride?: string, opts: AgentTeamOptions = OPTS): Promise<{ defs: Array<{ name: string; execute: (input: never) => Promise<void> }>; sent: string[] }> {
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
    const runtime = createRuntime(ctx, opts);
    await registerCommands(runtime);
    return { defs, sent };
  }

  /**
   * The global scope follows the host's own configuration-home convention, so
   * pointing that variable at a temporary directory keeps the command off the
   * developer's real OpenCode configuration.
   */
  async function withConfigHome<T>(run: () => Promise<T>): Promise<T> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-config-"));
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = dir;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  }

  it("setup --plan dry-runs and only operator commands are registered", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name).sort()).toEqual(["agent-team/doctor", "agent-team/guard", "agent-team/setup"]);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() => setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --plan" }, delivery: "steer" } as never));
    expect(sent.join("\n")).toContain("Dry run only");
  });
  it("setup --apply writes agents", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    await initializeState({ projectRoot: root, sessionId: "s", actor: "team-leader", outcome: "Win" });
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() => setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope project" }, delivery: "steer" } as never));
    expect(sent.join("\n")).toContain("Agent Team setup applied");
    expect(await fs.promises.readFile(path.join(root, ".opencode", "agents", "team-leader.md"), "utf8")).toContain("You are Team Leader");
  });
  it("global setup plans without writing, doctor command runs", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() => setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --plan --scope global" }, delivery: "steer" } as never));
    expect(sent.join("\n")).toContain("Agent Team setup plan");
    const doctor = defs.find((d) => d.name === "agent-team/doctor")!;
    await doctor.execute({ sessionID: "s", prompt: { text: "/agent-team/doctor" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Agent Team Doctor");
  });
  it("global setup asks for the undecided decisions and writes nothing", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(async () => {
      await setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope global" }, delivery: "steer" } as never);
      const asked = sent.join("\n");
      expect(asked).toContain("PROMPT:");
      expect(asked).toContain("default_agent");
      expect(asked).toContain("--leader-title");
      expect(asked).not.toContain("Agent Team setup applied");
      // the question names both files the answers change
      expect(asked).toContain(path.join("opencode", "opencode.json"));
      expect(asked).toContain(path.join("opencode", "agents", "team-leader.md"));
      // and nothing was written
      const written = await fs.promises.readdir(path.join(process.env["XDG_CONFIG_HOME"] ?? "", "opencode")).catch(() => [] as string[]);
      expect(written).toEqual([]);
    });
  });
  it("global setup reports a configuration file it cannot read", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(async () => {
      const configDir = path.join(process.env["XDG_CONFIG_HOME"] ?? "", "opencode");
      await fs.promises.mkdir(configDir, { recursive: true });
      await fs.promises.writeFile(path.join(configDir, "opencode.json"), "{ broken !!!");
      await setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope global" }, delivery: "steer" } as never);
      const reported = sent.join("\n");
      expect(reported).toContain("opencode.json");
      expect(reported).toContain("parse errors");
      expect(reported).not.toContain("PROMPT:");
      expect(reported).not.toContain("Agent Team setup applied");
    });
  });
  it("global setup keeps a settled flag in the re-run it asks for", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() => setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope global --set-default" }, delivery: "steer" } as never));
    const asked = sent.join("\n");
    // the decision the user already settled is not asked again
    expect(asked).not.toContain("Question 1");
    expect(asked).toContain("Question 2");
    // and the re-run carries the flag the invocation already had
    expect(asked).toContain("--set-default");
    expect(asked).toContain("--leader-title");
    // the question names the file the answer changes
    expect(asked).toContain(path.join("opencode", "agents", "team-leader.md"));
    // and not the configuration file, whose value this invocation settled
    expect(asked).not.toContain(path.join("opencode", "opencode.json"));
  });

  it("global setup records the plugin's defaults, not the session's options", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    // a session that configures the plugin differently from the defaults
    const { defs } = await captureCommands(root, undefined, {
      profile: "private",
      projectState: ".my-state",
      telemetry: false,
    } as never);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    const config = await withConfigHome(async () => {
      await setup.execute({ sessionID: "s", prompt: { text: '/agent-team/setup --apply --scope global --set-default --leader-title "Meu Time"' }, delivery: "steer" } as never);
      const configDir = path.join(process.env["XDG_CONFIG_HOME"] ?? "", "opencode");
      return JSON.parse(await fs.promises.readFile(path.join(configDir, "opencode.json"), "utf8")) as {
        plugins: Array<{ package: string; options: { profile: string; projectState: string; telemetry: boolean } }>;
      };
    });
    expect(config.plugins[0]!.options.profile).toBe("public");
    expect(config.plugins[0]!.options.telemetry).toBe(false);
    expect(config.plugins[0]!.options.projectState).toBe(".agent-team");
  });

  it("project setup records the session's options", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs } = await captureCommands(root, undefined, {
      profile: "private",
      projectState: ".my-state",
      telemetry: false,
    } as never);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() => setup.execute({ sessionID: "s", prompt: { text: "/agent-team/setup --apply --scope project" }, delivery: "steer" } as never));
    const config = JSON.parse(await fs.promises.readFile(path.join(root, "opencode.jsonc"), "utf8")) as {
      plugins: Array<{ options: { profile: string; projectState: string; telemetry: boolean } }>;
    };
    expect(config.plugins[0]!.options.profile).toBe("private");
    expect(config.plugins[0]!.options.telemetry).toBe(false);
    expect(config.plugins[0]!.options.projectState).toBe(".my-state");
  });

  it("global setup with the explicit flags installs the roster and the title", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() =>
      setup.execute({ sessionID: "s", prompt: { text: '/agent-team/setup --apply --scope global --set-default --leader-title "Meu Time"' }, delivery: "steer" } as never),
    );
    expect(sent.join("\n")).toContain("Agent Team setup applied");
    expect(sent.join("\n")).not.toContain("PROMPT:");
  });
  it("setup refuses a leader title that would break the agent file", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    const { defs, sent } = await captureCommands(root);
    const setup = defs.find((d) => d.name === "agent-team/setup")!;
    await withConfigHome(() =>
      setup.execute({ sessionID: "s", prompt: { text: '/agent-team/setup --apply --scope global --set-default --leader-title "Boss:"' }, delivery: "steer" } as never),
    );
    expect(sent.join("\n")).toContain("leader title is not valid");
    expect(sent.join("\n")).not.toContain("Agent Team setup applied");
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
  it("guard records promotion authorization", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-cmd-"));
    await initializeState({ projectRoot: root, sessionId: "s", actor: "team-leader", outcome: "Win" });
    const { defs, sent } = await captureCommands(root);
    const guard = defs.find((d) => d.name === "agent-team/guard")!;
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard --allow-promotion" }, delivery: "steer" } as never);
    expect(sent.join("\n")).toContain("Promotion: authorized");
    const { readState } = await import("../../src/ledger/store.js");
    expect((await readState(root))?.allowPromotion).toBe(true);
    await guard.execute({ sessionID: "s", prompt: { text: "/agent-team/guard --no-promotion" }, delivery: "steer" } as never);
    expect((await readState(root))?.allowPromotion).toBe(false);
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
