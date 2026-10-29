import { Plugin } from "@opencode/plugin";
import type { AgentTeamOptions } from "./options.js";

export type AgentTeamContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

export interface AgentTeamRuntime {
  ctx: AgentTeamContext;
  options: AgentTeamOptions;
}

export function createRuntime(ctx: AgentTeamContext, options: AgentTeamOptions): AgentTeamRuntime {
  return { ctx, options };
}

export function projectRootOf(ctx: AgentTeamContext): string {
  const loc = ctx.location as unknown as {
    project?: { canonical?: string; directory?: string };
    directory?: string;
  };
  return loc.project?.canonical ?? loc.project?.directory ?? loc.directory ?? process.cwd();
}

export function toolOk(data: unknown): { content: string } {
  return { content: JSON.stringify(data, null, 2) };
}

export function toolErr(message: string): never {
  throw new Error(message);
}
