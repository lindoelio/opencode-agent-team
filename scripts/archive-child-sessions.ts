import { execFileSync } from "node:child_process";

/**
 * Archives the child sessions the plugin booked for specialists.
 *
 * Why this exists: the plugin archives a child when it settles, but a host
 * whose plugin runtime ignores `session.update({ archived: true })` leaves it
 * visible (the report event records `archive: "failed"`). The host's HTTP API
 * does apply the archive, so this operator command is the working path on
 * those hosts.
 *
 * It targets only sessions the plugin created: those carry
 * `metadata.agentTeamParent`. The leader's own session is never touched.
 *
 *   npm run sessions:archive            # dry run: lists what would be archived
 *   npm run sessions:archive -- --apply # archives them
 *   npm run sessions:archive -- --temp --apply
 *                                       # also archives sessions left in the OS temp dirs
 */

interface SessionRow {
  id?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  location?: { directory?: string };
}

function apiGet(path: string): { data?: SessionRow[]; cursor?: { next?: string } } {
  return JSON.parse(execFileSync("opencode", ["api", "get", path], { encoding: "utf8" }));
}

function listSessions(): SessionRow[] {
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

function isChild(session: SessionRow): boolean {
  return typeof session.metadata?.["agentTeamParent"] === "string";
}

function isTestDebris(session: SessionRow): boolean {
  const directory = session.location?.directory ?? "";
  return directory.startsWith("/private/var/folders/") || directory.startsWith("/tmp/");
}

function archive(sessionID: string): void {
  execFileSync("opencode", ["api", "session.update", "--param", `sessionID=${sessionID}`, "-d", '{"archived":true}'], {
    encoding: "utf8",
  });
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const includeTemp = args.has("--temp");
  const sessions = listSessions();
  const targets = sessions.filter((session) => isChild(session) || (includeTemp && isTestDebris(session)));

  if (targets.length === 0) {
    console.log("no child session to archive");
    return;
  }
  for (const session of targets) {
    console.log(`${apply ? "archiving" : "would archive"} ${session.id} — ${session.title ?? "(untitled)"}`);
  }
  if (!apply) {
    console.log(`dry run: ${targets.length} session(s); re-run with --apply to archive them`);
    return;
  }
  let archived = 0;
  for (const session of targets) {
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

main();
