import { addAbortListener } from "node:events";
import type { HostCustodyHttpHandoff as Handoff, HostCustodyHttpResourceLifetime } from "./host-custody-http-resource-lifetime.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

import { NodeCustodyHttpResources, type NodeCustodyHttpResourceInput } from "./node-custody-http-resources.js";
import type { HostHttpEgressSessionDependencies } from "./egress/host-http-egress-session.js";

import type { DarwinSeatbeltRouteOwner } from "./darwin-seatbelt-route-owner.js";

import { isIssuedDarwinRouteOwner } from "./darwin-route-identity.js";

const nativeRemove = EventTarget.prototype.removeEventListener;

/** Private identity of a reserved execution session, never evidence of a PID or start. */
declare const executionSession: unique symbol;
export type NodeCustodyExecutionSessionIdentity = Readonly<{ [executionSession]: true }>;
export interface NodeCustodyHttpLifetime extends HostCustodyHttpResourceLifetime {
  readonly executionSessionIdentity: NodeCustodyExecutionSessionIdentity;
}

/** Only trusted Host wiring inside the actual kernel prepareClaimed may call acquire.
 * This is no claim issuer: possession of a structural proof/digest is insufficient
 * authority to call it. COMMIT acknowledgement remains with the trusted operation
 * owner; the kernel binds custodyId, hostBootId, hostInstanceId and the remaining
 * kernel proof fields before invoking prepareClaimed.
 */
export interface NodeCustodyHttpPreparation {
  acquire(input: Handoff): NodeCustodyHttpLifetime;
  prepareResources(lifetime: NodeCustodyHttpLifetime, input: NodeCustodyHttpResourceInput):
    ReturnType<NodeCustodyHttpResources["prepare"]>;
  retainDarwinRoute(lifetime: NodeCustodyHttpLifetime, owner: DarwinSeatbeltRouteOwner): void;
  finalize(lifetime: NodeCustodyHttpLifetime): import("./host-launch-finalization.js").ClaimedHostLaunchFinalizer;
}

export { custodyDataRecord } from "./host-custody-inert-record.js";

export { readHostCustodyHttpHandoff as readNodeCustodyHttpHandoff } from "./host-custody-http-resource-lifetime.js";

/** Retained directly by LiveCustody from reservation creation through release.
 * Acquisition supplies identity/cutoff only, never HTTP readiness. Concrete HTTP
 * preparation and finalization use fixed slots on this same reservation.
 * No cleanup registry or physical-containment claim lives here.
 */
export class NodeProviderProcessCustodyHttpReservation {
  readonly #controller = new AbortController();
  readonly #resources = new NodeCustodyHttpResources(this, this.#controller);
  readonly #identity = Object.freeze(Object.create(null)) as NodeCustodyExecutionSessionIdentity;
  #route: DarwinSeatbeltRouteOwner | undefined;
  #claimed = false;
  #cutoff = false;
  #preparationAbort: {readonly signal: AbortSignal; readonly listener: () => void} | undefined;
  #lifetime: NodeCustodyHttpLifetime | undefined;

  public get pending(): Promise<void> | undefined {
    // The Darwin flight encloses resource preparation and finalization. Preserve
    // the original Linux promise identity and avoid allocating per observation.
    return this.#route?.pending ?? this.#resources.pending;
  }
  public get darwinRoute(): DarwinSeatbeltRouteOwner | undefined {return this.#route;}
  public retainDarwinRoute(live: LiveCustody, lifetime: NodeCustodyHttpLifetime, owner: DarwinSeatbeltRouteOwner): void {
    this.assertPreparation(lifetime);
    if (this.#route !== undefined || !isIssuedDarwinRouteOwner(owner) || owner.lifetime !== lifetime ||
        live.httpReservation !== this || this.#resources.pending !== undefined) {throw new TypeError("Darwin route owner conflicts");}
    owner.attach(live); this.#route = owner;
  }

  public cleanup(): Promise<boolean> {
    this.cutoff(); return this.#route === undefined ? this.#resources.cleanup() : this.#route.cleanup(() => this.#resources.cleanup());
  }

  public prepareResources(lifetime: NodeCustodyHttpLifetime, input: NodeCustodyHttpResourceInput) {
    this.assertPreparation(lifetime);
    return this.#resources.prepare(lifetime, input);
  }

  public openIngress(lifetime: NodeCustodyHttpLifetime) {
    this.assertPreparation(lifetime);
    return this.#resources.openIngress(lifetime);
  }

  public bindSession(lifetime: NodeCustodyHttpLifetime, dependencies: HostHttpEgressSessionDependencies) {
    this.assertPreparation(lifetime);
    return this.#resources.bindSession(dependencies);
  }

  public get executionSessionIdentity(): NodeCustodyExecutionSessionIdentity {return this.#identity;}

  public get signal(): AbortSignal {return this.#controller.signal;}

  public assertActive(): void {
    if (this.#cutoff) {throw new Error("Host Custody reservation is sealed");}
  }

  public assertPreparation(lifetime: NodeCustodyHttpLifetime): void {
    this.assertActive();
    if (this.#lifetime === undefined || this.#lifetime !== lifetime) {
      throw new TypeError("Host Custody HTTP preparation identity conflicts");
    }
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
    addAbortListener(this.#controller.signal, listener);
    addAbortListener(handoff.signal, listener);
    return this.#lifetime;
  }

  /** Admission cutoff only. Cleanup, erasure and terminal evidence remain separate. */
  public cutoff(): void {
    if (this.#cutoff) {return;}
    this.#cutoff = true;
    const preparation = this.#preparationAbort;
    this.#preparationAbort = undefined;
    try {this.#route?.cutoff(); this.#resources.cutoff(); this.#controller.abort();}
    finally {
      // Node's disposable consults a mutable signal property. Retire only our
      // retained listener through the native operation, even during reentrancy.
      if (preparation !== undefined) {
        nativeRemove.call(preparation.signal, "abort", preparation.listener);
      }
    }
  }
}
