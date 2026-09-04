import type { ContainedTurnEgress, ContainedTurnEgressDependencies, ContainedTurnEgressResult,
  EgressAuthorizationBodyV1, EgressAuthorizationConsumptionV1, EgressAuthorizationEnvelopeV1,
  EgressTransportV1, TrustedEgressHostIdentityV1 } from "./composition.js";
import { canonicalAuthorization, captureComposition, captureTransport, committedReceipt, exact, hash, isDigest,
  snapshotObservation, snapshotPolicy, snapshotRequest, snapshotRoute, snapshotTransportResult,
  type PolicyAuthority, type RouteAuthority } from "./validation.js";

const freeze = Object.freeze;
const deny = (reason: Extract<ContainedTurnEgressResult, {status: "denied"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "denied"}> => freeze({status: "denied", reason, deniedApplicationBytes: 0});
const uncertain = (reason: Extract<ContainedTurnEgressResult, {status: "indeterminate"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "indeterminate"}> => freeze({status: "indeterminate", reason});
const routeMatches = (route: RouteAuthority, request: NonNullable<ReturnType<typeof snapshotRequest>>["request"]) =>
  route.tenantId === request.scope.tenantId && route.projectId === request.scope.projectId &&
  route.providerId === request.providerId && route.providerAccountRef === request.providerAccountRef &&
  route.providerRouteRef === request.providerRouteRef && route.credentialBindingRef === request.credentialBindingRef &&
  route.credentialBindingDigest === request.credentialBindingDigest &&
  route.credentialGeneration === request.credentialGeneration && route.credentialRevision === request.credentialRevision &&
  route.pathConstraint === request.path;
const current = (value: unknown, expectedStatus = "current") => exact(value, ["status"])?.status === expectedStatus;
const policyCurrent = (value: unknown, policy: PolicyAuthority) => {
  const outcome = exact(value, ["status", "observedAt"]);
  return outcome?.status === "current" && Number.isSafeInteger(outcome.observedAt) &&
    (outcome.observedAt as number) >= policy.observedAt ? outcome.observedAt as number : undefined;
};
const signedEnvelope = (value: unknown, policy: PolicyAuthority): EgressAuthorizationEnvelopeV1 | undefined => {
  const result = exact(value, ["keyId", "keyGeneration", "signerRevision", "digest", "signature"]);
  return result !== undefined && result.keyId === policy.keyId && result.keyGeneration === policy.keyGeneration &&
    result.signerRevision === policy.signerRevision && isDigest(result.digest) && typeof result.signature === "string" &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(result.signature) ? freeze({...result}) as EgressAuthorizationEnvelopeV1 : undefined;
};
type CapturedRequest = NonNullable<ReturnType<typeof snapshotRequest>>;
const initialAuthorities = async (owners: ReturnType<typeof captureComposition>["dependencies"], captured: CapturedRequest):
Promise<Readonly<{route: RouteAuthority; policy: PolicyAuthority}> | ContainedTurnEgressResult> => {
  const request = captured.request; let route: RouteAuthority | undefined; let policy: PolicyAuthority | undefined;
  try {[route, policy] = await Promise.all([
    owners.routeAuthority.resolveExact(freeze({tenantId: request.scope.tenantId, projectId: request.scope.projectId,
      providerId: request.providerId, providerAccountRef: request.providerAccountRef,
      providerRouteRef: request.providerRouteRef, credentialBindingRef: request.credentialBindingRef,
      credentialBindingDigest: request.credentialBindingDigest, credentialGeneration: request.credentialGeneration,
      credentialRevision: request.credentialRevision})).then(snapshotRoute),
    owners.policyAuthority.resolve().then(snapshotPolicy),
  ]);} catch {return deny("authority_unavailable");}
  if (route === undefined) {return deny("route_unavailable");}
  if (!routeMatches(route, request)) {return deny("route_mismatch");}
  if (policy === undefined) {return deny("authority_unavailable");}
  if (captured.requestBytes > policy.maxRequestBytes || request.budgets.requestBytes > policy.maxRequestBytes ||
      request.budgets.responseBytes > policy.maxResponseBytes || request.budgets.deadlineMs > policy.maxDeadlineMs) {
    return deny("budget_exceeded");
  }
  return freeze({route, policy});
};
type FinalContext = Readonly<{interrupted: boolean; callbackCount: number;
  callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined; consumptionCount: number;
  actualConsumption: unknown; authorizedConsumption: EgressAuthorizationConsumptionV1 | undefined;
  requestBytes: number; responseLimit: number}>;
const mapResult = (result: ReturnType<typeof snapshotTransportResult>, context: FinalContext): ContainedTurnEgressResult => {
  if (result === undefined) {return uncertain("response_invalid");}
  if (result.status === "write_indeterminate") {return uncertain("first_write_indeterminate");}
  if (result.status === "not_sent") {return context.callbackDenial ?? deny("transport_denied");}
  if (context.interrupted || context.callbackCount !== 1 || context.callbackDenial !== undefined ||
      context.consumptionCount !== 1 || context.actualConsumption !== context.authorizedConsumption ||
      result.applicationBytesWritten !== context.requestBytes) {
    return uncertain("first_write_indeterminate");
  }
  return result.responseBytes > context.responseLimit ? uncertain("response_invalid") :
    freeze({status: "completed", responseDigest: result.responseDigest, responseBytes: result.responseBytes});
};

export const createContainedTurnEgressGateway = (trustedIdentity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies): ContainedTurnEgress => {
  const captured = captureComposition(trustedIdentity, dependencies); const owners = captured.dependencies;
  let state: "open" | "active" | "closing" | "used" | "closed" | "quarantined" = "open";
  let transport: EgressTransportV1 | undefined; let closure: Promise<boolean> | undefined;
  let flight: Promise<ContainedTurnEgressResult> | undefined;
  const markUsed = () => {if (state === "active") {state = "used";}};
  const close = () => {
    if (closure !== undefined) {return closure;}
    if (transport === undefined) {return Promise.resolve(true);}
    try {closure = transport.close().then(() => true, () => {state = "quarantined"; return false;});}
    catch {state = "quarantined"; closure = Promise.resolve(false);}
    return closure;
  };
  const run = async (unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]): Promise<ContainedTurnEgressResult> => {
    const capturedRequest = snapshotRequest(unsafe);
    if (capturedRequest === undefined) {markUsed(); return deny("invalid_request");}
    const request = capturedRequest.request; const initial = await initialAuthorities(owners, capturedRequest);
    if ("status" in initial) {markUsed(); return initial;}
    const {route, policy} = initial;
    if (state !== "active") {return deny("authority_drift");}
    try {transport = captureTransport(await owners.transportGateway.openOneShotHttps());}
    catch {markUsed(); return deny("transport_denied");}
    if (transport === undefined) {markUsed(); return deny("transport_denied");}
    if (state !== "active") {return await close() ? deny("authority_drift") : uncertain("close_failed");}

    let boundaryOpen = true; let callbackCount = 0; let consumptionCount = 0;
    let callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined;
    let authorizedConsumption: EgressAuthorizationConsumptionV1 | undefined;
    const callbacks = new Set<Promise<unknown>>();
    const beforeFirstByte = (rawObservation: unknown) => {
      callbackCount += 1;
      if (!boundaryOpen || callbackCount !== 1 || state !== "active") {
        callbackDenial = deny("authorization_invalid"); return Promise.resolve(freeze({status: "denied" as const}));
      }
      const pending = (async () => {
        const observation = snapshotObservation(rawObservation);
        if (observation === undefined) {callbackDenial = deny("address_denied"); return freeze({status: "denied" as const});}
        if (observation.tlsServerName !== route.tlsServerName || observation.peerPort !== route.port) {
          callbackDenial = deny("tls_peer_mismatch"); return freeze({status: "denied" as const});
        }
        let routeOutcome: unknown; let dispatchOutcome: unknown; let policyOutcome: unknown;
        try {[routeOutcome, dispatchOutcome, policyOutcome] = await Promise.all([
          owners.routeAuthority.revalidateExact(route), owners.dispatchAuthority.observeDispatchConsumption(request.dispatch),
          owners.policyAuthority.revalidateExact(policy),
        ]);} catch {callbackDenial = deny("authority_unavailable"); return freeze({status: "denied" as const});}
        if (!boundaryOpen || state !== "active") {callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        if (!current(routeOutcome)) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        const receipt = committedReceipt(dispatchOutcome, request.dispatch);
        if (receipt === undefined) {callbackDenial = deny("dispatch_not_committed"); return freeze({status: "denied" as const});}
        const issuedAt = policyCurrent(policyOutcome, policy);
        if (issuedAt === undefined) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        if (issuedAt >= policy.expiresAt || issuedAt - policy.observedAt > request.budgets.deadlineMs) {
          callbackDenial = deny("expired"); return freeze({status: "denied" as const});
        }
        const body: EgressAuthorizationBodyV1 = freeze({contractVersion: "contained-turn-egress-authorization-body/v1",
          tenantId: route.tenantId, projectId: route.projectId, scopeDigest: receipt.scope.scopeDigest,
          providerId: route.providerId, providerAccountRef: route.providerAccountRef,
          providerRouteRef: route.providerRouteRef, credentialBindingRef: route.credentialBindingRef,
          credentialBindingDigest: route.credentialBindingDigest, credentialGeneration: route.credentialGeneration,
          credentialRevision: route.credentialRevision, routeRevision: route.routeRevision,
          routeAuthorityDigest: route.authorityDigest, operationId: receipt.operationId,
          attemptId: captured.identity.attemptId, dispatchReceipt: receipt, requestId: request.requestId,
          requestNonce: request.requestNonce, environmentId: captured.identity.environmentId,
          gatewayId: captured.identity.gatewayId, hostInstanceId: captured.identity.hostInstanceId,
          hostBootId: captured.identity.hostBootId, transportMode: captured.identity.transportMode,
          policyId: policy.policyId, policyRevision: policy.policyRevision, policyGeneration: policy.policyGeneration,
          keyId: policy.keyId, keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision,
          timeAuthorityId: policy.timeAuthorityId, timeGeneration: policy.timeGeneration, issuedAt,
          expiresAt: policy.expiresAt, target: freeze({scheme: route.scheme, host: route.host, port: route.port,
            tlsServerName: route.tlsServerName, path: request.path}), addresses: observation.canonicalAddresses,
          peerAddress: observation.peerAddress, peerPort: observation.peerPort, tlsSpkiDigest: observation.tlsSpkiDigest,
          alpn: observation.alpn, method: request.method, headerDigest: capturedRequest.headerDigest,
          bodyDigest: capturedRequest.bodyDigest, requestDigest: capturedRequest.requestDigest,
          requestBytes: capturedRequest.requestBytes, budgets: request.budgets,
          policyMaxima: freeze({requestBytes: policy.maxRequestBytes, responseBytes: policy.maxResponseBytes,
            deadlineMs: policy.maxDeadlineMs})});
        const canonicalBody = canonicalAuthorization(body); let envelope: EgressAuthorizationEnvelopeV1 | undefined;
        try {envelope = signedEnvelope(owners.signer.sign(Uint8Array.from(canonicalBody), freeze({keyId: policy.keyId,
          keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision})), policy);} catch {envelope = undefined;}
        let verified: unknown = false;
        try {verified = envelope === undefined ? false : owners.signer.verify(Uint8Array.from(canonicalBody), envelope);} catch {verified = false;}
        if (envelope === undefined || envelope.digest !== hash(canonicalBody) || verified !== true) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});
        }
        const token = freeze({authorizationDigest: envelope.digest}); authorizedConsumption = token;
        return freeze({status: "authorized" as const, body, canonicalBody: Uint8Array.from(canonicalBody), envelope,
          consume() {consumptionCount += 1;
            if (!boundaryOpen || state !== "active" || consumptionCount !== 1) {
              callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});
            }
            return token;
          }});
      })();
      callbacks.add(pending); void pending.finally(() => callbacks.delete(pending)); return pending;
    };
    let rawResult: unknown;
    try {rawResult = await transport.execute(freeze({target: freeze({scheme: route.scheme, host: route.host,
      port: route.port, tlsServerName: route.tlsServerName, path: request.path}), request: capturedRequest.buffered,
      responseByteLimit: request.budgets.responseBytes, deadlineMs: request.budgets.deadlineMs, beforeFirstByte}));}
    catch {rawResult = freeze({status: "write_indeterminate"});}
    boundaryOpen = false; await Promise.allSettled(callbacks);
    const result = snapshotTransportResult(rawResult); const interrupted = state !== "active";
    const closed = await close(); transport = undefined;
    if (!closed) {return uncertain("close_failed");}
    markUsed(); return mapResult(result, {interrupted, callbackCount, callbackDenial, consumptionCount,
      actualConsumption: result?.status === "completed" ? result.authorizationConsumption : undefined,
      authorizedConsumption, requestBytes: capturedRequest.requestBytes, responseLimit: request.budgets.responseBytes});
  };
  const isQuarantined = () => state === "quarantined";
  return freeze({exchange(unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]) {
    if (state !== "open") {return Promise.resolve(deny("invalid_request"));}
    state = "active"; flight = run(unsafe); return flight;
  }, async dispose() {
    if (state === "closed") {return "closed" as const;}
    if (isQuarantined()) {return "quarantined" as const;}
    if (state === "open") {state = "closing";} else if (state === "active") {state = "closing";}
    if (flight !== undefined) {await flight;}
    if (isQuarantined()) {return "quarantined" as const;}
    if (!await close()) {return "quarantined" as const;}
    transport = undefined; state = "closed"; return "closed" as const;
  }});
};
