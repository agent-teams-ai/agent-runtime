import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { basename, dirname } from "node:path";

import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerEngineCall } from "./docker-engine-port.js";
import type { EndpointPolicy, SocketCustody } from "./bounded-unix-http.js";

const MAX_CALL_MS = 120_000;
const LINUX_O_PATH = 0x20_0000;

export interface AuthenticatedUnixConnection {
  readonly release: () => Promise<void>;
  readonly socket: Socket;
}

export type DockerPeerConnector = (
  policy: EndpointPolicy,
  custody: SocketCustody,
  call: DockerEngineCall,
  observeCustody: () => Promise<SocketCustody>,
) => Promise<AuthenticatedUnixConnection>;

const connectionFailure = (call: DockerEngineCall): DockerEngineError =>
  new DockerEngineError(call.signal.aborted ? "aborted" : "endpoint-custody-lost");

const awaitConnection = async (socket: Socket, call: DockerEngineCall): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const remaining = Math.min(call.deadlineEpochMs - Date.now(), MAX_CALL_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", abort);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
    };
    const finish = (work: () => void): void => {
      if (settled) {return;}
      settled = true;
      cleanup();
      work();
    };
    const connected = (): void => {finish(resolve);};
    const failed = (): void => {finish(() => {reject(new DockerEngineError("endpoint-custody-lost"));});};
    const abort = (): void => {socket.destroy(); finish(() => {reject(connectionFailure(call));});};
    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => {reject(new DockerEngineError("deadline-exceeded"));});
    }, Math.max(1, remaining));
    call.signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", connected);
    socket.once("error", failed);
  });

export const connectAuthenticatedUnixPeer: DockerPeerConnector = async (policy, custody, call, observeCustody) => {
  const parent = await open(
    dirname(policy.socketPath),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let endpoint: Awaited<ReturnType<typeof open>> | undefined;
  let socket: Socket | undefined;
  try {
    const parentFacts = await parent.stat({ bigint: true });
    if (!parentFacts.isDirectory()) {throw new DockerEngineError("endpoint-custody-lost");}
    const pinnedPath = `/proc/self/fd/${parent.fd}/${basename(policy.socketPath)}`;
    endpoint = await open(pinnedPath, LINUX_O_PATH | fsConstants.O_NOFOLLOW);
    const endpointFacts = await endpoint.stat({ bigint: true });
    const beforeConnect = await observeCustody();
    if (beforeConnect.token !== custody.token || endpointFacts.dev !== custody.device || endpointFacts.ino !== custody.inode ||
        !endpointFacts.isSocket()) {
      throw new DockerEngineError("endpoint-custody-lost");
    }
    socket = createConnection({ path: pinnedPath });
    await awaitConnection(socket, call);
    const [afterConnect, currentParentFacts] = await Promise.all([observeCustody(), parent.stat({ bigint: true })]);
    if (afterConnect.token !== custody.token || afterConnect.daemonPid !== custody.daemonPid ||
        afterConnect.daemonStartTicks !== custody.daemonStartTicks || currentParentFacts.dev !== parentFacts.dev ||
        currentParentFacts.ino !== parentFacts.ino || currentParentFacts.ctimeNs !== parentFacts.ctimeNs) {
      throw new DockerEngineError("endpoint-custody-lost");
    }
    const heldEndpoint = endpoint;
    const connectedSocket = socket;
    let released = false;
    return {
      release: async () => {
        if (released) {return;}
        released = true;
        connectedSocket.destroy();
        await Promise.allSettled([heldEndpoint.close(), parent.close()]);
      },
      socket: connectedSocket,
    };
  } catch (error) {
    socket?.destroy();
    await Promise.allSettled([endpoint?.close(), parent.close()]);
    if (error instanceof DockerEngineError) {throw error;}
    throw new DockerEngineError("endpoint-custody-lost");
  }
};
