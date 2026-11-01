import type { ScopeKind } from "./scope.js";

export interface SetupDecisions {
  /** Whether the leader becomes the default agent. Undefined means unanswered. */
  setDefault: boolean | undefined;
  /** The title the leader carries. Undefined means the shipped label. */
  leaderTitle: string | undefined;
}

export type PendingDecision = "setDefault" | "leaderTitle";

/** The flags that settle a decision. */
export function settlingFlagsFor(decision: PendingDecision): string {
  return decision === "setDefault" ? "--set-default | --no-default" : '--leader-title "<title>"';
}

export interface DecisionInput {
  kind: ScopeKind;
  updateOnly: boolean;
  flags: Set<string>;
  /** The value of the leader-title flag, when it was passed. */
  leaderTitle?: string | undefined;
  /** The default agent the target configuration file already records. */
  recordedDefaultAgent?: string | undefined;
  /** The title the installed leader file already records. */
  recordedTitle?: string | undefined;
  /** The title the globally installed leader file records. */
  globalRecordedTitle?: string | undefined;
  /** The leader file is absent, or is one the plugin may write. */
  leaderFileWritable: boolean;
}

export interface ResolvedDecisions {
  decisions: SetupDecisions;
  pending: PendingDecision[];
}

/**
 * The two decisions the setup makes, and the ones it still has to ask about.
 *
 * Whether a decision is unanswered does not depend on the mode: it depends on
 * the flags and on what is already recorded. What the mode decides is what
 * happens to an unanswered decision — an apply asks, a dry run lists it.
 */
export function resolveDecisions(input: DecisionInput): ResolvedDecisions {
  const setDefault = resolveDefaultAgent(input);
  const { leaderTitle, pendingTitle } = resolveLeaderTitle(input);
  const pending: PendingDecision[] = [];
  if (input.kind === "global" && setDefault === undefined) pending.push("setDefault");
  if (pendingTitle) pending.push("leaderTitle");
  return { decisions: { setDefault, leaderTitle }, pending };
}

function resolveDefaultAgent(input: DecisionInput): boolean | undefined {
  // In the global scope an update never reaches the recorded value: the
  // flags do not reach it either.
  if (input.kind === "global" && input.updateOnly) return false;
  if (input.flags.has("set-default")) return true;
  if (input.flags.has("no-default")) return false;
  if (input.kind === "project") {
    // The published project behaviour: an apply records the leader. The
    // resolution does not depend on the mode, so a dry run shows the change
    // the apply would make.
    return true;
  }
  // In the global scope a recorded value of any kind settles the decision:
  // the user's own default agent is left alone.
  if (input.recordedDefaultAgent !== undefined) return false;
  return undefined;
}

function resolveLeaderTitle(input: DecisionInput): { leaderTitle: string | undefined; pendingTitle: boolean } {
  // The flag applies only outside an update: an update refreshes the roster,
  // it does not re-title it.
  if (!input.updateOnly && input.leaderTitle !== undefined) {
    return { leaderTitle: input.leaderTitle, pendingTitle: false };
  }
  if (input.recordedTitle !== undefined) {
    return { leaderTitle: input.recordedTitle, pendingTitle: false };
  }
  if (input.kind === "project") {
    // A project with no title of its own inherits the global one.
    const inherited = input.leaderFileWritable ? input.globalRecordedTitle : undefined;
    return { leaderTitle: inherited, pendingTitle: false };
  }
  // In the global scope the title is unanswered when an update is not
  // running and the leader file is one the setup may write.
  return { leaderTitle: undefined, pendingTitle: !input.updateOnly && input.leaderFileWritable };
}
