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

export interface ClaudeCodeVocabularySnapshot {
  readonly budgets: Readonly<Record<string, number>>;
  readonly dialect: string;
  readonly effortVocabulary: readonly string[];
  readonly modelDefault: string;
  readonly modelVocabulary: readonly string[];
  readonly sourcePlanContract: string;
}

export const publishedClaudeCodeVocabulary = (): ClaudeCodeVocabularySnapshot => ({
  budgets: CLAUDE_CODE_CONFIGURATION_BUDGETS,
  dialect: CLAUDE_CODE_SETTINGS_DIALECT,
  effortVocabulary: CLAUDE_CODE_EFFORT_VALUES,
  modelDefault: CLAUDE_CODE_MODEL_DEFAULT,
  modelVocabulary: CLAUDE_CODE_MODEL_ALIASES,
  sourcePlanContract: CLAUDE_CODE_OBSERVED_SOURCE_PLAN_CONTRACT,
});

export const appliedClaudeCodeVocabulary = (): ClaudeCodeVocabularySnapshot => ({
  budgets: CLAUDE_CODE_BUDGETS,
  dialect: CLAUDE_CODE_DIALECT,
  effortVocabulary: CLAUDE_CODE_EFFORT_VOCABULARY,
  modelDefault: CLAUDE_CODE_DEFAULT_MODEL,
  modelVocabulary: CLAUDE_CODE_MODEL_VOCABULARY,
  sourcePlanContract: CLAUDE_CODE_SOURCE_PLAN_CONTRACT,
});

/** Runtime: ordering and numeric budgets are not expressible as types, and both
 * are observable. Model alias order decides precedence reporting, and a budget
 * that differs by one byte changes which input is refused. */
export const assertClaudeCodeVocabularyParity = (
  published = publishedClaudeCodeVocabulary(),
  applied = appliedClaudeCodeVocabulary(),
): void => {
  if (published.dialect !== applied.dialect
    || published.sourcePlanContract !== applied.sourcePlanContract
    || published.modelDefault !== applied.modelDefault
    || !sameOrder(published.modelVocabulary, applied.modelVocabulary)
    || !sameOrder(published.effortVocabulary, applied.effortVocabulary)) {
    throw new TypeError("published Claude Code vocabulary and application vocabulary disagree");
  }
  const publishedBudgets = Object.entries(published.budgets).toSorted(([left], [right]) => left < right ? -1 : 1);
  const appliedBudgets = Object.entries(applied.budgets).toSorted(([left], [right]) => left < right ? -1 : 1);
  if (publishedBudgets.length !== appliedBudgets.length
    || publishedBudgets.some(([key, value], index) => appliedBudgets[index]?.[0] !== key || appliedBudgets[index]?.[1] !== value)) {
    throw new TypeError("published Claude Code budgets and enforced budgets disagree");
  }
};
