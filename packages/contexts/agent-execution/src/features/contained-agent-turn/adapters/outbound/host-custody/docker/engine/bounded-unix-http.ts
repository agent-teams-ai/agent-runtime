import { request } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall } from "./docker-engine-port.js";

const MAX_CALL_MS = 120_000;
const MAX_HEADER_BYTES = 16_384;
const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 262_144;

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

export class BoundedUnixHttpClient {
  readonly #request: (options: RequestOptions) => ClientRequest;
  readonly #socketPath: string;

  public constructor(socketPath: string, requestFactory: (options: RequestOptions) => ClientRequest = request) {
    if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
      throw new DockerEngineError("invalid-create-request");
    }
    this.#request = requestFactory;
    this.#socketPath = socketPath;
  }

  public async buffered(input: Omit<RequestInput, "stream">): Promise<UnixHttpResponse<Uint8Array>> {
    const response = await this.#open({ ...input, stream: false });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        const value = chunk as Uint8Array;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {throw new DockerEngineError("response-too-large");}
        chunks.push(value);
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

  async #open(input: RequestInput): Promise<UnixHttpResponse<AsyncIterable<Uint8Array>>> {
    const now = Date.now();
    if (input.call.signal.aborted) {throw new DockerEngineError("aborted");}
    if (!Number.isSafeInteger(input.call.deadlineEpochMs) || input.call.deadlineEpochMs <= now) {
      throw new DockerEngineError("deadline-exceeded");
    }
    if ((input.body?.byteLength ?? 0) > MAX_REQUEST_BYTES) {
      throw new DockerEngineError("invalid-create-request");
    }
    const effectiveMs = Math.min(input.call.deadlineEpochMs - now, MAX_CALL_MS);
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
        socketPath: this.#socketPath,
      });
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
      const cleanup = (): void => {
        clearTimeout(timer);
        input.call.signal.removeEventListener("abort", abort);
      };
      input.call.signal.addEventListener("abort", abort, { once: true });
      operation.once("error", finishFailure);
      operation.once("response", response => {
        if (headerBytes(response) > MAX_HEADER_BYTES) {
          response.destroy();
          if (!settled) {
            settled = true;
            cleanup();
            reject(new DockerEngineError("response-too-large"));
          }
          return;
        }
        settled = true;
        const body = this.#deadlineBoundBody(response, input.call, timer, abort, () => deadlineExpired);
        resolve({
          body,
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "",
          statusCode: response.statusCode ?? 0,
        });
      });
      operation.end(input.body);
    });
  }

  async *#deadlineBoundBody(
    response: IncomingMessage,
    call: DockerEngineCall,
    timer: NodeJS.Timeout,
    abort: () => void,
    deadlineExpired: () => boolean,
  ): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of response) {yield chunk as Uint8Array;}
    } catch {
      throw failureFor(call, deadlineExpired() || Date.now() >= call.deadlineEpochMs);
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
      if (!response.complete) {response.destroy();}
    }
  }
}
