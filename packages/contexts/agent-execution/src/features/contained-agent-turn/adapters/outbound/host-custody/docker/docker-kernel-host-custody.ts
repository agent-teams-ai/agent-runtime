import {custodyDataRecord} from "../host-custody-inert-record.js";
import {randomUUID, createHash} from "node:crypto";
import type {ContainedTurnHostCustodyPort} from "../contained-turn-kernel-custody-contracts.js";
import {HostCustodyUnsupportedError, type HostCustodyReservationInput} from "../custodied-provider-process.js";
import {createImmutableHostCustodyLaunchPlan} from "../host-custody-launch-plan-snapshot.js";
import {DockerKernelEvidence} from "./docker-kernel-evidence.js";

type Containment = Awaited<ReturnType<ContainedTurnHostCustodyPort["requestContainment"]>>;
export interface DockerKernelReservation {
  readonly input: HostCustodyReservationInput;
  readonly custodyRef: string;
  readonly evidence: DockerKernelEvidence;
}
export interface DockerKernelReservationCleanup {
  cutoff(): void;
  cleanup(input: Readonly<{deadlineEpochMs: number}>): Promise<Readonly<{kind: "released" | "quarantined"}>>;
}
interface Retained extends DockerKernelReservation {
  cleanup?: DockerKernelReservationCleanup;
  containment?: Promise<Containment>;
  receipt?: string;
  resourcesReleased: boolean;
}

/** Raw Host port, inert reservations only. Private composition installs the
 * actual preparation cleanup before it can allocate any external resource. */
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
      providerBinding: Object.freeze({...value.providerBinding}), workspaceAuthority: Object.freeze({...value.workspaceAuthority,
        identity: Object.freeze({...value.workspaceAuthority.identity})})});
    const custodyRef = `docker-host-reservation:${randomUUID()}`;
    this.#records.set(custodyRef, {input, custodyRef, evidence: new DockerKernelEvidence(input), resourcesReleased: false});
    return Object.freeze({custodyRef});
  }
  public reservation(custodyRef: string): DockerKernelReservation {
    const record = this.#records.get(custodyRef);
    if (record === undefined) {throw new TypeError("Docker reservation unavailable");}
    return Object.freeze({input: record.input, custodyRef, evidence: record.evidence});
  }
  public installCleanup(custodyRef: string, cleanup: DockerKernelReservationCleanup): void {
    const record = this.#records.get(custodyRef);
    if (this.#disposed || record === undefined || record.cleanup !== undefined || record.containment !== undefined) {
      throw new TypeError("Docker cleanup ownership cannot be replaced");
    }
    record.cleanup = Object.freeze({cutoff: cleanup.cutoff.bind(cleanup), cleanup: cleanup.cleanup.bind(cleanup)});
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
    // Publish before any external callbacks. Uncertainty never resets this flight.
    if (record.containment !== undefined) {return record.containment;}
    let cutoffFailed = false;
    record.containment = Promise.resolve().then(async () => {
      try {
        const result = await record.cleanup?.cleanup({deadlineEpochMs: Date.now() + this.cleanupMilliseconds});
        record.resourcesReleased = result?.kind === "released";
        const evidence = record.evidence.snapshot();
        if (cutoffFailed || !record.resourcesReleased || !evidence.sealed || evidence.closure.status !== "closed") {return this.unproven(record.custodyRef);}
        record.receipt = `urn:agent-runtime:docker-containment:${createHash("sha256")
          .update(JSON.stringify([record.custodyRef, record.input.operationId, record.input.attemptId, evidence])).digest("hex")}`;
        return Object.freeze({kind: "contained" as const, receiptRef: record.receipt});
      } catch {return this.unproven(record.custodyRef);}
    });
    try {record.cleanup?.cutoff();} catch {cutoffFailed = true;}
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
