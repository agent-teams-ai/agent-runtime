import type { ContainedTurnEgress, ContainedTurnEgressDependencies, ContainedTurnEgressRequest,
  ContainedTurnEgressResult, EgressAuthorizationBodyV1, EgressAuthorizationEnvelopeV1,
  ExactFirstWriteReceiptV1, EgressTransportV1, ProviderRouteAuthoritySnapshotV1,
  TrustedEgressHostIdentityV1 } from "./composition.js";
import { createEgressValidation, isDigest, type EgressSecurityPrimitives } from "./validation.js";

const freeze = Object.freeze;
const deny = (reason: Extract<ContainedTurnEgressResult, {status: "denied"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "denied"}> => freeze({status: "denied", reason, deniedApplicationBytes: 0});
const uncertain = (reason: Extract<ContainedTurnEgressResult, {status: "indeterminate"}>["reason"]):
Extract<ContainedTurnEgressResult, {status: "indeterminate"}> => freeze({status: "indeterminate", reason});
const routeMatches = (route: ProviderRouteAuthoritySnapshotV1, request: ContainedTurnEgressRequest) =>
  route.tenantId === request.scope.tenantId && route.projectId === request.scope.projectId &&
  route.providerId === request.providerId && route.providerAccountRef === request.providerAccountRef &&
  route.providerRouteRef === request.providerRouteRef && route.credentialBindingRef === request.credentialBindingRef &&
  route.credentialBindingDigest === request.credentialBindingDigest && route.credentialGeneration === request.credentialGeneration &&
  route.credentialRevision === request.credentialRevision && route.pathConstraint === request.path;

// oxlint-disable-next-line max-lines-per-function -- owns one-shot state and its indivisible final boundary closure.
export const createContainedTurnEgressGatewayCore = (trustedIdentity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies, primitives: EgressSecurityPrimitives): ContainedTurnEgress => {
  const validation = createEgressValidation(primitives); const captured = validation.captureComposition(trustedIdentity, dependencies);
  const owners = captured.dependencies; let state: "open" | "active" | "closing" | "used" | "closed" | "quarantined" = "open";
  let transport: EgressTransportV1 | undefined; let closure: Promise<boolean> | undefined;
  let flight: Promise<ContainedTurnEgressResult> | undefined;
  const isQuarantined = () => state === "quarantined";
  const markUsed = () => {if (state === "active") {state = "used";}};
  const close = async () => {
    if (closure !== undefined) {return await closure;}
    if (transport === undefined) {return true;}
    closure = (async () => {try {await transport?.close(); return true;} catch {state = "quarantined"; return false;}})();
    return await closure;
  };
  // oxlint-disable-next-line complexity -- ordered one-shot denial and quarantine transitions remain explicit.
  const run = async (unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]): Promise<ContainedTurnEgressResult> => {
    const preliminary = validation.snapshotRequest(unsafe);
    if (preliminary === undefined) {markUsed(); return deny("invalid_request");}
    const request = preliminary.request; let route; let policy;
    if (preliminary.applicationBytes > request.budgets.requestBytes) {markUsed(); return deny("invalid_request");}
    try {
      const routeRaw = await owners.routeAuthority.resolveExact(freeze({tenantId: request.scope.tenantId,
        projectId: request.scope.projectId, providerId: request.providerId, providerAccountRef: request.providerAccountRef,
        providerRouteRef: request.providerRouteRef, credentialBindingRef: request.credentialBindingRef,
        credentialBindingDigest: request.credentialBindingDigest, credentialGeneration: request.credentialGeneration,
        credentialRevision: request.credentialRevision}));
      const policyRaw = await owners.policyAuthority.resolve(); route = validation.snapshotRoute(routeRaw);
      policy = validation.snapshotPolicy(policyRaw);
    } catch {markUsed(); return deny("authority_unavailable");}
    if (route === undefined) {markUsed(); return deny("route_unavailable");}
    if (policy === undefined) {markUsed(); return deny("authority_unavailable");}
    if (!routeMatches(route, request)) {markUsed(); return deny("route_mismatch");}
    const capturedRequest = validation.snapshotRequest(preliminary.request, route.host);
    if (capturedRequest === undefined || capturedRequest.requestDigest !== preliminary.requestDigest ||
        capturedRequest.pathDigest !== preliminary.pathDigest) {markUsed(); return deny("invalid_request");}
    if (capturedRequest.applicationBytes > request.budgets.requestBytes) {markUsed(); return deny("invalid_request");}
    if (capturedRequest.applicationBytes > policy.maxRequestBytes ||
        request.budgets.requestBytes > policy.maxRequestBytes || request.budgets.responseBytes > policy.maxResponseBytes ||
        request.budgets.deadlineMs > policy.maxDeadlineMs) {
      markUsed(); return deny("budget_exceeded");
    }
    if (state !== "active") {return deny("authority_drift");}
    try {transport = validation.captureTransport(await owners.transportGateway.openOneShotHttps());}
    catch {markUsed(); return deny("transport_denied");}
    if (transport === undefined) {markUsed(); return deny("transport_denied");}
    if (state !== "active") {return await close() ? deny("authority_drift") : uncertain("close_failed");}

    let boundaryOpen = true; let callbackCount = 0; let writeAttempted = false; let wrote = false; let callbackPending = false;
    let boundaryReceipt: object | undefined; let writeReceipt: ExactFirstWriteReceiptV1 | undefined;
    let callbackDenial: Extract<ContainedTurnEgressResult, {status: "denied"}> | undefined;
    const callbacks = new Set<Promise<unknown>>();
    const beforeFirstWrite = (rawObservation: unknown, write: (authorization: Readonly<{body: EgressAuthorizationBodyV1;
      canonicalBody: Uint8Array; envelope: EgressAuthorizationEnvelopeV1}>) => unknown) => {
      callbackCount += 1; callbackPending = true;
      if (!boundaryOpen || callbackCount !== 1 || state !== "active" || !primitives.callable(write)) {
        callbackDenial = deny("authorization_invalid"); callbackPending = false;
        return Promise.resolve(freeze({status: "denied" as const}));
      }
      // oxlint-disable-next-line complexity -- indivisible revalidation/sign/write conditions must all fail closed.
      const pending = (async () => {
        const observation = validation.snapshotObservation(rawObservation);
        if (observation === undefined) {callbackDenial = deny("address_denied"); return freeze({status: "denied" as const});}
        if (observation.tlsServerName !== route.tlsServerName || observation.peerPort !== route.port ||
            !route.allowedTlsSpkiDigests.includes(observation.tlsSpkiDigest)) {
          callbackDenial = deny("tls_peer_mismatch"); return freeze({status: "denied" as const});
        }
        if (observation.applicationBytesDigest !== capturedRequest.applicationBytesDigest ||
            observation.applicationBytes !== capturedRequest.applicationBytes) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});
        }
        let routeOutcome: unknown; let dispatchOutcome: unknown; let policyOutcome: unknown;
        try {routeOutcome = await owners.routeAuthority.revalidateExact(route);
          dispatchOutcome = await owners.dispatchAuthority.observeDispatchConsumption(request.dispatch);
          policyOutcome = await owners.policyAuthority.revalidateExact(policy);
        } catch {callbackDenial = deny("authority_unavailable"); return freeze({status: "denied" as const});}
        if (!boundaryOpen || state !== "active") {callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        if (validation.exact(routeOutcome, ["status"])?.status !== "current") {
          callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        const receipt = validation.committedReceipt(dispatchOutcome, request.dispatch);
        if (receipt === undefined) {callbackDenial = deny("dispatch_not_committed"); return freeze({status: "denied" as const});}
        const timed = validation.exact(policyOutcome, ["status", "observedAt"]);
        const issuedAt = timed?.status === "current" && Number.isSafeInteger(timed.observedAt) &&
          (timed.observedAt as number) >= policy.observedAt ? timed.observedAt as number : undefined;
        if (issuedAt === undefined) {callbackDenial = deny("authority_drift"); return freeze({status: "denied" as const});}
        if (issuedAt >= policy.expiresAt || issuedAt - policy.observedAt > request.budgets.deadlineMs) {
          callbackDenial = deny("expired"); return freeze({status: "denied" as const});}
        const body: EgressAuthorizationBodyV1 = freeze({contractVersion: "contained-turn-egress-authorization-body/v1",
          tenantId: route.tenantId, projectId: route.projectId, scopeDigest: receipt.scope.scopeDigest,
          providerId: route.providerId, providerAccountRef: route.providerAccountRef, providerRouteRef: route.providerRouteRef,
          credentialBindingRef: route.credentialBindingRef, credentialBindingDigest: route.credentialBindingDigest,
          credentialGeneration: route.credentialGeneration, credentialRevision: route.credentialRevision,
          routeRevision: route.routeRevision, routeAuthorityDigest: route.authorityDigest, operationId: receipt.operationId,
          attemptId: captured.identity.attemptId, dispatchReceipt: receipt, requestId: request.requestId,
          requestNonce: request.requestNonce, environmentId: captured.identity.environmentId, gatewayId: captured.identity.gatewayId,
          hostInstanceId: captured.identity.hostInstanceId, hostBootId: captured.identity.hostBootId,
          transportMode: captured.identity.transportMode, policyId: policy.policyId, policyRevision: policy.policyRevision,
          policyGeneration: policy.policyGeneration, keyId: policy.keyId, keyGeneration: policy.keyGeneration,
          signerRevision: policy.signerRevision, timeAuthorityId: policy.timeAuthorityId, timeGeneration: policy.timeGeneration,
          issuedAt, expiresAt: policy.expiresAt, target: freeze({scheme: route.scheme, host: route.host, port: route.port,
            tlsServerName: route.tlsServerName, pathDigest: capturedRequest.pathDigest}),
          allowedTlsSpkiDigests: route.allowedTlsSpkiDigests, tlsPinSetDigest: route.tlsPinSetDigest,
          tlsPinSetGeneration: route.tlsPinSetGeneration, tlsPinSetRevision: route.tlsPinSetRevision,
          resolutionAuthorityId: observation.resolutionAuthorityId, resolutionGeneration: observation.resolutionGeneration,
          answerSetDigest: observation.answerSetDigest, addresses: observation.canonicalAddresses,
          peerAddress: observation.peerAddress, peerPort: observation.peerPort, tlsSpkiDigest: observation.tlsSpkiDigest,
          alpn: observation.alpn, method: request.method, headerDigest: capturedRequest.headerDigest,
          bodyDigest: capturedRequest.bodyDigest, requestDigest: capturedRequest.requestDigest,
          applicationBytesDigest: capturedRequest.applicationBytesDigest, applicationBytes: capturedRequest.applicationBytes,
          budgets: request.budgets, policyMaxima: freeze({requestBytes: policy.maxRequestBytes,
            responseBytes: policy.maxResponseBytes, deadlineMs: policy.maxDeadlineMs})});
        const canonicalBody = validation.canonicalAuthorization(body); let envelope: EgressAuthorizationEnvelopeV1 | undefined;
        try {const signed = owners.signer.sign(Uint8Array.from(canonicalBody), freeze({keyId: policy.keyId,
          keyGeneration: policy.keyGeneration, signerRevision: policy.signerRevision}));
          if (!primitives.thenable(signed)) {const raw = validation.exact(signed, ["keyId", "keyGeneration", "signerRevision", "digest", "signature"]);
            if (raw?.keyId === policy.keyId && raw.keyGeneration === policy.keyGeneration && raw.signerRevision === policy.signerRevision &&
                isDigest(raw.digest) && primitives.canonicalEd25519Signature(raw.signature)) {
              envelope = freeze({...raw}) as EgressAuthorizationEnvelopeV1;}}
        } catch {envelope = undefined;}
        let verified: unknown = false;
        try {verified = envelope === undefined ? false : owners.signer.verify(Uint8Array.from(canonicalBody), envelope);} catch {verified = false;}
        if (envelope === undefined || envelope.digest !== validation.hash(canonicalBody) || primitives.thenable(verified) || verified !== true) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        const auth = freeze({body, canonicalBody: Uint8Array.from(canonicalBody), envelope}); let rawReceipt: unknown;
        try {writeAttempted = true; rawReceipt = write(auth);} catch {callbackDenial = deny("authorization_invalid");
          return freeze({status: "denied" as const});}
        const canonicalUnchanged = auth.canonicalBody.byteLength === canonicalBody.byteLength &&
          auth.canonicalBody.every((byte, index) => byte === canonicalBody[index]);
        if (primitives.thenable(rawReceipt) || !canonicalUnchanged || callbackCount !== 1 || !boundaryOpen || state !== "active") {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        const exactReceipt = validation.exact(rawReceipt, ["status", "authorizationDigest", "applicationBytesDigest", "applicationBytesWritten"]);
        if (exactReceipt?.status !== "written" || exactReceipt.authorizationDigest !== envelope.digest ||
            exactReceipt.applicationBytesDigest !== capturedRequest.applicationBytesDigest ||
            exactReceipt.applicationBytesWritten !== capturedRequest.applicationBytes) {
          callbackDenial = deny("authorization_invalid"); return freeze({status: "denied" as const});}
        wrote = true; writeReceipt = freeze({...exactReceipt}) as ExactFirstWriteReceiptV1; boundaryReceipt = freeze({});
        return freeze({status: "written" as const, boundaryReceipt});
      })();
      callbacks.add(pending); void pending.finally(() => {callbackPending = false; callbacks.delete(pending);}); return pending;
    };
    let rawResult: unknown; let returnedWhilePending = false;
    try {rawResult = await transport.execute(freeze({target: freeze({scheme: route.scheme, host: route.host, port: route.port,
      tlsServerName: route.tlsServerName, path: request.path}), request: capturedRequest.buffered,
      responseByteLimit: request.budgets.responseBytes, deadlineMs: request.budgets.deadlineMs, beforeFirstWrite}));
      returnedWhilePending = callbackPending;
    } catch {rawResult = freeze({status: "write_indeterminate"});}
    boundaryOpen = false; await Promise.allSettled(callbacks); const interrupted = state !== "active";
    const result = validation.snapshotTransportResult(rawResult); const closed = await close(); transport = undefined;
    if (!closed) {return uncertain("close_failed");}
    const quarantine = () => {state = "quarantined"; return uncertain("first_write_indeterminate");};
    if (result === undefined) {return writeAttempted ? quarantine() : uncertain("response_invalid");}
    if (result.status === "write_indeterminate") {return quarantine();}
    if (result.status === "not_sent") {if (writeAttempted) {return quarantine();} markUsed();
      return callbackDenial ?? deny("transport_denied");}
    const echoed = validation.exact(rawResult, ["status", "applicationBytesDigest", "applicationBytesWritten", "responseBytes",
      "responseDigest", "boundaryReceipt"]);
    if (interrupted || returnedWhilePending || callbackCount !== 1 || callbackDenial !== undefined || !wrote ||
        writeReceipt === undefined || echoed?.boundaryReceipt !== boundaryReceipt ||
        result.applicationBytesDigest !== writeReceipt.applicationBytesDigest ||
        result.applicationBytesWritten !== writeReceipt.applicationBytesWritten) {return quarantine();}
    markUsed(); if (result.responseBytes > request.budgets.responseBytes) {return uncertain("response_invalid");}
    return freeze({status: "completed", responseDigest: result.responseDigest, responseBytes: result.responseBytes,
      applicationBytesDigest: result.applicationBytesDigest, applicationBytesWritten: result.applicationBytesWritten});
  };
  return freeze({exchange(unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]) {
    if (state !== "open") {return Promise.resolve(deny("invalid_request"));} state = "active"; flight = run(unsafe); return flight;
  }, async dispose() {if (state === "closed") {return "closed" as const;} if (isQuarantined()) {return "quarantined" as const;}
    if (state === "open" || state === "active") {state = "closing";} if (flight !== undefined) {await flight;}
    if (isQuarantined()) {return "quarantined" as const;} if (!await close()) {return "quarantined" as const;}
    transport = undefined; state = "closed"; return "closed" as const;}});
};
