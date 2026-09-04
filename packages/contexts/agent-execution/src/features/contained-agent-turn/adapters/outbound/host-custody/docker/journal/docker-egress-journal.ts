import type {
  DockerCustodyJournalFile,
  DockerCustodyJournalStorage,
} from "./docker-custody-journal-types.js";
import {
  createDockerEgressRecord,
  dockerEgressJournalLocator,
  encodeDockerEgressRecord,
  replayDockerEgressBytes,
  validateDockerEgressSubject,
} from "./docker-egress-journal-codec.js";
import { classifyDockerEgressLegacyV2, dockerJournalWireVersion } from "./docker-egress-v2-cleanup-reader.js";
import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_CLEANUP_ORDER,
  DOCKER_EGRESS_JOURNAL_VERSION,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournalCapacityError,
  DockerEgressJournalConflictError,
  DockerEgressJournalCorruptionError,
  type DockerEgressAcknowledgement,
  type DockerEgressJournalEvent,
  type DockerEgressJournalLimits,
  type DockerEgressJournalRecord,
  type DockerEgressJournalSubject,
  type DockerEgressQuarantineDiagnostic,
  type DockerEgressReconcileReason,
  type DockerEgressRecoveryObservation,
  type DockerEgressResourceKind,
} from "./docker-egress-journal-types.js";

interface ReplayState {
  readonly possible: Set<DockerEgressResourceKind>;
  readonly cleaned: Set<DockerEgressResourceKind>;
  materializePending: DockerEgressResourceKind | null;
  cleanupPending: DockerEgressResourceKind | null;
  materializeCursor: number;
  cleanupStarted: boolean;
  reconcileRequired: boolean;
  terminal: "closed" | null;
  quarantined: boolean;
}

const invalidTransition = (): never => {
  throw new DockerEgressJournalCorruptionError("egress journal event order violates the custody protocol");
};
const nextCleanup = (state: ReplayState): DockerEgressResourceKind | null =>
  DOCKER_EGRESS_CLEANUP_ORDER.find(resource => state.possible.has(resource) && !state.cleaned.has(resource)) ?? null;

const applyMaterializeEvent = (state: ReplayState, event: Extract<DockerEgressJournalEvent,
  { readonly kind: "materialize_intent" | "materialize_receipt" }>): void => {
  if (event.kind === "materialize_intent") {
    if (state.cleanupStarted || state.reconcileRequired || state.materializePending !== null ||
        state.cleanupPending !== null || DOCKER_EGRESS_RESOURCE_KINDS[state.materializeCursor] !== event.resource) {
      invalidTransition();
    }
    state.possible.add(event.resource);
    state.materializeCursor += 1;
    state.materializePending = event.resource;
  } else {
    if (state.materializePending !== event.resource || state.cleanupPending !== null) { invalidTransition(); }
    state.materializePending = null;
  }
};

const applyCleanupEvent = (state: ReplayState, event: Extract<DockerEgressJournalEvent,
  { readonly kind: "cleanup_intent" | "cleanup_receipt" }>): void => {
  if (event.kind === "cleanup_intent") {
    if (state.materializePending !== null || state.cleanupPending !== null || nextCleanup(state) !== event.resource) {
      invalidTransition();
    }
    state.cleanupStarted = true;
    state.cleanupPending = event.resource;
  } else {
    if (state.cleanupPending !== event.resource) { invalidTransition(); }
    state.cleaned.add(event.resource);
    state.cleanupPending = null;
    if (nextCleanup(state) === null) { state.reconcileRequired = false; }
  }
};

const applyReconcileEvent = (state: ReplayState,
  event: Extract<DockerEgressJournalEvent, { readonly kind: "reconcile_required" }>): void => {
  if (event.resource === null) {
    if (state.materializePending !== null || state.cleanupPending !== null) { invalidTransition(); }
  } else if (state.materializePending === event.resource) {
    if (event.reason !== "acknowledgement_unknown") { invalidTransition(); }
    state.materializePending = null;
    state.cleanupStarted = true;
  } else if (state.cleanupPending === event.resource) {
    if (event.reason !== "cleanup_failed" && event.reason !== "cleanup_observation_unknown" &&
        event.reason !== "acknowledgement_unknown") { invalidTransition(); }
    state.cleanupPending = null;
    state.cleanupStarted = true;
  } else { invalidTransition(); }
  state.reconcileRequired = true;
};

const applyEvent = (state: ReplayState, event: DockerEgressJournalEvent, sequence: number): void => {
  if (state.terminal !== null) { invalidTransition(); }
  if (sequence === 0) {
    if (event.kind !== "open_intent") { invalidTransition(); }
    return;
  }
  switch (event.kind) {
    case "open_intent": return invalidTransition();
    case "materialize_intent":
    case "materialize_receipt": applyMaterializeEvent(state, event); return;
    case "cleanup_intent":
    case "cleanup_receipt": applyCleanupEvent(state, event); return;
    case "reconcile_required": applyReconcileEvent(state, event); return;
    case "quarantined":
      if (state.quarantined) { invalidTransition(); }
      state.reconcileRequired = true; state.quarantined = true; return;
    case "closed":
      if (state.materializePending !== null || state.cleanupPending !== null || nextCleanup(state) !== null ||
          state.reconcileRequired || state.quarantined) { invalidTransition(); }
      state.terminal = "closed";
  }
};

const replayState = (records: readonly DockerEgressJournalRecord[]): ReplayState => {
  const state: ReplayState = {
    possible: new Set(), cleaned: new Set(), materializePending: null, cleanupPending: null,
    materializeCursor: 0, cleanupStarted: false, reconcileRequired: false, terminal: null, quarantined: false,
  };
  records.forEach(record => applyEvent(state, record.event, record.sequence));
  return state;
};

export const validateDockerEgressJournalTransitions = (records: readonly DockerEgressJournalRecord[]): void => {
  if (records.length === 0) { throw new DockerEgressJournalCorruptionError("egress journal is empty"); }
  replayState(records);
};

const limitsFrom = (input?: Partial<DockerEgressJournalLimits>): DockerEgressJournalLimits => {
  const result = Object.freeze({ ...DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS, ...input });
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) { throw new TypeError(`${name} must be a positive safe integer`); }
  }
  if (result.maxJournalBytes < result.maxRecordBytes || result.maxRestartScanBytes < result.maxJournalBytes ||
      result.maxRecordsPerJournal < 2 + DOCKER_EGRESS_RESOURCE_KINDS.length * 6 ||
      result.maxJournalBytes < result.maxRecordBytes * (2 + DOCKER_EGRESS_RESOURCE_KINDS.length * 6)) {
    throw new TypeError("egress journal limits cannot contain one crash-recovery lifecycle");
  }
  return result;
};

const sameAttemptIdentity = (left: DockerEgressJournalSubject, right: DockerEgressJournalSubject): boolean => {
  const a = left.identity; const b = right.identity;
  return a.operationId === b.operationId && a.attemptId === b.attemptId && a.effectId === b.effectId &&
    a.custodyId === b.custodyId && a.workspaceId === b.workspaceId;
};
const sameHostResourceGeneration = (left: DockerEgressJournalSubject, right: DockerEgressJournalSubject): boolean =>
  left.identity.hostInstanceId === right.identity.hostInstanceId && left.identity.hostBootId === right.identity.hostBootId &&
  left.identity.resourceGenerationId === right.identity.resourceGenerationId;

export class DockerEgressJournal {
  private readonly limits: DockerEgressJournalLimits;
  public constructor(private readonly storage: DockerCustodyJournalStorage, limits?: Partial<DockerEgressJournalLimits>) {
    this.limits = limitsFrom(limits);
  }

  private async readV3(file: DockerCustodyJournalFile): Promise<readonly DockerEgressJournalRecord[]> {
    const replay = replayDockerEgressBytes(await file.read(this.limits.maxJournalBytes), this.limits);
    if (replay.tail !== "complete") { throw new DockerEgressJournalCorruptionError("egress journal has a partial tail"); }
    validateDockerEgressJournalTransitions(replay.records);
    return replay.records;
  }

  public async open(subjectInput: DockerEgressJournalSubject): Promise<DockerEgressJournalRecord> {
    const subject = validateDockerEgressSubject(subjectInput);
    return this.storage.exclusive(async () => {
      const locator = dockerEgressJournalLocator(subject);
      const existing = await this.storage.open(locator);
      if (existing !== undefined) {
        try {
          const records = await this.readV3(existing);
          const last = records.at(-1);
          if (last === undefined || last.subject.bindingSha256 !== subject.bindingSha256) {
            throw new DockerEgressJournalConflictError();
          }
          return last;
        } finally { await existing.close(); }
      }
      const scanned = await this.storage.scan(this.limits.maxJournalFiles);
      try {
        for (const entry of scanned) {
          const bytes = await entry.file.read(this.limits.maxJournalBytes);
          if (dockerJournalWireVersion(bytes, this.limits.maxRecordBytes) !== DOCKER_EGRESS_JOURNAL_VERSION) { continue; }
          const replay = replayDockerEgressBytes(bytes, this.limits);
          if (replay.tail !== "complete") { throw new DockerEgressJournalCorruptionError(); }
          validateDockerEgressJournalTransitions(replay.records);
          const first = replay.records[0];
          if (first !== undefined && (sameAttemptIdentity(first.subject, subject) ||
              sameHostResourceGeneration(first.subject, subject)) && first.subject.bindingSha256 !== subject.bindingSha256) {
            throw new DockerEgressJournalConflictError("egress attempt or host resource generation is already bound");
          }
        }
        if (scanned.length >= this.limits.maxJournalFiles) { throw new DockerEgressJournalCapacityError(); }
      } finally { for (const entry of scanned) { await entry.file.close(); } }
      const file = await this.storage.create(locator);
      const first = createDockerEgressRecord({ sequence: 0, subject, event: { kind: "open_intent" }, previousChecksumSha256: null });
      try { await file.append(0, encodeDockerEgressRecord(first, this.limits)); return first; }
      finally { await file.close(); }
    });
  }

  private async append(subjectInput: DockerEgressJournalSubject, expectedSequence: number,
    event: DockerEgressJournalEvent): Promise<DockerEgressJournalRecord> {
    const subject = validateDockerEgressSubject(subjectInput);
    return this.storage.exclusive(async () => {
      const file = await this.storage.open(dockerEgressJournalLocator(subject));
      if (file === undefined) { throw new DockerEgressJournalConflictError("egress journal is not open"); }
      try {
        const records = await this.readV3(file);
        const previous = records.at(-1);
        if (previous === undefined || previous.sequence !== expectedSequence ||
            previous.subject.bindingSha256 !== subject.bindingSha256) { throw new DockerEgressJournalConflictError(); }
        if (records.length >= this.limits.maxRecordsPerJournal) { throw new DockerEgressJournalCapacityError(); }
        const next = createDockerEgressRecord({
          sequence: expectedSequence + 1, subject, event, previousChecksumSha256: previous.checksumSha256,
        });
        try { validateDockerEgressJournalTransitions([...records, next]); }
        catch (error) {
          if (error instanceof DockerEgressJournalCorruptionError) {
            throw new DockerEgressJournalConflictError("egress journal transition is not the exact safe next event");
          }
          throw error;
        }
        const bytes = encodeDockerEgressRecord(next, this.limits);
        if (file.byteLength + bytes.byteLength > this.limits.maxJournalBytes) { throw new DockerEgressJournalCapacityError(); }
        await file.append(file.byteLength, bytes);
        return next;
      } finally { await file.close(); }
    });
  }

  public materializeIntent(subject: DockerEgressJournalSubject, expectedSequence: number,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { kind: "materialize_intent", resource });
  }
  public materializeReceipt(subject: DockerEgressJournalSubject, expectedSequence: number,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { acknowledgement: "acknowledged", kind: "materialize_receipt", resource });
  }
  public cleanupIntent(subject: DockerEgressJournalSubject, expectedSequence: number,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { kind: "cleanup_intent", resource });
  }
  public cleanupReceipt(subject: DockerEgressJournalSubject, expectedSequence: number,
    resource: DockerEgressResourceKind, acknowledgement: DockerEgressAcknowledgement): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { acknowledgement, kind: "cleanup_receipt", resource });
  }
  public reconcileRequired(subject: DockerEgressJournalSubject, expectedSequence: number,
    reason: DockerEgressReconcileReason, resource: DockerEgressResourceKind | null): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { kind: "reconcile_required", reason, resource });
  }
  public close(subject: DockerEgressJournalSubject, expectedSequence: number): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { kind: "closed" });
  }
  public quarantine(subject: DockerEgressJournalSubject, expectedSequence: number,
    diagnostic: DockerEgressQuarantineDiagnostic): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, { diagnostic, kind: "quarantined" });
  }

  public async recover(): Promise<readonly DockerEgressRecoveryObservation[]> {
    return this.storage.exclusive(async () => {
      const entries = await this.storage.scan(this.limits.maxJournalFiles);
      const observations: DockerEgressRecoveryObservation[] = [];
      let total = 0;
      for (const entry of entries) {
        try {
          const remaining = this.limits.maxRestartScanBytes - total;
          if (remaining <= 0) { throw new DockerEgressJournalCapacityError("egress restart scan bound exhausted"); }
          const bytes = await entry.file.read(Math.min(this.limits.maxJournalBytes, remaining));
          total += bytes.byteLength;
          const version = dockerJournalWireVersion(bytes, this.limits.maxRecordBytes);
          if (version === DOCKER_EGRESS_JOURNAL_VERSION) {
            const replay = replayDockerEgressBytes(bytes, this.limits);
            if (replay.tail !== "complete") { throw new DockerEgressJournalCorruptionError(); }
            validateDockerEgressJournalTransitions(replay.records);
            const first = replay.records[0];
            if (first === undefined) { throw new DockerEgressJournalCorruptionError(); }
            const state = replayState(replay.records);
            observations.push(Object.freeze({
              kind: "cleanup_only", bindingSha256: first.subject.bindingSha256, nextCleanup: nextCleanup(state),
              reconcileRequired: state.reconcileRequired || state.materializePending !== null || state.cleanupPending !== null,
              status: state.quarantined ? "quarantined" : state.terminal ?? (state.cleanupStarted ? "cleaning" : "open"),
            }));
          } else if (version === 2 || version === undefined) {
            const legacy = classifyDockerEgressLegacyV2(bytes, this.limits);
            observations.push(Object.freeze({ kind: "legacy_cleanup_only", locatorSha256: entry.locatorSha256, ...legacy }));
          } else {
            observations.push(Object.freeze({
              kind: "legacy_cleanup_only", locatorSha256: entry.locatorSha256,
              diagnostic: "legacy_corrupt", quarantineRequired: true, executionAuthority: null, cleanupIdentity: null,
            }));
          }
        } catch {
          observations.push(Object.freeze({
            kind: "cleanup_only", bindingSha256: entry.locatorSha256, nextCleanup: null,
            reconcileRequired: true, status: "quarantined",
          }));
        } finally { await entry.file.close(); }
      }
      return Object.freeze(observations);
    });
  }
}
