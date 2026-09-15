import {types as utilTypes} from "node:util";
import type {HostHttpResolverObservation} from "./http-egress-ports.js";
import {boundedHttpOpaque} from "./http-ingress-validation.js";
import {normalizeHttpEgressResolution} from "./public-address-policy.js";

// Resolver observations are untrusted data: inspect descriptors before reading values.
const resolverRecord = (value: unknown, fields: readonly string[]): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {return undefined;}
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {return undefined;}
    result[field] = descriptor.value;
  }
  return result;
};
const resolverAddresses = (value: unknown): string[] | undefined => {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)
    || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {return undefined;}
  const length = value.length;
  if (length < 1 || length > 32) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length + 1) {return undefined;}
  const addresses: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {return undefined;}
    const entry = resolverRecord(descriptor.value, ["family", "address", "classification"]);
    if (entry === undefined || typeof entry.address !== "string" || entry.address.length > 64 || entry.classification !== "public"
      || entry.family !== (entry.address.includes(":") ? "ipv6" : "ipv4")) {return undefined;}
    addresses.push(entry.address);
  }
  return addresses;
};

export const normalizeHttpResolverEvidence = (rawResolution: unknown): HostHttpResolverObservation | undefined => {
  const raw = resolverRecord(rawResolution,
    ["addresses", "selectedAddress", "resolutionCount", "resolverIdentity", "resolverEpoch"]);
  if (raw === undefined || raw.resolutionCount !== 1
    || !boundedHttpOpaque(raw.resolverIdentity) || !boundedHttpOpaque(raw.resolverEpoch)) {return undefined;}
  const values = resolverAddresses(raw.addresses);
  const normalized = normalizeHttpEgressResolution(values, raw.selectedAddress);
  if (normalized === undefined) {return undefined;}
  const addresses: HostHttpResolverObservation["addresses"] = Object.freeze(normalized.addresses.map(address =>
    Object.freeze({family: address.includes(":") ? "ipv6" as const : "ipv4" as const, address,
      classification: "public" as const})));
  return Object.freeze({selectedAddress: normalized.selectedAddress, addresses,
    resolverIdentity: raw.resolverIdentity, resolverEpoch: raw.resolverEpoch, resolutionCount: 1});
};
