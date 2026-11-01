import * as fs from "node:fs";
import { loadTemplates } from "../catalog/agents.js";
import { checksumOf, isManaged, stripHeader } from "./jsonc.js";

/** The managed template of the team leader, relative to a scope's agents directory. */
export const LEADER_REL = ".opencode/agents/team-leader.md";

const DESCRIPTION_LINE = /^description:[ \t]*(.*)$/m;
const LABEL_SEPARATOR = " — ";

/**
 * The characters YAML treats as an indicator at the start of a plain scalar.
 * A value beginning with one is read as something other than the string it
 * looks like.
 */
const YAML_INDICATORS = "-?:,[]{}#&*!|>'\"%@`";

/** The description the shipped leader template carries. */
export function leaderDescription(template: string): string | undefined {
  return template.match(DESCRIPTION_LINE)?.[1]?.trim();
}

/**
 * The description the leader file carries with a title in place of the
 * shipped label.
 *
 * The title is substituted for the label, so the remainder of the shipped
 * description is kept: the agent stays discoverable by what it does.
 */
export function assembleLeaderDescription(template: string, title: string): string {
  const value = leaderDescription(template) ?? "";
  const separator = value.indexOf(LABEL_SEPARATOR);
  const rest = separator === -1 ? "" : value.slice(separator + LABEL_SEPARATOR.length);
  return rest.length > 0 ? `${title}${LABEL_SEPARATOR}${rest}` : title;
}

/**
 * Whether a description value stays a plain scalar, and so keeps the file
 * readable as the agent definition it is.
 *
 * The check runs on the assembled value rather than on the title alone: the
 * title is substituted into the description line, and it is that line the
 * host reads.
 */
export function isPlainScalar(value: string): boolean {
  if (value.length === 0) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value !== value.trim()) return false;
  if (value.includes(": ")) return false;
  if (value.includes(" #")) return false;
  const first = value[0];
  if (first !== undefined && YAML_INDICATORS.includes(first)) return false;
  return true;
}

/**
 * Whether a title may be installed.
 *
 * The check is on the assembled description, not on the title alone: a title
 * ending in a colon carries no colon-space inside it, yet the line it
 * produces does, and the host would read a nested mapping instead of a
 * description.
 */
export function isValidLeaderTitle(template: string, title: string): boolean {
  if (title.length === 0) return false;
  if (title !== title.trim()) return false;
  if (/[\r\n]/.test(title)) return false;
  if (title.includes(":")) return false;
  if (title.includes(" #")) return false;
  const first = title[0];
  if (first !== undefined && YAML_INDICATORS.includes(first)) return false;
  return isPlainScalar(assembleLeaderDescription(template, title));
}

/** The leader templates with the title in place of the shipped label. */
export function withLeaderTitle(templates: Map<string, string>, title: string): Map<string, string> {
  const leader = templates.get(LEADER_REL);
  if (leader === undefined) return templates;
  const description = assembleLeaderDescription(leader, title);
  const next = leader.replace(DESCRIPTION_LINE, () => `description: ${description}`);
  const out = new Map(templates);
  out.set(LEADER_REL, next);
  return out;
}

/**
 * The agent templates the setup installs, with the leader's title in place of
 * the shipped label when one was chosen.
 */
export async function setupTemplates(leaderTitle: string | undefined): Promise<Map<string, string>> {
  const templates = await loadTemplates();
  return leaderTitle === undefined ? templates : withLeaderTitle(templates, leaderTitle);
}

export interface LeaderFileState {
  exists: boolean;
  /** The setup may write this file: it is absent, or managed and not edited. */
  writable: boolean;
  title?: string;
}

/**
 * What the installed leader file is: absent, the plugin's, or the user's.
 *
 * A file the user edited keeps its marker but no longer matches its own
 * checksum, and the setup never writes it.
 */
export async function inspectLeaderFile(absPath: string): Promise<LeaderFileState> {
  let content: string;
  try {
    content = await fs.promises.readFile(absPath, "utf8");
  } catch {
    return { exists: false, writable: true };
  }
  const meta = isManaged(content);
  if (!meta) return { exists: true, writable: false };
  const drifted = meta.checksum !== checksumOf(stripHeader(content));
  return { exists: true, writable: !drifted, title: meta.title };
}
