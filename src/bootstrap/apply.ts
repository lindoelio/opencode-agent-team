import * as fs from "node:fs";
import { atomicWriteFile } from "../util/atomic-file.js";
import { backupFile, checksumOf, isManaged, mergeConfig, planStaleManagedFiles, readConfigFile, stripHeader, withHeader } from "./jsonc.js";
import { LEGACY_MANAGED_AGENT_FILES } from "./managed-files.js";
import type { SetupOptions } from "./plan.js";
import { LEADER_REL, setupTemplates } from "./templates.js";

export interface ApplyResult {
  created: string[];
  updated: string[];
  removed: string[];
  skipped: string[];
  /** Templates this scope does not materialise, such as the project ledger readme in the global scope. */
  notMaterialised: string[];
  backups: string[];
  configChanged: boolean;
  warnings: string[];
}

/**
 * True when a managed file drifted: its body no longer matches the shipped
 * checksum and no longer matches the template. A header-only difference
 * (corrupted checksum over an intact body) is a repair, not a drift.
 */
function isDrifted(existing: string, template: string): boolean {
  const meta = isManaged(existing);
  if (!meta) return false;
  const body = stripHeader(existing);
  if (body === stripHeader(template)) return false;
  return meta.checksum !== checksumOf(body);
}

export async function applySetupPlan(opts: SetupOptions): Promise<ApplyResult> {
  const scope = opts.scope;
  // The configuration file is parsed before anything is written: a file the
  // setup cannot read stops the installation instead of leaving it half
  // applied.
  await readConfigFile(scope.configFile);
  const templates = await setupTemplates(opts.decisions.leaderTitle);
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const notMaterialised: string[] = [];
  const backups: string[] = [];
  const warnings: string[] = [];

  for (const [rel, template] of templates) {
    const abs = scope.resolve(rel);
    if (abs === null) {
      // The scope does not materialise this file: the ledger readme is a
      // project artifact, and the global scope writes no project ledger.
      notMaterialised.push(rel);
      warnings.push(`${rel}: not materialised in the ${scope.kind} scope`);
      continue;
    }
    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(abs, "utf8");
    } catch {
      existing = null;
    }
    if (opts.updateOnly && existing === null) {
      // `--update` refreshes the installed roster; it does not add the files
      // a newer version of the plugin introduced.
      warnings.push(`not created (not installed): ${rel}`);
      continue;
    }
    if (existing !== null && isManaged(existing) === null) {
      skipped.push(abs); // never overwrite user content
      continue;
    }
    // A managed file the user edited is drifted: the recorded checksum no
    // longer matches its body. The plan already reports it as keep-drifted;
    // the apply must honor that and leave it untouched.
    if (existing !== null && isDrifted(existing, template)) {
      skipped.push(abs);
      continue;
    }
    const title = rel === LEADER_REL ? opts.decisions.leaderTitle : undefined;
    const next = withHeader(template, "1", title);
    if (existing === next) {
      skipped.push(abs);
      continue;
    }
    if (existing !== null) backups.push(await backupFile(scope.backupDir, abs));
    await atomicWriteFile(abs, next);
    if (existing === null) created.push(abs);
    else updated.push(abs);
  }

  // Roster files from an earlier version of the plugin: removed on apply so a
  // project never keeps two rosters. A file the user edited is preserved.
  for (const stale of await planStaleManagedFiles(scope, LEGACY_MANAGED_AGENT_FILES)) {
    if (stale.action !== "remove-managed") {
      skipped.push(stale.abs);
      continue;
    }
    backups.push(await backupFile(scope.backupDir, stale.abs));
    await fs.promises.rm(stale.abs);
    removed.push(stale.abs);
  }

  // The configuration merge. It parses before it writes, so a file the setup
  // cannot read stops the installation instead of leaving it half applied.
  let configChanged = false;
  const merged = await mergeConfig({
    configFile: scope.configFile,
    setDefault: opts.decisions.setDefault === true,
    pluginPackage: opts.pluginPackage,
    pluginOptions: opts.pluginOptions,
    includePluginOptions: opts.includePluginOptions,
    repin: scope.kind === "project",
  });
  if (merged.changed) {
    // A backup that fails stops the write: the user's own file must not be
    // replaced by one the setup cannot restore from.
    backups.push(await backupFile(scope.backupDir, merged.path));
    await atomicWriteFile(merged.path, merged.after);
    configChanged = true;
  }
  return { created, updated, removed, skipped, notMaterialised, backups, configChanged, warnings };
}
