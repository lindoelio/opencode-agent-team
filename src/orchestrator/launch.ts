import { loadSkillBody, skillsForSpecialist, SKILL_IDS } from "../catalog/skills.js";
import { scopeOverlaps } from "../domain/scope.js";
import { READ_ONLY_ROLES, REPORT_SHAPE_LINE } from "../domain/handoff.js";
import { appendEvent, readState, storeContext, STATE_NOT_INITIALIZED } from "../ledger/store.js";
import { handoffId, waveId } from "../util/ids.js";
import { resolveSessionLauncher, type SessionLauncher } from "../compat/host.js";
import { projectRootOf, toolOk, type AgentTeamRuntime } from "../runtime.js";
import type { HandoffRef } from "../domain/schemas.js";
import { assertTeamRuntime } from "./host-gate.js";
import { parseShellEnded, recordShellEnded } from "./shell.js";
import { observeDeclaredCheck } from "./observe.js";
import { markTrustedLaunch } from "./launch-trust.js";
import { consumeLineageEvent } from "./lineage.js";

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

/** How long a session may sit idle before a booked handoff is called failed. */
export const SETTLE_GRACE_MS = 45_000;

type ArchiveStatus = "applied" | "failed" | "unavailable" | "disabled";

export interface ArchiveOutcome {
  status: ArchiveStatus;
  /** Why the archive did not apply, when it did not. Short enough for an event. */
  reason?: string;
}

/**
 * Archives one child session and verifies that it took effect.
 *
 * The host's session list shows archived sessions separately, so the person's
 * thread list keeps only the conversation they started. A call that resolves
 * is not proof: the SDK on some supported lines types `session.update` without
 * `archived` and silently drops it, so the result is read back from the
 * host's own record. The caller reports a status instead of pretending, and
 * the failure keeps its reason so an operator can tell a host gap from a bug.
 */
async function archiveChild(launcher: SessionLauncher, sessionID: string): Promise<ArchiveOutcome> {
  if (!launcher.archive) return { status: "unavailable", reason: "the host exposes no session archive surface" };
  try {
    await launcher.archive(sessionID);
  } catch (err) {
    return { status: "failed", reason: `session.update threw: ${(err as Error).message ?? String(err)}`.slice(0, 240) };
  }
  if (!launcher.get) return { status: "applied" };
  try {
    const info = await launcher.get(sessionID);
    const record = info as { data?: { time?: { archived?: unknown } }; time?: { archived?: unknown } };
    const archived = record?.data?.time?.archived ?? record?.time?.archived;
    return typeof archived === "number"
      ? { status: "applied" }
      : { status: "failed", reason: "session.update did not set time.archived on the session" };
  } catch (err) {
    return { status: "failed", reason: `the session could not be read back: ${(err as Error).message ?? String(err)}`.slice(0, 240) };
  }
}

/**
 * Archives a specialist session once it has settled.
 *
 * Archiving at creation does not survive the first prompt: the host clears
 * the archive when the session starts running. Archiving after the report (or
 * after a failed settle) sticks, which is also what the person asked for: the
 * thread list shows the work while it runs and drops it when it is done. The
 * result is verified against the host's own record, so a host that ignores
 * `archived` is reported as failed instead of assumed to have worked.
 */
export async function archiveSettledSession(runtime: AgentTeamRuntime, sessionID: string): Promise<ArchiveOutcome> {
  if (runtime.options.orchestration?.archiveChildSessions === false) return { status: "disabled" };
  const launcher = resolveSessionLauncher(runtime.ctx).launcher;
  if (!launcher) return { status: "unavailable", reason: "the host exposes no child-session surface" };
  return archiveChild(launcher, sessionID);
}

function childPrompt(unit: LaunchUnit, id: string): string {
  // The body follows the skill the leader declared for this unit, not the
  // role's first default: a reviewer booked over a design artifact gets the
  // design-review procedure, not code review.
  const declared = unit.skills && unit.skills.length > 0 ? [...unit.skills] : [...skillsForSpecialist(unit.role)];
  const skill = declared[0] ? loadSkillBody(declared[0]) : "";
  return [
    `You are team-leader/${unit.role}. Bounded handoff ${id}.`,
    `Objective: ${unit.objective}`,
    ...(unit.context.length > 0 ? ["Context:", ...unit.context.map((line) => `- ${line}`)] : []),
    `Allowed scope: ${unit.allowedScope.join(", ") || "(none)"}`,
    `Prohibited scope: ${unit.prohibitedScope.join(", ") || "(none)"}`,
    `Questions to answer: ${unit.questions.join(" | ") || "(none)"}`,
    `Required evidence: ${unit.requiredEvidence.join(" | ") || "(none)"}`,
    ...(unit.dependsOn && unit.dependsOn.length > 0 ? [`Wait for these handoffs to complete: ${unit.dependsOn.join(", ")}`] : []),
    `Stop when: ${unit.stopCondition}`,
    `Skills (load with the skill tool when the task matches; the primary procedure is embedded below): ${declared.join(", ") || "(none)"}`,
    REPORT_SHAPE_LINE,
    "Act autonomously; do not ask for authorization unless a registered guardrail covers the action.",
    ...(READ_ONLY_ROLES.has(unit.role)
      ? ["You cannot launch helper agents: this role is read-only."]
      : ["You may launch built-in OpenCode helper agents (e.g. explore, general); the handoff scope holds for their writes too; never create team-leader/* agents."]),
    ...(skill ? ["", "Primary procedure (embedded):", skill] : []),
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
  if (!current) throw new Error(STATE_NOT_INITIALIZED);
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
    throw new Error("the route already names the file and the symptom; do not launch an explorer. If the route is wrong, record an override with agent_team_state action:\"route\" and a reason");
  }
  if (current.route?.riskSignal && input.units.some((u) => u.role === "reviewer") && !input.units.some((u) => u.role === "security")) {
    throw new Error("the route reports a secret, authentication, or external-write risk; include a security specialist in the review wave");
  }
  // A change that does not name the file and the symptom needs discovery.
  // Leaving it to prose made a weak model skip the explorer; the route is the
  // source of truth, and the override is the recorded escape when the route
  // is wrong.
  const needsDiscovery = current.route?.engagementClass === "change" && current.route.namesFileAndSymptom === false;
  const hasExplorer =
    input.units.some((unit) => unit.role === "explorer") ||
    current.handoffs.some((h) => h.role === "explorer" && (h.status === "running" || h.status === "completed"));
  if (needsDiscovery && !hasExplorer) {
    throw new Error("the route is change and does not name the file and the symptom; book a team-leader/explorer first, or record a route override with agent_team_state action:\"route\" and namesFileAndSymptom: true");
  }
  // A reviewer is independent only if it is pointed at an implementation and
  // says so. The gate already checks coverage; this refuses the booking that
  // never declared what it reviews.
  const implementations = current.handoffs.filter(
    (h) => (h.role === "coder" || h.role === "worker") && (h.status === "running" || h.status === "completed"),
  );
  if (implementations.length > 0) {
    for (const unit of input.units) {
      if (unit.role !== "reviewer") continue;
      const dependsOn = unit.dependsOn ?? [];
      if (!implementations.some((h) => dependsOn.includes(h.id))) {
        throw new Error(`a reviewer must depend on the implementation it reviews; add ${implementations.map((h) => h.id).join(" or ")} to the reviewer unit's dependsOn`);
      }
    }
  }
  // A skill id that does not exist ships no procedure: the child prompt would
  // embed nothing while the ledger still looked like a procedure was
  // assigned. Drop the unknown ids and say so in the result — refusing the
  // whole wave would turn one typo into a dead end for a model that cannot
  // recover from it.
  const knownSkills = SKILL_IDS as readonly string[];
  const ignoredSkills = [...new Set(input.units.flatMap((u) => u.skills ?? []).filter((id) => !knownSkills.includes(id)))];

  const first = current.handoffs.reduce((max, h) => {
    const n = Number.parseInt(h.id.replace(/^HND-/, ""), 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0) + 1;
  // One launch call is one wave. The id is what makes "booked together"
  // readable from the ledger instead of from the host's subagent trace.
  const wave = waveId(
    current.handoffs.reduce((max, h) => {
      const n = Number.parseInt((h.wave ?? "").replace(/^WV-/, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0) + 1,
  );

  const prepared: HandoffRef[] = input.units.map((unit, index) => {
    const declared = (unit.skills ?? []).filter((id) => knownSkills.includes(id));
    return {
      id: handoffId(first + index),
      role: unit.role,
      objective: unit.objective,
      context: unit.context,
      allowedScope: unit.allowedScope,
      prohibitedScope: unit.prohibitedScope,
      questions: unit.questions,
      requiredEvidence: unit.requiredEvidence,
      stopCondition: unit.stopCondition,
      // A unit left with no valid skill falls back to its role's own set, so
      // the child prompt always embeds a real procedure.
      skills: declared.length > 0 ? declared : [...skillsForSpecialist(unit.role)],
      dependsOn: unit.dependsOn ?? [],
      status: "running" as const,
      wave,
      parentSessionID: input.leaderSessionID,
    };
  });

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
    wave,
  }, (s) => ({
    ...s,
    handoffs: [...s.handoffs, ...launched],
    nextAction: { description: `Wave running: ${launched.map((h) => h.id).join(", ")}`, owner: "team-leader" },
  }));

  const prompts: string[] = [];
  for (const unit of launched) {
    const text = childPrompt(unit, unit.id);
    prompts.push(text);
    // The leader wrote this prompt: it is the task, not retrieved text. Mark
    // the session so the prompt hook does not quarantine the specialist
    // against its own brief.
    if (unit.sessionID) markTrustedLaunch(unit.sessionID);
    await launcher.prompt({ sessionID: unit.sessionID!, text });
  }

  return toolOk({
    ids: launched.map((h) => h.id),
    sessions: launched.map((h) => ({ id: h.id, sessionID: h.sessionID, role: h.role })),
    wave,
    prompts,
    revision: next.revision,
    parallelBudget: { max: budget, running: running.length + launched.length },
    ...(ignoredSkills.length > 0
      ? {
          note: `ignored unknown skill ids: ${ignoredSkills.join(", ")} — the role's own procedures were embedded instead. Valid skills: ${SKILL_IDS.join(", ")}.`,
        }
      : {}),
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
  // A failed booking has also settled: archive it so the thread list drops
  // it, exactly like a reported one.
  const archive = await archiveSettledSession(runtime, sessionID).catch(() => ({ status: "failed" as const, reason: "archive check failed" }));
  const next = await appendEvent(storeContext(projectRoot, "plugin", "plugin"), "handoff.failed", { id: handoff.id, reason: "session ended without a report", archive: archive.status, ...(archive.reason ? { archiveReason: archive.reason } : {}) }, (s) => ({
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
      // Idle is not proof of completion: a session may pause between turns of
      // a multi-step job. Only an idle older than the grace, an explicit
      // failure, or an unreadable session settles the booking.
      const idleLongEnough = typeof data?.time?.idle === "number" && Date.now() - data.time.idle > SETTLE_GRACE_MS;
      if (data?.outcome === "failed" || data?.outcome === "error" || idleLongEnough) await settleSession(runtime, handoff.sessionID!);
    } catch {
      await settleSession(runtime, handoff.sessionID!);
    }
  }
}

/** Subscribes to session execution events and settles the booked handoff. */
export async function registerOrchestrator(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const root = projectRootOf(runtime.ctx);
  const extraPrefixes = runtime.options.orchestration?.allowedCheckPrefixes ?? [];
  void (async () => {
    try {
      for await (const event of runtime.ctx.event.subscribe({ signal: controller.signal } as never)) {
        // The helper-agent lineage is fed from the host's own session events;
        // a host that does not report parents degrades to direct enforcement.
        consumeLineageEvent(event);
        const e = event as unknown as {
          type?: string;
          sessionID?: string;
          properties?: { sessionID?: string };
          data?: { sessionID?: string };
        };
        if (e.type === "session.shell.ended") {
          const shellSession = String(e.data?.sessionID ?? e.sessionID ?? e.properties?.sessionID ?? "");
          if (shellSession) recordShellEnded(shellSession, e.data);
          // Observation without a host shell surface: the host reports the
          // command, the exit code and the output of the check the specialist
          // ran, which is enough to record an observed row.
          const facts = parseShellEnded(event);
          if (facts) await observeDeclaredCheck(root, facts, extraPrefixes).catch(() => {});
          continue;
        }
        if (e.type && !["session.execution.succeeded", "session.execution.failed", "session.idle"].includes(e.type)) continue;
        const sessionID = String(e.data?.sessionID ?? e.sessionID ?? e.properties?.sessionID ?? "");
        if (!sessionID) continue;
        if (e.type === "session.idle") {
          // A session goes idle at the end of every turn. Settling on the
          // first idle marks a specialist failed while it is still thinking,
          // so the settle waits for the grace and re-checks.
          const timer = setTimeout(() => {
            timers.delete(timer);
            void settleSession(runtime, sessionID).catch(() => {});
          }, SETTLE_GRACE_MS);
          timers.add(timer);
          continue;
        }
        await settleSession(runtime, sessionID).catch(() => {});
      }
    } catch {
      // A host without the event stream still settles through report calls.
    }
  })();
  return {
    dispose: async () => {
      controller.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
