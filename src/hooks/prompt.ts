import { classifySteering, extractFactFromUntrusted } from "../domain/decision.js";
import { redactText } from "../ledger/redaction.js";
import { UPDATE_HOST_MESSAGE } from "../compat/host.js";
import { shouldNoticeOldHost } from "../orchestrator/host-gate.js";
import { routePrompt } from "../decision/route.js";
import { quarantineSession } from "./untrusted.js";
import { consumeTrustedLaunch } from "../orchestrator/launch-trust.js";
import type { AgentTeamRuntime } from "../runtime.js";

/**
 * Instruction-shaped input families, English, Portuguese and Spanish.
 *
 * A list this short is a mitigation, not a classifier: it raises the cost of
 * the obvious injection without pretending to catch a paraphrase. The
 * multi-language entries exist because a pattern list that only reads English
 * protects only English input.
 */
const INJECTION_HINTS: RegExp[] = [
  /ignore\s+(prior|previous|all)\s+instructions/i,
  /ignora\s+(as\s+)?(instru(?:ções|cciones)|ordens)\s+(anteriores|prévias|todas|previas)/i,
  /execute\s+(this|the\s+following)\s+command/i,
  /execute\s+(o\s+)?(seguinte\s+)?comando/i,
  /upload\s+this\s+log/i,
  /disregard\s+.*policy/i,
  /desconsidera\s+.*pol[ií]tica/i,
  /ignora\s+.*pol[ií]tica/i,
  /bypass\s+.*(policy|protection|approval)/i,
  /contorna\s+.*(prote(c|ç)[ãa]o|pol[ií]tica)/i,
];

/** session.prompt: redact secrets, tag steering, quarantine untrusted instructions. Retry-safe, no side effects. */
export async function registerPromptHook(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const reg = await runtime.ctx.session.hook("prompt", async (event: any) => {
    const prompt = event.prompt as unknown as { text?: string };
    if (typeof prompt.text === "string") {
      prompt.text = redactText(prompt.text);
      const steering = classifySteering(prompt.text);
      event.metadata = { ...(event.metadata ?? {}), agentTeamSteering: steering, agentTeamAgent: "prompt" };
      const sessionId = String((event as unknown as { sessionID?: string }).sessionID ?? "");
      // A prompt the plugin itself wrote for a launched specialist is the
      // task, not untrusted content: quarantining it would tell the
      // specialist to treat its own brief as data.
      const trustedLaunch = sessionId.length > 0 && consumeTrustedLaunch(sessionId);
      if (!trustedLaunch && INJECTION_HINTS.some((re) => re.test(prompt.text ?? ""))) {
        const { fact, instructions } = extractFactFromUntrusted(prompt.text ?? "");
        if (sessionId) quarantineSession(sessionId, instructions);
        event.metadata = {
          ...(event.metadata ?? {}),
          agentTeamUntrusted: true,
          agentTeamFactExtract: fact.slice(0, 500),
        };
      }
    }
    // Route the admitted prompt before the chat model spends a turn on
    // classification. The router is idempotent on the admitted text.
    //
    // The prompt hook contract carries no `agent` field, so the role comes
    // from the session record. Without this lookup the leader check is never
    // true and the router silently does nothing on every host.
    const routeSession = String((event as unknown as { sessionID?: string }).sessionID ?? "");
    let routeAgent = String((event as unknown as { agent?: string }).agent ?? "");
    if (routeSession && !routeAgent) {
      try {
        const info = (await runtime.ctx.session.get({ sessionID: routeSession } as never)) as unknown;
        const record = info as { data?: { agent?: unknown }; agent?: unknown };
        routeAgent = String(record?.data?.agent ?? record?.agent ?? "");
      } catch {
        // No session record: the prompt still reaches the model un-routed.
      }
    }
    if (routeSession && routeAgent === "team-leader" && typeof prompt.text === "string") {
      await routePrompt(runtime, routeSession, prompt.text).catch(() => {});
    }
    // A host below the floor is told once per session. The notice is
    // synthetic, so it cannot re-enter this hook and loop.
    const sessionId = String((event as unknown as { sessionID?: string }).sessionID ?? "");
    const agent = String((event as unknown as { agent?: string }).agent ?? "");
    if (sessionId && agent.startsWith("team-leader") && shouldNoticeOldHost(runtime, sessionId)) {
      try {
        await runtime.ctx.session.synthetic({ sessionID: sessionId, text: UPDATE_HOST_MESSAGE } as never);
      } catch {
        // A host without synthetic messages still refuses every mutating tool.
      }
    }
  });
  return { dispose: () => reg.dispose() };
}
