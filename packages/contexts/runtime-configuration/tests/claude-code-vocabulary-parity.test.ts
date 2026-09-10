import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertClaudeCodeVocabularyParity } from "../dist/features/claude-code-configuration-inspection/adapters/inbound/claude-code-vocabulary-parity.js";

const parityModule = fileURLToPath(new URL(
  "../dist/features/claude-code-configuration-inspection/adapters/inbound/claude-code-vocabulary-parity.js",
  import.meta.url,
));

test("the published vocabulary and the enforced vocabulary agree today", () => {
  assert.doesNotThrow(() => assertClaudeCodeVocabularyParity());
});

// The duplication between contracts and application exists because the standard
// gives them no shared layer. That is only safe while drift is impossible, so the
// guard itself has to be shown to fire, not merely to pass.
const drifts = {
  "a reordered model vocabulary": (source: string) =>
    source.replace('"best", "fable"', '"fable", "best"'),
  "a removed effort level": (source: string) =>
    source.replace(', "xhigh"]', "]"),
  "a changed byte budget": (source: string) =>
    source.replace("bytesPerSource: 128 * 1_024", "bytesPerSource: 127 * 1_024"),
  "a changed dialect identifier": (source: string) =>
    source.replace('"claude-code-settings@2026-08-28"', '"claude-code-settings@2026-08-29"'),
};

for (const [name, drift] of Object.entries(drifts)) {
  test(`the parity guard refuses ${name}`, async () => {
    const published = await readFile(fileURLToPath(new URL(
      "../dist/features/claude-code-configuration-inspection/contracts/claude-code-configuration-inspection.js",
      import.meta.url,
    )), "utf8");
    const applied = await readFile(fileURLToPath(new URL(
      "../dist/features/claude-code-configuration-inspection/application/models/claude-code-vocabulary.js",
      import.meta.url,
    )), "utf8");
    const drifted = drift(applied);
    assert.notEqual(drifted, applied, "the drift must actually change the application vocabulary");
    // Load the guard against a drifted application vocabulary through a data URL,
    // so the check runs against real modules without writing into the package.
    const guard = await readFile(parityModule, "utf8");
    const module = await import(`data:text/javascript,${encodeURIComponent(
      guard
        .replace(/from "\.\.\/\.\.\/contracts\/[^"]+"/u, `from "data:text/javascript,${encodeURIComponent(published)}"`)
        .replace(/from "\.\.\/\.\.\/application\/models\/[^"]+"/u, `from "data:text/javascript,${encodeURIComponent(drifted)}"`),
    )}`) as { assertClaudeCodeVocabularyParity: () => void };
    assert.throws(() => module.assertClaudeCodeVocabularyParity(), TypeError);
  });
}
