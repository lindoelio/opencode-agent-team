import { resolveShellSurface } from "../compat/host.js";
import type { AgentTeamRuntime } from "../runtime.js";

export interface ShellOutcome {
  exitCode: number;
  output: string;
}

interface Waiter {
  resolve: (outcome: ShellOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const results = new Map<string, ShellOutcome>();
const waiters = new Map<string, Waiter[]>();

function normalise(raw: unknown): ShellOutcome {
  const record = (raw ?? {}) as Record<string, unknown>;
  const exit = record["exitCode"] ?? record["exit_code"] ?? record["code"] ?? record["status"];
  const exitCode = typeof exit === "number" ? exit : Number.parseInt(String(exit ?? "1"), 10);
  const output = String(record["output"] ?? record["stdout"] ?? record["text"] ?? record["content"] ?? "");
  return { exitCode: Number.isFinite(exitCode) ? exitCode : 1, output };
}

/** Called from the event subscription when a host shell ends. */
export function recordShellEnded(sessionID: string, data: unknown): void {
  const outcome = normalise(data);
  results.set(sessionID, outcome);
  const list = waiters.get(sessionID) ?? [];
  for (const waiter of list) {
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }
  waiters.delete(sessionID);
}

function waitFor(sessionID: string, timeoutMs: number): Promise<ShellOutcome> {
  const existing = results.get(sessionID);
  if (existing) {
    results.delete(sessionID);
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.set(sessionID, (waiters.get(sessionID) ?? []).filter((w) => w.timer !== timer));
      resolve({ exitCode: 1, output: `the host shell did not report a result within ${timeoutMs}ms` });
    }, timeoutMs);
    waiters.set(sessionID, [...(waiters.get(sessionID) ?? []), { resolve, timer }]);
  });
}

/**
 * Runs one command through the host.
 *
 * The host's `session.shell` takes a session id and returns void on 2.2; the
 * exit code and output arrive in `session.shell.ended`. A synchronous result
 * is accepted too, which is what a test host provides.
 */
export async function runHostShell(
  runtime: AgentTeamRuntime,
  input: { sessionID: string; command: string; cwd?: string },
): Promise<ShellOutcome | undefined> {
  const surface = resolveShellSurface(runtime.ctx);
  if (!surface.available) return undefined;
  const raw = await surface.run!({ sessionID: input.sessionID, command: input.command, cwd: input.cwd });
  if (raw && typeof raw === "object") return normalise(raw);
  return waitFor(input.sessionID, 120_000);
}

export function _resetShellResultsForTests(): void {
  results.clear();
  for (const list of waiters.values()) for (const waiter of list) clearTimeout(waiter.timer);
  waiters.clear();
}
