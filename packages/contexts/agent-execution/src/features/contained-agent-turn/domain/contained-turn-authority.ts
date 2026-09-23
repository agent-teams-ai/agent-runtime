import {
  asContainedTurnCancellationFingerprint,
  asContainedTurnCommandFingerprint,
  digestContainedTurnCanonicalInput,
  type ContainedTurnCancellationFingerprint,
  type ContainedTurnCanonicalDigest,
  type ContainedTurnCommandFingerprint,
} from "./contained-turn-codecs.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "./contained-turn-limits.js";
import { assertContainedTurnCanonicalArray, assertContainedTurnDataRecord, assertContainedTurnExactRecord } from "./contained-turn-record.js";
import type {
  ContainedTurnCancellationCommandId,
  ContainedTurnOperationId,
} from "./contained-turn-identities.js";

/** Opaque provider identity. Provider-specific semantics belong to outer adapters. */
export type ContainedTurnAuthorityProvider = string;
export type ContainedTurnAuthorityMode = "analysis" | "workspace-write";

export interface ContainedTurnAuthorityScope {
  readonly projectId: string;
  readonly tenantId: string;
}

export interface ContainedTurnIntent {
  readonly mode: ContainedTurnAuthorityMode;
  readonly prompt: string;
}

export interface ContainedTurnProviderAccessSnapshot {
  readonly accessRef: string;
  readonly credentialBindingDigest: ContainedTurnCanonicalDigest;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly ownerAuthorityDigest: string;
  readonly projectId: string;
  readonly provider: ContainedTurnAuthorityProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly tenantId: string;
}

export interface ContainedTurnProviderAdapterSnapshot {
  readonly adapterRevision: string;
  readonly binaryRevision: string;
  readonly capabilityManifestRevision: string;
  readonly provider: ContainedTurnAuthorityProvider;
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
  readonly provider: ContainedTurnAuthorityProvider;
  readonly providerAttemptCardinality: "at_most_one";
  /** Compatibility declaration only; Kernel acceptance never sources receipt membership from it. */
  readonly requiredProofKinds: typeof CONTAINED_TURN_REQUIRED_PROOF_KINDS;
  readonly resourceScopeRevision: string;
  readonly supportedModes: readonly ContainedTurnAuthorityMode[];
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

export type ContainedTurnUnknownFields<Value> = { readonly [Key in keyof Value]: unknown };
export interface ContainedTurnAuthorityShape {
  readonly acceptedAuthorityVector: Omit<ContainedTurnUnknownFields<ContainedTurnAuthorityVector>, "adapterSnapshot" | "providerAccessSnapshot"> & {
    readonly adapterSnapshot: ContainedTurnUnknownFields<ContainedTurnProviderAdapterSnapshot>;
    readonly providerAccessSnapshot: ContainedTurnUnknownFields<ContainedTurnProviderAccessSnapshot>;
  };
  readonly adapterSnapshot: ContainedTurnUnknownFields<ContainedTurnProviderAdapterSnapshot>;
  readonly intent: ContainedTurnUnknownFields<ContainedTurnIntent>;
  readonly providerAccessSnapshot: ContainedTurnUnknownFields<ContainedTurnProviderAccessSnapshot>;
  readonly scope: ContainedTurnUnknownFields<ContainedTurnAuthorityScope>;
}

function validateAdapterShape(adapter: unknown): asserts adapter is ContainedTurnUnknownFields<ContainedTurnProviderAdapterSnapshot> {
  assertContainedTurnExactRecord("adapter snapshot", adapter,
    ["adapterRevision", "binaryRevision", "capabilityManifestRevision", "provider"]);
}
function validateProviderAccessShape(snapshot: unknown): asserts snapshot is ContainedTurnUnknownFields<ContainedTurnProviderAccessSnapshot> {
  assertContainedTurnExactRecord("Provider Access snapshot", snapshot, [
    "accessRef", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
    "ownerAuthorityDigest", "projectId", "provider", "providerAccountRef", "providerRouteRef", "revision", "tenantId",
  ]);
}

export function validateContainedTurnAuthorityShape(input: {
  readonly acceptedAuthorityVector: unknown;
  readonly adapterSnapshot: unknown;
  readonly intent: unknown;
  readonly providerAccessSnapshot: unknown;
  readonly scope: unknown;
}): asserts input is ContainedTurnAuthorityShape {
  assertContainedTurnExactRecord("accepted authority vector", input.acceptedAuthorityVector, [
    "adapterSnapshot", "capabilityManifestRevision", "containmentPolicyDigest", "operationAuthorityRevision",
    "providerAccessSnapshot", "scopeDigest", "securityAuthorityRevision", "securityDecisionDigest",
  ]);
  validateAdapterShape(input.adapterSnapshot);
  validateAdapterShape(input.acceptedAuthorityVector.adapterSnapshot);
  validateProviderAccessShape(input.providerAccessSnapshot);
  validateProviderAccessShape(input.acceptedAuthorityVector.providerAccessSnapshot);
  assertContainedTurnExactRecord("contained-turn intent", input.intent, ["mode", "prompt"]);
  assertContainedTurnExactRecord("contained-turn scope", input.scope, ["projectId", "tenantId"]);
}

export const containedTurnAuthorityVectorDigest = (
  vector: ContainedTurnAuthorityShape["acceptedAuthorityVector"],
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalInput({
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
  snapshot: ContainedTurnUnknownFields<ContainedTurnProviderAccessSnapshot>,
): ContainedTurnCanonicalDigest => digestContainedTurnCanonicalInput({
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
  readonly provider: ContainedTurnAuthorityProvider;
  readonly scope: ContainedTurnAuthorityScope;
}

export const containedTurnCommandFingerprint = (
  input: Readonly<{ intent: ContainedTurnUnknownFields<ContainedTurnIntent>; provider: unknown; scope: ContainedTurnUnknownFields<ContainedTurnAuthorityScope> }>,
): ContainedTurnCommandFingerprint => asContainedTurnCommandFingerprint(digestContainedTurnCanonicalInput({
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

export const containedTurnScopeDigest = (scope: ContainedTurnUnknownFields<ContainedTurnAuthorityScope>): ContainedTurnCanonicalDigest =>
  digestContainedTurnCanonicalInput({ projectId: scope.projectId, tenantId: scope.tenantId, version: 1 });

export const containedTurnCancellationFingerprint = (input: {
  readonly cancellationCommandId: unknown;
  readonly operationId: unknown;
  readonly scopeDigest: unknown;
}): ContainedTurnCancellationFingerprint => asContainedTurnCancellationFingerprint(digestContainedTurnCanonicalInput({
  cancellationCommandId: input.cancellationCommandId,
  operationId: input.operationId,
  scopeDigest: input.scopeDigest,
  version: 1,
}));

export function validateContainedTurnManifest(
  manifest: unknown,
  adapter: Readonly<{ provider: unknown; capabilityManifestRevision: unknown }>,
): asserts manifest is ContainedTurnCapabilityManifest {
  assertContainedTurnExactRecord(
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
  validateContainedTurnText("capability manifest provider", manifest.provider, {
    encoding: "utf8",
    maximumBytes: 128,
  });
  validateContainedTurnText("adapter provider", adapter.provider, {
    encoding: "utf8",
    maximumBytes: 128,
  });
  const supported = new Set(manifest.supportedModes);
  const exactProofKinds = manifest.requiredProofKinds.length === CONTAINED_TURN_REQUIRED_PROOF_KINDS.length &&
    manifest.requiredProofKinds.every((kind, index) => kind === CONTAINED_TURN_REQUIRED_PROOF_KINDS[index]);
  if (
    manifest.manifestVersion !== 1 || manifest.effectClass !== "contained_unmediated_effect" ||
    manifest.effectCardinality !== "one_coarse_effect_per_operation" ||
    manifest.providerAttemptCardinality !== "at_most_one" || manifest.unknownCapabilityPolicy !== "fail_closed" ||
    manifest.provider !== adapter.provider ||
    manifest.manifestRevision !== adapter.capabilityManifestRevision ||
    supported.size !== manifest.supportedModes.length || supported.size === 0 || !exactProofKinds
  ) {throw new TypeError("capability manifest is missing, unknown, contradictory, or not closed");}
  for (const mode of supported) {
    if (mode !== "analysis" && mode !== "workspace-write") {throw new TypeError("unknown capability scope fails closed");}
  }
  validateContainedTurnText("manifestRevision", manifest.manifestRevision, CONTAINED_TURN_LIMITS.text.identifier);
  validateContainedTurnText("resourceScopeRevision", manifest.resourceScopeRevision, CONTAINED_TURN_LIMITS.text.identifier);
}

export function validateContainedTurnAuthorityText(input: {
  readonly commandId: unknown;
  readonly intent: unknown;
  readonly operationId: unknown;
  readonly scope: unknown;
}): asserts input is {
  readonly commandId: string;
  readonly intent: Readonly<{ prompt: string; mode?: unknown }>;
  readonly operationId: string;
  readonly scope: ContainedTurnAuthorityScope;
} {
  validateContainedTurnText("commandId", input.commandId, CONTAINED_TURN_LIMITS.text.commandId);
  validateContainedTurnText("operationId", input.operationId, CONTAINED_TURN_LIMITS.text.identifier);
  assertContainedTurnDataRecord("contained-turn scope", input.scope);
  validateContainedTurnText("projectId", input.scope.projectId, CONTAINED_TURN_LIMITS.text.identifier);
  validateContainedTurnText("tenantId", input.scope.tenantId, CONTAINED_TURN_LIMITS.text.identifier);
  assertContainedTurnDataRecord("contained-turn intent", input.intent);
  validateContainedTurnText("prompt", input.intent.prompt, CONTAINED_TURN_LIMITS.text.prompt);
}

// Public composition declaration dependencies for this adapter boundary.
export { type ContainedTurnClosureDebtId, type ContainedTurnClosureRecovery, type ContainedTurnClosureRequestId, type ContainedTurnClosureStage, type ContainedTurnNoWorkspaceClosureFact, type ContainedTurnPendingClosure } from "./contained-turn-closure-recovery.js";
