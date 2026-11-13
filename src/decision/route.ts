import { appendEvent, readState, storeContext } from "../ledger/store.js";
import { decisionOptions } from "../options.js";
import { decisionModelCatalog, chooseDecisionModel } from "./catalog.js";
import { buildDecisionRequest, normaliseDecisionResult } from "./protocol.js";
import { screenDecisionState } from "./screen.js";
import { effectiveThresholds, estimateTokens } from "../domain/decision-model.js";
import { resolveDecisionGenerator } from "../compat/host.js";
import { projectRootOf, type AgentTeamRuntime } from "../runtime.js";
import { sha256Hex } from "../util/hash.js";

export interface Route {
  engagementClass: "fix" | "change" | "decision" | "clarify";
  namesFileAndSymptom: boolean;
  riskSignal: boolean;
  model?: string;
  reason?: string;
}

const cache = new Map<string, Route | null>();
const pending = new Map<string, Route>();
const TIMEOUT_MS = 1500;

/** A route recorded before the engagement existed, consumed at initialize. */
export function takePendingRoute(sessionID: string): Route | undefined {
  const route = pending.get(sessionID);
  pending.delete(sessionID);
  return route;
}

function cacheKey(sessionID: string, text: string): string {
  return `${sessionID}:${sha256Hex(text)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the decision did not answer within ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function answerChoice(answers: unknown[], name: string): { value: string; probability: number; confidence: number } | undefined {
  for (const raw of answers) {
    const a = raw as { type?: string; name?: string; choice?: unknown; probabilities?: Record<string, number>; confidence?: number };
    if (a.type !== "choice" || a.name !== name) continue;
    const value = String(a.choice ?? "");
    const probability = a.probabilities?.[value] ?? 0;
    return { value, probability, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
  }
  return undefined;
}

function answerPredicate(answers: unknown[], name: string): number {
  for (const raw of answers) {
    const a = raw as { type?: string; name?: string; probability?: number };
    if (a.type === "predicate" && a.name === name) return typeof a.probability === "number" ? a.probability : 0;
  }
  return 0;
}

function s_class(value: "fix" | "change" | "decision" | undefined): "fix" | "change" | "decision" | "clarify" {
  return value ?? "change";
}

async function writeRoute(runtime: AgentTeamRuntime, sessionID: string, route: Route): Promise<void> {
  const projectRoot = projectRootOf(runtime.ctx);
  const state = await readState(projectRoot).catch(() => null);
  // An operator override is the leader's judgment over the router's. It is
  // sticky within the engagement: without this guard, the next admitted
  // prompt would re-route over it and silently undo the override.
  if (state?.route?.overridden === true) {
    return;
  }
  if (!state) {
    pending.set(sessionID, route);
  }
  const confident = !route.reason?.includes("did not reach the threshold");
  const recorded = state && !confident ? { ...route, engagementClass: s_class(state.engagementClass) } : route;
  if (state) {
    await appendEvent(storeContext(projectRoot, "plugin", "plugin"), "route.recorded", { ...recorded }, (s) => ({
      ...s,
      route: recorded,
      ...(confident && (route.engagementClass === "fix" || route.engagementClass === "change" || route.engagementClass === "decision")
        ? { engagementClass: route.engagementClass }
        : {}),
    })).catch(() => {});
  }
  const line = `route: ${recorded.engagementClass}; names_file_and_symptom: ${recorded.namesFileAndSymptom}; risk: ${recorded.riskSignal}${recorded.model ? `; model: ${recorded.model}` : ""}`;
  try {
    const surface = (runtime.ctx as unknown as {
      session?: { instructions?: { entry?: { put?: (input: unknown) => Promise<unknown> } } };
    }).session?.instructions?.entry?.put;
    if (typeof surface === "function") {
      await surface({ sessionID, key: "agent-team/route", value: line });
      return;
    }
  } catch {
    // fall through to the context hook's own projection
  }
}

/**
 * Routes one admitted prompt. The cache key is the admitted text, so a replay
 * of the same admission does not call the decision model twice.
 */
export async function routePrompt(runtime: AgentTeamRuntime, sessionID: string, text: string): Promise<Route | null> {
  const key = cacheKey(sessionID, text);
  if (cache.has(key)) return cache.get(key) ?? null;
  const options = decisionOptions(runtime.options);
  if (options.mode === "off") {
    cache.set(key, null);
    return null;
  }
  const surface = resolveDecisionGenerator(runtime.ctx);
  if (!surface.available) {
    cache.set(key, null);
    return null;
  }
  const screened = screenDecisionState(text);
  if (screened.quarantined.length > 0) {
    cache.set(key, null);
    return null;
  }
  const models = await decisionModelCatalog(runtime.ctx, projectRootOf(runtime.ctx));
  if (models.length === 0) {
    cache.set(key, null);
    return null;
  }
  const state = await readState(projectRootOf(runtime.ctx)).catch(() => null);
  const projection = state
    ? `\nphase: ${state.engagement.phase}\nclass: ${state.engagementClass ?? "change"}\ncriteria: ${(state.activeDelivery?.acceptanceCriteria ?? []).join(", ")}`
    : "";
  const selection = chooseDecisionModel(models, { pinned: options.model, evidenceTokens: estimateTokens(screened.state + projection) });
  if ("error" in selection) {
    cache.set(key, null);
    return null;
  }
  const thresholds = effectiveThresholds("team-leader", undefined, options.thresholds);
  const request = buildDecisionRequest({
    model: { id: selection.model.id, providerID: selection.model.providerID },
    state: screened.state + projection,
    questions: [
      {
        type: "choice",
        name: "engagement_class",
        instructions: "Which path does this request need? fix: a bounded correction inside an accepted approach. change: a capability or behaviour change. decision: a material choice with real options. clarify: the request is too ambiguous to book work.",
        choices: [
          { value: "fix", description: "bounded correction" },
          { value: "change", description: "behaviour change" },
          { value: "decision", description: "material choice" },
          { value: "clarify", description: "too ambiguous" },
        ],
      },
      {
        type: "predicate",
        name: "names_file_and_symptom",
        instructions: "Does the request already name the file and the symptom, so an explorer adds nothing?",
      },
      {
        type: "predicate",
        name: "risk_signal",
        instructions: "Does the request involve a secret, an authentication change, or an external write?",
      },
    ],
  });
  let route: Route | null = null;
  try {
    const raw = await withTimeout(surface.generator!.decisions(request), TIMEOUT_MS);
    const answers = normaliseDecisionResult(raw).answers;
    const cls = answerChoice(answers, "engagement_class");
    const confident = cls && cls.probability >= thresholds.probability && cls.confidence >= thresholds.confidence;
    route = {
      engagementClass: confident && ["fix", "change", "decision", "clarify"].includes(cls!.value) ? (cls!.value as Route["engagementClass"]) : "change",
      namesFileAndSymptom: answerPredicate(answers, "names_file_and_symptom") >= thresholds.probability,
      riskSignal: answerPredicate(answers, "risk_signal") >= thresholds.probability,
      model: `${selection.model.providerID}/${selection.model.id}`,
      ...(confident ? {} : { reason: "the class did not reach the threshold; treated as change" }),
    };
  } catch (err) {
    route = null;
    void err;
  }
  cache.set(key, route);
  if (route) await writeRoute(runtime, sessionID, route).catch(() => {});
  return route;
}

export function _resetRouteCacheForTests(): void {
  cache.clear();
}
