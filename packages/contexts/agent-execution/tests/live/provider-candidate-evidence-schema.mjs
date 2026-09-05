import { types } from "node:util";
import { sha256 } from "./provider-candidate-build-tree.mjs";
import { DARWIN_LIMITATIONS } from "./provider-candidate-observation.mjs";

const reject = () => {throw new TypeError("candidate evidence must match the bounded immutable schema");};
export const record = (value, fields, required = fields) => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) {return reject();}
  const keys = Reflect.ownKeys(value);
  if (keys.length > fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key)) ||
      required.some(key => !keys.includes(key))) {return reject();}
  const result = {};
  for (const key of keys.sort()) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(property, "value") || !property.enumerable) {return reject();}
    result[key] = property.value;
  }
  return result;
};
export const choice = (value, values) => values.includes(value) ? value : reject();
const text = (value, pattern) => typeof value === "string" && value.length <= 512 && pattern.test(value) ? value : reject();
export const exactDigest = value => `sha256:${text(value, /^[a-f0-9]{64}$/u)}`;
const packageRevision = value => text(value, /^@(?:openai\/codex(?:-linux-x64|-darwin-arm64)?[@:]0\.150\.1(?:[+-](?:linux-x64|darwin-arm64))?|anthropic-ai\/claude-agent-sdk@0\.3\.251)$/u);
const version = value => choice(value, ["0.150.1", "0.3.251", "2.1.251"]);

const TUPLE_FIELDS = Object.freeze({
  adapterRevision: value => choice(value, ["codex-app-server-contained-turn:0.150.1+native-permission-config-v2", "claude-agent-sdk-contained-turn:0.3.251"]),
  architecture: value => choice(value, ["x64", "arm64"]),
  binaryRevision: value => typeof value === "string" && value.startsWith("sha256:") ? text(value, /^sha256:[a-f0-9]{64}$/u) : packageRevision(value),
  binarySha256: exactDigest, clientName: value => choice(value, ["agent-runtime"]),
  containmentProfile: value => choice(value, ["strict-linux-cgroup-v2", "cooperative-darwin-posix-process-group"]),
  nativeDependencyAliasRevision: packageRevision, packageRevision,
  platform: value => choice(value, ["linux", "darwin"]), platformFamily: value => choice(value, ["unix"]),
  platformOs: value => choice(value, ["linux", "macos"]),
  protocolRevision: value => text(value, /^contained-turn:v1:codex-app-server:0\.150\.1:schema-[a-f0-9]{64}:bindings-[a-f0-9]{64}:agent-runtime-contained-v1:native-permission-config-v2$/u),
  resolvedNativePackageRevision: packageRevision, userAgentArchitecture: value => choice(value, ["arm64", "x86_64"]),
  userAgentOsName: value => choice(value, ["Mac OS", "Ubuntu"]), version,
  bundledCliVersion: version, executableSha256: exactDigest,
  manifestRevision: value => choice(value, ["claude-contained-turn-v1@1"]),
  resourceScopeRevision: value => choice(value, ["contained-turn-v1-worst-case-scope@1"]), sdkVersion: version,
  workspaceAuthority: value => choice(value, ["canonical-operation-workspace", "retained-descriptor"]),
});

export const safeTuple = input => {
  const tuple = record(input, Object.keys(TUPLE_FIELDS), ["platform", "architecture"]);
  for (const key of Object.keys(tuple)) {tuple[key] = TUPLE_FIELDS[key](tuple[key]);}
  if ((tuple.platform === "linux") !== (tuple.architecture === "x64")) {return reject();}
  const darwin = tuple.platform === "darwin";
  const expected = {
    containmentProfile: darwin ? "cooperative-darwin-posix-process-group" : "strict-linux-cgroup-v2",
    platformOs: darwin ? "macos" : "linux", userAgentArchitecture: darwin ? "arm64" : "x86_64",
    userAgentOsName: darwin ? "Mac OS" : "Ubuntu",
    workspaceAuthority: darwin ? "canonical-operation-workspace" : "retained-descriptor",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (tuple[key] !== undefined && tuple[key] !== value) {return reject();}
  }
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
  artifactManifestRefDigest: exactDigest, resultRefDigest: exactDigest,
  artifactManifestProofDigest: exactDigest, resultPublicationProofDigest: exactDigest,
  closureStatus: value => choice(value, ["closed", "not-started", "unproven"]),
  containmentLimitations: limitations, containmentProfile: TUPLE_FIELDS.containmentProfile,
  containmentProofDigest: exactDigest, failureKind: value => choice(value, ["canary-failed"]), outputDigest: exactDigest,
  executionClosureProofDigest: exactDigest, operationIdentityDigest: exactDigest,
  outputDrainProofDigest: exactDigest, providerTerminalProofDigest: exactDigest, terminalProofDigest: exactDigest,
  outputEvents: value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : reject(),
  providerOutcome: value => choice(value, ["succeeded", "failed", "cancelled", "indeterminate"]),
  reconciliation: value => choice(value, ["clear", "required"]),
  closureRecovery: value => choice(value, ["clear", "required", "proved_no_workspace"]),
  terminalKind: value => choice(value, ["open", "final"]),
  terminalStatus: value => choice(value, ["succeeded", "failed", "cancelled", "reconcile_required", "running", "accepted"]),
  ownerDisposal: value => choice(value, ["completed", "failed", "not_observed"]),
  runtimeDisposal: value => choice(value, ["completed", "failed", "not_observed"]),
});
export const safeObservations = input => {
  const result = record(input, Object.keys(OBSERVATIONS), ["ownerDisposal", "runtimeDisposal"]);
  for (const key of Object.keys(result)) {result[key] = OBSERVATIONS[key](result[key]);}
  for (const key of ["artifactManifestRef", "resultRef"]) {
    if (result[key] !== undefined && result[`${key}Digest`] !== undefined &&
        result[`${key}Digest`] !== exactDigest(sha256(result[key]))) {return reject();}
  }
  return Object.freeze(result);
};

const validateClosure = (input, observations, tuple) => {
  const darwin = tuple.platform === "darwin";
  const profile = darwin ? "cooperative-darwin-posix-process-group" : "strict-linux-cgroup-v2";
  if (tuple.containmentProfile !== undefined && tuple.containmentProfile !== profile) {return reject();}
  if (["closureStatus", "containmentProfile", "containmentLimitations"].every(key => observations[key] === undefined)) {return;}
  if (observations.closureStatus === undefined || observations.containmentProfile !== profile ||
      JSON.stringify(observations.containmentLimitations) !== JSON.stringify(darwin ? [...DARWIN_LIMITATIONS].sort() : [])) {return reject();}
  if (observations.closureStatus === "closed" &&
      (darwin || input.physicalContainment !== "contained" || observations.containmentProofDigest === undefined)) {return reject();}
  if (observations.closureStatus === "unproven" &&
      (input.physicalContainment !== "indeterminate" || observations.terminalKind === "final" ||
       (observations.terminalStatus !== undefined && observations.terminalStatus !== "reconcile_required") ||
       (observations.closureRecovery !== undefined && observations.closureRecovery !== "required") ||
       observations.containmentProofDigest !== undefined || observations.terminalProofDigest !== undefined)) {return reject();}
  if (observations.closureStatus === "not-started" &&
      (input.physicalContainment !== "indeterminate" || observations.terminalStatus === "succeeded" ||
       observations.containmentProofDigest !== undefined)) {return reject();}
};
const requireFacts = (observations, keys) => {
  if (keys.some(key => observations[key] === undefined)) {return reject();}
};
const hasReference = (observations, key) => observations[key] !== undefined || observations[`${key}Digest`] !== undefined;
const validateTerminal = (input, observations, tuple) => {
  const keys = ["terminalKind", "terminalStatus", "reconciliation", "closureRecovery"];
  const final = observations.terminalKind === "final";
  const finalStatus = ["succeeded", "failed", "cancelled"].includes(observations.terminalStatus);
  // Failure may retain only part of a kernel read. Missing facts do not imply
  // clear recovery or terminal success; explicit finality still needs proof.
  if (final || finalStatus || observations.terminalProofDigest !== undefined) {
    requireFacts(observations, [...keys, "operationIdentityDigest", "terminalProofDigest", "closureStatus"]);
    if (!final || !finalStatus || (observations.providerOutcome !== undefined &&
        observations.providerOutcome !== observations.terminalStatus)) {return reject();}
  } else if (input.status !== "failed") {requireFacts(observations, keys);}
  const debt = observations.reconciliation === "required" || observations.closureRecovery === "required";
  const recoveryKnown = observations.reconciliation !== undefined && observations.closureRecovery !== undefined;
  if ((debt && observations.terminalStatus !== undefined && observations.terminalStatus !== "reconcile_required") ||
      (recoveryKnown && !debt && observations.terminalStatus === "reconcile_required")) {return reject();}
  if (observations.terminalStatus === "succeeded" &&
      (tuple.platform !== "linux" || observations.providerOutcome !== "succeeded" ||
       observations.closureStatus !== "closed" || input.physicalContainment !== "contained")) {return reject();}
};
const validateArtifactEvidence = observations => {
  for (const [reference, proof] of [["artifactManifestRef", "artifactManifestProofDigest"], ["resultRef", "resultPublicationProofDigest"]]) {
    if (hasReference(observations, reference) || observations[proof] !== undefined) {
      requireFacts(observations, ["operationIdentityDigest", proof, "outputDrainProofDigest", "outputEvents"]);
      if (!hasReference(observations, reference) || observations.closureRecovery === "proved_no_workspace") {return reject();}
    }
  }
  if (hasReference(observations, "resultRef") && !hasReference(observations, "artifactManifestRef")) {return reject();}
  if (observations.terminalStatus === "succeeded") {
    requireFacts(observations, ["outputDrainProofDigest", "outputEvents"]);
    if (!["artifactManifestRef", "resultRef"].every(key => hasReference(observations, key))) {return reject();}
  }
};
const validateClaimEvidence = (input, observations) => {
  if ((input.physicalContainment === "contained") !== (observations.containmentProofDigest !== undefined)) {return reject();}
  if (input.physicalContainment === "contained" && observations.closureStatus !== "closed") {return reject();}
  if (Object.keys(observations).some(key => key.endsWith("ProofDigest")) || observations.outputEvents !== undefined) {
    requireFacts(observations, ["operationIdentityDigest"]);
  }
  if (observations.providerOutcome === "succeeded" || observations.executionClosureProofDigest !== undefined ||
      observations.providerTerminalProofDigest !== undefined) {
    requireFacts(observations, ["operationIdentityDigest", "executionClosureProofDigest", "providerTerminalProofDigest"]);
    choice(observations.providerOutcome, ["succeeded", "failed", "cancelled"]);
  }
  if (observations.outputDigest !== undefined || observations.outputDrainProofDigest !== undefined) {
    requireFacts(observations, ["operationIdentityDigest", "outputDrainProofDigest", "outputEvents"]);
  }
  validateArtifactEvidence(observations);
};
export const validateCompletion = (input, observations, tuple) => {
  validateClosure(input, observations, tuple);
  validateTerminal(input, observations, tuple);
  // Claims carry their own evidence requirements even if later teardown fails.
  validateClaimEvidence(input, observations);
  if (input.status === "failed") {
    if (observations.failureKind !== "canary-failed") {return reject();}
    return;
  }
  const darwin = tuple.platform === "darwin";
  const expected = {
    providerOutcome: "succeeded", closureStatus: darwin ? "unproven" : "closed", ownerDisposal: "completed", runtimeDisposal: "completed",
    closureRecovery: darwin ? "required" : "clear",
    terminalStatus: darwin ? "reconcile_required" : "succeeded", terminalKind: darwin ? "open" : "final",
    containmentProfile: darwin ? "cooperative-darwin-posix-process-group" : "strict-linux-cgroup-v2",
  };
  for (const [key, value] of Object.entries(expected)) {if (observations[key] !== value) {return reject();}}
  if (!darwin && observations.reconciliation !== "clear") {return reject();}
  if (observations.failureKind !== undefined || input.physicalContainment !== (darwin ? "indeterminate" : "contained")) {return reject();}
  for (const key of ["operationIdentityDigest", "executionClosureProofDigest", "providerTerminalProofDigest", "outputDrainProofDigest", "outputDigest", "outputEvents"]) {
    if (observations[key] === undefined) {return reject();}
  }
  if (!darwin && ["artifactManifestRef", "resultRef"].some(key => observations[key] === undefined && observations[`${key}Digest`] === undefined)) {return reject();}
};

export const evidenceDigest = value => sha256(JSON.stringify(value));
