/**
 * Scope matching for handoffs and deliveries.
 *
 * `allowedScope` and `prohibitedScope` are real fields on a handoff: they
 * are echoed into the packet the specialist receives. Until now they were
 * advisory only — nothing checked a specialist's writes against them. These
 * helpers make them enforceable.
 *
 * The scope syntax is deliberately small: a path, or a path with a trailing
 * `/**` for a subtree. It matches the shapes the templates actually use
 * (`src/**`, `docs/**`, `src/board.ts`).
 */

/** Normalises a scope entry to a directory prefix, or null for a plain path. */
function directoryPrefix(pattern: string): string | null {
  const trimmed = pattern.trim().replace(/^\.\//, "");
  if (trimmed.endsWith("/**")) return trimmed.slice(0, -3);
  return null;
}

/** True when `path` falls inside `pattern`. */
export function pathInScope(path: string, pattern: string): boolean {
  const target = path.trim().replace(/^\.\//, "");
  if (target.length === 0) return false;
  const prefix = directoryPrefix(pattern);
  if (prefix !== null) {
    if (prefix.length === 0) return true; // `/**` is the whole tree
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  // A plain pattern matches the exact path, or a file inside a named
  // directory (`docs` matches `docs/notes.md`).
  return target === pattern.trim() || target.startsWith(`${pattern.trim()}/`);
}

/** True when the path is inside at least one allowed pattern. */
export function pathAllowed(path: string, scope: string[]): boolean {
  if (scope.length === 0) return true; // no scope declared: nothing to enforce
  return scope.some((pattern) => pathInScope(path, pattern));
}

/** True when the path falls inside at least one prohibited pattern. */
export function pathProhibited(path: string, scope: string[]): boolean {
  return scope.some((pattern) => pathInScope(path, pattern));
}

/**
 * True when two scope lists point at overlapping work. Used to check that a
 * reviewer was actually pointed at what was built.
 */
export function scopeOverlaps(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const px = directoryPrefix(x);
      const py = directoryPrefix(y);
      if (px !== null && py !== null) {
        if (px === py || px.startsWith(`${py}/`) || py.startsWith(`${px}/`)) return true;
        continue;
      }
      if (px !== null) {
        if (pathInScope(y, x) || pathInScope(x, y)) return true;
        continue;
      }
      if (py !== null) {
        if (pathInScope(y, x) || pathInScope(x, y)) return true;
        continue;
      }
      // Two plain paths overlap only when one contains the other.
      if (x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}
