import * as fs from "node:fs";
import * as path from "node:path";
import { packageRoot } from "../catalog/agents.js";
import { skillsForSpecialist } from "../catalog/skills.js";
import { scopeOverlaps } from "../domain/scope.js";
import { appendEvent, readState, storeContext } from "../ledger/store.js";
import { handoffId } from "../util/ids.js";
import { resolveSessionLauncher } from "../compat/host.js";
import { toolOk, type AgentTeamRuntime } from "../runtime.js";
import type { HandoffRef } from "../domain/schemas.js";
import { assertTeamRuntime } from "./host-gate.js";
import { recordShellEnded } from "./shell.js";

export interface LaunchUnit {
  role: HandoffRef["role"];
  objective: string;
  context: string[];
  allowedScope: string[];
  prohibitedScope: string[];
  questions: string[];
  requiredEvidence: string[];
  stopCondition: string;
  skills?: string[];
  dependsOn?: string[];
}

const WRITING_ROLES = new Set<HandoffRef["role"]>(["coder", "worker", "designer", "release"]);

function roleSkillBody(role: HandoffRef["role"]): string {
  const id = skillsForSpecialist(role)[0];
  if (!id) return "";
  try {
    return fs.readFileSync(path.join(packageRoot(), "assets", "skills", id, "SKILL.md"), "utf8").slice(0, 6000);
  } catch {
    return "";
  }
}

function childPrompt(unit: LaunchUnit, id: string): string {
  const skill = roleSkillBody(unit.role);
  return [
    `You are team-leader/${unit.role}. Bounded handoff ${id}.`,
    `Objective: ${unit.objective}`,
    `Allowed scope: ${unit.allowedScope.join(", ") || "(none)"}`,
    `Prohibited scope: ${unit.prohibitedScope.join(", ") || "(none)"}`,
    `Questions to answer: ${unit.questions.join(" | ") || "(none)"}`,
    `Required evidence: ${unit.requiredEvidence.join(" | ") || "(none)"}`,
    ...(unit.dependsOn && unit.dependsOn.length > 0 ? [`Wait for these handoffs to complete: ${unit.dependsOn.join(", ")}`] : []),
    `Stop when: ${unit.stopCondition}`,
    `Role procedure: ${(unit.skills ?? [...skillsForSpecialist(unit.role)]).join(", ") || "(none)"}`,
    "Call the agent_team_report tool with SpecialistResult@1 and then stop. Do not return the result as prose for the leader to copy.",
    "Act autonomously; do not ask for authorization unless a registered guardrail covers the action.",
    "You may launch built-in OpenCode helper agents (e.g. explore, general); never create team-leader/* agents.",
    ...(skill ? ["", "Role procedure:", skill] : []),
  ].join("\n");
}

function sessionIdOf(created: unknown): string {
  const record = created as { id?: unknown; data?: { id?: unknown } };
  const id = record?.id ?? record?.data?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("the host created a session without an id");
  return id;
}

function refusesOverlap(units: LaunchUnit[], running: HandoffRef[]): string | undefined {
  const writers = units.filter((u) => WRITING_ROLES.has(u.role));
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      if (scopeOverlaps(writers[i]!.allowedScope, writers[j]!.allowedScope)) {
        return `${writers[i]!.role} and ${writers[j]!.role} share a writable path`;
      }
    }
  }
  for (const unit of writers) {
    for (const h of running) {
      if (!WRITING_ROLES.has(h.role)) continue;
      if (scopeOverlaps(unit.allowedScope, h.allowedScope)) return `${unit.role} overlaps running handoff ${h.id}`;
    }
  }
  return undefined;
}

/**
 * Books a wave and launches one child session per unit.
 *
 * It returns after the sessions are created and prompted. It does not wait:
 * a specialist takes minutes, and a tool call that blocks that long loses the
 * leader's turn. Completion arrives through the session event subscription.
 */
export async function launchWave(
  runtime: AgentTeamRuntime,
  input: { units: LaunchUnit[]; expectedRevision: number; leaderSessionID: string },
): Promise<{ content: string }> {
  assertTeamRuntime(runtime);
  const launcher = resolveSessionLauncher(runtime.ctx).launcher!;
  const projectRoot = (runtime.ctx as unknown as { location: { project?: { canonical?: string }; directory?: string } }).location;
  const root = projectRoot.project?.canonical ?? projectRoot.directory ?? process.cwd();
  const current = await readState(root);
  if (!current) throw new Error("agent-team state not initialized");
  if (current.revision !== input.expectedRevision) {
    throw new Error(`stale revision: expected ${input.expectedRevision}, actual ${current.revision}`);
  }

  const budget = runtime.options.orchestration?.maxParallelSpecialists ?? 6;
  const running = current.handoffs.filter((h) => h.status === "running");
  if (running.length + input.units.length > budget) {
    throw new Error(`parallel specialist budget exhausted: ${running.length} of ${budget} handoffs are running and this wave needs ${input.units.length} more`);
  }
  const overlap = refusesOverlap(input.units, running);
  if (overlap) throw new Error(`overlapping writable scope: ${overlap}`);
  try {
    const agents = (await runtime.ctx.agent.list()) as unknown as Array<{ id?: string; name?: string }>;
    const ids = new Set(agents.map((a) => String(a.id ?? a.name ?? "")));
    if (ids.size > 0) {
      const missing = input.units.map((u) => `team-leader/${u.role}`).filter((id) => !ids.has(id));
      if (missing.length > 0) throw new Error(`role agent not installed: ${missing.join(", ")}; run /agent-team/setup`);
    }
  } catch (err) {
    if ((err as Error).message.startsWith("role agent not installed")) throw err;
    // A host that cannot list agents still launches; the child create fails loudly.
  }
  // The route is not decorative: a clarify route books nothing, a named file
  // skips the explorer, and a risk signal requires the security lens.
  if (current.route?.engagementClass === "clarify") {
    throw new Error("the route is clarify: ask the person one question before booking a wave");
  }
  if (current.route?.namesFileAndSymptom && input.units.some((u) => u.role === "explorer")) {
    throw new Error("the route already names the file and the symptom; do not launch an explorer");
  }
  if (current.route?.riskSignal && input.units.some((u) => u.role === "reviewer") && !input.units.some((u) => u.role === "security")) {
    throw new Error("the route reports a secret, authentication, or external-write risk; include a security specialist in the review wave");
  }

  const first = current.handoffs.reduce((max, h) => {
    const n = Number.parseInt(h.id.replace(/^HND-/, ""), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0) + 1;

  const prepared: HandoffRef[] = input.units.map((unit, index) => ({
    id: handoffId(first + index),
    role: unit.role,
    objective: unit.objective,
    context: unit.context,
    allowedScope: unit.allowedScope,
    prohibitedScope: unit.prohibitedScope,
    questions: unit.questions,
    requiredEvidence: unit.requiredEvidence,
    stopCondition: unit.stopCondition,
    skills: unit.skills ?? [...skillsForSpecialist(unit.role)],
    dependsOn: unit.dependsOn ?? [],
    status: "running" as const,
    parentSessionID: input.leaderSessionID,
  }));

  const launched: HandoffRef[] = [];
  for (const unit of prepared) {
    const created = await launcher.create({
      parentID: input.leaderSessionID,
      metadata: { agentTeamParent: input.leaderSessionID, agentTeamHandoff: unit.id },
      title: `${unit.id} ${unit.role}`,
      agent: `team-leader/${unit.role}`,
      permissions: [
        { action: "subagent", resource: "team-leader/*", effect: "deny" },
        ...(unit.role === "explorer" || unit.role === "reviewer" || unit.role === "security" || unit.role === "product" || unit.role === "architect"
          ? [{ action: "edit", resource: "*", effect: "deny" as const }, { action: "shell", resource: "*", effect: "deny" as const }]
          : [
              { action: "edit", resource: "*", effect: "deny" as const },
              ...unit.allowedScope.map((scope) => ({ action: "edit", resource: scope, effect: "allow" as const })),
              ...unit.prohibitedScope.map((scope) => ({ action: "edit", resource: scope, effect: "deny" as const })),
            ]),
      ],
    });
    const sessionID = sessionIdOf(created);
    launched.push({ ...unit, sessionID });
  }

  const next = await appendEvent(storeContext(root, input.leaderSessionID, "plugin"), "handoff.launched", {
    ids: launched.map((h) => h.id),
    sessions: launched.map((h) => h.sessionID),
  }, (s) => ({
    ...s,
    handoffs: [...s.handoffs, ...launched],
    nextAction: { description: `Wave running: ${launched.map((h) => h.id).join(", ")}`, owner: "team-leader" },
  }));

  const prompts: string[] = [];
  for (const unit of launched) {
    const text = childPrompt(unit, unit.id);
    prompts.push(text);
    await launcher.prompt({ sessionID: unit.sessionID, text });
  }

  return toolOk({
    ids: launched.map((h) => h.id),
    sessions: launched.map((h) => ({ id: h.id, sessionID: h.sessionID, role: h.role })),
    prompts,
    revision: next.revision,
    parallelBudget: { max: budget, running: running.length + launched.length },
  });
}

/** Marks a running handoff failed when its session ended without a report. */
export async function settleSession(runtime: AgentTeamRuntime, sessionID: string): Promise<void> {
  const root = (runtime.ctx as unknown as { location: { project?: { canonical?: string }; directory?: string } }).location;
  const projectRoot = root.project?.canonical ?? root.directory ?? process.cwd();
  const state = await readState(projectRoot);
  if (!state) return;
  const handoff = state.handoffs.find((h) => h.sessionID === sessionID && h.status === "running");
  if (!handoff) return;
  const next = await appendEvent(storeContext(projectRoot, "plugin", "plugin"), "handoff.failed", { id: handoff.id, reason: "session ended without a report" }, (s) => ({
    ...s,
    handoffs: s.handoffs.map((h) => (h.id === handoff.id ? { ...h, status: "failed" as const } : h)),
    nextAction: { description: `${handoff.id} failed without a report`, owner: "team-leader" },
  }));
  const parent = handoff.parentSessionID;
  if (parent) {
    try {
      await runtime.ctx.session.synthetic({
        sessionID: parent,
        text: `${handoff.id} (${handoff.role}) ended without a report and is failed. Book it again if the work is still needed.`,
      } as never);
    } catch {
      // The ledger is the record; the notice is best-effort.
    }
  }
  void next;
}

/** Reconciles running handoffs after a reload. Never invents a report. */
export async function reconcileRunning(runtime: AgentTeamRuntime): Promise<void> {
  const root = (runtime.ctx as unknown as { location: { project?: { canonical?: string }; directory?: string } }).location;
  const projectRoot = root.project?.canonical ?? root.directory ?? process.cwd();
  const state = await readState(projectRoot);
  if (!state) return;
  for (const handoff of state.handoffs.filter((h) => h.status === "running" && h.sessionID)) {
    try {
      const info = (await runtime.ctx.session.get({ sessionID: handoff.sessionID! } as never)) as unknown;
      const record = info as { data?: { outcome?: string; time?: { idle?: number } }; outcome?: string; time?: { idle?: number } };
      const data = record?.data ?? record;
      if (data?.outcome === "failed" || data?.outcome === "error" || typeof data?.time?.idle === "number") await settleSession(runtime, handoff.sessionID!);
    } catch {
      await settleSession(runtime, handoff.sessionID!);
    }
  }
}

/** Subscribes to session execution events and settles the booked handoff. */
export async function registerOrchestrator(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of runtime.ctx.event.subscribe({ signal: controller.signal } as never)) {
        const e = event as unknown as {
          type?: string;
          sessionID?: string;
          properties?: { sessionID?: string };
          data?: { sessionID?: string };
        };
        if (e.type === "session.shell.ended") {
          const shellSession = String(e.data?.sessionID ?? e.sessionID ?? e.properties?.sessionID ?? "");
          if (shellSession) recordShellEnded(shellSession, e.data);
          continue;
        }
        if (e.type && !["session.execution.succeeded", "session.execution.failed", "session.idle"].includes(e.type)) continue;
        const sessionID = String(e.data?.sessionID ?? e.sessionID ?? e.properties?.sessionID ?? "");
        if (sessionID) await settleSession(runtime, sessionID).catch(() => {});
      }
    } catch {
      // A host without the event stream still settles through report calls.
    }
  })();
  return { dispose: async () => controller.abort() };
}
