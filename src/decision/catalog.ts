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
    raw = await ctx.model.list();
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: DecisionModelInfo[] = [];
  for (const model of raw as HostModel[]) {
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

/** The listing command's output. */
export function renderDecisionListing(report: DecisionReport, thresholds: string): string {
  const lines: string[] = [];
  lines.push(`Decision surface: ${report.surface ? "available" : "unavailable (the host exposes no decision surface)"}`);
  lines.push(`Decision models: ${report.models.length}`);
  if (report.models.length === 0) {
    lines.push("  (none — connect a provider that exposes decision models to enable calibrated first passes)");
  }
  for (const model of report.models) {
    const price = model.costPerMillionInput === undefined ? "price unknown" : `$${model.costPerMillionInput}/Mtok in`;
    const context = model.contextLimit === undefined ? "context unknown" : `${model.contextLimit} tokens`;
    const connected = report.connected.has(model.providerID) ? "connected" : "provider not connected";
    lines.push(`  ${model.ref} — ${model.name}; ${price}; ${context}; ${connected}; ${model.status}`);
  }
  lines.push(`Thresholds in force: ${thresholds}`);
  lines.push("A judgement is a first pass: it routes and escalates. It never approves a criterion and never supports a claim.");
  return lines.join("\n");
}

/** The block pushed into the session context of a team role. */
export function renderDecisionContext(report: DecisionReport, thresholds: string): string {
  const pick = report.models[0];
  const head = report.surface
    ? `Decision models: ${report.models.length} available${pick ? `; the auto-pick would choose ${pick.ref}` : ""}.`
    : "Decision models: none available (the host exposes no decision surface).";
  return [
    head,
    `Thresholds in force: ${thresholds}.`,
    "A judgement is a first pass: it routes the case and escalates when unsure. It never approves a criterion and never supports a claim.",
  ].join(" ");
}

/** The thresholds a role is held to, as one readable line. */
export function thresholdsLine(role: string, options: DecisionOptions, requested?: DecisionUse): string {
  const thresholds = effectiveThresholds(role, requested, options.thresholds);
  return `probability >= ${thresholds.probability}, confidence >= ${thresholds.confidence}`;
}
