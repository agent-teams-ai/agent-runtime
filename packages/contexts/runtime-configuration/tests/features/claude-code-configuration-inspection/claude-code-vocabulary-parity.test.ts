import assert from "node:assert/strict";
import test from "node:test";

import {
  appliedClaudeCodeVocabulary,
  assertClaudeCodeVocabularyParity,
  publishedClaudeCodeVocabulary,
} from "../../../dist/features/claude-code-configuration-inspection/adapters/inbound/claude-code-vocabulary-parity.js";

test("the published vocabulary and the enforced vocabulary agree today", () => {
  assert.doesNotThrow(() => assertClaudeCodeVocabularyParity());
});

// The duplication between contracts and application exists because the standard
// gives them no shared layer. That is only safe while drift is impossible, so the
// guard itself has to be shown to fire, not merely to pass.
const drifts: Record<string, () => ReturnType<typeof appliedClaudeCodeVocabulary>> = {
  "a reordered model vocabulary": () => {
    const applied = appliedClaudeCodeVocabulary();
    const modelVocabulary = [...applied.modelVocabulary];
    [modelVocabulary[0], modelVocabulary[1]] = [modelVocabulary[1]!, modelVocabulary[0]!];
    return { ...applied, modelVocabulary };
  },
  "a removed effort level": () => {
    const applied = appliedClaudeCodeVocabulary();
    return {
      ...applied,
      effortVocabulary: applied.effortVocabulary.filter((value) => value !== "xhigh"),
    };
  },
  "a changed byte budget": () => {
    const applied = appliedClaudeCodeVocabulary();
    return {
      ...applied,
      budgets: { ...applied.budgets, bytesPerSource: applied.budgets.bytesPerSource - 1_024 },
    };
  },
  "a changed dialect identifier": () => {
    const applied = appliedClaudeCodeVocabulary();
    return { ...applied, dialect: "claude-code-settings@2026-08-29" };
  },
};

for (const [name, drift] of Object.entries(drifts)) {
  test(`the parity guard refuses ${name}`, () => {
    const published = publishedClaudeCodeVocabulary();
    const applied = appliedClaudeCodeVocabulary();
    const drifted = drift();
    assert.notDeepEqual(drifted, applied, "the drift must actually change the application vocabulary");
    assert.throws(() => assertClaudeCodeVocabularyParity(published, drifted), TypeError);
  });
}
