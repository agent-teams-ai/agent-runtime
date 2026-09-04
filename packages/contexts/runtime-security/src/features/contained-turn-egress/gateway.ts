import type { ContainedTurnEgress, ContainedTurnEgressDependencies, ContainedTurnEgressResult,
  EgressAuthorizationBodyV1, EgressAuthorizationEnvelopeV1, EgressTransportV1,
  TrustedEgressHostIdentityV1 } from "./composition.js";
import { captureComposition, captureTransport, exact, hash, isDigest, snapshotObservation, snapshotPolicy,
  snapshotRequest, snapshotRoute, snapshotTransportResult, type PolicyAuthority, type RouteAuthority } from "./validation.js";

const freeze = Object.freeze;
const deny = (reason: Extract<ContainedTurnEgressResult, {status: "denied"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "denied"}> => freeze({status: "denied", reason, deniedApplicationBytes: 0});
const uncertain = (reason: Extract<ContainedTurnEgressResult, {status: "indeterminate"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "indeterminate"}> => freeze({status: "indeterminate", reason});

const routeMatches = (route: RouteAuthority, request: ReturnType<typeof snapshotRequest> & object) =>
  route.tenantId === request.request.scope.tenantId && route.projectId === request.request.scope.projectId &&
  route.providerId === request.request.providerId && route.providerAccountRef === request.request.providerAccountRef &&
  route.providerRouteRef === request.request.providerRouteRef && route.pathConstraint === request.request.path;
const current = (value: unknown, expectedStatus = "current") => {
  const outcome = exact(value, ["status"]);
  return outcome?.status === expectedStatus;
};
const policyCurrent = (value: unknown, policy: PolicyAuthority) => {
  const outcome = exact(value, ["status", "observedAt"]);
  return outcome?.status === "current" && Number.isSafeInteger(outcome.observedAt) &&
    (outcome.observedAt as number) >= policy.observedAt ? outcome.observedAt as number : undefined;
};
const envelope = (value: unknown, policy: PolicyAuthority): EgressAuthorizationEnvelopeV1 | undefined => {
  const result = exact(value, ["keyId", "keyGeneration", "signerRevision", "digest", "signature"]);
  return result !== undefined && result.keyId === policy.keyId && result.keyGeneration === policy.keyGeneration &&
    result.signerRevision === policy.signerRevision && isDigest(result.digest) && typeof result.signature === "string" &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(result.signature) ? freeze({...result}) as EgressAuthorizationEnvelopeV1 : undefined;
};
type CapturedRequest = NonNullable<ReturnType<typeof snapshotRequest>>;
const resolveInitialAuthorities = async (
  owners: ReturnType<typeof captureComposition>["dependencies"],
  capturedRequest: CapturedRequest,
): Promise<Readonly<{route: RouteAuthority; policy: PolicyAuthority}> | ContainedTurnEgressResult> => {
  const request = capturedRequest.request;
  let route: RouteAuthority | undefined;
  let policy: PolicyAuthority | undefined;
  try {[route, policy] = await Promise.all([
    owners.routeAuthority.resolveExact(freeze({tenantId: request.scope.tenantId,
      projectId: request.scope.projectId, providerId: request.providerId,
      providerAccountRef: request.providerAccountRef, providerRouteRef: request.providerRouteRef})).then(snapshotRoute),
    owners.policyAuthority.resolve().then(snapshotPolicy),
  ]);} catch {return deny("authority_unavailable");}
  if (route === undefined) {return deny("route_unavailable");}
  if (!routeMatches(route, capturedRequest)) {return deny("route_mismatch");}
  if (policy === undefined) {return deny("authority_unavailable");}
  if (capturedRequest.requestBytes > policy.maxRequestBytes || request.budgets.requestBytes > policy.maxRequestBytes ||
      request.budgets.responseBytes > policy.maxResponseBytes || request.budgets.deadlineMs > policy.maxDeadlineMs) {
    return deny("budget_exceeded");
  }
  return freeze({route, policy});
};
const mapTransportResult = (result: ReturnType<typeof snapshotTransportResult>, callbackCount: number,
  callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined,
  responseLimit: number): ContainedTurnEgressResult => {
  if (result === undefined) {return uncertain("response_invalid");}
  if (callbackCount !== 1) {
    return result.status === "not_sent" ? callbackDenial ?? deny("transport_denied") : uncertain("first_write_indeterminate");
  }
  if (callbackDenial !== undefined) {
    return result.status === "not_sent" ? callbackDenial : uncertain("first_write_indeterminate");
  }
  if (result.status === "not_sent") {return deny("transport_denied");}
  if (result.status === "write_indeterminate") {return uncertain("first_write_indeterminate");}
  return result.responseBytes > responseLimit ? uncertain("response_invalid") :
    freeze({status: "completed", responseDigest: result.responseDigest, responseBytes: result.responseBytes});
};

export const createContainedTurnEgressGateway = (
  trustedIdentity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies,
): ContainedTurnEgress => {
  const captured = captureComposition(trustedIdentity, dependencies);
  const owners = captured.dependencies;
  let state: "open" | "active" | "used" | "closed" | "quarantined" = "open";
  let transport: EgressTransportV1 | undefined;
  let closure: Promise<boolean> | undefined;
  const close = () => {
    if (closure !== undefined) {return closure;}
    if (transport === undefined) {return Promise.resolve(true);}
    try {closure = transport.close().then(() => true, () => {state = "quarantined"; return false;});}
    catch {state = "quarantined"; closure = Promise.resolve(false);}
    return closure;
  };

  const exchange = async (unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]): Promise<ContainedTurnEgressResult> => {
    if (state !== "open") {return deny("invalid_request");}
    state = "active";
    const capturedRequest = snapshotRequest(unsafe);
    if (capturedRequest === undefined) {state = "used"; return deny("invalid_request");}
    const request = capturedRequest.request;
    const initial = await resolveInitialAuthorities(owners, capturedRequest);
    if ("status" in initial) {state = "used"; return initial;}
    const {route, policy} = initial;
    if (state !== "active") {return deny("authority_drift");}
    try {transport = captureTransport(await owners.transportGateway.openOneShotHttps());}
    catch {state = "used"; return deny("transport_denied");}
    if (transport === undefined) {state = "used"; return deny("transport_denied");}
    if (state !== "active") {return await close() ? deny("authority_drift") : uncertain("close_failed");}

    let callbackCount = 0;
    let callbackOpen = true;
    let callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined;
    const beforeFirstByte = async (rawObservation: unknown) => {
      callbackCount += 1;
      if (!callbackOpen || callbackCount !== 1 || state !== "active") {
        callbackDenial = deny("authorization_invalid");
        return freeze({status: "denied" as const});
      }
      const observation = snapshotObservation(rawObservation);
      if (observation === undefined) {callbackDenial = deny("address_denied"); return freeze({status: "denied" as const});}
      if (observation.tlsServerName !== route.tlsServerName || observation.peerPort !== route.port) {
        callbackDenial = deny("tls_peer_mismatch"); return freeze({status: "denied" as const});
      }
      const dispatch = freeze({tenantId: request.scope.tenantId, projectId: request.scope.projectId,
        scopeDigest: request.scope.scopeDigest, providerId: request.providerId, operationId: request.operationId,
        attemptId: captured.identity.attemptId, ...request.dispatch});
      let routeOutcome: unknown; let dispatchOutcome: unknown; let policyOutcome: unknown;
      try {[routeOutcome, dispatchOutcome, policyOutcome] = await Promise.all([
        owners.routeAuthority.revalidateExact(route), owners.dispatchAuthority.revalidateClaimCommitted(dispatch),
        owners.policyAuthority.revalidateExact(policy),
      ]);} catch {callbackDenial = deny("authority_unavailable"); return freeze({status: "denied" as const});}
      if (!current(routeOutcome)) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
      if (!current(dispatchOutcome, "claim_committed")) {
        callbackDenial = deny("dispatch_not_committed"); return freeze({status: "denied" as const});
      }
      const issuedAt = policyCurrent(policyOutcome, policy);
      if (issuedAt === undefined) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
      if (issuedAt >= policy.expiresAt || issuedAt - policy.observedAt > request.budgets.deadlineMs) {
        callbackDenial = deny("expired"); return freeze({status: "denied" as const});
      }
      const authorization: EgressAuthorizationBodyV1 = freeze({contractVersion: "contained-turn-egress-authorization-body/v1",
        tenantId: request.scope.tenantId, projectId: request.scope.projectId, scopeDigest: request.scope.scopeDigest,
        providerId: request.providerId, providerAccountRef: request.providerAccountRef,
        providerRouteRef: request.providerRouteRef, routeRevision: route.routeRevision,
        routeAuthorityDigest: route.authorityDigest, operationId: request.operationId,
        ...request.dispatch, requestId: request.requestId, requestNonce: request.requestNonce,
        ...captured.identity, policyId: policy.policyId, policyRevision: policy.policyRevision,
        policyGeneration: policy.policyGeneration, keyId: policy.keyId, keyGeneration: policy.keyGeneration,
        signerRevision: policy.signerRevision, timeAuthorityId: policy.timeAuthorityId,
        timeGeneration: policy.timeGeneration, issuedAt, expiresAt: policy.expiresAt,
        target: {scheme: route.scheme, host: route.host, port: route.port, tlsServerName: route.tlsServerName,
          path: request.path}, addresses: observation.canonicalAddresses, peerAddress: observation.peerAddress,
        peerPort: observation.peerPort, tlsSpkiDigest: observation.tlsSpkiDigest, alpn: observation.alpn,
        method: request.method, headerDigest: capturedRequest.headerDigest, bodyDigest: capturedRequest.bodyDigest,
        requestDigest: capturedRequest.requestDigest, requestBytes: capturedRequest.requestBytes,
        budgets: request.budgets, policyMaxima: {requestBytes: policy.maxRequestBytes,
          responseBytes: policy.maxResponseBytes, deadlineMs: policy.maxDeadlineMs}});
      const body = JSON.stringify(authorization);
      let signed: EgressAuthorizationEnvelopeV1 | undefined;
      try {signed = envelope(owners.signer.sign(body, freeze({keyId: policy.keyId,
        keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision})), policy);}
      catch {signed = undefined;}
      let verified = false;
      try {verified = signed !== undefined && owners.signer.verify(body, signed);}
      catch {verified = false;}
      if (signed === undefined || signed.digest !== hash(body) || !verified) {
        callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});
      }
      return freeze({status: "authorized" as const, body, envelope: signed});
    };
    let rawResult: unknown;
    try {rawResult = await transport.execute(freeze({target: freeze({scheme: route.scheme, host: route.host,
      port: route.port, tlsServerName: route.tlsServerName, path: request.path}), request: capturedRequest.buffered,
      responseByteLimit: request.budgets.responseBytes, deadlineMs: request.budgets.deadlineMs, beforeFirstByte}));}
    catch {rawResult = freeze({status: "write_indeterminate"});}
    callbackOpen = false;
    const result = snapshotTransportResult(rawResult);
    const closed = await close();
    transport = undefined;
    if (!closed) {return uncertain("close_failed");}
    state = "used";
    return mapTransportResult(result, callbackCount, callbackDenial, request.budgets.responseBytes);
  };

  return freeze({exchange, async dispose() {
    if (state === "quarantined") {return "quarantined" as const;}
    state = "closed";
    if (!await close()) {return "quarantined" as const;}
    transport = undefined; return "closed" as const;
  }});
};
