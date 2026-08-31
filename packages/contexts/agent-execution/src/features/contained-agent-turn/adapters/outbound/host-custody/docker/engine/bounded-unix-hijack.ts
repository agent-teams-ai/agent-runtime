import { Agent } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { Duplex } from "node:stream";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall } from "./docker-engine-port.js";

const MAX_HEADER_BYTES = 16_384;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export interface UnixHijackChannel {
  readonly input: Duplex;
  readonly output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

interface HijackInput {
  readonly call: DockerEngineCall;
  readonly effectiveMs: number;
  readonly path: string;
  readonly release: () => Promise<void>;
  readonly request: (options: RequestOptions) => ClientRequest;
  readonly socket: Duplex;
  readonly verifyCustody: () => Promise<void>;
}

const responseHeaderBytes = (response: IncomingMessage): number => response.rawHeaders.reduce(
  (total, part) => total + Buffer.byteLength(part),
  0,
);

const validateUpgrade = (response: IncomingMessage): void => {
  if (response.httpVersion !== "1.1" || response.statusCode !== 101 ||
      response.rawHeaders.length % 2 !== 0 || responseHeaderBytes(response) > MAX_HEADER_BYTES) {
    throw new DockerEngineError(responseHeaderBytes(response) > MAX_HEADER_BYTES ? "response-too-large" : "protocol-violation");
  }
  const headers = new Map<string, string>();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const rawName = response.rawHeaders[index];
    const rawValue = response.rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined || !HEADER_NAME.test(rawName) || /[\r\n]/u.test(rawValue)) {
      throw new DockerEngineError("protocol-violation");
    }
    const name = rawName.toLowerCase();
    if (headers.has(name)) {throw new DockerEngineError("protocol-violation");}
    headers.set(name, rawValue.trim().toLowerCase());
  }
  if (headers.get("connection") !== "upgrade" || headers.get("upgrade") !== "tcp" ||
      headers.get("content-type") !== "application/vnd.docker.raw-stream" ||
      headers.has("content-length") || headers.has("transfer-encoding")) {
    throw new DockerEngineError("protocol-violation");
  }
};

const failure = (call: DockerEngineCall, expired: boolean): DockerEngineError => {
  if (call.signal.aborted) {return new DockerEngineError("aborted");}
  return new DockerEngineError(expired ? "deadline-exceeded" : "daemon-disconnected");
};

export const openBoundedUnixHijack = (input: HijackInput): Promise<UnixHijackChannel> => new Promise((resolve, reject) => {
  const agent = new Agent({keepAlive: false, maxSockets: 1});
  agent.createConnection = () => input.socket;
  let expired = false;
  let sessionExpired = false;
  let settled = false;
  let released = false;
  let sessionTimer: NodeJS.Timeout | undefined;
  const release = async (): Promise<void> => {
    if (released) {return;}
    released = true; agent.destroy(); await input.release();
  };
  const operation = input.request({
    agent,
    headers: {connection: "Upgrade", host: "docker", upgrade: "tcp"},
    maxHeaderSize: MAX_HEADER_BYTES,
    method: "POST",
    path: input.path,
    setHost: false,
  });
  const abort = (): void => {
    const error = failure(input.call, expired || sessionExpired);
    if (!settled) {operation.destroy(error);}
    input.socket.destroy(error);
  };
  const establishmentTimer = setTimeout(() => {expired = true; abort();}, input.effectiveMs);
  const cleanupOpening = (): void => {
    operation.removeAllListeners();
  };
  const fail = (error?: unknown): void => {
    if (settled) {return;}
    settled = true; clearTimeout(establishmentTimer); if (sessionTimer !== undefined) {clearTimeout(sessionTimer);}
    input.call.signal.removeEventListener("abort", abort);
    input.socket.destroy(); void release();
    reject(error instanceof DockerEngineError ? error : failure(input.call, expired));
  };
  input.call.signal.addEventListener("abort", abort, {once: true});
  operation.once("error", fail);
  operation.once("response", response => {response.destroy(); fail(new DockerEngineError("protocol-violation"));});
  operation.once("upgrade", (response, socket, head) => {
    const accept = async (): Promise<void> => {
      try {
        validateUpgrade(response);
        if (socket !== input.socket) {throw new DockerEngineError("endpoint-custody-lost");}
        await input.verifyCustody();
        if (head.byteLength > 0) {socket.unshift(head);}
        clearTimeout(establishmentTimer);
        const remaining = input.call.deadlineEpochMs - Date.now();
        if (remaining <= 0) {sessionExpired = true; throw new DockerEngineError("deadline-exceeded");}
        sessionTimer = setTimeout(() => {sessionExpired = true; abort();}, remaining);
        sessionTimer.unref();
        settled = true; cleanupOpening();
        const close = async (): Promise<void> => {
          clearTimeout(establishmentTimer); if (sessionTimer !== undefined) {clearTimeout(sessionTimer);}
          input.call.signal.removeEventListener("abort", abort);
          if (!socket.destroyed) {socket.destroy();}
          await release();
        };
        const output = async function* (): AsyncIterable<Uint8Array> {
          for await (const chunk of socket) {yield chunk as Uint8Array;}
          await input.verifyCustody();
        };
        socket.once("close", () => {void close();});
        resolve({close, input: socket, output: output()});
      } catch (error) {fail(error);}
    };
    void accept();
  });
  operation.end();
});
