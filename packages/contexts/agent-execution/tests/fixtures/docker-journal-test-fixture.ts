import {
  DockerCustodyJournal,
  DockerCustodyJournalConflictError,
  type DockerCustodyAttemptKey,
  type DockerCustodyJournalFile,
  type DockerCustodyJournalStorage,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

export const fingerprint = "a".repeat(64);
export const authoritySha256 = "9".repeat(64);
export const key = Object.freeze({
  daemonBootGenerationSha256: "b".repeat(64),
  daemonIdentitySha256: "c".repeat(64),
  hostBootGenerationSha256: "d".repeat(64),
  hostIdentitySha256: "e".repeat(64),
  tenantId: "tenant-1",
  projectId: "project-1",
  operationId: "operation:1",
  attemptId: "attempt:1",
  custodyId: "custody:1",
  hostInstanceId: "host:1",
  hostBootId: "boot:1",
  launchFingerprintSha256: fingerprint,
  operationNonceSha256: "f".repeat(64),
}) satisfies DockerCustodyAttemptKey;

export class MemoryFile implements DockerCustodyJournalFile {
  public bytes = Buffer.alloc(0);
  public syncs = 0;
  public get byteLength(): number {return this.bytes.byteLength;}
  public async append(expectedByteLength: number, bytes: Uint8Array): Promise<void> {
    if (expectedByteLength !== this.bytes.byteLength) {throw new DockerCustodyJournalConflictError();}
    this.bytes = Buffer.concat([this.bytes, bytes]);
    this.syncs += 1;
  }
  public async read(maxBytes: number): Promise<Uint8Array> {
    if (this.bytes.byteLength > maxBytes) {throw new Error("bounded read exceeded");}
    return this.bytes;
  }
  public async close(): Promise<void> {}
}

export class MemoryStorage implements DockerCustodyJournalStorage {
  public readonly files = new Map<string, MemoryFile>();
  public readonly retirements = new Map<string, MemoryFile>();
  private serial = Promise.resolve();
  public async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>(resolve => {release = resolve;});
    await previous;
    try {return await operation();} finally {release();}
  }
  public async create(locator: string): Promise<DockerCustodyJournalFile> {
    if (this.files.has(locator)) {throw new DockerCustodyJournalConflictError();}
    const file = new MemoryFile();
    this.files.set(locator, file);
    return file;
  }
  public async open(locator: string): Promise<DockerCustodyJournalFile | undefined> {return this.files.get(locator);}
  public async openRetirement(locator: string): Promise<DockerCustodyJournalFile | undefined> {
    return this.retirements.get(locator);
  }
  public async retire(locator: string, receipt: Uint8Array): Promise<void> {
    const existing = this.retirements.get(locator);
    if (existing !== undefined && !existing.bytes.equals(Buffer.from(receipt))) {
      throw new DockerCustodyJournalConflictError("retirement receipt conflicts");
    }
    if (existing === undefined) {
      const durable = new MemoryFile();
      await durable.append(0, receipt);
      this.retirements.set(locator, durable);
    }
    if (!this.files.delete(locator)) {throw new DockerCustodyJournalConflictError("journal is unavailable");}
  }
  public async scan(maxFiles: number) {
    if (this.files.size > maxFiles) {throw new Error("bounded scan exceeded");}
    return [...this.files].map(([locatorSha256, file]) => ({ locatorSha256, file }));
  }
}

export const advance = async (
  journal: DockerCustodyJournal,
  attemptKey: DockerCustodyAttemptKey = key,
  providerExecutionProved = false,
): Promise<Awaited<ReturnType<DockerCustodyJournal["observe"]>>> => {
  await journal.prepare(attemptKey);
  await journal.beforeAction({ key: attemptKey, expectedSequence: 0, state: "create_requested" });
  await journal.observe({ authoritySha256, key: attemptKey, expectedSequence: 1, state: "created", evidence: { status: "proved" } });
  await journal.beforeAction({ key: attemptKey, expectedSequence: 2, state: "init_start_requested" });
  await journal.observe({ key: attemptKey, expectedSequence: 3, state: "init_ready", evidence: { status: "proved" } });
  await journal.beforeAction({ key: attemptKey, expectedSequence: 4, state: "provider_exec_requested" });
  await journal.observe({
    key: attemptKey, expectedSequence: 5, state: "provider_exec_observed",
    evidence: providerExecutionProved
      ? { status: "proved" }
      : { status: "unproven", reason: "provider_execution_unproven" },
  });
  await journal.beforeAction({ key: attemptKey, expectedSequence: 6, state: "contain_requested" });
  await journal.observe({ key: attemptKey, expectedSequence: 7, state: "empty_observed", evidence: { status: "proved" } });
  await journal.beforeAction({ key: attemptKey, expectedSequence: 8, state: "remove_requested" });
  await journal.observe({ key: attemptKey, expectedSequence: 9, state: "removed_observed", evidence: { status: "proved" } });
  return journal.observe({ key: attemptKey, expectedSequence: 10, state: "closed", evidence: { status: "proved" } });
};
