import { DockerOperationNetwork, operationNetworkName, validateAuthorityShape, snapshotDockerEngineCall,
  type DockerOperationNetworkInput, type DockerOperationNetworkBinding } from "./engine/docker-engine-composition.js";
import type { DockerContainerAuthority, DockerEngineCall } from "./engine/docker-engine-port.js";
import { dockerCustodyOwnerIdentitySha256 } from "./journal/docker-custody-journal-codec.js";
import { HostHttpEgressV4Journal } from "./journal/host-http-egress-v4-journal.js";
import { v4Digest, v4Exact, v4Hash, v4Subject } from "./journal/host-http-egress-v4-codec.js";
import type { HostHttpEgressV4Intent, HostHttpEgressV4Observation, HostHttpEgressV4ObservationOwner,
  HostHttpEgressV4Subject } from "./journal/host-http-egress-v4-types.js";

const rejected = (): Error => new Error("Docker HTTP operation resource ownership is unproven");
const {evidence, recordIntent, target, recordObservation} = HostHttpEgressV4Journal.prototype;
const {sealAdmission, allocate, retainContainer, inspectMembership, remove} = DockerOperationNetwork.prototype;
const identityKeys = ["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"] as const;
export type DockerHttpResourceClaim = Readonly<Record<typeof identityKeys[number], string> & {
  effectId: string; workspaceId: string; executionGenerationId: string;
  committedClaimSha256: string; acceptedAuthoritySha256: string;
}>;
export const dockerHttpOperationNetworkRecipe = (input: HostHttpEgressV4Subject) => {
  const subject = v4Subject(input); const attempt = subject.attempt;
  const binding: DockerOperationNetworkBinding = Object.freeze({
    daemonIdentitySha256: attempt.daemonIdentitySha256, daemonBootGenerationSha256: attempt.daemonBootGenerationSha256,
    hostIdentitySha256: attempt.hostIdentitySha256, hostBootGenerationSha256: attempt.hostBootGenerationSha256,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(attempt), operationNonceSha256: attempt.operationNonceSha256,
    launchFingerprintSha256: attempt.launchFingerprintSha256, operationSha256: v4Hash(attempt.operationId),
    executionGenerationSha256: v4Hash(subject.executionGenerationId), networkHandleSha256: subject.networkHandle.slice(8),
  });
  return Object.freeze({binding, name: operationNetworkName(binding)});
};
export type DockerHttpNetworkResourceInput = Readonly<{
  subject: HostHttpEgressV4Subject; engine: Omit<DockerOperationNetworkInput, "binding">;
  cleanupMilliseconds: number;
}>;

/** Retained network/Engine observation issuer. It cannot issue listener, socket,
 * route-cut, no-container-create, or consumption evidence. Those tokens belong
 * to the existing physical owners and must be joined in outer composition.
 * No method accepts an observation body, a boolean closure claim or raw readback.
 * V4 remains borrowed: this owner never retires/closes it or authorizes exec. */
export class DockerHttpNetworkResources implements HostHttpEgressV4ObservationOwner {
  readonly #subject: HostHttpEgressV4Subject;
  readonly #network: DockerOperationNetwork;
  readonly #tokens = new WeakMap<object, HostHttpEgressV4Observation>();
  readonly #cut = new AbortController();
  readonly #cleanupMilliseconds: number;
  #journal: HostHttpEgressV4Journal | undefined;
  #pending: Promise<void> | undefined;
  #entered = false;
  #intent = false;
  #releaseIntent = false;
  #networkAbsent = false;
  #cleanup: Promise<"absent" | "unknown"> | undefined;

  public constructor(input: DockerHttpNetworkResourceInput) {
    v4Exact(input, ["subject", "engine", "cleanupMilliseconds"]);
    try {v4Exact(input.engine, ["policy"]);} catch {v4Exact(input.engine, ["policy", "client"]);}
    this.#subject = v4Subject(input.subject);
    const recipe = dockerHttpOperationNetworkRecipe(this.#subject);
    this.#network = new DockerOperationNetwork({...input.engine, binding: recipe.binding});
    if (!Number.isSafeInteger(input.cleanupMilliseconds) || input.cleanupMilliseconds < 1 || input.cleanupMilliseconds > 5_000) {throw rejected();}
    this.#cleanupMilliseconds = input.cleanupMilliseconds;
  }
  public get networkName(): string {return this.#network.name;}
  public get signal(): AbortSignal {return this.#cut.signal;}
  public readObservation(token: object): HostHttpEgressV4Observation | undefined {return this.#tokens.get(token);}

  public assertClaim(current: DockerHttpResourceClaim): void {
    v4Exact(current, [...identityKeys, "effectId", "workspaceId", "executionGenerationId", "committedClaimSha256", "acceptedAuthoritySha256"]);
    const subject = this.#subject;
    if (identityKeys.some(key => current[key] !== subject.attempt[key]) ||
      ["effectId", "workspaceId", "executionGenerationId", "committedClaimSha256", "acceptedAuthoritySha256"]
        .some(key => current[key] !== subject[key as keyof HostHttpEgressV4Subject])) {this.cutoff(); throw rejected();}
  }
  #record(kind: HostHttpEgressV4Intent) {
    const journal = this.#journal!;
    return recordIntent.call(journal, `command:${v4Hash({subject: v4Hash(this.#subject), kind})}`,
      {kind, targetSha256: target.call(journal, kind)});
  }
  async #uncertain(): Promise<void> {
    this.cutoff();
    try {
      if (this.#journal !== undefined && !evidence.call(this.#journal).reconcileRequired) {await this.#record("uncertain");}
    } catch { /* Retain ownership even when the ledger itself is quarantined. */ }
  }
  public cutoff(): void {
    sealAdmission.call(this.#network);
    if (!this.#cut.signal.aborted) {this.#cut.abort();}
  }
  #check(call: DockerEngineCall): void {
    if (this.#cut.signal.aborted || call.signal.aborted || Date.now() >= call.deadlineEpochMs ||
      this.#journal === undefined || evidence.call(this.#journal).admission !== "fresh_ledger") {throw rejected();}
  }
  async #publish(kind: "network_allocated" | "network_absent" | "container_attached",
    actual: unknown, evidenceSha256: string, container: DockerContainerAuthority | null = null): Promise<void> {
    const journal = this.#journal!;
    const token = Object.freeze({});
    const observation: HostHttpEgressV4Observation = Object.freeze({kind, container, writeOutcome: null,
      subjectSha256: v4Hash(this.#subject), observerSha256: this.#subject.observerSha256,
      targetSha256: target.call(journal, kind), actualSha256: v4Hash(actual), evidenceSha256: v4Digest(evidenceSha256)});
    this.#tokens.set(token, observation);
    await recordObservation.call(journal, `command:${v4Hash(observation)}`, token);
  }

  public prepare(journal: HostHttpEgressV4Journal, current: DockerHttpResourceClaim, input: DockerEngineCall) {
    if (this.#entered || this.signal.aborted) {throw rejected();}
    this.#entered = true;
    const completion = Promise.withResolvers<void>(); this.#pending = completion.promise;
    let call: DockerEngineCall;
    try {
      call = snapshotDockerEngineCall(input);
      this.assertClaim(current);
      const ledger = evidence.call(journal);
      if (ledger.subjectSha256 !== v4Hash(this.#subject) || ledger.admission !== "fresh_ledger") {throw rejected();}
      this.#journal = journal;
    } catch (error) {this.cutoff(); completion.resolve(); throw error;}
    const abort = () => this.cutoff();
    call.signal.addEventListener("abort", abort, {once: true});
    return this.#prepare(call).finally(() => {call.signal.removeEventListener("abort", abort); completion.resolve();});
  }
  async #prepare(call: DockerEngineCall): Promise<Readonly<{networkName: string; gateway: string}>> {
    try {
      this.#check(call);
      const intent = await this.#record("network_intent");
      if (intent.kind !== "recorded") {throw rejected();}
      this.#intent = true;
      this.#check(call);
      const observed = await allocate.call(this.#network, call);
      this.#check(call);
      await this.#publish("network_allocated", {networkId: observed.networkId, networkName: this.networkName}, observed.evidenceSha256);
      this.#check(call);
      return Object.freeze({networkName: this.networkName, gateway: observed.gateway});
    } catch (error) {await this.#uncertain(); throw error;}
  }

  public async observeContainer(input: DockerContainerAuthority, invocation: DockerEngineCall): Promise<void> {
    const call = snapshotDockerEngineCall(invocation);
    const abort = () => this.cutoff();
    call.signal.addEventListener("abort", abort, {once: true});
    try {
      const authority = validateAuthorityShape(input);
      if (authority.imageDigest !== this.#subject.imageDigest) {throw rejected();}
      // A late launch identity still belongs to cleanup even after admission cut.
      retainContainer.call(this.#network, authority);
      this.#check(call);
      const observed = await inspectMembership.call(this.#network, call);
      this.#check(call);
      await this.#publish("container_attached", {container: authority, endpoint: observed.endpoint}, observed.evidenceSha256, authority);
      this.#check(call);
    } catch (error) {await this.#uncertain(); throw error;}
    finally {call.signal.removeEventListener("abort", abort);}
  }

  /** Existing V4 cutoff/socket/container/listener observations must precede this
   * call. Missing authority leaves the endpoint retained, and can be supplied
   * later by its real owner. Each physical cleanup uses its own bounded call. */
  public cleanupNetwork(): Promise<"absent" | "unknown"> {
    if (this.#cleanup !== undefined) {return this.#cleanup;}
    const completion = Promise.withResolvers<"absent" | "unknown">(); this.#cleanup = completion.promise;
    this.cutoff();
    void this.#clean().then(completion.resolve, () => completion.resolve("unknown")).finally(() => {this.#cleanup = undefined;});
    return completion.promise;
  }
  async #clean(): Promise<"absent" | "unknown"> {
    await this.#pending;
    if (this.#networkAbsent) {return "absent";}
    if (!this.#intent) {return "unknown";}
    if (!this.#releaseIntent) {
      try {
        if ((await this.#record("network_release")).kind !== "recorded") {return "unknown";}
        this.#releaseIntent = true;
      } catch {return "unknown";}
    }
    const result = await remove.call(this.#network,
      {signal: new AbortController().signal, deadlineEpochMs: Date.now() + this.#cleanupMilliseconds});
    if (result.state !== "absent") {await this.#uncertain(); return "unknown";}
    if (result.reconcileRequired) {await this.#uncertain();}
    await this.#publish("network_absent", {networkId: result.networkId, networkName: this.networkName}, result.evidenceSha256);
    this.#networkAbsent = true;
    // Physical absence does not erase uncertain execution or permit V4 retirement.
    return "absent";
  }
}
