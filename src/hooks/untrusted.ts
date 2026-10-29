/**
 * Per-session quarantine for untrusted content.
 *
 * The prompt hook detects instruction-shaped content in the user's input and
 * quarantines the offending lines. The quarantine is consequential in two
 * places:
 *
 * - the context hook tells the agent that untrusted content was seen, so it
 *   treats that content as data;
 * - the tool-audit hook refuses a tool call whose input carries a quarantined
 *   instruction, so a retrieved instruction can never become a command.
 */

const QUARANTINED = new Map<string, string[]>();

/** Minimum instruction length worth quarantining. */
const MIN_INSTRUCTION_LENGTH = 8;

export function quarantineSession(sessionId: string, instructions: string[]): void {
  const payload = instructions.map((i) => i.trim()).filter((i) => i.length >= MIN_INSTRUCTION_LENGTH);
  if (payload.length === 0) return;
  const existing = QUARANTINED.get(sessionId) ?? [];
  for (const line of payload) {
    if (!existing.includes(line)) existing.push(line);
  }
  QUARANTINED.set(sessionId, existing);
}

export function sessionIsQuarantined(sessionId: string): boolean {
  return (QUARANTINED.get(sessionId)?.length ?? 0) > 0;
}

export function quarantinedInstructions(sessionId: string): string[] {
  return [...(QUARANTINED.get(sessionId) ?? [])];
}

/** True when the payload carries a quarantined instruction. */
export function containsQuarantinedInstruction(sessionId: string, payload: unknown): boolean {
  const instructions = quarantinedInstructions(sessionId);
  if (instructions.length === 0) return false;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  if (!text) return false;
  return instructions.some((line) => text.includes(line));
}

export function clearSession(sessionId: string): void {
  QUARANTINED.delete(sessionId);
}

export function _resetQuarantineForTests(): void {
  QUARANTINED.clear();
}
