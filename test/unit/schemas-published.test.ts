import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { generatePublishedSchemas } from "../../src/ledger/schema-gen.js";

/**
 * The published JSON Schemas are generated from the Zod source of truth.
 * Hand-written copies drifted silently: they typed the key collections as
 * bare `{"type":"object"}`, so they could never detect the drift they
 * existed to prevent, and nothing in the codebase read them.
 *
 * This test is the drift detector. Regenerate with `npm run schemas:generate`.
 */
describe("published schemas", () => {
  const schemasDir = path.resolve("schemas");

  for (const { file, schema } of generatePublishedSchemas()) {
    it(`schemas/${file} matches the Zod source of truth`, () => {
      const onDisk = JSON.parse(fs.readFileSync(path.join(schemasDir, file), "utf8"));
      expect(onDisk).toEqual(schema);
    });

    it(`schemas/${file} types its collections`, () => {
      const properties = (schema as { properties?: Record<string, { type?: string; items?: unknown }> }).properties ?? {};
      for (const [key, value] of Object.entries(properties)) {
        if (value.type !== "array") continue;
        expect(value.items, `${file}.${key} must type its items`).toBeDefined();
        expect(value.items).not.toEqual({});
      }
    });
  }
});
