import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256Hex, hashEventPayload, newId, shortHash } from "../../src/util/hash.js";
import { engagementId, eventId, decisionId, deliveryId, evidenceId, approvalId, handoffId } from "../../src/util/ids.js";
import { agentTeamDir, statePath, eventsPath, resolveInside, assertNoSymlinkEscape, isAgentTeamManagedAgentPath } from "../../src/util/paths.js";

describe("util", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(hashEventPayload("p", "prev")).toBe(sha256Hex("prev\np"));
    expect(newId("X")).toMatch(/^X-[0-9A-F]{8}$/);
    expect(shortHash("abc")).toBe(sha256Hex("abc").slice(0, 16));
    expect(shortHash("abc", 8)).toHaveLength(8);
  });
  it("generates well-formed ids", () => {
    expect(engagementId()).toMatch(/^ENG-/);
    expect(eventId()).toMatch(/^EVT-/);
    expect(decisionId(1)).toBe("DEC-0001");
    expect(deliveryId(2)).toBe("DEL-002");
    expect(evidenceId(3)).toBe("EVD-0003");
    expect(approvalId(4)).toBe("APR-0004");
    expect(handoffId(5)).toBe("HND-0005");
  });
  it("builds ledger paths and guards traversal", () => {
    expect(agentTeamDir("/p")).toBe("/p/.agent-team");
    expect(statePath("/p")).toBe("/p/.agent-team/state.json");
    expect(eventsPath("/p")).toBe("/p/.agent-team/ledger/events.jsonl");
    expect(() => resolveInside("/p", "../evil")).toThrow();
    expect(resolveInside("/p", ".agent-team/state.json")).toBe(path.resolve("/p/.agent-team/state.json"));
    expect(isAgentTeamManagedAgentPath(".opencode/agents/team-leader.md")).toBe(true);
    expect(isAgentTeamManagedAgentPath(".opencode/agents/team-leader/explorer.md")).toBe(true);
    expect(isAgentTeamManagedAgentPath(".opencode/agents/team-leader/worker.md")).toBe(true);
    expect(isAgentTeamManagedAgentPath(".agent-team/README.md")).toBe(true);
    expect(isAgentTeamManagedAgentPath(".opencode/agents/agent-team.md")).toBe(false);
    expect(isAgentTeamManagedAgentPath("src/index.ts")).toBe(false);
  });
  it("refuses symlink escape but allows in-root links", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-paths-"));
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-outside-"));
    await fs.promises.writeFile(path.join(outside, "secret.txt"), "x");
    await fs.promises.symlink(path.join(outside, "secret.txt"), path.join(root, "evil-link"));
    await expect(assertNoSymlinkEscape(root, path.join(root, "evil-link"))).rejects.toThrow();
    await fs.promises.writeFile(path.join(root, "real.txt"), "y");
    await fs.promises.symlink(path.join(root, "real.txt"), path.join(root, "ok-link"));
    await expect(assertNoSymlinkEscape(root, path.join(root, "ok-link"))).resolves.toBe(path.join(root, "ok-link"));
    await expect(assertNoSymlinkEscape(root, path.join(root, "..", "escape"))).rejects.toThrow();
  });
});
