/**
 * Checks the plugin against every supported OpenCode SDK line.
 *
 * The CI matrix runs the same thing; this script is the local equivalent, so
 * a compatibility break is found before it is pushed rather than after.
 *
 * The SDK is installed by swapping its published package into the tree, not
 * by resolving it fresh. A fresh `npm install @opencode/plugin@X` drags in
 * the whole provider-SDK tree, and that tree is not always installable: the
 * published SDKs currently require an `@aws-sdk/core` range that the
 * registry does not satisfy, so a fresh resolve fails on a transitive
 * dependency that has nothing to do with this plugin. Swapping the package
 * tests exactly what matters — that the plugin's source compiles and its
 * suite passes against that SDK's own typings.
 *
 * Usage: `npm run compat:check` (every line)
 *        `npx tsx scripts/compat-check.ts 2.2.0` (one line, for a CI matrix)
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ALL_SDKS = ["2.0.10", "2.1.4", "2.2.0"];
const requested = process.argv[2];
const SUPPORTED_SDKS = requested ? [requested] : ALL_SDKS;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: string[], cwd: string): { code: number; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Downloads and extracts an SDK release without resolving its dependency tree. */
function fetchSdk(version: string, target: string): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-sdk-"));
  try {
    const packed = run("npm", ["pack", `@opencode/plugin@${version}`, "--silent"], scratch);
    if (packed.code !== 0) {
      throw new Error(`could not download @opencode/plugin@${version}:\n${packed.output}`);
    }
    const tarball = fs.readdirSync(scratch).find((f) => f.endsWith(".tgz"));
    if (!tarball) throw new Error(`no tarball was produced for @opencode/plugin@${version}`);
    const extracted = path.join(scratch, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    const untar = run("tar", ["xzf", path.join(scratch, tarball), "-C", extracted], scratch);
    if (untar.code !== 0) throw new Error(`could not unpack @opencode/plugin@${version}:\n${untar.output}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(extracted, "package"), target, { recursive: true });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

let failed = false;
for (const sdk of SUPPORTED_SDKS) {
  console.error(`\n[compat] @opencode/plugin@${sdk}`);
  // A scratch copy so the working tree's lockfile and node_modules are never touched.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-compat-"));
  try {
    for (const entry of ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts"]) {
      fs.copyFileSync(path.join(repoRoot, entry), path.join(scratch, entry));
    }
    for (const dir of ["src", "test", "fixtures", "assets", "bench", "schemas"]) {
      fs.cpSync(path.join(repoRoot, dir), path.join(scratch, dir), { recursive: true });
    }
    // The resolved tree comes from the repository; only the SDK itself is
    // swapped. `.bin` is skipped: its entries are symlinks that do not
    // survive the copy, and the tools are invoked directly instead.
    fs.cpSync(path.join(repoRoot, "node_modules"), path.join(scratch, "node_modules"), {
      recursive: true,
      dereference: true,
      filter: (src) =>
        !src.includes(`${path.sep}@opencode${path.sep}plugin`) && !src.includes(`${path.sep}.bin${path.sep}`),
    });
    const sdkTarget = path.join(scratch, "node_modules", "@opencode", "plugin");
    try {
      fetchSdk(sdk, sdkTarget);
    } catch (err) {
      console.error((err as Error).message);
      failed = true;
      continue;
    }
    const typecheck = run("node", [path.join(scratch, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], scratch);
    if (typecheck.code !== 0) {
      console.error(typecheck.output);
      failed = true;
      continue;
    }
    const tests = run(
      "node",
      [path.join(scratch, "node_modules", "vitest", "vitest.mjs"), "run", "test/unit", "test/integration"],
      scratch,
    );
    if (tests.code !== 0) {
      console.error(tests.output);
      failed = true;
      continue;
    }
    console.error(`[compat] @opencode/plugin@${sdk} OK`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("\n[compat] FAILED: the plugin does not build and pass on every supported SDK line");
  process.exit(1);
}
console.error("\n[compat] OK: the plugin builds and passes on every supported SDK line");
