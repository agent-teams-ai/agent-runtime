import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir, realpath } from "node:fs/promises";
import { request } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall, DockerEnginePolicy } from "./docker-engine-port.js";

const HOST_BOOT_ID = "/proc/sys/kernel/random/boot_id";
const MAX_CALL_MS = 120_000;
const MAX_HEADER_BYTES = 16_384;
const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 262_144;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export interface DockerEndpointIdentity {
  readonly canonicalSocketPath: string;
  readonly daemonBootGenerationSha256: string;
  readonly hostBootGenerationSha256: string;
}

export interface UnixHttpResponse<T> {
  readonly body: T;
  readonly contentType: string;
  readonly statusCode: number;
}

interface RequestInput {
  readonly body?: Uint8Array;
  readonly call: DockerEngineCall;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly stream: boolean;
}

interface SocketCustody {
  readonly identity: DockerEndpointIdentity;
  readonly token: string;
}

export interface DockerEndpointObservation {
  readonly canonicalSocketPath: string;
  readonly ctimeNs: bigint;
  readonly daemonBootGeneration: string;
  readonly daemonCustodyToken: string;
  readonly device: bigint;
  readonly gid: bigint;
  readonly hostBootId: string;
  readonly inode: bigint;
  readonly mode: number;
  readonly socket: boolean;
  readonly symbolicLink: boolean;
  readonly uid: bigint;
}

type EndpointPolicy = Pick<DockerEnginePolicy,
  | "daemonPidFileMode"
  | "daemonPidFileOwnerGid"
  | "daemonPidFileOwnerUid"
  | "daemonPidFilePath"
  | "socketMode"
  | "socketOwnerGid"
  | "socketOwnerUid"
  | "socketPath"
>;

const processStartTicks = async (pid: number): Promise<string> => {
  const source = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = source.slice(source.lastIndexOf(") ") + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(startTicks)) {
    throw new DockerEngineError("endpoint-custody-lost");
  }
  return startTicks;
};

const socketKernelInode = async (socketPath: string): Promise<string> => {
  const matches = (await readFile("/proc/net/unix", "utf8")).split("\n").slice(1).flatMap(line => {
    const fields = line.trim().split(/\s+/u);
    return fields[7] === socketPath && /^(?:0|[1-9][0-9]*)$/u.test(fields[6] ?? "") ? [fields[6] ?? ""] : [];
  });
  if (matches.length !== 1) {throw new DockerEngineError("endpoint-custody-lost");}
  return matches[0] ?? "";
};

const daemonOwnsSocket = async (pid: number, inode: string): Promise<boolean> => {
  const directory = `/proc/${pid}/fd`;
  const descriptors = await readdir(directory);
  const links = await Promise.all(descriptors.map(async descriptor => {
    try {return await readlink(`${directory}/${descriptor}`);} catch {return "";}
  }));
  return links.includes(`socket:[${inode}]`);
};

const observeDaemon = async (policy: EndpointPolicy): Promise<{
  readonly generation: string;
  readonly token: string;
}> => {
  const [canonicalPath, facts, rawPid] = await Promise.all([
    realpath(policy.daemonPidFilePath),
    lstat(policy.daemonPidFilePath, { bigint: true }),
    readFile(policy.daemonPidFilePath, "utf8"),
  ]);
  const pidValue = rawPid.trim();
  if (!/^[1-9][0-9]{0,8}$/u.test(pidValue)) {throw new DockerEngineError("endpoint-custody-lost");}
  const pid = Number(pidValue);
  if (canonicalPath !== policy.daemonPidFilePath || facts.isSymbolicLink() || !facts.isFile() ||
      Number(facts.uid) !== policy.daemonPidFileOwnerUid || Number(facts.gid) !== policy.daemonPidFileOwnerGid ||
      Number(facts.mode & 0o777n) !== policy.daemonPidFileMode) {
    throw new DockerEngineError("endpoint-custody-lost");
  }
  const [before, inode] = await Promise.all([processStartTicks(pid), socketKernelInode(policy.socketPath)]);
  if (!await daemonOwnsSocket(pid, inode) || await processStartTicks(pid) !== before) {
    throw new DockerEngineError("endpoint-custody-lost");
  }
  return {
    generation: JSON.stringify([pidValue, before, inode]),
    token: JSON.stringify([
      canonicalPath, facts.dev.toString(), facts.ino.toString(), facts.ctimeNs.toString(),
      facts.uid.toString(), facts.gid.toString(), Number(facts.mode & 0o777n), pidValue, before, inode,
    ]),
  };
};

const observeEndpoint = async (policy: EndpointPolicy): Promise<DockerEndpointObservation> => {
  const [canonicalSocketPath, facts, rawBootId] = await Promise.all([
    realpath(policy.socketPath),
    lstat(policy.socketPath, { bigint: true }),
    readFile(HOST_BOOT_ID, "utf8"),
  ]);
  const daemon = await observeDaemon(policy);
  return {
    canonicalSocketPath,
    ctimeNs: facts.ctimeNs,
    daemonBootGeneration: daemon.generation,
    daemonCustodyToken: daemon.token,
    device: facts.dev,
    gid: facts.gid,
    hostBootId: rawBootId.trim().toLowerCase(),
    inode: facts.ino,
    mode: Number(facts.mode & 0o777n),
    socket: facts.isSocket(),
    symbolicLink: facts.isSymbolicLink(),
    uid: facts.uid,
  };
};

const invalidEndpointPaths = (policy: EndpointPolicy): boolean =>
  !isAbsolute(policy.socketPath) || policy.socketPath !== resolvePath(policy.socketPath) ||
  policy.socketPath.includes("\0") || !isAbsolute(policy.daemonPidFilePath) ||
  policy.daemonPidFilePath !== resolvePath(policy.daemonPidFilePath) ||
  policy.daemonPidFilePath.includes("\0") || policy.daemonPidFilePath === policy.socketPath;

const invalidEndpointOwnership = (policy: EndpointPolicy): boolean =>
  !Number.isSafeInteger(policy.socketOwnerUid) || !Number.isSafeInteger(policy.socketOwnerGid) ||
  policy.socketOwnerUid < 0 || policy.socketOwnerGid < 0 || !Number.isSafeInteger(policy.socketMode) ||
  policy.socketMode < 0 || policy.socketMode > 0o777 || !Number.isSafeInteger(policy.daemonPidFileOwnerUid) ||
  !Number.isSafeInteger(policy.daemonPidFileOwnerGid) || policy.daemonPidFileOwnerUid < 0 ||
  policy.daemonPidFileOwnerGid < 0 || !Number.isSafeInteger(policy.daemonPidFileMode) ||
  policy.daemonPidFileMode < 0 || policy.daemonPidFileMode > 0o777;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const failureFor = (call: DockerEngineCall, deadlineExpired: boolean): DockerEngineError => {
  if (call.signal.aborted) {return new DockerEngineError("aborted");}
  return new DockerEngineError(deadlineExpired ? "deadline-exceeded" : "daemon-disconnected");
};

const requestFailureFor = (
  error: unknown,
  call: DockerEngineCall,
  deadlineExpired: boolean,
): DockerEngineError => {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (code === "HPE_HEADER_OVERFLOW") {return new DockerEngineError("response-too-large");}
  if (typeof code === "string" && code.startsWith("HPE_")) {return new DockerEngineError("protocol-violation");}
  return failureFor(call, deadlineExpired);
};

const headerBytes = (response: IncomingMessage): number => response.rawHeaders.reduce(
  (total, part) => total + Buffer.byteLength(part),
  0,
);

const validateResponseHeaders = (response: IncomingMessage): string => {
  if (response.rawHeaders.length % 2 !== 0) {throw new DockerEngineError("protocol-violation");}
  const seen = new Set<string>();
  let contentType = "";
  let hasContentLength = false;
  let hasTransferEncoding = false;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const rawName = response.rawHeaders[index];
    const rawValue = response.rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined || !HEADER_NAME.test(rawName) || /[\r\n]/u.test(rawValue)) {
      throw new DockerEngineError("protocol-violation");
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) {throw new DockerEngineError("protocol-violation");}
    seen.add(name);
    if (name === "content-type") {contentType = rawValue;}
    if (name === "content-length") {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(rawValue)) {throw new DockerEngineError("protocol-violation");}
      hasContentLength = true;
    }
    if (name === "transfer-encoding") {hasTransferEncoding = true;}
  }
  if (hasContentLength && hasTransferEncoding) {throw new DockerEngineError("protocol-violation");}
  return contentType;
};

export class BoundedUnixHttpClient {
  readonly #policy: EndpointPolicy;
  readonly #request: (options: RequestOptions) => ClientRequest;
  readonly #observeEndpoint: (policy: EndpointPolicy) => Promise<DockerEndpointObservation>;
  #baselineToken: string | undefined;

  public constructor(
    policy: EndpointPolicy,
    requestFactory: (options: RequestOptions) => ClientRequest = request,
    endpointObserver: (policy: EndpointPolicy) => Promise<DockerEndpointObservation> = observeEndpoint,
  ) {
    if (invalidEndpointPaths(policy) || invalidEndpointOwnership(policy)) {
      throw new DockerEngineError("invalid-create-request");
    }
    this.#policy = Object.freeze({ ...policy });
    this.#request = requestFactory;
    this.#observeEndpoint = endpointObserver;
  }

  public async endpointIdentity(call: DockerEngineCall): Promise<DockerEndpointIdentity> {
    this.#checkCall(call);
    return (await this.#observeCustody()).identity;
  }

  public async buffered(input: Omit<RequestInput, "stream">): Promise<UnixHttpResponse<Uint8Array>> {
    const response = await this.#open({ ...input, stream: false });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {throw new DockerEngineError("response-too-large");}
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof DockerEngineError) {throw error;}
      throw failureFor(input.call, Date.now() >= input.call.deadlineEpochMs);
    }
    return { ...response, body: Buffer.concat(chunks, bytes) };
  }

  public stream(input: Omit<RequestInput, "stream">): Promise<UnixHttpResponse<AsyncIterable<Uint8Array>>> {
    return this.#open({ ...input, stream: true });
  }

  async #observeCustody(): Promise<SocketCustody> {
    try {
      const observation = await this.#observeEndpoint(this.#policy);
      if (observation.canonicalSocketPath !== this.#policy.socketPath || observation.symbolicLink ||
          !observation.socket || Number(observation.uid) !== this.#policy.socketOwnerUid ||
          Number(observation.gid) !== this.#policy.socketOwnerGid || observation.mode !== this.#policy.socketMode ||
          !BOOT_ID.test(observation.hostBootId)) {
        throw new DockerEngineError("endpoint-custody-lost");
      }
      const token = JSON.stringify([
        observation.canonicalSocketPath, observation.device.toString(), observation.inode.toString(),
        observation.ctimeNs.toString(), observation.uid.toString(), observation.gid.toString(), observation.mode,
        observation.daemonCustodyToken,
      ]);
      if (this.#baselineToken !== undefined && token !== this.#baselineToken) {
        throw new DockerEngineError("endpoint-custody-lost");
      }
      this.#baselineToken ??= token;
      return {
        identity: {
          canonicalSocketPath: observation.canonicalSocketPath,
          daemonBootGenerationSha256: hash(observation.daemonBootGeneration),
          hostBootGenerationSha256: hash(observation.hostBootId),
        },
        token,
      };
    } catch (error) {
      if (error instanceof DockerEngineError) {throw error;}
      throw new DockerEngineError("endpoint-custody-lost");
    }
  }

  #checkCall(call: DockerEngineCall): void {
    if (call.signal.aborted) {throw new DockerEngineError("aborted");}
    if (!Number.isSafeInteger(call.deadlineEpochMs) || call.deadlineEpochMs <= Date.now()) {
      throw new DockerEngineError("deadline-exceeded");
    }
  }

  async #open(input: RequestInput): Promise<UnixHttpResponse<AsyncIterable<Uint8Array>>> {
    this.#checkCall(input.call);
    if ((input.body?.byteLength ?? 0) > MAX_REQUEST_BYTES) {
      throw new DockerEngineError("invalid-create-request");
    }
    if (!input.path.startsWith("/") || input.path.length > 4096 || input.path.includes("\0") ||
        input.path.includes("\r") || input.path.includes("\n")) {
      throw new DockerEngineError("protocol-violation");
    }
    const custody = await this.#observeCustody();
    const effectiveMs = Math.min(input.call.deadlineEpochMs - Date.now(), MAX_CALL_MS);
    if (effectiveMs <= 0) {throw new DockerEngineError("deadline-exceeded");}
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadlineExpired = false;
      const operation = this.#request({
        headers: input.body === undefined ? undefined : {
          "content-length": String(input.body.byteLength),
          "content-type": "application/json",
        },
        maxHeaderSize: MAX_HEADER_BYTES,
        method: input.method,
        path: input.path,
        setHost: false,
        socketPath: custody.identity.canonicalSocketPath,
      });
      const cleanup = (): void => {
        clearTimeout(timer);
        input.call.signal.removeEventListener("abort", abort);
      };
      const finishFailure = (error: unknown): void => {
        if (settled) {return;}
        settled = true;
        cleanup();
        reject(requestFailureFor(error, input.call, deadlineExpired));
      };
      const abort = (): void => {operation.destroy();};
      const timer = setTimeout(() => {
        deadlineExpired = true;
        operation.destroy();
      }, effectiveMs);
      input.call.signal.addEventListener("abort", abort, { once: true });
      operation.once("error", finishFailure);
      operation.once("response", response => {
        const settle = async (): Promise<void> => {
          try {
            if (headerBytes(response) > MAX_HEADER_BYTES) {throw new DockerEngineError("response-too-large");}
            const contentType = validateResponseHeaders(response);
            if (!Number.isSafeInteger(response.statusCode) || (response.statusCode ?? 0) < 100 ||
                (response.statusCode ?? 0) > 599) {throw new DockerEngineError("protocol-violation");}
            const current = await this.#observeCustody();
            if (current.token !== custody.token) {throw new DockerEngineError("endpoint-custody-lost");}
            settled = true;
            resolve({
              body: this.#deadlineBoundBody(response, input.call, timer, abort, custody.token),
              contentType,
              statusCode: response.statusCode ?? 0,
            });
          } catch (error) {
            response.destroy();
            if (!settled) {settled = true; cleanup(); reject(error);}
          }
        };
        void settle();
      });
      operation.end(input.body);
    });
  }

  async *#deadlineBoundBody(
    response: IncomingMessage,
    call: DockerEngineCall,
    timer: NodeJS.Timeout,
    abort: () => void,
    custodyToken: string,
  ): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of response) {yield chunk as Uint8Array;}
      const custody = await this.#observeCustody();
      if (!response.complete || custody.token !== custodyToken) {throw new DockerEngineError("endpoint-custody-lost");}
    } catch (error) {
      if (error instanceof DockerEngineError) {throw error;}
      throw failureFor(call, Date.now() >= call.deadlineEpochMs);
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
      if (!response.complete) {response.destroy();}
    }
  }
}
