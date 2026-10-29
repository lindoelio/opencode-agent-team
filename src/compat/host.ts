/**
 * Host compatibility for the OpenCode plugin SDK.
 *
 * The plugin supports the 2.0.x, 2.1.x and 2.2.x lines of the OpenCode host.
 * Two things change across those lines and both are handled here:
 *
 * 1. The generation API moved. `ctx.generate` is the full `GenerateApi` on
 *    2.0.x/2.1.x and a deprecated `Pick<GenerateApi, "text">` on 2.2.x, where
 *    `ctx.experimental.generate` is the full API. The plugin resolves the
 *    generator by feature detection rather than by version number, so it is
 *    correct on every supported line and survives the next rename.
 *
 * 2. New optional surfaces appear (`ctx.credential` on 2.1.x,
 *    `ctx.permission.assert` and `ctx.experimental.generate` on 2.2.x). The
 *    plugin does not depend on them; the doctor reports them so an operator
 *    can see which host they are actually running.
 */

/** Host lines this plugin is verified against. */
export const SUPPORTED_HOST_LINES = ["2.0", "2.1", "2.2"] as const;

/** The npm range of `@opencode/plugin` this plugin supports. */
export const SUPPORTED_SDK_RANGE = ">=2.0.10 <2.3.0";

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
  const line = `${major}.${minor}`;
  const supported = (SUPPORTED_HOST_LINES as readonly string[]).includes(line);
  return { major, minor, patch, support: supported ? "supported" : "unsupported" };
}

/** Classifies a host version against the supported lines. */
export function hostVersionSupport(version: string): HostSupport {
  return parseHostVersion(version).support;
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
 * Resolves the host's text generator. `ctx.experimental.generate.text` is
 * preferred (2.2.x); `ctx.generate.text` is the fallback for 2.0.x and
 * 2.1.x, and is still present but deprecated on 2.2.x.
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
    "this OpenCode host exposes no text-generation surface (neither ctx.experimental.generate.text nor ctx.generate.text); Agent Team requires OpenCode 2.0.x, 2.1.x or 2.2.x",
  );
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
    session?: { hook?: unknown };
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
  probe("tool.hook", surface.tool?.hook);
  probe("command.transform", surface.command?.transform);
  probe("skill.transform", surface.skill?.transform);
  probe("storage", surface.storage);
  probe("model.list", surface.model?.list);
  probe("agent.list", surface.agent?.list);
  const required = ["session.hook", "tool.hook", "command.transform", "skill.transform", "storage", "model.list", "agent.list"];
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
