import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";

import { containedTurnEgressProviderBindingDigest, createContainedTurnEgressGateway, createNodeEd25519EgressSigner,
  type ContainedTurnEgressDependencies, type ContainedTurnEgressRequest,
  type EgressAuthorizationBodyV1, type EgressTransportV1, type NetworkAddressV1,
  type TrustedEgressHostIdentityV1 } from "../../dist/composition.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const utf8 = new TextEncoder();
const frame = (tag: string, values: readonly (string | Uint8Array)[]) => {const fields = [utf8.encode(tag),
  ...values.map(value => typeof value === "string" ? utf8.encode(value) : value)];
  const bytes = new Uint8Array(fields.reduce((n, value) => n + value.byteLength + 4, 0));
  const view = new DataView(bytes.buffer); let offset = 0; for (const value of fields) {view.setUint32(offset, value.byteLength);
    offset += 4; bytes.set(value, offset); offset += value.byteLength;} return bytes;};
const keys = generateKeyPairSync("ed25519");
const signer = () => createNodeEd25519EgressSigner(Object.freeze({keyId: "key-1", keyGeneration: "key-gen-1",
  signerRevision: "signer-1", privateKey: keys.privateKey, publicKey: keys.publicKey}));
const host = (overrides: Partial<TrustedEgressHostIdentityV1> = {}): TrustedEgressHostIdentityV1 => Object.freeze({
  attemptId: "attempt-1", environmentId: "environment-1", gatewayId: "gateway-1", hostInstanceId: "host-instance-1",
  hostBootId: "host-boot-1", transportMode: "one_shot_https", ...overrides,
});
const binding = Object.freeze({credentialBindingRef: "credential-binding-1", credentialBindingDigest: sha("credential"),
  credentialGeneration: "credential-generation-1", credentialRevision: "credential-revision-1"});
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "provider-route-authority/v1", tenantId: "tenant-1", projectId: "project-1",
  providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1", ...binding,
  accessRef: "access-1", accessRevision: "access-revision-1",
  scopeDigest: sha("scope"), resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  routeRevision: "route-revision-1", authorityDigest: sha("route-authority"), scheme: "https",
  host: "api.example.com", port: 443, tlsServerName: "api.example.com", pathConstraint: "/v1/turn", ...overrides,
  allowedTlsSpkiDigests: Object.freeze([sha("spki")]),
  tlsPinSetDigest: sha(frame("contained-turn-egress-tls-pin-set/v1", [sha("spki")])),
  tlsPinSetGeneration: "pin-generation-1", tlsPinSetRevision: "pin-revision-1", ...overrides,
});
const policy = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "contained-turn-egress-policy/v1", policyId: "policy-1", policyRevision: "policy-revision-1",
  policyGeneration: "policy-generation-1", keyId: "key-1", keyGeneration: "key-gen-1",
  signerRevision: "signer-1", timeAuthorityId: "clock-1", timeGeneration: "clock-generation-1",
  observedAt: 100, expiresAt: 500, maxRequestBytes: 4_096, maxResponseBytes: 8_192,
  maxDeadlineMs: 300, ...overrides,
});
const v4 = (bytesHex = "5db8d822"): NetworkAddressV1 => Object.freeze({family: "ipv4", bytesHex});
const v6 = (bytesHex = "26062800022000010248189325c81946"): NetworkAddressV1 => Object.freeze({family: "ipv6", bytesHex});
const observation = (overrides: Record<string, unknown> = {}) => {const addresses = (overrides.canonicalAddresses ?? [v4()]) as NetworkAddressV1[];
  return Object.freeze({canonicalAddresses: Object.freeze(addresses), peerAddress: v4(), peerPort: 443, tlsServerName: "api.example.com",
  tlsSpkiDigest: sha("spki"), alpn: "http/1.1", phase: "immediately_before_first_application_byte",
  resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  answerSetDigest: sha(frame("contained-turn-egress-answer-set/v1", addresses.map(address => `${address.family}:${address.bytesHex}`))),
  ...overrides});};
const dispatch = Object.freeze({purpose: "contained-turn.provider-dispatch/v1" as const, operationId: "operation-1",
  scope: Object.freeze({tenantId: "tenant-1", projectId: "project-1", scopeDigest: sha("scope")}),
  grantRequestId: "grant-request-1", requestDigest: sha("dispatch-request"), providerId: "provider-1",
  authorityGeneration: "authority-generation-1", providerBindingDigest: containedTurnEgressProviderBindingDigest(route())!,
  claimBindingDigest: sha("claim-binding"), acceptedAuthorityDigest: sha("accepted-authority"),
  expectedAuthorityHeadDigest: sha("authority-head"), expectedAuthorityRevision: "authority-revision-1",
  expectedConstraintsDigest: sha("constraints"), expectedContainmentPolicyDigest: sha("containment-policy")});
const receipt = (overrides: Record<string, unknown> = {}) => Object.freeze({
  contractVersion: "contained-turn-dispatch-consumption/v1", purpose: dispatch.purpose,
  operationId: dispatch.operationId, scope: dispatch.scope, grantRequestId: dispatch.grantRequestId,
  requestDigest: dispatch.requestDigest, providerId: dispatch.providerId,
  authorityGeneration: dispatch.authorityGeneration, providerBindingDigest: dispatch.providerBindingDigest,
  claimBindingDigest: dispatch.claimBindingDigest, acceptedAuthorityDigest: dispatch.acceptedAuthorityDigest,
  authorityHeadDigestAtConsumption: dispatch.expectedAuthorityHeadDigest,
  authorityRevision: dispatch.expectedAuthorityRevision, constraintsDigest: dispatch.expectedConstraintsDigest,
  containmentPolicyDigest: dispatch.expectedContainmentPolicyDigest, consumptionDigest: sha("consumption"),
  claimBeforeControlTime: 200, consumedAtControlTime: 100, ownerEvidenceRef: "evidence-1", ...overrides,
});
const request = (overrides: Record<string, unknown> = {}): ContainedTurnEgressRequest => ({
  scope: dispatch.scope, providerId: "provider-1", providerAccountRef: "account-1", providerRouteRef: "route-1",
  ...binding, resolutionAuthorityId: "resolver-1", resolutionGeneration: "resolver-generation-1",
  operationId: "operation-1", dispatch, requestId: "request-1", requestNonce: "nonce-1", method: "POST",
  path: "/v1/turn", headers: [{name: "content-type", value: "application/json"},
    {name: "x-request-class", value: "synthetic"}], body: Uint8Array.from([1, 2, 3, 4]),
  budgets: {requestBytes: 1_000, responseBytes: 2_000, deadlineMs: 200}, ...overrides,
} as ContainedTurnEgressRequest);
const wire = (candidate: ContainedTurnEgressRequest, hostname = "api.example.com") => Buffer.concat([Buffer.from(`${candidate.method} ${candidate.path} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Length: ${candidate.body.byteLength}\r\n`),
  ...candidate.headers.map(header => Buffer.from(`${header.name}: ${header.value}\r\n`)), Buffer.from("\r\n"), candidate.body]);
const applicationBytes = (candidate: ContainedTurnEgressRequest) => wire(candidate).byteLength;
const stall = () => {const start = performance.now(); while (performance.now() - start < 210) {/* Synthetic CPU delay. */}};
const deferred = () => {let release!: () => void; const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, resolve: release};};
const spoof = <Value>(values: Value[]) => {Object.defineProperties(values, {every: {value() {return true;}, enumerable: true},
  some: {value() {return false;}, enumerable: true}, map: {value() {return [];}, enumerable: true},
  [Symbol.iterator]: {value() {throw new Error("iterator called");}, enumerable: false}}); return values;};
const deniedRequest = async (candidate: ContainedTurnEgressRequest) => {
  const fixture = harness();
  const result = await createContainedTurnEgressGateway(host(), fixture.dependencies).exchange(candidate);
  assert.deepEqual(result, {status: "denied", reason: "invalid_request", deniedApplicationBytes: 0});
  assert.deepEqual(fixture.events, []);
};

interface HarnessOptions {
  route?: unknown; policy?: unknown; observation?: unknown; routeOutcome?: unknown; dispatchOutcome?: unknown;
  policyOutcome?: unknown; openFails?: boolean; closeFails?: boolean; executeThrows?: boolean;
  skipCallback?: boolean; completedWithoutCallback?: boolean; reentrantCallback?: boolean; doubleConsume?: boolean;
  unawaitedCallback?: boolean; writeIndeterminate?: boolean; transportResult?: unknown; responseBytes?: number;
  partialWrite?: boolean; signerThenable?: boolean; verifierThenable?: boolean; consumptionThenable?: boolean;
  onSign?: () => void; onVerify?: () => void; onWrite?: () => void;
  consumeOutcome?: unknown; onConsume?: () => void;
  mutateAuthorization?: boolean; repeatedWrite?: boolean;
  mutateRetainedWrite?: boolean; mutateResultDuringClose?: boolean; onClose?: () => void | Promise<void>;
  holdOpen?: Promise<void>; holdAuthority?: Promise<void>; holdExecute?: Promise<void>; holdClose?: Promise<void>;
  mutateAtResolve?: () => void;
}
const harness = (options: HarnessOptions = {}) => {
  const events: string[] = []; const authorizations: EgressAuthorizationBodyV1[] = [];
  const canonicalBodies: Uint8Array[] = []; const dispatchInputs: unknown[] = [];
  const routeInputs: unknown[] = []; let retainedWrite: {authorization: {canonicalBody: Uint8Array}; applicationBytes: Uint8Array} | undefined;
  const emittedApplicationBytes: Uint8Array[] = []; let writerUsed = false;
  let returnedResult: Record<string, unknown> | undefined;
  const transported: {headers?: readonly Readonly<{name: string; value: string}>[]; body?: Uint8Array} = {};
  let callback: ((value: unknown) => Promise<unknown>) | undefined;
  let closeCount = 0;
  const transport: EgressTransportV1 = {
    async execute(input) {
      events.push("transport:execute"); transported.headers = input.request.headers; transported.body = input.request.body;
      callback = input.beforeFirstWrite;
      const exactWire = wire({...request(), path: input.target.path, method: input.request.method,
        headers: input.request.headers, body: input.request.body}, input.target.host); const applicationBytesDigest = sha(exactWire);
      const observed = {applicationBytesDigest, applicationBytes: exactWire.byteLength,
        ...(options.observation ?? observation())};
      if (options.executeThrows) {throw new Error("ambiguous write");}
      if (options.completedWithoutCallback) {events.push("transport:write"); return Object.freeze({status: "completed",
        responseBytes: 12, responseDigest: sha("response"), boundaryReceipt: {}});}
      if (options.skipCallback) {return Object.freeze({status: "not_sent"});}
      if (options.unawaitedCallback) {void input.beforeFirstWrite(observed);
        return Object.freeze({status: "completed", responseBytes: 12, responseDigest: sha("response"), boundaryReceipt: {}});}
      if (options.reentrantCallback) {const first = input.beforeFirstWrite(observed);
        const second = input.beforeFirstWrite(observed); await Promise.all([first, second]); return Object.freeze({status: "not_sent"});}
      events.push("transport:ready"); const admission = await input.beforeFirstWrite(observed) as
        {status: string; boundaryReceipt?: unknown};
      if (admission.status !== "written") {return Object.freeze({status: "not_sent"});}
      if (options.doubleConsume) {await input.beforeFirstWrite(observed);}
      await options.holdExecute;
      if (options.mutateRetainedWrite && retainedWrite !== undefined) {retainedWrite.authorization.canonicalBody.fill(9);
        retainedWrite.applicationBytes.fill(9);}
      if (options.writeIndeterminate) {return Object.freeze({status: "write_indeterminate"});}
      if (options.transportResult !== undefined) {return options.transportResult;}
      returnedResult = {status: "completed", responseBytes: options.responseBytes ?? 12,
        responseDigest: sha("response"), boundaryReceipt: admission.boundaryReceipt};
      return options.mutateResultDuringClose ? returnedResult : Object.freeze(returnedResult);
    },
    async close() {events.push("transport:close"); closeCount += 1; await options.onClose?.(); await options.holdClose;
      if (options.mutateResultDuringClose && returnedResult !== undefined) {returnedResult.boundaryReceipt = {};
        returnedResult.responseDigest = sha("repaired");}
      if (options.closeFails) {throw new Error("close failed");}},
  };
  const realSigner = signer();
  const firstWrite = {writeExact(value: unknown) {
    if (writerUsed) {throw new Error("exact writer already used");} writerUsed = true;
    const gate = value as {consumeAuthorization(): boolean}; options.onWrite?.();
    if (!gate.consumeAuthorization()) {return;}
    events.push("transport:write"); const safe = value as {authorization: {body: EgressAuthorizationBodyV1;
      canonicalBody: Uint8Array}; applicationBytes: Uint8Array}; authorizations.push(safe.authorization.body);
    retainedWrite = safe; canonicalBodies.push(safe.authorization.canonicalBody.slice());
    emittedApplicationBytes.push(safe.applicationBytes.slice());
    if (options.mutateAuthorization) {safe.authorization.canonicalBody[0] ^= 1;}
    if (options.partialWrite || options.repeatedWrite) {return {applicationBytesWritten: options.partialWrite ? 1 : 2};}
    if (options.consumptionThenable) {return Promise.resolve();}
  }};
  const dependencies: ContainedTurnEgressDependencies = {
    routeAuthority: {
      async resolveExact(input) {events.push("route:resolve"); routeInputs.push(input); options.mutateAtResolve?.();
        return options.route ?? route();},
      async revalidateExact() {events.push("route:revalidate"); return options.routeOutcome ?? Object.freeze({status: "current" as const});},
    },
    dispatchAuthority: {async observeDispatchConsumption(input) {events.push("dispatch:observe");
      dispatchInputs.push(input); if (dispatchInputs.length > 1) {await options.holdAuthority;} return options.dispatchOutcome ??
        Object.freeze({status: "consumed" as const, receipt: receipt(), lifecycleState: "claim_committed" as const});}},
    policyAuthority: {
      consumeFirstWrite() {options.onConsume?.(); return options.consumeOutcome ?? Object.freeze({status: "current", observedAt: 101});},
      async resolve() {events.push("policy:resolve"); return options.policy ?? policy();},
      async revalidateExact() {events.push("policy:revalidate"); return options.policyOutcome ??
        Object.freeze({status: "current" as const, observedAt: 101});},
    },
    signer: {
      sign(body, key) {options.onSign?.(); const value = realSigner.sign(body, key);
        // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
        return options.signerThenable ? {...value as object, then() {}} : value;},
      // oxlint-disable-next-line unicorn/no-thenable -- adversarial boundary fixture
      verify(body, envelope) {options.onVerify?.(); return options.verifierThenable ? {then() {}} : realSigner.verify(body, envelope);},
    },
    transportGateway: {async openOneShotHttps() {events.push("transport:open"); await options.holdOpen;
      if (options.openFails) {throw new Error("open failed");} return {transport, firstWrite};}},
  };
  return {dependencies, transport, events, authorizations, canonicalBodies, dispatchInputs, routeInputs, transported,
    firstWrite, emittedApplicationBytes, get callback() {return callback;}, get closeCount() {return closeCount;}};
};

export { applicationBytes, binding, deferred, deniedRequest, dispatch, frame, harness, host, keys, observation,
  policy, receipt, request, route, sha, signer, spoof, stall, v4, v6, wire };
export type { HarnessOptions };
