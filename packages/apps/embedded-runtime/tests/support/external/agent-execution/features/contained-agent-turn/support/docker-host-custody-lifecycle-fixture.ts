import {createHash} from "node:crypto";
import {mkdir, mkdtemp, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {DockerHostCustodyContainerCreate} from "@agent-teams/agent-execution/composition";
import type {DockerEngineCall, DockerEnginePolicy} from "@agent-teams/agent-execution/composition";
import {DockerCustodyJournalConflictError, type DockerCustodyJournalFile, type DockerCustodyJournalStorage,
  type DockerCustodyOwnerIdentity} from "@agent-teams/agent-execution/composition";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const FINGERPRINT = digest("launch");
const NONCE = digest("operation");
const IMAGE = `registry.invalid/runtime@sha256:${digest("image")}`;
const SECCOMP_JSON = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });

export class MemoryFile implements DockerCustodyJournalFile {
  public bytes = Buffer.alloc(0);
  public get byteLength(): number {return this.bytes.byteLength;}
  public async append(expectedByteLength: number, bytes: Uint8Array): Promise<void> {
    if (this.byteLength !== expectedByteLength) {throw new DockerCustodyJournalConflictError();}
    this.bytes = Buffer.concat([this.bytes, bytes]);
  }
  public async close(): Promise<void> {}
  public async read(maxBytes: number): Promise<Uint8Array> {
    if (this.byteLength > maxBytes) {throw new Error("bounded journal read exceeded");}
    return this.bytes;
  }
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
  public async open(locator: string): Promise<DockerCustodyJournalFile | undefined> {
    return this.files.get(locator);
  }
  public async openRetirement(locator: string): Promise<DockerCustodyJournalFile | undefined> {
    return this.retirements.get(locator);
  }
  public async retire(locator: string, receipt: Uint8Array): Promise<void> {
    const existing = this.retirements.get(locator);
    if (existing !== undefined && !existing.bytes.equals(Buffer.from(receipt))) {
      throw new DockerCustodyJournalConflictError();
    }
    if (existing === undefined) {
      const durable = new MemoryFile();
      await durable.append(0, receipt);
      this.retirements.set(locator, durable);
    }
    if (!this.files.delete(locator)) {throw new DockerCustodyJournalConflictError();}
  }
  public async scan(maxFiles: number) {
    if (this.files.size > maxFiles) {throw new Error("bounded journal scan exceeded");}
    return [...this.files].map(([locatorSha256, file]) => ({ file, locatorSha256 }));
  }
}

export const engineCall = (): DockerEngineCall => ({
  deadlineEpochMs: Date.now() + 5_000,
  signal: new AbortController().signal,
});

export const policy = (root: string): DockerEnginePolicy => ({
  allowedEnvironmentKeys: ["AR_OPERATION"],
  allowedNetworkName: "ar-operation-gateway",
  appArmorProfile: "agent-runtime-contained-turn-v1",
  cgroupParent: "system.slice/agent-runtime.slice",
  cpuNanoCpus: 500_000_000,
  daemonPidFileMode: 0o600,
  daemonPidFileOwnerGid: process.getgid?.() ?? 0,
  daemonPidFileOwnerUid: process.getuid?.() ?? 0,
  daemonPidFilePath: join(root, "docker.pid"),
  hostIdentitySha256: digest("host"),
  memoryBytes: 100_663_296,
  pidsLimit: 32,
  privateRootSourceRoot: join(root, "private"),
  seccompProfileJson: SECCOMP_JSON,
  seccompProfileSha256: digest(SECCOMP_JSON),
  socketMode: 0o600,
  socketOwnerGid: process.getgid?.() ?? 0,
  socketOwnerUid: process.getuid?.() ?? 0,
  socketPath: join(root, "docker.sock"),
  tmpfsBytes: 16_777_216,
  user: "65532:65532",
  workspaceSourceRoot: join(root, "workspaces"),
  writableLayerBytes: 33_554_432,
});

export const createInput = (root: string, nonce = NONCE): DockerHostCustodyContainerCreate => ({
  arguments: ["serve", "--stdio"],
  entrypoint: "/usr/local/bin/provider",
  environment: { AR_OPERATION: "opaque-operation" },
  imageDigest: IMAGE,
  launchFingerprintSha256: FINGERPRINT,
  operationNonceSha256: nonce,
  privateRootSource: join(root, "private", "operation"),
  workspaceSource: join(root, "workspaces", "operation"),
  workspaceWritable: true,
});

export const owner = Object.freeze({
  attemptId: "attempt:docker-composition",
  custodyId: "custody:docker-composition",
  hostBootId: "host-boot:docker-composition",
  hostInstanceId: "host-instance:docker-composition",
  operationId: "operation:docker-composition",
  projectId: "project:docker-composition",
  tenantId: "tenant:docker-composition",
}) satisfies DockerCustodyOwnerIdentity;

export const disposable = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar-docker-custody-composition-")));
  await Promise.all([
    mkdir(join(root, "private", "operation"), { recursive: true }),
    mkdir(join(root, "workspaces", "operation"), { recursive: true }),
  ]);
  return root;
};
