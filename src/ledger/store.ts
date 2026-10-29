import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, appendFileSynced } from "../util/atomic-file.js";
import { sha256Hex } from "../util/hash.js";
import { eventId } from "../util/ids.js";
import { eventsPath, agentTeamDir, resolveInside, statePath, assertNoSymlinkEscape } from "../util/paths.js";
import { AgentTeamEventSchema, AgentTeamProjectStateSchema, type AgentTeamEventV1, type AgentTeamProjectStateV2 } from "../domain/schemas.js";
import { migrateUnknown } from "./migrations.js";
import { computeEventHash, GENESIS_HASH, verifyChain } from "./events.js";
import { redactText, redactUnknown } from "./redaction.js";

const LOCKS = new Map<string, Promise<void>>();

/**
 * Serializes writes to one project root.
 *
 * The lock is per-process: it protects concurrent writes made by tools in the
 * same OpenCode server process. It does not protect against a second process
 * writing the same ledger — that is what the hash chain and the
 * `expectedRevision` guard are for, and a broken chain fails closed.
 */
export async function withLedgerLock<T>(key: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  while (LOCKS.has(key)) {
    if (Date.now() - started > timeoutMs) throw new Error(`lock timeout: ${key}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  LOCKS.set(key, gate);
  try {
    return await fn();
  } finally {
    LOCKS.delete(key);
    release();
  }
}

export interface StoreContext {
  projectRoot: string;
  sessionIdHash: string;
  actor: string;
}

function sessionHash(sessionId: string): string {
  return sha256Hex(sessionId).slice(0, 16);
}

export async function ensureLayout(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  for (const dir of ["", "ledger", "decisions", "deliveries", "evidence/artifacts", "judgements", "approvals", "exports"]) {
    await fs.promises.mkdir(path.join(agentTeamDir(root), dir), { recursive: true });
  }
  const readme = path.join(agentTeamDir(root), "README.md");
  try {
    await fs.promises.access(readme);
  } catch {
    await atomicWriteFile(readme, "# .agent-team\n\nAgent Team project ledger. Machine-managed; edit via /agent-team commands and tools.\n");
  }
}

export async function readState(projectRoot: string): Promise<AgentTeamProjectStateV2 | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath(projectRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as { schemaVersion?: number };
  if (parsed?.schemaVersion === 1) return migrateStateFile(projectRoot, raw);
  return AgentTeamProjectStateSchema.parse(parsed);
}

/**
 * Migrates a v1 state file to v2 in place. The pre-migration file is backed
 * up first so a failed upgrade never destroys the previous ledger state.
 */
async function migrateStateFile(projectRoot: string, raw: string): Promise<AgentTeamProjectStateV2> {
  const root = path.resolve(projectRoot);
  await ensureLayout(root);
  const validated = AgentTeamProjectStateSchema.parse(migrateUnknown(JSON.parse(raw)));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(agentTeamDir(root), "setup-backups", stamp, "state.v1.json");
  await fs.promises.mkdir(path.dirname(backup), { recursive: true });
  await atomicWriteFile(backup, raw);
  await atomicWriteFile(statePath(root), JSON.stringify(validated, null, 2));
  return validated;
}

export async function readEvents(projectRoot: string): Promise<AgentTeamEventV1[]> {
  try {
    const raw = await fs.promises.readFile(eventsPath(projectRoot), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.map((l) => AgentTeamEventSchema.parse(JSON.parse(l)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function appendEvent(
  ctx: StoreContext,
  type: string,
  payload: unknown,
  mutate: (state: AgentTeamProjectStateV2) => AgentTeamProjectStateV2,
): Promise<AgentTeamProjectStateV2> {
  const root = path.resolve(ctx.projectRoot);
  return withLedgerLock(`agent-team:${root}`, async () => {
    await ensureLayout(root);
    const current = await readState(root);
    if (!current) throw new Error("agent-team state not initialized; run agent_team_state initialize");
    const events = await readEvents(root);
    const chain = verifyChain(events);
    if (!chain.ok) throw new Error(`ledger chain broken at index ${chain.badIndex}; recover from backup`);
    const sanitized = redactUnknown(payload);
    const sequence = events.length;
    const previousHash = sequence === 0 ? GENESIS_HASH : (events[events.length - 1]?.hash ?? GENESIS_HASH);
    const base = {
      schemaVersion: 1 as const,
      id: eventId(),
      sequence,
      timestamp: new Date().toISOString(),
      projectId: current.project.id,
      engagementId: current.engagement.id,
      sessionIdHash: ctx.sessionIdHash,
      actor: ctx.actor,
      type,
      payload: sanitized,
      previousHash,
    };
    const hash = computeEventHash(base);
    const event: AgentTeamEventV1 = { ...base, hash };
    const next = mutate(structuredClone(current));
    next.revision = current.revision + 1;
    next.engagement.updatedAt = event.timestamp;
    const validated = AgentTeamProjectStateSchema.parse(redactUnknown(next));
    await appendFileSynced(eventsPath(root), JSON.stringify(event) + "\n");
    await atomicWriteFile(statePath(root), JSON.stringify(validated, null, 2));
    return validated;
  });
}

export async function initializeState(input: {
  projectRoot: string;
  sessionId: string;
  actor: string;
  outcome: string;
  actors?: string[];
  constraints?: string[];
  nonGoals?: string[];
  acceptance?: string[];
}): Promise<AgentTeamProjectStateV2> {
  const root = path.resolve(input.projectRoot);
  return withLedgerLock(`agent-team:${root}`, async () => {
    await ensureLayout(root);
    const existing = await readState(root);
    if (existing) return existing;
    const now = new Date().toISOString();
    const { engagementId } = await import("../util/ids.js");
    const state: AgentTeamProjectStateV2 = {
      schemaVersion: 2,
      revision: 0,
      project: { id: `PRJ-${sha256Hex(root).slice(0, 8).toUpperCase()}`, canonicalDirectoryHash: sha256Hex(root) },
      engagement: { id: engagementId(), createdAt: now, updatedAt: now, status: "DRAFT", phase: "INTENT" },
      outcome: input.outcome,
      actors: input.actors ?? [],
      constraints: input.constraints ?? [],
      nonGoals: input.nonGoals ?? [],
      guardrails: [],
      assumptions: [],
      decisions: [],
      risks: [],
      gates: [],
      evidence: [],
      approvals: [],
      handoffs: [],
      nextAction: { description: "Run /agent-team/discover to inventory the current state", owner: "team-leader" },
    };
    // The initial projection is written here rather than through
    // `appendEvent`, so it needs the redactor of its own. Without it, a secret
    // in the outcome survives verbatim in state.json — and the event that
    // records the same outcome is redacted, so the two disagree.
    const validated = AgentTeamProjectStateSchema.parse(redactUnknown(state));
    const event: AgentTeamEventV1 = {
      schemaVersion: 1,
      id: eventId(),
      sequence: 0,
      timestamp: now,
      projectId: validated.project.id,
      engagementId: validated.engagement.id,
      sessionIdHash: sessionHash(input.sessionId),
      actor: input.actor,
      type: "engagement.initialized",
      payload: redactUnknown({ outcome: input.outcome, acceptance: input.acceptance ?? [] }),
      previousHash: GENESIS_HASH,
      hash: "",
    };
    event.hash = computeEventHash({ ...event, hash: undefined as never } as Omit<AgentTeamEventV1, "hash">);
    await appendFileSynced(eventsPath(root), JSON.stringify(event) + "\n");
    await atomicWriteFile(statePath(root), JSON.stringify(validated, null, 2));
    return validated;
  });
}

export function storeContext(projectRoot: string, sessionId: string, actor: string): StoreContext {
  return { projectRoot: path.resolve(projectRoot), sessionIdHash: sessionHash(sessionId), actor };
}

/**
 * The single write path for every ledger document.
 *
 * Redaction happens here rather than at the call site, so a new document type
 * cannot bypass it by omission. Free-text bodies are redacted as text;
 * structured bodies are redacted key-by-key, which is both more precise and
 * preserves values such as an evidence digest that a text rule would eat.
 */
async function writeLedgerDocument(projectRoot: string, relPath: string, body: unknown): Promise<string> {
  const abs = resolveInside(projectRoot, relPath);
  await assertNoSymlinkEscape(path.resolve(projectRoot), abs);
  const content = typeof body === "string" ? redactText(body) : JSON.stringify(redactUnknown(body), null, 2);
  await atomicWriteFile(abs, content);
  return abs;
}

export async function writeDecisionDoc(projectRoot: string, id: string, markdown: string): Promise<string> {
  return writeLedgerDocument(projectRoot, `.agent-team/decisions/${id}.md`, markdown);
}

export async function writeDeliveryDoc(projectRoot: string, id: string, yaml: string): Promise<string> {
  return writeLedgerDocument(projectRoot, `.agent-team/deliveries/${id}.yaml`, yaml);
}

export async function writeEvidenceDoc(projectRoot: string, id: string, json: unknown): Promise<string> {
  return writeLedgerDocument(projectRoot, `.agent-team/evidence/${id}.json`, json);
}

/**
 * The judgement document.
 *
 * Written by the decision tool for every executed decision, so a decision
 * nobody submitted as evidence is still auditable. It goes through the shared
 * redacting write path like every other document, and it sits outside the hash
 * chain and outside the owner guard because a specialist writes it.
 */
export async function writeJudgementDoc(projectRoot: string, id: string, json: unknown): Promise<string> {
  return writeLedgerDocument(projectRoot, `.agent-team/judgements/${id}.json`, json);
}
