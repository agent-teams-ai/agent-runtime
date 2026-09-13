import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnEgressGateway } from "../../dist/composition.js";
import { authority as dispatchHead, harness as dispatchHarness } from
  "../features/contained-turn-dispatch-authority/contained-turn-dispatch-authority.fixtures.ts";
import { dispatch, harness, host, request, route } from
  "../features/contained-turn-egress/contained-turn-egress.fixture.ts";

test("an owner-consumed and settled dispatch receipt authorizes only its selected Provider Access route", async () => {
  const owner = dispatchHarness(dispatchHead({scope: dispatch.scope, operationId: dispatch.operationId,
    requestDigest: dispatch.requestDigest, providerId: dispatch.providerId, authorityGeneration: dispatch.authorityGeneration,
    providerBindingDigest: dispatch.providerBindingDigest, claimBindingDigest: dispatch.claimBindingDigest,
    acceptedAuthorityDigest: dispatch.acceptedAuthorityDigest, authorityRevision: dispatch.expectedAuthorityRevision,
    authorityHeadDigest: dispatch.expectedAuthorityHeadDigest, constraintsDigest: dispatch.expectedConstraintsDigest,
    containmentPolicyDigest: dispatch.expectedContainmentPolicyDigest})); const consumed = await owner.authority.consumeForDispatch(dispatch);
  assert.equal(consumed.status, "consumed"); if (consumed.status !== "consumed") {return;}
  await owner.authority.settleDispatchConsumption({scope: dispatch.scope, providerId: dispatch.providerId,
    authorityGeneration: dispatch.authorityGeneration, operationId: dispatch.operationId, grantRequestId: dispatch.grantRequestId,
    settlementRequestId: "settlement-1", consumptionDigest: consumed.receipt.consumptionDigest, disposition: "claim_committed"});
  const committed = await owner.authority.observeDispatchConsumption(dispatch);
  assert.equal(committed.status, "consumed"); if (committed.status !== "consumed") {return;}
  assert.equal(committed.lifecycleState, "claim_committed");
  for (const changed of [false, true]) {
    const change = changed ? {providerAccountRef: "account-2", providerRouteRef: "route-2", credentialGeneration: "credential-generation-2"} : {};
    const fixture = harness({route: route(change)});
    fixture.dependencies.dispatchAuthority.observeDispatchConsumption = input => owner.authority.observeDispatchConsumption(input);
    const result = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request(change));
    assert.equal(result.status, changed ? "denied" : "completed");
    assert.equal(fixture.events.includes("transport:open"), !changed);
    assert.equal(fixture.emittedApplicationBytes.length, changed ? 0 : 1);
  }
});
