import * as fs from "node:fs";
import * as path from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { atomicWriteFile } from "../util/atomic-file.js";
import { sha256Hex } from "../util/hash.js";
import type { Scope } from "./scope.js";

export interface SetupPlanFile {
  path: string;
  /** Where the file is written, when the scope materialises it. */
  abs: string;
  action: "create" | "update-managed" | "keep-drifted" | "keep" | "remove-managed";
  reason: string;
}

export interface SetupPlan {
  files: SetupPlanFile[];
  configDiff?: string | undefined;
  warnings: string[];
}

export function managedHeader(version: string, checksum: string, title?: string): string {
  const suffix = title === undefined ? "" : ` title=${encodeURIComponent(title)}`;
  return `\n<!-- AGENT-TEAM-MANAGED version=${version} checksum=${checksum}${suffix} -->\n`;
}

export function checksumOf(content: string): string {
  return sha256Hex(content).slice(0, 16);
}

export interface ManagedMarker {
  version: string;
  checksum: string;
  title?: string;
}

export function isManaged(content: string): ManagedMarker | null {
  const m = content.match(/AGENT-TEAM-MANAGED version=([^\s]+) checksum=([^\s>]+)(?: title=([^\s>]+))?/);
  if (!m) return null;
  return { version: m[1] ?? "?", checksum: (m[2] ?? "?").replace(/-->$/, ""), title: decodeTitle(m[3]) };
}

/** The title a managed file was installed with, if any. */
export function managedTitle(content: string): string | undefined {
  return isManaged(content)?.title;
}

/**
 * A title reaches the marker percent-encoded, so the marker stays one line of
 * tokens. A marker written by hand may hold a sequence that is not valid
 * percent-encoding; that marker has no readable title, and saying so beats
 * throwing while a file is being inspected.
 */
function decodeTitle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export async function planManagedFiles(scope: Scope, templates: Map<string, string>, version: string): Promise<SetupPlanFile[]> {
  const files: SetupPlanFile[] = [];
  for (const [rel, template] of templates) {
    const abs = scope.resolve(rel);
    if (abs === null) continue;
    let existing: string | null = null;
    try {
      existing = await fs.promises.readFile(abs, "utf8");
    } catch {
      existing = null;
    }
    if (existing === null) {
      files.push({ path: rel, abs, action: "create", reason: "missing" });
      continue;
    }
    const meta = isManaged(existing);
    if (!meta) {
      files.push({ path: rel, abs, action: "keep-drifted", reason: "not managed; user content preserved" });
      continue;
    }
    const body = stripHeader(existing);
    const templateBody = stripHeader(template);
    if (body === templateBody) {
      if (meta.checksum === checksumOf(body)) files.push({ path: rel, abs, action: "keep", reason: "up to date" });
      else files.push({ path: rel, abs, action: "update-managed", reason: `repair header v${meta.version}` });
      continue;
    }
    if (meta.checksum === checksumOf(body)) {
      // Intact managed file; the template evolved.
      files.push({ path: rel, abs, action: "update-managed", reason: `update v${meta.version} -> v${version}` });
      continue;
    }
    // Content matches neither the recorded checksum nor the template: user drift.
    files.push({ path: rel, abs, action: "keep-drifted", reason: `managed file drifted (v${meta.version})` });
  }
  return files;
}

export function stripHeader(content: string): string {
  // Managed marker is a trailing HTML comment on its own line; frontmatter must stay at byte 0.
  // Legacy leading markers are also stripped for migration.
  return content.replace(/<!-- AGENT-TEAM-MANAGED[^>]*-->\n?$/, "").replace(/^<!-- AGENT-TEAM-MANAGED[^>]*-->\n?/, "");
}

export function withHeader(template: string, version: string, title?: string): string {
  let body = stripHeader(template);
  if (!body.endsWith("\n")) body += "\n";
  return body + managedHeader(version, checksumOf(body), title).slice(1);
}

/**
 * The configuration file, parsed.
 *
 * A file the setup cannot read stops the run: the decision resolution needs
 * the default agent it records, and a question whose answer cannot be acted
 * on is worse than an error.
 */
export async function readConfigFile(configFile: string): Promise<Record<string, unknown>> {
  let before = "";
  try {
    before = await fs.promises.readFile(configFile, "utf8");
  } catch {
    return {};
  }
  const errors: unknown[] = [];
  const parsed = before.trim().length === 0 ? {} : (parse(before, errors as never, { allowTrailingComma: true }) as Record<string, unknown>);
  if (errors.length > 0) {
    throw new Error(`${configFile} has parse errors: ${JSON.stringify(errors).slice(0, 500)}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Safe JSONC merge: preserve comments/order, insert default_agent + plugin
 * options only when asked.
 *
 * The file is the one the scope selected, and `repin` says whether an
 * existing plugin entry may be rewritten to a pinned specification. The
 * global scope does not repin: an unpinned entry means "track the latest
 * release", and pinning it during an installation would freeze the user's
 * plugin at whatever version the installation happened to carry.
 */
export async function mergeConfig(input: {
  configFile: string;
  setDefault: boolean;
  pluginPackage: string;
  pluginOptions: Record<string, unknown>;
  includePluginOptions: boolean;
  repin: boolean;
}): Promise<{ path: string; before: string; after: string; changed: boolean }> {
  const configPath = input.configFile;
  let before = "";
  try {
    before = await fs.promises.readFile(configPath, "utf8");
  } catch {
    before = "";
  }
  const parsed = await readConfigFile(configPath);
  let after = before.trim().length === 0 ? "{\n}\n" : before;
  if (input.setDefault && (parsed as Record<string, unknown>)["default_agent"] !== "team-leader") {
    after = applyJsoncEdit(after, ["default_agent"], "team-leader");
  }
  if (input.includePluginOptions) {
    const plugins = (parsed as Record<string, unknown>)["plugins"];
    const packageName = packageNameOf(input.pluginPackage);
    const spec = input.repin ? input.pluginPackage : packageName;
    const entry = { package: spec, options: input.pluginOptions };
    const recorded = recordsPlugin(parsed, packageName);
    if (recorded) {
      // An entry for this package already exists, under either key. It is
      // left exactly as it is: two entries for the same package load two
      // copies of the plugin.
      if (Array.isArray(plugins)) {
        const idx = plugins.findIndex((p) => {
          const found = pluginSpecOf(p);
          return found !== undefined && samePlugin(found, packageName);
        });
        if (idx !== -1 && input.repin) {
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
    } else if (!Array.isArray(plugins)) {
      after = applyJsoncEdit(after, ["plugins"], [entry]);
    } else {
      after = applyJsoncEdit(after, ["plugins"], [...plugins, entry]);
    }
  }
  return { path: configPath, before, after, changed: after !== before };
}

/**
 * Whether the configuration already records this package, under the current
 * key or the deprecated one. The deprecated key is read in both shapes it
 * can take, so a configuration that still carries it does not gain a second
 * entry under the current key.
 */
function recordsPlugin(parsed: Record<string, unknown>, packageName: string): boolean {
  const specs: string[] = [];
  const current = parsed["plugins"];
  if (Array.isArray(current)) for (const p of current) pushSpec(specs, p);
  const deprecated = parsed["plugin"];
  if (Array.isArray(deprecated)) for (const p of deprecated) pushSpec(specs, p);
  else pushSpec(specs, deprecated);
  return specs.some((spec) => samePlugin(spec, packageName));
}

function pushSpec(specs: string[], entry: unknown): void {
  const spec = pluginSpecOf(entry);
  if (spec !== undefined) specs.push(spec);
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

export async function backupFile(backupDir: string, absPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, stamp, path.basename(absPath));
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
export async function planStaleManagedFiles(scope: Scope, candidates: readonly string[]): Promise<SetupPlanFile[]> {
  const out: SetupPlanFile[] = [];
  for (const rel of candidates) {
    const abs = scope.resolve(rel);
    // A candidate the scope does not hold is not in this scope: the global
    // scope has no project ledger readme, and no previous-version file there.
    if (abs === null) continue;
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
      out.push({ path: rel, abs, action: "remove-managed", reason: "installed by a previous version; the roster was replaced" });
    } else {
      out.push({ path: rel, abs, action: "keep-drifted", reason: "user edited a previous-version file; preserved" });
    }
  }
  return out;
}
