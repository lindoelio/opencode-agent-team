import { describe, expect, it } from "vitest";
import { createRuntime, type AgentTeamRuntime } from "../../src/runtime.js";
import { registerTools } from "../../src/tools/index.js";
import { registerCommands } from "../../src/catalog/command-registration.js";
import { registerSkills } from "../../src/catalog/skill-registration.js";
import { registerHooks } from "../../src/hooks/index.js";

function mockCtx(): { ctx: never; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const editor = {
    added: [] as Array<{ name?: string; id?: string }>,
    add(def: { name?: string; id?: string }) { (this as { added: Array<unknown> }).added.push(def); },
    namespace() {},
    update() {},
    remove() {},
    list() { return []; },
    get() { return undefined; },
    default() {},
  };
  const transform = async (cb: (e: unknown) => void) => {
    calls["transform"] = (calls["transform"] ?? 0) + 1;
    cb({ ...editor, added: [] });
    return { dispose: async () => {} };
  };
  const hook = async () => ({ dispose: async () => {} });
  const ctx = {
    options: {},
    location: { project: { canonical: "/tmp/agent-team-test" } },
    tool: { transform, reload: async () => {}, list: async () => [], hook },
    command: { transform, reload: async () => {}, list: async () => [] },
    skill: { transform, reload: async () => {}, list: async () => [] },
    session: { hook, synthetic: async () => {}, prompt: async () => {} },
    permission: { hook },
    agent: { list: async () => [] },
    model: { list: async () => [] },
    storage: { set: async () => {}, get: async () => undefined, remove: async () => {} },
    generate: { text: async () => ({ text: "ok" }) },
    app: { version: "2.0.10" },
  };
  return { ctx: ctx as never, calls };
}

describe("plugin registration contracts", () => {
  it("registers 9 agent-team tools, 15 commands and 18 skills without throwing", async () => {
    const { ctx } = mockCtx();
    const runtime = createRuntime(ctx as never, { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false } as never);
    const addedTools: string[] = [];
    const toolExecutes: Array<(input: unknown, tool: unknown) => Promise<unknown>> = [];
    const toolEditor = {
      namespace() {},
      add(def: { name: string; execute: (input: unknown, tool: unknown) => Promise<unknown> }) {
        addedTools.push(`agent_team_${def.name}`);
        toolExecutes.push(def.execute);
      },
      update() {}, remove() {}, list() { return []; }, get() { return undefined; },
    };
    (ctx as unknown as { tool: { transform: unknown } }).tool.transform = async (cb: (e: unknown) => void) => {
      cb(toolEditor);
      return { dispose: async () => {} };
    };
    const addedCommands: string[] = [];
    (ctx as unknown as { command: { transform: unknown } }).command.transform = async (cb: (e: unknown) => void) => {
      cb({ add(def: { name: string }) { addedCommands.push(def.name); } });
      return { dispose: async () => {} };
    };
    const addedSkills: string[] = [];
    const skillDefs: Array<Record<string, unknown>> = [];
    (ctx as unknown as { skill: { transform: unknown } }).skill.transform = async (cb: (e: unknown) => void) => {
      cb({ add(def: { id: string }) { addedSkills.push(def.id); skillDefs.push(def as unknown as Record<string, unknown>); }, list: () => [], get: () => undefined, update: () => {}, remove: () => {} });
      return { dispose: async () => {} };
    };
    await registerTools(runtime as AgentTeamRuntime);
    await registerCommands(runtime as AgentTeamRuntime);
    await registerSkills(runtime as AgentTeamRuntime);
    await registerHooks(runtime as AgentTeamRuntime);
    expect(addedTools.sort()).toEqual(["agent_team_define_delivery", "agent_team_evaluate_decision", "agent_team_evaluate_gate", "agent_team_handoff", "agent_team_record_assumption", "agent_team_record_decision", "agent_team_request_approval", "agent_team_state", "agent_team_submit_evidence"]);
    expect(addedCommands).toHaveLength(15);
    expect(addedSkills).toHaveLength(18);
    // Regression: Skill.Info requires absolute `path` (server disables the
    // plugin on schema mismatch); `location` is not a valid key.
    for (const def of skillDefs) {
      expect(def["path"]).toMatch(/^\//);
      expect(def).not.toHaveProperty("location");
      expect(def["content"]).toContain("## ");
    }
    // Execute every registered wrapper once. A wrapper must reject empty
    // input with a validation or domain error; a wiring error (a TypeError,
    // an undefined import) means the tool is not connected to its
    // implementation at all and must fail this test rather than be
    // swallowed.
    expect(toolExecutes).toHaveLength(9);
    for (const execute of toolExecutes) {
      const outcome = await (execute as (input: unknown, tool: unknown) => Promise<unknown>)({}, { sessionID: "s", agent: "team-leader" }).then(
        () => ({ threw: false as const, error: undefined as unknown }),
        (error: unknown) => ({ threw: true as const, error }),
      );
      if (!outcome.threw) continue;
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).constructor.name).not.toBe("TypeError");
      expect((outcome.error as Error).constructor.name).not.toBe("ReferenceError");
    }
  });

  it("keeps every tool input closed and in sync with its Zod schema", async () => {
    const { AGENT_TEAM_STATE_TOOL } = await import("../../src/tools/state.js");
    const { ASSUMPTION_TOOL } = await import("../../src/tools/assumption.js");
    const { DECISION_TOOL } = await import("../../src/tools/decision.js");
    const { EVIDENCE_TOOL } = await import("../../src/tools/evidence.js");
    const { GATE_TOOL } = await import("../../src/tools/gate.js");
    const { APPROVAL_TOOL } = await import("../../src/tools/approval.js");
    const { HANDOFF_TOOL } = await import("../../src/tools/handoff.js");
    const { DELIVERY_TOOL } = await import("../../src/tools/delivery.js");
    const { EVALUATE_DECISION_TOOL } = await import("../../src/tools/evaluate-decision.js");
    const tools = [
      AGENT_TEAM_STATE_TOOL,
      ASSUMPTION_TOOL,
      DECISION_TOOL,
      EVIDENCE_TOOL,
      GATE_TOOL,
      APPROVAL_TOOL,
      HANDOFF_TOOL,
      DELIVERY_TOOL,
      EVALUATE_DECISION_TOOL,
    ];
    for (const tool of tools) {
      expect(tool.input.additionalProperties).toBe(false);
      expect(tool.input.type).toBe("object");
      expect(Array.isArray(tool.input.required)).toBe(true);
    }
    // The declared enums must match the canonical domain enums.
    const { HANDOFF_ROLES } = await import("../../src/domain/handoff.js");
    const { SpecialistRoleSchema } = await import("../../src/domain/schemas.js");
    const handoff = HANDOFF_TOOL.input.properties["role"] as { enum: readonly string[] };
    expect(handoff.enum).toEqual([...HANDOFF_ROLES]);
    expect(handoff.enum).toEqual([...SpecialistRoleSchema.options]);
    const gate = GATE_TOOL.input.properties["gate"] as { enum: readonly string[] };
    expect(gate.enum).toEqual(["INTENT", "DISCOVERY", "PLAN", "VERIFY", "REVIEW", "ACCEPT", "DELIVER"]);
    // The state tool declares the work-status enum. The handler and the Zod
    // schema both accept it, so a declared schema that omits it would make
    // FAILED and BLOCKED unreachable through a host that validates inputs.
    const { WorkStatusSchema } = await import("../../src/domain/schemas.js");
    const status = AGENT_TEAM_STATE_TOOL.input.properties["status"] as { enum: readonly string[] };
    expect(status.enum).toEqual([...WorkStatusSchema.options]);
    // The evidence kind enum is declared in three places; a missed literal
    // would only fail at the host's schema layer, so it is pinned here.
    const { EvidenceRefSchema } = await import("../../src/domain/schemas.js");
    const evidence = EVIDENCE_TOOL.input.properties["kind"] as { enum: readonly string[] };
    expect(evidence.enum).toEqual([...EvidenceRefSchema.shape.kind.options]);
    expect(evidence.enum).toContain("judgment");
    // The handoff carries the wave graph and the assigned skills.
    expect(HANDOFF_TOOL.input.properties).toHaveProperty("skills");
    expect(HANDOFF_TOOL.input.properties).toHaveProperty("dependsOn");
    // A handoff must declare a scope: a unit with no boundary has no scope
    // to enforce, so the declared schema requires one.
    const allowedScope = HANDOFF_TOOL.input.properties["allowedScope"] as { minItems?: number };
    expect(allowedScope.minItems).toBe(1);
    const waveUnits = HANDOFF_TOOL.input.properties["units"] as {
      items: { properties: Record<string, { minItems?: number }> };
    };
    expect(waveUnits.items.properties["allowedScope"]?.minItems).toBe(1);
  });
});
