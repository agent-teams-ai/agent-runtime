import { DockerEngineError } from "./docker-engine-error.js";
import {
  canonicalizeCreateMounts,
  containerName,
  decodeCreateId,
  decodeEngineIdentity,
  decodeInspection,
  encodeCreateRequest,
  validateAuthorityShape,
} from "./docker-engine-codec.js";
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

const API = "/v1.47";
const MAX_CALL_MS = 120_000;
interface JsonResponse {
  readonly statusCode: number;
  readonly value: unknown;
}

const parseJson = (body: Uint8Array): unknown => {
  try {return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));}
  catch {throw new DockerEngineError("malformed-response");}
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
    const cleanup = (): void => {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
    };
    call.signal.addEventListener("abort", abort, { once: true });
    const settle = async (): Promise<void> => {
      try {resolve(await work);}
      catch (error) {reject(error);}
      finally {cleanup();}
    };
    void settle();
  });
};

const statusFailure = (statusCode: number): DockerEngineError => {
  if (statusCode === 404) {return new DockerEngineError("resource-not-found", statusCode);}
  if (statusCode === 409) {return new DockerEngineError("resource-already-exists", statusCode);}
  return new DockerEngineError("request-rejected", statusCode);
};

export class NodeUnixSocketDockerEngine implements DockerEnginePort {
  readonly #client: Pick<BoundedUnixHttpClient, "buffered" | "stream">;
  readonly #policy: DockerEnginePolicy;

  public constructor(input: {
    /** Internal protocol-test seam; production construction must supply socketPath. */
    readonly client?: Pick<BoundedUnixHttpClient, "buffered" | "stream">;
    readonly policy: DockerEnginePolicy;
    readonly socketPath?: string;
  }) {
    if (input.client === undefined && input.socketPath === undefined) {
      throw new DockerEngineError("invalid-create-request");
    }
    this.#client = input.client ?? new BoundedUnixHttpClient(input.socketPath ?? "");
    this.#policy = Object.freeze({
      ...input.policy,
      allowedEnvironmentKeys: Object.freeze([...input.policy.allowedEnvironmentKeys]),
    });
    encodeCreateRequest({
      arguments: [],
      entrypoint: "/bin/false",
      environment: {},
      imageDigest: `validation@sha256:${"0".repeat(64)}`,
      launchFingerprintSha256: "0".repeat(64),
      operationNonceSha256: "0".repeat(64),
      privateRootSource: `${input.policy.privateRootSourceRoot}/validation`,
      workspaceSource: `${input.policy.workspaceSourceRoot}/validation`,
      workspaceWritable: false,
    }, this.#policy);
  }

  public async create(input: DockerContainerCreate, call: DockerEngineCall): Promise<DockerContainerAuthority> {
    const canonicalInput = await boundedPreflight(canonicalizeCreateMounts(input, this.#policy), call);
    const requestBody = encodeCreateRequest(canonicalInput, this.#policy);
    const engine = await this.#identity(call);
    const name = containerName(input.operationNonceSha256);
    let id: string;
    try {
      const response = await this.#json("POST", `${API}/containers/create?name=${name}`, call, requestBody);
      if (response.statusCode !== 201) {throw statusFailure(response.statusCode);}
      id = decodeCreateId(response.value);
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === "aborted") {
        throw new DockerEngineError("create-acknowledgement-unknown");
      }
      if (!(error instanceof DockerEngineError) ||
          !["daemon-disconnected", "deadline-exceeded", "malformed-response", "protocol-violation"].includes(error.code)) {
        throw error;
      }
      return this.#resolveLostAcknowledgement(canonicalInput, engine, name, call);
    }
    const authority = this.#authority(id, canonicalInput, engine);
    const observation = await this.inspect(authority, call);
    if (observation.existence !== "present") {throw new DockerEngineError("authority-conflict");}
    return authority;
  }

  public async inspect(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerContainerObservation> {
    validateAuthorityShape(authority);
    const engine = await this.#identity(call);
    this.#assertEngine(authority, engine);
    const response = await this.#json("GET", `${API}/containers/${authority.containerId}/json`, call);
    const confirmedEngine = await this.#identity(call);
    this.#assertEngine(authority, confirmedEngine);
    if (response.statusCode === 404) {
      return { authority, cgroupTree: "unobserved", engine: confirmedEngine, existence: "absent" };
    }
    if (response.statusCode !== 200) {throw statusFailure(response.statusCode);}
    return decodeInspection(response.value, authority, confirmedEngine, this.#policy);
  }

  public async start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("POST", `${API}/containers/${authority.containerId}/start`, authority, call, [204, 304]);
  }

  public logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    return this.#logs(authority, call);
  }

  public async stop(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("POST", `${API}/containers/${authority.containerId}/stop?t=10`, authority, call, [204, 304]);
  }

  public async kill(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("POST", `${API}/containers/${authority.containerId}/kill?signal=SIGKILL`, authority, call, [204]);
  }

  public async remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    await this.#mutate("DELETE", `${API}/containers/${authority.containerId}?force=0&v=0&link=0`, authority, call, [204]);
  }

  async *#logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame> {
    const observation = await this.inspect(authority, call);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
    const response = await this.#client.stream({
      call,
      method: "GET",
      path: `${API}/containers/${authority.containerId}/logs?follow=1&stdout=1&stderr=1&timestamps=0&tail=all`,
    });
    if (response.statusCode !== 200) {throw statusFailure(response.statusCode);}
    if (mediaType(response.contentType) !== "application/vnd.docker.raw-stream") {
      throw new DockerEngineError("protocol-violation");
    }
    yield* parseDockerMultiplexedStream(response.body, DOCKER_LOG_MAX_FRAME_BYTES, DOCKER_LOG_MAX_STREAM_BYTES);
    this.#assertEngine(authority, await this.#identity(call));
  }

  async #mutate(
    method: "DELETE" | "POST",
    path: string,
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
    accepted: readonly number[],
  ): Promise<void> {
    const observation = await this.inspect(authority, call);
    if (observation.existence !== "present") {throw new DockerEngineError("resource-not-found", 404);}
    const response = await this.#client.buffered({ call, method, path });
    if (!accepted.includes(response.statusCode)) {throw statusFailure(response.statusCode);}
    if (response.body.byteLength !== 0) {throw new DockerEngineError("protocol-violation");}
    this.#assertEngine(authority, await this.#identity(call));
  }

  async #resolveLostAcknowledgement(
    input: DockerContainerCreate,
    originalEngine: DockerEngineIdentity,
    name: string,
    call: DockerEngineCall,
  ): Promise<DockerContainerAuthority> {
    try {
      const currentEngine = await this.#identity(call);
      if (currentEngine.daemonIdentitySha256 !== originalEngine.daemonIdentitySha256) {
        throw new DockerEngineError("create-acknowledgement-unknown");
      }
      const response = await this.#json("GET", `${API}/containers/${name}/json`, call);
      if (response.statusCode !== 200) {throw new DockerEngineError("create-acknowledgement-unknown");}
      const value = response.value as { readonly Id?: unknown };
      const id = typeof value?.Id === "string" ? value.Id : "";
      const authority = this.#authority(id, input, currentEngine);
      decodeInspection(response.value, authority, currentEngine, this.#policy);
      this.#assertEngine(authority, await this.#identity(call));
      return authority;
    } catch (error) {
      if (error instanceof DockerEngineError && error.code === "aborted") {throw error;}
      throw new DockerEngineError("create-acknowledgement-unknown");
    }
  }

  #authority(
    id: string,
    input: DockerContainerCreate,
    engine: DockerEngineIdentity,
  ): DockerContainerAuthority {
    const authority = {
      containerId: id,
      daemonIdentitySha256: engine.daemonIdentitySha256,
      hostIdentitySha256: engine.hostIdentitySha256,
      imageDigest: input.imageDigest,
      launchFingerprintSha256: input.launchFingerprintSha256,
      operationNonceSha256: input.operationNonceSha256,
    };
    validateAuthorityShape(authority);
    return authority;
  }

  #assertEngine(authority: DockerContainerAuthority, engine: DockerEngineIdentity): void {
    if (authority.hostIdentitySha256 !== engine.hostIdentitySha256 ||
        authority.daemonIdentitySha256 !== engine.daemonIdentitySha256) {
      throw new DockerEngineError("daemon-identity-changed");
    }
  }

  async #identity(call: DockerEngineCall): Promise<DockerEngineIdentity> {
    const response = await this.#json("GET", `${API}/info`, call);
    if (response.statusCode !== 200) {throw statusFailure(response.statusCode);}
    return decodeEngineIdentity(response.value, this.#policy);
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
    return { statusCode: response.statusCode, value: hasBody ? parseJson(response.body) : undefined };
  }
}
