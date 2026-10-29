# Style Guide

The conventions of this codebase, and the reason behind each one. Nothing here is
a matter of taste — every rule below exists because the opposite caused a bug, a
broken build on a supported OpenCode version, or an unreviewable diff.

The compiler is strict: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
and `noEmit` are all on (see `tsconfig.json`). The house style works with that
configuration rather than around it.

## Language and runtime

- TypeScript 5.9, ESM, `NodeNext` module resolution, Node 22 or newer.
- The package **ships TypeScript source**. `package.json` exports `./src/index.ts`
  and there is no build step; the OpenCode host loads the source directly. This is
  why there is no `dist/` and why `npm run pack:check` inspects the tarball
  contents instead of a build output.
- **Never use a TypeScript `enum` or `namespace`.** Both are non-erasable syntax
  and would break the type-stripping execution path. Model closed sets with
  Zod: `z.enum([...])`.

## Formatting

From `.editorconfig`:

- Two-space indentation, LF line endings, UTF-8, final newline.
- Trailing whitespace is trimmed everywhere except Markdown files.
- Double quotes for strings. Single quotes appear only inside regular expressions.

There is no formatter or linter configured. Match the surrounding code.

## Imports and exports

- **Every relative import carries a `.js` extension**, even though the file on
  disk is `.ts`: `import { parseOptions } from "./options.js";`. `NodeNext`
  resolution requires it, and the same specifiers must work at runtime.
- **Type-only imports use `import type`.** `verbatimModuleSyntax` is on, so a
  value import of a type is an error.
- **Named exports everywhere.** The single default export in the codebase is the
  plugin entry in `src/index.ts`, because `Plugin.define` requires it.
- **Declare functions with `export function`.** Do not use `export const fn = () => {}`.
  The codebase has 90+ exported function declarations and zero exported arrow
  constants; hoisting and stack traces both read better this way.
- Use `interface` for object shapes and `type` for unions and aliases.

## Types at the plugin boundary

The OpenCode host API is not fully typed across the three supported SDK lines, so
the boundary is handled deliberately:

- **Host surfaces you cannot rely on are read through `unknown`** and narrowed by
  feature detection. `resolveTextGenerator` in `src/compat/host.ts` is the
  reference implementation: it prefers `ctx.experimental.generate.text` when that
  exists and falls back to `ctx.generate.text`, and it throws a typed
  `UnsupportedHostError` when neither is present.
- **`any` is confined to the host callback boundary** — hook handlers and the
  `ctx.*.transform` editors receive loosely typed arguments from the SDK and are
  cast back to the expected shape at the call site (`tool as never`).
- Elsewhere, prefer `unknown` plus narrowing. `unknown` appears about four times
  as often as `any` in `src/`, and the difference is deliberate.

## Tool definitions

A tool is one file in `src/tools/`. The shape is fixed:

```ts
export const EVIDENCE_TOOL = {
  name: "submit_evidence",
  description: "Submit criterion-linked evidence (...)",
  input: {
    type: "object",
    properties: { /* ... */ },
    required: ["expectedRevision", "criterionId", "kind", "status", "summary", "observedAt"],
    additionalProperties: false,
  },
} as const;

export async function executeEvidence(runtime: AgentTeamRuntime, rawInput: unknown, tool: ToolContext): Promise<{ content: string }> { /* ... */ }
```

Rules that the tool contract depends on:

- The input is a **closed** JSON Schema: `additionalProperties: false`, every
  property typed, and the `required` list is the actual minimum.
- The definition object ends with `as const`. That is a compile-time type
  assertion, not `Object.freeze` — the object is not frozen at runtime, and
  nothing claims it is.
- The file **imports** the matching Zod input schema from `src/domain/schemas.ts`
  and validates with it, rather than reading the declared JSON Schema. The JSON
  Schema is the contract the host sees; the Zod schema is the contract the
  plugin enforces, and the two must agree.
- The declared JSON Schema must list every field the execute function reads. A
  field the handler accepts but the schema omits is unreachable through a host
  that validates inputs — which is how `agent_team_state`'s `status` override
  became unreachable while still passing its tests.
- The execute function receives `rawInput: unknown` and parses it itself, so the
  validation error surfaces as a tool error rather than a host-level rejection.
- Register the tool in `src/tools/index.ts` under the `agent_team` namespace, and
  bump the expected tool count in `src/doctor/checks.ts` and in
  `test/integration/contracts.test.ts`.

## Naming

| Thing | Convention | Example |
|---|---|---|
| File | kebab-case | `skill-registration.ts`, `schema-gen.ts` |
| Function, variable | camelCase | `parseOptions`, `expectedRevision` |
| Type, interface | PascalCase | `AgentTeamRuntime`, `StoreContext` |
| Tool definition constant | SCREAMING_SNAKE | `EVIDENCE_TOOL`, `HANDOFF_TOOL` |
| Ledger event type | dotted, lowercase | `evidence.submitted`, `delivery.defined` |
| Ledger document id | Prefix + zero-padded number | `DEC-0001`, `DEL-001`, `EVD-0001`, `HND-0001` |
| Skill id | `agent-team-` prefix, kebab-case | `agent-team-evidence-gate` |
| Agent id | `team-leader` or `team-leader/<role>` | `team-leader/reviewer` |

One deliberate split: **the TypeScript API is camelCase, the on-disk delivery
contract is snake_case.** `executeDelivery` takes `userOutcome` and writes
`user_outcome:` into `.agent-team/deliveries/DEL-001.yaml`. The YAML is a human- and
model-facing contract; the API is not. Do not "fix" the mismatch by making them
the same.

## Errors

- Fail with `throw new Error(...)`. There is no custom error hierarchy in `src/`;
  the only subclass is `UnsupportedHostError`, which exists because the host
  incompatibility has to be distinguishable from an ordinary failure.
- **Messages are lowercase and actionable.** They say what was wrong and, where
  possible, what is valid instead:

  ```ts
  throw new Error(`unknown criterionId ${input.criterionId}; active delivery declares: ${criteria.join(", ")}`);
  throw new Error(`stale revision: expected ${expectedRevision}, actual ${current.revision}`);
  ```

  The exceptions are the `Agent Team DENY: …` messages the scope and injection
  refusals raise. Those are read by a human reading a refusal, so they are
  capitalised and carry the prefix.

- Error text is part of the contract. The gate, tool and handoff errors are read by
  models driving the plugin, and the tests assert on them.
- Return success with `toolOk(data)` from `src/runtime.ts`, which serialises to the
  host's `{ content }` shape. `toolErr` throws.

## Async

`async`/`await` throughout. There are no `.then()` chains in `src/`.

## Comments

**Add a comment only when it is highly necessary to explain non-obvious intent, a
workaround, or a critical constraint.** The house style states the *failure the
guard prevents* rather than restating the code:

```ts
// Good — names the failure this rule exists for.
// Last matching rule wins.
//
// A rule whose matcher throws is not treated as "did not match". Treating it
// that way would let a broken DENY rule fall through to ALLOW, which is the
// exact opposite of "DENY is final". The matrix therefore fails closed: an
// unevaluable rule denies.

// Bad — restates the code.
// Increment the counter.
```

JSDoc blocks (`/** ... */`) are used for exported functions whose contract is not
obvious from the signature, and for file-level explanations of a module's role.
Inline `//` comments explain a specific decision inside a function.

When you delete code, delete its comment with it. A comment that describes
behaviour that no longer exists is worse than no comment.

## Tests

Same conventions as the source, plus:

- `describe` / `it` with a sentence that states the property being protected, not
  the mechanism: `"the authority matrix fails closed"`, not `"classifyAuthority 2"`.
- **Name the failure in the test title.** The suite reads as a list of guarantees.
- Use real temporary directories and real files for anything touching the ledger,
  filesystem or paths. Mocks of the filesystem defeat the point of those tests.
