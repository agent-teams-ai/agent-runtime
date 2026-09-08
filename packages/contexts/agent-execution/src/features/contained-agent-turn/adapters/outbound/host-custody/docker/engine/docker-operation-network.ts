import { addAbortListener } from "node:events";
import { randomBytes } from "node:crypto";
import { BoundedUnixHttpClient, type UnixHttpResponse } from "./bounded-unix-http.js";
import { NodeUnixSocketDockerEngine } from "./node-unix-socket-docker-engine.js";
import { snapshotDockerEngineCall, snapshotDockerEnginePolicy, snapshotOwnDataObject } from "./docker-boundary-snapshot.js";
import { decodeInspection, validateAuthorityShape } from "./docker-engine-codec.js";
import { canonicalJsonSha256 } from "./docker-canonical-json.js";
import { parseStrictJson } from "./strict-json.js";
import type { DockerContainerAuthority, DockerEngineCall, DockerEngineIdentity, DockerEnginePolicy } from "./docker-engine-port.js";
import { assertNetworkContainer, assertNetworkEngine, awaitNetworkCleanupWork, decodeOperationNetwork, networkBinding,
  networkDigest, networkFailure, networkObject, operationNetworkLabels, operationNetworkName,
  type DockerOperationNetworkBinding, type DockerOperationNetworkObservation } from "./docker-operation-network-codec.js";

type EngineInput = ConstructorParameters<typeof NodeUnixSocketDockerEngine>[0];
type Client = NonNullable<EngineInput["client"]>;
export type DockerOperationNetworkInput = EngineInput & Readonly<{binding: DockerOperationNetworkBinding}>;
export type DockerOperationNetworkRemoval = Readonly<{
  state: "absent"; networkId: string; evidenceSha256: string; reconcileRequired: boolean;
}> | Readonly<{state: "unknown"}>;
const API = "/v1.47/networks/";
const json = (response: UnixHttpResponse<Uint8Array>): unknown => {
  if (response.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
    response.body.byteLength > 262_144) {throw networkFailure();}
  return parseStrictJson(response.body);
};

/** One retained allocation slot, using the same typed Unix Engine transport and
 * identity decoder as container custody. Construction never opens a socket.
 * A lost create acknowledgement permits exact read-only cleanup discovery with
 * the privately generated allocation label; it never permits another create.
 * This class is adapter-private, not a provider or application network API. */
export class DockerOperationNetwork {
  readonly #binding: DockerOperationNetworkBinding;
  readonly #client: Client;
  readonly #engine: NodeUnixSocketDockerEngine;
  readonly #policy: DockerEnginePolicy;
  readonly #name: string;
  #engineIdentity: DockerEngineIdentity | undefined;
  #allocation: string | undefined;
  #networkId: string | undefined;
  #container: DockerContainerAuthority | undefined;
  #entered = false;
  #createIssued = false;
  #provenance: string | undefined;
  #networkAbsence: string | undefined;
  #containerAbsence: string | undefined;
  #launchAbort: ReturnType<typeof addAbortListener> | undefined;
  #removeIssued = false;
  #cut = false;
  #uncertain = false;
  #foreign = false;
  #allocationPending: Promise<unknown> | undefined;
  #removal: Promise<DockerOperationNetworkRemoval> | undefined;

  public constructor(input: DockerOperationNetworkInput) {
    const construction = snapshotOwnDataObject(input, ["binding", "client", "policy"], ["binding", "policy"], "invalid-create-request");
    this.#binding = networkBinding(construction.binding as DockerOperationNetworkBinding);
    this.#name = operationNetworkName(this.#binding);
    const policy = snapshotDockerEnginePolicy(construction.policy);
    this.#policy = policy;
    if (policy.allowedNetworkName !== this.#name || policy.hostIdentitySha256 !== this.#binding.hostIdentitySha256) {throw networkFailure();}
    const {daemonPidFileMode, daemonPidFileOwnerGid, daemonPidFileOwnerUid, daemonPidFilePath,
      socketMode, socketOwnerGid, socketOwnerUid, socketPath} = policy;
    if (construction.client === undefined) {
      const native = new BoundedUnixHttpClient({daemonPidFileMode, daemonPidFileOwnerGid,
        daemonPidFileOwnerUid, daemonPidFilePath, socketMode, socketOwnerGid, socketOwnerUid, socketPath});
      // The Engine boundary accepts an inert own-method record, not a class
      // instance. Both owners retain the SAME native client's endpoint custody.
      this.#client = Object.freeze({buffered: native.buffered.bind(native),
        endpointIdentity: native.endpointIdentity.bind(native), stream: native.stream.bind(native)});
    } else {this.#client = construction.client as Client;}
    this.#engine = new NodeUnixSocketDockerEngine({client: this.#client, policy});
  }

  /** Internal deployment metadata from retained ownership, never a custody proof. */
  public get listenerContext() {
    if (this.#cut || this.#uncertain || this.#networkId === undefined ||
        this.#allocation === undefined) {throw networkFailure();}
    return Object.freeze({networkId: this.#networkId, allocation: this.#allocation,
      ...(this.#container === undefined ? {} : {container: Object.freeze({...this.#container})})});
  }

  public get name(): string {return this.#name;}
  public get reconcileRequired(): boolean {return this.#uncertain;}
  public sealAdmission(): void {
    this.#cut = true;
    this.#launchAbort?.[Symbol.dispose](); this.#launchAbort = undefined;
  }

  #check(call: DockerEngineCall): void {
    if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {throw networkFailure();}
  }
  #admit(call: DockerEngineCall): void {
    this.#check(call);
    if (this.#cut || this.#foreign || this.#uncertain) {throw networkFailure();}
  }
  async #identity(call: DockerEngineCall): Promise<void> {
    this.#check(call);
    const identity = await this.#engine.identity(call);
    this.#check(call);
    assertNetworkEngine(this.#binding, identity);
    if (this.#engineIdentity !== undefined && canonicalJsonSha256(identity) !== canonicalJsonSha256(this.#engineIdentity)) {
      throw networkFailure();
    }
    this.#engineIdentity ??= Object.freeze({...identity});
  }
  async #get(path: string, call: DockerEngineCall): Promise<Readonly<{absent: boolean; value: unknown; evidenceSha256: string}>> {
    await this.#identity(call);
    const response = await this.#client.buffered({call, method: "GET", path});
    const value = json(response);
    await this.#identity(call);
    if (response.statusCode !== 200 && response.statusCode !== 404) {throw networkFailure();}
    if (response.statusCode === 404 && typeof networkObject(value).message !== "string") {throw networkFailure();}
    return {absent: response.statusCode === 404, value,
      evidenceSha256: canonicalJsonSha256({path, statusCode: response.statusCode, value, engine: this.#engineIdentity})};
  }

  public allocate(input: DockerEngineCall): Promise<DockerOperationNetworkObservation> {
    if (this.#entered) {throw networkFailure();}
    this.#entered = true;
    const completion = Promise.withResolvers<DockerOperationNetworkObservation>();
    this.#allocationPending = completion.promise.then(() => null, () => null);
    try {
      const call = snapshotDockerEngineCall(input);
      this.#admit(call);
      this.#launchAbort = addAbortListener(call.signal, () => this.sealAdmission());
      void this.#allocate(call).then(completion.resolve, completion.reject);
    }
    catch (error) {this.#uncertain = true; this.sealAdmission(); completion.reject(error);}
    return completion.promise;
  }
  async #allocate(call: DockerEngineCall): Promise<DockerOperationNetworkObservation> {
    try {
      this.#admit(call);
      const before = await this.#get(`${API}${this.#name}`, call);
      this.#admit(call);
      // Even perfectly matching preexisting labels cannot be acquired.
      if (!before.absent) {this.#foreign = true; throw networkFailure();}
      this.#allocation = randomBytes(32).toString("hex");
      const body = Buffer.from(JSON.stringify({Name: this.#name, CheckDuplicate: true, Driver: "bridge",
        Internal: true, Attachable: false, Ingress: false, EnableIPv6: false,
        IPAM: {Driver: "default", Config: [], Options: {}},
        Options: {"com.docker.network.bridge.enable_icc": "false"},
        Labels: operationNetworkLabels(this.#binding, this.#allocation)}));
      // Retain uncertainty BEFORE entering transport, including synchronous
      // throws, cancellation, reentrancy and a late successful acknowledgement.
      this.#createIssued = true;
      const response = await this.#client.buffered({call, method: "POST", path: `${API}create`, body,
        beforeWrite: () => this.#admit(call)});
      const created = networkObject(json(response));
      if (response.statusCode !== 201) {throw networkFailure();}
      this.#networkId = networkDigest(created.Id);
      if (created.Warning !== undefined && created.Warning !== "") {throw networkFailure();}
      this.#admit(call);
      const observation = await this.#observe(call);
      this.#admit(call);
      if (observation === undefined || observation.endpoint !== null) {throw networkFailure();}
      return observation;
    } catch (error) {this.#uncertain = true; this.sealAdmission(); throw error;}
  }

  /** Bind the exact V2 launch identity before inspecting membership. Binding is
   * inert, one-way, and cannot adopt a container by name or network IP. */
  public retainContainer(input: DockerContainerAuthority): void {
    const authority = validateAuthorityShape(input);
    assertNetworkContainer(this.#binding, authority);
    if (this.#container !== undefined && canonicalJsonSha256(this.#container) !== canonicalJsonSha256(authority)) {throw networkFailure();}
    this.#container ??= Object.freeze({...authority});
  }

  async #observe(call: DockerEngineCall): Promise<DockerOperationNetworkObservation | undefined> {
    if (!this.#createIssued || this.#allocation === undefined || this.#foreign) {throw networkFailure();}
    const response = await this.#get(`${API}${this.#networkId ?? this.#name}`, call);
    if (response.absent) {this.#networkAbsence = response.evidenceSha256; return undefined;}
    let observed: DockerOperationNetworkObservation;
    try {
      observed = decodeOperationNetwork({value: response.value, name: this.#name,
        labels: operationNetworkLabels(this.#binding, this.#allocation), networkId: this.#networkId, container: this.#container});
    } catch (error) {this.#foreign = true; throw error;}
    this.#networkId ??= observed.networkId;
    this.#provenance = observed.evidenceSha256;
    return observed;
  }

  async #memberContainer(call: DockerEngineCall, observed?: DockerOperationNetworkObservation): Promise<string> {
    const raw = await this.#get(`/v1.47/containers/${this.#container!.containerId}/json`, call);
    this.#admit(call);
    if (raw.absent) {throw networkFailure();}
    // Validate launch specification AND endpoint on the same readback. A final
    // Engine.inspect alone ignores NetworkSettings and cannot confirm membership.
    decodeInspection(raw.value, this.#container!, this.#engineIdentity!, this.#policy);
    const networks = networkObject(networkObject(networkObject(raw.value).NetworkSettings).Networks);
    if (Object.keys(networks).length !== 1 || !Object.hasOwn(networks, this.#name)) {throw networkFailure();}
    const endpoint = networkObject(networks[this.#name]);
    if (observed !== undefined && (observed.endpoint === null || endpoint.NetworkID !== observed.networkId ||
      endpoint.EndpointID !== observed.endpoint.endpointId ||
      `${String(endpoint.IPAddress)}/${String(endpoint.IPPrefixLen)}` !== observed.endpoint.address ||
      endpoint.GlobalIPv6Address !== "")) {throw networkFailure();}
    return raw.evidenceSha256;
  }

  public async inspectMembership(input: DockerEngineCall): Promise<DockerOperationNetworkObservation> {
    const call = snapshotDockerEngineCall(input);
    try {
      this.#admit(call);
      if (this.#container === undefined) {throw networkFailure();}
      await this.#memberContainer(call);
      const observed = await this.#observe(call);
      this.#admit(call);
      if (observed === undefined || observed.endpoint === null) {throw networkFailure();}
      await this.#memberContainer(call, observed);
      const after = await this.#observe(call);
      this.#admit(call);
      if (after === undefined || canonicalJsonSha256(after) !== canonicalJsonSha256(observed)) {throw networkFailure();}
      const containerReadback = await this.#memberContainer(call, observed);
      this.#admit(call);
      return Object.freeze({...observed, evidenceSha256: canonicalJsonSha256({network: observed.evidenceSha256, containerReadback})});
    } catch (error) {this.#uncertain = true; this.sealAdmission(); throw error;}
  }

  async #containerAbsent(call: DockerEngineCall): Promise<void> {
    const authority = this.#container;
    if (authority !== undefined) {
      const container = await this.#get(`/v1.47/containers/${authority.containerId}/json`, call);
      this.#check(call);
      if (!container.absent) {throw networkFailure();}
      this.#containerAbsence = container.evidenceSha256;
    }
    // A late launch handle received during this await invalidates the proof.
    if (this.#container !== authority) {throw networkFailure();}
  }

  /** Caller supplies an independent cleanup deadline/signal. Duplicate calls
   * share one flight. A lost DELETE acknowledgement is reconciled by observation
   * only: an existing network never authorizes repeating that mutation. */
  public remove(input: DockerEngineCall): Promise<DockerOperationNetworkRemoval> {
    if (this.#removal !== undefined) {return this.#removal;}
    const completion = Promise.withResolvers<DockerOperationNetworkRemoval>();
    this.#removal = completion.promise;
    this.sealAdmission();
    // Validate inside the owned promise so a malformed call cannot strand it.
    void this.#remove(input).then(result => {
      this.#removal = undefined; return completion.resolve(result);
    }, () => {
      this.#uncertain = true; this.#removal = undefined;
      return completion.resolve(Object.freeze({state: "unknown"}));
    });
    return completion.promise;
  }
  async #remove(input: DockerEngineCall): Promise<DockerOperationNetworkRemoval> {
    const call = snapshotDockerEngineCall(input);
    await awaitNetworkCleanupWork(this.#allocationPending, call);
    const boundContainer = this.#container;
    const before = await this.#observe(call);
    await this.#containerAbsent(call);
    if (before !== undefined) {
      if (before.endpoint !== null || this.#removeIssued) {throw networkFailure();}
      const confirmed = await this.#observe(call);
      if (confirmed === undefined || canonicalJsonSha256(confirmed) !== canonicalJsonSha256(before)) {throw networkFailure();}
      this.#removeIssued = true;
      // Exact id only; never DELETE a name, disconnect a foreign endpoint, or force.
      try {
        const response = await this.#client.buffered({call, method: "DELETE", path: `${API}${before.networkId}`,
          beforeWrite: () => {
            this.#check(call);
            if (this.#container !== boundContainer) {throw networkFailure();}
          }});
        if (response.statusCode !== 204 || response.body.byteLength !== 0 || response.contentType !== "") {this.#uncertain = true;}
      } catch {this.#uncertain = true;}
      const after = await this.#observe(call);
      if (after !== undefined) {throw networkFailure();}
    }
    // A name-only 404 after a lost create response is not proof of absence: the
    // unresolved POST may still allocate. Keep that slot quarantined forever.
    if (this.#networkId === undefined || this.#provenance === undefined) {throw networkFailure();}
    // Recheck exact container removal after DELETE/network absence, then the
    // retained Engine before issuing the physical network absence observation.
    const container = this.#container;
    await this.#containerAbsent(call);
    await this.#identity(call);
    if (this.#container !== container) {throw networkFailure();}
    return Object.freeze({state: "absent", networkId: this.#networkId, reconcileRequired: this.#uncertain,
      evidenceSha256: canonicalJsonSha256({networkId: this.#networkId, engine: this.#engineIdentity, absent: true,
        container: this.#container ?? null, allocation: this.#allocation, provenance: this.#provenance,
        networkReadback: this.#networkAbsence, containerReadback: this.#containerAbsence ?? null})});
  }
}
