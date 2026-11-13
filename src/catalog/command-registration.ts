import { AGENT_TEAM_COMMANDS, parseCommandArgs } from "./commands.js";
import { loadTemplates, packageVersion } from "./agents.js";
import { applySetupPlan } from "../bootstrap/apply.js";
import { buildSetupPlan, renderPlanText } from "../bootstrap/plan.js";
import { resolveDecisions, type PendingDecision } from "../bootstrap/decisions.js";
import { readConfigFile } from "../bootstrap/jsonc.js";
import { resolveScope, type Scope } from "../bootstrap/scope.js";
import { LEADER_REL, inspectLeaderFile, isValidLeaderTitle } from "../bootstrap/templates.js";
import { runDoctor, renderDoctorReport } from "../doctor/checks.js";
import { defaultAgentTeamOptions } from "../options.js";
import { appendEvent, readState, storeContext } from "../ledger/store.js";
import { projectRootOf, type AgentTeamRuntime } from "../runtime.js";

const PLUGIN_PACKAGE = `@lindoelio/opencode-agent-team@${packageVersion()}`;

async function sendSessionText(runtime: AgentTeamRuntime, sessionID: string, text: string): Promise<void> {
  await runtime.ctx.session.synthetic({ sessionID, text } as never);
}

/**
 * The question the setup puts to the user.
 *
 * The plugin has no interactive question surface, so the question travels
 * through the agent already in the session: it asks with the question tool
 * and re-runs the setup with the answer as an explicit flag.
 *
 * The re-run command carries every flag the invocation already had, so a
 * decision the user already settled is not asked a second time. Only the
 * global scope ever asks.
 */
function askForDecisions(scope: Scope, pending: PendingDecision[], flags: Set<string>, leaderTitle: string | undefined): string {
  const questions: string[] = [];
  const template: string[] = [];
  const leaderPath = scope.resolve(LEADER_REL) ?? "the leader agent file";
  if (pending.includes("setDefault")) {
    questions.push(
      `Question 1 — default agent: set "default_agent": "team-leader" in ${scope.configFile}, so every project opens with the Agent Team leader? (yes / no)`,
    );
  }
  if (pending.includes("leaderTitle")) {
    questions.push(
      `Question 2 — leader title: what should the team leader be called in OpenCode? The title lands in ${leaderPath} and is shown beside "team-leader" in the agent picker. Default: "Team Leader".`,
    );
  }
  if (flags.has("set-default")) template.push("--set-default");
  else if (flags.has("no-default")) template.push("--no-default");
  else if (pending.includes("setDefault")) template.push("--set-default|--no-default");
  if (leaderTitle !== undefined) template.push(`--leader-title "${leaderTitle}"`);
  else if (pending.includes("leaderTitle")) template.push('--leader-title "<the answer>"');
  return [
    "Ask the user with the question tool, then re-run the setup with the answers as explicit flags. Do not guess an answer.",
    "",
    ...questions,
    "",
    "Then run the command below, with <the answer> replaced by what the user said and with either --set-default or --no-default kept:",
    `/agent-team/setup --apply --scope global ${template.join(" ")}`.trim(),
  ].join("\n");
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
            const kind = parsed.get("scope") === "global" ? ("global" as const) : ("project" as const);
            const apply = parsed.flags.has("apply");
            const updateOnly = parsed.flags.has("update");
            const projectRoot = projectRootOf(runtime.ctx);
            const scope = resolveScope({ kind, projectRoot, env: process.env });
            const globalScope = kind === "global" ? scope : resolveScope({ kind: "global", projectRoot, env: process.env });

            // The configuration file is parsed before anything is decided: a
            // file the setup cannot read stops the run, and the question is
            // never asked about a decision the answer cannot act on.
            let recordedDefaultAgent: string | undefined;
            try {
              const config = await readConfigFile(scope.configFile);
              const recorded = config["default_agent"];
              recordedDefaultAgent = recorded === undefined ? undefined : String(recorded);
            } catch (err) {
              await sendSessionText(runtime, sessionID, `Agent Team setup stopped: ${(err as Error).message}`);
              return;
            }

            const leaderPath = scope.resolve(LEADER_REL);
            const leader = leaderPath === null ? { exists: false, writable: true } : await inspectLeaderFile(leaderPath);
            const globalLeaderPath = globalScope.resolve(LEADER_REL);
            const globalLeader = globalLeaderPath === null ? { exists: false, writable: true } : await inspectLeaderFile(globalLeaderPath);

            // A title that would change how the agent file is read stops the
            // run before anything is written.
            const title = parsed.get("leader-title");
            if (title !== undefined) {
              const templates = await loadTemplates();
              const leaderTemplate = templates.get(LEADER_REL) ?? "";
              if (!isValidLeaderTitle(leaderTemplate, title)) {
                await sendSessionText(
                  runtime,
                  sessionID,
                  "Agent Team setup stopped: the leader title is not valid. It must be a single line, hold no colon, no space before a hash, and not begin with a YAML indicator character.",
                );
                return;
              }
            }

            const { decisions, pending } = resolveDecisions({
              kind,
              updateOnly,
              flags: parsed.flags,
              leaderTitle: title,
              recordedDefaultAgent,
              recordedTitle: leader.title,
              globalRecordedTitle: globalLeader.title,
              leaderFileWritable: leader.writable,
            });

            const options = {
              scope,
              decisions,
              pending,
              updateOnly,
              pluginPackage: PLUGIN_PACKAGE,
              // The global scope records the plugin's own defaults: a project
              // that configures the plugin must not export its settings to
              // every project on the machine.
              pluginOptions:
                scope.kind === "global"
                  ? defaultAgentTeamOptions()
                  : {
                      profile: runtime.options.profile,
                      projectState: runtime.options.projectState,
                      telemetry: false,
                    },
              includePluginOptions: true,
            };

            if (pending.length > 0 && apply) {
              // The plugin has no interactive question surface, so the
              // question reaches the user through the agent already in the
              // session.
              await runtime.ctx.session.prompt({ sessionID, text: askForDecisions(scope, pending, parsed.flags, title) } as never);
              return;
            }
            if (!apply) {
              const plan = await buildSetupPlan(options);
              await sendSessionText(runtime, sessionID, `${renderPlanText(plan)}\n\nDry run only. Re-run with --apply to write.`);
              return;
            }
            const result = await applySetupPlan(options);
            await sendSessionText(runtime, sessionID, `Agent Team setup applied.\nCreated: ${result.created.join(", ") || "(none)"}\nUpdated: ${result.updated.join(", ") || "(none)"}\nRemoved (previous roster): ${result.removed.join(", ") || "(none)"}\nSkipped (user content): ${result.skipped.join(", ") || "(none)"}\nNot materialised in this scope: ${result.notMaterialised.join(", ") || "(none)"}\nBackups: ${result.backups.length}\nConfig changed: ${result.configChanged}${result.warnings.length > 0 ? `\nWarnings: ${result.warnings.join("; ")}` : ""}\n\nReload OpenCode and run /agent-team/doctor.`);
            return;
          }
          if (cmd.name === "agent-team/guard") {
            const parsed = parseCommandArgs(stripCommandPrefix(args, "agent-team/guard"));
            const root = projectRootOf(runtime.ctx);
            const state = await readState(root);
            if (!state) {
              await sendSessionText(runtime, sessionID, "Verdict: no engagement yet.\n\nTell the leader the outcome you want. Guardrails can be recorded once the engagement exists.");
              return;
            }
            const add = parsed.get("add");
            const remove = parsed.get("remove");
            const mode = parsed.get("mode");
            const clear = parsed.flags.has("clear");
            const allowPromotion = parsed.flags.has("allow-promotion") ? true : parsed.flags.has("no-promotion") ? false : undefined;
            if (mode !== undefined && mode !== "yolo" && mode !== "guarded") {
              await sendSessionText(runtime, sessionID, `Invalid --mode '${mode}': expected yolo or guarded. Nothing changed.`);
              return;
            }
            const hasChanges = add !== undefined || remove !== undefined || mode !== undefined || clear || allowPromotion !== undefined;
            const optAutonomy = runtime.options.autonomy ?? { mode: "yolo" as const, askBefore: [] as string[], allowPromotion: false };
            if (!hasChanges) {
              const effective = state.autonomyMode ?? optAutonomy.mode;
              const all = [...optAutonomy.askBefore, ...state.guardrails];
              const promotion = state.allowPromotion === true || optAutonomy.allowPromotion === true;
              await sendSessionText(runtime, sessionID, [
                `Autonomy: ${effective}${effective === "yolo" ? " (asks nothing by default)" : " (legacy ask-before-external behavior)"}`,
                `Guardrails: ${all.length > 0 ? all.map((g) => `"${g}"`).join(", ") : "(none)"}`,
                `Promotion: ${promotion ? "authorized" : "denied until --allow-promotion is recorded"}`,
                "",
                `Usage: /agent-team/guard --add "<pattern>" | --remove "<pattern>" | --clear | --mode yolo|guarded | --allow-promotion | --no-promotion`,
                `Patterns match "<action> <resources>" case-insensitively (plain text or regex).`,
              ].join("\n"));
              return;
            }
            const next = await appendEvent(storeContext(root, sessionID, "plugin"), "guardrails.updated", { add, remove, mode, clear, allowPromotion }, (s) => {
              let guardrails = [...s.guardrails];
              if (clear) guardrails = [];
              if (remove !== undefined) guardrails = guardrails.filter((g) => g !== remove);
              if (add !== undefined && !guardrails.includes(add)) guardrails = [...guardrails, add];
              return {
                ...s,
                guardrails,
                ...(mode ? { autonomyMode: mode } : {}),
                ...(allowPromotion !== undefined ? { allowPromotion } : {}),
              };
            });
            const effective = next.autonomyMode ?? optAutonomy.mode;
            const promotion = next.allowPromotion === true || optAutonomy.allowPromotion === true;
            await sendSessionText(runtime, sessionID, [
              `Autonomy: ${effective}`,
              `Guardrails: ${next.guardrails.length > 0 ? next.guardrails.map((g) => `"${g}"`).join(", ") : "(none)"}`,
              `Promotion: ${promotion ? "authorized" : "denied"}`,
              effective === "yolo" && next.guardrails.length === 0 ? "Agent Team asks nothing and executes autonomously." : "Matching actions now require explicit authorization.",
            ].join("\n"));
            return;
          }
          if (cmd.name === "agent-team/doctor") {
            const report = await runDoctor(runtime);
            await sendSessionText(runtime, sessionID, renderDoctorReport(report));
            return;
          }
          // Every registered command executes locally. A command that only
          // re-entered the session with a prompt was part of the phase menu
          // this change removed.
          await sendSessionText(runtime, sessionID, `Unknown Agent Team command: ${cmd.name}`);
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
