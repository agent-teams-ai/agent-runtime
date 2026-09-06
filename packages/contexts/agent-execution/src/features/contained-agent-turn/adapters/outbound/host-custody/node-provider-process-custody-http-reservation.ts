import { addAbortListener } from "node:events";
import { types } from "node:util";
import {
  validateCommittedDispatchProofV1,
  type CommittedDispatchProofV1,
} from "../../../domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnHostPostClaimPreparation } from "./contained-turn-kernel-custody-contracts.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

const nativeRemove = EventTarget.prototype.removeEventListener;

type Handoff = Parameters<ContainedTurnHostPostClaimPreparation["prepareClaimed"]>[0];

/** Private identity of a reserved execution session, never evidence of a PID or start. */
declare const executionSession: unique symbol;
export type NodeCustodyExecutionSessionIdentity = Readonly<{ [executionSession]: true }>;
export interface NodeCustodyHttpLifetime {
  readonly executionSessionIdentity: NodeCustodyExecutionSessionIdentity;
  readonly committedDispatchProof: CommittedDispatchProofV1;
  readonly underlyingCustodyRef: string;
  readonly hostLifecycleGenerationSha256: string;
  readonly signal: AbortSignal;
}

/** Only trusted Host wiring inside the actual kernel prepareClaimed may call acquire.
 * This is no claim issuer: possession of a structural proof/digest is insufficient
 * authority to call it. COMMIT acknowledgement remains with the trusted operation
 * owner; the kernel binds custodyId, hostBootId, hostInstanceId and the remaining
 * kernel proof fields before invoking prepareClaimed.
 */
export interface NodeCustodyHttpPreparation {
  acquire(input: Handoff): NodeCustodyHttpLifetime;
}

/** Snapshot data without executing proxy traps, accessors or inherited properties. */
export const custodyDataRecord = <Value extends object>(value: Value): Value => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    throw new TypeError("Host Custody requires an inert data record");
  }
  const result = Object.create(null) as Value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {throw new TypeError("Host Custody accessors are unavailable");}
    Object.defineProperty(result, key, descriptor);
  }
  return Object.freeze(result);
};

export const readNodeCustodyHttpHandoff = (input: Handoff): Handoff => {
  const record = custodyDataRecord(input);
  if (Reflect.ownKeys(record).length !== 3 || typeof record.underlyingCustodyRef !== "string" ||
      record.underlyingCustodyRef.length === 0) {
    throw new TypeError("Host Custody HTTP preparation handoff is unavailable");
  }
  const proof = custodyDataRecord(record.committedDispatchProof);
  // Every proof field is scalar; reject nested executable values before validation.
  for (const key of Reflect.ownKeys(proof)) {
    const value: unknown = Object.getOwnPropertyDescriptor(proof, key)!.value;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new TypeError("Host Custody HTTP preparation proof is unavailable");
    }
  }
  const signal = record.signal;
  if (signal === null || typeof signal !== "object" || types.isProxy(signal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
      Reflect.ownKeys(signal).some(key => typeof key === "string" ||
        !("value" in Object.getOwnPropertyDescriptor(signal, key)!))) {
    throw new TypeError("Host Custody HTTP preparation signal is unavailable");
  }
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!.call(signal);
  return Object.freeze({ committedDispatchProof: validateCommittedDispatchProofV1({ ...proof }),
    signal, underlyingCustodyRef: record.underlyingCustodyRef });
};

/** Retained directly by LiveCustody from reservation creation through release.
 * Acquisition supplies identity/cutoff only, never HTTP readiness. Listener/journal
 * retention and post-claim launch finalization remain separate prerequisites.
 * No cleanup registry or physical-containment claim lives here.
 */
export class NodeProviderProcessCustodyHttpReservation {
  readonly #controller = new AbortController();
  readonly #identity = Object.freeze(Object.create(null)) as NodeCustodyExecutionSessionIdentity;
  #claimed = false;
  #cutoff = false;
  #preparationAbort: {readonly signal: AbortSignal; readonly listener: () => void} | undefined;
  #lifetime: NodeCustodyHttpLifetime | undefined;

  public get executionSessionIdentity(): NodeCustodyExecutionSessionIdentity {return this.#identity;}

  public get signal(): AbortSignal {return this.#controller.signal;}

  public assertActive(): void {
    if (this.#cutoff) {throw new Error("Host Custody reservation is sealed");}
  }

  public acquire(live: LiveCustody, handoff: Handoff): NodeCustodyHttpLifetime {
    const proof = handoff.committedDispatchProof;
    if (live.httpReservation !== this || this.#claimed || this.#cutoff || live.sealed ||
        live.abortRequested || live.spawnStatus !== "never-started" ||
        live.startIdentitySha256 !== undefined || live.fingerprint === undefined ||
        live.retainedWorkspaceAuthority === undefined || live.plan?.spawnMode !== "sdk-delegated" ||
        handoff.underlyingCustodyRef !== live.custodyRef || proof.attemptId !== live.attemptId ||
        proof.operationId !== live.operationId || proof.provider !== live.providerBinding.provider) {
      throw new TypeError("Host Custody HTTP reservation is unavailable or conflicts");
    }
    // These are the Host facts this record actually owns. Kernel custody/boot facts
    // are retained verbatim from its trusted caller, never synthesized from them.
    this.#claimed = true;
    if (handoff.signal.aborted) {
      this.cutoff();
      throw new TypeError("Host Custody HTTP preparation was cut off");
    }
    this.#lifetime = Object.freeze({ committedDispatchProof: proof,
      executionSessionIdentity: this.#identity,
      hostLifecycleGenerationSha256: live.identity.hostLifecycleGenerationSha256,
      signal: this.#controller.signal, underlyingCustodyRef: live.custodyRef });
    const listener = () => {this.cutoff();};
    this.#preparationAbort = {signal: handoff.signal, listener};
    addAbortListener(handoff.signal, listener);
    return this.#lifetime;
  }

  /** Admission cutoff only. Cleanup, erasure and terminal evidence remain separate. */
  public cutoff(): void {
    if (this.#cutoff) {return;}
    this.#cutoff = true;
    const preparation = this.#preparationAbort;
    this.#preparationAbort = undefined;
    try {this.#controller.abort();}
    finally {
      // Node's disposable consults a mutable signal property. Retire only our
      // retained listener through the native operation, even during reentrancy.
      if (preparation !== undefined) {
        nativeRemove.call(preparation.signal, "abort", preparation.listener);
      }
    }
  }
}
