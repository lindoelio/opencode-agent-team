import { describe, expect, it } from "vitest";
import { classifySession, isBlank, type SessionRow, type SweepOptions } from "../../scripts/archive-child-sessions.js";

const OFF: SweepOptions = { includeTemp: false, includeBlank: false };
const BLANK: SweepOptions = { includeTemp: false, includeBlank: true };
const TEMP: SweepOptions = { includeTemp: true, includeBlank: false };

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "ses_x",
    agent: null,
    title: null,
    parentID: null,
    metadata: null,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/" },
    ...overrides,
  };
}

describe("blank session detection", () => {
  it("recognizes a session no agent ever ran in", () => {
    expect(isBlank(row())).toBe(true);
    // The host records an empty metadata object rather than null sometimes.
    expect(isBlank(row({ metadata: {} }))).toBe(true);
  });

  it("does not call a session blank when any sign of work exists", () => {
    expect(isBlank(row({ agent: "build" }))).toBe(false);
    expect(isBlank(row({ title: "Some title" }))).toBe(false);
    expect(isBlank(row({ parentID: "ses_parent" }))).toBe(false);
    expect(isBlank(row({ metadata: { agentTeamParent: "ses_parent" } }))).toBe(false);
    expect(isBlank(row({ tokens: { input: 12 } }))).toBe(false);
    // Cache reads count as work: a conversation that only replayed context is
    // still a conversation.
    expect(isBlank(row({ tokens: { cache: { read: 100 } } }))).toBe(false);
  });
});

describe("sweep classification", () => {
  it("always takes the plugin's own children", () => {
    const child = row({ metadata: { agentTeamParent: "ses_leader" }, title: "HND-0001 coder", agent: "team-leader/coder" });
    expect(classifySession(child, OFF)).toBe("child");
    expect(classifySession(child, BLANK)).toBe("child");
  });

  it("takes temp leftovers only with --temp", () => {
    const inTemp = row({ location: { directory: "/private/var/folders/xx/T/agent-team-e2e-1" } });
    expect(classifySession(inTemp, OFF)).toBeNull();
    expect(classifySession(inTemp, TEMP)).toBe("temp");
    expect(classifySession(row({ location: { directory: "/tmp/probe" } }), TEMP)).toBe("temp");
    expect(classifySession(row({ location: { directory: "/private/tmp/probe" } }), TEMP)).toBe("temp");
    // A real project path is never temp debris.
    expect(classifySession(row({ location: { directory: "/Users/someone/project" } }), TEMP)).toBeNull();
  });

  it("takes blank sessions only with --blank", () => {
    expect(classifySession(row(), OFF)).toBeNull();
    expect(classifySession(row(), BLANK)).toBe("blank");
    // A blank session in a temp directory is reported as temp when both flags
    // are on, because that rule already covers it.
    expect(classifySession(row({ location: { directory: "/tmp/x" } }), { includeTemp: true, includeBlank: true })).toBe("temp");
  });

  it("never takes a real conversation", () => {
    const real = row({ agent: "build", title: "Refactor the parser", tokens: { input: 10, output: 20 } });
    expect(classifySession(real, { includeTemp: true, includeBlank: true })).toBeNull();
  });
});
