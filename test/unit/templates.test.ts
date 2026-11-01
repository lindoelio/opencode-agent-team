import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { managedTitle, stripHeader, withHeader } from "../../src/bootstrap/jsonc.js";
import { assembleLeaderDescription, inspectLeaderFile, isPlainScalar, isValidLeaderTitle, withLeaderTitle } from "../../src/bootstrap/templates.js";

const LEADER_REL = ".opencode/agents/team-leader.md";
const TEMPLATE = "---\ndescription: Team Leader — accountable orchestrator that turns goals into deliveries\nmode: primary\n---\n\nYou are Team Leader.\n";

describe("the managed marker", () => {
  it("carries a title and reads it back", () => {
    const marked = withHeader(TEMPLATE, "1", "Meu Time");
    expect(marked).toContain("title=Meu%20Time");
    expect(managedTitle(marked)).toBe("Meu Time");
  });

  it("reads a marker written without a title as before", () => {
    expect(managedTitle(withHeader(TEMPLATE, "1"))).toBeUndefined();
  });

  it("keeps a title that holds marker-breaking characters intact", () => {
    for (const title of ["A > B", "50% off", "a#b", "Meu Time"]) {
      const marked = withHeader(TEMPLATE, "1", title);
      expect(managedTitle(marked)).toBe(title);
      expect(stripHeader(marked)).not.toContain("AGENT-TEAM-MANAGED");
    }
  });

  it("reports no title for a marker whose encoding is broken", () => {
    expect(managedTitle("<!-- AGENT-TEAM-MANAGED version=1 checksum=abc title=%zz -->")).toBeUndefined();
  });
});

describe("the leader title", () => {
  it("replaces the label and keeps the rest of the description", () => {
    const next = withLeaderTitle(new Map([[LEADER_REL, TEMPLATE]]), "Meu Time");
    expect(next.get(LEADER_REL)).toContain("description: Meu Time — accountable orchestrator that turns goals into deliveries");
    expect(next.get(LEADER_REL)).toContain("You are Team Leader.");
  });

  it("leaves the templates alone when there is no leader to title", () => {
    const templates = new Map([[".opencode/agents/team-leader/coder.md", TEMPLATE]]);
    expect(withLeaderTitle(templates, "Meu Time")).toBe(templates);
  });

  it("keeps a leader template that carries no description untouched", () => {
    const bare = "---\nmode: primary\n---\n";
    const next = withLeaderTitle(new Map([[LEADER_REL, bare]]), "Meu Time");
    expect(next.get(LEADER_REL)).toBe(bare);
    expect(assembleLeaderDescription(bare, "Meu Time")).toBe("Meu Time");
  });

  it("refuses a title that would change how the frontmatter is read", () => {
    for (const title of ["", "   ", "Meu Time\noutro", "Boss:", "a: b", "Team #1", "[Boss]", "Team "]) {
      expect(isValidLeaderTitle(TEMPLATE, title)).toBe(false);
    }
  });

  it("accepts a title that keeps the description a plain scalar", () => {
    for (const title of ["Meu Time", "Team 2", "Équipe"]) {
      expect(isValidLeaderTitle(TEMPLATE, title)).toBe(true);
    }
  });

  it("recognises a value that is not a plain scalar", () => {
    expect(isPlainScalar("Meu Time — accountable")).toBe(true);
    expect(isPlainScalar("")).toBe(false);
    expect(isPlainScalar("one\ntwo")).toBe(false);
    expect(isPlainScalar(" Meu Time")).toBe(false);
    expect(isPlainScalar("Meu Time ")).toBe(false);
    expect(isPlainScalar("Boss: — accountable")).toBe(false);
    expect(isPlainScalar("Team #1 — accountable")).toBe(false);
    expect(isPlainScalar("[Boss] — accountable")).toBe(false);
  });

  it("reads the title an installed leader file carries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-title-"));
    const file = path.join(dir, "team-leader.md");
    fs.writeFileSync(file, withHeader(TEMPLATE, "1", "Meu Time"));
    expect((await inspectLeaderFile(file)).title).toBe("Meu Time");
    expect((await inspectLeaderFile(path.join(dir, "missing.md"))).title).toBeUndefined();
  });

  it("tells a managed leader file from one the user owns or edited", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-leader-"));
    const file = path.join(dir, "team-leader.md");

    const absent = await inspectLeaderFile(path.join(dir, "missing.md"));
    expect(absent).toEqual({ exists: false, writable: true });

    fs.writeFileSync(file, "MY OWN AGENT\n");
    const owned = await inspectLeaderFile(file);
    expect(owned.exists).toBe(true);
    expect(owned.writable).toBe(false);

    fs.writeFileSync(file, withHeader(TEMPLATE, "1", "Meu Time"));
    const managed = await inspectLeaderFile(file);
    expect(managed.writable).toBe(true);
    expect(managed.title).toBe("Meu Time");

    fs.writeFileSync(file, withHeader(TEMPLATE, "1", "Meu Time").replace("Team Leader", "Someone Else"));
    const drifted = await inspectLeaderFile(file);
    expect(drifted.writable).toBe(false);
  });
});
