import { mergeConfig, planManagedFiles, planStaleManagedFiles, type SetupPlan } from "./jsonc.js";
import { LEGACY_MANAGED_AGENT_FILES } from "./managed-files.js";
import { settlingFlagsFor, type PendingDecision, type SetupDecisions } from "./decisions.js";
import type { Scope, ScopeKind } from "./scope.js";
import { setupTemplates } from "./templates.js";

export interface SetupOptions {
  scope: Scope;
  decisions: SetupDecisions;
  pending: PendingDecision[];
  updateOnly: boolean;
  pluginPackage: string;
  pluginOptions: Record<string, unknown>;
  includePluginOptions: boolean;
}

export interface SetupPlanReport extends SetupPlan {
  scope: ScopeKind;
  configDir: string;
  pending: PendingDecision[];
  leaderTitle?: string | undefined;
}

export async function buildSetupPlan(opts: SetupOptions): Promise<SetupPlanReport> {
  const scope = opts.scope;
  const warnings: string[] = [];
  const templates = await setupTemplates(opts.decisions.leaderTitle);
  const files = await planManagedFiles(scope, templates, "1");
  // A template the scope does not materialise is reported the same way the
  // apply reports it, so the plan and the apply describe the same run.
  for (const [rel] of templates) {
    if (scope.resolve(rel) === null) warnings.push(`${rel}: not materialised in the ${scope.kind} scope`);
  }
  // `--update` refreshes the installed roster; it does not add the files a
  // newer version of the plugin introduced. The plan says so, so the dry run
  // and the apply agree.
  const notCreated = opts.updateOnly ? files.filter((f) => f.action === "create") : [];
  const scoped = opts.updateOnly ? files.filter((f) => f.action !== "create") : files;
  if (notCreated.length > 0) {
    warnings.push(`--update: not created (not installed): ${notCreated.map((f) => f.path).join(", ")}`);
  }
  // Roster files from an earlier version of the plugin are removed so that
  // the project never keeps two rosters.
  const stale = await planStaleManagedFiles(scope, LEGACY_MANAGED_AGENT_FILES);
  scoped.push(...stale);
  if (stale.some((f) => f.action === "remove-managed")) {
    warnings.push("previous-version agent files will be removed on apply (backed up first)");
  }
  const merged = await mergeConfig({
    configFile: scope.configFile,
    setDefault: opts.decisions.setDefault ?? false,
    pluginPackage: opts.pluginPackage,
    pluginOptions: opts.pluginOptions,
    includePluginOptions: opts.includePluginOptions,
    repin: scope.kind === "project",
  });
  const configDiff = merged.changed ? `--- ${merged.path}\n+++ planned\n${merged.after}` : undefined;
  return { files: scoped, configDiff, warnings, scope: scope.kind, configDir: scope.configDir, pending: opts.pending, leaderTitle: opts.decisions.leaderTitle };
}

export function renderPlanText(plan: SetupPlanReport): string {
  const lines = [`Agent Team setup plan — scope: ${plan.scope}, configuration directory: ${plan.configDir}`, ""];
  for (const f of plan.files) lines.push(`- ${f.action} ${f.abs} (${f.reason})`);
  if (plan.leaderTitle !== undefined) lines.push("", `leader title: ${plan.leaderTitle}`);
  if (plan.configDiff) lines.push("", plan.configDiff);
  if (plan.pending.length > 0) {
    lines.push("", "undecided:");
    for (const decision of plan.pending) lines.push(`- ${decision} — settle it with ${settlingFlagsFor(decision)}`);
  }
  if (plan.warnings.length > 0) lines.push("", ...plan.warnings.map((w) => `warning: ${w}`));
  return lines.join("\n");
}
