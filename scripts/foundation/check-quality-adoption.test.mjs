import assert from "node:assert/strict";
import test from "node:test";
import { assertQualityAdoption, readQualityAdoption } from "./check-quality-adoption.mjs";

const accepted = await readQualityAdoption();
test("published quality activation retains the accepted consumer contract", () => {
  assertQualityAdoption(accepted);
});

const mutations = {
  missing: value => { delete value.foundation.capabilities["quality.source-coverage"]; },
  disabled: value => { value.foundation.capabilities["quality.source-coverage"].enabled = false; },
  "wrong profile": value => { value.foundation.capabilities["quality.source-coverage"].configPath = "other.yaml"; },
  "wrong authority": value => { value.profile.featureProfilePath = "other.json"; },
  "wrong pin": value => { value.manifest.devDependencies["@agent-teams/engineering-foundation"] = "^1.6.0"; },
  "stale pin": value => { value.manifest.devDependencies["@agent-teams/engineering-foundation"] = "1.5.1"; },
  "missing typed lint companion": value => { delete value.manifest.devDependencies["oxlint-tsgolint"]; },
  "no-op scope": value => { value.manifest.scripts["quality:coverage:scope"] = "true"; },
  "no-op typed": value => { value.manifest.scripts["lint:typed"] = "true"; },
  "removed fast route": value => { value.manifest.scripts["check:fast"] = "pnpm lint"; },
  "removed full route": value => { value.manifest.scripts.check = "pnpm lint"; }
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`quality activation rejects ${name}`, () => {
    const value = structuredClone(accepted);
    mutate(value);
    assert.throws(() => assertQualityAdoption(value), assert.AssertionError);
  });
}
