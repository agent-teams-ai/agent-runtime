import { types as utilTypes } from "node:util";
import type {
  HttpEgressAuthorizationDecision,
  HttpEgressFinalAuthorizationDecision,
  HttpEgressRoute,
} from "./http-egress-ports.js";

const encoder = new TextEncoder();
const MAX_OPAQUE_RECEIPT_BYTES = 512;

const plainRecord = (value: unknown): object | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {return undefined;}
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : undefined;
};

const ownData = (record: object, name: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

const boundedOpaque = (value: unknown): value is string => typeof value === "string"
  && value.length > 0
  && value.length <= MAX_OPAQUE_RECEIPT_BYTES
  && value.isWellFormed()
  && encoder.encode(value).byteLength <= MAX_OPAQUE_RECEIPT_BYTES;

const snapshotAuthorization = (
  value: unknown,
  final: boolean,
): HttpEgressAuthorizationDecision | HttpEgressFinalAuthorizationDecision | undefined => {
  const record = plainRecord(value);
  if (record === undefined) {return undefined;}
  const decision = ownData(record, "decision");
  const receiptDigest = ownData(record, "receiptDigest");
  const validUntil = ownData(record, "validUntil");
  const policyGeneration = ownData(record, "policyGeneration");
  const keyGeneration = ownData(record, "keyGeneration");
  const routeGeneration = ownData(record, "routeGeneration");
  const credentialGeneration = ownData(record, "credentialGeneration");
  const materializationReceiptDigest = ownData(record, "materializationReceiptDigest");
  const bindingDigest = final ? ownData(record, "bindingDigest") : undefined;
  if ((decision !== "allow" && decision !== "deny") || !boundedOpaque(receiptDigest)
    || typeof validUntil !== "number" || !Number.isFinite(validUntil)
    || !boundedOpaque(policyGeneration) || !boundedOpaque(keyGeneration)
    || !boundedOpaque(routeGeneration) || !boundedOpaque(credentialGeneration)
    || !boundedOpaque(materializationReceiptDigest) || (final && !boundedOpaque(bindingDigest))) {
    return undefined;
  }
  const snapshot: HttpEgressAuthorizationDecision = Object.freeze({
    decision, receiptDigest, validUntil, policyGeneration, keyGeneration,
    routeGeneration, credentialGeneration, materializationReceiptDigest,
  });
  return final
    ? Object.freeze({ ...snapshot, bindingDigest: bindingDigest as string })
    : snapshot;
};

export const snapshotHttpAuthorizationDecision = (
  value: unknown,
): HttpEgressAuthorizationDecision | undefined => snapshotAuthorization(value, false);

export const snapshotHttpFinalAuthorizationDecision = (
  value: unknown,
): HttpEgressFinalAuthorizationDecision | undefined =>
  snapshotAuthorization(value, true) as HttpEgressFinalAuthorizationDecision | undefined;

export const httpAuthorizationMatches = (
  decision: HttpEgressAuthorizationDecision,
  route: HttpEgressRoute,
  now: number,
): boolean => decision.decision === "allow"
  && Number.isFinite(now) && now < decision.validUntil
  && decision.policyGeneration === route.policyGeneration
  && decision.keyGeneration === route.keyGeneration
  && decision.routeGeneration === route.routeGeneration
  && decision.credentialGeneration === route.credentialGeneration
  && decision.materializationReceiptDigest === route.materializationReceiptDigest;

export const httpFinalAuthorizationMatches = (
  decision: HttpEgressFinalAuthorizationDecision,
  bindingDigest: string,
  route: HttpEgressRoute,
  now: number,
): boolean => httpAuthorizationMatches(decision, route, now)
  && decision.bindingDigest === bindingDigest;

export type HttpEgressClosureDecision = Readonly<{
  state: "closed" | "unknown";
  receiptDigest: string;
}>;

export const snapshotHttpClosureDecision = (value: unknown): HttpEgressClosureDecision | undefined => {
  const record = plainRecord(value);
  if (record === undefined) {return undefined;}
  const state = ownData(record, "state");
  const receiptDigest = ownData(record, "receiptDigest");
  if ((state !== "closed" && state !== "unknown") || !boundedOpaque(receiptDigest)) {return undefined;}
  return Object.freeze({ state, receiptDigest });
};
