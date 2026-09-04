export const DOCKER_EGRESS_JOURNAL_VERSION = 3 as const;

export const DOCKER_EGRESS_RESOURCE_KINDS = Object.freeze([
  "private_network", "broker_namespace", "broker_cgroup", "broker_process", "broker_listener",
  "broker_inbound_socket", "broker_upstream_socket", "provider_endpoint", "network_endpoint",
  "upstream_rule", "provider_container",
] as const);
export type DockerEgressResourceKind = typeof DOCKER_EGRESS_RESOURCE_KINDS[number];
export const DOCKER_EGRESS_CLEANUP_ORDER = Object.freeze(
  DOCKER_EGRESS_RESOURCE_KINDS.toReversed() as DockerEgressResourceKind[],
);

/** Canonical identities are adapter-issued prefix + 256 random/digest bits. */
export interface DockerEgressIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly effectId: string;
  readonly custodyId: string;
  readonly workspaceId: string;
  readonly hostSlotId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly executionGenerationId: string;
  readonly daemonId: string;
  readonly daemonGenerationId: string;
  readonly slotGenerationId: string;
  readonly exactFingerprintSha256: string;
}

/** Authority is closed, digest-only data. */
export interface DockerEgressAuthorityBinding {
  readonly scopeSha256: string;
  readonly operationSha256: string;
  readonly acceptedAuthoritySha256: string;
  readonly brokerPolicySha256: string;
  readonly routeAuthorizationSha256: string;
  readonly materializationAuthorizationSha256: string;
}

/** Host-private cleanup handles. These values must never be copied to public evidence. */
export interface DockerEgressResourceIdentities {
  readonly privateNetworkHandle: string;
  readonly brokerNamespaceHandle: string;
  readonly brokerCgroupHandle: string;
  readonly brokerProcessHandle: string;
  readonly brokerListenerHandle: string;
  readonly brokerInboundSocketHandle: string;
  readonly brokerUpstreamSocketHandle: string;
  readonly providerEndpointHandle: string;
  readonly networkEndpointHandle: string;
  readonly upstreamRuleHandle: string;
  readonly providerContainerHandle: string;
}

export interface DockerEgressJournalSubject {
  readonly identity: DockerEgressIdentity;
  readonly authority: DockerEgressAuthorityBinding;
  readonly resources: DockerEgressResourceIdentities;
  readonly bindingSha256: string;
}

export interface DockerEgressCleanupObservation {
  readonly resource: DockerEgressResourceKind;
  readonly cleanupHandle: string;
  readonly scopeSha256: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly executionGenerationId: string;
  readonly daemonId: string;
  readonly daemonGenerationId: string;
  readonly slotGenerationId: string;
  readonly observerId: string;
  readonly capabilityRevisionSha256: string;
  readonly result: "absent";
  readonly observationSha256: string;
}

/** Construction-owned Host authority for accepting private absence observations. */
export interface DockerEgressCleanupObserverAuthority {
  readonly observerId: string;
  readonly capabilityRevisionSha256: string;
}

export interface DockerEgressReservation {
  readonly recordCount: number;
  readonly byteCount: number;
}

export type DockerEgressReconcileReason =
  | "acknowledgement_unknown" | "cleanup_failed" | "cleanup_observation_unknown"
  | "journal_corrupt" | "legacy_incompatible" | "legacy_malformed" | "identity_stale";
export type DockerEgressQuarantineDiagnostic =
  | "cleanup_incomplete" | "journal_corrupt" | "identity_stale" | "locator_mismatch"
  | "legacy_unsafe" | "unsafe_entry";

export type DockerEgressJournalEvent =
  | Readonly<{ kind: "open_intent" }>
  | Readonly<{ kind: "materialize_intent"; resource: DockerEgressResourceKind; reservation: DockerEgressReservation }>
  | Readonly<{ kind: "materialize_receipt"; resource: DockerEgressResourceKind }>
  | Readonly<{ kind: "cleanup_intent"; resource: DockerEgressResourceKind; reservation: DockerEgressReservation }>
  | Readonly<{ kind: "cleanup_receipt"; resource: DockerEgressResourceKind; observation: DockerEgressCleanupObservation }>
  | Readonly<{ kind: "reconcile_required"; reason: DockerEgressReconcileReason; resource: DockerEgressResourceKind | null }>
  | Readonly<{ diagnostic: DockerEgressQuarantineDiagnostic; kind: "quarantined" }>
  | Readonly<{ kind: "closed" }>;

export interface DockerEgressJournalRecord {
  readonly version: typeof DOCKER_EGRESS_JOURNAL_VERSION;
  readonly sequence: number;
  readonly subject: DockerEgressJournalSubject;
  readonly commandId: string;
  readonly commandDigestSha256: string;
  readonly event: DockerEgressJournalEvent;
  readonly previousChecksumSha256: string | null;
  readonly checksumSha256: string;
}

export interface DockerEgressTombstone {
  readonly version: typeof DOCKER_EGRESS_JOURNAL_VERSION;
  readonly locatorSha256: string;
  readonly bindingSha256: string | null;
  readonly disposition: "retired" | "quarantined";
  readonly terminalRecord: DockerEgressJournalRecord | null;
  readonly checksumSha256: string;
}

export interface DockerEgressTrustedRuntimeIdentity {
  readonly scopeSha256: string;
  readonly hostSlotId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly executionGenerationId: string;
  readonly daemonId: string;
  readonly daemonGenerationId: string;
  readonly slotGenerationId: string;
}

/** Adapter-private directive. It grants cleanup of exactly one journaled handle, never materialization. */
export interface DockerEgressCleanupDirective {
  readonly kind: "cleanup_only";
  readonly subject: DockerEgressJournalSubject;
  readonly sequence: number;
  readonly resource: DockerEgressResourceKind;
  readonly cleanupHandle: string;
  readonly reconcileRequired: boolean;
}

/** Detached public evidence. No subject, authority, or cleanup handle is present. */
export interface DockerEgressRecoveryEvidence {
  readonly kind: "cleanup_evidence" | "quarantine_evidence" | "retirement_evidence" | "legacy_evidence";
  readonly locatorSha256: string;
  readonly bindingSha256: string | null;
  readonly status: "debt" | "quarantined" | "retired";
}

export type DockerEgressLegacyDiagnostic =
  | "legacy_empty" | "legacy_populated_without_cleanup_identity" | "legacy_corrupt"
  | "legacy_oversized" | "legacy_partial_tail";
export interface DockerEgressLegacyV2Result {
  readonly diagnostic: DockerEgressLegacyDiagnostic;
  readonly quarantineRequired: boolean;
  readonly executionAuthority: null;
  readonly cleanupIdentity: null;
}

export interface DockerEgressJournalLimits {
  readonly maxJournalFiles: number;
  readonly maxRecordBytes: number;
  readonly maxRecordsPerJournal: number;
  readonly maxJournalBytes: number;
  readonly maxRestartScanBytes: number;
}
export const DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS: DockerEgressJournalLimits = Object.freeze({
  maxJournalFiles: 1_024,
  maxRecordBytes: 12_288,
  maxRecordsPerJournal: 96,
  maxJournalBytes: 1_152 * 1_024,
  maxRestartScanBytes: 24 * 1_024 * 1_024,
});

export interface DockerEgressJournalFile {
  readonly byteLength: number;
  append(expectedByteLength: number, bytes: Uint8Array): Promise<void>;
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface DockerEgressStorageEntry {
  readonly locatorSha256: string;
  readonly byteLength: number;
  readonly file: DockerEgressJournalFile;
}
export interface DockerEgressJournalStorage {
  exclusive<Result>(fence: DockerEgressTrustedRuntimeIdentity, operation: () => Promise<Result>): Promise<Result>;
  createWithFirstRecord(locatorSha256: string, firstRecord: Uint8Array): Promise<DockerEgressJournalFile>;
  openV3(locatorSha256: string): Promise<DockerEgressJournalFile | undefined>;
  scanV3(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]>;
  scanLegacyV2(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]>;
  scanTombstones(maxFiles: number): Promise<readonly DockerEgressStorageEntry[]>;
  persistTombstone(locatorSha256: string, tombstone: Uint8Array, removeLive: boolean): Promise<void>;
}

export class DockerEgressJournalError extends Error {
  public constructor(message: string) { super(message); this.name = "DockerEgressJournalError"; }
}
export class DockerEgressJournalConflictError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal identity, command, or compare-and-swap conflict") {
    super(message); this.name = "DockerEgressJournalConflictError";
  }
}
export class DockerEgressJournalCorruptionError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal is corrupt, truncated, misplaced, or oversized") {
    super(message); this.name = "DockerEgressJournalCorruptionError";
  }
}
export class DockerEgressJournalCapacityError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal capacity exhausted") {
    super(message); this.name = "DockerEgressJournalCapacityError";
  }
}
export class DockerEgressJournalBusyError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal lock is busy or stale; explicit recovery is required") {
    super(message); this.name = "DockerEgressJournalBusyError";
  }
}
