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
    name: "agent-team/start",
    description: "Start or resume an engagement (INTENT)",
    prompt: p(`You are Team Leader. Execute /agent-team/start: run a light doctor, detect existing .agent-team state, initialize the engagement if missing (agent_team_state initialize with outcome/actors/constraints/nonGoals/acceptance), extract outcome/actors/constraints/non-goals/acceptance/unknowns, ask only materially outcome-changing questions about intent (never for authorization), record safe assumptions, and return one provisional thesis sentence plus the next action. Verdict-first, evidence-linked.`),
  },
  {
    name: "agent-team/discover",
    description: "Investigate project, system, or domain (DISCOVER)",
    prompt: p(`You are Team Leader. Execute /agent-team/discover: delegate discovery to team-leader/explorer by default via agent_team_handoff (parallel explorers for independent areas, within the parallel budget the tool enforces), prefer CLI/API/direct source over UI, classify each conclusion VERIFIED/USER_STATED/OBSERVED_PATTERN/INFERENCE/PROPOSAL/UNKNOWN, do not edit product code, close with Observed/Inferred/Unknown/Impact.`),
  },
  {
    name: "agent-team/thesis",
    description: "Produce or refine the Product Thesis (FRAME)",
    prompt: p(`You are Team Leader. Execute /agent-team/thesis: delegate to team-leader/product by default. Format: For <actor> who <problem/context>, Team Leader proposes <product/capability> that delivers <observable outcome>. Unlike <alternative>, it wins through <differentiator>, and will be considered valid when <evidence>. Include non-goals, riskiest assumptions, first proof. Version the thesis in state.`),
  },
  {
    name: "agent-team/decide",
    description: "Make an explicit decision with a Decision Record (DECIDE)",
    prompt: p(`You are Team Leader. Execute /agent-team/decide: record the assumptions behind the choice first (agent_team_record_assumption) — agent_team_record_decision refuses a decision whose evidenceRefs cite no existing assumption or evidence id. Then capture drivers, compare 2-4 viable options in a trade-off matrix, recommend one with reversibility and blast radius, list evidence/unknowns, persist via agent_team_record_decision citing the assumption ids. Delegate the option analysis to team-leader/architect. With --critical, run the architect and security lenses in parallel via agent_team_handoff plus a second pass at the highest configured reasoning effort when preflight allows.`),
  },
  {
    name: "agent-team/plan",
    description: "Define the smallest end-to-end delivery (PLAN)",
    prompt: p(`You are Team Leader. Execute /agent-team/plan: produce exactly one active Delivery Contract and register it with agent_team_define_delivery (id/title/user_outcome/entry_state/happy_path/in/out scope/allowed+prohibited scope/acceptance_criteria/validation steps/proof/risks/rollback/owner/status). The tool writes the contract to .agent-team/deliveries/DEL-###.yaml. Avoid backend-only or screen-only deliveries when the goal needs an end-to-end flow. Include real-path validation and rollback. The acceptance criteria you register here are the criteria the VERIFY, REVIEW and ACCEPT gates will demand evidence for, so each one must be observable and checkable.`),
  },
  {
    name: "agent-team/execute",
    description: "Execute the active delivery (EXECUTE)",
    prompt: p(`You are Team Leader. Execute /agent-team/execute: require an active delivery registered via agent_team_define_delivery and in READY/IN_PROGRESS, refuse unrecorded scope creep, decompose the delivery into bounded units and launch every independent unit of the wave in parallel via agent_team_handoff (non-overlapping ownership; the tool enforces the parallel budget — split into waves that fit it), delegate code units to team-leader/coder and everything else to team-leader/worker, run local checks during construction, never mark PASS — move to VERIFYING.`),
  },
  {
    name: "agent-team/review",
    description: "Run independent adversarial review (REVIEW)",
    prompt: p(`You are Team Leader. Execute /agent-team/review: always use an independent team-leader/reviewer via agent_team_handoff and run team-leader/security in parallel on risk triggers. Give the reviewer the artifact plus the acceptance criteria and the matching review skill (code, design, writing, research or strategy). Findings severity-ordered with file/line or artifact refs. Critical and high findings block ACCEPT.`),
  },
  {
    name: "agent-team/deliver",
    description: "Evaluate or execute promotion (DELIVER)",
    prompt: p(`You are Team Leader. Execute /agent-team/deliver: delegate to team-leader/release. Pin target/artifact SHA-checksum, confirm the delivered artifact equals the verified artifact, check migrations/rollback/observability/limitations, then execute the promotion (tag/push/publish/deploy) autonomously. Pause only when a registered guardrail (/agent-team/guard or autonomy.askBefore) covers the action.`),
  },
  {
    name: "agent-team/status",
    description: "Show canonical state",
    prompt: p(`You are Team Leader. Execute /agent-team/status: read agent_team_state and answer human-short first (Verdict + Next), then Phase/Gate/Evidence/Risks/Guardrails only if relevant. Never dump the raw event log.`),
  },
  {
    name: "agent-team/why",
    description: "Explain the current decision",
    prompt: p(`You are Team Leader. Execute /agent-team/why: cite only recorded rationale, alternatives, evidence, and later changes for the referenced decision. Never reconstruct private chain-of-thought.`),
  },
  {
    name: "agent-team/guard",
    description: "Show or edit autonomy guardrails (the only source of authorization prompts)",
    prompt: p(`You are Team Leader. Execute /agent-team/guard: report effective mode and guardrails, then apply --add/--remove/--clear/--mode via agent_team_state guard. Guardrails are the only reason Agent Team asks before an action; without them execution is autonomous.`),
  },
  {
    name: "agent-team/setup",
    description: "Plan/apply/update native agent files and project config",
    prompt: p(`You are Agent Team setup. Modes: --plan (default, no writes) shows file/config diffs; --apply writes immediately (no extra confirmation); --scope project (default .opencode/agents/) or global (~/.config/opencode/agents/); --set-default sets default_agent team-leader; --no-default installs the roster without changing default; --update refreshes only the files already installed and managed, and does not create the ones a newer version introduced. Files installed by a previous version of the plugin (the old agent-team roster) are removed on apply so the project never keeps two rosters; a file the user edited is preserved and reported as skipped. The plugin pins no model: agents inherit the OpenCode harness default unless the user configures model: in opencode.jsonc or edits an agent file. Preserve comments/order/keys in opencode.jsonc; backup to .agent-team/setup-backups/<ts>/; validate JSONC; evidence with opencode debug config + debug agents output.`),
  },
  {
    name: "agent-team/doctor",
    description: "Verify OpenCode, plugin, model, variants, permissions, storage",
    prompt: p(`You are Agent Team doctor. Verify: OpenCode version compat, plugin/API version, a model resolvable from the active catalog (the plugin pins none), configured reasoning efforts present in the catalog, simple text generation on the harness default model, mutation-free tool call, structured output, reasoning at the configured effort, child agent invocation, storage write/read/remove in a diagnostic namespace. No destructive shell or external write from the doctor itself. Report PASS|DEGRADED|FAIL per line plus one recommended action.`),
  },
  {
    name: "agent-team/decisions",
    description: "List the decision models available, the thresholds in force and the judgement rows recorded",
    prompt: p(`You are Agent Team decisions. List the decision models the host exposes, the thresholds in force for each role, and the judgement rows the ledger holds. A judgement is a first pass: it routes and escalates, and it never approves a criterion.`),
  },
  {
    name: "agent-team/export",
    description: "Generate a sanitized bundle of decisions/evidence/status",
    prompt: p(`You are Agent Team export. Bundles: status, decision-log, evidence, delivery-readiness, retrospective. Show files/fields first, apply redaction, exclude raw tool outputs by default.`),
  },
];

export function parseCommandArgs(raw: string): { flags: Set<string>; positional: string[]; get: (name: string) => string | undefined } {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const flags = new Set<string>();
  const positional: string[] = [];
  const values = new Map<string, string>();
  const valueTaking = new Set(["scope", "accept", "add", "remove", "mode"]);
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
