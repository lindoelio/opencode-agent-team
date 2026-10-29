import { classifySteering, extractFactFromUntrusted } from "../domain/decision.js";
import { redactText } from "../ledger/redaction.js";
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
  });
  return { dispose: () => reg.dispose() };
}
