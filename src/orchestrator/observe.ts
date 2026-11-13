import * as path from "node:path";
import { appendEvent, readState, storeContext } from "../ledger/store.js";
import { evidenceId } from "../util/ids.js";
import { sha256Hex } from "../util/hash.js";
import { isAllowedCheck } from "../domain/checks.js";
import { runHostShell } from "./shell.js";
import type { AgentTeamRuntime } from "../runtime.js";
import type { DeliveryRef, EvidenceRef } from "../domain/schemas.js";

export interface ObservedCheck {
  criterionId: string;
  kind: EvidenceRef["kind"];
  summary: string;
  command: string;
  exitCode: number;
  output: string;
  artifactRef?: string;
}

/**
 * Records a check Agent Team ran through the host.
 *
 * This is the only path that writes `observed: true`. The model cannot call
 * it, and it does not accept a claim of a run: the caller passes the exit code
 * and output it observed.
 */
export async function recordObservedEvidence(projectRoot: string, check: ObservedCheck): Promise<EvidenceRef> {
  const outputDigest = sha256Hex(check.output.slice(0, 4000));
  const record: EvidenceRef = {
    id: evidenceId(Date.now()),
    criterionId: check.criterionId,
    kind: check.kind,
    status: check.exitCode === 0 ? "pass" : "fail",
    summary: check.summary.slice(0, 2000),
    command: check.command,
    digest: outputDigest,
    observedAt: new Date().toISOString(),
    observed: true,
    limitations: [],
    ...(check.artifactRef ? { artifactRef: check.artifactRef } : {}),
  };
  await appendEvent(storeContext(projectRoot, "plugin", "plugin"), "evidence.observed", {
    id: record.id,
    criterionId: record.criterionId,
    kind: record.kind,
    status: record.status,
    exitCode: check.exitCode,
    digest: outputDigest,
  }, (s) => ({ ...s, evidence: [...s.evidence, record] }));
  return record;
}

/**
 * Records an observed result for a declared check the host reported.
 *
 * This is the observation path for a host that exposes no shell surface to the
 * plugin: the specialist runs the declared command with its own shell — which
 * the tool audit limits to the allowlist — and the host reports the command,
 * the exit code and the output. Two controls keep it honest: the command must
 * match a declared step exactly, and the shell must have run inside this
 * project. A prior observed pass is not re-recorded; a prior failure is, so a
 * fixed check supersedes it.
 */
export async function observeDeclaredCheck(
  projectRoot: string,
  facts: { command: string; exitCode: number; output: string; cwd?: string },
  extraPrefixes: string[] = [],
): Promise<number> {
  const state = await readState(projectRoot);
  const delivery = state?.activeDelivery;
  if (!state || !delivery) return 0;
  if (facts.cwd) {
    const root = path.resolve(projectRoot);
    const cwd = path.resolve(facts.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return 0;
  }
  const wanted = facts.command.trim();
  const matches = delivery.validationSteps.filter((step) => step.command.trim() === wanted && isAllowedCheck(step.command, extraPrefixes));
  let recorded = 0;
  for (const step of matches) {
    const already = state.evidence.some(
      (e) => e.criterionId === step.criterionId && e.command === step.command && e.observed === true && e.status === "pass",
    );
    if (already) continue;
    await recordObservedEvidence(projectRoot, {
      criterionId: step.criterionId,
      kind: delivery.criterionKinds?.[step.criterionId] ?? "test",
      summary: `${step.command} exited ${facts.exitCode}`,
      command: step.command,
      exitCode: facts.exitCode,
      output: facts.output,
    });
    recorded += 1;
  }
  return recorded;
}

/**
 * Runs every declared validation step through the host.
 *
 * A step is skipped when it is not on the allowlist or when an observed pass
 * already exists for the same criterion and command. The plugin never spawns
 * a process: no host shell surface means no observed pass.
 */
export async function observeDeliveryChecks(
  runtime: AgentTeamRuntime,
  projectRoot: string,
  delivery: DeliveryRef,
  sessionID = "plugin",
): Promise<number> {
  const state = await readState(projectRoot);
  if (!state) return 0;
  const extra = runtime.options.orchestration?.allowedCheckPrefixes ?? [];
  let recorded = 0;
  for (const step of delivery.validationSteps) {
    if (!isAllowedCheck(step.command, extra)) continue;
    // The step names the criterion it proves. The old positional pairing
    // disappeared with the schema: a criterion the leader did not bind is
    // simply never observed, exactly as the registration note told them.
    const criterion = step.criterionId;
    const already = state.evidence.some((e) => e.criterionId === criterion && e.command === step.command && e.observed === true && e.status === "pass");
    if (already) continue;
    let outcome: { exitCode: number; output: string };
    try {
      const ran = await runHostShell(runtime, { sessionID, command: step.command, cwd: projectRoot });
      if (!ran) return 0;
      outcome = ran;
    } catch (err) {
      outcome = { exitCode: 1, output: String((err as Error).message ?? "check failed") };
    }
    await recordObservedEvidence(projectRoot, {
      criterionId: criterion,
      kind: delivery.criterionKinds?.[criterion] ?? "test",
      summary: `${step.command} exited ${outcome.exitCode}`,
      command: step.command,
      exitCode: outcome.exitCode,
      output: outcome.output,
    });
    recorded += 1;
  }
  return recorded;
}
