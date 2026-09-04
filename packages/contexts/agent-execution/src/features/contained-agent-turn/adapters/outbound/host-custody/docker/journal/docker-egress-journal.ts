import { createHash } from "node:crypto";

import {
  createDockerEgressRecord,
  createDockerEgressTombstone,
  decodeDockerEgressTombstone,
  dockerEgressCleanupHandle,
  dockerEgressJournalLocator,
  encodeDockerEgressRecord,
  encodeDockerEgressTombstone,
  replayDockerEgressBytes,
  type DockerEgressReplay,
  validateDockerEgressSubject,
  validateDockerEgressTrustedIdentity,
} from "./docker-egress-journal-codec.js";
import { classifyDockerEgressLegacyV2 } from "./docker-egress-v2-cleanup-reader.js";
import {
  DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS,
  DOCKER_EGRESS_CLEANUP_ORDER,
  DOCKER_EGRESS_RESOURCE_KINDS,
  DockerEgressJournalCapacityError,
  DockerEgressJournalConflictError,
  DockerEgressJournalCorruptionError,
  type DockerEgressCleanupDirective,
  type DockerEgressCleanupObservation,
  type DockerEgressJournalEvent,
  type DockerEgressJournalFile,
  type DockerEgressJournalLimits,
  type DockerEgressJournalRecord,
  type DockerEgressJournalStorage,
  type DockerEgressJournalSubject,
  type DockerEgressQuarantineDiagnostic,
  type DockerEgressReconcileReason,
  type DockerEgressRecoveryEvidence,
  type DockerEgressResourceKind,
  type DockerEgressStorageEntry,
  type DockerEgressTrustedRuntimeIdentity,
} from "./docker-egress-journal-types.js";
import { DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS } from "./docker-custody-journal-types.js";

interface ReplayState {
  readonly possible: Set<DockerEgressResourceKind>;
  readonly cleaned: Set<DockerEgressResourceKind>;
  materializePending: DockerEgressResourceKind | null;
  cleanupPending: DockerEgressResourceKind | null;
  materializeCursor: number;
  cleanupStarted: boolean;
  reconcileRequired: boolean;
  unscopedReconciliation: boolean;
  terminal: boolean;
  quarantined: boolean;
}
const invalid = (): never => { throw new DockerEgressJournalCorruptionError("invalid custody transition"); };
const nextCleanup = (state: ReplayState): DockerEgressResourceKind | null =>
  DOCKER_EGRESS_CLEANUP_ORDER.find(resource => state.possible.has(resource) && !state.cleaned.has(resource)) ?? null;
const isDebtFree = (state: ReplayState): boolean => nextCleanup(state) === null &&
  state.materializePending === null && state.cleanupPending === null &&
  !state.reconcileRequired && !state.quarantined;
const initialState = (): ReplayState => ({
  possible: new Set(), cleaned: new Set(), materializePending: null, cleanupPending: null,
  materializeCursor: 0, cleanupStarted: false, reconcileRequired: false, unscopedReconciliation: false, terminal: false, quarantined: false,
});
const requiredReservation = (state: ReplayState, kind: "materialize" | "cleanup"): number => kind === "cleanup"
  ? 3
  : 4 + (state.possible.size + 1) * 2;

const observationMatches = (subject: DockerEgressJournalSubject, resource: DockerEgressResourceKind,
  observation: DockerEgressCleanupObservation): boolean => {
  const identity = subject.identity;
  return observation.resource === resource && observation.cleanupHandle === dockerEgressCleanupHandle(subject, resource) &&
    observation.scopeSha256 === subject.authority.scopeSha256 && observation.hostInstanceId === identity.hostInstanceId &&
    observation.hostBootId === identity.hostBootId && observation.executionGenerationId === identity.executionGenerationId &&
    observation.daemonId === identity.daemonId && observation.daemonGenerationId === identity.daemonGenerationId &&
    observation.slotGenerationId === identity.slotGenerationId && observation.result === "absent";
};
const applyMaterializeIntent = (state: ReplayState, event: Extract<DockerEgressJournalEvent, {kind: "materialize_intent"}>): void => {
    if (state.cleanupStarted || state.reconcileRequired || state.materializePending !== null || state.cleanupPending !== null ||
        DOCKER_EGRESS_RESOURCE_KINDS[state.materializeCursor] !== event.resource ||
        event.reservation.recordCount !== requiredReservation(state, "materialize") ||
        event.reservation.byteCount !== event.reservation.recordCount * DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordBytes) { invalid(); }
    state.possible.add(event.resource); state.materializeCursor += 1; state.materializePending = event.resource;
};
const applyMaterializeReceipt = (state: ReplayState, event: Extract<DockerEgressJournalEvent, {kind: "materialize_receipt"}>): void => {
    if (state.materializePending !== event.resource || state.cleanupPending !== null) { invalid(); }
    state.materializePending = null;
};
const applyCleanupIntent = (state: ReplayState, event: Extract<DockerEgressJournalEvent, {kind: "cleanup_intent"}>): void => {
    if (state.materializePending !== null || state.cleanupPending !== null || nextCleanup(state) !== event.resource ||
        event.reservation.recordCount !== requiredReservation(state, "cleanup") ||
        event.reservation.byteCount !== event.reservation.recordCount * DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordBytes) { invalid(); }
    state.cleanupStarted = true; state.cleanupPending = event.resource;
};
const applyCleanupReceipt = (state: ReplayState, subject: DockerEgressJournalSubject,
  event: Extract<DockerEgressJournalEvent, {kind: "cleanup_receipt"}>): void => {
    if (state.cleanupPending !== event.resource || !observationMatches(subject, event.resource, event.observation)) { invalid(); }
    state.cleaned.add(event.resource); state.cleanupPending = null;
    if (nextCleanup(state) === null) { state.reconcileRequired = state.unscopedReconciliation; }
};
const applyReconciliation = (state: ReplayState, event: Extract<DockerEgressJournalEvent, {kind: "reconcile_required"}>): void => {
    if (event.resource === null) {
      if (state.materializePending !== null || state.cleanupPending !== null) { invalid(); }
      state.unscopedReconciliation = true;
    } else if (state.materializePending === event.resource && event.reason === "acknowledgement_unknown") {
      state.materializePending = null; state.cleanupStarted = true;
    } else if (state.cleanupPending === event.resource &&
        ["acknowledgement_unknown", "cleanup_failed", "cleanup_observation_unknown"].includes(event.reason)) {
      state.cleanupPending = null; state.cleanupStarted = true;
    } else { invalid(); }
    state.reconcileRequired = true;
};
const applyClosed = (state: ReplayState): void => {
  if (state.materializePending !== null || state.cleanupPending !== null || nextCleanup(state) !== null ||
      state.reconcileRequired || state.quarantined) { invalid(); }
  state.terminal = true;
};
const applyEvent = (state: ReplayState, record: DockerEgressJournalRecord): void => {
  const event = record.event;
  if (state.terminal || (record.sequence === 0 && event.kind !== "open_intent") ||
      (record.sequence !== 0 && event.kind === "open_intent")) { invalid(); }
  switch (event.kind) {
    case "open_intent": return;
    case "materialize_intent": return applyMaterializeIntent(state, event);
    case "materialize_receipt": return applyMaterializeReceipt(state, event);
    case "cleanup_intent": return applyCleanupIntent(state, event);
    case "cleanup_receipt": return applyCleanupReceipt(state, record.subject, event);
    case "reconcile_required": return applyReconciliation(state, event);
    case "quarantined": {
      if (state.quarantined) { invalid(); }
      state.quarantined = true; state.reconcileRequired = true; return;
    }
    case "closed": return applyClosed(state);
  }
};
const replayState = (records: readonly DockerEgressJournalRecord[]): ReplayState => {
  if (records.length === 0) { invalid(); }
  const state = initialState(); records.forEach(record => applyEvent(state, record)); return state;
};
export const validateDockerEgressJournalTransitions = (records: readonly DockerEgressJournalRecord[]): void => { replayState(records); };

const limitsFrom = (input?: Partial<DockerEgressJournalLimits>): DockerEgressJournalLimits => {
  const result = Object.freeze({ ...DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS, ...input });
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) { throw new TypeError(`${name} must be a positive safe integer`); }
  }
  const lifecycleRecords = 5 + DOCKER_EGRESS_RESOURCE_KINDS.length * 4;
  if (result.maxRecordBytes !== DEFAULT_DOCKER_EGRESS_JOURNAL_LIMITS.maxRecordBytes ||
      result.maxRecordsPerJournal < lifecycleRecords || result.maxJournalBytes < result.maxRecordBytes * lifecycleRecords ||
      result.maxRestartScanBytes < result.maxJournalBytes) { throw new TypeError("limits cannot reserve one crash-safe lifecycle"); }
  return result;
};
const trustedMatches = (subject: DockerEgressJournalSubject, trusted: DockerEgressTrustedRuntimeIdentity): boolean => {
  const identity = subject.identity;
  return subject.authority.scopeSha256 === trusted.scopeSha256 && identity.hostSlotId === trusted.hostSlotId &&
    identity.hostInstanceId === trusted.hostInstanceId && identity.hostBootId === trusted.hostBootId &&
    identity.executionGenerationId === trusted.executionGenerationId && identity.daemonId === trusted.daemonId &&
    identity.daemonGenerationId === trusted.daemonGenerationId && identity.slotGenerationId === trusted.slotGenerationId;
};
const uniquenessValues = (subject: DockerEgressJournalSubject): readonly string[] => Object.freeze([
  subject.identity.operationId, subject.identity.effectId, subject.identity.attemptId, subject.identity.executionGenerationId,
  subject.identity.daemonGenerationId, subject.identity.slotGenerationId, ...Object.values(subject.resources),
]);
const identitiesOverlap = (left: DockerEgressJournalSubject, right: DockerEgressJournalSubject): boolean => {
  const seen = new Set(uniquenessValues(left)); return uniquenessValues(right).some(value => seen.has(value));
};
const internalCommand = (locator: string, purpose: string): string =>
  `command:${createHash("sha256").update(`docker-egress-internal/v3:${locator}:${purpose}`).digest("hex")}`;

export class DockerEgressJournal {
  private readonly limits: DockerEgressJournalLimits;
  private readonly trusted: DockerEgressTrustedRuntimeIdentity;
  public constructor(
    private readonly storage: DockerEgressJournalStorage,
    trusted: DockerEgressTrustedRuntimeIdentity,
    limits?: Partial<DockerEgressJournalLimits>,
  ) { this.trusted = validateDockerEgressTrustedIdentity(trusted); this.limits = limitsFrom(limits); }

  private async replay(file: DockerEgressJournalFile): Promise<DockerEgressReplay> {
    return replayDockerEgressBytes(await file.read(this.limits.maxJournalBytes), this.limits);
  }
  private async read(file: DockerEgressJournalFile): Promise<readonly DockerEgressJournalRecord[]> {
    const replay = await this.replay(file);
    if (replay.tail !== "complete") { throw new DockerEgressJournalCorruptionError("partial journal tail"); }
    replayState(replay.records); return replay.records;
  }
  private precharge(entries: readonly DockerEgressStorageEntry[], used: number): number {
    let total = used;
    for (const entry of entries) {
      total += entry.byteLength;
      if (total > this.limits.maxRestartScanBytes) { throw new DockerEgressJournalCapacityError("restart scan bytes exhausted before I/O"); }
    }
    return total;
  }
  private async scanAll(): Promise<Readonly<{
    v3: readonly DockerEgressStorageEntry[]; legacy: readonly DockerEgressStorageEntry[]; tombstones: readonly DockerEgressStorageEntry[];
  }>> {
    const opened: DockerEgressStorageEntry[] = [];
    try {
      const tombstones = await this.storage.scanTombstones(this.limits.maxJournalFiles); opened.push(...tombstones);
      const v3 = await this.storage.scanV3(this.limits.maxJournalFiles); opened.push(...v3);
      const legacy = await this.storage.scanLegacyV2(this.limits.maxJournalFiles); opened.push(...legacy);
      if (opened.length >= this.limits.maxJournalFiles) { throw new DockerEgressJournalCapacityError(); }
      let charged = this.precharge(tombstones, 0); charged = this.precharge(v3, charged); this.precharge(legacy, charged);
      return { tombstones, v3, legacy };
    } catch (error) {
      await this.closeEntries(opened);
      throw error;
    }
  }
  private async closeEntries(entries: readonly DockerEgressStorageEntry[]): Promise<void> {
    await Promise.all(entries.map(async entry => entry.file.close().catch(() => {})));
  }

  private async validateLegacyAdmission(entries: readonly DockerEgressStorageEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.byteLength > DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS.maxJournalBytes) {
        throw new DockerEgressJournalConflictError("oversized V2 entry fences admission");
      }
      const legacy = classifyDockerEgressLegacyV2(await entry.file.read(entry.byteLength));
      if (legacy.quarantineRequired) { throw new DockerEgressJournalConflictError("unsafe V2 entry fences admission"); }
    }
  }

  private async quarantineCorruptEntry(entry: DockerEgressStorageEntry): Promise<never> {
    let terminalRecord: DockerEgressJournalRecord | null = null;
    try {
      const prefix = await this.replay(entry.file);
      if (prefix.records.length > 0) {
        replayState(prefix.records);
        if (dockerEgressJournalLocator(prefix.records[0]!.subject) === entry.locatorSha256) {
          terminalRecord = prefix.records.at(-1)!;
        }
      }
    } catch { /* Only a completely validated, locator-bound prefix is retained. */ }
    const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256,
      bindingSha256: terminalRecord?.subject.bindingSha256 ?? null,
      disposition: "quarantined", terminalRecord });
    await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
    throw new DockerEgressJournalConflictError("corrupt V3 entry fences admission");
  }

  public async open(subjectInput: DockerEgressJournalSubject, commandId: string): Promise<DockerEgressJournalRecord> {
    const subject = validateDockerEgressSubject(subjectInput);
    if (!trustedMatches(subject, this.trusted)) { throw new DockerEgressJournalConflictError("subject is not current trusted runtime identity"); }
    return this.storage.exclusive(this.trusted, async () => {
      const all = await this.scanAll(); const entries = [...all.tombstones, ...all.v3, ...all.legacy];
      try {
        await this.validateLegacyAdmission(all.legacy);
        for (const entry of all.tombstones) {
          const tombstone = decodeDockerEgressTombstone(await entry.file.read(entry.byteLength), this.limits);
          if (tombstone.locatorSha256 !== entry.locatorSha256 || tombstone.disposition === "quarantined") {
            throw new DockerEgressJournalConflictError("quarantine or misplaced tombstone fences admission");
          }
          const retiredSubject = tombstone.terminalRecord?.subject;
          if (retiredSubject !== undefined && identitiesOverlap(retiredSubject, subject)) {
            throw new DockerEgressJournalConflictError("retirement tombstone prevents identity resurrection");
          }
        }
        const locator = dockerEgressJournalLocator(subject);
        for (const entry of all.v3) {
          if (entry.byteLength === 0) {
            if (entry.locatorSha256 === locator) { continue; }
            throw new DockerEgressJournalConflictError("unknown zero-byte V3 entry fences admission");
          }
          let records: readonly DockerEgressJournalRecord[];
          try { records = await this.read(entry.file); }
          catch { return await this.quarantineCorruptEntry(entry); }
          const first = records[0]!;
          if (dockerEgressJournalLocator(first.subject) !== entry.locatorSha256) {
            const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256,
              bindingSha256: first.subject.bindingSha256, disposition: "quarantined", terminalRecord: records.at(-1)! });
            await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
            throw new DockerEgressJournalConflictError("locator-record mismatch fences admission");
          }
          if (entry.locatorSha256 === locator) {
            const candidate = createDockerEgressRecord({ sequence: 0, subject, commandId, event: { kind: "open_intent" }, previousChecksumSha256: null });
            if (records[0]?.commandId === commandId && records[0].commandDigestSha256 === candidate.commandDigestSha256) { return records[0]; }
            throw new DockerEgressJournalConflictError("open command conflicts with existing journal");
          }
          if (!replayState(records).terminal || identitiesOverlap(first.subject, subject)) {
            throw new DockerEgressJournalConflictError("live, debt, or reused identity fences admission");
          }
        }
        const first = createDockerEgressRecord({ sequence: 0, subject, commandId, event: { kind: "open_intent" }, previousChecksumSha256: null });
        const file = await this.storage.createWithFirstRecord(locator, encodeDockerEgressRecord(first, this.limits));
        await file.close(); return first;
      } finally { await this.closeEntries(entries); }
    });
  }

  private async tombstoneRetry(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    event: DockerEgressJournalEvent): Promise<DockerEgressJournalRecord | undefined> {
    const entries = await this.storage.scanTombstones(this.limits.maxJournalFiles);
    try {
      const file = entries.find(entry => entry.locatorSha256 === dockerEgressJournalLocator(subject))?.file;
      if (file === undefined) { return; }
      const tombstone = decodeDockerEgressTombstone(await file.read(this.limits.maxRecordBytes), this.limits);
      const committed = tombstone.terminalRecord;
      if (committed?.commandId !== commandId) { return; }
      const candidate = createDockerEgressRecord({ sequence: expectedSequence + 1, subject, commandId, event,
        previousChecksumSha256: committed.previousChecksumSha256 });
      if (candidate.commandDigestSha256 !== committed.commandDigestSha256) { throw new DockerEgressJournalConflictError("command digest conflict"); }
      return committed;
    } finally { await this.closeEntries(entries); }
  }

  private async persistRetirement(locator: string, terminalRecord: DockerEgressJournalRecord): Promise<void> {
    const tombstone = createDockerEgressTombstone({ locatorSha256: locator,
      bindingSha256: terminalRecord.subject.bindingSha256, disposition: "retired", terminalRecord });
    await this.storage.persistTombstone(locator, encodeDockerEgressTombstone(tombstone, this.limits), true);
  }

  private async committedCommandRetry(locator: string, subject: DockerEgressJournalSubject,
    committed: DockerEgressJournalRecord, event: DockerEgressJournalEvent): Promise<DockerEgressJournalRecord> {
    const candidate = createDockerEgressRecord({ sequence: committed.sequence, subject, commandId: committed.commandId, event,
      previousChecksumSha256: committed.previousChecksumSha256 });
    if (candidate.commandDigestSha256 !== committed.commandDigestSha256) {
      throw new DockerEgressJournalConflictError("same command ID has a different canonical digest");
    }
    if (committed.event.kind === "closed") { await this.persistRetirement(locator, committed); }
    return committed;
  }

  private async append(subjectInput: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    event: DockerEgressJournalEvent): Promise<DockerEgressJournalRecord> {
    const subject = validateDockerEgressSubject(subjectInput);
    if (!trustedMatches(subject, this.trusted)) { throw new DockerEgressJournalConflictError("stale runtime identity"); }
    return this.storage.exclusive(this.trusted, async () => {
      const locator = dockerEgressJournalLocator(subject); const file = await this.storage.openV3(locator);
      if (file === undefined) {
        const retry = await this.tombstoneRetry(subject, expectedSequence, commandId, event);
        if (retry !== undefined) { return retry; }
        throw new DockerEgressJournalConflictError("journal is unavailable");
      }
      try {
        const records = await this.read(file); const committed = records.find(record => record.commandId === commandId);
        if (committed !== undefined) { return await this.committedCommandRetry(locator, subject, committed, event); }
        const previous = records.at(-1);
        if (previous === undefined || previous.sequence !== expectedSequence || previous.subject.bindingSha256 !== subject.bindingSha256) {
          throw new DockerEgressJournalConflictError();
        }
        const next = createDockerEgressRecord({ sequence: expectedSequence + 1, subject, commandId, event,
          previousChecksumSha256: previous.checksumSha256 });
        try { replayState([...records, next]); } catch { throw new DockerEgressJournalConflictError("unsafe next event"); }
        const bytes = encodeDockerEgressRecord(next, this.limits);
        const reservation = event.kind === "materialize_intent" || event.kind === "cleanup_intent" ? event.reservation : undefined;
        const requiredRecords = reservation?.recordCount ?? 1; const requiredBytes = reservation?.byteCount ?? bytes.byteLength;
        if (records.length + requiredRecords > this.limits.maxRecordsPerJournal || file.byteLength + requiredBytes > this.limits.maxJournalBytes) {
          throw new DockerEgressJournalCapacityError("durable reverse-cleanup reservation unavailable");
        }
        await file.append(file.byteLength, bytes);
        if (event.kind === "closed" || event.kind === "quarantined") {
          const tombstone = createDockerEgressTombstone({ locatorSha256: locator, bindingSha256: subject.bindingSha256,
            disposition: event.kind === "closed" ? "retired" : "quarantined", terminalRecord: next });
          await this.storage.persistTombstone(locator, encodeDockerEgressTombstone(tombstone, this.limits), event.kind === "closed");
        }
        return next;
      } finally { await file.close(); }
    });
  }

  public materializeIntent(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    const stateCount = DOCKER_EGRESS_RESOURCE_KINDS.indexOf(resource) + 1; const count = 4 + stateCount * 2;
    return this.append(subject, expectedSequence, commandId, { kind: "materialize_intent", resource,
      reservation: { recordCount: count, byteCount: count * this.limits.maxRecordBytes } });
  }
  public materializeReceipt(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { kind: "materialize_receipt", resource });
  }
  public cleanupIntent(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    resource: DockerEgressResourceKind): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { kind: "cleanup_intent", resource,
      reservation: { recordCount: 3, byteCount: 3 * this.limits.maxRecordBytes } });
  }
  public cleanupReceipt(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    resource: DockerEgressResourceKind, observation: DockerEgressCleanupObservation): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { kind: "cleanup_receipt", resource, observation });
  }
  public reconcileRequired(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    reason: DockerEgressReconcileReason, resource: DockerEgressResourceKind | null): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { kind: "reconcile_required", reason, resource });
  }
  public close(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { kind: "closed" });
  }
  public quarantine(subject: DockerEgressJournalSubject, expectedSequence: number, commandId: string,
    diagnostic: DockerEgressQuarantineDiagnostic): Promise<DockerEgressJournalRecord> {
    return this.append(subject, expectedSequence, commandId, { diagnostic, kind: "quarantined" });
  }

  private async quarantineStaleEntry(entry: DockerEgressStorageEntry,
    records: readonly DockerEgressJournalRecord[], state: ReplayState): Promise<void> {
    const previous = records.at(-1)!; const subject = previous.subject;
    let terminalRecord = previous;
    if (!state.terminal && !state.quarantined && records.length < this.limits.maxRecordsPerJournal) {
      const event = { diagnostic: dockerEgressJournalLocator(subject) === entry.locatorSha256
        ? "identity_stale" as const : "locator_mismatch" as const, kind: "quarantined" as const };
      terminalRecord = createDockerEgressRecord({ sequence: previous.sequence + 1, subject,
        commandId: internalCommand(entry.locatorSha256, event.diagnostic), event, previousChecksumSha256: previous.checksumSha256 });
      await entry.file.append(entry.file.byteLength, encodeDockerEgressRecord(terminalRecord, this.limits));
    }
    const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256,
      bindingSha256: subject.bindingSha256, disposition: "quarantined", terminalRecord });
    await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
  }

  private async retireDebtFree(entry: DockerEgressStorageEntry,
    records: readonly DockerEgressJournalRecord[]): Promise<DockerEgressJournalRecord> {
    const previous = records.at(-1)!;
    if (previous.event.kind === "closed") {
      await this.persistRetirement(entry.locatorSha256, previous);
      return previous;
    }
    const terminal = createDockerEgressRecord({ sequence: previous.sequence + 1, subject: previous.subject,
      commandId: internalCommand(entry.locatorSha256, "recovery-close"), event: { kind: "closed" },
      previousChecksumSha256: previous.checksumSha256 });
    if (records.length >= this.limits.maxRecordsPerJournal ||
        entry.file.byteLength + this.limits.maxRecordBytes > this.limits.maxJournalBytes) {
      throw new DockerEgressJournalCapacityError("debt-free recovery closure reservation unavailable");
    }
    await entry.file.append(entry.file.byteLength, encodeDockerEgressRecord(terminal, this.limits));
    await this.persistRetirement(entry.locatorSha256, terminal);
    return terminal;
  }

  private async retryExactRetirement(tombstoneEntry: DockerEgressStorageEntry,
    liveEntry: DockerEgressStorageEntry): Promise<boolean> {
    const tombstone = decodeDockerEgressTombstone(await tombstoneEntry.file.read(tombstoneEntry.byteLength), this.limits);
    const expected = tombstone.terminalRecord;
    if (tombstone.locatorSha256 !== tombstoneEntry.locatorSha256 || tombstone.disposition !== "retired" ||
        expected === null || expected.event.kind !== "closed") { return false; }
    let replay: DockerEgressReplay;
    try { replay = await this.replay(liveEntry.file); } catch { return false; }
    if (replay.tail !== "complete") { return false; }
    const actual = replay.records.at(-1);
    if (actual === undefined || actual.checksumSha256 !== expected.checksumSha256 ||
        actual.subject.bindingSha256 !== tombstone.bindingSha256 ||
        dockerEgressJournalLocator(actual.subject) !== liveEntry.locatorSha256 ||
        liveEntry.locatorSha256 !== tombstoneEntry.locatorSha256) { return false; }
    try { replayState(replay.records); } catch { return false; }
    if (!replayState(replay.records).terminal) { return false; }
    await this.storage.persistTombstone(tombstoneEntry.locatorSha256,
      encodeDockerEgressTombstone(tombstone, this.limits), true);
    return true;
  }

  private async recoverV3Entry(entry: DockerEgressStorageEntry, directives: DockerEgressCleanupDirective[],
    evidence: DockerEgressRecoveryEvidence[]): Promise<void> {
    try {
      const replay = await this.replay(entry.file); const records = replay.records;
      if (records.length === 0) { throw new DockerEgressJournalCorruptionError(); }
      const subject = records[0]!.subject; const state = replayState(records);
      if (dockerEgressJournalLocator(subject) !== entry.locatorSha256 || !trustedMatches(subject, this.trusted)) {
        await this.quarantineStaleEntry(entry, records, state);
        evidence.push(Object.freeze({ kind: "quarantine_evidence", locatorSha256: entry.locatorSha256,
          bindingSha256: subject.bindingSha256, status: "quarantined" })); return;
      }
      if (replay.tail === "complete" && state.terminal) {
        await this.persistRetirement(entry.locatorSha256, records.at(-1)!);
        evidence.push(Object.freeze({ kind: "retirement_evidence", locatorSha256: entry.locatorSha256,
          bindingSha256: subject.bindingSha256, status: "retired" })); return;
      }
      if (replay.tail === "complete" && isDebtFree(state)) {
        await this.retireDebtFree(entry, records);
        evidence.push(Object.freeze({ kind: "retirement_evidence", locatorSha256: entry.locatorSha256,
          bindingSha256: subject.bindingSha256, status: "retired" })); return;
      }
      const resource = nextCleanup(state);
      if (resource !== null) { directives.push(Object.freeze({ kind: "cleanup_only", subject, sequence: records.at(-1)!.sequence,
        resource, cleanupHandle: dockerEgressCleanupHandle(subject, resource),
        reconcileRequired: state.reconcileRequired || state.materializePending !== null || state.cleanupPending !== null })); }
      if (replay.tail !== "complete") {
        const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256,
          bindingSha256: subject.bindingSha256, disposition: "quarantined", terminalRecord: records.at(-1)! });
        await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
      }
      evidence.push(Object.freeze({ kind: state.quarantined || replay.tail !== "complete" ? "quarantine_evidence" : "cleanup_evidence",
        locatorSha256: entry.locatorSha256, bindingSha256: subject.bindingSha256,
        status: state.quarantined || replay.tail !== "complete" ? "quarantined" : "debt" }));
    } catch {
      const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256, bindingSha256: null,
        disposition: "quarantined", terminalRecord: null });
      await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
      evidence.push(Object.freeze({ kind: "quarantine_evidence", locatorSha256: entry.locatorSha256,
        bindingSha256: null, status: "quarantined" }));
    }
  }

  private async recovery(): Promise<Readonly<{ directives: readonly DockerEgressCleanupDirective[]; evidence: readonly DockerEgressRecoveryEvidence[] }>> {
    return this.storage.exclusive(this.trusted, async () => {
      const all = await this.scanAll(); const entries = [...all.tombstones, ...all.v3, ...all.legacy];
      const directives: DockerEgressCleanupDirective[] = []; const evidence: DockerEgressRecoveryEvidence[] = [];
      const retiredLive = new Set<string>();
      try {
        for (const entry of all.tombstones) {
          try {
            const item = decodeDockerEgressTombstone(await entry.file.read(entry.byteLength), this.limits);
            if (item.locatorSha256 !== entry.locatorSha256) { throw new Error("tombstone locator mismatch"); }
            const live = all.v3.find(candidate => candidate.locatorSha256 === entry.locatorSha256);
            if (live !== undefined && await this.retryExactRetirement(entry, live)) { retiredLive.add(entry.locatorSha256); }
            evidence.push(Object.freeze({ kind: item.disposition === "retired" ? "retirement_evidence" : "quarantine_evidence",
              locatorSha256: entry.locatorSha256, bindingSha256: item.bindingSha256,
              status: item.disposition === "retired" ? "retired" : "quarantined" }));
          } catch { evidence.push(Object.freeze({ kind: "quarantine_evidence", locatorSha256: entry.locatorSha256,
            bindingSha256: null, status: "quarantined" })); }
        }
        for (const entry of all.legacy) {
          const legacy = entry.byteLength > DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS.maxJournalBytes
            ? { diagnostic: "legacy_oversized" as const, quarantineRequired: true, executionAuthority: null, cleanupIdentity: null }
            : classifyDockerEgressLegacyV2(await entry.file.read(entry.byteLength));
          if (legacy.quarantineRequired) {
            const tombstone = createDockerEgressTombstone({ locatorSha256: entry.locatorSha256, bindingSha256: null,
              disposition: "quarantined", terminalRecord: null });
            await this.storage.persistTombstone(entry.locatorSha256, encodeDockerEgressTombstone(tombstone, this.limits), false);
          }
          evidence.push(Object.freeze({ kind: "legacy_evidence", locatorSha256: entry.locatorSha256, bindingSha256: null,
            status: legacy.quarantineRequired ? "quarantined" : "retired" }));
        }
        for (const entry of all.v3) {
          if (retiredLive.has(entry.locatorSha256)) { continue; }
          await this.recoverV3Entry(entry, directives, evidence);
        }
        return Object.freeze({ directives: Object.freeze(directives), evidence: Object.freeze(evidence) });
      } finally { await this.closeEntries(entries); }
    });
  }
  public async recoverCleanupDirectives(): Promise<readonly DockerEgressCleanupDirective[]> { return (await this.recovery()).directives; }
  public async recoveryEvidence(): Promise<readonly DockerEgressRecoveryEvidence[]> { return (await this.recovery()).evidence; }
}
