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
  for (const [index, step] of delivery.validationSteps.entries()) {
    if (!isAllowedCheck(step, extra)) continue;
    // Pair each step with a criterion by position. Using the first criterion
    // for every step made a multi-criterion delivery impossible to satisfy.
    const criterion = delivery.acceptanceCriteria[Math.min(index, delivery.acceptanceCriteria.length - 1)];
    if (!criterion) continue;
    const already = state.evidence.some((e) => e.criterionId === criterion && e.command === step && e.observed === true && e.status === "pass");
    if (already) continue;
    let outcome: { exitCode: number; output: string };
    try {
      const ran = await runHostShell(runtime, { sessionID, command: step, cwd: projectRoot });
      if (!ran) return 0;
      outcome = ran;
    } catch (err) {
      outcome = { exitCode: 1, output: String((err as Error).message ?? "check failed") };
    }
    await recordObservedEvidence(projectRoot, {
      criterionId: criterion,
      kind: delivery.criterionKinds?.[criterion] ?? "test",
      summary: `${step} exited ${outcome.exitCode}`,
      command: step,
      exitCode: outcome.exitCode,
      output: outcome.output,
    });
    recorded += 1;
  }
  return recorded;
}
