import * as fs from "node:fs";
import { loadTemplates } from "../catalog/agents.js";
import { backupFile, checksumOf, isManaged, mergeProjectConfig, planStaleManagedFiles, stripHeader, withHeader } from "./jsonc.js";
import { resolveTargetAbs, targetRoot, type SetupOptions } from "./plan.js";
import { LEGACY_MANAGED_AGENT_FILES } from "./managed-files.js";
import { atomicWriteFile } from "../util/atomic-file.js";

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

export interface ApplyResult {
  created: string[];
  updated: string[];
  removed: string[];
  skipped: string[];
  backups: string[];
  configChanged: boolean;
  warnings: string[];
}

export async function applySetupPlan(opts: SetupOptions): Promise<ApplyResult> {
  // The same root the plan was built against. Resolving it twice, with two
  // different rules, made the dry run and the apply disagree when `HOME` was
  // unset.
  const root = targetRoot(opts);
  const templates = await loadTemplates();
  const created: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const backups: string[] = [];
  const warnings: string[] = [];

  for (const [rel, template] of templates) {
    // --update: only touch managed-undrifted files.
    const abs = resolveTargetAbs(root, rel, opts.scope);
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
      skipped.push(rel); // never overwrite user content
      continue;
    }
    // A managed file the user edited is drifted: the recorded checksum no longer
    // matches its body. The plan already reports it as keep-drifted; the apply
    // must honor that and leave it untouched.
    if (existing !== null && isDrifted(existing, template)) {
      skipped.push(rel);
      continue;
    }
    const next = withHeader(template, "1");
    if (existing === next) {
      skipped.push(rel);
      continue;
    }
    if (existing !== null) backups.push(await backupFile(root, abs));
    await atomicWriteFile(abs, next);
    if (existing === null) created.push(rel);
    else updated.push(rel);
  }

  // Roster files from an earlier version of the plugin: removed on apply so a
  // project never keeps two rosters. A file the user edited is preserved.
  for (const stale of await planStaleManagedFiles(root, LEGACY_MANAGED_AGENT_FILES)) {
    if (stale.action !== "remove-managed") {
      skipped.push(stale.path);
      continue;
    }
    const abs = resolveTargetAbs(root, stale.path, opts.scope);
    backups.push(await backupFile(root, abs));
    await fs.promises.rm(abs);
    removed.push(stale.path);
  }

  // opencode.jsonc merge (project scope only writes config; global never touches project config)
  let configChanged = false;
  if (opts.scope === "project") {
    const merged = await mergeProjectConfig({
      projectRoot: root,
      setDefault: opts.setDefault,
      pluginPackage: opts.pluginPackage,
      pluginOptions: opts.pluginOptions,
      includePluginOptions: opts.includePluginOptions,
    });
    if (merged.changed) {
      try {
        backups.push(await backupFile(root, merged.path));
      } catch {
        // config missing: no backup needed
      }
      await atomicWriteFile(merged.path, merged.after);
      configChanged = true;
    }
  }
  return { created, updated, removed, skipped, backups, configChanged, warnings };
}
