import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "../util/hash.js";

export interface TreeSnapshot {
  digest: string;
  files: Record<string, string>;
}

function normalise(scope: string): string {
  const trimmed = scope.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed;
}

/** The files a scope names, relative to the project root. */
function filesInScope(root: string, scope: string): string[] {
  const clean = normalise(scope);
  if (clean.length === 0) return [];
  const abs = path.resolve(root, clean);
  const contained = abs === root || abs.startsWith(`${root}${path.sep}`);
  if (!contained) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return [clean];
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(abs, clean);
  return out.sort();
}

/**
 * Hashes the bytes of every file the delivery's allowed scope names.
 *
 * It is deliberately the files, not the contract: a contract that did not
 * change does not prove the code did not change.
 */
export function snapshotScope(root: string, allowedScope: string[]): TreeSnapshot {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  for (const scope of allowedScope) {
    for (const rel of filesInScope(root, scope)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      try {
        files[rel] = sha256Hex(fs.readFileSync(path.join(root, rel)));
      } catch {
        // A file that disappeared between listing and reading is not evidence.
      }
    }
  }
  const digest = sha256Hex(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, d]) => `${p}:${d}`).join("\n"));
  return { digest, files };
}

/** Paths whose digest differs from the baseline, including added and removed. */
export function changedPaths(baseline: Record<string, string> | undefined, current: Record<string, string>): string[] {
  const base = baseline ?? {};
  const out = new Set<string>();
  for (const [p, d] of Object.entries(current)) if (base[p] !== d) out.add(p);
  for (const p of Object.keys(base)) if (current[p] === undefined) out.add(p);
  return [...out].sort();
}
