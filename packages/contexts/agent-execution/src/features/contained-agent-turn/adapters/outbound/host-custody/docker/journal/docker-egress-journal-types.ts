export const DOCKER_EGRESS_JOURNAL_VERSION = 3 as const;

export const DOCKER_EGRESS_RESOURCE_KINDS = Object.freeze([
  "private_network",
  "broker_namespace",
  "broker_cgroup",
  "broker_process",
  "broker_listener",
  "broker_inbound_socket",
  "broker_upstream_socket",
  "provider_endpoint",
  "network_endpoint",
  "upstream_rule",
  "provider_container",
] as const);
export type DockerEgressResourceKind = typeof DOCKER_EGRESS_RESOURCE_KINDS[number];

/** Dependency order for creation. Cleanup always uses the exact reverse. */
export const DOCKER_EGRESS_CLEANUP_ORDER = Object.freeze(
  DOCKER_EGRESS_RESOURCE_KINDS.toReversed() as DockerEgressResourceKind[],
);

export interface DockerEgressIdentity {
  readonly operationId: string;
  readonly attemptId: string;
  readonly effectId: string;
  readonly custodyId: string;
  readonly workspaceId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly resourceGenerationId: string;
}

/** All authority is digest-only. The journal never stores owner records, routes, policy, or credentials. */
export interface DockerEgressAuthorityBinding {
  readonly scopeSha256: string;
  readonly operationSha256: string;
  readonly acceptedAuthoritySha256: string;
  readonly brokerPolicySha256: string;
  readonly routeAuthorizationSha256: string;
  readonly materializationAuthorizationSha256: string;
}

/** Host-private opaque cleanup handles. No path, address, port, secret, or provider output is accepted. */
export interface DockerEgressResourceIdentities {
  readonly privateNetworkId: string;
  readonly brokerNamespaceId: string;
  readonly brokerCgroupId: string;
  readonly brokerProcessId: string;
  readonly brokerListenerId: string;
  readonly brokerInboundSocketId: string;
  readonly brokerUpstreamSocketId: string;
  readonly providerEndpointId: string;
  readonly networkEndpointId: string;
  readonly upstreamRuleGenerationId: string;
  readonly providerContainerId: string;
}

export interface DockerEgressJournalSubject {
  readonly identity: DockerEgressIdentity;
  readonly authority: DockerEgressAuthorityBinding;
  readonly resources: DockerEgressResourceIdentities;
  readonly bindingSha256: string;
}

export type DockerEgressAcknowledgement = "acknowledged" | "already_absent";
export type DockerEgressReconcileReason =
  | "acknowledgement_unknown"
  | "cleanup_failed"
  | "cleanup_observation_unknown"
  | "journal_corrupt"
  | "legacy_incompatible"
  | "legacy_malformed"
  | "scope_conflict";

export type DockerEgressJournalEvent =
  | Readonly<{ kind: "open_intent" }>
  | Readonly<{ kind: "materialize_intent"; resource: DockerEgressResourceKind }>
  | Readonly<{ acknowledgement: "acknowledged"; kind: "materialize_receipt"; resource: DockerEgressResourceKind }>
  | Readonly<{ kind: "cleanup_intent"; resource: DockerEgressResourceKind }>
  | Readonly<{ acknowledgement: DockerEgressAcknowledgement; kind: "cleanup_receipt"; resource: DockerEgressResourceKind }>
  | Readonly<{ kind: "reconcile_required"; reason: DockerEgressReconcileReason; resource: DockerEgressResourceKind | null }>
  | Readonly<{ diagnostic: DockerEgressQuarantineDiagnostic; kind: "quarantined" }>
  | Readonly<{ kind: "closed" }>;

export interface DockerEgressJournalRecord {
  readonly version: typeof DOCKER_EGRESS_JOURNAL_VERSION;
  readonly sequence: number;
  readonly subject: DockerEgressJournalSubject;
  readonly event: DockerEgressJournalEvent;
  readonly previousChecksumSha256: string | null;
  readonly checksumSha256: string;
}

export type DockerEgressLegacyDiagnostic =
  | "legacy_empty"
  | "legacy_populated_without_cleanup_identity"
  | "legacy_corrupt"
  | "legacy_oversized"
  | "legacy_partial_tail";
export type DockerEgressQuarantineDiagnostic = DockerEgressLegacyDiagnostic
  | "cleanup_incomplete"
  | "journal_corrupt"
  | "scope_conflict";

export interface DockerEgressJournalLimits {
  readonly maxJournalFiles: number;
  readonly maxRecordBytes: number;
  readonly maxRecordsPerJournal: number;
  readonly maxJournalBytes: number;
  readonly maxRestartScanBytes: number;
}

export const DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS: DockerEgressJournalLimits = Object.freeze({
  maxJournalFiles: 1_024,
  maxRecordBytes: 8_192,
  maxRecordsPerJournal: 96,
  maxJournalBytes: 768 * 1_024,
  maxRestartScanBytes: 24 * 1_024 * 1_024,
});

export type DockerEgressRecoveryObservation =
  | Readonly<{
      kind: "cleanup_only";
      bindingSha256: string;
      nextCleanup: DockerEgressResourceKind | null;
      reconcileRequired: boolean;
      status: "open" | "cleaning" | "closed" | "quarantined";
    }>
  | Readonly<{
      kind: "legacy_cleanup_only";
      locatorSha256: string;
      diagnostic: DockerEgressLegacyDiagnostic;
      quarantineRequired: boolean;
      executionAuthority: null;
      cleanupIdentity: null;
    }>;

export class DockerEgressJournalError extends Error {
  public constructor(message: string) { super(message); this.name = "DockerEgressJournalError"; }
}
export class DockerEgressJournalConflictError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal identity or compare-and-swap conflict") {
    super(message); this.name = "DockerEgressJournalConflictError";
  }
}
export class DockerEgressJournalCorruptionError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal is corrupt, truncated, or oversized") {
    super(message); this.name = "DockerEgressJournalCorruptionError";
  }
}
export class DockerEgressJournalCapacityError extends DockerEgressJournalError {
  public constructor(message = "Docker egress journal capacity exhausted") {
    super(message); this.name = "DockerEgressJournalCapacityError";
  }
}
