import assert from "node:assert/strict";

import {
  createContainedTurnDispatchAuthorityFeature,
  createInMemoryDispatchConsumptionRepository,
  createNodeSha256DispatchDigest,
} from "../dist/composition.js";
import type { DispatchAuthorityHead } from "../dist/composition.js";
import type {
  ConsumeForDispatchInput,
  DispatchAuthorityScope,
} from "../dist/index.js";

export const scope: DispatchAuthorityScope = Object.freeze({
  tenantId: "tenant-a",
  projectId: "project-a",
  scopeDigest: "scope-digest-a",
});

export const authority = (
  overrides: Partial<DispatchAuthorityHead> = {},
): DispatchAuthorityHead => ({
  decision: "accepted",
  purpose: "contained-turn.provider-dispatch/v1",
  operationId: "operation-a",
  scope,
  authorityRevision: "authority-revision-7",
  acceptedAuthorityDigest: "accepted-authority-digest-a",
  authorityHeadDigest: "authority-head-digest-a",
  constraintsDigest: "constraints-digest-a",
  containmentPolicyDigest: "containment-policy-digest-a",
  requestDigest: "request-digest-a",
  providerId: "provider-a",
  authorityGeneration: "generation-a",
  providerBindingDigest: "provider-binding-digest-a",
  claimBindingDigest: "claim-binding-digest-a",
  claimBeforeControlTime: 200,
  revoked: false,
  ownerEvidenceRef: "runtime-security-evidence:v1:opaque-a",
  ...overrides,
});

export const input = (
  overrides: Partial<ConsumeForDispatchInput> = {},
): ConsumeForDispatchInput => ({
  purpose: "contained-turn.provider-dispatch/v1",
  operationId: "operation-a",
  scope,
  grantRequestId: "grant-request-a",
  requestDigest: "request-digest-a",
  providerId: "provider-a",
  authorityGeneration: "generation-a",
  providerBindingDigest: "provider-binding-digest-a",
  claimBindingDigest: "claim-binding-digest-a",
  acceptedAuthorityDigest: "accepted-authority-digest-a",
  expectedAuthorityHeadDigest: "authority-head-digest-a",
  expectedAuthorityRevision: "authority-revision-7",
  expectedConstraintsDigest: "constraints-digest-a",
  expectedContainmentPolicyDigest: "containment-policy-digest-a",
  ...overrides,
});

export const harness = (head: DispatchAuthorityHead = authority()) => {
  let controlTime = 100;
  const repository = createInMemoryDispatchConsumptionRepository([head]);
  const feature = createContainedTurnDispatchAuthorityFeature({
    repository,
    clock: { now: () => controlTime },
    digest: createNodeSha256DispatchDigest(),
  });
  return {
    authority: feature.dispatchAuthorityV1,
    repository,
    setControlTime: (value: number) => {
      controlTime = value;
    },
  };
};

export const assertDeepFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {return;}
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {assertDeepFrozen(nested);}
};
