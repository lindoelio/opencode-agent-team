import * as fs from "node:fs";
import * as path from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { atomicWriteFile } from "../util/atomic-file.js";
import { sha256Hex } from "../util/hash.js";

export interface SetupPlanFile {
  path: string;
  action: "create" | "update-managed" | "keep-drifted" | "keep" | "remove-managed";
  reason: string;
}

export interface SetupPlan {
  files: SetupPlanFile[];
  configDiff?: string | undefined;
  warnings: string[];
}

export function managedHeader(version: string, checksum: string): string {
  return `\n<!-- AGENT-TEAM-MANAGED version=${version} checksum=${checksum} -->\n`;
}

export function checksumOf(content: string): string {
  return sha256Hex(content).slice(0, 16);
}

export function isManaged(content: string): { version: string; checksum: string } | null {
  const m = content.match(/AGENT-TEAM-MANAGED version=([^\s]+) checksum=([^\s>]+)/);
  if (!m) return null;
  return { version: m[1] ?? "?", checksum: (m[2] ?? "?").replace(/-->$/, "") };
}

export async function planManagedFiles(projectRoot: string, templates: Map<string, string>, version: string): Promise<SetupPlanFile[]> {
  const files: SetupPlanFile[] = [];
  for (const [rel, template] of templates) {
    const abs = path.join(projectRoot, rel);
    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(abs, "utf8");
    } catch {
      existing = null;
    }
    if (existing === null) {
      files.push({ path: rel, action: "create", reason: "missing" });
      continue;
    }
    const meta = isManaged(existing);
    if (!meta) {
      files.push({ path: rel, action: "keep-drifted", reason: "not managed; user content preserved" });
      continue;
    }
    const body = stripHeader(existing);
    const templateBody = stripHeader(template);
    if (body === templateBody) {
      if (meta.checksum === checksumOf(body)) files.push({ path: rel, action: "keep", reason: "up to date" });
      else files.push({ path: rel, action: "update-managed", reason: `repair header v${meta.version}` });
      continue;
    }
    if (meta.checksum === checksumOf(body)) {
      // Intact managed file; the template evolved.
      files.push({ path: rel, action: "update-managed", reason: `update v${meta.version} -> v${version}` });
      continue;
    }
    // Content matches neither the recorded checksum nor the template: user drift.
    files.push({ path: rel, action: "keep-drifted", reason: `managed file drifted (v${meta.version})` });
  }
  return files;
}

export function stripHeader(content: string): string {
  // Managed marker is a trailing HTML comment on its own line; frontmatter must stay at byte 0.
  // Legacy leading markers are also stripped for migration.
  return content.replace(/<!-- AGENT-TEAM-MANAGED[^>]*-->\n?$/, "").replace(/^<!-- AGENT-TEAM-MANAGED[^>]*-->\n?/, "");
}

export function withHeader(template: string, version: string): string {
  let body = stripHeader(template);
  if (!body.endsWith("\n")) body += "\n";
  return body + managedHeader(version, checksumOf(body)).slice(1);
}

/** Safe JSONC merge: preserve comments/order, insert default_agent + plugin options only when asked. */
export async function mergeProjectConfig(input: {
  projectRoot: string;
  setDefault: boolean;
  pluginPackage: string;
  pluginOptions: Record<string, unknown>;
  includePluginOptions: boolean;
}): Promise<{ path: string; before: string; after: string; changed: boolean }> {
  const configPath = path.join(input.projectRoot, "opencode.jsonc");
  let before = "";
  try {
    before = await fs.promises.readFile(configPath, "utf8");
  } catch {
    before = "";
  }
  const errors: unknown[] = [];
  const parsed = before.trim().length === 0 ? {} : (parse(before, errors as never, { allowTrailingComma: true }) as Record<string, unknown>);
  if ((errors as unknown[]).length > 0) {
    throw new Error(`opencode.jsonc has parse errors: ${JSON.stringify(errors).slice(0, 500)}`);
  }
  let after = before.trim().length === 0 ? "{\n}\n" : before;
  if (input.setDefault && (parsed as Record<string, unknown>)["default_agent"] !== "team-leader") {
    after = applyJsoncEdit(after, ["default_agent"], "team-leader");
  }
  if (input.includePluginOptions) {
    const plugins = (parsed as Record<string, unknown>)["plugins"];
    const entry = { package: input.pluginPackage, options: input.pluginOptions };
    if (!Array.isArray(plugins)) {
      after = applyJsoncEdit(after, ["plugins"], [entry]);
    } else {
      const idx = plugins.findIndex((p) => {
        const spec = pluginSpecOf(p);
        return spec !== undefined && samePlugin(spec, input.pluginPackage);
      });
      if (idx === -1) {
        const next = [...plugins, entry];
        after = applyJsoncEdit(after, ["plugins"], next);
      } else {
        // Same package, possibly a different version or a local checkout. Two
        // entries for the same package load two copies of the plugin, so the
        // spec is updated in place. The user's own options are left alone.
        const existing = plugins[idx];
        const current = pluginSpecOf(existing)!;
        const nextSpec = isLocalPath(current) ? current : input.pluginPackage;
        if (nextSpec !== current) {
          const next = [...plugins];
          next[idx] = typeof existing === "string" ? nextSpec : { ...(existing as Record<string, unknown>), package: nextSpec };
          after = applyJsoncEdit(after, ["plugins"], next);
        }
      }
    }
  }
  return { path: configPath, before, after, changed: after !== before };
}

/** The package spec of a plugins entry, whether it is a bare string or an object. */
function pluginSpecOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const pkg = (entry as Record<string, unknown>)["package"];
    return typeof pkg === "string" ? pkg : undefined;
  }
  return undefined;
}

/** Strips the version suffix: `@scope/name@1.2.3` -> `@scope/name`. */
function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** A local checkout path, not a registry spec. */
function isLocalPath(spec: string): boolean {
  return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file://");
}

/** Two specs refer to the same package when their names match, version aside. */
function samePlugin(a: string, b: string): boolean {
  if (a === b) return true;
  if (isLocalPath(a)) return path.basename(stripFileScheme(a)) === lastNameSegment(packageNameOf(b));
  if (isLocalPath(b)) return path.basename(stripFileScheme(b)) === lastNameSegment(packageNameOf(a));
  return packageNameOf(a) === packageNameOf(b);
}

function stripFileScheme(spec: string): string {
  return spec.startsWith("file://") ? spec.slice("file://".length) : spec;
}

/** The last segment of a package name: `@scope/name` -> `name`. */
function lastNameSegment(pkg: string): string {
  const parts = pkg.split("/");
  return parts[parts.length - 1] ?? pkg;
}

function applyJsoncEdit(text: string, jsonPath: (string | number)[], value: unknown): string {
  const edits = modify(text, jsonPath as never, value as never, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  return applyEdits(text, edits);
}

export async function backupFile(projectRoot: string, absPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(projectRoot, ".agent-team", "setup-backups", stamp, path.basename(absPath));
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    const content = await fs.promises.readFile(absPath, "utf8");
    await atomicWriteFile(dest, content);
    return dest;
  } catch {
    // missing file: record intention only
    await atomicWriteFile(dest + ".missing", "");
    return dest + ".missing";
  }
}

/**
 * Managed files left behind by an earlier version of the plugin. A file is
 * only a candidate when it still carries the managed marker: anything the
 * user wrote or edited is left alone.
 */
export async function planStaleManagedFiles(root: string, candidates: readonly string[]): Promise<SetupPlanFile[]> {
  const out: SetupPlanFile[] = [];
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    let existing: string;
    try {
      existing = await fs.promises.readFile(abs, "utf8");
    } catch {
      continue;
    }
    const meta = isManaged(existing);
    if (!meta) continue; // not plugin-managed: not ours to touch
    const body = stripHeader(existing);
    if (meta.checksum === checksumOf(body)) {
      out.push({ path: rel, action: "remove-managed", reason: "installed by a previous version; the roster was replaced" });
    } else {
      out.push({ path: rel, action: "keep-drifted", reason: "user edited a previous-version file; preserved" });
    }
  }
  return out;
}
