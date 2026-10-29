import { z } from "zod";
import { DECISION_USES } from "./decision-model.js";

export const PhaseSchema = z.enum([
  "INTENT",
  "DISCOVER",
  "FRAME",
  "DECIDE",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "REVIEW",
  "ACCEPT",
  "DELIVER",
]);
export type Phase = z.infer<typeof PhaseSchema>;

export const WorkStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "IN_PROGRESS",
  "VERIFYING",
  "REVIEWING",
  "ACCEPTED",
  "DELIVERY_READY",
  "DELIVERED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
]);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

export const EpistemicBasisSchema = z.enum(["USER_STATED", "OBSERVED_PATTERN", "INFERENCE", "PROPOSAL", "VERIFIED", "UNKNOWN"]);
export type EpistemicBasis = z.infer<typeof EpistemicBasisSchema>;

export const AuthorityLevelSchema = z.enum(["ALLOW", "ALLOW_WITH_RECORD", "ASK", "DENY"]);
export type AuthorityLevel = z.infer<typeof AuthorityLevelSchema>;

export const SpecialistRoleSchema = z.enum([
  "explorer",
  "product",
  "architect",
  "designer",
  "coder",
  "worker",
  "reviewer",
  "security",
  "release",
]);
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;

export const AssumptionRefSchema = z.object({
  id: z.string(),
  statement: z.string().min(1),
  basis: z.enum(["USER_STATED", "OBSERVED_PATTERN", "INFERENCE", "PROPOSAL"]),
  confidence: z.enum(["low", "medium", "high"]),
  impact: z.string(),
  validation: z.string().optional(),
  sourceRefs: z.array(z.string()).default([]),
});
export type AssumptionRef = z.infer<typeof AssumptionRefSchema>;

export const DecisionOptionSchema = z.object({
  name: z.string().min(1),
  benefits: z.array(z.string()),
  costs: z.array(z.string()),
  risks: z.array(z.string()),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionRefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  context: z.string(),
  drivers: z.array(z.string()),
  options: z.array(DecisionOptionSchema).min(1),
  decision: z.string().min(1),
  rationale: z.string().min(1),
  consequences: z.array(z.string()),
  reversibility: z.enum(["easy", "moderate", "hard", "irreversible"]),
  authority: z.enum(["ALLOW", "ALLOW_WITH_RECORD", "ASK"]),
  evidenceRefs: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type DecisionRef = z.infer<typeof DecisionRefSchema>;

/** How a delivery is proven. `functional` = the flow works, `presentation` = how it looks, `document` = an artifact exists, `metric` = a number moved. */
export const ProofKindSchema = z.enum(["functional", "presentation", "document", "metric"]);
export type ProofKind = z.infer<typeof ProofKindSchema>;

export const ProofSchema = z.object({
  kind: ProofKindSchema,
  claim: z.string().min(1),
  ref: z.string().min(1),
});
export type Proof = z.infer<typeof ProofSchema>;

export const DeliveryRefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  userOutcome: z.string().min(1),
  entryState: z.string(),
  happyPath: z.array(z.string()),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  /** What this delivery may touch: files, channels, pages, processes, accounts. */
  allowedScope: z.array(z.string()),
  /** What it must never touch. */
  prohibitedScope: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).min(1),
  /** How the delivery is checked: commands, checks, calls, human sign-offs. */
  validationSteps: z.array(z.string()),
  proof: z.array(ProofSchema),
  risks: z.array(z.string()),
  rollback: z.string(),
  owner: z.string(),
  status: z.string(),
});
export type DeliveryRef = z.infer<typeof DeliveryRefSchema>;

export const RiskRefSchema = z.object({
  id: z.string(),
  statement: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  mitigation: z.string().optional(),
});
export type RiskRef = z.infer<typeof RiskRefSchema>;

export const GateRefSchema = z.object({
  gate: z.enum(["INTENT", "DISCOVERY", "PLAN", "VERIFY", "REVIEW", "ACCEPT", "DELIVER"]),
  result: z.enum(["PASS", "FAIL", "BLOCKED"]),
  claim: z.string(),
  satisfied: z.array(z.string()),
  missing: z.array(z.string()),
  failed: z.array(z.string()),
  waivers: z.array(z.string()),
  nextAction: z.string(),
  evaluatedAt: z.string(),
  /**
   * A digest of the delivery contract this gate was evaluated against. The
   * DELIVER gate compares it with the contract as it stands now, so a
   * delivery cannot be quietly changed after it was accepted.
   */
  contractDigest: z.string().optional(),
});
export type GateRef = z.infer<typeof GateRefSchema>;

/**
 * One answer of a calibrated decision.
 *
 * The plugin's own union, so a decision is recorded in the same shape
 * whichever provider answered it.
 */
export const JudgmentAnswerSchema = z.object({
  name: z.string(),
  type: z.enum(["predicate", "choice", "score", "error"]),
  probability: z.number().optional(),
  confidence: z.number().optional(),
  choice: z.union([z.string(), z.boolean()]).optional(),
  optionProbabilities: z.record(z.string(), z.number()).optional(),
  levelProbabilities: z.array(z.object({ value: z.number(), label: z.string(), probability: z.number() })).optional(),
  levelScore: z.number().optional(),
  reason: z.string().optional(),
});

/**
 * A judgement: the record of one calibrated decision.
 *
 * It is a record, not a proof. It never satisfies a criterion and never
 * supports a claim, so the fields below exist for the audit trail.
 */
export const JudgmentBlockSchema = z.object({
  model: z.string(),
  answers: z.array(JudgmentAnswerSchema),
  role: z.string(),
  use: z.enum(DECISION_USES),
  thresholds: z.object({ probability: z.number(), confidence: z.number() }),
  criterion: z.string().min(1),
  decisionId: z.string().min(1),
  verdict: z.enum(["satisfied", "unanswered", "escalate"]),
  verified: z.boolean(),
  stateDigest: z.string(),
  rationale: z.string(),
  elapsedMs: z.number(),
  usage: z.object({ input: z.number(), output: z.number() }),
});

export type JudgmentBlock = z.infer<typeof JudgmentBlockSchema>;

export const EvidenceRefSchema = z.object({
  id: z.string(),
  criterionId: z.string().min(1),
  kind: z.enum(["test", "runtime", "visual", "source", "review", "release", "document", "metric", "judgment"]),
  status: z.enum(["pass", "fail", "partial", "skipped"]),
  summary: z.string().min(1),
  artifactRef: z.string().optional(),
  command: z.string().optional(),
  digest: z.string().optional(),
  observedAt: z.string(),
  limitations: z.array(z.string()).default([]),
  judgment: JudgmentBlockSchema.optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ApprovalRefSchema = z.object({
  id: z.string(),
  category: z.enum(["external_write", "release", "production", "destructive", "financial", "legal", "scope"]),
  requestedAction: z.string(),
  resources: z.array(z.string()),
  reason: z.string(),
  risks: z.array(z.string()),
  rollback: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  resolvedAt: z.string().optional(),
});
export type ApprovalRef = z.infer<typeof ApprovalRefSchema>;

export const HandoffRefSchema = z.object({
  id: z.string(),
  role: SpecialistRoleSchema,
  objective: z.string().min(1),
  context: z.array(z.string()),
  allowedScope: z.array(z.string()),
  prohibitedScope: z.array(z.string()),
  questions: z.array(z.string()),
  requiredEvidence: z.array(z.string()),
  stopCondition: z.string(),
  /** Skills the specialist must load before acting. */
  skills: z.array(z.string()).default([]),
  /** Handoff ids that must complete before this one can start. */
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(["prepared", "completed", "cancelled"]),
  result: z.unknown().optional(),
});
export type HandoffRef = z.infer<typeof HandoffRefSchema>;

export const SpecialistResultSchema = z
  .object({
    status: z.enum(["PASS", "FAIL", "BLOCKED", "ADVISORY"]),
    summary: z.string().min(1),
    findings: z.array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low", "note"]),
        claim: z.string(),
        evidence: z.array(z.string()),
      }),
    ),
    risks: z.array(z.string()),
    unknowns: z.array(z.string()),
    recommended_next_action: z.string().min(1),
    /**
     * The decisions the specialist executed.
     *
     * The identifier and the block, so the leader can record the judgement
     * without re-running the decision. A malformed block degrades to no
     * decision rather than refusing the handoff.
     */
    decisions: z
      .array(
        z.object({
          id: z.string().min(1),
          criterion: z.string().min(1),
          verdict: z.enum(["satisfied", "unanswered", "escalate"]),
          judgment: JudgmentBlockSchema.optional(),
        }),
      )
      .optional(),
  })
  .strict();
export type SpecialistResult = z.infer<typeof SpecialistResultSchema>;

export const AgentTeamProjectStateSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().min(0),
  project: z.object({
    id: z.string().min(1),
    canonicalDirectoryHash: z.string().min(1),
  }),
  engagement: z.object({
    id: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: WorkStatusSchema,
    phase: PhaseSchema,
  }),
  thesis: z
    .object({
      version: z.number().int().min(1),
      statement: z.string(),
      actor: z.string(),
      problem: z.string(),
      outcome: z.string(),
      differentiator: z.string().optional(),
      validation: z.array(z.string()),
    })
    .optional(),
  outcome: z.string(),
  actors: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  /** User-registered guardrails: patterns that require asking before matching actions. Empty = nothing is asked. */
  guardrails: z.array(z.string()).default([]),
  /** State-level override for autonomy. Falls back to plugin options (`yolo` by default). */
  autonomyMode: z.enum(["yolo", "guarded"]).optional(),
  assumptions: z.array(AssumptionRefSchema),
  decisions: z.array(DecisionRefSchema),
  activeDelivery: DeliveryRefSchema.optional(),
  risks: z.array(RiskRefSchema),
  gates: z.array(GateRefSchema),
  evidence: z.array(EvidenceRefSchema),
  approvals: z.array(ApprovalRefSchema),
  handoffs: z.array(HandoffRefSchema),
  nextAction: z.object({
    description: z.string(),
    owner: z.string(),
    blockedBy: z.array(z.string()).optional(),
  }),
});
export type AgentTeamProjectStateV2 = z.infer<typeof AgentTeamProjectStateSchema>;

/**
 * Event envelope format. Unchanged by the v2 state migration: the hash chain
 * covers these bytes, so the envelope keeps its own version.
 */
export const AgentTeamEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  sequence: z.number().int().min(0),
  timestamp: z.string(),
  projectId: z.string(),
  engagementId: z.string(),
  sessionIdHash: z.string(),
  actor: z.string(),
  type: z.string(),
  payload: z.unknown(),
  previousHash: z.string(),
  hash: z.string(),
});
export type AgentTeamEventV1 = z.infer<typeof AgentTeamEventSchema>;

// ---- Tool input schemas (closed) ----

export const StateReadInput = z.object({ action: z.literal("read") }).strict();
export const StateInitInput = z
  .object({
    action: z.literal("initialize"),
    outcome: z.string().min(1),
    actors: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    acceptance: z.array(z.string()).optional(),
  })
  .strict();
export const StateTransitionInput = z
  .object({
    action: z.literal("transition"),
    expectedRevision: z.number().int().min(0),
    to: PhaseSchema,
    reason: z.string().min(1),
    nextAction: z.string().min(1),
    /**
     * Explicit work status. The status normally follows the phase, but a
     * leader must be able to mark an engagement FAILED or BLOCKED without
     * inventing a phase that means it.
     */
    status: WorkStatusSchema.optional(),
  })
  .strict();
export const StateGuardInput = z
  .object({
    action: z.literal("guard"),
    expectedRevision: z.number().int().min(0),
    mode: z.enum(["yolo", "guarded"]).optional(),
    add: z.array(z.string()).optional(),
    remove: z.array(z.string()).optional(),
    clear: z.boolean().optional(),
  })
  .strict();
export const AgentTeamStateInputSchema = z.union([StateReadInput, StateInitInput, StateTransitionInput, StateGuardInput]);

export const RecordAssumptionInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    statement: z.string().min(1),
    basis: z.enum(["USER_STATED", "OBSERVED_PATTERN", "INFERENCE", "PROPOSAL"]),
    confidence: z.enum(["low", "medium", "high"]),
    impact: z.string().min(1),
    validation: z.string().optional(),
    sourceRefs: z.array(z.string()).optional(),
  })
  .strict();

export const RecordDecisionInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    title: z.string().min(1),
    context: z.string().min(1),
    drivers: z.array(z.string()).min(1),
    options: z.array(DecisionOptionSchema).min(2).max(4),
    decision: z.string().min(1),
    rationale: z.string().min(1),
    consequences: z.array(z.string()),
    reversibility: z.enum(["easy", "moderate", "hard", "irreversible"]),
    authority: z.enum(["ALLOW", "ALLOW_WITH_RECORD", "ASK"]),
    /** Ids of the assumptions or evidence records this decision rests on. At least one must exist. */
    evidenceRefs: z.array(z.string()).min(1),
  })
  .strict();

export const DefineDeliveryInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    title: z.string().min(1),
    userOutcome: z.string().min(1),
    entryState: z.string().optional(),
    /** The one thin end-to-end flow this delivery proves. Required: a delivery without a path is not a delivery. */
    happyPath: z.array(z.string()).min(1),
    inScope: z.array(z.string()).optional(),
    outOfScope: z.array(z.string()).optional(),
    /** What the delivery may touch. Required: scope without a boundary is unbounded work. */
    allowedScope: z.array(z.string()).min(1),
    prohibitedScope: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).min(1),
    validationSteps: z.array(z.string()).min(1),
    proof: z.array(ProofSchema).optional(),
    risks: z.array(z.string()).optional(),
    rollback: z.string().min(1),
    owner: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

export const SubmitEvidenceInputSchema = z  .object({
    expectedRevision: z.number().int().min(0),
    criterionId: z.string().min(1),
    kind: z.enum(["test", "runtime", "visual", "source", "review", "release", "document", "metric", "judgment"]),
    status: z.enum(["pass", "fail", "partial", "skipped"]),
    summary: z.string().min(1),
    artifactRef: z.string().optional(),
    command: z.string().optional(),
    digest: z.string().optional(),
    observedAt: z.string().min(1),
    limitations: z.array(z.string()).optional(),
    /** The decision this row records. The plugin resolves the block itself. */
    decisionId: z.string().optional(),
    /** The block the specialist reported, used when the plugin holds no record of the decision. */
    judgment: JudgmentBlockSchema.optional(),
  })
  .strict();

/**
 * The decision tool's input.
 *
 * The criterion is required: a decision with no criterion has nothing to bind
 * to, and could be spent on any criterion later.
 */
export const DecisionQuestionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("predicate"),
      name: z.string().min(1),
      instructions: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      name: z.string().min(1),
      instructions: z.string().min(1),
      choices: z
        .array(
          z
            .object({
              value: z.union([z.string(), z.boolean()]),
              description: z.string().optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      name: z.string().min(1),
      instructions: z.string().min(1),
      levels: z
        .array(
          z
            .object({
              label: z.string().min(1),
              description: z.string().optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

export const EvaluateDecisionInputSchema = z
  .object({
    criterionId: z.string().min(1),
    state: z.string().min(1),
    questions: z.array(DecisionQuestionSchema).min(1),
    /** A stricter use than the caller's role carries. Never a looser one. */
    use: z.enum(DECISION_USES).optional(),
    /** A pinned decision model, as `provider/model`. */
    model: z.string().optional(),
  })
  .strict();

export const EvaluateGateInputSchema = z
  .object({
    gate: z.enum(["INTENT", "DISCOVERY", "PLAN", "VERIFY", "REVIEW", "ACCEPT", "DELIVER"]),
    claim: z.string().min(1),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export const ApprovalOpenInputSchema = z
  .object({
    action: z.literal("open"),
    expectedRevision: z.number().int().min(0),
    category: z.enum(["external_write", "release", "production", "destructive", "financial", "legal", "scope"]),
    requestedAction: z.string().min(1),
    resources: z.array(z.string()).min(1),
    reason: z.string().min(1),
    risks: z.array(z.string()),
    rollback: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .strict();
export const ApprovalResolveInputSchema = z
  .object({
    action: z.literal("resolve"),
    expectedRevision: z.number().int().min(0),
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    userMessageId: z.string().min(1),
  })
  .strict();
export const ApprovalInputSchema = z.union([ApprovalOpenInputSchema, ApprovalResolveInputSchema]);

/** One bounded unit of delegated work. */
export const HandoffUnitSchema = z
  .object({
    role: SpecialistRoleSchema,
    objective: z.string().min(1),
    context: z.array(z.string()),
    /**
     * What this unit may touch. Required, and non-empty: a unit with no
     * boundary has no scope to enforce, and scope that is not enforced is a
     * promise rather than a control.
     */
    allowedScope: z.array(z.string()).min(1),
    prohibitedScope: z.array(z.string()),
    questions: z.array(z.string()),
    requiredEvidence: z.array(z.string()),
    stopCondition: z.string().min(1),
    /** Skills the specialist must load before acting. */
    skills: z.array(z.string()).optional(),
    /** Handoff ids that must complete before this one can start. */
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();

export const HandoffPrepareInputSchema = z
  .object({
    action: z.literal("prepare"),
    expectedRevision: z.number().int().min(0),
    role: SpecialistRoleSchema,
    objective: z.string().min(1),
    context: z.array(z.string()),
    /** What this unit may touch. Non-empty: a unit with no boundary has no
     * scope to enforce. */
    allowedScope: z.array(z.string()).min(1),
    prohibitedScope: z.array(z.string()),
    questions: z.array(z.string()),
    requiredEvidence: z.array(z.string()),
    stopCondition: z.string().min(1),
    /** Skills the specialist must load before acting. */
    skills: z.array(z.string()).optional(),
    /** Handoff ids that must complete before this one can start. */
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();

/**
 * A whole wave in one call. Preparing a wave as a single mutation costs one
 * revision bump instead of one per unit, which is what keeps the leader's
 * revision stable while a wave is in flight.
 */
export const HandoffPrepareWaveInputSchema = z
  .object({
    action: z.literal("prepareWave"),
    expectedRevision: z.number().int().min(0),
    units: z.array(HandoffUnitSchema).min(1),
  })
  .strict();

export const HandoffCompleteInputSchema = z
  .object({
    action: z.literal("complete"),
    expectedRevision: z.number().int().min(0),
    handoffId: z.string().min(1),
    result: SpecialistResultSchema,
  })
  .strict();
export const HandoffCancelInputSchema = z
  .object({
    action: z.literal("cancel"),
    expectedRevision: z.number().int().min(0),
    handoffId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export const HandoffInputSchema = z.union([
  HandoffPrepareInputSchema,
  HandoffPrepareWaveInputSchema,
  HandoffCompleteInputSchema,
  HandoffCancelInputSchema,
]);
