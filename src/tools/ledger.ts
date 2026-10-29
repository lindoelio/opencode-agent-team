import type { AgentTeamRuntime } from "../runtime.js";
import { projectRootOf } from "../runtime.js";
import { readState, storeContext, type StoreContext } from "../ledger/store.js";
import type { AgentTeamProjectStateV2 } from "../domain/schemas.js";
import { assertLedgerOwner } from "./authority.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";

export interface LedgerContext {
  projectRoot: string;
  current: AgentTeamProjectStateV2;
  ctx: StoreContext;
}

/**
 * Opens the ledger for a mutation.
 *
 * Every ledger write goes through here, so the guard lives in one place
 * rather than in seven copies that could drift: the acting role must be the
 * ledger owner, the engagement must exist, and the caller's revision must
 * still be current. A specialist may always read; it may never write.
 */
export async function openLedger(
  runtime: AgentTeamRuntime,
  tool: ToolContext | undefined,
  expectedRevision: number,
  what: string,
): Promise<LedgerContext> {
  assertLedgerOwner(tool, what);
  const projectRoot = projectRootOf(runtime.ctx);
  const current = await readState(projectRoot);
  if (!current) throw new Error("agent-team state not initialized");
  if (expectedRevision !== current.revision) {
    throw new Error(`stale revision: expected ${expectedRevision}, actual ${current.revision}`);
  }
  const sessionId = String((tool as unknown as { sessionID?: string })?.sessionID ?? "unknown");
  const agent = String((tool as unknown as { agent?: string })?.agent ?? "team-leader");
  return { projectRoot, current, ctx: storeContext(projectRoot, sessionId, agent) };
}
