import type {DockerCustodyJournalRecoveryReader, DockerCustodyJournalWriter} from "./journal/docker-custody-journal.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerEngineIdentity,
  DockerEngineCall, DockerEnginePort,
} from "./engine/docker-engine-port.js";
import {
  bindDockerCustodyAttemptKey,
  dockerCustodyOwnerIdentitySha256,
} from "./journal/docker-custody-journal-codec.js";
import type {
  DockerCustodyAttemptKey,
  DockerCustodyOwnerIdentity,
  DockerCustodyJournalLimits, DockerCustodyJournalStorage, DockerCustodyRecoveryObservation, DockerCustodyJournalRecord,
} from "./journal/docker-custody-journal-types.js";

export type DockerHostCustodyContainerCreateInput = Omit<DockerContainerCreate, "ownerIdentitySha256">;

export const bindDockerHostCustodyCreate = (
  key: DockerCustodyAttemptKey,
  create: DockerHostCustodyContainerCreateInput,
): DockerContainerCreate => {
  if (key.launchFingerprintSha256 !== create.launchFingerprintSha256 ||
      key.operationNonceSha256 !== create.operationNonceSha256) {
    throw new TypeError("Docker Host Custody launch facts conflict with their canonical owner identity");
  }
  return Object.freeze({
    ...create,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(key),
  });
};

export const assertDockerEngineBinding = (
  key: DockerCustodyAttemptKey,
  engine: DockerEngineIdentity,
): void => {
  if (key.daemonIdentitySha256 !== engine.daemonIdentitySha256 ||
      key.daemonBootGenerationSha256 !== engine.daemonBootGenerationSha256 ||
      key.hostIdentitySha256 !== engine.hostIdentitySha256 ||
      key.hostBootGenerationSha256 !== engine.hostBootGenerationSha256) {
    throw new TypeError("Docker Host Custody engine generation conflicts with its canonical owner identity");
  }
};

export const assertDockerAuthorityBinding = (
  key: DockerCustodyAttemptKey,
  authority: DockerContainerAuthority,
): void => {
  if (key.daemonIdentitySha256 !== authority.daemonIdentitySha256 ||
      key.daemonBootGenerationSha256 !== authority.daemonBootGenerationSha256 ||
      key.hostIdentitySha256 !== authority.hostIdentitySha256 ||
      key.hostBootGenerationSha256 !== authority.hostBootGenerationSha256 ||
      key.launchFingerprintSha256 !== authority.launchFingerprintSha256 ||
      key.operationNonceSha256 !== authority.operationNonceSha256 ||
      authority.ownerIdentitySha256 !== dockerCustodyOwnerIdentitySha256(key)) {
    throw new TypeError("Docker Host Custody authority conflicts with its canonical owner identity");
  }
};

export const sameDockerAuthority = (
  left: DockerContainerAuthority,
  right: DockerContainerAuthority,
): boolean =>
  left.containerId === right.containerId &&
  left.createSpecificationSha256 === right.createSpecificationSha256 &&
  left.daemonBootGenerationSha256 === right.daemonBootGenerationSha256 &&
  left.daemonIdentitySha256 === right.daemonIdentitySha256 &&
  left.hostBootGenerationSha256 === right.hostBootGenerationSha256 &&
  left.hostIdentitySha256 === right.hostIdentitySha256 &&
  left.imageDigest === right.imageDigest &&
  left.launchFingerprintSha256 === right.launchFingerprintSha256 &&
  left.operationNonceSha256 === right.operationNonceSha256 &&
  left.ownerIdentitySha256 === right.ownerIdentitySha256;

export const isRunningDockerObservation = (observation: DockerContainerObservation): boolean =>
  observation.existence === "present" && observation.state.running && observation.state.status === "running";

export const isInactiveDockerObservation = (observation: DockerContainerObservation): boolean =>
  observation.existence === "absent" || (
    !observation.state.running && !observation.state.paused && !observation.state.restarting &&
    observation.state.hostPid === 0 && ["created", "dead", "exited"].includes(observation.state.status)
  );

export const dockerHostCustodyAttemptKey = (
  owner: DockerCustodyOwnerIdentity,
  create: DockerHostCustodyContainerCreateInput,
  engine: DockerEngineIdentity,
): DockerCustodyAttemptKey => bindDockerCustodyAttemptKey({
  daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
  daemonIdentitySha256: engine.daemonIdentitySha256,
  hostBootGenerationSha256: engine.hostBootGenerationSha256,
  hostIdentitySha256: engine.hostIdentitySha256,
  launchFingerprintSha256: create.launchFingerprintSha256,
  operationNonceSha256: create.operationNonceSha256,
  owner,
});

export interface DockerHostCustodyJournalPort extends DockerCustodyJournalWriter, DockerCustodyJournalRecoveryReader {}
export interface DockerHostCustodyResiduePort {
  proveEmpty(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<"empty" | "residue" | "unknown">;
}
/** Outer composition supplies launch facts only; the lifecycle derives and seals ownerIdentitySha256. */
export type DockerHostCustodyContainerCreate = DockerHostCustodyContainerCreateInput;
export interface DockerHostCustodyRecoveryResolver {
  resolve(key: DockerCustodyAttemptKey): Promise<Readonly<{
    /** Optional durable authority permits exact absence proof after a remove acknowledgement was lost. */
    authority?: DockerContainerAuthority;
    call: DockerEngineCall;
    create: DockerHostCustodyContainerCreate;
  }> | undefined>;
}
export interface DockerHostCustodyCompositionDependencies {
  readonly engine: DockerEnginePort;
  readonly journalLimits?: Partial<DockerCustodyJournalLimits>;
  readonly journalStorage: DockerCustodyJournalStorage;
  readonly residue: DockerHostCustodyResiduePort;
}
export type DockerHostCustodyRecovery =
  | { readonly journal: DockerCustodyRecoveryObservation; readonly kind: "journal_unproven"; readonly containment?: "closed" | "indeterminate" }
  | { readonly journal: DockerCustodyJournalRecord; readonly kind: "closed" }
  | {
    readonly journal: Extract<DockerCustodyRecoveryObservation, { readonly kind: "replayed" }>;
    readonly kind: "indeterminate";
    readonly reason: "authority_unavailable" | "engine_observation_unavailable" | "containment_unproven";
  };
export type DockerHostCustodyContainment =
  | Readonly<{ journal: DockerCustodyJournalRecord; kind: "closed" }>
  | Readonly<{ journal: DockerCustodyJournalRecord; kind: "indeterminate"; reason: "containment_unproven" }>
  | Readonly<{
      authority: DockerContainerAuthority;
      containment: "closed" | "indeterminate";
      kind: "indeterminate";
      reason: "journal_unavailable";
    }>
  | Readonly<{
      authority: DockerContainerAuthority;
      containment: "indeterminate";
      kind: "indeterminate";
      reason: "authority_mismatch" | "authority_unavailable";
    }>;
