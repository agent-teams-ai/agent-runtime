import { addAbortListener } from "node:events";
import { custodyDataRecord } from "../host-custody-inert-record.js";
import { readHostCustodyHttpHandoff, type HostCustodyHttpHandoff,
  type HostCustodyHttpResourceLifetime } from "../host-custody-http-resource-lifetime.js";
import { NodeCustodyHttpResources, type NodeCustodyHttpResourceInput } from "../node-custody-http-resources.js";
import type { HostHttpEgressSessionDependencies } from "../egress/host-http-egress-session.js";
import { DockerHostCustodyLifecycle, dockerProviderProcessMountFacts } from "./docker-host-custody-lifecycle.js";
import type { LaunchedDockerCustody } from "./docker-lifecycle-issued-launch.js";
import { sameDockerAuthority } from "./docker-host-custody-lifecycle-guards.js";
import { awaitNetworkCleanupWork } from "./engine/docker-operation-network-codec.js";

const {observeLaunch} = DockerHostCustodyLifecycle.prototype;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeAbort = AbortController.prototype.abort;
const rejected = (): TypeError => new TypeError("Docker HTTP custody lifetime unavailable or conflicts");
const ownerKeys = ["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"] as const;

export type DockerCustodyHttpReservationInput = Readonly<{
  lifecycle: DockerHostCustodyLifecycle;
  launch: LaunchedDockerCustody;
  /** Independent Host lifecycle identity, supplied by trusted Host composition. */
  hostLifecycleGenerationSha256: string;
  /** Exact current post-claim handoff, supplied only after COMMIT acknowledgement. */
  claimed: HostCustodyHttpHandoff;
}>;

/** Docker's second concrete consumer of the fixed HTTP resource slots. This
 * owner does not fabricate Node custody, consume provider IO, map executables,
 * finalize a native launch, or issue physical/terminal observations.
 *
 * Construction retains an actual lifecycle/launch and the trusted current
 * handoff, with no IO, session, timer or listener. The caller must join cutoff
 * to Host shutdown/containment and retain cleanup until it settles. Validating
 * a proof digest does not establish COMMIT provenance or grant caller authority.
 */
export class DockerCustodyHttpReservation {
  static readonly #reserved = new WeakSet<LaunchedDockerCustody>();
  readonly #controller = new AbortController();
  readonly #signal = this.#controller.signal;
  readonly #resources = new NodeCustodyHttpResources(Object.freeze({cutoff: () => this.#cutoff()}), this.#controller);
  readonly #identity: object = Object.freeze(Object.create(null));
  readonly #input: DockerCustodyHttpReservationInput;
  readonly #observed: ReturnType<DockerHostCustodyLifecycle["observeLaunch"]>;
  readonly #preparation;
  #lifetime: HostCustodyHttpResourceLifetime | undefined;
  #cut = false;
  #subscribed = false;
  readonly #abort = () => this.#cutoff();

  public constructor(input: DockerCustodyHttpReservationInput) {
    input = custodyDataRecord(input);
    if (Reflect.ownKeys(input).length !== 4 || typeof input.hostLifecycleGenerationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.hostLifecycleGenerationSha256)) {throw rejected();}
    // Private lifecycle branding and its issued-launch table are authoritative;
    // neither a replaced instance method nor a structural launch is consulted.
    this.#observed = observeLaunch.call(input.lifecycle, input.launch);
    const original = custodyDataRecord(input.claimed);
    const checked = readHostCustodyHttpHandoff(original);
    const key = this.#observed.key;
    if (ownerKeys.some(field => checked.committedDispatchProof[field] !== key[field]) ||
      checked.underlyingCustodyRef !== key.custodyId) {throw rejected();}
    // Validation above read only inert scalars. Preserve the exact capability
    // received from the trusted caller, including identity-based provenance.
    const claimed = Object.freeze({...checked, committedDispatchProof: Object.freeze(original.committedDispatchProof)});
    this.#input = Object.freeze({lifecycle: input.lifecycle, launch: input.launch,
      hostLifecycleGenerationSha256: input.hostLifecycleGenerationSha256, claimed});
    if (this.#observed.retired || this.#observed.journal.state !== "init_ready" ||
      this.#observed.terminal !== null || this.#observed.removal !== null) {throw rejected();}
    if (DockerCustodyHttpReservation.#reserved.has(input.launch)) {throw rejected();}
    DockerCustodyHttpReservation.#reserved.add(input.launch);
    this.#preparation = Object.freeze({
      binding: Object.freeze({attempt: key, imageDigest: this.#observed.authority.imageDigest,
        hostLifecycleGenerationSha256: input.hostLifecycleGenerationSha256}),
      acquire: (handoff: HostCustodyHttpHandoff) => this.#acquire(handoff),
      prepareResources: (lifetime: HostCustodyHttpResourceLifetime, resources: NodeCustodyHttpResourceInput) => {
        this.#assertPreparation(lifetime); return this.#resources.prepare(lifetime, resources);
      },
      openIngress: (lifetime: HostCustodyHttpResourceLifetime) => {
        this.#assertPreparation(lifetime); return this.#resources.openIngress(lifetime);
      },
      bindSession: (lifetime: HostCustodyHttpResourceLifetime, dependencies: HostHttpEgressSessionDependencies) => {
        this.#assertPreparation(lifetime); return this.#resources.bindSession(dependencies);
      },
      cutoff: this.#abort,
      cleanup: (deadlineEpochMs: number) => this.#cleanup(deadlineEpochMs),
    });
  }

  /** Nominal private owner lookup; foreign objects/proxies cannot supply a facade. */
  public static httpPreparation(owner: unknown) {
    return typeof owner === "object" && owner !== null && #preparation in owner ? owner.#preparation : undefined;
  }
  public get signal(): AbortSignal {return this.#signal;}
  public get pending(): Promise<void> | undefined {return this.#resources.pending;}

  #assertLaunch(): void {
    const current = observeLaunch.call(this.#input.lifecycle, this.#input.launch);
    if (current.retired || current.journal.state !== "init_ready" || current.terminal !== null ||
      current.removal !== null || !sameDockerAuthority(current.authority, this.#observed.authority) ||
      (Object.keys(this.#observed.key) as Array<keyof typeof current.key>)
        .some(field => current.key[field] !== this.#observed.key[field])) {throw rejected();}
    // This existing read-only capability also checks synchronous live cutoff and
    // the original launch call, before delayed journal observations can catch up.
    // It never claims the launch or opens an init session.
    dockerProviderProcessMountFacts(this.#input.launch);
  }

  #acquire(input: HostCustodyHttpHandoff): HostCustodyHttpResourceLifetime {
    if (this.#cut || this.#lifetime !== undefined) {throw rejected();}
    const original = custodyDataRecord(input);
    const handoff = readHostCustodyHttpHandoff(original);
    const expected = this.#input.claimed;
    if (original.committedDispatchProof !== expected.committedDispatchProof ||
      handoff.underlyingCustodyRef !== expected.underlyingCustodyRef || handoff.signal !== expected.signal) {throw rejected();}
    try {
      this.#assertLaunch();
      if (nativeAborted.call(expected.signal)) {throw rejected();}
      this.#lifetime = Object.freeze({committedDispatchProof: expected.committedDispatchProof,
        underlyingCustodyRef: expected.underlyingCustodyRef, executionSessionIdentity: this.#identity,
        hostLifecycleGenerationSha256: this.#input.hostLifecycleGenerationSha256, signal: this.#signal});
      this.#subscribed = true;
      addAbortListener(this.#signal, this.#abort);
      addAbortListener(expected.signal, this.#abort);
      return this.#lifetime;
    } catch (error) {this.#cutoff(); throw error;}
  }

  #assertPreparation(lifetime: HostCustodyHttpResourceLifetime): void {
    if (this.#cut || this.#lifetime === undefined || lifetime !== this.#lifetime) {throw rejected();}
    try {this.#assertLaunch();} catch (error) {this.#cutoff(); throw error;}
  }

  #cutoff(): void {
    if (this.#cut) {return;}
    this.#cut = true;
    try {this.#resources.cutoff();}
    finally {
      // Ignore caller replacement of signal cleanup properties and stopped
      // propagation. Cleanup still belongs to the same fixed resource slots.
      nativeAbort.call(this.#controller);
      if (this.#subscribed) {
        nativeRemove.call(this.#input.claimed.signal, "abort", this.#abort);
        nativeRemove.call(this.#signal, "abort", this.#abort);
        this.#subscribed = false;
      }
    }
  }

  async #cleanup(deadlineEpochMs: number): Promise<boolean> {
    this.#cutoff();
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= Date.now()) {return false;}
    const work = this.#resources.cleanup();
    // Only the wait is bounded. The resource owner's existing shared cleanup
    // flight and late acquisitions remain retained after this waiter detaches.
    try {
      await awaitNetworkCleanupWork(work, {signal: new AbortController().signal, deadlineEpochMs});
      return await work;
    } catch {return false;}
  }
}
