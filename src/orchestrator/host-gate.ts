import { hostVersionAtLeast, resolveSessionLauncher, UPDATE_HOST_MESSAGE } from "../compat/host.js";
import type { AgentTeamRuntime } from "../runtime.js";

/** Hosts already told about the floor in this server process. */
const noticed = new Set<string>();

export interface HostGate {
  versionSupported: boolean;
  sessionAvailable: boolean;
  version: string;
}

export function hostGate(runtime: AgentTeamRuntime): HostGate {
  const app = (runtime.ctx as unknown as { app?: { version?: string } }).app;
  const version = String(app?.version ?? "unknown");
  return {
    version,
    versionSupported: hostVersionAtLeast(version),
    sessionAvailable: resolveSessionLauncher(runtime.ctx).available,
  };
}

/** Every mutating team tool calls this. An old host is refused, not degraded. */
export function assertSupportedHost(runtime: AgentTeamRuntime): void {
  if (!hostGate(runtime).versionSupported) throw new Error(UPDATE_HOST_MESSAGE);
}

/**
 * A launch needs a child session. A host that reports 2.2 but cannot create
 * one is refused; Agent Team does not return a prompt packet instead.
 */
export function assertTeamRuntime(runtime: AgentTeamRuntime): void {
  assertSupportedHost(runtime);
  if (!hostGate(runtime).sessionAvailable) {
    throw new Error(
      "Agent Team cannot launch a specialist: this host does not expose session.create. Update OpenCode to 2.2.0 or newer; there is no prompt-packet fallback.",
    );
  }
}

/** True the first time this session is told the host is too old. */
export function shouldNoticeOldHost(runtime: AgentTeamRuntime, sessionID: string): boolean {
  if (hostGate(runtime).versionSupported) return false;
  if (noticed.has(sessionID)) return false;
  noticed.add(sessionID);
  return true;
}

export function _resetHostNoticesForTests(): void {
  noticed.clear();
}
