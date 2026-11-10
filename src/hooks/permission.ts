import { approvalSatisfies, classifyAuthority, classifyGuarded, matchesGuardrail } from "../domain/authority.js";
import { readState } from "../ledger/store.js";
import { projectRootOf, type AgentTeamRuntime } from "../runtime.js";

/**
 * permission.evaluate: YOLO by default.
 *
 * - ALLOW is the baseline, including external, destructive, production,
 *   financial and legal actions. The hook does not elevate allow -> ask.
 * - ASK is produced only by (a) user-registered guardrails
 *   (`autonomy.askBefore`, `/agent-team/guard`) or (b) `autonomy.mode: "guarded"`
 *   (legacy opt-in behavior). State-level settings override plugin options.
 * - DENY integrity rules are final and are never weakened.
 * - A previously asked action is allowed only with an exact, current approval.
 */
export async function registerPermissionHook(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const reg = await runtime.ctx.permission.hook("evaluate", async (event: any) => {
    const action = String(event.action ?? "");
    const resources = [...(event.resources ?? [])];
    const agent = event.agent ? String(event.agent) : undefined;
    const resourceText = resources.join(" ");

    const isExternal = /push|pull request|pr\b|publish|deploy|tag |http|external|mcp|webhook/i.test(`${action} ${resourceText}`);
    const isDestructive = /delete|destroy|drop|rm\s+-rf|production|billing|permission|destructive/i.test(`${action} ${resourceText}`);
    const isOutsideDelivery = /outside|out-of-scope|\.\.\//i.test(resourceText);

    // Effective autonomy: state overrides plugin options.
    let mode = runtime.options.autonomy?.mode ?? "yolo";
    let guardrails = [...(runtime.options.autonomy?.askBefore ?? [])];
    let allowPromotion = runtime.options.autonomy?.allowPromotion === true;
    try {
      const root = projectRootOf(runtime.ctx);
      const state = await readState(root);
      if (state) {
        guardrails = [...guardrails, ...state.guardrails];
        if (state.autonomyMode) mode = state.autonomyMode;
        // An explicit state value wins, including false: --no-promotion must
        // override an option that enabled it.
        if (state.allowPromotion !== undefined) allowPromotion = state.allowPromotion === true;
      }
    } catch {
      // storage failure: fall back to option-level configuration
    }

    const query = { action, resource: resources[0], role: agent, isExternal, isDestructive, isOutsideDelivery };
    const verdict = mode === "guarded" ? classifyGuarded(query) : classifyAuthority(query);

    // Integrity denial runs first. A promotion flag can never turn a DENY into
    // an allow, even when the action name also mentions deploy.
    if (verdict.effect === "DENY") {
      event.effect = "deny";
      event.message = `Agent Team DENY: ${verdict.reason}`;
      return;
    }

    // Promotion is denied, not asked. The allow-promotion flag is the only
    // authorization; an ask-before match and a one-time permission reply are
    // not.
    // Match the action, not the resource: editing `release.md` is not a
    // release, and a shell command that mentions a deploy directory is not a
    // deploy either.
    const isPromotion = /\b(push|tag|publish|deploy|release|deployment)\b/i.test(action);
    if (isPromotion && !allowPromotion) {
      event.effect = "deny";
      event.message = "Agent Team DENY: promotion requires explicit authorization. Record --allow-promotion; an ask-before guardrail does not authorize it.";
      return;
    }
    if (isPromotion && allowPromotion) {
      event.effect = "allow";
      event.message = "Agent Team ALLOW: promotion explicitly authorized.";
      return;
    }

    // Guardrails are the only source of ASK in yolo mode.
    const matched = matchesGuardrail(guardrails, action, resources);
    if (matched && event.effect === "allow") {
      event.effect = "ask";
      event.message = `Agent Team ASK (guardrail "${matched}"): ${`${action} ${resourceText}`.trim()}`;
    } else if (verdict.effect === "ASK" && event.effect === "allow") {
      event.effect = "ask";
      event.message = `Agent Team ASK: ${verdict.reason}`;
    }

    // A previous ask may be satisfied by an exact matching approval.
    if (event.effect === "ask") {
      try {
        const root = projectRootOf(runtime.ctx);
        const state = await readState(root);
        const approvals = state?.approvals ?? [];
        const match = approvals.find((a) =>
          approvalSatisfies(`${action}:${resources[0] ?? ""}`.replace(/:$/, ""), resources, a as never) ||
          approvalSatisfies(action, resources, a as never),
        );
        if (match) {
          event.effect = "allow";
          event.message = `Agent Team approval ${match.id} matched scope`;
          return;
        }
      } catch {
        // storage failure: fail closed, keep ask
      }
      if (!event.message) event.message = "Agent Team: explicit authorization required";
    }
  });
  return { dispose: () => reg.dispose() };
}

/** Re-exported from the domain so the observer and the hook share one list. */
export { VALIDATION_SAFE_PREFIXES, isAllowedCheck as isValidationSafe } from "../domain/checks.js";
