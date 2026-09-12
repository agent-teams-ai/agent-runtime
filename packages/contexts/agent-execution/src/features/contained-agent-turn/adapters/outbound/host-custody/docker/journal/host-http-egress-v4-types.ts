import type { DockerContainerAuthority } from "../engine/docker-engine-port.js";
import type { DockerCustodyAttemptKey } from "./docker-custody-journal-types.js";

/** One fixed in-Host HTTP resource recipe. No provider/operation terminal authority. */
export interface HostHttpEgressV4Subject {
  readonly attempt: DockerCustodyAttemptKey;
  readonly effectId: string;
  readonly workspaceId: string;
  readonly executionGenerationId: string;
  readonly scopeSha256: string;
  readonly acceptedAuthoritySha256: string;
  readonly committedClaimSha256: string;
  readonly observerSha256: string;
  readonly imageDigest: string;
  readonly networkHandle: string;
  readonly listenerHandle: string;
  readonly routeHandle: string;
}

export type HostHttpEgressV4Intent =
  | "network_intent" | "listener_intent" | "route_intent"
  | "inbound_intent" | "upstream_intent" | "sockets_close"
  | "cutoff" | "listener_release" | "network_release" | "uncertain" | "retired";
export type HostHttpEgressV4Observed =
  | "network_allocated" | "listener_allocated" | "container_attached" | "route_installed"
  | "inbound_allocated" | "upstream_allocated" | "sockets_closed"
  | "cutoff_observed" | "container_absent" | "listener_absent" | "network_absent";

/** Private data supplied by the retained observer, never by the ordinary handle. */
export interface HostHttpEgressV4Observation {
  readonly kind: HostHttpEgressV4Observed;
  readonly subjectSha256: string;
  readonly observerSha256: string;
  readonly targetSha256: string;
  readonly actualSha256: string;
  readonly evidenceSha256: string;
  readonly container: DockerContainerAuthority | null;
  readonly writeOutcome: "settled" | "unknown" | null;
}

/**
 * Adapter-private capability seam. The later retained Docker/network/socket owner
 * resolves ONLY its own unforgeable tokens (e.g. a private WeakMap), after actual
 * observation. This checkpoint supplies no production issuer or observer.
 * container_absent with null container requires V2 owner proof of no creation;
 * an unknown create/remove must return undefined, never a fabricated observation.
 * sockets_closed covers pending creation AND write/drain outcomes; uncertain
 * delivery must additionally record uncertain, even after physical closure.
 */
export interface HostHttpEgressV4ObservationOwner {
  readObservation(token: object): HostHttpEgressV4Observation | undefined;
}

export type HostHttpEgressV4Event =
  | Readonly<{ kind: "opened"; subject: HostHttpEgressV4Subject }>
  | Readonly<{ kind: HostHttpEgressV4Intent; targetSha256: string }>
  | Readonly<{ kind: HostHttpEgressV4Observed; observation: HostHttpEgressV4Observation }>;
export interface HostHttpEgressV4Record {
  readonly version: 4;
  readonly sequence: number;
  readonly subjectSha256: string;
  readonly commandId: string;
  readonly commandSha256: string;
  readonly event: HostHttpEgressV4Event;
  readonly previousSha256: string | null;
  readonly checksumSha256: string;
}
export interface HostHttpEgressV4Tombstone {
  readonly version: 4;
  readonly subjectSha256: string;
  readonly tailSha256: string;
  readonly uncertainAppendSha256: string | null;
  readonly disposition: "retired" | "quarantined";
  readonly reconcileRequired: boolean;
  readonly checksumSha256: string;
}

export const HOST_HTTP_EGRESS_V4_LIMITS = Object.freeze({
  maxRecordBytes: 4096, maxRecords: 1600, maxBytes: 1600 * 4096, maxExchanges: 256,
});
export interface HostHttpEgressV4Capacity { readonly maxRecords: number; readonly maxBytes: number; }
/** A dedicated private directory holds at most one journal and its retained tombstone. */
export interface HostHttpEgressV4Storage {
  prepare(locatorSha256: string): Promise<Readonly<{
    journal: Uint8Array | null; tombstone: Uint8Array | null;
  }>>;
  assertOwned(): Promise<void>;
  append(expectedBytes: number, bytes: Uint8Array): Promise<void>;
  tombstone(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export class HostHttpEgressV4Error extends Error {
  public constructor(public readonly code: "conflict" | "capacity" | "quarantined" | "busy") {
    super(`host HTTP egress V4: ${code}`); this.name = "HostHttpEgressV4Error";
  }
}
