import { redactText } from "../ledger/redaction.js";

/**
 * The decision screen.
 *
 * The state a decision model scores is untrusted content. This module holds
 * the screen's own list of the instruction families that would redirect a
 * judgement, and it deliberately does not reuse the session quarantine's list:
 * that list is an existing denial trigger, and widening it would change
 * behaviour this change does not own.
 */

/**
 * The six families that would redirect a judgement.
 *
 * The match is per line and may land anywhere within the line: what matters
 * is the line's content, not where the phrase sits in it.
 */
const DECISION_OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(prior|previous|all)\s+instructions/i,
  /execute\s+(this\s+)?command/i,
  /upload\s+(this|any|all|your)\b/i,
  /disregard\s+.*policy/i,
  /bypass\s+.*(policy|protection|approval)/i,
  /override\s+.*(answer|verdict|score|decision|result)/i,
];

export interface ScreenedState {
  /** The state to send, with the secrets already redacted. */
  state: string;
  /** The lines that would redirect a judgement. */
  quarantined: string[];
}

/**
 * Screens a state for a decision.
 *
 * A quarantined line is reported rather than silently stripped: the caller
 * refuses the request, because a probability about a state the operator never
 * submitted is worse than an error.
 */
export function screenDecisionState(raw: string): ScreenedState {
  const quarantined: string[] = [];
  for (const line of raw.split("\n")) {
    if (DECISION_OVERRIDE_PATTERNS.some((pattern) => pattern.test(line))) {
      const trimmed = line.trim();
      if (trimmed.length > 0) quarantined.push(trimmed);
    }
  }
  return { state: redactText(raw), quarantined };
}
