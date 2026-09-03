import {
  createDockerCustodyRetirementReceipt,
  createDockerCustodyRecord,
  decodeDockerCustodyRetirementReceipt,
  dockerCustodyAttemptLocator,
  encodeDockerCustodyRecord,
  encodeDockerCustodyRetirementReceipt,
  replayDockerCustodyBytes,
  validateDockerCustodyAttemptKey,
} from "./docker-custody-journal-codec.js";
import {
  DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
  DOCKER_CUSTODY_ACTION_STATES,
  DOCKER_CUSTODY_STATES,
  DockerCustodyJournalCapacityError,
  DockerCustodyJournalConflictError,
  DockerCustodyJournalCorruptionError,
  DockerCustodyJournalUnavailableError,
  isDockerCustodyJournalTransition,
  type DockerCustodyActionState,
  type DockerCustodyAttemptKey,
  type DockerCustodyJournalEvidence,
  type DockerCustodyJournalFile,
  type DockerCustodyJournalLimits,
  type DockerCustodyJournalRecord,
  type DockerCustodyJournalState,
  type DockerCustodyJournalStorage,
  type DockerCustodyObservationState,
  type DockerCustodyRecoveryObservation,
} from "./docker-custody-journal-types.js";

const limitsFrom = (input?: Partial<DockerCustodyJournalLimits>): DockerCustodyJournalLimits => {
  const limits = Object.freeze({ ...DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS, ...input });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {throw new TypeError(`${name} must be a positive integer`);}
  }
  if (
    limits.maxRecordsPerJournal < DOCKER_CUSTODY_STATES.length ||
    limits.maxJournalBytes < limits.maxRecordBytes * DOCKER_CUSTODY_STATES.length ||
    limits.maxRestartScanBytes < limits.maxJournalBytes
  ) {throw new TypeError("journal limits cannot reserve one complete attempt");}
  return limits;
};

const sameKey = (left: DockerCustodyAttemptKey, right: DockerCustodyAttemptKey): boolean =>
  Object.keys(left).every(key => left[key as keyof DockerCustodyAttemptKey] === right[key as keyof DockerCustodyAttemptKey]);

const sameStableAttempt = (left: DockerCustodyAttemptKey, right: DockerCustodyAttemptKey): boolean =>
  left.tenantId === right.tenantId && left.projectId === right.projectId && left.operationId === right.operationId &&
  left.attemptId === right.attemptId;

const providerExecution = (records: readonly DockerCustodyJournalRecord[]): "not_requested" | "may_have_executed" | "unknown" =>
  records.length === 0 ? "unknown" : records.some(record => record.state === "provider_exec_requested")
    ? "may_have_executed"
    : "not_requested";

const hasUnresolvedDebt = (records: readonly DockerCustodyJournalRecord[]): boolean => {
  const providerRequested = records.some(record => record.state === "provider_exec_requested");
  const providerObservation = records.findLast(record => record.state === "provider_exec_observed");
  const providerDebt = providerRequested && providerObservation?.evidence.status !== "proved";
  const closed = records.at(-1)?.state === "closed";
  return providerDebt || (!closed && records.some(record => record.evidence.status === "unproven"));
};

const minimumRecordsAfterAction = (state: DockerCustodyActionState): number => {
  switch (state) {
    case "create_requested": return 10;
    case "init_start_requested": return 8;
    case "provider_exec_requested": return 6;
    case "contain_requested": return 4;
    case "remove_requested": return 2;
  }
};

export interface DockerCustodyJournalWriter {
  prepare(key: DockerCustodyAttemptKey): Promise<DockerCustodyJournalRecord>;
  /** Exact non-creating durable lookup for all post-launch actions. */
  lookup(key: DockerCustodyAttemptKey): Promise<DockerCustodyJournalRecord>;
  beforeAction(input: {
    readonly key: DockerCustodyAttemptKey;
    readonly expectedSequence: number;
    readonly state: DockerCustodyActionState;
  }): Promise<DockerCustodyJournalRecord>;
  observe(input: {
    readonly authoritySha256?: string;
    readonly key: DockerCustodyAttemptKey;
    readonly expectedSequence: number;
    readonly state: DockerCustodyObservationState;
    readonly evidence: DockerCustodyJournalEvidence;
  }): Promise<DockerCustodyJournalRecord>;
  retire(input: {
    readonly expectedChecksumSha256: string;
    readonly key: DockerCustodyAttemptKey;
  }): Promise<void>;
}

export interface DockerCustodyJournalRecoveryReader {
  recover(): Promise<readonly DockerCustodyRecoveryObservation[]>;
}

export class DockerCustodyJournal implements DockerCustodyJournalWriter, DockerCustodyJournalRecoveryReader {
  private readonly limits: DockerCustodyJournalLimits;

  public constructor(private readonly storage: DockerCustodyJournalStorage, limits?: Partial<DockerCustodyJournalLimits>) {
    this.limits = limitsFrom(limits);
  }

  private async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.storage.exclusive(operation);
  }

  private async replay(file: DockerCustodyJournalFile) {
    return replayDockerCustodyBytes(await file.read(this.limits.maxJournalBytes), this.limits);
  }

  private async close(file: DockerCustodyJournalFile): Promise<void> {
    await file.close();
  }

  public async prepare(keyInput: DockerCustodyAttemptKey): Promise<DockerCustodyJournalRecord> {
    const key = validateDockerCustodyAttemptKey(keyInput);
    return this.exclusive(async () => {
      const locator = dockerCustodyAttemptLocator(key);
      const existing = await this.storage.open(locator);
      if (existing !== undefined) {
        try {
          const replay = await this.replay(existing);
          if (replay.tail !== "complete" || replay.records.length === 0) {throw new DockerCustodyJournalCorruptionError();}
          const first = replay.records[0];
          if (first === undefined || !sameKey(first.attemptKey, key)) {throw new DockerCustodyJournalConflictError("attempt launch fingerprint conflicts");}
          return replay.records.at(-1) as DockerCustodyJournalRecord;
        } finally {await this.close(existing);}
      }
      const scanned = await this.storage.scan(this.limits.maxJournalFiles);
      try {
        for (const entry of scanned) {
          const replay = await this.replay(entry.file);
          const first = replay.records[0];
          if (replay.tail !== "complete" || first === undefined) {throw new DockerCustodyJournalCorruptionError();}
          if ((sameStableAttempt(first.attemptKey, key) ||
              first.attemptKey.operationNonceSha256 === key.operationNonceSha256) &&
              !sameKey(first.attemptKey, key)) {
            throw new DockerCustodyJournalConflictError("canonical Docker custody owner binding conflicts");
          }
        }
        if (scanned.length >= this.limits.maxJournalFiles) {throw new DockerCustodyJournalCapacityError();}
      } finally {
        for (const entry of scanned) {await this.close(entry.file);}
      }
      let file: DockerCustodyJournalFile;
      try {file = await this.storage.create(locator);} catch (error) {
        if (!(error instanceof DockerCustodyJournalConflictError)) {throw error;}
        const raced = await this.storage.open(locator);
        if (raced === undefined) {throw error;}
        try {
          const replay = await this.replay(raced);
          const first = replay.records[0];
          if (replay.tail !== "complete" || first === undefined || !sameKey(first.attemptKey, key)) {
            throw new DockerCustodyJournalConflictError("attempt launch fingerprint conflicts");
          }
          return replay.records.at(-1) as DockerCustodyJournalRecord;
        } finally {await this.close(raced);}
      }
      const prepared = createDockerCustodyRecord({
        attemptKey: key, sequence: 0, state: "prepared", evidence: { status: "proved" }, previousChecksumSha256: null,
      });
      const bytes = encodeDockerCustodyRecord(prepared, this.limits);
      try {await file.append(0, bytes); return prepared;} finally {await this.close(file);}
    });
  }

  public async lookup(keyInput: DockerCustodyAttemptKey): Promise<DockerCustodyJournalRecord> {
    const key = validateDockerCustodyAttemptKey(keyInput);
    return this.exclusive(async () => {
      const file = await this.storage.open(dockerCustodyAttemptLocator(key));
      if (file === undefined) {throw new DockerCustodyJournalUnavailableError();}
      try {
        const replay = await this.replay(file);
        const first = replay.records[0];
        const last = replay.records.at(-1);
        if (replay.tail !== "complete" || first === undefined || last === undefined) {
          throw new DockerCustodyJournalCorruptionError();
        }
        if (!sameKey(first.attemptKey, key)) {
          throw new DockerCustodyJournalConflictError("attempt owner binding conflicts");
        }
        return last;
      } finally {await this.close(file);}
    });
  }

  private async append(input: {
    readonly authoritySha256?: string;
    readonly key: DockerCustodyAttemptKey;
    readonly expectedSequence: number;
    readonly state: DockerCustodyJournalState;
    readonly evidence: DockerCustodyJournalEvidence;
  }): Promise<DockerCustodyJournalRecord> {
    const key = validateDockerCustodyAttemptKey(input.key);
    return this.exclusive(async () => {
      const file = await this.storage.open(dockerCustodyAttemptLocator(key));
      if (file === undefined) {throw new DockerCustodyJournalConflictError("attempt is not prepared");}
      try {
        const replay = await this.replay(file);
        if (replay.tail !== "complete") {throw new DockerCustodyJournalCorruptionError();}
        const previous = replay.records.at(-1);
        if (previous === undefined || !sameKey(previous.attemptKey, key) || previous.sequence !== input.expectedSequence) {
          throw new DockerCustodyJournalConflictError();
        }
        const sequence = previous.sequence + 1;
        if (!isDockerCustodyJournalTransition(previous, input.state)) {
          throw new DockerCustodyJournalConflictError("journal transition is not the exact next monotone state");
        }
        if (DOCKER_CUSTODY_ACTION_STATES.includes(input.state as DockerCustodyActionState)) {
          const remaining = 1 + minimumRecordsAfterAction(input.state as DockerCustodyActionState);
          if (
            replay.records.length + remaining > this.limits.maxRecordsPerJournal ||
            file.byteLength + remaining * this.limits.maxRecordBytes > this.limits.maxJournalBytes
          ) {throw new DockerCustodyJournalCapacityError("capacity must be reserved before an external Docker action");}
        }
        if (sequence >= this.limits.maxRecordsPerJournal) {
          throw new DockerCustodyJournalCapacityError();
        }
        const authoritySha256 = input.state === "created"
          ? input.authoritySha256 ?? null
          : previous.authoritySha256;
        const record = createDockerCustodyRecord({
          attemptKey: key, sequence, state: input.state, evidence: input.evidence,
          authoritySha256,
          previousChecksumSha256: previous.checksumSha256,
        });
        if (input.state === "created" && record.authoritySha256 === null) {
          throw new DockerCustodyJournalConflictError("created observation requires exact container authority");
        }
        const bytes = encodeDockerCustodyRecord(record, this.limits);
        if (file.byteLength + bytes.byteLength > this.limits.maxJournalBytes) {
          throw new DockerCustodyJournalCorruptionError("reserved journal capacity was unavailable");
        }
        await file.append(file.byteLength, bytes);
        return record;
      } finally {await this.close(file);}
    });
  }

  public beforeAction(input: { readonly key: DockerCustodyAttemptKey; readonly expectedSequence: number; readonly state: DockerCustodyActionState }): Promise<DockerCustodyJournalRecord> {
    if (!DOCKER_CUSTODY_ACTION_STATES.includes(input.state)) {throw new TypeError("state is not an authority-bearing action request");}
    return this.append({ ...input, evidence: { status: "proved" } });
  }

  public observe(input: { readonly authoritySha256?: string; readonly key: DockerCustodyAttemptKey; readonly expectedSequence: number; readonly state: DockerCustodyObservationState; readonly evidence: DockerCustodyJournalEvidence }): Promise<DockerCustodyJournalRecord> {
    return this.append(input);
  }

  public async retire(input: {
    readonly expectedChecksumSha256: string;
    readonly key: DockerCustodyAttemptKey;
  }): Promise<void> {
    const key = validateDockerCustodyAttemptKey(input.key);
    return this.exclusive(async () => {
      const locator = dockerCustodyAttemptLocator(key);
      const expectedReceipt = createDockerCustodyRetirementReceipt({
        attemptKey: key,
        journalChecksumSha256: input.expectedChecksumSha256,
      });
      const retirement = await this.storage.openRetirement(locator);
      let retirementProved = false;
      if (retirement !== undefined) {
        try {
          const receipt = decodeDockerCustodyRetirementReceipt(
            await retirement.read(this.limits.maxRecordBytes),
            this.limits,
          );
          if (!sameKey(receipt.attemptKey, key) ||
              receipt.journalChecksumSha256 !== input.expectedChecksumSha256 ||
              receipt.receiptChecksumSha256 !== expectedReceipt.receiptChecksumSha256) {
            throw new DockerCustodyJournalConflictError("retirement receipt conflicts with the exact journal identity");
          }
          retirementProved = true;
        } finally {await this.close(retirement);}
      }
      const file = await this.storage.open(locator);
      if (file === undefined) {
        if (retirementProved) {return;}
        throw new DockerCustodyJournalUnavailableError("completed journal and retirement receipt are unavailable");
      }
      try {
        const replay = await this.replay(file);
        const last = replay.records.at(-1);
        if (replay.tail !== "complete" || last === undefined || !sameKey(last.attemptKey, key) ||
            last.state !== "closed" || last.checksumSha256 !== input.expectedChecksumSha256 ||
            hasUnresolvedDebt(replay.records)) {
          throw new DockerCustodyJournalConflictError("only exact debt-free closed journals can retire");
        }
      } finally {await this.close(file);}
      await this.storage.retire(locator, encodeDockerCustodyRetirementReceipt(expectedReceipt, this.limits));
    });
  }

  public async recover(): Promise<readonly DockerCustodyRecoveryObservation[]> {
    return this.exclusive(async () => {
      const scanned = await this.storage.scan(this.limits.maxJournalFiles);
      let totalBytes = 0;
      const observations: DockerCustodyRecoveryObservation[] = [];
      for (const entry of scanned) {
        try {
          const bytes = await entry.file.read(Math.min(this.limits.maxJournalBytes, this.limits.maxRestartScanBytes - totalBytes));
          totalBytes += bytes.byteLength;
          if (totalBytes > this.limits.maxRestartScanBytes) {throw new DockerCustodyJournalCapacityError("restart scan byte bound exceeded");}
          const replay = replayDockerCustodyBytes(bytes, this.limits);
          const last = replay.records.at(-1);
          if (replay.tail === "partial") {
            observations.push({
              kind: "unproven", locatorSha256: entry.locatorSha256, reason: "partial_tail",
              ...(last === undefined ? {} : { lastValidRecord: last }), providerExecution: "unknown",
            });
          } else if (last === undefined) {
            observations.push({ kind: "unproven", locatorSha256: entry.locatorSha256, reason: "empty_journal", providerExecution: "unknown" });
          } else {
            observations.push({
              kind: "replayed", attemptKey: last.attemptKey, state: last.state, sequence: last.sequence,
              evidence: last.evidence, hasDebt: hasUnresolvedDebt(replay.records),
              providerExecution: providerExecution(replay.records) as "not_requested" | "may_have_executed", tail: "complete",
            });
          }
        } catch (error) {
          if (!(error instanceof DockerCustodyJournalCorruptionError)) {throw error;}
          observations.push({ kind: "unproven", locatorSha256: entry.locatorSha256, reason: "corrupt_record", providerExecution: "unknown" });
        } finally {await this.close(entry.file);}
      }
      return Object.freeze(observations);
    });
  }
}
