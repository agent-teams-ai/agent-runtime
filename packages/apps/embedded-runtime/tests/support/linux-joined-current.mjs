import assert from "node:assert/strict";
import {fixture as currentOwnersFixture} from "../contained-turn-current-egress-owners.fixture.ts";
import {createContainedTurnHttpEgressRoute} from "../../dist/composition/contained-turn-http-egress-upstream.js";

/** Synthetic external authority repositories, actual PA route and RS current
 * owner projection. Call after durable acceptance, before resource selection.
 * No new binding or permission is inferred from an HTTP request. */
export const joinedCurrentOwners = async ({operation, binding}) => {
  const scope = {tenantId: operation.scope.tenantId, projectId: operation.scope.projectId,
    scopeDigest: operation.acceptedAuthorityVector.scopeDigest};
  assert.equal(binding.tenantId, scope.tenantId);
  assert.equal(binding.projectId, scope.projectId);
  const fixture = await currentOwnersFixture("codex-chatgpt", "codex-chatgpt-responses/v1", {
    binding: {...scope, accessRef: binding.accessRef, provider: "codex",
      providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef,
      credentialBindingRef: binding.credentialBindingRef, credentialBindingDigest: binding.ownerAuthorityDigest,
      credentialGeneration: binding.credentialGeneration, bindingRevision: binding.revision},
    authority: {scope, operationId: operation.operationId, providerId: "codex"},
  });
  try {
    const projected = await createContainedTurnHttpEgressRoute({current: await fixture.paOwner.readCurrent(), provider: "codex"});
    assert.equal(projected.providerAccessSnapshot.scopeDigest, scope.scopeDigest);
    assert.equal(fixture.input.operation.scope.operationId, operation.operationId);
    return {...fixture, ...projected};
  } catch (error) {fixture.dispose(); throw error;}
};
