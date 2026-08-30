import {
  asContainedTurnCancellationFingerprint,
  asContainedTurnCommandFingerprint,
  digestContainedTurnCanonicalValue,
  type ContainedTurnCancellationFingerprint,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnExactRecord } from "./contained-turn-record.js";
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
  readonly credentialBindingDigest: ContainedTurnCanonicalDigest;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly ownerAuthorityDigest: string;
  readonly projectId: string;
  readonly provider: ContainedTurnProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly tenantId: string;
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
  /** Compatibility declaration only; Kernel acceptance never sources receipt membership from it. */
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

const assertExactKeys = (name: string, value: object, expected: readonly string[]): void => {
  assertContainedTurnExactRecord(name, value, expected);
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
      "accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
      "ownerAuthorityDigest", "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId",
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
    credentialBindingDigest: vector.providerAccessSnapshot.credentialBindingDigest,
    credentialBindingRef: vector.providerAccessSnapshot.credentialBindingRef,
    credentialGeneration: vector.providerAccessSnapshot.credentialGeneration,
    ownerAuthorityDigest: vector.providerAccessSnapshot.ownerAuthorityDigest,
    projectId: vector.providerAccessSnapshot.projectId,
    provider: vector.providerAccessSnapshot.provider,
    providerAccountRef: vector.providerAccessSnapshot.providerAccountRef,
    providerRouteRef: vector.providerAccessSnapshot.providerRouteRef,
    revision: vector.providerAccessSnapshot.revision,
    tenantId: vector.providerAccessSnapshot.tenantId,
  },
  scopeDigest: vector.scopeDigest,
  securityAuthorityRevision: vector.securityAuthorityRevision,
  securityDecisionDigest: vector.securityDecisionDigest,
});

export const containedTurnProviderAccessSnapshotDigest = (
  snapshot: ContainedTurnProviderAccessSnapshot,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalValue({
  accessRef: snapshot.accessRef,
  credentialBindingDigest: snapshot.credentialBindingDigest,
  credentialBindingRef: snapshot.credentialBindingRef,
  credentialGeneration: snapshot.credentialGeneration,
  ownerAuthorityDigest: snapshot.ownerAuthorityDigest,
  projectId: snapshot.projectId,
  provider: snapshot.provider,
  providerAccountRef: snapshot.providerAccountRef,
  providerRouteRef: snapshot.providerRouteRef,
  revision: snapshot.revision,
  tenantId: snapshot.tenantId,
  version: 1,
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
  assertContainedTurnCanonicalArray(manifest.requiredProofKinds);
  assertContainedTurnCanonicalArray(manifest.supportedModes);
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
