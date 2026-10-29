import type { ToolContext } from "@opencode/plugin/promise/tool";

/**
 * Ledger-write authority.
 *
 * One orchestrator owns the ledger. Specialists produce artifacts and
 * results; the leader records them. This is what makes "one accountable
 * orchestrator" mechanically true instead of a convention, and it removes the
 * revision contention that parallel specialists would otherwise create: no
 * specialist can advance the ledger revision underneath the leader.
 */

/** The role that owns the ledger. */
export const LEDGER_OWNER = "team-leader";

export function actorOf(tool: ToolContext | undefined): string {
  return String((tool as unknown as { agent?: string })?.agent ?? LEDGER_OWNER);
}

/**
 * Refuses a ledger mutation from a non-owner role. Reads are never guarded
 * by this helper: a specialist may always look at the ledger.
 */
export function assertLedgerOwner(tool: ToolContext | undefined, what: string): void {
  const actor = actorOf(tool);
  if (actor !== LEDGER_OWNER) {
    throw new Error(
      `only ${LEDGER_OWNER} may ${what} (actor: ${actor}); specialists report their result and the leader records it`,
    );
  }
}
