import type { StableFilesystemHandle } from "@agent-teams/filesystem-custody/composition";
import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { publishStableDirectoryNoReplace } from "@agent-teams/filesystem-custody/composition";
import {
  assertDisjointNonAncestorRoots, bindContainedTurnRoot, descriptorChildPath,
  fsyncDirectoryHandle, inspectFileHandle, openBoundDirectory, openDirectoryEntry,
  sameFilesystemIdentity,
  type BoundContainedTurnRoot,
} from "./contained-turn-filesystem-custody.js";
import { readDirectoryNamesBounded } from "./contained-turn-filesystem-reads.js";
import type { HostCustodyPrivateRootClosureEvidence } from "../host-custody/custodied-provider-process.js";
import {
  assertPrivateRootAbsent, assertPrivateRootEntry, assertPrivateRootHandle,
  privateRootDirectoryIdentity, traversePrivateRoot, type PrivateRootTraversal,
} from "./host-private-root-filesystem.js";

export interface HostPrivateRootBinding {
  readonly canonicalBindSourcePath: string;
  readonly identity: BoundContainedTurnRoot["identity"];
  readonly parentIdentity: BoundContainedTurnRoot["identity"];
  readonly parentUid: bigint;
  readonly uid: bigint;
  readonly canonicalWorkspacePath: string;
  readonly workspaceIdentity: BoundContainedTurnRoot["identity"];
  readonly operationId: string;
  readonly attemptId: string;
  readonly custodyRef: string;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  readonly physicalHostBootId: string;
  readonly hostLifecycleGenerationSha256: string;
}

export interface HostPrivateRootReadback {
  readonly evidence: HostCustodyPrivateRootClosureEvidence;
  readonly history: readonly string[];
  readonly debt: boolean;
  readonly retainedHandles: number;
}

export interface HostPrivateRootOwner {
  /** Effectful, one shared capture. Must settle before any Docker create. */
  capture(): Promise<HostPrivateRootBinding>;
  revalidate(): Promise<HostPrivateRootBinding>;
  snapshot(): HostPrivateRootReadback;
  /** Private Host capability; never give this to a provider or ordinary caller. */
  quarantineAndDelete(input: Readonly<{ deadlineEpochMs: number }>): Promise<HostPrivateRootReadback>;
}

export interface PrivateRootOwnerOptions {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly custodyRef: string;
  readonly maximumEntries: number;
  readonly maximumDepth: number;
  readonly maximumMilliseconds: number;
  readonly hostInstanceId: string;
  readonly hostBootId: string;
  /** Retained factory generation, shared across this Host's reservations. */
  generation(): string;
  /** Bound by trusted composition to the existing preparation cleanup owner.
   * Resolves only after physical containment AND private consumers settle. */
  awaitQuiescence(input: Readonly<{ deadlineEpochMs: number }>): Promise<void>;
}

interface Capture {
  readonly root: BoundContainedTurnRoot;
  readonly parent: BoundContainedTurnRoot;
  readonly workspace: BoundContainedTurnRoot;
  readonly rootHandle: StableFilesystemHandle;
  readonly parentHandle: StableFilesystemHandle;
  readonly workspaceHandle: StableFilesystemHandle;
  readonly binding: HostPrivateRootBinding;
}

const hash = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)).digest("hex");

/** Concrete Linux descriptor custody, deliberately independent of Docker and
 * Node LiveCustody. The constructor acquires no filesystem resources. */
export class NodeHostPrivateRootOwner implements HostPrivateRootOwner {
  readonly #handles = new Map<StableFilesystemHandle, Promise<void> | undefined>();
  readonly #history: string[] = [];
  #status: HostCustodyPrivateRootClosureEvidence["status"] = "unproven";
  #identity = "";
  #debt = false;
  #capture: Promise<HostPrivateRootBinding> | undefined;
  #retained: Capture | undefined;
  #cleanup: Promise<HostPrivateRootReadback> | undefined;
  #reads: Promise<unknown> = Promise.resolve();
  #closing = false;
  #deadline = Infinity;

  public constructor(private readonly options: PrivateRootOwnerOptions) {}

  public snapshot(): HostPrivateRootReadback {
    return Object.freeze({ evidence: Object.freeze({ identitySha256: this.#identity, status: this.#status }),
      history: Object.freeze([...this.#history]), debt: this.#debt, retainedHandles: this.#handles.size });
  }

  private retain = <Handle extends StableFilesystemHandle>(handle: Handle): Handle => {this.#handles.set(handle, undefined); return handle;};
  private close = async (handle: StableFilesystemHandle): Promise<void> => {
    // A rejected close is retained and never attempted again: its FD may have
    // been released and reused even though the acknowledgement failed.
    let closing = this.#handles.get(handle);
    if (!this.#handles.has(handle)) {return;}
    if (closing === undefined) {
      closing = Promise.resolve().then(() => handle.close());
      this.#handles.set(handle, closing);
    }
    await closing;
    this.#handles.delete(handle);
  };
  private check = (): void => {
    if (performance.now() >= this.#deadline) {throw new Error("Private root deadline exceeded");}
  };
  private budget(forbiddenDirectoryIdentities: ReadonlySet<string> = new Set(), directoryIdentities = new Set<string>()): PrivateRootTraversal {
    return { remaining: this.options.maximumEntries, maximumDepth: this.options.maximumDepth,
      forbiddenDirectoryIdentities, directoryIdentities,
      check: this.check, retain: this.retain, close: this.close };
  }

  private async validateSeparation(
    parent: BoundContainedTurnRoot, rootHandle: StableFilesystemHandle, workspaceHandle: StableFilesystemHandle,
  ): Promise<ReadonlySet<string>> {
    const parentIdentity = privateRootDirectoryIdentity(parent.identity);
    const workspaceIdentities = new Set([privateRootDirectoryIdentity(await inspectFileHandle(workspaceHandle))]);
    const protectedIdentities = new Set([parentIdentity]);
    // Collect only the private subtree, never the parent's siblings. A workspace
    // sibling under the protected parent remains supported. Check every visited
    // directory so aliases of nested private/workspace directories also fail.
    await traversePrivateRoot(rootHandle, this.budget(new Set([parentIdentity, ...workspaceIdentities]), protectedIdentities));
    await traversePrivateRoot(workspaceHandle, this.budget(protectedIdentities, workspaceIdentities));
    workspaceIdentities.add(parentIdentity);
    return workspaceIdentities;
  }

  private async bootIdentity(): Promise<string> {
    const fd = this.retain(await open("/proc/sys/kernel/random/boot_id", constants.O_RDONLY | constants.O_NOFOLLOW));
    try {
      // procfs reports size zero; use a bounded direct read, never readFile.
      const buffer = Buffer.alloc(65);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const value = buffer.subarray(0, bytesRead).toString("ascii").trim();
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) {throw new Error("Host boot unavailable");}
      return value;
    } finally {await this.close(fd);}
  }

  public capture(): Promise<HostPrivateRootBinding> {
    if (this.#capture !== undefined) {return this.#capture;}
    if (this.#closing) {return Promise.reject(new Error("Private root capture closed"));}
    this.#deadline = performance.now() + this.options.maximumMilliseconds;
    this.#capture = Promise.resolve().then(() => this.captureDirectories()).catch(async error => {
      this.fail("capture-unproven");
      await this.closeAll();
      throw error;
    });
    return this.#capture;
  }

  private async captureDirectories(): Promise<HostPrivateRootBinding> {
    if (process.platform !== "linux") {throw new Error("Strict private root descriptor proof unsupported outside Linux");}
    const parent = await bindContainedTurnRoot(dirname(this.options.rootPath), { private: true });
    const parentHandle = this.retain(await openBoundDirectory(parent));
    const root = await bindContainedTurnRoot(this.options.rootPath, { private: true });
    const rootHandle = this.retain(await openDirectoryEntry(parentHandle, basename(root.canonicalPath)));
    const workspace = await bindContainedTurnRoot(this.options.workspacePath);
    const workspaceHandle = this.retain(await openBoundDirectory(workspace));
    assertDisjointNonAncestorRoots(root, workspace);
    // The retained parent is outside the provider workspace mount. It is also
    // necessarily outside its direct private-root child mount.
    if (sameFilesystemIdentity(parent.identity, workspace.identity) ||
        parent.canonicalPath === workspace.canonicalPath ||
        parent.canonicalPath.startsWith(`${workspace.canonicalPath}${sep}`)) {
      throw new Error("Private root containing parent is exposed by the workspace mount");
    }
    await assertPrivateRootHandle(parentHandle, parent);
    await assertPrivateRootHandle(rootHandle, root);
    await this.validateSeparation(parent, rootHandle, workspaceHandle);
    const physicalHostBootId = await this.bootIdentity();
    const generation = this.options.generation();
    const binding: HostPrivateRootBinding = Object.freeze({ canonicalBindSourcePath: root.canonicalPath,
      identity: root.identity, parentIdentity: parent.identity, uid: (await inspectFileHandle(rootHandle)).uid,
      parentUid: (await inspectFileHandle(parentHandle)).uid,
      canonicalWorkspacePath: workspace.canonicalPath, workspaceIdentity: workspace.identity,
      operationId: this.options.operationId, attemptId: this.options.attemptId, custodyRef: this.options.custodyRef,
      hostInstanceId: this.options.hostInstanceId, hostBootId: this.options.hostBootId, physicalHostBootId,
      hostLifecycleGenerationSha256: hash([this.options.hostInstanceId, this.options.hostBootId, physicalHostBootId, generation]) });
    this.#retained = { parent, root, workspace, parentHandle, rootHandle, workspaceHandle, binding };
    await this.validateDirectories();
    this.#identity = hash(binding);
    this.#status = "active";
    this.#history.push("captured");
    return binding;
  }

  private async validateDirectories(): Promise<HostPrivateRootBinding> {
    const retained = this.#retained;
    if (retained === undefined || this.#debt) {throw new Error("Private root capture unavailable");}
    const { parent, root, workspace, parentHandle, rootHandle } = retained;
    this.check();
    // Reopen the whole canonical lineage with existing no-follow custody tools.
    for (const bound of [parent, root, workspace]) {await this.close(this.retain(await openBoundDirectory(bound)));}
    if (await realpath(descriptorChildPath(parentHandle)) !== parent.canonicalPath ||
        await realpath(descriptorChildPath(rootHandle)) !== root.canonicalPath) {throw new Error("Private root lineage replaced");}
    await assertPrivateRootHandle(parentHandle, parent);
    await assertPrivateRootHandle(rootHandle, root);
    await assertPrivateRootEntry(parentHandle, basename(root.canonicalPath), root, this.budget());
    await this.validateSeparation(parent, rootHandle, retained.workspaceHandle);
    this.check();
    return retained.binding;
  }

  public revalidate(): Promise<HostPrivateRootBinding> {
    if (this.#closing || this.#status !== "active") {return Promise.reject(new Error("Private root readback closed"));}
    const read = this.#reads.then(async () => {
      this.#deadline = performance.now() + this.options.maximumMilliseconds;
      try {return await this.validateDirectories();} catch (error) {this.fail("revalidation-unproven"); throw error;}
    });
    this.#reads = read.catch(() => {});
    return read;
  }

  private fail(stage: string): void {
    this.#status = "unproven"; this.#debt = true; this.#history.push(stage);
  }

  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#handles.keys()].map(handle => this.close(handle)));
    if (results.some(result => result.status === "rejected")) {this.fail("descriptor-release-unproven");}
  }

  public quarantineAndDelete(input: Readonly<{ deadlineEpochMs: number }>): Promise<HostPrivateRootReadback> {
    if (this.#cleanup !== undefined) {return this.#cleanup;}
    if (!Number.isSafeInteger(input.deadlineEpochMs)) {return Promise.reject(new TypeError("Private root cleanup deadline invalid"));}
    this.#closing = true;
    const deadline = Math.min(this.options.maximumMilliseconds, input.deadlineEpochMs - Date.now());
    const monotonicDeadline = performance.now() + Math.max(0, deadline);
    const work = Promise.resolve().then(async () => {
      try {
        await this.#capture;
        await this.#reads;
        this.#deadline = monotonicDeadline;
        this.check();
        if (this.#debt || this.#retained === undefined) {throw new Error("Private root is not captured");}
        await this.options.awaitQuiescence(Object.freeze({ deadlineEpochMs: input.deadlineEpochMs }));
        this.check();
        this.#history.push("private-owner-quiescence");
        await this.validateDirectories();
        await this.removeCapturedRoot();
        // Seal the descriptor observations before relinquishing their authority.
        this.#history.push("deletion-observations-sealed");
        await this.closeAll();
        this.check();
        if (this.#debt || this.#handles.size !== 0) {throw new Error("Private root descriptor release unproven");}
        this.#status = "deleted";
        this.#history.push("deleted");
      } catch {this.fail("cleanup-unproven");}
      return this.snapshot();
    });
    this.#cleanup = this.observeCleanup(work, Math.max(0, deadline));
    return this.#cleanup;
  }

  private observeCleanup(work: Promise<HostPrivateRootReadback>, milliseconds: number): Promise<HostPrivateRootReadback> {
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<HostPrivateRootReadback>(resolve => {
      timer = setTimeout(() => {
        this.fail("cleanup-observation-timeout");
        resolve(this.snapshot());
      }, milliseconds);
    });
    // The operation and all capabilities remain retained after a bounded wait.
    // Late continuations check the same deadline/debt before another mutation.
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
  }

  private async removeCapturedRoot(): Promise<void> {
    const { parent, root, workspace, parentHandle, rootHandle, workspaceHandle } = this.#retained!;
    const sourceName = basename(root.canonicalPath);
    const quarantineName = `.ar-private-root-${randomUUID()}`;
    // Retain the exact attempted name even when the native acknowledgement fails.
    this.#history.push(`quarantine-attempt:${quarantineName}`);
    const published = await publishStableDirectoryNoReplace({ sourceDirectory: parentHandle, sourceName,
      destinationDirectory: parentHandle, destinationName: quarantineName, expectedSourceIdentity: root.identity });
    this.check();
    if (published !== "created") {throw new Error("Private root quarantine collision");}
    await assertPrivateRootEntry(parentHandle, quarantineName, root, this.budget());
    await assertPrivateRootAbsent(parentHandle, sourceName);
    await fsyncDirectoryHandle(parentHandle);
    this.#status = "quarantined";
    this.#history.push("quarantine-identity-readback");
    // Quarantine publication and its readbacks are asynchronous. Refresh the
    // separation proof before deleting, and carry it into each directory open.
    await this.close(this.retain(await openBoundDirectory(workspace)));
    const forbidden = await this.validateSeparation(parent, rootHandle, workspaceHandle);
    await traversePrivateRoot(rootHandle, this.budget(forbidden), { depth: 0, remove: true });
    await assertPrivateRootHandle(parentHandle, parent);
    await assertPrivateRootEntry(parentHandle, quarantineName, root, this.budget());
    if ((await readDirectoryNamesBounded(rootHandle, 0)).length !== 0) {throw new Error("Private root not empty");}
    this.check();
    this.#history.push("exact-entry-remove-attempt");
    await rmdir(descriptorChildPath(parentHandle, quarantineName));
    this.check();
    await assertPrivateRootAbsent(parentHandle, quarantineName);
    await assertPrivateRootAbsent(parentHandle, sourceName);
    if ((await inspectFileHandle(rootHandle)).nlink !== 0n) {throw new Error("Held private root is not unlinked");}
    if ((await readDirectoryNamesBounded(rootHandle, 0)).length !== 0) {throw new Error("Held private root is not empty");}
    await fsyncDirectoryHandle(rootHandle);
    await fsyncDirectoryHandle(parentHandle);
    this.check();
  }
}
