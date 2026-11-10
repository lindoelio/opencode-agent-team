/**
 * The commands the operator can run directly.
 *
 * The phase loop is leader behavior, not a slash-command menu: a person states
 * an outcome and talks to the leader. These three remain because a broken
 * model must not be the only way to install the roster, read the preflight, or
 * record a guardrail.
 */
export interface AgentTeamCommand {
  name: string;
  description: string;
  prompt: (args: string) => string;
}

function p(text: string): (args: string) => string {
  return (args: string) => (args.trim().length > 0 ? `${text}\n\nArguments: ${args}` : text);
}

export const AGENT_TEAM_COMMANDS: AgentTeamCommand[] = [
  {
    name: "agent-team/setup",
    description: "Plan/apply/update the agent roster and the OpenCode configuration",
    prompt: p(`You are Agent Team setup. Modes: --plan (default, no writes) shows the file and configuration diffs; --apply writes immediately; --scope project (default .opencode/agents/ and opencode.jsonc) or global (~/.config/opencode/agents/ and the global configuration file, opencode.json or the opencode.jsonc already in that directory, following XDG_CONFIG_HOME when it is set); --set-default records default_agent team-leader; --no-default leaves the recorded default agent alone; --leader-title "..." names the team leader in the agent picker, replacing the shipped label in its description; --update refreshes only the files already installed and managed, and does not create the ones a newer version introduced. A decision the setup cannot settle from the flags is put to the user: in the global scope it asks whether the team leader becomes the default agent and what it is called, and it writes nothing until the answer comes back as a flag. Files installed by a previous version of the plugin (the old agent-team roster) are removed on apply so the project never keeps two rosters; a file the user edited is preserved and reported as skipped. The plugin pins no model: agents inherit the OpenCode harness default unless the user configures model: in the configuration file or edits an agent file. Preserve comments/order/keys in the configuration file; back up to <project>/.agent-team/setup-backups/<ts>/ in a project and to <globalConfigDir>/.agent-team/setup-backups/<ts>/ in the global scope; validate JSONC; evidence with opencode debug config + debug agents output.`),
  },
  {
    name: "agent-team/doctor",
    description: "Verify OpenCode, plugin, model, variants, permissions, storage",
    prompt: p(`You are Agent Team doctor. Verify: OpenCode version compat (2.2.0 or newer), plugin/API version, the team runtime (session.create), a model resolvable from the active catalog (the plugin pins none), configured reasoning efforts present in the catalog, simple text generation on the harness default model, mutation-free tool call, structured output, reasoning at the configured effort, child agent invocation, storage write/read/remove in a diagnostic namespace. No destructive shell or external write from the doctor itself. Report PASS|DEGRADED|FAIL per line plus one recommended action.`),
  },
  {
    name: "agent-team/guard",
    description: "Show or edit autonomy guardrails (the only source of authorization prompts)",
    prompt: p(`You are Agent Team guard. Report effective mode and guardrails, then apply --add/--remove/--clear/--mode via agent_team_state guard. Guardrails are the only reason Agent Team asks before an action; without them execution is autonomous. Promotion (push, tag, publish, deploy) is denied unless --allow-promotion is recorded. --no-promotion removes that authorization.`),
  },
];

export function parseCommandArgs(raw: string): { flags: Set<string>; positional: string[]; get: (name: string) => string | undefined } {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const flags = new Set<string>();
  const positional: string[] = [];
  const values = new Map<string, string>();
  const valueTaking = new Set(["scope", "accept", "add", "remove", "mode", "leader-title"]);
  for (let i = 0; i < tokens.length; i++) {
    const t = (tokens[i] ?? "").trim();
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        const k = t.slice(2, eq);
        values.set(k, t.slice(eq + 1).replace(/^["']|["']$/g, ""));
        flags.add(k);
      } else {
        const k = t.slice(2);
        const next = tokens[i + 1];
        if (next && !next.startsWith("--") && valueTaking.has(k)) {
          values.set(k, next.replace(/^["']|["']$/g, ""));
          flags.add(k);
          i++;
        } else {
          flags.add(k);
        }
      }
    } else if (t.length > 0) {
      positional.push(t.replace(/^["']|["']$/g, ""));
    }
  }
  return { flags, positional, get: (name: string) => values.get(name) };
}
