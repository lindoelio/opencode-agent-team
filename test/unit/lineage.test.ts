import { describe, expect, it } from "vitest";
import { ancestorsOf, consumeLineageEvent, noteParent, parentOf, resolveAncestors, resolveParent, _resetLineageForTests } from "../../src/orchestrator/lineage.js";
import { consumeTrustedLaunch, markTrustedLaunch, _resetTrustedLaunchesForTests } from "../../src/orchestrator/launch-trust.js";

describe("session lineage", () => {
  it("walks the parent chain nearest first and survives a cycle", () => {
    _resetLineageForTests();
    noteParent("helper-1", "specialist-1");
    noteParent("specialist-1", "leader-1");
    noteParent("leader-1", "leader-1");
    expect(parentOf("helper-1")).toBe("specialist-1");
    expect(ancestorsOf("helper-1")).toEqual(["specialist-1", "leader-1"]);
    // A cycle cannot hang the walk.
    noteParent("specialist-1", "helper-1");
    expect(ancestorsOf("helper-1").length).toBeLessThanOrEqual(2);
    _resetLineageForTests();
  });

  it("ignores a self-parent and a blank id", () => {
    _resetLineageForTests();
    noteParent("s", "s");
    noteParent("", "parent");
    expect(parentOf("s")).toBeUndefined();
    expect(parentOf("")).toBeUndefined();
  });

  it("reads the parent relation from every event envelope the host uses", () => {
    _resetLineageForTests();
    consumeLineageEvent({ type: "session.created", data: { sessionID: "a", parentID: "p1" } });
    consumeLineageEvent({ type: "session.created", sessionID: "b", parentID: "p2" });
    consumeLineageEvent({ type: "session.created", properties: { sessionID: "c", parentID: "p3" } });
    consumeLineageEvent({ type: "session.idle", data: { sessionID: "d", parentID: "p4" } });
    expect(parentOf("a")).toBe("p1");
    expect(parentOf("b")).toBe("p2");
    expect(parentOf("c")).toBe("p3");
    expect(parentOf("d")).toBeUndefined();
    _resetLineageForTests();
  });
});

describe("trusted launch prompts", () => {
  it("consumes the mark once", () => {
    _resetTrustedLaunchesForTests();
    markTrustedLaunch("child-1");
    expect(consumeTrustedLaunch("child-1")).toBe(true);
    expect(consumeTrustedLaunch("child-1")).toBe(false);
    expect(consumeTrustedLaunch("other")).toBe(false);
    _resetTrustedLaunchesForTests();
  });
});

describe("lazy lineage fallback", () => {
  it("asks the host once, caches the parent, and caches the definitive absence", async () => {
    _resetLineageForTests();
    let calls = 0;
    const getSession = async (id: string) => {
      calls += 1;
      if (id === "helper-1") return { parentID: "specialist-1" };
      return { data: { id } };
    };
    expect(await resolveParent(getSession, "helper-1")).toBe("specialist-1");
    expect(parentOf("helper-1")).toBe("specialist-1");
    // The second question never reaches the host.
    expect(await resolveParent(getSession, "helper-1")).toBe("specialist-1");
    expect(calls).toBe(1);
    // A session with no parent is asked about once, not on every tool call.
    expect(await resolveParent(getSession, "user-1")).toBeUndefined();
    expect(await resolveParent(getSession, "user-1")).toBeUndefined();
    expect(calls).toBe(2);
    _resetLineageForTests();
  });

  it("does not cache a host failure: a transient error must not become a permanent negative", async () => {
    _resetLineageForTests();
    let calls = 0;
    const broken = async () => {
      calls += 1;
      throw new Error("host down");
    };
    expect(await resolveParent(broken, "helper-x")).toBeUndefined();
    expect(await resolveParent(broken, "helper-x")).toBeUndefined();
    expect(calls).toBe(2);
    _resetLineageForTests();
  });

  it("walks a multi-level chain through the host when the event map is empty", async () => {
    _resetLineageForTests();
    const parents: Record<string, string> = { "helper-2": "helper-1", "helper-1": "specialist-1" };
    const getSession = async (id: string) => (parents[id] ? { data: { parentID: parents[id] } } : { data: { id } });
    expect(await resolveAncestors(getSession, "helper-2")).toEqual(["helper-1", "specialist-1"]);
    // The resolved links are now in the event map.
    expect(ancestorsOf("helper-2")).toEqual(["helper-1", "specialist-1"]);
    _resetLineageForTests();
  });

  it("uses the event-fed chain without asking the host", async () => {
    _resetLineageForTests();
    noteParent("helper-1", "specialist-1");
    const failIfCalled = async () => {
      throw new Error("the host must not be asked");
    };
    expect(await resolveAncestors(failIfCalled, "helper-1")).toEqual(["specialist-1"]);
    _resetLineageForTests();
  });
});
