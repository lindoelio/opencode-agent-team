import { AGENT_TEAM_COMMANDS, parseCommandArgs } from "./commands.js";
import { packageVersion } from "./agents.js";
import { applySetupPlan } from "../bootstrap/apply.js";
import { buildSetupPlan, renderPlanText } from "../bootstrap/plan.js";
import { runDoctor, renderDoctorReport } from "../doctor/checks.js";
import { resolveDecisionGenerator } from "../compat/host.js";
import { decisionReport, renderDecisionListing, thresholdsLine } from "../decision/catalog.js";
import { decisionOptions } from "../options.js";
import { appendEvent, readState, storeContext } from "../ledger/store.js";
import { project } from "../ledger/projection.js";
import { projectRootOf, type AgentTeamRuntime } from "../runtime.js";

const PLUGIN_PACKAGE = `@lindoelio/opencode-agent-team@${packageVersion()}`;

async function sendSessionText(runtime: AgentTeamRuntime, sessionID: string, text: string): Promise<void> {
  await runtime.ctx.session.synthetic({ sessionID, text } as never);
}

export async function registerCommands(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const registration = await runtime.ctx.command.transform((editor: any) => {
    for (const cmd of AGENT_TEAM_COMMANDS) {
      editor.add({
        name: cmd.name,
        description: cmd.description,
        execute: async ({ sessionID, prompt }: any) => {
          const args = String((prompt as unknown as { text?: string }).text ?? "");
          // Lifecycle commands execute locally for determinism.
          if (cmd.name === "agent-team/setup") {
            const parsed = parseCommandArgs(stripCommandPrefix(args, "agent-team/setup"));
            const scope = parsed.get("scope") === "global" ? "global" : "project";
            const setDefault = parsed.flags.has("set-default") || (!parsed.flags.has("no-default") && scope === "project" && parsed.flags.has("apply"));
            const plan = await buildSetupPlan({
              scope,
              setDefault: parsed.flags.has("set-default"),
              updateOnly: parsed.flags.has("update"),
              projectRoot: projectRootOf(runtime.ctx),
              pluginPackage: PLUGIN_PACKAGE,
              pluginOptions: {
                profile: runtime.options.profile,
                strictEvidence: runtime.options.strictEvidence,
                projectState: runtime.options.projectState,
                telemetry: false,
              },
              includePluginOptions: true,
            });
            if (parsed.flags.has("apply")) {
              const result = await applySetupPlan({
                scope,
                setDefault: parsed.flags.has("set-default") ? true : setDefault,
                updateOnly: parsed.flags.has("update"),
                projectRoot: projectRootOf(runtime.ctx),
                pluginPackage: PLUGIN_PACKAGE,
                pluginOptions: {
                  profile: runtime.options.profile,
                  strictEvidence: runtime.options.strictEvidence,
                  projectState: runtime.options.projectState,
                  telemetry: false,
                },
                includePluginOptions: true,
              });
              await sendSessionText(runtime, sessionID, `Agent Team setup applied.\nCreated: ${result.created.join(", ") || "(none)"}\nUpdated: ${result.updated.join(", ") || "(none)"}\nRemoved (previous roster): ${result.removed.join(", ") || "(none)"}\nSkipped (user content): ${result.skipped.join(", ") || "(none)"}\nBackups: ${result.backups.length}\nConfig changed: ${result.configChanged}${result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : ""}\n\nReload OpenCode and run /agent-team/doctor.`);
              return;
            }
            await sendSessionText(runtime, sessionID, `${renderPlanText(plan)}\n\nDry run only. Re-run with --apply to write.`);
            return;
          }
          if (cmd.name === "agent-team/guard") {
            const parsed = parseCommandArgs(stripCommandPrefix(args, "agent-team/guard"));
            const root = projectRootOf(runtime.ctx);
            const state = await readState(root);
            if (!state) {
              await sendSessionText(runtime, sessionID, "Verdict: no engagement yet.\n\nNext: run /agent-team/start <outcome>, then /agent-team/guard to tune authorization.");
              return;
            }
            const add = parsed.get("add");
            const remove = parsed.get("remove");
            const mode = parsed.get("mode");
            const clear = parsed.flags.has("clear");
            if (mode !== undefined && mode !== "yolo" && mode !== "guarded") {
              await sendSessionText(runtime, sessionID, `Invalid --mode '${mode}': expected yolo or guarded. Nothing changed.`);
              return;
            }
            const hasChanges = add !== undefined || remove !== undefined || mode !== undefined || clear;
            const optAutonomy = runtime.options.autonomy ?? { mode: "yolo" as const, askBefore: [] as string[] };
            if (!hasChanges) {
              const effective = state.autonomyMode ?? optAutonomy.mode;
              const all = [...optAutonomy.askBefore, ...state.guardrails];
              await sendSessionText(runtime, sessionID, [
                `Autonomy: ${effective}${effective === "yolo" ? " (asks nothing by default)" : " (legacy ask-before-external behavior)"}`,
                `Guardrails: ${all.length > 0 ? all.map((g) => `"${g}"`).join(", ") : "(none)"}`,
                "",
                `Usage: /agent-team/guard --add "<pattern>" | --remove "<pattern>" | --clear | --mode yolo|guarded`,
                `Patterns match "<action> <resources>" case-insensitively (plain text or regex).`,
              ].join("\n"));
              return;
            }
            const next = await appendEvent(storeContext(root, sessionID, "plugin"), "guardrails.updated", { add, remove, mode, clear }, (s) => {
              let guardrails = [...s.guardrails];
              if (clear) guardrails = [];
              if (remove !== undefined) guardrails = guardrails.filter((g) => g !== remove);
              if (add !== undefined && !guardrails.includes(add)) guardrails = [...guardrails, add];
              return { ...s, guardrails, ...(mode ? { autonomyMode: mode } : {}) };
            });
            const effective = next.autonomyMode ?? optAutonomy.mode;
            await sendSessionText(runtime, sessionID, [
              `Autonomy: ${effective}`,
              `Guardrails: ${next.guardrails.length > 0 ? next.guardrails.map((g) => `"${g}"`).join(", ") : "(none)"}`,
              effective === "yolo" && next.guardrails.length === 0 ? "Agent Team asks nothing and executes autonomously." : "Matching actions now require explicit authorization.",
            ].join("\n"));
            return;
          }
          if (cmd.name === "agent-team/doctor") {
            const report = await runDoctor(runtime);
            await sendSessionText(runtime, sessionID, renderDoctorReport(report));
            return;
          }
          if (cmd.name === "agent-team/decisions") {
            const root = projectRootOf(runtime.ctx);
            const options = decisionOptions(runtime.options);
            const surface = resolveDecisionGenerator(runtime.ctx);
            const state = await readState(root);
            const judgementRows = state?.evidence.filter((e) => e.kind === "judgment").length ?? 0;
            const report = await decisionReport(runtime.ctx, root, surface.available, judgementRows);
            await sendSessionText(runtime, sessionID, renderDecisionListing(report, thresholdsLine("team-leader", options)));
            return;
          }
          if (cmd.name === "agent-team/status") {
            const state = await readState(projectRootOf(runtime.ctx));
            if (!state) {
              await sendSessionText(runtime, sessionID, "Verdict: no engagement yet.\n\nNext: run /agent-team/start <outcome>.");
              return;
            }
            const p = project(state);
            const autonomy = state.autonomyMode ?? runtime.options.autonomy?.mode ?? "yolo";
            const guards = [...(runtime.options.autonomy?.askBefore ?? []), ...state.guardrails];
            await sendSessionText(runtime, sessionID, `Verdict: ${state.engagement.phase} / ${state.engagement.status} — ${p.next_action}\n\nPhase: ${p.phase}\nGate: ${JSON.stringify(p.gate_status)}\nEvidence: ${state.evidence.length} records\nRisks: ${p.critical_risks.length} critical/high\nAutonomy: ${autonomy} (${guards.length} guardrails)`);
            return;
          }
          if (cmd.name === "agent-team/export") {
            await sendSessionText(runtime, sessionID, "Agent Team export: choose bundle (status | decision-log | evidence | delivery-readiness | retrospective). Files/fields preview + redaction applied before writing to .agent-team/exports/. Re-run with the bundle name as argument to generate.");
            return;
          }
          // Loop commands: structured prompt to agent-team in the current session.
          const body = cmd.prompt(stripCommandPrefix(args, cmd.name));
          await runtime.ctx.session.prompt({ sessionID, text: body } as never);
        },
      });
    }
  });
  return { dispose: () => registration.dispose() };
}

function stripCommandPrefix(args: string, name: string): string {
  const trimmed = args.trim();
  if (trimmed.startsWith("/")) {
    const without = trimmed.slice(1);
    if (without.startsWith(name)) return without.slice(name.length).trim();
  }
  if (trimmed.startsWith(name)) return trimmed.slice(name.length).trim();
  return trimmed;
}
