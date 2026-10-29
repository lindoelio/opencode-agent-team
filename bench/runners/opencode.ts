import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Drives a real OpenCode run and captures what actually happened: the skills
 * that were loaded, the specialists that were spawned, the Agent Team tools
 * that were called, and the text that was produced.
 *
 * This is the observation layer of AgentTeamBench and of the opt-in E2E
 * suite. It talks to the `opencode` CLI, so it exercises the plugin the way
 * a user does: real hooks, real tools, real subagents.
 */
export interface RunTrace {
  skillsLoaded: string[];
  subagents: Array<{ agent: string; description: string; start?: number; end?: number }>;
  agentTeamTools: string[];
  toolCalls: string[];
  texts: string[];
  errors: string[];
  filesWritten: string[];
  /** Host permission prompts: the run stopped to ask the user. */
  permissionPrompts: number;
}

export interface OpenCodeRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  trace: RunTrace;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  agent: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const AGENT_TOOL_PREFIX = "tools.agent_team.";
const AGENT_TEAM_TOOL = "agent_team_";

/** Every run this module starts, so an interrupted suite leaves nothing behind. */
const LIVE_GROUPS = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function reapAll(signal: NodeJS.Signals): void {
  for (const pid of LIVE_GROUPS) killGroup(pid, signal);
  LIVE_GROUPS.clear();
}

let cleanupInstalled = false;
function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const onExit = (): void => reapAll("SIGKILL");
  process.on("exit", onExit);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      reapAll("SIGKILL");
      process.exit(1);
    });
  }
}

function emptyTrace(): RunTrace {
  return { skillsLoaded: [], subagents: [], agentTeamTools: [], toolCalls: [], texts: [], errors: [], filesWritten: [], permissionPrompts: 0 };
}

interface PartTime {
  start?: number;
  end?: number;
}

/**
 * Parses the JSON event stream a real run produced.
 *
 * Every measurement the bench makes comes from here: the tools that were
 * called, the specialists that were spawned and when, the files that were
 * written, and whether the run stopped to ask the user for permission.
 */
export function parseTrace(stdout: string): RunTrace {
  const trace = emptyTrace();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(event["type"] ?? "");
    if (type === "permission.asked") {
      // The run stopped to ask the user for authorization.
      trace.permissionPrompts += 1;
      continue;
    }
    if (type === "text") {
      const part = event["part"] as { text?: string } | undefined;
      if (part?.text) trace.texts.push(part.text);
      continue;
    }
    if (type !== "tool_use") continue;
    const part = event["part"] as
      | { tool?: string; state?: { input?: unknown; error?: unknown }; time?: PartTime }
      | undefined;
    const tool = part?.tool ?? "";
    const state = part?.state ?? {};
    const input = (state.input ?? {}) as Record<string, unknown>;
    const time = part?.time ?? {};
    trace.toolCalls.push(tool);
    if (state.error !== undefined && state.error !== null) trace.errors.push(String(state.error));
    // A registered plugin tool is named directly in the event, so the tool
    // name is the reliable signal. The `execute` code scan stays as a
    // fallback for hosts that only expose the code path.
    if (tool.startsWith(AGENT_TEAM_TOOL)) {
      const name = tool.slice(AGENT_TEAM_TOOL.length);
      if (name && !trace.agentTeamTools.includes(name)) trace.agentTeamTools.push(name);
    }
    if (tool === "skill") {
      const id = String(input["id"] ?? "");
      if (id && !trace.skillsLoaded.includes(id)) trace.skillsLoaded.push(id);
    }
    if (tool === "subagent") {
      trace.subagents.push({
        agent: String(input["agent"] ?? ""),
        description: String(input["description"] ?? ""),
        start: typeof time.start === "number" ? time.start : undefined,
        end: typeof time.end === "number" ? time.end : undefined,
      });
    }
    if (tool === "execute") {
      const code = String(input["code"] ?? "");
      for (const match of code.matchAll(/tools\.agent_team\.(\w+)\s*\(/g)) {
        const name = match[1]!;
        if (!trace.agentTeamTools.includes(name)) trace.agentTeamTools.push(name);
      }
      if (code.includes(AGENT_TOOL_PREFIX) && trace.agentTeamTools.length === 0) {
        trace.agentTeamTools.push("unknown");
      }
    }
    if (tool === "write" || tool === "edit" || tool === "patch") {
      const p = String(input["path"] ?? input["filePath"] ?? "");
      if (p) trace.filesWritten.push(p);
    }
  }
  return trace;
}

export async function runOpenCode(opts: RunOptions): Promise<OpenCodeRun> {
  const args = ["run", "--agent", opts.agent, "--format", "json"];
  if (opts.model) args.push("--model", opts.model);
  args.push(opts.prompt);
  // A case drives the whole operating loop — decisions, delegation, gates
  // and evidence — and the model iterates when a gate refuses. Fifteen
  // minutes was not enough to finish a delivery, so the default is raised
  // and stays overridable.
  const timeoutMs = opts.timeoutMs ?? 2_400_000;
  return await new Promise<OpenCodeRun>((resolve) => {
    // Two non-obvious requirements of the CLI:
    // - stdin must be closed, or it reads it and waits forever;
    // - the project is resolved from `PWD`, not from `cwd`, so a spawned
    //   process would otherwise resolve the agents of the caller's directory.
    const env = { ...process.env, ...opts.env, PWD: opts.cwd };
    // The run is its own process group: a specialist is a separate `opencode`
    // process, and a killed parent must never leave those children running.
    const child = spawn("opencode", args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    installCleanup();
    if (child.pid !== undefined) LIVE_GROUPS.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      const hard = setTimeout(() => killTree("SIGKILL"), 3000);
      hard.unref?.();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (child.pid !== undefined) LIVE_GROUPS.delete(child.pid);
      killTree("SIGKILL");
      resolve({ exitCode: code ?? -1, stdout, stderr, trace: parseTrace(stdout), timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (child.pid !== undefined) LIVE_GROUPS.delete(child.pid);
      killTree("SIGKILL");
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err), trace: emptyTrace(), timedOut });
    });
  });
}

/**
 * Points a project at this plugin and makes the team leader the default agent.
 *
 * The plugin options are written in the same shape the setup writes them, so
 * a bench run can turn the decision capability on without the plugin
 * inventing a second configuration path.
 */
export async function createProject(
  root: string,
  pluginPath: string,
  extra: Record<string, unknown> = {},
  pluginOptions?: Record<string, unknown>,
): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true });
  const plugin = pluginOptions && Object.keys(pluginOptions).length > 0 ? { package: pluginPath, options: pluginOptions } : pluginPath;
  await fs.promises.writeFile(
    path.join(root, "opencode.jsonc"),
    `{\n  "plugins": [${JSON.stringify(plugin)}],\n  "default_agent": "team-leader",\n  "experimental": { "subagent_depth": 2 }${Object.keys(extra).length ? `,\n  ${JSON.stringify(extra).slice(1, -1)}` : ""}\n}\n`,
  );
}

/**
 * Materializes the agent roster into a project, the same way
 * `/agent-team/setup --apply` does. Without it the specialists do not exist
 * and the run cannot address them.
 */
export async function materializeRoster(root: string): Promise<void> {
  const { applySetupPlan } = await import("../../src/bootstrap/apply.js");
  await applySetupPlan({
    scope: "project",
    setDefault: true,
    updateOnly: false,
    projectRoot: root,
    pluginPackage: "@lindoelio/opencode-agent-team",
    pluginOptions: { profile: "public", strictEvidence: true, projectState: ".agent-team", telemetry: false },
    includePluginOptions: true,
  });
}

/** Reads the project ledger after a run. Returns null when nothing was recorded. */
export function readLedger(root: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".agent-team", "state.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
