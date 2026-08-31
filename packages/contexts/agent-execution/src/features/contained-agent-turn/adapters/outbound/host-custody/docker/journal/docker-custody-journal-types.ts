export const DOCKER_CUSTODY_JOURNAL_VERSION = 2 as const;

export const DOCKER_CUSTODY_STATES = [
  "prepared",
  "create_requested",
  "created",
  "init_start_requested",
  "init_ready",
  "provider_exec_requested",
  "provider_exec_observed",
  "contain_requested",
  "empty_observed",
  "remove_requested",
  "removed_observed",
  "closed",
] as const;

export type DockerCustodyJournalState = typeof DOCKER_CUSTODY_STATES[number];

export const DOCKER_CUSTODY_ACTION_STATES = [
  "create_requested",
  "init_start_requested",
  "provider_exec_requested",
  "contain_requested",
  "remove_requested",
] as const;

export type DockerCustodyActionState = typeof DOCKER_CUSTODY_ACTION_STATES[number];

export const DOCKER_CUSTODY_OBSERVATION_STATES = [
  "created",
  "init_ready",
  "provider_exec_observed",
  "empty_observed",
  "removed_observed",
  "closed",
] as const;

export type DockerCustodyObservationState = typeof DOCKER_CUSTODY_OBSERVATION_STATES[number];

export const DOCKER_CUSTODY_DEBT_REASONS = [
  "docker_observation_unavailable",
  "provider_execution_unproven",
  "containment_unproven",
  "empty_custody_unproven",
  "removal_unproven",
] as const;

export type DockerCustodyDebtReason = typeof DOCKER_CUSTODY_DEBT_REASONS[number];

/** Canonical product owner identity supplied by outer Host composition. */
export interface DockerCustodyOwnerIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly custodyId: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
}

/** Durable cross-binding for one canonical owner and one exact Docker resource generation. */
export interface DockerCustodyAttemptKey extends DockerCustodyOwnerIdentity {
  readonly daemonIdentitySha256: string;
  readonly daemonBootGenerationSha256: string;
  readonly hostIdentitySha256: string;
  readonly hostBootGenerationSha256: string;
  readonly launchFingerprintSha256: string;
  readonly operationNonceSha256: string;
}

export type DockerCustodyJournalEvidence =
  | { readonly status: "proved" }
  | { readonly status: "unproven"; readonly reason: DockerCustodyDebtReason };

export interface DockerCustodyJournalRecord {
  readonly version: typeof DOCKER_CUSTODY_JOURNAL_VERSION;
  readonly sequence: number;
  readonly attemptKey: DockerCustodyAttemptKey;
  /** Canonical digest of the complete created container authority; null until create is observed. */
  readonly authoritySha256: string | null;
  readonly state: DockerCustodyJournalState;
  readonly evidence: DockerCustodyJournalEvidence;
  readonly previousChecksumSha256: string | null;
  readonly checksumSha256: string;
}

/** Fixed, exact idempotency proof for one retired journal; it is never included in live-entry scans. */
export interface DockerCustodyRetirementReceipt {
  readonly version: typeof DOCKER_CUSTODY_JOURNAL_VERSION;
  readonly attemptKey: DockerCustodyAttemptKey;
  readonly journalChecksumSha256: string;
  readonly receiptChecksumSha256: string;
}

const DOCKER_CUSTODY_TRANSITIONS: Readonly<Record<DockerCustodyJournalState, readonly DockerCustodyJournalState[]>> =
  Object.freeze({
    prepared: ["create_requested", "closed"],
    create_requested: ["created", "closed"],
    created: ["init_start_requested", "contain_requested"],
    init_start_requested: ["init_ready", "contain_requested"],
    init_ready: ["provider_exec_requested", "contain_requested"],
    provider_exec_requested: ["provider_exec_observed", "contain_requested"],
    provider_exec_observed: ["contain_requested"],
    contain_requested: ["empty_observed"],
    empty_observed: ["contain_requested", "remove_requested"],
    remove_requested: ["removed_observed"],
    removed_observed: ["contain_requested", "closed"],
    closed: [],
  });

/** The sole bounded Docker journal transition contract, shared by append and replay. */
export const isDockerCustodyJournalTransition = (
  previous: Pick<DockerCustodyJournalRecord, "evidence" | "state">,
  next: DockerCustodyJournalState,
): boolean => DOCKER_CUSTODY_TRANSITIONS[previous.state].includes(next) && (
  previous.state === "empty_observed"
    ? next === (previous.evidence.status === "proved" ? "remove_requested" : "contain_requested")
    : previous.state !== "removed_observed" ||
      next === (previous.evidence.status === "proved" ? "closed" : "contain_requested")
);

export interface DockerCustodyJournalLimits {
  readonly maxJournalFiles: number;
  readonly maxRecordBytes: number;
  readonly maxRecordsPerJournal: number;
  readonly maxJournalBytes: number;
  readonly maxRestartScanBytes: number;
}

export const DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS: DockerCustodyJournalLimits = Object.freeze({
  maxJournalFiles: 1_024,
  maxRecordBytes: 4_096,
  maxRecordsPerJournal: 32,
  maxJournalBytes: 128 * 1_024,
  maxRestartScanBytes: 8 * 1_024 * 1_024,
});

export interface DockerCustodyJournalFile {
  readonly byteLength: number;
  append(expectedByteLength: number, bytes: Uint8Array): Promise<void>;
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface DockerCustodyJournalStorage {
  exclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
  create(locatorSha256: string): Promise<DockerCustodyJournalFile>;
  open(locatorSha256: string): Promise<DockerCustodyJournalFile | undefined>;
  openRetirement(locatorSha256: string): Promise<DockerCustodyJournalFile | undefined>;
  retire(locatorSha256: string, receipt: Uint8Array): Promise<void>;
  scan(maxFiles: number): Promise<readonly {
    readonly locatorSha256: string;
    readonly file: DockerCustodyJournalFile;
  }[]>;
}

export type DockerCustodyRecoveryObservation =
  | {
      readonly kind: "replayed";
      readonly attemptKey: DockerCustodyAttemptKey;
      readonly state: DockerCustodyJournalState;
      readonly sequence: number;
      readonly evidence: DockerCustodyJournalEvidence;
      readonly hasDebt: boolean;
      readonly providerExecution: "not_requested" | "may_have_executed";
      readonly tail: "complete";
    }
  | {
      readonly kind: "unproven";
      readonly locatorSha256: string;
      readonly reason: "empty_journal" | "partial_tail" | "corrupt_record";
      readonly lastValidRecord?: DockerCustodyJournalRecord;
      readonly providerExecution: "not_requested" | "may_have_executed" | "unknown";
    };

export class DockerCustodyJournalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DockerCustodyJournalError";
  }
}

export class DockerCustodyJournalConflictError extends DockerCustodyJournalError {
  public constructor(message = "Docker custody journal compare-and-swap conflict") {
    super(message);
    this.name = "DockerCustodyJournalConflictError";
  }
}

export class DockerCustodyJournalCapacityError extends DockerCustodyJournalError {
  public constructor(message = "Docker custody journal capacity exhausted") {
    super(message);
    this.name = "DockerCustodyJournalCapacityError";
  }
}

export class DockerCustodyJournalCorruptionError extends DockerCustodyJournalError {
  public constructor(message = "Docker custody journal is corrupt or has a partial tail") {
    super(message);
    this.name = "DockerCustodyJournalCorruptionError";
  }
}

export class DockerCustodyJournalUnavailableError extends DockerCustodyJournalError {
  public constructor(message = "Docker custody journal durable authority is unavailable") {
    super(message);
    this.name = "DockerCustodyJournalUnavailableError";
  }
}

export class DockerCustodyJournalBusyError extends DockerCustodyJournalError {
  public constructor() {
    super("Docker custody journal authority is busy; explicit recovery is required");
    this.name = "DockerCustodyJournalBusyError";
  }
}

export type DockerCustodyFilesystemDiagnostic =
  | "io_failure"
  | "permission_denied"
  | "root_changed"
  | "storage_full"
  | "unsafe_entry"
  | "unsupported_platform";

export class DockerCustodyJournalFilesystemError extends DockerCustodyJournalError {
  public constructor(public readonly diagnostic: DockerCustodyFilesystemDiagnostic) {
    super(`Docker custody journal filesystem failure: ${diagnostic}`);
    this.name = "DockerCustodyJournalFilesystemError";
  }
}
