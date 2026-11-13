/**
 * Trusted launch prompts.
 *
 * The prompt hook quarantines instruction-shaped content so retrieved text
 * cannot become a command. A handoff prompt written by the leader is not
 * retrieved text: it *is* the task, and a legitimate "Execute command: npm
 * test" objective would otherwise quarantine the specialist against its own
 * brief. The launch marks the session once; the hook consumes the mark.
 */

const TRUSTED = new Set<string>();

export function markTrustedLaunch(sessionID: string): void {
  if (sessionID) TRUSTED.add(sessionID);
}

/** True once per marked session; the mark is consumed by its first prompt. */
export function consumeTrustedLaunch(sessionID: string): boolean {
  if (!TRUSTED.has(sessionID)) return false;
  TRUSTED.delete(sessionID);
  return true;
}

export function _resetTrustedLaunchesForTests(): void {
  TRUSTED.clear();
}
