import { types } from "node:util";
import { detachEgressScope, detachProvisionalEgressInputV2, isNodeProxy } from
  "../adapters/node-egress-boundary.js";
import { createNodeSha256EgressDigest } from "../adapters/outbound/node-egress-cryptography.js";
import { canonicalEgressValue, digestCanonical } from "../application/egress-canonical.js";
import { deepFreezeEgress } from "../application/immutable.js";
import { validBudgets, validDigest, validOrigin, validRef, validRequestProjection } from
  "../domain/egress-values.js";
import type { CurrentEgressDispatchHead, CurrentEgressEndorsement, CurrentEgressOperation,
  CurrentEgressOwnerInput, CurrentEgressRoute } from "./current-egress-inputs.js";
import type { TrustedHostRequestProjectionV2 } from
  "../contracts/provider-process-egress-authorization-v2.js";

export function requireCurrentEgress(condition: unknown): asserts condition {
  if (!condition) {throw new TypeError("invalid current egress binding");}
}
export const sameCurrentEgress = (left: unknown, right: unknown): boolean =>
  canonicalEgressValue(left) === canonicalEgressValue(right);
export const currentEgressDigest = (value: unknown): string =>
  digestCanonical(createNodeSha256EgressDigest(), value);

// This private, closed shape walker bounds snapshots and never invokes property
// accessors or Proxy traps. Request/scope schemas reuse the existing RS boundary.
type Shape = ((value: unknown) => unknown) | { readonly [key: string]: Shape };
const capture = (value: unknown, shape: Shape): unknown => {
  if (typeof shape === "function") {return shape(value);}
  requireCurrentEgress(value !== null && typeof value === "object" && !isNodeProxy(value));
  requireCurrentEgress(Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireCurrentEgress(keys.length === Object.keys(shape).length &&
    keys.every(key => typeof key === "string" && Object.hasOwn(shape, key)));
  return Object.fromEntries(Object.entries(shape).map(([key, member]) => {
    const property = descriptors[key];
    requireCurrentEgress(property !== undefined && "value" in property && property.enumerable === true);
    return [key, capture(property!.value, member)];
  }));
};
const check = (predicate: (value: unknown) => boolean) => (value: unknown): unknown => {
  requireCurrentEgress(predicate(value)); return value;
};
const ref = check(value => typeof value === "string" && validRef(value));
const digest = check(value => typeof value === "string" && validDigest(value));
const integer = check(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const bool = check(value => typeof value === "boolean");
const literal = (expected: string) => check(value => value === expected);
const callback = check(value => typeof value === "function" && !types.isProxy(value));
const readCallback = check(value => typeof value === "function" && !types.isProxy(value) &&
  types.isAsyncFunction(value) && !types.isGeneratorFunction(value));
const monotonic = check(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
const version = check(value => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9_223_372_036_854_775_807n);
const scope = (value: unknown) => {
  const detached = detachEgressScope(value) as CurrentEgressOperation["scope"];
  requireCurrentEgress([detached.tenantId, detached.projectId, detached.operationId].every(validRef) &&
    validDigest(detached.scopeDigest)); return detached;
};
const operation = { scope, providerId: ref, authorityGeneration: ref, claimBindingDigest: digest };
const authority = { operation, decision: literal("accepted"),
  purpose: literal("contained-turn.provider-dispatch/v1"), authorityRevision: ref,
  acceptedAuthorityDigest: digest, authorityHeadDigest: digest, constraintsDigest: digest,
  containmentPolicyDigest: digest, requestDigest: digest, providerBindingDigest: digest,
  claimBeforeControlTime: integer, revoked: bool,
  ownerEvidenceRef: check(value => typeof value === "string" && value.length <= 512 &&
    /^runtime-security-evidence:v1:[A-Za-z0-9._:@-]+$/.test(value)) };
const head = { headVersion: check(value => value === "0" || version(value) === value),
  authority: (value: unknown) => value === null ? null : capture(value, authority) };
const slots = (value: unknown) => {
  requireCurrentEgress(Array.isArray(value) && !isNodeProxy(value));
  requireCurrentEgress(Object.getPrototypeOf(value) === Array.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const length = descriptors.length!.value as number;
  requireCurrentEgress(length >= 1 && length <= 16 && Reflect.ownKeys(descriptors).length === length + 1);
  return Array.from({ length }, (_, index) => {
    const item = descriptors[String(index)];
    requireCurrentEgress(item !== undefined && "value" in item && item.enumerable === true);
    return check(name => typeof name === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(name))(item!.value);
  });
};
const route = { method: check(value => typeof value === "string" &&
    ["DELETE", "GET", "PATCH", "POST", "PUT"].includes(value)),
  origin: { scheme: literal("https"), hostname: ref, port: integer },
  requestTarget: { digest, byteLength: integer }, credentialSlots: slots, credentialRecipeRef: ref,
  framing: { protocol: literal("http/1.1"), requestTarget: literal("origin-form"),
    authoritySource: literal("host"), contentLength: literal("body-byte-length"),
    transferEncoding: literal("absent"), connectionSpecificHeaders: literal("absent") } };
const rule = { policyRef: ref, revision: ref, expectedAcceptedConstraintsDigest: digest, route,
  tlsPolicyDigest: digest, limits: { requestBytes: integer, responseBytes: integer,
    totalMilliseconds: integer }, decisionTtlMilliseconds: integer };
const endorsement = { operation, accessRef: ref, accountRef: ref, providerRouteRef: ref,
  bindingRevision: integer, credentialBindingDigest: digest, credentialGeneration: ref,
  routeAuthorityDigest: digest, available: bool, revoked: bool, route };

export const captureCurrentEgressHead = (value: unknown): CurrentEgressDispatchHead =>
  deepFreezeEgress(capture(value, head)) as CurrentEgressDispatchHead;
export const captureCurrentEgressEndorsement = (value: unknown): CurrentEgressEndorsement | null =>
  value === null ? null : deepFreezeEgress(capture(value, endorsement)) as CurrentEgressEndorsement;
export const captureCurrentEgressResolve = (value: unknown) => {
  const captured = capture(value, { scope, authorizationRequestId: ref,
    request: (request: unknown) => (detachProvisionalEgressInputV2({
      contractVersion: "provider-process-egress-provisional/v2", authorizationRequestId: "snapshot",
      request }) as { request: TrustedHostRequestProjectionV2 }).request }) as {
        scope: CurrentEgressOperation["scope"]; authorizationRequestId: string;
        request: TrustedHostRequestProjectionV2 };
  requireCurrentEgress(validRequestProjection(captured.request));
  return deepFreezeEgress(captured);
};
export const captureCurrentEgressRead = (value: unknown) =>
  capture(value, { scope, authorityRef: ref }) as { scope: CurrentEgressOperation["scope"];
    authorityRef: string };

export const captureCurrentEgressInput = (value: unknown): CurrentEgressOwnerInput => {
  const result = capture(value, { operation, acceptedDispatch: head, rule,
    approval: { ruleRevision: ref, bindingDigest: digest }, timing: { controlTimeAtAnchor: integer,
      monotonicAtAnchor: monotonic, operationDeadlineMonotonic: monotonic, readTimeoutMilliseconds: integer },
    monotonicNow: callback, readRsHead: readCallback, readPaEndorsement: readCallback }) as CurrentEgressOwnerInput;
  const accepted = result.acceptedDispatch.authority;
  requireCurrentEgress(accepted !== null && !accepted.revoked && result.acceptedDispatch.headVersion !== "0");
  requireCurrentEgress(sameCurrentEgress(accepted!.operation, result.operation) &&
    result.rule.expectedAcceptedConstraintsDigest === accepted!.constraintsDigest &&
    result.approval.ruleRevision === result.rule.revision);
  requireCurrentEgress(result.approval.bindingDigest === currentEgressDigest({
    domain: "rs-current-egress-rule/v1", operation: result.operation,
    acceptedDispatch: result.acceptedDispatch, rule: result.rule }));
  requireCurrentEgress(validBudgets(result.rule.limits) && validOrigin(result.rule.route.origin) &&
    result.rule.route.requestTarget.byteLength <= 16_384);
  const names = result.rule.route.credentialSlots;
  requireCurrentEgress(names.every((name, index) => index === 0 || names[index - 1]! < name));
  requireCurrentEgress(result.rule.decisionTtlMilliseconds >= 1 && result.rule.decisionTtlMilliseconds <= 300_000);
  const time = result.timing;
  requireCurrentEgress(time.readTimeoutMilliseconds >= 1 && time.readTimeoutMilliseconds <= 60_000 &&
    time.operationDeadlineMonotonic > time.monotonicAtAnchor);
  return deepFreezeEgress(result);
};

export const matchesCurrentEgressRequest = (request: TrustedHostRequestProjectionV2,
  selected: CurrentEgressRoute): boolean =>
  request.method === selected.method &&
  sameCurrentEgress({ scheme: request.scheme, ...request.authority }, selected.origin) &&
  sameCurrentEgress(request.requestTarget, selected.requestTarget) &&
  sameCurrentEgress(request.headers.credentialFields.map(field => field.name), selected.credentialSlots) &&
  sameCurrentEgress({ ...request.framing, contentLength: "body-byte-length" }, selected.framing) &&
  request.framing.contentLength === request.body.byteLength;
