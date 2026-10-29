import { z } from "zod";
import {
  AgentTeamEventSchema,
  AgentTeamProjectStateSchema,
  SpecialistResultSchema,
} from "../domain/schemas.js";

/**
 * The published JSON Schemas are generated from the Zod definitions, not
 * written by hand. Hand-written copies drifted: they typed the key
 * collections as bare `{"type":"object"}`, so they could never detect the
 * drift they existed to prevent, and nothing in the codebase read them.
 *
 * `z.toJSONSchema` emits draft-07, the dialect the published files use.
 */

const SCHEMA_BASE = "https://github.com/lindoelio/opencode-agent-team/schemas";

export interface PublishedSchema {
  file: string;
  title: string;
  schema: Record<string, unknown>;
}

function describe(title: string, id: string, source: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(source, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${SCHEMA_BASE}/${id}.json`,
    title,
    ...generated,
  };
}

/** Every published schema, in the order they are written to disk. */
export function generatePublishedSchemas(): PublishedSchema[] {
  return [
    { file: "state-v2.json", title: "AgentTeamProjectStateV2", schema: describe("AgentTeamProjectStateV2", "state-v2", AgentTeamProjectStateSchema) },
    { file: "event-v1.json", title: "AgentTeamEventV1", schema: describe("AgentTeamEventV1", "event-v1", AgentTeamEventSchema) },
    { file: "specialist-result-v1.json", title: "SpecialistResultV1", schema: describe("SpecialistResultV1", "specialist-result-v1", SpecialistResultSchema) },
  ];
}
