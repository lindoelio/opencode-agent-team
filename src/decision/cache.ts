import type { DecisionAnswer, DecisionThresholds, DecisionVerdict, DecisionUse } from "../domain/decision-model.js";

/**
 * The decisions the plugin executed, held in memory.
 *
 * The cache lives at module scope on purpose. The OpenCode host runs a
 * delegated specialist as a child session inside the same server process and
 * loads the plugin package once, so a module-scope map is shared by the
 * leader and every specialist it delegates to. It does not cross an OpenCode
 * server boundary and it does not survive a restart, which is why the
 * specialist's result also carries the decision block.
 */

export interface HeldDecision {
  /** The decision identifier, as `JDG-XXXXXXXX`. */
  id: string;
  /** The project the decision was executed for. */
  projectRoot: string;
  /** The acceptance criterion the decision was executed for. */
  criterion: string;
  /** The role that ran the decision. */
  role: string;
  /** The use the decision was held to. */
  use: DecisionUse;
  /** The thresholds the verdict was computed against. */
  thresholds: DecisionThresholds;
  /** The decision model that answered. */
  model: { providerID: string; id: string; ref: string };
  /** One answer per question. */
  answers: DecisionAnswer[];
  /** The verdict the plugin computed. */
  verdict: DecisionVerdict;
  /** The digest of the screened state. */
  stateDigest: string;
  /** Why this model was chosen. */
  rationale: string;
  /** How long the decision took. */
  elapsedMs: number;
  /** The usage the host reported. */
  usage: { input: number; output: number };
}

const heldDecisions = new Map<string, HeldDecision>();

/** Holds an executed decision and returns it. */
export function holdDecision(decision: Omit<HeldDecision, "id"> & { id: string }): HeldDecision {
  heldDecisions.set(decision.id, decision);
  return decision;
}

/** The decision with that identifier, when this plugin executed it here. */
export function findHeldDecision(id: string): HeldDecision | undefined {
  return heldDecisions.get(id);
}

/** The decision with that identifier, only when it belongs to this project. */
export function findHeldDecisionForProject(projectRoot: string, id: string): HeldDecision | undefined {
  const decision = heldDecisions.get(id);
  return decision && decision.projectRoot === projectRoot ? decision : undefined;
}

/** Drops every held decision. Used by the tests. */
export function _resetHeldDecisionsForTests(): void {
  heldDecisions.clear();
}
