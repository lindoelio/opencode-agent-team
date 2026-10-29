import type { Phase, WorkStatus } from "./schemas.js";

const PHASE_ORDER: Phase[] = [
  "INTENT",
  "DISCOVER",
  "FRAME",
  "DECIDE",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "REVIEW",
  "ACCEPT",
  "DELIVER",
];

/** Allowed forward step plus documented backward returns. Forward jumps of >1 are rejected. */
const BACKWARD_EDGES: Record<Phase, Phase[]> = {
  INTENT: [],
  DISCOVER: ["INTENT"],
  FRAME: ["INTENT", "DISCOVER"],
  DECIDE: ["FRAME", "DISCOVER"],
  PLAN: ["DECIDE", "FRAME"],
  EXECUTE: ["PLAN"],
  VERIFY: ["EXECUTE", "PLAN"],
  REVIEW: ["VERIFY", "EXECUTE"],
  ACCEPT: ["REVIEW", "VERIFY"],
  DELIVER: ["ACCEPT"],
};

export function canTransitionPhase(from: Phase, to: Phase): boolean {
  if (from === to) return true;
  const fi = PHASE_ORDER.indexOf(from);
  const ti = PHASE_ORDER.indexOf(to);
  if (ti === fi + 1) return true; // canonical forward step
  return (BACKWARD_EDGES[to] ?? []).includes(from) || (BACKWARD_EDGES[from] ?? []).includes(to);
}

export function validatePhaseTransition(from: Phase, to: Phase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(`invalid phase transition: ${from} -> ${to}`);
  }
}

const STATUS_ORDER: WorkStatus[] = [
  "DRAFT",
  "READY",
  "IN_PROGRESS",
  "VERIFYING",
  "REVIEWING",
  "ACCEPTED",
  "DELIVERY_READY",
  "DELIVERED",
];

const TERMINAL: WorkStatus[] = ["FAILED", "BLOCKED", "CANCELLED"];

/**
 * The statuses the phase machine can actually produce. `READY` is in the
 * schema but no phase maps to it, so a transition may skip it: the normal
 * progression from INTENT (DRAFT) to DISCOVER (IN_PROGRESS) is one phase
 * step and two status steps.
 */
const REACHABLE_STATUSES = new Set<WorkStatus>([
  "DRAFT",
  "IN_PROGRESS",
  "VERIFYING",
  "REVIEWING",
  "ACCEPTED",
  "DELIVERY_READY",
  "DELIVERED",
]);

export function canTransitionStatus(from: WorkStatus, to: WorkStatus): boolean {
  if (from === to) return true;
  if (TERMINAL.includes(to)) {
    // Terminal states reachable from any active state, but never from DELIVERED.
    return from !== "DELIVERED";
  }
  if (TERMINAL.includes(from)) {
    // Reopen allowed back to IN_PROGRESS (records reason), nothing else silent.
    return to === "IN_PROGRESS";
  }
  const fi = STATUS_ORDER.indexOf(from);
  const ti = STATUS_ORDER.indexOf(to);
  if (fi < 0 || ti < 0) return false;
  // A status never silently goes backwards.
  if (ti < fi) return false;
  // A forward jump may skip only statuses the phase machine never produces.
  for (let i = fi + 1; i < ti; i++) {
    const skipped = STATUS_ORDER[i]!;
    if (REACHABLE_STATUSES.has(skipped)) return false;
  }
  return true;
}

export function statusForPhase(phase: Phase): WorkStatus {
  switch (phase) {
    case "INTENT":
      return "DRAFT";
    case "DISCOVER":
    case "FRAME":
    case "DECIDE":
    case "PLAN":
    case "EXECUTE":
      return "IN_PROGRESS";
    case "VERIFY":
      return "VERIFYING";
    case "REVIEW":
      return "REVIEWING";
    case "ACCEPT":
      return "ACCEPTED";
    case "DELIVER":
      return "DELIVERY_READY";
  }
}
