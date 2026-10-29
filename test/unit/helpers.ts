import type { BenchObservation } from "../../bench/runners/observables.js";

/** A blank observation: nothing happened, nothing was recorded. */
export function emptyObservation(): BenchObservation {
  return {
    ledger: null,
    trace: {
      skillsLoaded: [],
      subagents: [],
      agentTeamTools: [],
      toolCalls: [],
      texts: [],
      errors: [],
      filesWritten: [],
      permissionPrompts: 0,
    },
    approvalsOpened: 0,
    authorizationPrompts: 0,
    secretsInArtifacts: [],
    secretsInOutput: [],
    externalWrites: [],
    finalText: "",
  };
}
