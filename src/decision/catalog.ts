import {
  selectDecisionModel,
  type DecisionCandidate,
  type DecisionSelection,
  type DecisionSelectionFailure,
} from "../domain/decision-model.js";
import type { DecisionOptions } from "../options.js";
import { effectiveThresholds, type DecisionUse } from "../domain/decision-model.js";
import type { AgentTeamContext } from "../runtime.js";

/**
 * The decision models the host offers.
 *
 * Everything here comes from the host's own catalog: the plugin names no
 * vendor, holds no price table and asks no provider what it supports. The
 * host classifies a model as a decision model, and this reads that
 * classification.
 */
export interface DecisionModelInfo extends DecisionCandidate {
  /** `provider/model`, how a caller names the model. */
  ref: string;
}

interface HostModel {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  type?: string;
  enabled?: boolean;
  status?: string;
  cost?: Array<{ input?: number; output?: number }>;
  limit?: { context?: number };
}

/** Reads the host catalog and keeps only the entries the host calls decision models. */
export async function discoverDecisionModels(ctx: AgentTeamContext): Promise<DecisionModelInfo[]> {
  let raw: unknown;
  try {
    // The host's model list defaults to chat models — the only type offered
    // for sessions — so a decision model never appears without asking for the
    // type explicitly. Newer host lines wrap the list in `{ data }`; older
    // ones return the array directly.
    raw = await ctx.model.list({ types: ["decision"] } as never);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(list)) return [];
  const out: DecisionModelInfo[] = [];
  for (const model of list as HostModel[]) {
    if (model.type !== "decision") continue;
    const providerID = String(model.providerID ?? "");
    const id = String(model.modelID ?? model.id ?? "");
    if (!providerID || !id) continue;
    const cost = Array.isArray(model.cost) ? model.cost[0] : undefined;
    out.push({
      providerID,
      id,
      ref: `${providerID}/${id}`,
      name: String(model.name ?? id),
      costPerMillionInput: typeof cost?.input === "number" ? cost.input : undefined,
      contextLimit: typeof model.limit?.context === "number" ? model.limit.context : undefined,
      enabled: model.enabled !== false,
      status: String(model.status ?? "active"),
    });
  }
  return out;
}

/**
 * The catalog, cached for a short while.
 *
 * The context hook runs on every session, and the catalog can change when the
 * operator connects a provider, so the read is cached rather than repeated on
 * every prompt.
 */
const CATALOG_TTL_MS = 30_000;
const catalogCache = new Map<string, { at: number; models: DecisionModelInfo[] }>();

export async function decisionModelCatalog(ctx: AgentTeamContext, projectRoot: string): Promise<DecisionModelInfo[]> {
  const now = Date.now();
  const cached = catalogCache.get(projectRoot);
  if (cached && now - cached.at < CATALOG_TTL_MS) return cached.models;
  const models = await discoverDecisionModels(ctx);
  catalogCache.set(projectRoot, { at: now, models });
  return models;
}

export function _resetDecisionModelCatalogForTests(): void {
  catalogCache.clear();
}

/**
 * The one decision model to use.
 *
 * The selection itself is pure and lives in the domain; this only hands it
 * the catalog.
 */
export function chooseDecisionModel(
  models: DecisionCandidate[],
  input: { pinned?: string; evidenceTokens: number },
): DecisionSelection | DecisionSelectionFailure {
  return selectDecisionModel(models, input);
}

/** The providers the host currently has connected. */
export async function connectedProviders(ctx: AgentTeamContext): Promise<Set<string>> {
  const connected = new Set<string>();
  try {
    const raw = (await ctx.provider.list()) as unknown;
    if (!Array.isArray(raw)) return connected;
    for (const provider of raw as Array<{ id?: string; connected?: boolean }>) {
      if (provider.connected && provider.id) connected.add(provider.id);
    }
  } catch {
    return connected;
  }
  return connected;
}

/**
 * The decision surfaces, rendered for a human.
 *
 * The doctor reports them briefly and the listing command reports them in
 * full; both read the same catalog, so they cannot disagree about what is
 * available.
 */
export interface DecisionReport {
  /** The host exposes the decision surface. */
  surface: boolean;
  /** The decision models, ordered the way the auto-pick would choose them. */
  models: DecisionModelInfo[];
  /** The providers that are connected, so the operator can see what is missing. */
  connected: Set<string>;
  /** How many judgement rows the project state holds. */
  judgementRows: number;
}

export async function decisionReport(
  ctx: AgentTeamContext,
  projectRoot: string,
  surface: boolean,
  judgementRows: number,
): Promise<DecisionReport> {
  const models = await decisionModelCatalog(ctx, projectRoot);
  const ordered = [...models].sort((a, b) => {
    const price = (a.costPerMillionInput ?? Number.MAX_SAFE_INTEGER) - (b.costPerMillionInput ?? Number.MAX_SAFE_INTEGER);
    if (price !== 0) return price;
    const context = (b.contextLimit ?? 0) - (a.contextLimit ?? 0);
    if (context !== 0) return context;
    return a.ref.localeCompare(b.ref);
  });
  const connected = await connectedProviders(ctx);
  return { surface, models: ordered, connected, judgementRows };
}
