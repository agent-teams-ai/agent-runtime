import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_MODEL_DEFAULT,
  CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT,
  CLAUDE_CODE_SETTINGS_DIALECT,
  type ClaudeCodeConfigurationDialect,
  type ClaudeCodeEffort,
  type ClaudeCodeModelAlias,
} from "../../contracts/claude-code-configuration-inspection.js";
import {
  CLAUDE_CODE_BUDGETS,
  CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_DIALECT,
  CLAUDE_CODE_EFFORT_VOCABULARY,
  CLAUDE_CODE_MODEL_VOCABULARY,
  CLAUDE_CODE_SOURCE_PLAN_CONTRACT,
  type ClaudeCodeDialect,
  type ClaudeCodeEffortLevel,
  type ClaudeCodeModelName,
} from "../../application/models/claude-code-vocabulary.js";

/** The standard leaves no layer that both `contracts` and `application` may
 * import, so a value both need is declared twice. This adapter is the only file
 * that sees both declarations, and it is where the duplication is paid for. */

type Equals<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// Compile-time: the published unions and the application vocabulary describe the
// same values, so a member added to one side and not the other fails the build.
export type DialectsAgree = Expect<Equals<ClaudeCodeConfigurationDialect, ClaudeCodeDialect>>;
export type ModelsAgree = Expect<Equals<ClaudeCodeModelAlias, ClaudeCodeModelName>>;
export type EffortsAgree = Expect<Equals<ClaudeCodeEffort, ClaudeCodeEffortLevel>>;

const sameOrder = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Runtime: ordering and numeric budgets are not expressible as types, and both
 * are observable. Model alias order decides precedence reporting, and a budget
 * that differs by one byte changes which input is refused. */
export const assertClaudeCodeVocabularyParity = (): void => {
  if (CLAUDE_CODE_SETTINGS_DIALECT !== CLAUDE_CODE_DIALECT
    || CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT !== CLAUDE_CODE_SOURCE_PLAN_CONTRACT
    || CLAUDE_CODE_MODEL_DEFAULT !== CLAUDE_CODE_DEFAULT_MODEL
    || !sameOrder(CLAUDE_CODE_MODEL_ALIASES, CLAUDE_CODE_MODEL_VOCABULARY)
    || !sameOrder(CLAUDE_CODE_EFFORT_VALUES, CLAUDE_CODE_EFFORT_VOCABULARY)) {
    throw new TypeError("published Claude Code vocabulary and application vocabulary disagree");
  }
  const published = Object.entries(CLAUDE_CODE_CONFIGURATION_BUDGETS).toSorted(([left], [right]) => left < right ? -1 : 1);
  const applied = Object.entries(CLAUDE_CODE_BUDGETS).toSorted(([left], [right]) => left < right ? -1 : 1);
  if (published.length !== applied.length
    || published.some(([key, value], index) => applied[index]?.[0] !== key || applied[index]?.[1] !== value)) {
    throw new TypeError("published Claude Code budgets and enforced budgets disagree");
  }
};
