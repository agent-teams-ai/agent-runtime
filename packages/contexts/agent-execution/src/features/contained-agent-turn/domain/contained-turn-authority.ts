import {
  asContainedTurnCancellationFingerprint,
  asContainedTurnCommandFingerprint,
  digestContainedTurnCanonicalValue,
  type ContainedTurnCancellationFingerprint,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import type {
  ContainedTurnCancellationCommandId,
  ContainedTurnOperationId,
} from "./contained-turn-identities.js";

export type ContainedTurnProvider = "claude" | "codex";
export type ContainedTurnMode = "analysis" | "workspace-write";

export interface ContainedTurnScope {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ContainedTurnIntent {
  readonly mode: ContainedTurnMode;
  readonly prompt: string;
}

export interface ContainedTurnProviderAccessSnapshot {
  readonly accessRef: string;
  readonly accessRevision: string;
  readonly accountRef: string;
  readonly accountRevision: string;
  readonly credentialBindingDigest: ContainedTurnCanonicalDigest;
  readonly credentialBindingGeneration: string;
  readonly credentialBindingRef: string;
  readonly credentialBindingRevision: string;
  readonly provider: ContainedTurnProvider;
  readonly providerRouteRef: string;
  readonly providerRouteRevision: string;
}

export interface ContainedTurnProviderAdapterSnapshot {
  readonly adapterRevision: string;
  readonly binaryRevision: string;
  readonly capabilityManifestRevision: string;
  readonly provider: ContainedTurnProvider;
}

export const CONTAINED_TURN_REQUIRED_PROOF_KINDS = Object.freeze([
  "command_acceptance",
  "dispatch_authority",
  "execution_closure",
  "provider_terminal_observation",
  "output_drain",
  "host_custody",
  "workspace_closure",
  "artifact_manifest_seal",
  "effect_resolution",
  "containment_execution",
  "canonical_result_publication",
  "cutoff_enforcement",
] as const);

export type ContainedTurnRequiredProofKind = (typeof CONTAINED_TURN_REQUIRED_PROOF_KINDS)[number];

export interface ContainedTurnCapabilityManifest {
  readonly effectCardinality: "one_coarse_effect_per_operation";
  readonly effectClass: "contained_unmediated_effect";
  readonly manifestRevision: string;
  readonly manifestVersion: 1;
  readonly provider: ContainedTurnProvider;
  readonly providerAttemptCardinality: "at_most_one";
  readonly requiredProofKinds: typeof CONTAINED_TURN_REQUIRED_PROOF_KINDS;
  readonly resourceScopeRevision: string;
  readonly supportedModes: readonly ContainedTurnMode[];
  readonly unknownCapabilityPolicy: "fail_closed";
}

export interface ContainedTurnAuthorityVector {
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly capabilityManifestRevision: string;
  readonly containmentPolicyDigest: ContainedTurnCanonicalDigest;
  readonly operationAuthorityRevision: string;
  readonly providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
  readonly scopeDigest: ContainedTurnCanonicalDigest;
  readonly securityAuthorityRevision: string;
  readonly securityDecisionDigest: ContainedTurnCanonicalDigest;
}

const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = [...expected].toSorted();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
};

const assertExactKeys = (name: string, value: object, expected: readonly string[]): void => {
  if (!hasExactKeys(value, expected)) {throw new TypeError(`${name} must be an exact closed record`);}
};

export const validateContainedTurnAuthorityShape = (input: {
  readonly acceptedAuthorityVector: ContainedTurnAuthorityVector;
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly intent: ContainedTurnIntent;
  readonly providerAccessSnapshot: ContainedTurnProviderAccessSnapshot;
  readonly scope: ContainedTurnScope;
}): void => {
  const validateAdapter = (adapter: ContainedTurnProviderAdapterSnapshot): void => assertExactKeys(
    "adapter snapshot",
    adapter,
    ["adapterRevision", "binaryRevision", "capabilityManifestRevision", "provider"],
  );
  const validateProviderAccess = (snapshot: ContainedTurnProviderAccessSnapshot): void => assertExactKeys(
    "Provider Access snapshot",
    snapshot,
    [
      "accessRef", "accessRevision", "accountRef", "accountRevision", "credentialBindingDigest",
      "credentialBindingGeneration", "credentialBindingRef", "credentialBindingRevision", "provider",
      "providerRouteRef", "providerRouteRevision",
    ],
  );
  assertExactKeys(
    "accepted authority vector",
    input.acceptedAuthorityVector,
    [
      "adapterSnapshot", "capabilityManifestRevision", "containmentPolicyDigest", "operationAuthorityRevision",
      "providerAccessSnapshot", "scopeDigest", "securityAuthorityRevision", "securityDecisionDigest",
    ],
  );
  validateAdapter(input.adapterSnapshot);
  validateAdapter(input.acceptedAuthorityVector.adapterSnapshot);
  validateProviderAccess(input.providerAccessSnapshot);
  validateProviderAccess(input.acceptedAuthorityVector.providerAccessSnapshot);
  assertExactKeys("contained-turn intent", input.intent, ["mode", "prompt"]);
  assertExactKeys("contained-turn scope", input.scope, ["projectId", "tenantId"]);
};

export const containedTurnAuthorityVectorDigest = (
  vector: ContainedTurnAuthorityVector,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  adapter: {
    adapterRevision: vector.adapterSnapshot.adapterRevision,
    binaryRevision: vector.adapterSnapshot.binaryRevision,
    capabilityManifestRevision: vector.adapterSnapshot.capabilityManifestRevision,
    provider: vector.adapterSnapshot.provider,
  },
  capabilityManifestRevision: vector.capabilityManifestRevision,
  containmentPolicyDigest: vector.containmentPolicyDigest,
  operationAuthorityRevision: vector.operationAuthorityRevision,
  providerAccess: {
    accessRef: vector.providerAccessSnapshot.accessRef,
    accessRevision: vector.providerAccessSnapshot.accessRevision,
    accountRef: vector.providerAccessSnapshot.accountRef,
    accountRevision: vector.providerAccessSnapshot.accountRevision,
    credentialBindingDigest: vector.providerAccessSnapshot.credentialBindingDigest,
    credentialBindingGeneration: vector.providerAccessSnapshot.credentialBindingGeneration,
    credentialBindingRef: vector.providerAccessSnapshot.credentialBindingRef,
    credentialBindingRevision: vector.providerAccessSnapshot.credentialBindingRevision,
    provider: vector.providerAccessSnapshot.provider,
    providerRouteRef: vector.providerAccessSnapshot.providerRouteRef,
    providerRouteRevision: vector.providerAccessSnapshot.providerRouteRevision,
  },
  scopeDigest: vector.scopeDigest,
  securityAuthorityRevision: vector.securityAuthorityRevision,
  securityDecisionDigest: vector.securityDecisionDigest,
});

export interface ContainedTurnCommandFingerprintInput {
  readonly intent: ContainedTurnIntent;
  readonly provider: ContainedTurnProvider;
  readonly scope: ContainedTurnScope;
}

export const containedTurnCommandFingerprint = (
  input: ContainedTurnCommandFingerprintInput,
): ContainedTurnCommandFingerprint => asContainedTurnCommandFingerprint(digestContainedTurnCanonicalValue({
  intent: { mode: input.intent.mode, prompt: input.intent.prompt },
  provider: input.provider,
  scope: { projectId: input.scope.projectId, tenantId: input.scope.tenantId },
  version: 1,
}));

export interface ContainedTurnCancellationCommand {
  readonly cancellationCommandId: ContainedTurnCancellationCommandId;
  readonly fingerprint: ContainedTurnCancellationFingerprint;
  readonly operationId: ContainedTurnOperationId;
  readonly scopeDigest: ContainedTurnCanonicalDigest;
}

export const containedTurnScopeDigest = (scope: ContainedTurnScope): ContainedTurnCanonicalDigest =>
  digestContainedTurnCanonicalValue({ projectId: scope.projectId, tenantId: scope.tenantId, version: 1 });

export const containedTurnCancellationFingerprint = (input: {
  readonly cancellationCommandId: ContainedTurnCancellationCommandId;
  readonly operationId: ContainedTurnOperationId;
  readonly scopeDigest: ContainedTurnCanonicalDigest;
}): ContainedTurnCancellationFingerprint => asContainedTurnCancellationFingerprint(digestContainedTurnCanonicalValue({
  cancellationCommandId: input.cancellationCommandId,
  operationId: input.operationId,
  scopeDigest: input.scopeDigest,
  version: 1,
}));

export const validateContainedTurnManifest = (
  manifest: ContainedTurnCapabilityManifest,
  adapter: ContainedTurnProviderAdapterSnapshot,
): void => {
  assertExactKeys(
    "capability manifest",
    manifest,
    [
      "effectCardinality", "effectClass", "manifestRevision", "manifestVersion", "provider",
      "providerAttemptCardinality", "requiredProofKinds", "resourceScopeRevision", "supportedModes",
      "unknownCapabilityPolicy",
    ],
  );
  const supported = new Set<ContainedTurnMode>(manifest.supportedModes);
  const exactProofKinds = manifest.requiredProofKinds.length === CONTAINED_TURN_REQUIRED_PROOF_KINDS.length &&
    manifest.requiredProofKinds.every((kind, index) => kind === CONTAINED_TURN_REQUIRED_PROOF_KINDS[index]);
  if (
    manifest.manifestVersion !== 1 || manifest.effectClass !== "contained_unmediated_effect" ||
    manifest.effectCardinality !== "one_coarse_effect_per_operation" ||
    manifest.providerAttemptCardinality !== "at_most_one" || manifest.unknownCapabilityPolicy !== "fail_closed" ||
    (manifest.provider !== "claude" && manifest.provider !== "codex") || manifest.provider !== adapter.provider ||
    manifest.manifestRevision !== adapter.capabilityManifestRevision ||
    supported.size !== manifest.supportedModes.length || supported.size === 0 || !exactProofKinds
  ) {throw new TypeError("capability manifest is missing, unknown, contradictory, or not closed");}
  for (const mode of supported) {
    if (mode !== "analysis" && mode !== "workspace-write") {throw new TypeError("unknown capability scope fails closed");}
  }
};

export const validateContainedTurnAuthorityText = (input: {
  readonly commandId: string;
  readonly intent: ContainedTurnIntent;
  readonly operationId: string;
  readonly scope: ContainedTurnScope;
}): void => {
  validateContainedTurnText("commandId", input.commandId, CONTAINED_TURN_LIMITS.text.commandId);
  validateContainedTurnText("operationId", input.operationId, CONTAINED_TURN_LIMITS.text.identifier);
  validateContainedTurnText("projectId", input.scope.projectId, CONTAINED_TURN_LIMITS.text.identifier);
  validateContainedTurnText("tenantId", input.scope.tenantId, CONTAINED_TURN_LIMITS.text.identifier);
  validateContainedTurnText("prompt", input.intent.prompt, CONTAINED_TURN_LIMITS.text.prompt);
};
