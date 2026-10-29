/** Imperative lines that look like instructions rather than data. */
const IMPERATIVE_LINE = /^(run|execute|upload|ignore|disregard|bypass|rm|curl|wget|eval)\b/i;

/** Extract the single relevant fact from untrusted content; never execute it. */
export function extractFactFromUntrusted(text: string): { fact: string; refusedInstructions: boolean; instructions: string[] } {
  const instructionPatterns = [
    /ignore\s+(prior|previous|all)\s+instructions/i,
    /execute\s+(this\s+)?command/i,
    /upload\s+this\s+log/i,
    /run\s+(this|the following)/i,
    /disregard\s+.*policy/i,
    /bypass\s+.*(policy|protection|approval)/i,
  ];
  const refusedInstructions = instructionPatterns.some((re) => re.test(text));
  // Keep only a short factual summary, strip imperative lines. The stripped
  // lines are the payload to quarantine: they are data that looks like a
  // command, and a tool call must never be built from them.
  const lines = text.split("\n");
  const instructions = lines.filter((l) => IMPERATIVE_LINE.test(l.trim())).map((l) => l.trim()).filter((l) => l.length > 0);
  const fact = lines.filter((l) => !IMPERATIVE_LINE.test(l.trim())).join("\n").slice(0, 2000);
  return { fact, refusedInstructions, instructions };
}

export function classifySteering(text: string): "replace" | "extend" | "question" | "unknown" {
  const t = text.toLowerCase();
  if (/^(stop|forget|instead|scratch that|replace)/.test(t.trim())) return "replace";
  if (/^(also|additionally|extend|and also|on top)/.test(t.trim())) return "extend";
  if (/\?\s*$/.test(text.trim())) return "question";
  return "unknown";
}
