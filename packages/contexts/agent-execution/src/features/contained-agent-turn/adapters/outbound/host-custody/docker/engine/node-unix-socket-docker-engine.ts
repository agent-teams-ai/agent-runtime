import { DockerEngineError } from "./docker-engine-error.js";
import {
  decodeEngineIdentity,
  decodeInspection,
  validateAuthorityShape,
} from "./docker-engine-codec.js";
import { canonicalizeCreateMounts, containerName, encodeCreateRequest } from "./docker-create-request.js";
import { createSpecificationSha256 } from "./docker-create-specification.js";
import {
  snapshotDockerContainerCreate,
  snapshotDockerEngineCall,
  snapshotDockerEnginePolicy,
  snapshotOwnDataObject,
} from "./docker-boundary-snapshot.js";
import { isTerminalObservation, mutationPostconditionSatisfied } from "./docker-engine-semantics.js";
import { decodeCreateId, decodeErrorResponse, decodeWaitExitCode } from "./docker-response-codec.js";
import type {
  DockerContainerAuthority,
  DockerContainerCreate,
  DockerContainerObservation,
  DockerEngineCall,
  DockerEngineIdentity,
  DockerEnginePolicy,
  DockerEnginePort,
  DockerLogFrame,
} from "./docker-engine-port.js";
import { DOCKER_LOG_MAX_FRAME_BYTES, DOCKER_LOG_MAX_STREAM_BYTES } from "./docker-engine-port.js";
import { parseDockerMultiplexedStream } from "./docker-multiplexed-stream.js";
import { BoundedUnixHttpClient } from "./bounded-unix-http.js";
import type { DockerEndpointIdentity, UnixHttpResponse } from "./bounded-unix-http.js";
import { parseStrictJson } from "./strict-json.js";

const API = "/v1.47";
const MAX_CALL_MS = 120_000;

interface JsonResponse {
  readonly statusCode: number;
  readonly value: unknown;
}

type EngineClient = {
  buffered(input: {
    readonly body?: Uint8Array;
    readonly call: DockerEngineCall;
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<UnixHttpResponse<Uint8Array>>;
  endpointIdentity(call: DockerEngineCall): Promise<DockerEndpointIdentity>;
  stream(input: {
    readonly call: DockerEngineCall;
    readonly method: "DELETE" | "GET" | "POST";
    readonly path: string;
  }): Promise<UnixHttpResponse<AsyncIterable<Uint8Array>>>;
};

const mediaType = (value: string): string => value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const boundedPreflight = async <T>(work: Promise<T>, call: DockerEngineCall): Promise<T> => {
  const remaining = Math.min(call.deadlineEpochMs - Date.now(), MAX_CALL_MS);
  if (call.signal.aborted) {throw new DockerEngineError("aborted");}
  if (!Number.isSafeInteger(call.deadlineEpochMs) || remaining <= 0) {
    throw new DockerEngineError("deadline-exceeded");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {cleanup(); reject(new DockerEngineError("aborted"));};
    const timer = setTimeout(() => {cleanup(); reject(new DockerEngineError("deadline-exceeded"));}, remaining);
    const cleanup = (): void => {clearTimeout(timer); call.signal.removeEventListener("abort", abort);};
    call.signal.addEventListener("abort", abort, { once: true });
    const settle = async (): Promise<void> => {
      try {resolve(await work);} catch (error) {reject(error);} finally {cleanup();}
    };
    void settle();
  });
};

const statusFailure = (operation: string, statusCode: number): DockerEngineError => {
  if (statusCode === 404) {return new DockerEngineError("resource-not-found", statusCode);}
  if (operation === "create" && statusCode === 409) {
    return new DockerEngineError("resource-already-exists", statusCode);
  }
  return new DockerEngineError("request-rejected", statusCode);
};

export class NodeUnixSocketDockerEngine implements DockerEnginePort {
  readonly #client: EngineClient;
  readonly #policy: DockerEnginePolicy;

  public constructor(input: {
    /** Internal protocol-test seam. It must supply the same boot-generation observations as production. */
    readonly client?: EngineClient;
    readonly policy: DockerEnginePolicy;
  }) {
    const construction = snapshotOwnDataObject(input, ["client", "policy"], ["policy"], "invalid-create-request");
    const policy = snapshotDockerEnginePolicy(construction.policy);
    if (construction.client === undefined) {
      this.#client = new BoundedUnixHttpClient({
        daemonPidFileMode: policy.daemonPidFileMode,
        daemonPidFileOwnerGid: policy.daemonPidFileOwnerGid,
        daemonPidFileOwnerUid: policy.daemonPidFileOwnerUid,
        daemonPidFilePath: policy.daemonPidFilePath,
        socketMode: policy.socketMode,
        socketOwnerGid: policy.socketOwnerGid,
        socketOwnerUid: policy.socketOwnerUid,
        socketPath: policy.socketPath,
      });
    } else {
      const client = snapshotOwnDataObject(
        construction.client,
        ["buffered", "endpointIdentity", "stream"],
        ["buffered", "endpointIdentity", "stream"],
        "invalid-create-request",
      );
      if (typeof client.buffered !== "function" || typeof client.endpointIdentity !== "function" ||
          typeof client.stream !== "function") {
        throw new DockerEngineError("invalid-create-request");
      }
      this.#client = client as unknown as EngineClient;
    }
    this.#policy = policy;
    encodeCreateRequest({
      arguments: [],
      entrypoint: "/bin/false",
      environment: {},
      imageDigest: `validation@sha256:${"0".repeat(64)}`,
      launchFingerprintSha256: "0".repeat(64),
      operationNonceSha256: "0".repeat(64),
      privateRootSource: `${policy.privateRootSourceRoot}/validation`,
      workspaceSource: `${policy.workspaceSourceRoot}/validation`,
      workspaceWritable: false,
    }, this.#policy);
  }

  public async create(input: DockerContainerCreate, call: DockerEngineCall): Promise<DockerContainerAuthority> {
    const inputSnapshot = snapshotDockerContainerCreate(input);
    const callSnapshot = snapshotDockerEngineCall(call);
    const canonicalInput = await boundedPreflight(canonicalizeCreateMounts(inputSnapshot, this.#policy), callSnapshot);
    const requestBody = encodeCreateRequest(canonicalInput, this.#policy);
    const engine = await this.#identity(callSnapshot);
    const name = containerName(canonicalInput.operationNonceSha256);
    let id: string;
    try {
      const response = await this.#json("POST", `${API}/containers/create?name=${name}`, callSnapshot, requestBody);
      if (response.statusCode !== 201) {throw statusFailure("create", response.statusCode);}
      id = decodeCreateId(response.value);
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === "aborted") {
        throw new DockerEngineError("create-acknowledgement-unknown");
      }
      if (!(error instanceof DockerEngineError) || ![
        "daemon-disconnected", "deadline-exceeded", "malformed-response", "protocol-violation",
      ].includes(error.code)) {throw error;}
      return this.#resolveLostAcknowledgement(canonicalInput, engine, name, callSnapshot);
    }
    const authority = this.#authority(id, canonicalInput, engine);
    const observation = await this.inspect(authority, callSnapshot);
    if (observation.existence !== "present") {throw new DockerEngineError("authority-conflict");}
    return authority;
  }

  public async inspect(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerContainerObservation> {
    const authoritySnapshot = validateAuthorityShape(authority);
    const callSnapshot = snapshotDockerEngineCall(call);
    const engine = await this.#identity(callSnapshot);
    this.#assertEngine(authoritySnapshot, engine);
    const response = await this.#json("GET", `${API}/containers/${authoritySnapshot.containerId}/json`, callSnapshot);
    const confirmedEngine = await this.#identity(callSnapshot);
    this.#assertEngine(authoritySnapshot, confirmedEngine);
    if (response.statusCode === 404) {
      return { authority: authoritySnapshot, cgroupTree: "unobserved", engine: confirmedEngine, existence: "absent" };
    }
    if (response.statusCode !== 200) {throw statusFailure("inspect", response.statusCode);}
    return decodeInspection(response.value, authoritySnapshot, confirmedEngine, this.#policy);
  }

  public async start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("start", "POST", authority, call);
  }

  public logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    return this.#logs(validateAuthorityShape(authority), snapshotDockerEngineCall(call));
  }

  public async stop(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("stop", "POST", authority, call);
  }

  public async kill(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("kill", "POST", authority, call);
  }

  public async remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("remove", "DELETE", authority, call);
  }

  public async wait(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerContainerObservation> {
    const authoritySnapshot = validateAuthorityShape(authority);
    const callSnapshot = snapshotDockerEngineCall(call);
    const before = await this.inspect(authoritySnapshot, callSnapshot);
    if (before.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
    const response = await this.#json(
      "POST",
      `${API}/containers/${authoritySnapshot.containerId}/wait?condition=not-running`,
      callSnapshot,
    );
    if (response.statusCode !== 200) {throw statusFailure("wait", response.statusCode);}
    const exitCode = decodeWaitExitCode(response.value);
    const after = await this.inspect(authoritySnapshot, callSnapshot);
    if (!isTerminalObservation(after) || after.existence !== "present" || after.state.exitCode !== exitCode) {
      throw new DockerEngineError("terminal-observation-unknown");
    }
    return after;
  }

  async *#logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    const observation = await this.inspect(authority, call);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
    const response = await this.#client.stream({
      call,
      method: "GET",
      path: `${API}/containers/${authority.containerId}/logs?follow=1&stdout=1&stderr=1&timestamps=0&tail=all`,
    });
    if (response.statusCode !== 200) {throw statusFailure("logs", response.statusCode);}
    if (mediaType(response.contentType) !== "application/vnd.docker.raw-stream") {
      throw new DockerEngineError("protocol-violation");
    }
    yield* parseDockerMultiplexedStream(response.body, DOCKER_LOG_MAX_FRAME_BYTES, DOCKER_LOG_MAX_STREAM_BYTES);
    const after = await this.inspect(authority, call);
    if (!isTerminalObservation(after)) {throw new DockerEngineError("terminal-observation-unknown");}
  }

  async #mutate(
    operation: "kill" | "remove" | "start" | "stop",
    method: "DELETE" | "POST",
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<void> {
    const authoritySnapshot = validateAuthorityShape(authority);
    const callSnapshot = snapshotDockerEngineCall(call);
    const observation = await this.inspect(authoritySnapshot, callSnapshot);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
    const path = operation === "start" ? `${API}/containers/${authoritySnapshot.containerId}/start`
      : operation === "stop" ? `${API}/containers/${authoritySnapshot.containerId}/stop?t=10`
        : operation === "kill" ? `${API}/containers/${authoritySnapshot.containerId}/kill?signal=SIGKILL`
          : `${API}/containers/${authoritySnapshot.containerId}?force=0&v=0&link=0`;
    let response: UnixHttpResponse<Uint8Array>;
    try {response = await this.#client.buffered({ call: callSnapshot, method, path });}
    catch (error) {
      if (error instanceof DockerEngineError && ![
        "daemon-disconnected", "deadline-exceeded", "aborted", "protocol-violation", "response-too-large",
      ].includes(error.code)) {throw error;}
      await this.#reconcileMutation(operation, authoritySnapshot, callSnapshot);
      return;
    }
    const accepted = operation === "start" || operation === "stop" ? [204, 304] : [204];
    if (!accepted.includes(response.statusCode)) {
      this.#decodeErrorResponse(response);
      throw statusFailure(operation, response.statusCode);
    }
    if (response.body.byteLength !== 0 || response.contentType !== "") {
      throw new DockerEngineError("protocol-violation");
    }
    await this.#reconcileMutation(operation, authoritySnapshot, callSnapshot);
  }

  async #reconcileMutation(
    operation: "kill" | "remove" | "start" | "stop",
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<void> {
    try {
      const observed = await this.inspect(authority, call);
      const satisfied = mutationPostconditionSatisfied(operation, observed);
      if (!satisfied) {throw new DockerEngineError("mutation-acknowledgement-unknown");}
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === "mutation-acknowledgement-unknown") {throw error;}
      throw new DockerEngineError("mutation-acknowledgement-unknown");
    }
  }

  async #resolveLostAcknowledgement(
    input: DockerContainerCreate,
    originalEngine: DockerEngineIdentity,
    name: string,
    call: DockerEngineCall,
  ): Promise<DockerContainerAuthority> {
    try {
      const currentEngine = await this.#identity(call);
      this.#assertSameEngine(originalEngine, currentEngine);
      const response = await this.#json("GET", `${API}/containers/${name}/json`, call);
      if (response.statusCode !== 200) {throw new DockerEngineError("create-acknowledgement-unknown");}
      const value = response.value as { readonly Id?: unknown };
      const id = typeof value?.Id === "string" ? value.Id : "";
      const authority = this.#authority(id, input, currentEngine);
      decodeInspection(response.value, authority, currentEngine, this.#policy);
      this.#assertSameEngine(currentEngine, await this.#identity(call));
      return authority;
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === "aborted") {throw error;}
      throw new DockerEngineError("create-acknowledgement-unknown");
    }
  }

  #authority(id: string, input: DockerContainerCreate, engine: DockerEngineIdentity): DockerContainerAuthority {
    const authority = {
      containerId: id,
      createSpecificationSha256: createSpecificationSha256(input, this.#policy),
      daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
      daemonIdentitySha256: engine.daemonIdentitySha256,
      hostBootGenerationSha256: engine.hostBootGenerationSha256,
      hostIdentitySha256: engine.hostIdentitySha256,
      imageDigest: input.imageDigest,
      launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256,
    };
    return validateAuthorityShape(authority);
  }

  #assertEngine(authority: DockerContainerAuthority, engine: DockerEngineIdentity): void {
    if (authority.hostIdentitySha256 !== engine.hostIdentitySha256 ||
        authority.daemonIdentitySha256 !== engine.daemonIdentitySha256 ||
        authority.hostBootGenerationSha256 !== engine.hostBootGenerationSha256 ||
        authority.daemonBootGenerationSha256 !== engine.daemonBootGenerationSha256) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  #assertSameEngine(left: DockerEngineIdentity, right: DockerEngineIdentity): void {
    if (left.hostIdentitySha256 !== right.hostIdentitySha256 ||
        left.daemonIdentitySha256 !== right.daemonIdentitySha256 ||
        left.hostBootGenerationSha256 !== right.hostBootGenerationSha256 ||
        left.daemonBootGenerationSha256 !== right.daemonBootGenerationSha256) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  async #identity(call: DockerEngineCall): Promise<DockerEngineIdentity> {
    const before = await this.#client.endpointIdentity(call);
    const response = await this.#json("GET", `${API}/info`, call);
    if (response.statusCode !== 200) {throw statusFailure("info", response.statusCode);}
    const after = await this.#client.endpointIdentity(call);
    if (before.hostBootGenerationSha256 !== after.hostBootGenerationSha256 ||
        before.daemonBootGenerationSha256 !== after.daemonBootGenerationSha256 ||
        before.canonicalSocketPath !== after.canonicalSocketPath) {
      throw new DockerEngineError("daemon-identity-changed");
    }
    return decodeEngineIdentity(response.value, this.#policy, after);
  }

  #decodeErrorResponse(response: UnixHttpResponse<Uint8Array>): void {
    if (response.body.byteLength === 0 || mediaType(response.contentType) !== "application/json") {
      throw new DockerEngineError("protocol-violation");
    }
    decodeErrorResponse(parseStrictJson(response.body));
  }

  async #json(
    method: "GET" | "POST",
    path: string,
    call: DockerEngineCall,
    body?: unknown,
  ): Promise<JsonResponse> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = encoded === undefined
      ? await this.#client.buffered({ call, method, path })
      : await this.#client.buffered({ body: encoded, call, method, path });
    const hasBody = response.body.byteLength !== 0;
    if (hasBody && mediaType(response.contentType) !== "application/json") {
      throw new DockerEngineError("protocol-violation");
    }
    if (!hasBody && response.contentType !== "") {throw new DockerEngineError("protocol-violation");}
    if (!hasBody) {throw new DockerEngineError("protocol-violation");}
    const value = hasBody ? parseStrictJson(response.body) : undefined;
    if (response.statusCode >= 400) {decodeErrorResponse(value);}
    return { statusCode: response.statusCode, value };
  }
}
