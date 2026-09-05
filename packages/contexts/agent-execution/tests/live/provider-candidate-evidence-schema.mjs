import { types } from "node:util";
import { sha256 } from "./provider-candidate-build-tree.mjs";
import { DARWIN_LIMITATIONS } from "./provider-candidate-observation.mjs";

const reject = () => {throw new TypeError("candidate evidence must match the bounded immutable schema");};
export const record = (value, fields, required = fields) => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) {return reject();}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > fields.length || required.some(key => !Object.hasOwn(descriptors, key))) {return reject();}
  const result = {};
  for (const key of keys.sort()) {
    const property = descriptors[key];
    if (!fields.includes(key) || !Object.hasOwn(property, "value") || !property.enumerable) {return reject();}
    result[key] = property.value;
  }
  return result;
};
export const choice = (value, values) => values.includes(value) ? value : reject();
const text = (value, pattern) => typeof value === "string" && value.length <= 512 && pattern.test(value) ? value : reject();
export const exactDigest = value => `sha256:${text(value, /^[a-f0-9]{64}$/u)}`;
const token = value => text(value, /^[a-zA-Z0-9][a-zA-Z0-9:._+@-]{0,511}$/u);
const packageRevision = value => text(value, /^@[a-z0-9-]+\/[a-z0-9-]+[@:][0-9]+\.[0-9]+\.[0-9]+(?:[+-][a-z0-9.-]+)?$/u);
const version = value => text(value, /^[0-9]+\.[0-9]+\.[0-9]+$/u);

const TUPLE_FIELDS = Object.freeze({
  adapterRevision: token, architecture: value => choice(value, ["x64", "arm64"]),
  binaryRevision: value => typeof value === "string" && value.startsWith("sha256:") ? text(value, /^sha256:[a-f0-9]{64}$/u) : packageRevision(value),
  binarySha256: exactDigest, clientName: value => choice(value, ["agent-runtime"]),
  containmentProfile: value => choice(value, ["strict-linux-cgroup-v2", "cooperative-darwin-posix-process-group"]),
  nativeDependencyAliasRevision: packageRevision, packageRevision,
  platform: value => choice(value, ["linux", "darwin"]), platformFamily: value => choice(value, ["unix"]),
  platformOs: value => choice(value, ["linux", "macos"]), protocolRevision: token,
  resolvedNativePackageRevision: packageRevision, userAgentArchitecture: value => choice(value, ["arm64", "x86_64"]),
  userAgentOsName: value => choice(value, ["Mac OS", "Ubuntu"]), version,
  bundledCliVersion: version, executableSha256: exactDigest, manifestRevision: token,
  resourceScopeRevision: token, sdkVersion: version,
  workspaceAuthority: value => choice(value, ["canonical-operation-workspace", "retained-descriptor"]),
});

export const safeTuple = input => {
  const tuple = record(input, Object.keys(TUPLE_FIELDS), ["platform", "architecture"]);
  for (const key of Object.keys(tuple)) {tuple[key] = TUPLE_FIELDS[key](tuple[key]);}
  if ((tuple.platform === "linux") !== (tuple.architecture === "x64")) {return reject();}
  return Object.freeze(tuple);
};

export const safePackageIdentity = input => {
  const fields = {
    nativeDependencyAliasRevision: packageRevision, resolvedNativePackageRevision: packageRevision,
    wrapperPackageRevision: packageRevision, bundledCliVersion: version, sdkRevision: packageRevision,
  };
  const result = record(input, Object.keys(fields), []);
  if (Object.keys(result).length === 0) {return reject();}
  for (const key of Object.keys(result)) {result[key] = fields[key](result[key]);}
  return Object.freeze(result);
};

const limitations = input => {
  if (!input || types.isProxy(input) || !Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Array.prototype || !Object.isFrozen(input) || input.length > 4) {return reject();}
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(properties).length !== input.length + 1) {return reject();}
  const result = [];
  for (let i = 0; i < input.length; i += 1) {
    const property = properties[i];
    if (!property || !Object.hasOwn(property, "value") || !property.enumerable) {return reject();}
    result.push(choice(property.value, DARWIN_LIMITATIONS));
  }
  if (new Set(result).size !== result.length) {return reject();}
  return Object.freeze(result.sort());
};
const OBSERVATIONS = Object.freeze({
  artifactManifestRef: value => text(value, /^urn:agent-runtime:artifact-manifest:[a-f0-9]{64}$/u),
  resultRef: value => text(value, /^urn:agent-runtime:contained-turn-result:[a-f0-9]{64}$/u),
  closureStatus: value => choice(value, ["closed", "quarantined"]),
  containmentLimitations: limitations, containmentProfile: TUPLE_FIELDS.containmentProfile,
  containmentProofDigest: exactDigest, errorDigest: exactDigest, outputDigest: exactDigest,
  executionClosureProofDigest: exactDigest, operationIdentityDigest: exactDigest,
  outputDrainProofDigest: exactDigest, providerTerminalProofDigest: exactDigest, terminalProofDigest: exactDigest,
  outputEvents: value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : reject(),
  providerOutcome: value => choice(value, ["succeeded", "failed", "cancelled", "indeterminate"]),
  reconciliation: value => choice(value, ["clear", "required"]),
  terminalKind: value => choice(value, ["open", "final"]),
  terminalStatus: value => choice(value, ["succeeded", "failed", "cancelled", "reconcile_required"]),
  ownerDisposal: value => choice(value, ["completed", "failed", "not_observed"]),
  runtimeDisposal: value => choice(value, ["completed", "failed", "not_observed"]),
});
export const safeObservations = input => {
  const result = record(input, Object.keys(OBSERVATIONS), []);
  for (const key of Object.keys(result)) {result[key] = OBSERVATIONS[key](result[key]);}
  return Object.freeze(result);
};

export const validateCompletion = (input, observations, tuple) => {
  if (input.status !== "provider-completed") {return;}
  const darwin = tuple.platform === "darwin";
  if (observations.providerOutcome !== "succeeded" || observations.closureStatus !== "closed" ||
      observations.ownerDisposal !== "completed" || observations.runtimeDisposal !== "completed" ||
      observations.terminalStatus !== (darwin ? "reconcile_required" : "succeeded") ||
      observations.terminalKind !== (darwin ? "open" : "final") ||
      observations.reconciliation !== (darwin ? "required" : "clear") ||
      input.physicalContainment !== (darwin ? "indeterminate" : "contained") ||
      observations.containmentProfile !== (darwin ? "cooperative-darwin-posix-process-group" : "strict-linux-cgroup-v2")) {return reject();}
  for (const field of ["operationIdentityDigest", "executionClosureProofDigest", "providerTerminalProofDigest", "outputDrainProofDigest", "outputDigest", "outputEvents"]) {
    if (observations[field] === undefined) {return reject();}
  }
  if (!darwin && ["artifactManifestRef", "resultRef", "terminalProofDigest", "containmentProofDigest"].some(key => observations[key] === undefined)) {return reject();}
  if (darwin && (observations.terminalProofDigest !== undefined || observations.containmentProofDigest !== undefined)) {return reject();}
  if (JSON.stringify(observations.containmentLimitations) !== JSON.stringify(darwin ? [...DARWIN_LIMITATIONS].sort() : [])) {return reject();}
};

export const evidenceDigest = value => sha256(JSON.stringify(value));
