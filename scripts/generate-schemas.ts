/**
 * Regenerates the published JSON Schemas from the Zod source of truth.
 *
 * Run with `npm run schemas:generate`. The drift check in
 * `test/unit/schemas-published.test.ts` fails if the files on disk differ
 * from what this produces.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePublishedSchemas } from "../src/ledger/schema-gen.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemasDir = path.join(repoRoot, "schemas");

fs.mkdirSync(schemasDir, { recursive: true });
for (const { file, schema } of generatePublishedSchemas()) {
  const target = path.join(schemasDir, file);
  fs.writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  console.error(`[schemas] wrote ${path.relative(repoRoot, target)}`);
}
