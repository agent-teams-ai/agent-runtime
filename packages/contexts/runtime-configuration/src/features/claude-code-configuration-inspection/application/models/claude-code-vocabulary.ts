/** The vocabulary and budgets the use cases reason with.
 *
 * This is a second declaration of values the feature also publishes in
 * `contracts/`, and that duplication is deliberate rather than an oversight. The
 * standard gives `contracts` no layer it may import and gives `application` no
 * access to `contracts`, so a value both need cannot live in one place. Rather
 * than leave the application importing its own transport surface, each side owns
 * its declaration and `adapters/inbound/claude-code-vocabulary-parity.ts` refuses
 * to let them drift, at compile time and when the feature is constructed.
 *
 * The application side is the authority for behavior: these are the values the
 * use cases enforce. The contract side is the authority for what callers are
 * told. They must agree, and the parity guard is what makes that a fact rather
 * than an intention. */

export const CLAUDE_CODE_DIALECT = "claude-code-settings@2026-08-28" as const;

export const CLAUDE_CODE_SOURCE_PLAN_CONTRACT = "claude-code-observed-source-plan/v1" as const;

export const CLAUDE_CODE_DEFAULT_MODEL = "default" as const;

export const CLAUDE_CODE_MODEL_VOCABULARY = [
  "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]", "opusplan",
] as const;

export const CLAUDE_CODE_EFFORT_VOCABULARY = ["low", "medium", "high", "xhigh"] as const;

/** Enforcement limits, not suggestions: every one of these is a refusal boundary
 * the use case applies before it allocates or reads anything further. */
export const CLAUDE_CODE_BUDGETS = Object.freeze({
  aggregateSourceBytes: 1_024 * 1_024,
  arrayItems: 1_024,
  bytesPerSource: 128 * 1_024,
  classifierValueLength: 256,
  depth: 16,
  diagnostics: 1_024,
  identifierLength: 128,
  keyLength: 256,
  locationClaimsPerSource: 4,
  nodes: 4_096,
  objectKeys: 1_024,
  pathLength: 16_384,
  rootSlots: 16,
  sourceSlots: 16,
  stringLength: 16_384,
});

export type ClaudeCodeDialect = typeof CLAUDE_CODE_DIALECT;
export type ClaudeCodeModelName = typeof CLAUDE_CODE_MODEL_VOCABULARY[number];
export type ClaudeCodeEffortLevel = typeof CLAUDE_CODE_EFFORT_VOCABULARY[number];
