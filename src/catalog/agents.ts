import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentTemplate {
  id: string;
  targetRel: string;
  sourceRel: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  { id: "team-leader", targetRel: ".opencode/agents/team-leader.md", sourceRel: "assets/agents/team-leader.md" },
  { id: "team-leader/explorer", targetRel: ".opencode/agents/team-leader/explorer.md", sourceRel: "assets/agents/team-leader/explorer.md" },
  { id: "team-leader/product", targetRel: ".opencode/agents/team-leader/product.md", sourceRel: "assets/agents/team-leader/product.md" },
  { id: "team-leader/architect", targetRel: ".opencode/agents/team-leader/architect.md", sourceRel: "assets/agents/team-leader/architect.md" },
  { id: "team-leader/designer", targetRel: ".opencode/agents/team-leader/designer.md", sourceRel: "assets/agents/team-leader/designer.md" },
  { id: "team-leader/coder", targetRel: ".opencode/agents/team-leader/coder.md", sourceRel: "assets/agents/team-leader/coder.md" },
  { id: "team-leader/worker", targetRel: ".opencode/agents/team-leader/worker.md", sourceRel: "assets/agents/team-leader/worker.md" },
  { id: "team-leader/reviewer", targetRel: ".opencode/agents/team-leader/reviewer.md", sourceRel: "assets/agents/team-leader/reviewer.md" },
  { id: "team-leader/security", targetRel: ".opencode/agents/team-leader/security.md", sourceRel: "assets/agents/team-leader/security.md" },
  { id: "team-leader/release", targetRel: ".opencode/agents/team-leader/release.md", sourceRel: "assets/agents/team-leader/release.md" },
];

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/catalog -> package root
  return path.resolve(here, "..", "..");
}

export async function loadTemplates(): Promise<Map<string, string>> {
  const root = packageRoot();
  const out = new Map<string, string>();
  for (const t of AGENT_TEMPLATES) {
    const abs = path.join(root, t.sourceRel);
    const content = await fs.promises.readFile(abs, "utf8");
    out.set(t.targetRel, content);
  }
  // .agent-team/README template
  const readme = path.join(root, "assets", "templates", "agent-team-readme.md");
  try {
    const content = await fs.promises.readFile(readme, "utf8");
    out.set(".agent-team/README.md", content);
  } catch {
    out.set(".agent-team/README.md", "# .agent-team\n\nAgent Team project ledger. Machine-managed; edit via /agent-team commands and tools.\n");
  }
  return out;
}
