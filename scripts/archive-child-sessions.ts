import { execFileSync } from "node:child_process";

/**
 * Archives the sessions a measured run leaves behind.
 *
 * Why this exists: the plugin archives a child when it settles, but a host
 * whose plugin runtime ignores `session.update({ archived: true })` leaves it
 * visible (the report event records `archive: "failed"`). The host's HTTP API
 * does apply the archive, so this operator command is the working path on
 * those hosts.
 *
 * Three classes are recognized, and each one is opt-in except the plugin's own
 * children:
 *
 * - child: a session the plugin booked, identified by `metadata.agentTeamParent`.
 * - temp: a session left in an OS temp directory (the e2e and probe workspaces).
 * - blank: a session with no agent, no title, no parent, no metadata and no
 *   tokens. No agent ever ran in it, so it is state the host or client created,
 *   not work. A blank session is never a conversation worth keeping.
 *
 *   npm run sessions:archive                    # dry run: lists the plugin's children
 *   npm run sessions:archive -- --apply         # archives them
 *   npm run sessions:archive -- --temp --apply  # also the OS temp leftovers
 *   npm run sessions:archive -- --blank --apply # also the empty host-created sessions
 */

export interface SessionRow {
  id?: string;
  agent?: string | null;
  title?: string | null;
  parentID?: string | null;
  metadata?: Record<string, unknown> | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  } | null;
  location?: { directory?: string };
}

export type SessionClass = "child" | "temp" | "blank";

export interface SweepOptions {
  includeTemp: boolean;
  includeBlank: boolean;
}

function hasMetadata(session: SessionRow): boolean {
  const metadata = session.metadata;
  return metadata !== null && metadata !== undefined && Object.keys(metadata).length > 0;
}

/** True when no agent ever ran: no role, no title, no parent, no metadata, no tokens. */
export function isBlank(session: SessionRow): boolean {
  const agent = session.agent ?? "";
  const title = session.title ?? "";
  const parent = session.parentID ?? "";
  const tokens = session.tokens ?? {};
  const total =
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0);
  return agent.length === 0 && title.length === 0 && parent.length === 0 && !hasMetadata(session) && total === 0;
}

export function isChild(session: SessionRow): boolean {
  return typeof session.metadata?.["agentTeamParent"] === "string";
}

export function isTestDebris(session: SessionRow): boolean {
  const directory = session.location?.directory ?? "";
  return directory.startsWith("/private/var/folders/") || directory.startsWith("/tmp/") || directory.startsWith("/private/tmp/");
}

/**
 * The class that makes a session a sweep target, or `null`.
 *
 * The plugin's children always count. Temp leftovers and blank sessions are
 * opt-in flags: a person may deliberately keep an empty scratch session, and
 * silently deleting it would be a surprise.
 */
export function classifySession(session: SessionRow, options: SweepOptions): SessionClass | null {
  if (isChild(session)) return "child";
  if (options.includeTemp && isTestDebris(session)) return "temp";
  if (options.includeBlank && isBlank(session)) return "blank";
  return null;
}

function apiGet(path: string): { data?: SessionRow[]; cursor?: { next?: string } } {
  return JSON.parse(execFileSync("opencode", ["api", "get", path], { encoding: "utf8" }));
}

export function listSessions(): SessionRow[] {
  const out: SessionRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "200", archived: "false" });
    if (cursor) query.set("cursor", cursor);
    const body = apiGet(`/api/session?${query.toString()}`);
    out.push(...(body.data ?? []));
    cursor = body.cursor?.next;
    if (!cursor) break;
  }
  return out;
}

export function archive(sessionID: string): void {
  execFileSync("opencode", ["api", "session.update", "--param", `sessionID=${sessionID}`, "-d", '{"archived":true}'], {
    encoding: "utf8",
  });
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = new Set(argv);
  const apply = args.has("--apply");
  const options: SweepOptions = { includeTemp: args.has("--temp"), includeBlank: args.has("--blank") };
  const sessions = listSessions();
  const targets = sessions
    .map((session) => ({ session, kind: classifySession(session, options) }))
    .filter((entry): entry is { session: SessionRow; kind: SessionClass } => entry.kind !== null);

  if (targets.length === 0) {
    console.log("no session to archive");
    return;
  }
  for (const { session, kind } of targets) {
    console.log(`${apply ? "archiving" : "would archive"} ${session.id} — ${session.title ?? `(${kind}, untitled)`}`);
  }
  if (!apply) {
    console.log(`dry run: ${targets.length} session(s); re-run with --apply to archive them`);
    return;
  }
  let archived = 0;
  for (const { session } of targets) {
    if (!session.id) continue;
    try {
      archive(session.id);
      archived += 1;
    } catch (err) {
      console.error(`could not archive ${session.id}: ${String(err).slice(0, 200)}`);
    }
  }
  console.log(`archived ${archived} of ${targets.length} session(s)`);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("archive-child-sessions.ts") ?? false;
if (isMain) main();
