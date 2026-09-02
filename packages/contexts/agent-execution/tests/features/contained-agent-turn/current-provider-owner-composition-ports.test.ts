import assert from "node:assert/strict";
import { test } from "node:test";

import { containedTurnFactoryPortKeys } from "./support/current-provider-owner-composition-ports.ts";

const compositionWith = (properties: string) => `
  export const createContainedTurnFeatureFromProviderAccess = dependencies => {
    return createContainedTurnFeature(Object.freeze({${properties}}));
  };
`;

test("contained turn composition port inspection rejects hidden dependency properties", async t => {
  await t.test("unknown identifier", () => {
    assert.throws(() => containedTurnFactoryPortKeys(compositionWith(
      "operationStore, security, providerAccess, workspace, artifacts, custody, provider, unexpected",
    )), /exact seven ports/u);
  });
  await t.test("spread", () => {
    assert.throws(() => containedTurnFactoryPortKeys(compositionWith("operationStore, ...dependencies")),
      /cannot use spread properties/u);
  });
  await t.test("computed key", () => {
    assert.throws(() => containedTurnFactoryPortKeys(compositionWith("operationStore, [dependencies.key]: provider")),
      /cannot be computed/u);
  });
  await t.test("literal key", () => {
    assert.throws(() => containedTurnFactoryPortKeys(compositionWith("operationStore, 'provider': provider")),
      /must be identifiers/u);
  });
});
