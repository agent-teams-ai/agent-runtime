import assert from "node:assert/strict";
import test from "node:test";
import { containedTurnEgressProviderBindingDigest, createContainedTurnEgressGateway,
  createNodeEd25519EgressSigner } from "../dist/composition.js";
import * as ordinaryRuntimeSecurity from "../dist/index.js";
import { authority as dispatchHead, harness as dispatchHarness } from "./contained-turn-dispatch-authority.fixtures.ts";
import { applicationBytes, dispatch, frame, harness, host, keys, observation, policy, receipt, request, route, sha, signer,
  v4, wire } from "./fixtures/contained-turn-egress.ts";

test("committed receipt cannot follow another same-provider route, account or credential authority", async () => {
  for (const change of [{providerRouteRef: "route-2"}, {providerAccountRef: "account-2"},
    {credentialBindingRef: "credential-binding-2"}, {credentialBindingDigest: sha("credential-2")},
    {credentialGeneration: "credential-generation-2"}, {credentialRevision: "credential-revision-2"},
    {accessRef: "access-2"}, {accessRevision: "access-revision-2"}, {routeRevision: "route-revision-2"}, {authorityDigest: sha("route-authority-2")},
    {providerRouteRef: "route-2", providerAccountRef: "account-2", credentialGeneration: "credential-generation-2"}]) {
    let signs = 0; const fixture = harness({route: route(change), onSign() {signs += 1;}});
    const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request(Object.fromEntries(Object.entries(change).filter(([key]) => key in request()))));
    assert.deepEqual(outcome, {status: "denied", reason: "route_mismatch", deniedApplicationBytes: 0});
    assert.equal(signs, 0); assert.equal(fixture.events.includes("transport:open"), false);
    assert.equal(fixture.emittedApplicationBytes.length, 0);
  }
});

test("short arrays with excess named own keys reject before descriptor materialization", async () => {
  for (const kind of ["headers", "pins", "addresses"] as const) {
    for (const key of ["extra", Symbol("extra")]) {
      const values = kind === "headers" ? [{name: "accept", value: "application/json"}] :
        kind === "pins" ? [sha("spki")] : [v4()];
      let getters = 0; Object.defineProperty(values, key, {get() {getters += 1; throw new Error("private-value");}});
      const fixture = harness(kind === "pins" ? {route: route({allowedTlsSpkiDigests: values})} :
        kind === "addresses" ? {observation: {...observation(), canonicalAddresses: values}} : {});
      const original = Object.getOwnPropertyDescriptors; let materializations = 0;
      Object.getOwnPropertyDescriptors = value => {if (value === values) {materializations += 1;
        throw new Error("descriptor amplification sentinel");} return original(value);};
      try {
        const outcome = await createContainedTurnEgressGateway(host(), fixture.dependencies)
          .exchange(request(kind === "headers" ? {headers: values} : {}));
        assert.deepEqual(outcome, {status: "denied", reason: kind === "headers" ? "invalid_request" :
          kind === "pins" ? "route_unavailable" : "address_denied", deniedApplicationBytes: 0});
        assert.equal(materializations, 0); assert.equal(getters, 0);
        assert.equal(fixture.emittedApplicationBytes.length, 0);
      } finally {Object.getOwnPropertyDescriptors = original;}
    }
  }
});

test("excess object keys reject before materializing any descriptors", async () => {
  const candidate = {...request(), extra: true}; const fixture = harness();
  const original = Object.getOwnPropertyDescriptors; let materializations = 0;
  Object.getOwnPropertyDescriptors = value => {if (value === candidate) {materializations += 1;
    throw new Error("descriptor amplification sentinel");} return original(value);};
  try {
    assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate),
      {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
    assert.equal(materializations, 0); assert.deepEqual(fixture.events, []);
  } finally {Object.getOwnPropertyDescriptors = original;}
});

test("each selected route needs its own committed digest; changing only the observation query cannot replay a receipt", async () => {
  const routes = [route(), route({providerRouteRef: "route-2", providerAccountRef: "account-2", accessRef: "access-2",
    accessRevision: "access-revision-2", credentialBindingRef: "credential-binding-2", credentialBindingDigest: sha("credential-2"),
    credentialGeneration: "credential-generation-2", credentialRevision: "credential-revision-2", routeRevision: "route-revision-2"})];
  for (const selected of routes) {
    const providerBindingDigest = containedTurnEgressProviderBindingDigest(selected);
    const candidate = request({...Object.fromEntries(Object.entries(selected).filter(([key]) => key in request())),
      dispatch: {...dispatch, providerBindingDigest}});
    const fixture = harness({route: selected, dispatchOutcome: Object.freeze({status: "consumed", lifecycleState: "claim_committed",
      receipt: receipt({providerBindingDigest})})});
    assert.equal((await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate)).status, "completed");
    assert.equal(fixture.authorizations[0]?.accessRef, selected.accessRef);
    assert.equal(fixture.authorizations[0]?.accessRevision, selected.accessRevision);
    if (selected === routes[0]) {continue;}
    const replay = harness({route: selected});
    assert.deepEqual(await createContainedTurnEgressGateway(host(), replay.dependencies).exchange(candidate),
      {status: "denied", reason: "dispatch_not_committed", deniedApplicationBytes: 0});
    assert.equal(replay.events.includes("transport:open"), false); assert.equal(replay.authorizations.length, 0);
  }
});

test("receipt is checked again against the same resolved binding at the final boundary", async () => {
  let signs = 0; let reads = 0; const fixture = harness({onSign() {signs += 1;}});
  fixture.dependencies.dispatchAuthority.observeDispatchConsumption = async () => Object.freeze({status: "consumed",
    lifecycleState: "claim_committed", receipt: receipt(++reads === 1 ? {} : {providerBindingDigest: sha("other-route")})});
  assert.deepEqual(await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request()),
    {status: "denied", reason: "dispatch_not_committed", deniedApplicationBytes: 0});
  assert.equal(reads, 2); assert.equal(signs, 0); assert.equal(fixture.emittedApplicationBytes.length, 0);
  assert.equal(fixture.closeCount, 1);
});

test("binding preimage covers every resolved route fact using an independently framed vector", () => {
  const selected = route(); const pathDigest = sha(frame("contained-turn-egress-path/v1", [selected.pathConstraint]));
  const values = ["provider-route-authority/v1", "tenant-1", "project-1", sha("scope"), "provider-1", "account-1",
    "access-1", "access-revision-1", "route-1", "route-revision-1", "credential-binding-1", sha("credential"),
    "credential-generation-1", "credential-revision-1", sha("route-authority"), "https", "api.example.com", "443",
    "api.example.com", pathDigest, selected.tlsPinSetDigest, "pin-generation-1", "pin-revision-1", "resolver-1", "resolver-generation-1"];
  assert.equal(containedTurnEgressProviderBindingDigest(selected), sha(frame("contained-turn-egress-provider-binding/v1", values)));
  for (const field of ["tenantId", "projectId", "providerId", "providerAccountRef", "accessRef", "accessRevision", "providerRouteRef",
    "routeRevision", "credentialBindingRef", "credentialGeneration", "credentialRevision", "tlsPinSetGeneration", "tlsPinSetRevision",
    "resolutionAuthorityId", "resolutionGeneration", "pathConstraint", "scopeDigest", "credentialBindingDigest", "authorityDigest"]) {
    const value = selected[field as keyof typeof selected] as string;
    const changed = route({[field]: field.endsWith("Digest") ? sha("changed") : `${value}-2`});
    assert.notEqual(containedTurnEgressProviderBindingDigest(changed), dispatch.providerBindingDigest, field);
    assert.ok(containedTurnEgressProviderBindingDigest(changed), field);
  }
  assert.equal(containedTurnEgressProviderBindingDigest(route({accessRef: ""})), undefined);
  assert.equal("containedTurnEgressProviderBindingDigest" in ordinaryRuntimeSecurity, false);
});

test("all candidate record boundaries bound own keys before descriptors and frozen scans", async () => {
  for (const stage of ["host", "dependencies", "owner", "request", "scope", "budgets", "dispatch", "header", "route", "policy",
    "receipt-outcome", "receipt", "receipt-scope", "route-current", "policy-current", "consume-current", "session", "transport",
    "writer", "observation", "address", "envelope", "result", "signer-identity"]) {
    for (const key of ["extra", Symbol("extra")]) {
      const fixture = harness(); const candidate = request(); let target: object = candidate; let getters = 0;
      let identity = host(); const ownerRecord = {status: "current", observedAt: 101};
      const outcome = {status: "consumed", lifecycleState: "claim_committed", receipt: receipt()};
      const assign = (owner: object, name: string, value: object) => {target = value;
        (owner as Record<string, unknown>)[name] = async () => value;};
      if (stage === "host") {target = identity = {...host()};}
      if (stage === "dependencies") {target = fixture.dependencies;}
      if (stage === "owner") {target = fixture.dependencies.routeAuthority;}
      if (stage === "scope") {target = (candidate as {scope: object}).scope = {...candidate.scope};}
      if (stage === "budgets") {target = candidate.budgets;}
      if (stage === "dispatch") {target = (candidate as {dispatch: object}).dispatch = {...candidate.dispatch};}
      if (stage === "header") {target = candidate.headers[0]!;}
      if (stage === "route") {assign(fixture.dependencies.routeAuthority, "resolveExact", {...route()});}
      if (stage === "policy") {assign(fixture.dependencies.policyAuthority, "resolve", {...policy()});}
      if (stage.startsWith("receipt")) {
        assign(fixture.dependencies.dispatchAuthority, "observeDispatchConsumption", outcome);
        if (stage !== "receipt-outcome") {target = outcome.receipt = {...receipt()};}
        if (stage === "receipt-scope") {target = (outcome.receipt as {scope: object}).scope = {...dispatch.scope};}
      }
      if (stage === "route-current") {assign(fixture.dependencies.routeAuthority, "revalidateExact", {status: "current"});}
      if (stage === "policy-current") {assign(fixture.dependencies.policyAuthority, "revalidateExact", ownerRecord);}
      if (stage === "consume-current") {target = ownerRecord; fixture.dependencies.policyAuthority.consumeFirstWrite = () => ownerRecord;}
      const session = {transport: fixture.transport, firstWrite: fixture.firstWrite};
      if (stage === "session") {assign(fixture.dependencies.transportGateway, "openOneShotHttps", session);}
      if (stage === "transport") {target = fixture.transport;}
      if (stage === "writer") {target = fixture.firstWrite;}
      if (stage === "observation" || stage === "address") {
        const observed = {...observation(), applicationBytesDigest: sha(wire(candidate)), applicationBytes: applicationBytes(candidate)};
        target = observed;
        if (stage === "address") {const address = {...v4()}; target = address; observed.peerAddress = address;}
        fixture.transport.execute = async input => {await input.beforeFirstWrite(observed); return Object.freeze({status: "not_sent"});};
      }
      if (stage === "envelope") {const signed = signer().sign(new Uint8Array(), policy()) as object; target = {...signed};
        fixture.dependencies.signer.sign = () => target;}
      if (stage === "result") {target = {status: "not_sent"}; fixture.transport.execute = async () => target;}
      if (stage === "signer-identity") {target = {keyId: "key-1", keyGeneration: "key-gen-1", signerRevision: "signer-1",
        privateKey: keys.privateKey, publicKey: keys.publicKey};}
      Object.defineProperty(target, key, {get() {getters += 1; throw new Error("PRIVATE_SENTINEL");}});
      Object.freeze(target);
      const descriptors = Object.getOwnPropertyDescriptors; const frozen = Object.isFrozen;
      let materializations = 0; let scans = 0;
      Object.getOwnPropertyDescriptors = value => {if (value === target) {materializations += 1;
        throw new Error("descriptor amplification sentinel");} return descriptors(value);};
      Object.isFrozen = value => {if (value === target) {scans += 1; throw new Error("unbounded frozen scan");} return frozen(value);};
      try {
        if (["host", "dependencies", "owner", "signer-identity"].includes(stage)) {
          assert.throws(() => stage === "signer-identity" ? createNodeEd25519EgressSigner(target as never) :
            createContainedTurnEgressGateway(identity, fixture.dependencies), {name: "TypeError",
            message: stage === "signer-identity" ? "invalid Ed25519 signer identity" : "invalid contained turn egress composition"});
        } else {
          const result = await createContainedTurnEgressGateway(identity, fixture.dependencies).exchange(candidate);
          const reasons: Record<string, string> = {request: "invalid_request", scope: "invalid_request", budgets: "invalid_request",
            dispatch: "invalid_request", header: "invalid_request", route: "route_unavailable", policy: "authority_unavailable",
            "receipt-outcome": "dispatch_not_committed", receipt: "dispatch_not_committed", "receipt-scope": "dispatch_not_committed",
            "route-current": "authority_drift", "policy-current": "authority_drift", "consume-current": "authority_drift",
            session: "transport_denied", transport: "transport_denied", writer: "transport_denied", observation: "address_denied",
            address: "address_denied", envelope: "authorization_invalid"};
          assert.deepEqual(result, stage === "result" ? {status: "indeterminate", reason: "response_invalid"} :
            {status: "denied", reason: reasons[stage], deniedApplicationBytes: 0}, stage);
          assert.equal(JSON.stringify(result).includes("PRIVATE_SENTINEL"), false);
          assert.equal(fixture.emittedApplicationBytes.length, 0, stage);
        }
        assert.equal(materializations, 0, stage); assert.equal(scans, 0, stage); assert.equal(getters, 0, stage);
      } finally {Object.getOwnPropertyDescriptors = descriptors; Object.isFrozen = frozen;}
    }
  }
});

test("synchronous signer and current-authority records never execute getters or proxy traps", async () => {
  for (const stage of ["sign", "verify", "consume"]) {
    for (const proxy of [false, true]) {
      let calls = 0; const trap = () => {calls += 1; throw new Error("PRIVATE_SENTINEL");};
      const hostile = proxy ? new Proxy({}, {get: trap, ownKeys: trap, isExtensible: trap,
        // oxlint-disable-next-line unicorn/no-thenable -- hostile synchronous return must not read then
        getOwnPropertyDescriptor: trap, getPrototypeOf: trap}) : Object.defineProperty({}, "then", {get: trap});
      const fixture = harness();
      if (stage === "sign") {fixture.dependencies.signer.sign = () => hostile;}
      if (stage === "verify") {fixture.dependencies.signer.verify = () => hostile;}
      if (stage === "consume") {fixture.dependencies.policyAuthority.consumeFirstWrite = () => hostile;}
      const result = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(request());
      assert.deepEqual(result, {status: "denied", reason: stage === "consume" ? "authority_drift" : "authorization_invalid", deniedApplicationBytes: 0});
      assert.equal(calls, 0); assert.equal(fixture.emittedApplicationBytes.length, 0);
    }
  }
});


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
