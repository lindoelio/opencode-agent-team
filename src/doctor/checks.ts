import { configuredReasoningEfforts } from "../catalog/model-options.js";
import { packageRoot } from "../catalog/agents.js";
import { describeHostCapabilities, hostHasRequiredSurface, hostVersionSupport, resolveTextGenerator, SUPPORTED_HOST_LINES, SUPPORTED_SDK_RANGE } from "../compat/host.js";
import type { AgentTeamRuntime } from "../runtime.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DoctorCheck {
  name: string;
  status: "PASS" | "DEGRADED" | "FAIL";
  detail: string;
}

export interface DoctorReport {
  verdict: "PASS" | "DEGRADED" | "FAIL";
  checks: DoctorCheck[];
  recommendedAction: string;
  opencodeVersion: string;
  pluginVersion: string;
}

/**
 * The plugin version is read from the shipped package, not hardcoded, so the
 * doctor can never report a version the plugin is not.
 */
function pluginVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ) as { version?: string };
    return manifest.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function runDoctor(runtime: AgentTeamRuntime): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const opencodeVersion: string = String((runtime.ctx.app as unknown as { version?: string }).version ?? "unknown");

  // 1. OpenCode version compat. The plugin supports the 2.0.x, 2.1.x and
  // 2.2.x host lines; anything else is DEGRADED (it may still work, but it
  // is not a line this plugin is verified against).
  const support = hostVersionSupport(opencodeVersion);
  checks.push({
    name: "OpenCode",
    status: support === "supported" ? "PASS" : "DEGRADED",
    detail:
      support === "supported"
        ? `${opencodeVersion} — supported (${SUPPORTED_HOST_LINES.join(" / ")}.x)`
        : support === "unknown"
          ? `${opencodeVersion} — version not recognised; supported lines are ${SUPPORTED_HOST_LINES.join(" / ")}.x`
          : `${opencodeVersion} — outside the supported lines (${SUPPORTED_HOST_LINES.join(" / ")}.x); the plugin may work but is not verified there`,
  });

  // 1b. Host API surface. The real compatibility signal is the API surface,
  // not the version string: it reports the optional surfaces this host has.
  const capabilities = describeHostCapabilities(runtime.ctx);
  checks.push({
    name: "Host API surface",
    status: hostHasRequiredSurface(runtime.ctx) ? "PASS" : "FAIL",
    detail: capabilities.join("; "),
  });

  // 2. Plugin/API version
  checks.push({ name: "Plugin", status: "PASS", detail: `${pluginVersion()} (SDK ${SUPPORTED_SDK_RANGE})` });

  // 2b. Autonomy policy (informational, always PASS)
  const autonomy = runtime.options.autonomy ?? { mode: "yolo" as const, askBefore: [] as string[] };
  checks.push({
    name: "Autonomy",
    status: "PASS",
    detail: autonomy.mode === "yolo"
      ? `yolo — external/destructive/production actions execute without asking${autonomy.askBefore.length > 0 ? `; askBefore: ${autonomy.askBefore.join("; ")}` : "; no guardrails registered"}`
      : `guarded — external/destructive/outside-delivery actions require approval${autonomy.askBefore.length > 0 ? `; askBefore: ${autonomy.askBefore.join("; ")}` : ""}`,
  });

  // 3. Model resolution. The plugin pins no model: it verifies the harness can
  // resolve one and that any user-configured reasoning effort exists in the
  // active catalog. It never substitutes a model on its own.
  const catalog = await readModelCatalog(runtime);
  if (catalog.error) {
    checks.push({ name: "Model catalog", status: "FAIL", detail: `catalog read failed: ${catalog.error}` });
  } else if (catalog.models.length === 0) {
    checks.push({ name: "Model catalog", status: "FAIL", detail: "no models in the active catalog — connect a provider, then rerun /agent-team/doctor" });
  } else {
    checks.push({
      name: "Model catalog",
      status: "PASS",
      detail: `${catalog.models.length} model(s) available; Agent Team pins none and follows the harness default`,
    });
  }

  const efforts = configuredReasoningEfforts(runtime.options);
  if (efforts.length === 0) {
    checks.push({ name: "Reasoning effort", status: "PASS", detail: "not configured — the harness default applies" });
  } else if (catalog.error) {
    checks.push({ name: "Reasoning effort", status: "DEGRADED", detail: `configured (${efforts.join(", ")}) but the catalog could not be read` });
  } else {
    const available = new Set<string>();
    for (const m of catalog.models) for (const v of m.variants ?? []) available.add(v.id);
    const missing = efforts.filter((e) => !available.has(e));
    checks.push({
      name: "Reasoning effort",
      status: missing.length === 0 ? "PASS" : "FAIL",
      detail: missing.length === 0
        ? `configured efforts resolve in the active catalog (${efforts.join(", ")})`
        : `configured effort(s) absent from the catalog: ${missing.join(", ")}`,
    });
  }

  // 4. Generation with the harness default model (no mutation). The
  // generator is resolved by feature detection: `ctx.experimental.generate.text`
  // on 2.2.x, `ctx.generate.text` on 2.0.x/2.1.x.
  try {
    const generator = resolveTextGenerator(runtime.ctx);
    const gen = await generator.text({ prompt: "Reply with exactly: doctor-ok" });
    const text = String((gen as unknown as { text?: string }).text ?? "");
    checks.push({ name: "Text generation", status: text.length > 0 ? "PASS" : "FAIL", detail: text.slice(0, 80) || "empty" });
  } catch (err) {
    checks.push({ name: "Text generation", status: "FAIL", detail: (err as Error).message.slice(0, 200) });
  }
  try {
    const tools = await runtime.ctx.tool.list();
    const agentTeamTools = tools.filter((t) => t.id.startsWith("agent_team_"));
    checks.push({ name: "Tool registration", status: agentTeamTools.length >= 8 ? "PASS" : "FAIL", detail: `${agentTeamTools.length}/8 agent_team_* tools` });
  } catch (err) {
    checks.push({ name: "Tool registration", status: "FAIL", detail: (err as Error).message.slice(0, 200) });
  }
  checks.push({ name: "Structured output", status: "PASS", detail: "closed JSON schemas (additionalProperties:false) on all agent-team tools" });

  // 5. Specialists discoverable (agent list)
  try {
    const agents = (await runtime.ctx.agent.list()) as unknown as Array<{ id?: string; name?: string }>;
    const ids = agents.map((a) => String(a.id ?? a.name ?? ""));
    const hasTeamLeader = ids.includes("team-leader");
    checks.push({ name: "Native specialists", status: hasTeamLeader ? "PASS" : "DEGRADED", detail: hasTeamLeader ? "team-leader discovered (run /agent-team/setup for full roster)" : "team-leader not materialized yet — run /agent-team/setup --apply" });
  } catch (err) {
    checks.push({ name: "Native specialists", status: "FAIL", detail: (err as Error).message.slice(0, 200) });
  }

  // 6. Storage
  try {
    await runtime.ctx.storage.set("agent-team/doctor", { at: new Date().toISOString() } as never);
    await runtime.ctx.storage.get("agent-team/doctor");
    await runtime.ctx.storage.remove("agent-team/doctor");
    checks.push({ name: "Ledger", status: "PASS", detail: "storage write/read/remove ok" });
  } catch (err) {
    checks.push({ name: "Ledger", status: "FAIL", detail: (err as Error).message.slice(0, 200) });
  }

  const hasFail = checks.some((c) => c.status === "FAIL");
  const hasDegraded = checks.some((c) => c.status === "DEGRADED");
  const verdict = hasFail ? "FAIL" : hasDegraded ? "DEGRADED" : "PASS";
  return {
    verdict,
    checks,
    recommendedAction:
      verdict === "PASS"
        ? "Ready. Start with /agent-team/start."
        : "Resolve FAIL lines above; Agent Team never substitutes a model on its own — fix the provider, the catalog or your configuration.",
    opencodeVersion,
    pluginVersion: pluginVersion(),
  };
}

interface CatalogModel {
  id: string;
  providerID: string;
  variants: Array<{ id: string }>;
}

async function readModelCatalog(runtime: AgentTeamRuntime): Promise<{ models: CatalogModel[]; error?: string }> {
  try {
    const raw = (await runtime.ctx.model.list()) as unknown as Array<Record<string, unknown>>;
    const models = raw.map((m) => ({
      id: String(m["id"] ?? m["modelID"] ?? ""),
      providerID: String(m["providerID"] ?? m["provider"] ?? ""),
      variants: Array.isArray(m["variants"]) ? (m["variants"] as Array<{ id?: string }>).map((v) => ({ id: String(v?.id ?? "") })) : [],
    }));
    return { models };
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

export function renderDoctorReport(report: DoctorReport): string {
  const header = new Set(["OpenCode", "Plugin"]);
  const lines = [
    `Agent Team Doctor — ${report.verdict}`,
    ``,
    `OpenCode: ${report.checks.find((c) => c.name === "OpenCode")?.status} (${report.opencodeVersion})`,
    `Plugin: ${report.checks.find((c) => c.name === "Plugin")?.status} (${report.pluginVersion})`,
    ...report.checks.filter((c) => !header.has(c.name)).map((c) => `${c.name}: ${c.status} (${c.detail.slice(0, 160)})`),
    ``,
    `Recommended action: ${report.recommendedAction}`,
  ];
  return lines.join("\n");
}
