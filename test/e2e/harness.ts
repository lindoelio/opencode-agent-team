import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createProject, materializeRoster, readLedger, runOpenCode, type OpenCodeRun } from "../../bench/runners/opencode.js";

/**
 * Shared harness for the opt-in real-model E2E suite.
 *
 * Every test drives the real `opencode` CLI against a throwaway project wired
 * to this plugin, then asserts on the artifacts the run produced: the ledger,
 * the files on disk, and the trace of tools and subagents. Nothing here reads
 * the model's self-report as proof.
 */

export const E2E_ENABLED = process.env["AGENT_TEAM_E2E"] === "1";

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function openCodeAvailable(): boolean {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter);
  return dirs.some((d) => d.length > 0 && fs.existsSync(path.join(d, "opencode")));
}

/**
 * Skips the suite when the real-model CLI is not available.
 *
 * A missing CLI is an environmental condition, not a failure: the suite must
 * skip rather than fail, or it becomes impossible to run anywhere but on a
 * machine with a provider configured.
 */
export function requireOpenCode(): void {
  if (!openCodeAvailable()) throw new Error("the opencode CLI is not on PATH; the real-model E2E suite cannot run");
}

/** True when the suite can run at all. */
export const E2E_RUNNABLE = E2E_ENABLED && openCodeAvailable();

export interface Workspace {
  root: string;
  cleanup: () => Promise<void>;
}

export async function makeWorkspace(fixture: "sample-task-board" | "clean-project" = "sample-task-board", seed: Record<string, string> = {}): Promise<Workspace> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-e2e-"));
  const source = path.join(repoRoot(), "fixtures", fixture);
  await fs.promises.cp(source, root, { recursive: true });
  for (const [rel, content] of Object.entries(seed)) {
    await fs.promises.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.promises.writeFile(path.join(root, rel), content);
  }
  // The roster must exist before the run: the specialists are native agents
  // materialized by the setup, not something the plugin registers at runtime.
  await materializeRoster(root);
  // The config points at this checkout, not at the registry, so the run never
  // depends on the package being published.
  await createProject(root, repoRoot());
  return { root, cleanup: async () => { await fs.promises.rm(root, { recursive: true, force: true }); } };
}

export interface LedgerShape {
  schemaVersion: number;
  engagement: { phase: string; status: string };
  assumptions: Array<{ basis: string; statement: string }>;
  decisions: Array<{ id: string; options: unknown[] }>;
  activeDelivery?: {
    id: string;
    title: string;
    happyPath: string[];
    allowedScope: string[];
    prohibitedScope: string[];
    acceptanceCriteria: string[];
    validationSteps: string[];
    proof: Array<{ kind: string }>;
    rollback: string;
  };
  evidence: Array<{ id: string; criterionId: string; kind: string; status: string; command?: string; artifactRef?: string }>;
  gates: Array<{ gate: string; result: string; satisfied: string[]; missing: string[] }>;
  handoffs: Array<{ id: string; role: string; status: string; skills: string[]; dependsOn: string[] }>;
  approvals: Array<{ id: string; status: string }>;
  nextAction: { description: string; owner: string };
}

export function ledger(ws: Workspace): LedgerShape | null {
  const raw = readLedger(ws.root);
  return raw ? (raw as unknown as LedgerShape) : null;
}

export function readFile(ws: Workspace, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(ws.root, rel), "utf8");
  } catch {
    return null;
  }
}

export function fileExists(ws: Workspace, rel: string): boolean {
  return fs.existsSync(path.join(ws.root, rel));
}

export function subagentRoles(run: OpenCodeRun): string[] {
  return [...new Set(run.trace.subagents.map((s) => s.agent))];
}

export function agentTeamToolNames(run: OpenCodeRun): string[] {
  return run.trace.agentTeamTools;
}

export async function runAgent(ws: Workspace, agent: string, prompt: string, timeoutMs = 900_000): Promise<OpenCodeRun> {
  return await runOpenCode({ cwd: ws.root, agent, prompt, timeoutMs, model: process.env["AGENT_TEAM_E2E_MODEL"] });
}

export function finalText(run: OpenCodeRun): string {
  return run.trace.texts.join("\n");
}
