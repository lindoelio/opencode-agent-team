import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Which installation a setup run writes. */
export type ScopeKind = "project" | "global";

/**
 * Where one installation writes.
 *
 * The scope is the single answer to that question. The plan and the apply
 * both take it, so they cannot resolve the same file to two different
 * places.
 */
export interface Scope {
  readonly kind: ScopeKind;
  readonly root: string;
  /** The configuration directory this scope writes into. */
  readonly configDir: string;
  /** The global configuration directory, whichever scope is running. */
  readonly globalConfigDir: string;
  readonly agentsDir: string;
  readonly configFile: string;
  readonly backupDir: string;
  /** The absolute path of a managed template, or nothing when this scope does not materialise it. */
  resolve(rel: string): string | null;
}

export interface ScopeOptions {
  kind: ScopeKind;
  projectRoot: string;
  /** The global configuration directory to use instead of the host's own convention. */
  injectedConfigDir?: string;
  /** The environment the configuration home is read from. */
  env: NodeJS.ProcessEnv;
}

const AGENTS_PREFIX = ".opencode/agents/";
const LEDGER_README = ".agent-team/README.md";

/**
 * The global configuration directory, by the host's own convention.
 *
 * `XDG_CONFIG_HOME` names a configuration home, so the directory is its
 * `opencode` subdirectory. Without it, the home directory's `.config`.
 */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"]?.trim() || os.homedir();
  const xdg = env["XDG_CONFIG_HOME"]?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(home, ".config");
  return path.join(base, "opencode");
}

/**
 * The configuration file the global scope writes.
 *
 * The host reads both names in a directory as separate documents and resolves
 * the JSON-with-comments one last, so that is the one to write when both
 * exist. With neither, the JSON one is created.
 */
function globalConfigFile(configDir: string): string {
  const jsonc = path.join(configDir, "opencode.jsonc");
  if (fs.existsSync(jsonc)) return jsonc;
  return path.join(configDir, "opencode.json");
}

export function resolveScope(opts: ScopeOptions): Scope {
  const env = opts.env;
  const globalDir = opts.injectedConfigDir ?? globalConfigDir(env);
  const isProject = opts.kind === "project";
  const root = isProject ? opts.projectRoot : env["HOME"]?.trim() || os.homedir();
  const configDir = isProject ? path.join(opts.projectRoot, ".opencode") : globalDir;
  const agentsDir = path.join(configDir, "agents");
  const configFile = isProject ? path.join(opts.projectRoot, "opencode.jsonc") : globalConfigFile(globalDir);
  const backupDir = isProject
    ? path.join(opts.projectRoot, ".agent-team", "setup-backups")
    : path.join(globalDir, ".agent-team", "setup-backups");

  function resolve(rel: string): string | null {
    if (rel.startsWith(AGENTS_PREFIX)) return path.join(agentsDir, rel.slice(AGENTS_PREFIX.length));
    // The ledger readme describes a project's ledger. The global scope does
    // not write one, so the template has no path there.
    if (rel === LEDGER_README) return isProject ? path.join(root, ".agent-team", "README.md") : null;
    return null;
  }

  return { kind: opts.kind, root, configDir, globalConfigDir: globalDir, agentsDir, configFile, backupDir, resolve };
}
