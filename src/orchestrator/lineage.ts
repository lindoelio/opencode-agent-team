/**
 * Session lineage for helper agents.
 *
 * A specialist may launch a built-in helper agent (explore, general, ...).
 * The helper runs under its own agent name, so a scope check keyed on the
 * `team-leader/*` prefix never sees it — and the writes the specialist is
 * forbidden to make would be one subagent call away. The map below carries
 * the parent relation the host reports, and the tool-audit hook walks it to
 * find the handoff a helper descends from.
 *
 * A host that exposes no parent relation degrades to direct-session
 * enforcement only; the map is per process and never persisted.
 */

const PARENTS = new Map<string, string>();

/** Sessions already asked about and found to have no parent. */
const NO_PARENT = new Set<string>();

export function noteParent(child: string, parent: string): void {
  if (!child || !parent || child === parent) return;
  PARENTS.set(child, parent);
  NO_PARENT.delete(child);
}

export function parentOf(sessionID: string): string | undefined {
  return PARENTS.get(sessionID);
}

/** The ancestor chain, nearest first. */
export function ancestorsOf(sessionID: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = PARENTS.get(sessionID);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = PARENTS.get(cursor);
  }
  return out;
}

/** The host call the lazy fallback uses. */
export type SessionGetter = (sessionID: string) => Promise<unknown>;

/**
 * Reads the parent relation out of the host's session record.
 *
 * The host owns this shape; the lookup accepts the envelopes the plugin
 * already handles elsewhere and never assumes one.
 */
function parentFromRecord(raw: unknown): string | undefined {
  const record = raw as {
    parentID?: unknown;
    parent?: { id?: unknown };
    data?: { parentID?: unknown; parent?: { id?: unknown } };
  };
  for (const candidate of [record?.data?.parentID, record?.parentID, record?.data?.parent?.id, record?.parent?.id]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * The parent of a session, resolved lazily when the event stream did not
 * report it.
 *
 * `session.created` is the cheap path, but a host that does not emit it (or
 * an event delivered before the subscription existed) would leave the
 * lineage empty and the boundary unenforced. The record is asked for once:
 * a positive answer is cached in the map, a definitive "no parent" is cached
 * as such. A throwing host surface is *not* cached — a transient failure must
 * not turn into a permanent negative.
 */
export async function resolveParent(getSession: SessionGetter, sessionID: string): Promise<string | undefined> {
  const known = PARENTS.get(sessionID);
  if (known) return known;
  if (NO_PARENT.has(sessionID)) return undefined;
  let raw: unknown;
  try {
    raw = await getSession(sessionID);
  } catch {
    return undefined;
  }
  const parent = parentFromRecord(raw);
  if (!parent) {
    NO_PARENT.add(sessionID);
    return undefined;
  }
  noteParent(sessionID, parent);
  return parent;
}

/**
 * The ancestor chain, walking through the host once per unknown link.
 *
 * Each step consults the event-fed map first, so a fully reported chain costs
 * no host call and a partially reported one only asks about the missing link.
 */
export async function resolveAncestors(getSession: SessionGetter, sessionID: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = await resolveParent(getSession, sessionID);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    out.push(cursor);
    cursor = await resolveParent(getSession, cursor);
  }
  return out;
}

/**
 * Records the parent relation from a host event, when the event carries it.
 * The host owns the event shape; the lookup is tolerant of the three
 * envelopes the plugin already handles elsewhere.
 */
export function consumeLineageEvent(event: unknown): void {
  const e = event as {
    type?: string;
    data?: { sessionID?: string; parentID?: string };
    sessionID?: string;
    parentID?: string;
    properties?: { sessionID?: string; parentID?: string };
  };
  if (e.type !== "session.created") return;
  const child = String(e.data?.sessionID ?? e.sessionID ?? e.properties?.sessionID ?? "");
  const parent = String(e.data?.parentID ?? e.parentID ?? e.properties?.parentID ?? "");
  noteParent(child, parent);
}

export function _resetLineageForTests(): void {
  PARENTS.clear();
  NO_PARENT.clear();
}
