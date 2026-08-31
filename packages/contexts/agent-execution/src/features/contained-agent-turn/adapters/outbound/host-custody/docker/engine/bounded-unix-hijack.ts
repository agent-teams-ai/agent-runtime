import { Agent } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { Duplex } from "node:stream";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall } from "./docker-engine-port.js";

const MAX_HEADER_BYTES = 16_384;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const ignoreSocketError = (): void => {};

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
  let operation: ClientRequest | undefined;
  let establishmentSocketClose: (() => void) | undefined;
  let establishmentSocketError: ((error: Error) => void) | undefined;
  let establishmentTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;
  const release = async (): Promise<void> => {
    if (released) {return;}
    released = true;
    try {agent.destroy();} catch {}
    try {await input.release();} catch {}
  };
  const cleanupOpening = (removeAbort = true): void => {
    if (establishmentTimer !== undefined) {try {clearTimeout(establishmentTimer);} catch {}}
    if (removeAbort) {try {input.call.signal.removeEventListener("abort", abort);} catch {}}
    try {operation?.removeAllListeners();} catch {}
    if (establishmentSocketError !== undefined) {
      try {input.socket.removeListener("error", establishmentSocketError);} catch {}
    }
    if (establishmentSocketClose !== undefined) {
      try {input.socket.removeListener("close", establishmentSocketClose);} catch {}
    }
  };
  const fail = (error?: unknown): void => {
    if (settled) {return;}
    const primary = error instanceof DockerEngineError ? error : failure(input.call, expired);
    settled = true;
    reject(primary);
    cleanupOpening();
    if (sessionTimer !== undefined) {try {clearTimeout(sessionTimer);} catch {}}
    try {operation?.once("error", ignoreSocketError);} catch {}
    try {operation?.destroy();} catch {}
    try {input.socket.destroy();} catch {}
    void release();
  };
  const abort = (): void => {
    const error = failure(input.call, expired || sessionExpired);
    if (!settled) {fail(error); return;}
    try {input.socket.destroy(error);} catch {}
  };
  establishmentTimer = setTimeout(() => {expired = true; abort();}, input.effectiveMs);
  input.call.signal.addEventListener("abort", abort, {once: true});
  try {
    operation = input.request({
      agent,
      headers: {connection: "Upgrade", host: "docker", upgrade: "tcp"},
      maxHeaderSize: MAX_HEADER_BYTES,
      method: "POST",
      path: input.path,
      setHost: false,
    });
  } catch (error) {fail(error); return;}
  if (settled) {try {operation.destroy();} catch {} return;}
  operation.once("error", fail);
  operation.once("response", response => {
    try {response.destroy();} catch {}
    fail(new DockerEngineError("protocol-violation"));
  });
  operation.once("upgrade", (response, socket, head) => {
    const accept = async (): Promise<void> => {
      try {
        validateUpgrade(response);
        if (socket !== input.socket) {throw new DockerEngineError("endpoint-custody-lost");}
        establishmentSocketError = error => {fail(error);};
        establishmentSocketClose = () => {fail(failure(input.call, expired || sessionExpired));};
        socket.once("error", establishmentSocketError);
        socket.once("close", establishmentSocketClose);
        await input.verifyCustody();
        if (settled) {return;}
        const remaining = input.call.deadlineEpochMs - Date.now();
        if (input.call.signal.aborted) {throw new DockerEngineError("aborted");}
        if (expired || remaining <= 0) {sessionExpired = true; throw new DockerEngineError("deadline-exceeded");}
        if (socket.destroyed || !socket.readable || !socket.writable) {
          throw new DockerEngineError("daemon-disconnected");
        }
        if (head.byteLength > 0) {socket.unshift(head);}
        sessionTimer = setTimeout(() => {sessionExpired = true; abort();}, remaining);
        sessionTimer.unref();
        // Upgrade detaches the socket from ClientRequest error handling. Keep an
        // error sink installed before exposing the hijack so abort cannot race
        // the custody-channel listener installation.
        socket.on("error", ignoreSocketError);
        const close = async (): Promise<void> => {
          if (establishmentTimer !== undefined) {try {clearTimeout(establishmentTimer);} catch {}}
          if (sessionTimer !== undefined) {try {clearTimeout(sessionTimer);} catch {}}
          try {input.call.signal.removeEventListener("abort", abort);} catch {}
          if (!socket.destroyed) {try {socket.destroy();} catch {}}
          await release();
          try {socket.removeListener("error", ignoreSocketError);} catch {}
          try {socket.removeListener("close", lifetimeClose);} catch {}
        };
        const lifetimeClose = (): void => {void close();};
        socket.once("close", lifetimeClose);
        if (establishmentSocketError !== undefined) {socket.removeListener("error", establishmentSocketError);}
        if (establishmentSocketClose !== undefined) {socket.removeListener("close", establishmentSocketClose);}
        settled = true; cleanupOpening(false);
        const output = async function* (): AsyncIterable<Uint8Array> {
          for await (const chunk of socket) {yield chunk as Uint8Array;}
          await input.verifyCustody();
        };
        resolve({close, input: socket, output: output()});
      } catch (error) {fail(error);}
    };
    void accept();
  });
  try {
    if (input.call.signal.aborted) {throw new DockerEngineError("aborted");}
    if (Date.now() >= input.call.deadlineEpochMs) {throw new DockerEngineError("deadline-exceeded");}
    operation.end();
  } catch (error) {fail(error);}
});
