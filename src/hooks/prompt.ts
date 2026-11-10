import { classifySteering, extractFactFromUntrusted } from "../domain/decision.js";
import { redactText } from "../ledger/redaction.js";
import { UPDATE_HOST_MESSAGE } from "../compat/host.js";
import { shouldNoticeOldHost } from "../orchestrator/host-gate.js";
import { routePrompt } from "../decision/route.js";
import { quarantineSession } from "./untrusted.js";
import type { AgentTeamRuntime } from "../runtime.js";

const INJECTION_HINTS: RegExp[] = [
  /ignore\s+(prior|previous|all)\s+instructions/i,
  /execute\s+(this\s+)?command/i,
  /upload\s+this\s+log/i,
  /disregard\s+.*policy/i,
  /bypass\s+.*(policy|protection|approval)/i,
];

/** session.prompt: redact secrets, tag steering, quarantine untrusted instructions. Retry-safe, no side effects. */
export async function registerPromptHook(runtime: AgentTeamRuntime): Promise<{ dispose: () => Promise<void> }> {
  const reg = await runtime.ctx.session.hook("prompt", async (event: any) => {
    const prompt = event.prompt as unknown as { text?: string };
    if (typeof prompt.text === "string") {
      prompt.text = redactText(prompt.text);
      const steering = classifySteering(prompt.text);
      event.metadata = { ...(event.metadata ?? {}), agentTeamSteering: steering, agentTeamAgent: "prompt" };
      if (INJECTION_HINTS.some((re) => re.test(prompt.text ?? ""))) {
        const { fact, instructions } = extractFactFromUntrusted(prompt.text ?? "");
        const sessionId = String((event as unknown as { sessionID?: string }).sessionID ?? "");
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
    const routeSession = String((event as unknown as { sessionID?: string }).sessionID ?? "");
    const routeAgent = String((event as unknown as { agent?: string }).agent ?? "");
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
