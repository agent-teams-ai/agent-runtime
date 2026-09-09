import {retainLaunchWorkspace, type RetainedLaunchWorkspace} from "../adapters/outbound/filesystem/retained-launch-workspace.js";
import {retainedHostPrivateRootBinding, type HostPrivateRootOwner} from "./host-private-root-owner.js";
import {custodyDataRecord, createImmutableHostCustodyLaunchPlan, type ContainedTurnHostCustodyPort}
  from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {randomUUID, createHash} from "node:crypto";
import {HostCustodyUnsupportedError, type HostCustodyReservationInput} from "../adapters/outbound/host-custody/custodied-provider-process.js";
import {DockerKernelEvidence} from "./docker-kernel-evidence.js";

type Containment = Awaited<ReturnType<ContainedTurnHostCustodyPort["requestContainment"]>>;
export interface DockerKernelReservation {
  readonly input: HostCustodyReservationInput;
  readonly workspace: RetainedLaunchWorkspace;
  readonly custodyRef: string;
  readonly evidence: DockerKernelEvidence;
}
export interface DockerKernelReservationCleanup {
  cutoff(): void;
  /** Observe the retained cleanup flight; repeated calls must never repeat destructive effects. */
  cleanup(input: Readonly<{deadlineEpochMs: number}>): Promise<Readonly<{kind: "released" | "quarantined"}>>;
}
interface Retained extends DockerKernelReservation {
  cleanup?: DockerKernelReservationCleanup;
  root?: HostPrivateRootOwner;
  containment?: Promise<Containment>;
  receipt?: string;
  resourcesReleased: boolean;
  cutoffFailed?: boolean;
  containmentStarted?: boolean;
}

/** Raw Host port retains the accepted directory during reservation. Private
 * composition installs preparation cleanup before Docker allocation. */
export class DockerKernelHostCustody implements ContainedTurnHostCustodyPort {
  readonly #records = new Map<string, Retained>();
  #disposed = false;
  public constructor(private readonly cleanupMilliseconds: number) {
    if (!Number.isSafeInteger(cleanupMilliseconds) || cleanupMilliseconds <= 0) {throw new TypeError("Docker cleanup bound required");}
  }
  public async open(): ReturnType<ContainedTurnHostCustodyPort["open"]> {
    throw new HostCustodyUnsupportedError("launch-plan-unavailable");
  }
  public async reserve(value: HostCustodyReservationInput): ReturnType<ContainedTurnHostCustodyPort["reserve"]> {
    if (this.#disposed || this.#records.size >= 64) {throw new HostCustodyUnsupportedError("retention-capacity-exhausted");}
    value = custodyDataRecord(value);
    custodyDataRecord(value.workspaceAuthority); custodyDataRecord(value.workspaceAuthority.identity);
    custodyDataRecord(value.providerBinding);
    if (value.launchPlan.spawnMode !== "sdk-delegated" || value.launchPlan.containmentProfile !== "strict-linux-cgroup-v2") {
      throw new HostCustodyUnsupportedError("platform-profile-unavailable");
    }
    const input = Object.freeze({...value, launchPlan: createImmutableHostCustodyLaunchPlan(value.launchPlan),
      providerBinding: Object.freeze({...value.providerBinding}), workspaceAuthority: Object.freeze({...value.workspaceAuthority, descriptorPath: "",
        identity: Object.freeze({...value.workspaceAuthority.identity})})});
    const custodyRef = `docker-host-reservation:${randomUUID()}`;
    const evidence = new DockerKernelEvidence(input);
    const workspace = await retainLaunchWorkspace(value.workspaceAuthority, value.operationId, value.workspaceRef);
    if (this.#disposed || this.#records.size >= 64) {await workspace.close(); throw new HostCustodyUnsupportedError("retention-capacity-exhausted");}
    this.#records.set(custodyRef, {input, workspace, custodyRef, evidence, resourcesReleased: false});
    return Object.freeze({custodyRef});
  }
  public reservation(custodyRef: string): DockerKernelReservation {
    const record = this.#records.get(custodyRef);
    if (record === undefined) {throw new TypeError("Docker reservation unavailable");}
    return Object.freeze({input: record.input, workspace: record.workspace, custodyRef, evidence: record.evidence});
  }
  public installCleanup(custodyRef: string, cleanup: DockerKernelReservationCleanup): void {
    const record = this.#records.get(custodyRef);
    if (this.#disposed || record === undefined || record.cleanup !== undefined || record.containmentStarted) {
      throw new TypeError("Docker cleanup ownership cannot be replaced");
    }
    record.cleanup = Object.freeze({cutoff: cleanup.cutoff.bind(cleanup), cleanup: cleanup.cleanup.bind(cleanup)});
  }
  public installPrivateRoot(custodyRef: string, root: HostPrivateRootOwner): void {
    const record = this.#records.get(custodyRef);
    retainedHostPrivateRootBinding(root);
    if (this.#disposed || record === undefined || record.cleanup === undefined || record.root !== undefined || record.containmentStarted) {
      throw new TypeError("Docker private root cannot be replaced");
    }
    record.evidence.attachPrivateRoot(root);
    record.root = root;
  }
  public evidence(custodyRef: string) {return this.#records.get(custodyRef)?.evidence.snapshot();}
  private match(input: Parameters<ContainedTurnHostCustodyPort["requestContainment"]>[0]): Retained | undefined {
    const record = input.custodyRef === undefined ? undefined : this.#records.get(input.custodyRef);
    return record?.input.operationId === input.operationId && record.input.attemptId === input.attemptId ? record : undefined;
  }
  private unproven(custodyRef: string): Extract<Containment, {kind: "unproven"}> {
    return Object.freeze({kind: "unproven", evidenceRef: `urn:agent-runtime:docker-custody-unproven:${createHash("sha256").update(custodyRef).digest("hex")}`});
  }
  public requestContainment(input: Parameters<ContainedTurnHostCustodyPort["requestContainment"]>[0]): Promise<Containment> {
    const record = this.match(input);
    if (record === undefined) {return Promise.resolve(this.unproven(input.custodyRef ?? "missing"));}
    // Share each observation; the preparation owner retains the single destructive
    // cleanup flight across bounded observations. A timeout is not its result.
    if (record.containment !== undefined) {return record.containment;}
    const first = !record.containmentStarted;
    record.containmentStarted = true;
    record.containment = Promise.resolve().then(async () => {
      try {
        if (record.cleanup === undefined) {
          // Preparation installs cleanup before acquiring physical resources. The
          // synchronous containmentStarted fence prevents any later installation.
          // Retire only this unstarted reservation's descriptor, joining its reads;
          // descriptor closure is not evidence of physical containment or release.
          await record.workspace.close();
          return this.unproven(record.custodyRef);
        }
        if (!record.resourcesReleased) {
          const result = await record.cleanup?.cleanup({deadlineEpochMs: Date.now() + this.cleanupMilliseconds});
          record.resourcesReleased = result?.kind === "released";
        }
        if (record.resourcesReleased && record.root !== undefined) {
          await record.root.quarantineAndDelete({deadlineEpochMs: Date.now() + this.cleanupMilliseconds});
        }
        const evidence = record.evidence.snapshot();
        if (record.cutoffFailed || !record.resourcesReleased || !evidence.sealed || evidence.closure.status !== "closed" ||
          record.root !== undefined && evidence.privateRoot.status !== "deleted") {return this.unproven(record.custodyRef);}
        await record.workspace.close();
        record.receipt = `urn:agent-runtime:docker-containment:${createHash("sha256")
          .update(JSON.stringify([record.custodyRef, record.input.operationId, record.input.attemptId, evidence])).digest("hex")}`;
        return Object.freeze({kind: "contained" as const, receiptRef: record.receipt});
      } catch {return this.unproven(record.custodyRef);}
    }).finally(() => {
      // Keep proved receipts stable; uncertain observations may join late work.
      if (record.receipt === undefined) {delete record.containment;}
    });
    if (first) {try {record.cleanup?.cutoff();} catch {record.cutoffFailed = true;}}
    return record.containment;
  }
  public async release(input: Parameters<ContainedTurnHostCustodyPort["release"]>[0]): ReturnType<ContainedTurnHostCustodyPort["release"]> {
    const record = this.match(input);
    if (record === undefined || record.receipt !== input.receiptRef || !record.resourcesReleased ||
        record.evidence.snapshot().privateRoot.status !== "deleted") {
      return this.unproven(input.custodyRef ?? "missing");
    }
    this.#records.delete(record.custodyRef);
    return Object.freeze({kind: "released"});
  }
  public dispose(): void {
    this.#disposed = true;
    for (const record of this.#records.values()) {
      try {record.cleanup?.cutoff();} catch { /* Keep cleanup debt. */ }
      void this.requestContainment({custodyRef: record.custodyRef, operationId: record.input.operationId, attemptId: record.input.attemptId});
    }
  }
}
