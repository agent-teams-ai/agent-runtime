import type { ContainedTurnEgressRequest, ContainedTurnEgressDependencies, ProviderRouteAuthoritySnapshotV1 } from "./composition.js";
import type { createEgressValidation } from "./validation.js";
import type { EgressOneShotLifecycle } from "./lifecycle.js";
import { frozenExact } from "./write-authorization.js";
import { deny } from "./results.js";
const freeze = Object.freeze;
const routeMatches = (route: ProviderRouteAuthoritySnapshotV1, request: ContainedTurnEgressRequest) =>
  route.tenantId === request.scope.tenantId && route.projectId === request.scope.projectId &&
  route.scopeDigest === request.scope.scopeDigest && route.providerId === request.providerId &&
  route.providerAccountRef === request.providerAccountRef && route.providerRouteRef === request.providerRouteRef &&
  route.credentialBindingRef === request.credentialBindingRef &&
  route.credentialBindingDigest === request.credentialBindingDigest && route.credentialGeneration === request.credentialGeneration &&
  route.credentialRevision === request.credentialRevision && route.resolutionAuthorityId === request.resolutionAuthorityId &&
  route.resolutionGeneration === request.resolutionGeneration && route.pathConstraint === request.path;
export const prepareExchange = async (unsafe: ContainedTurnEgressRequest,
  validation: ReturnType<typeof createEgressValidation>, owners: ContainedTurnEgressDependencies,
  lifecycle: EgressOneShotLifecycle) => {
  const preliminary = validation.snapshotRequest(unsafe);
  if (preliminary === undefined) {lifecycle.markUsed(); return deny("invalid_request");}
  const request = preliminary.request;
  if (preliminary.applicationBytes > request.budgets.requestBytes) {lifecycle.markUsed(); return deny("invalid_request");}
  let route; let policy;
  try {
    route = validation.snapshotRoute(await lifecycle.owner(() => owners.routeAuthority.resolveExact(freeze({tenantId: request.scope.tenantId,
      projectId: request.scope.projectId, scopeDigest: request.scope.scopeDigest, providerId: request.providerId,
      providerAccountRef: request.providerAccountRef, providerRouteRef: request.providerRouteRef,
      credentialBindingRef: request.credentialBindingRef, credentialBindingDigest: request.credentialBindingDigest,
      credentialGeneration: request.credentialGeneration, credentialRevision: request.credentialRevision,
      resolutionAuthorityId: request.resolutionAuthorityId, resolutionGeneration: request.resolutionGeneration}))));
    if (route === undefined) {lifecycle.markUsed(); return deny("route_unavailable");}
    policy = validation.snapshotPolicy(await lifecycle.owner(() => owners.policyAuthority.resolve()));
  } catch {lifecycle.markUsed(); return deny("authority_unavailable");}
  if (policy === undefined) {lifecycle.markUsed(); return deny("authority_unavailable");}
  if (!routeMatches(route, request) || request.dispatch.providerBindingDigest !== validation.routeBindingDigest(route)) {
    lifecycle.markUsed(); return deny("route_mismatch");}
  const capturedRequest = validation.snapshotRequest(preliminary.request, route.host);
  if (capturedRequest === undefined || capturedRequest.requestDigest !== preliminary.requestDigest ||
      capturedRequest.pathDigest !== preliminary.pathDigest) {lifecycle.markUsed(); return deny("invalid_request");}
  if (capturedRequest.applicationBytes > request.budgets.requestBytes) {lifecycle.markUsed(); return deny("invalid_request");}
  if (capturedRequest.applicationBytes > policy.maxRequestBytes || request.budgets.requestBytes > policy.maxRequestBytes ||
      request.budgets.responseBytes > policy.maxResponseBytes || request.budgets.deadlineMs > policy.maxDeadlineMs) {
    lifecycle.markUsed(); return deny("budget_exceeded");
  }
  // A caller's matching query is insufficient: inspect the committed owner's receipt before transport acquisition.
  try {
    const receipt = validation.committedReceipt(await lifecycle.owner(() =>
      owners.dispatchAuthority.observeDispatchConsumption(request.dispatch)), request.dispatch);
    if (receipt === undefined) {lifecycle.markUsed(); return deny("dispatch_not_committed");}
    const current = frozenExact(validation, await lifecycle.owner(() => owners.routeAuthority.revalidateExact(route)), ["status"]);
    if (current?.status !== "current") {lifecycle.markUsed(); return deny("authority_drift");}
  } catch {lifecycle.markUsed(); return deny("authority_unavailable");}
  return {request, route, policy, capturedRequest};
};
