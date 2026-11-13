/**
 * Host compatibility for the OpenCode plugin SDK.
 *
 * The plugin requires OpenCode 2.2.0 or newer. Older hosts are refused rather
 * than degraded: the team runtime needs a child session, and a 2.1 host does
 * not expose the decision and instruction surfaces the loop is built on.
 *
 * A surface is still detected, never assumed from the version string. A host
 * that reports 2.2.0 but cannot create a session is refused at launch, and the
 * doctor names the missing surface.
 */

/** Host lines this plugin is verified against. */
export const SUPPORTED_HOST_LINES = ["2.2"] as const;

/** The minimum host version. */
export const MINIMUM_HOST_VERSION = "2.2.0" as const;

/** The npm range of `@opencode/plugin` this plugin supports. */
export const SUPPORTED_SDK_RANGE = ">=2.2.0 <2.3.0";

/** The sentence a too-old host receives. One sentence, one place. */
export const UPDATE_HOST_MESSAGE =
  "Agent Team requires OpenCode 2.2.0 or newer. Update OpenCode, restart it, and talk to the leader again.";

export type HostSupport = "supported" | "unsupported" | "unknown";

export interface HostVersionInfo {
  major: number | null;
  minor: number | null;
  patch: number | null;
  support: HostSupport;
}

/** Parses a `major.minor.patch` version, tolerating a leading `v` and a suffix. */
export function parseHostVersion(version: string): HostVersionInfo {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return { major: null, minor: null, patch: null, support: "unknown" };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return { major, minor, patch, support: atLeast(minor, patch, major) ? "supported" : "unsupported" };
}

function atLeast(minor: number, patch: number, major: number): boolean {
  if (major > 2) return true;
  if (major < 2) return false;
  if (minor > 2) return true;
  if (minor < 2) return false;
  return patch >= 0;
}

/** Classifies a host version against the supported floor. */
export function hostVersionSupport(version: string): HostSupport {
  return parseHostVersion(version).support;
}

/** True when the host is at least OpenCode 2.2.0. */
export function hostVersionAtLeast(version: string): boolean {
  return parseHostVersion(version).support === "supported";
}

export class UnsupportedHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedHostError";
  }
}

/** The text-generation surface, whichever host line provides it. */
export interface TextGenerator {
  text(input: unknown): Promise<unknown>;
}

interface GenerationSurface {
  experimental?: { generate?: { text?: (input: unknown) => Promise<unknown> } };
  generate?: { text?: (input: unknown) => Promise<unknown> };
}

/**
 * Resolves the host's text generator. `ctx.experimental.generate.text` is the
 * full API on 2.2.x; `ctx.generate.text` is the deprecated fallback and is
 * kept only so a 2.2 patch that still exposes it does not break the doctor.
 */
export function resolveTextGenerator(ctx: unknown): TextGenerator {
  const surface = (ctx ?? {}) as GenerationSurface;
  const experimental = surface.experimental?.generate;
  if (typeof experimental?.text === "function") {
    return { text: (input: unknown) => experimental.text!(input) };
  }
  const legacy = surface.generate;
  if (typeof legacy?.text === "function") {
    return { text: (input: unknown) => legacy.text!(input) };
  }
  throw new UnsupportedHostError(
    `this OpenCode host exposes no text-generation surface (neither ctx.experimental.generate.text nor ctx.generate.text). ${UPDATE_HOST_MESSAGE}`,
  );
}

/** The host's child-session surface, resolved by feature detection. */
export interface SessionLauncher {
  create(input: unknown): Promise<unknown>;
  prompt(input: unknown): Promise<unknown>;
  switchAgent?(input: unknown): Promise<unknown>;
  wait?(input: unknown): Promise<unknown>;
  /**
   * Hides a child session from the session list.
   *
   * The host stores an archive timestamp and the client leaves archived
   * sessions out of the thread list. The SDK typings on the oldest supported
   * line do not declare `archived` on `session.update`, so the call goes
   * through the host view and is best-effort: a host that does not accept it
   * keeps its sessions visible and nothing else changes.
   */
  archive?(sessionID: string): Promise<unknown>;
  /** Reads a session back, used to verify that the archive took effect. */
  get?(sessionID: string): Promise<unknown>;
}

export interface SessionSurface {
  available: boolean;
  launcher?: SessionLauncher;
}

export function resolveSessionLauncher(ctx: unknown): SessionSurface {
  const surface = (ctx ?? {}) as {
    session?: {
      create?: (input: unknown) => Promise<unknown>;
      prompt?: (input: unknown) => Promise<unknown>;
      switchAgent?: (input: unknown) => Promise<unknown>;
      wait?: (input: unknown) => Promise<unknown>;
      get?: (input: unknown) => Promise<unknown>;
      update?: (input: unknown) => Promise<unknown>;
    };
  };
  const create = surface.session?.create;
  const prompt = surface.session?.prompt;
  if (typeof create !== "function" || typeof prompt !== "function") return { available: false };
  return {
    available: true,
    launcher: {
      create: (input: unknown) => create(input),
      prompt: (input: unknown) => prompt(input),
      ...(typeof surface.session?.switchAgent === "function" ? { switchAgent: (input: unknown) => surface.session!.switchAgent!(input) } : {}),
      ...(typeof surface.session?.wait === "function" ? { wait: (input: unknown) => surface.session!.wait!(input) } : {}),
      ...(typeof surface.session?.get === "function" ? { get: (sessionID: string) => surface.session!.get!({ sessionID }) } : {}),
      ...(typeof surface.session?.update === "function"
        ? { archive: (sessionID: string) => surface.session!.update!({ sessionID, archived: true }) }
        : {}),
    },
  };
}

/** The host's shell surface, used to observe a check. Never a plugin process. */
export interface ShellSurface {
  available: boolean;
  run?: (input: unknown) => Promise<unknown>;
}

export function resolveShellSurface(ctx: unknown): ShellSurface {
  const surface = (ctx ?? {}) as {
    shell?: { run?: (input: unknown) => Promise<unknown> };
    session?: { shell?: (input: unknown) => Promise<unknown> };
  };
  if (typeof surface.session?.shell === "function") {
    return { available: true, run: (input: unknown) => surface.session!.shell!(input) };
  }
  if (typeof surface.shell?.run === "function") {
    return { available: true, run: (input: unknown) => surface.shell!.run!(input) };
  }
  return { available: false };
}

/**
 * The host's decision surface, resolved by feature detection.
 *
 * Only the 2.2.x line exposes it, and the older supported SDK lines do not
 * declare it at all, so it is read through an `unknown` view and narrowed
 * here rather than assumed to exist at compile time. A host without it is a
 * degraded capability, not a failure: the caller decides what to do.
 */
export interface DecisionGenerator {
  decisions(input: unknown): Promise<unknown>;
}

export interface DecisionSurface {
  available: boolean;
  generator?: DecisionGenerator;
}

export function resolveDecisionGenerator(ctx: unknown): DecisionSurface {
  const surface = (ctx ?? {}) as {
    experimental?: { generate?: { decisions?: (input: unknown) => Promise<unknown> } };
  };
  const decisions = surface.experimental?.generate?.decisions;
  if (typeof decisions !== "function") return { available: false };
  return { available: true, generator: { decisions: (input: unknown) => decisions(input) } };
}

/**
 * Reports the optional host surfaces that are present. Used by the doctor so
 * an operator sees the real host surface rather than a version number.
 */
export function describeHostCapabilities(ctx: unknown): string[] {
  const surface = (ctx ?? {}) as {
    experimental?: { generate?: { decisions?: unknown }; terminal?: unknown };
    credential?: unknown;
    permission?: { assert?: unknown };
    session?: { hook?: unknown; create?: unknown; shell?: unknown };
    tool?: { hook?: unknown };
    command?: { transform?: unknown };
    skill?: { transform?: unknown };
    storage?: unknown;
    model?: { list?: unknown };
    agent?: { list?: unknown };
  };
  const present: string[] = [];
  const absent: string[] = [];
  const probe = (label: string, value: unknown): void => {
    if (value === undefined || value === null) absent.push(label);
    else present.push(label);
  };
  probe("experimental.generate", surface.experimental?.generate);
  // The decision surface is reported but never required: a host without it
  // degrades the capability, and a missing required surface would fail the
  // preflight of a machine that adopted nothing.
  probe("experimental.generate.decisions", surface.experimental?.generate?.decisions);
  probe("credential", surface.credential);
  probe("permission.assert", surface.permission?.assert);
  probe("session.hook", surface.session?.hook);
  probe("session.create", surface.session?.create);
  probe("tool.hook", surface.tool?.hook);
  probe("command.transform", surface.command?.transform);
  probe("skill.transform", surface.skill?.transform);
  probe("storage", surface.storage);
  probe("model.list", surface.model?.list);
  probe("agent.list", surface.agent?.list);
  probe("session.shell", surface.session?.shell);
  const required = [
    "session.hook",
    "session.create",
    "tool.hook",
    "command.transform",
    "skill.transform",
    "storage",
    "model.list",
    "agent.list",
  ];
  const missingRequired = required.filter((r) => absent.includes(r));
  if (missingRequired.length > 0) {
    return [`MISSING REQUIRED: ${missingRequired.join(", ")}`, ...present.map((p) => `present: ${p}`)];
  }
  return present.map((p) => `present: ${p}`);
}

/** True when every surface the plugin requires is present on this host. */
export function hostHasRequiredSurface(ctx: unknown): boolean {
  return !describeHostCapabilities(ctx).some((line) => line.startsWith("MISSING REQUIRED"));
}
