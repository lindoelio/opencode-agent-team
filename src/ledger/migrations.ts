import { AgentTeamProjectStateSchema, type AgentTeamProjectStateV2 } from "../domain/schemas.js";


export const CURRENT_SCHEMA_VERSION = 4;

export function needsMigration(schemaVersion: number): boolean {
  return schemaVersion !== CURRENT_SCHEMA_VERSION;
}

const PHASE_V1_TO_V2: Record<string, string> = {
  SLICE: "PLAN",
  IMPLEMENT: "EXECUTE",
  RELEASE: "DELIVER",
};

const STATUS_V1_TO_V2: Record<string, string> = {
  RELEASE_READY: "DELIVERY_READY",
  RELEASED: "DELIVERED",
};

const GATE_V1_TO_V2: Record<string, string> = {
  SLICE: "PLAN",
  RELEASE: "DELIVER",
};

const ROLE_V1_TO_V2: Record<string, string> = {
  builder: "coder",
  verifier: "reviewer",
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function migrateDelivery(raw: unknown): unknown {
  const d = asRecord(raw);
  const proof: Array<{ kind: string; claim: string; ref: string }> = [];
  for (const [kind, bucket] of [["functional", d["runtimeProof"]], ["presentation", d["visualProof"]]] as const) {
    for (const ref of stringList(bucket)) {
      if (ref.length > 0) proof.push({ kind, claim: ref, ref });
    }
  }
  return {
    id: d["id"],
    title: d["title"],
    userOutcome: d["userOutcome"],
    entryState: d["entryState"],
    happyPath: stringList(d["happyPath"]),
    inScope: stringList(d["inScope"]),
    outOfScope: stringList(d["outOfScope"]),
    allowedScope: stringList(d["allowedFiles"]),
    prohibitedScope: stringList(d["prohibitedFiles"]),
    acceptanceCriteria: stringList(d["acceptanceCriteria"]),
    validationSteps: stringList(d["validationCommands"]),
    proof,
    risks: stringList(d["risks"]),
    rollback: d["rollback"],
    owner: d["owner"],
    status: d["status"],
  };
}

/**
 * Forward-only migration. v1 → v2 renames the code-centric vocabulary to a
 * domain-neutral one and updates the specialist roster: `builder` becomes
 * `coder`, `verifier` becomes `reviewer`, and `worker` joins the roster.
 */
export function migrateUnknown(state: unknown): unknown {
  const s = state as { schemaVersion?: number };
  if (!s || typeof s !== "object") throw new Error("unknown state layout");
  if (s.schemaVersion === CURRENT_SCHEMA_VERSION) return state;
  if (s.schemaVersion === 3) return migrateV3toV4(state);
  if (s.schemaVersion === 2) return migrateV3toV4(migrateV2toV3(state));
  if (s.schemaVersion === 1) return migrateV3toV4(migrateV2toV3(migrateV1toV2(state)));
  throw new Error(`unsupported state schema: ${String(s.schemaVersion)} (backup required before upgrade)`);
}

/**
 * Forward-only migration. v3 → v4 pairs every validation step with the
 * criterion it proves and adds the waiver list.
 *
 * v3 recorded steps as plain commands and paired them with criteria by
 * position (the last criterion absorbing the surplus). That rule was load
 * bearing and invisible — every prompt surface, including this migration,
 * had to guess it. v4 makes the pairing explicit: the old positional rule is
 * applied once, here, so an in-flight delivery keeps exactly the checks the
 * leader declared. It does not promote a waiver: there was no waiver path
 * before, and inventing one would relax an engagement nobody relaxed.
 */
export function migrateV3toV4(state: unknown): AgentTeamProjectStateV2 {
  const s = asRecord(state);
  const delivery = s["activeDelivery"] !== undefined ? asRecord(s["activeDelivery"]) : undefined;
  const criteria = stringList(delivery?.["acceptanceCriteria"]);
  const rawSteps = delivery !== undefined && Array.isArray(delivery["validationSteps"]) ? delivery["validationSteps"] : [];
  const validationSteps = rawSteps.map((step, index) => {
    if (typeof step === "string") {
      return { criterionId: criteria[Math.min(index, criteria.length - 1)] ?? "", command: step };
    }
    return step;
  });
  const migrated: Record<string, unknown> = {
    ...s,
    schemaVersion: 4,
    waivers: Array.isArray(s["waivers"]) ? s["waivers"] : [],
    ...(delivery ? { activeDelivery: { ...delivery, validationSteps } } : {}),
  };
  return AgentTeamProjectStateSchema.parse(migrated);
}

/**
 * Forward-only migration. v2 → v3 adds the engagement class and the
 * observation flag. It does not promote a prior `pass`: an unobserved row
 * stays unobserved, and the gate refuses it.
 */
export function migrateV2toV3(state: unknown): MigratedV2State {
  const s = asRecord(state);
  const evidence = Array.isArray(s["evidence"])
    ? s["evidence"].map((raw) => {
        const e = asRecord(raw);
        return { ...e, observed: e["observed"] === true };
      })
    : [];
  const handoffs = Array.isArray(s["handoffs"])
    ? s["handoffs"].map((raw) => {
        const h = asRecord(raw);
        return { ...h, ...(typeof h["sessionID"] === "string" ? { sessionID: h["sessionID"] } : {}) };
      })
    : [];
  const migrated: Record<string, unknown> = {
    ...s,
    schemaVersion: 3,
    engagementClass: s["engagementClass"] === "fix" || s["engagementClass"] === "decision" ? s["engagementClass"] : "change",
    evidence,
    handoffs,
  };
  // This is an intermediate shape; `migrateV3toV4` validates the final one.
  return migrated as unknown as MigratedV2State;
}

export type MigratedV2State = Omit<AgentTeamProjectStateV2, "schemaVersion"> & { schemaVersion: 2 };

export function migrateV1toV2(state: unknown): MigratedV2State {
  const s = asRecord(state);
  const engagement = asRecord(s["engagement"]);
  const phase = PHASE_V1_TO_V2[String(engagement["phase"])] ?? String(engagement["phase"]);
  const status = STATUS_V1_TO_V2[String(engagement["status"])] ?? String(engagement["status"]);
  const activeSlice = s["activeSlice"];
  const gates = Array.isArray(s["gates"])
    ? s["gates"].map((raw) => {
        const g = asRecord(raw);
        const gate = GATE_V1_TO_V2[String(g["gate"])] ?? String(g["gate"]);
        return { ...g, gate };
      })
    : [];
  const handoffs = Array.isArray(s["handoffs"])
    ? s["handoffs"].map((raw) => {
        const h = asRecord(raw);
        const role = ROLE_V1_TO_V2[String(h["role"])] ?? String(h["role"]);
        // A v1 handoff without a status was, by definition, not completed.
        const status = typeof h["status"] === "string" ? h["status"] : "prepared";
        return { ...h, role, status, skills: stringList(h["skills"]), dependsOn: stringList(h["dependsOn"]) };
      })
    : [];
  const migrated: Record<string, unknown> = {
    ...s,
    schemaVersion: 2,
    engagementClass: "change",
    engagement: { ...engagement, phase, status },
    gates,
    handoffs,
    // The v2 schema requires these collections. A v1 state that lacked one
    // would otherwise fail to parse, and an unreadable engagement is a lost
    // engagement: default the missing collection to empty rather than
    // refusing the upgrade.
    risks: Array.isArray(s["risks"]) ? s["risks"] : [],
    assumptions: Array.isArray(s["assumptions"]) ? s["assumptions"] : [],
    decisions: Array.isArray(s["decisions"]) ? s["decisions"] : [],
    evidence: Array.isArray(s["evidence"]) ? s["evidence"] : [],
    approvals: Array.isArray(s["approvals"]) ? s["approvals"] : [],
    guardrails: Array.isArray(s["guardrails"]) ? s["guardrails"] : [],
    actors: Array.isArray(s["actors"]) ? s["actors"] : [],
    constraints: Array.isArray(s["constraints"]) ? s["constraints"] : [],
    nonGoals: Array.isArray(s["nonGoals"]) ? s["nonGoals"] : [],
  };
  if (activeSlice !== undefined) migrated["activeDelivery"] = migrateDelivery(activeSlice);
  delete migrated["activeSlice"];
  delete migrated["modelProfile"];
  // This is an intermediate shape. `migrateV2toV3` validates the final one.
  return migrated as unknown as MigratedV2State;
}
