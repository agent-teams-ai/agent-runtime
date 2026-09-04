import type { ContainedTurnEgress, ContainedTurnEgressDependencies, ContainedTurnEgressRequest,
  ContainedTurnEgressResult, EgressAuthorizationBodyV1, EgressAuthorizationEnvelopeV1,
  ProviderRouteAuthoritySnapshotV1, TrustedEgressHostIdentityV1 } from "./composition.js";
import { createEgressValidation, isDigest, type BufferedRequest, type EgressSecurityPrimitives,
  type PolicyAuthority, type TransportObservation } from "./validation.js";
import type { DispatchConsumptionReceipt } from
  "../contained-turn-dispatch-authority/contracts/contained-turn-dispatch-authority-v1.js";
import { EgressOneShotLifecycle } from "./lifecycle.js";

const freeze = Object.freeze;
const deny = (reason: Extract<ContainedTurnEgressResult, {status: "denied"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "denied"}> => freeze({status: "denied", reason, deniedApplicationBytes: 0});
const uncertain = (reason: Extract<ContainedTurnEgressResult, {status: "indeterminate"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "indeterminate"}> => freeze({status: "indeterminate", reason});
const sameBytes = (left: Uint8Array, right: Uint8Array) => {if (left.byteLength !== right.byteLength) {return false;}
  for (let index = 0; index < left.byteLength; index += 1) {if (left[index] !== right[index]) {return false;}} return true;};
const frozenExact = <Name extends string>(validation: ReturnType<typeof createEgressValidation>, value: unknown,
  names: readonly Name[]) => {try {return Object.isFrozen(value) ? validation.exact(value, names) : undefined;} catch {return;}};
const routeMatches = (route: ProviderRouteAuthoritySnapshotV1, request: ContainedTurnEgressRequest) =>
  route.tenantId === request.scope.tenantId && route.projectId === request.scope.projectId &&
  route.scopeDigest === request.scope.scopeDigest && route.providerId === request.providerId &&
  route.providerAccountRef === request.providerAccountRef && route.providerRouteRef === request.providerRouteRef &&
  route.credentialBindingRef === request.credentialBindingRef &&
  route.credentialBindingDigest === request.credentialBindingDigest && route.credentialGeneration === request.credentialGeneration &&
  route.credentialRevision === request.credentialRevision && route.resolutionAuthorityId === request.resolutionAuthorityId &&
  route.resolutionGeneration === request.resolutionGeneration && route.pathConstraint === request.path;
const authorizationBody = (input: Readonly<{route: ProviderRouteAuthoritySnapshotV1; request: ContainedTurnEgressRequest;
  receipt: DispatchConsumptionReceipt; identity: TrustedEgressHostIdentityV1; policy: PolicyAuthority; issuedAt: number;
  capturedRequest: BufferedRequest; observation: TransportObservation}>): EgressAuthorizationBodyV1 => {
  const {route, request, receipt, identity, policy, issuedAt, capturedRequest, observation} = input;
  return freeze({contractVersion: "contained-turn-egress-authorization-body/v1",
    tenantId: route.tenantId, projectId: route.projectId, scopeDigest: route.scopeDigest,
    providerId: route.providerId, providerAccountRef: route.providerAccountRef, providerRouteRef: route.providerRouteRef,
    credentialBindingRef: route.credentialBindingRef, credentialBindingDigest: route.credentialBindingDigest,
    credentialGeneration: route.credentialGeneration, credentialRevision: route.credentialRevision,
    routeRevision: route.routeRevision, routeAuthorityDigest: route.authorityDigest, operationId: receipt.operationId,
    attemptId: identity.attemptId, dispatchReceipt: receipt, requestId: request.requestId, requestNonce: request.requestNonce,
    environmentId: identity.environmentId, gatewayId: identity.gatewayId, hostInstanceId: identity.hostInstanceId,
    hostBootId: identity.hostBootId, transportMode: identity.transportMode, policyId: policy.policyId,
    policyRevision: policy.policyRevision, policyGeneration: policy.policyGeneration, keyId: policy.keyId,
    keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision, timeAuthorityId: policy.timeAuthorityId,
    timeGeneration: policy.timeGeneration, issuedAt, expiresAt: policy.expiresAt,
    target: freeze({scheme: route.scheme, host: route.host, port: route.port, tlsServerName: route.tlsServerName,
      pathDigest: capturedRequest.pathDigest}), allowedTlsSpkiDigests: route.allowedTlsSpkiDigests,
    tlsPinSetDigest: route.tlsPinSetDigest, tlsPinSetGeneration: route.tlsPinSetGeneration,
    tlsPinSetRevision: route.tlsPinSetRevision, resolutionAuthorityId: route.resolutionAuthorityId,
    resolutionGeneration: route.resolutionGeneration, answerSetDigest: observation.answerSetDigest,
    addresses: observation.canonicalAddresses, peerAddress: observation.peerAddress, peerPort: observation.peerPort,
    tlsSpkiDigest: observation.tlsSpkiDigest, alpn: observation.alpn, method: request.method,
    headerDigest: capturedRequest.headerDigest, bodyDigest: capturedRequest.bodyDigest,
    requestDigest: capturedRequest.requestDigest, applicationBytesDigest: capturedRequest.applicationBytesDigest,
    applicationBytes: capturedRequest.applicationBytes, budgets: request.budgets,
    policyMaxima: freeze({requestBytes: policy.maxRequestBytes, responseBytes: policy.maxResponseBytes,
      deadlineMs: policy.maxDeadlineMs})});
};

export const createContainedTurnEgressGatewayCore = (trustedIdentity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies, primitives: EgressSecurityPrimitives): ContainedTurnEgress => {
  const validation = createEgressValidation(primitives); const captured = validation.captureComposition(trustedIdentity, dependencies);
  const owners = captured.dependencies; const lifecycle = new EgressOneShotLifecycle();
  // oxlint-disable-next-line complexity -- ordered one-shot denial and quarantine transitions remain explicit.
  const run = async (unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]): Promise<ContainedTurnEgressResult> => {
    const preliminary = validation.snapshotRequest(unsafe);
    if (preliminary === undefined) {lifecycle.markUsed(); return deny("invalid_request");}
    const request = preliminary.request;
    if (preliminary.applicationBytes > request.budgets.requestBytes) {lifecycle.markUsed(); return deny("invalid_request");}
    let route; let policy;
    try {
      route = validation.snapshotRoute(await owners.routeAuthority.resolveExact(freeze({tenantId: request.scope.tenantId,
        projectId: request.scope.projectId, scopeDigest: request.scope.scopeDigest, providerId: request.providerId,
        providerAccountRef: request.providerAccountRef, providerRouteRef: request.providerRouteRef,
        credentialBindingRef: request.credentialBindingRef, credentialBindingDigest: request.credentialBindingDigest,
        credentialGeneration: request.credentialGeneration, credentialRevision: request.credentialRevision,
        resolutionAuthorityId: request.resolutionAuthorityId, resolutionGeneration: request.resolutionGeneration})));
      if (route === undefined) {lifecycle.markUsed(); return deny("route_unavailable");}
      policy = validation.snapshotPolicy(await owners.policyAuthority.resolve());
    } catch {lifecycle.markUsed(); return deny("authority_unavailable");}
    if (policy === undefined) {lifecycle.markUsed(); return deny("authority_unavailable");}
    if (!routeMatches(route, request)) {lifecycle.markUsed(); return deny("route_mismatch");}
    const capturedRequest = validation.snapshotRequest(preliminary.request, route.host);
    if (capturedRequest === undefined || capturedRequest.requestDigest !== preliminary.requestDigest ||
        capturedRequest.pathDigest !== preliminary.pathDigest) {lifecycle.markUsed(); return deny("invalid_request");}
    if (capturedRequest.applicationBytes > request.budgets.requestBytes) {lifecycle.markUsed(); return deny("invalid_request");}
    if (capturedRequest.applicationBytes > policy.maxRequestBytes || request.budgets.requestBytes > policy.maxRequestBytes ||
        request.budgets.responseBytes > policy.maxResponseBytes || request.budgets.deadlineMs > policy.maxDeadlineMs) {
      lifecycle.markUsed(); return deny("budget_exceeded");
    }
    if (!lifecycle.active) {return deny("authority_drift");}
    try {const session = validation.captureTransport(await owners.transportGateway.openOneShotHttps());
      if (session !== undefined) {lifecycle.attach(session);}}
    catch {lifecycle.markUsed(); return deny("transport_denied");}
    const transport = lifecycle.transport;
    if (transport === undefined || lifecycle.writeExact === undefined) {lifecycle.markUsed(); return deny("transport_denied");}
    if (!lifecycle.active) {return await lifecycle.closeTransport() ? deny("authority_drift") : uncertain("close_failed");}

    let boundaryOpen = true; let callbackCount = 0; let writeAttempted = false; let wrote = false; let callbackPending = false;
    let boundaryReceipt: object | undefined; let callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined;
    let expectedCanonical: Uint8Array | undefined; let writtenCanonical: Uint8Array | undefined;
    let writtenApplication: Uint8Array | undefined;
    const callbacks = new Set<Promise<unknown>>();
    const beforeFirstWrite = (rawObservation: unknown) => {
      callbackCount += 1; callbackPending = true;
      if (!boundaryOpen || callbackCount !== 1 || !lifecycle.active) {
        lifecycle.quarantine(); callbackDenial = deny("authorization_invalid"); callbackPending = false;
        return Promise.resolve(freeze({status: "denied" as const}));
      }
      // oxlint-disable-next-line complexity -- indivisible revalidation/sign/write conditions must all fail closed.
      const pending = (async () => {
        const observation = validation.snapshotObservation(rawObservation);
        if (observation === undefined) {callbackDenial = deny("address_denied"); return freeze({status: "denied" as const});}
        if (observation.resolutionAuthorityId !== route.resolutionAuthorityId ||
            observation.resolutionGeneration !== route.resolutionGeneration || observation.tlsServerName !== route.tlsServerName ||
            observation.peerPort !== route.port || !route.allowedTlsSpkiDigests.includes(observation.tlsSpkiDigest)) {
          callbackDenial = deny("tls_peer_mismatch"); return freeze({status: "denied" as const});
        }
        if (observation.applicationBytesDigest !== capturedRequest.applicationBytesDigest ||
            observation.applicationBytes !== capturedRequest.applicationBytes) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});
        }
        let receipt; let timed; let routeCurrent = false;
        try {
          receipt = validation.committedReceipt(await owners.dispatchAuthority.observeDispatchConsumption(request.dispatch), request.dispatch);
          timed = frozenExact(validation, await owners.policyAuthority.revalidateExact(policy), ["status", "observedAt"]);
          routeCurrent = frozenExact(validation, await owners.routeAuthority.revalidateExact(route), ["status"])?.status === "current";
        } catch {callbackDenial = deny("authority_unavailable"); return freeze({status: "denied" as const});}
        if (!boundaryOpen || !lifecycle.active) {callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        if (receipt === undefined) {callbackDenial = deny("dispatch_not_committed"); return freeze({status: "denied" as const});}
        if (!routeCurrent) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        const issuedAt = timed?.status === "current" && Number.isSafeInteger(timed.observedAt) &&
          (timed.observedAt as number) >= policy.observedAt ? timed.observedAt as number : undefined;
        if (issuedAt === undefined) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        if (issuedAt >= policy.expiresAt || issuedAt - policy.observedAt > request.budgets.deadlineMs) {
          callbackDenial = deny("expired"); return freeze({status: "denied" as const});}
        const body = authorizationBody({route, request, receipt, identity: captured.identity, policy, issuedAt,
          capturedRequest, observation});
        const canonicalBody = validation.canonicalAuthorization(body); let envelope: EgressAuthorizationEnvelopeV1 | undefined;
        try {const signed = owners.signer.sign(canonicalBody.slice(), freeze({keyId: policy.keyId,
          keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision}));
          if (!primitives.thenable(signed)) {const raw = validation.exact(signed, ["keyId", "keyGeneration", "signerRevision", "digest", "signature"]);
            if (raw?.keyId === policy.keyId && raw.keyGeneration === policy.keyGeneration && raw.signerRevision === policy.signerRevision &&
                isDigest(raw.digest) && primitives.canonicalEd25519Signature(raw.signature)) {envelope = freeze({...raw}) as EgressAuthorizationEnvelopeV1;}}
        } catch {envelope = undefined;}
        let verified: unknown = false;
        try {verified = envelope === undefined ? false : owners.signer.verify(canonicalBody.slice(), envelope);} catch {verified = false;}
        if (envelope === undefined || envelope.digest !== validation.hash(canonicalBody) || primitives.thenable(verified) || verified !== true) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        if (!boundaryOpen || callbackCount !== 1 || !lifecycle.active) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        const exposedCanonical = canonicalBody.slice(); const exposedApplication = capturedRequest.applicationBuffer.slice();
        const authorization = freeze({body, canonicalBody: exposedCanonical, envelope});
        try {writeAttempted = true; const returned = lifecycle.writeExact?.(freeze({authorization, applicationBytes: exposedApplication}));
          if (returned !== undefined || !sameBytes(exposedCanonical, canonicalBody) ||
              !sameBytes(exposedApplication, capturedRequest.applicationBuffer)) {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid");
            return freeze({status: "denied" as const});}}
        catch {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        if (callbackCount !== 1 || !boundaryOpen || !lifecycle.active) {lifecycle.quarantine(); callbackDenial = deny("authorization_invalid");
          return freeze({status: "denied" as const});}
        expectedCanonical = canonicalBody.slice(); writtenCanonical = exposedCanonical; writtenApplication = exposedApplication;
        wrote = true; boundaryReceipt = freeze({}); return freeze({status: "written" as const, boundaryReceipt});
      })();
      callbacks.add(pending); void pending.finally(() => {callbackPending = false; callbacks.delete(pending);}); return pending;
    };
    let result; let returnedWhilePending = false;
    try {result = validation.snapshotTransportResult(await transport.execute(freeze({target: freeze({scheme: route.scheme,
      host: route.host, port: route.port, tlsServerName: route.tlsServerName, path: request.path}), request: capturedRequest.buffered,
      responseByteLimit: request.budgets.responseBytes, deadlineMs: request.budgets.deadlineMs, beforeFirstWrite})));
      returnedWhilePending = callbackPending;
    } catch {result = freeze({status: "write_indeterminate" as const});}
    boundaryOpen = false; await Promise.allSettled(callbacks); const interrupted = !lifecycle.active;
    const closed = await lifecycle.closeTransport(); lifecycle.releaseTransport();
    if (!closed) {return uncertain("close_failed");}
    if (lifecycle.quarantined) {return uncertain("first_write_indeterminate");}
    if (result === undefined) {if (writeAttempted) {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
      return uncertain("response_invalid");}
    if (result.status === "write_indeterminate") {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
    if (result.status === "not_sent") {if (writeAttempted) {lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
      lifecycle.markUsed(); return callbackDenial ?? deny("transport_denied");}
    if (interrupted || returnedWhilePending || callbackCount !== 1 || callbackDenial !== undefined || !wrote ||
        writtenCanonical === undefined || writtenApplication === undefined ||
        expectedCanonical === undefined || !sameBytes(writtenCanonical, expectedCanonical) ||
        !sameBytes(writtenApplication, capturedRequest.applicationBuffer) || result.boundaryReceipt !== boundaryReceipt) {
      lifecycle.quarantine(); return uncertain("first_write_indeterminate");}
    lifecycle.markUsed(); if (result.responseBytes > request.budgets.responseBytes) {return uncertain("response_invalid");}
    return freeze({status: "completed", responseDigest: result.responseDigest, responseBytes: result.responseBytes,
      applicationBytesDigest: capturedRequest.applicationBytesDigest, applicationBytesWritten: capturedRequest.applicationBytes});
  };
  return freeze({exchange(unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]) {
    if (!lifecycle.activate()) {return Promise.resolve(deny("invalid_request"));}
    const flight = run(unsafe).catch(() => {lifecycle.quarantine(); return uncertain("first_write_indeterminate");});
    lifecycle.track(flight); return flight;
  }, dispose: () => lifecycle.dispose()});
};
