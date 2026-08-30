import assert from "node:assert/strict";
import { chmod, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { BoundedUnixHttpClient } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/bounded-unix-http.js";
import type {
  DockerEngineCall,
  DockerEnginePolicy,
} from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";

export const verifyProductionUnixPeerBinding = async (
  context: TestContext,
  disposable: () => Promise<string>,
  policy: (root: string) => DockerEnginePolicy,
  call: () => DockerEngineCall,
): Promise<void> => {
  const root = await disposable();
  const socketPath = join(root, "engine.sock");
  const daemonPidFilePath = join(root, "engine.pid");
  const body = Buffer.from("{\"qualified\":true}");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": String(body.byteLength),
      "content-type": "application/json",
    });
    response.end(body);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.skip("Unix-domain listeners are denied by the current test sandbox");
      return;
    }
    throw error;
  }
  await Promise.all([
    chmod(socketPath, 0o600),
    writeFile(daemonPidFilePath, `${process.pid}\n`, { mode: 0o600 }),
  ]);
  context.after(async () => {
    await new Promise<void>(resolve => {server.close(() => {resolve();});});
    await rm(root, { force: true, recursive: true });
  });
  const endpointPolicy = policy(root);
  const client = new BoundedUnixHttpClient({
    daemonPidFileMode: endpointPolicy.daemonPidFileMode,
    daemonPidFileOwnerGid: endpointPolicy.daemonPidFileOwnerGid,
    daemonPidFileOwnerUid: endpointPolicy.daemonPidFileOwnerUid,
    daemonPidFilePath,
    socketMode: 0o600,
    socketOwnerGid: endpointPolicy.socketOwnerGid,
    socketOwnerUid: endpointPolicy.socketOwnerUid,
    socketPath,
  });
  const response = await client.buffered({ call: call(), method: "GET", path: "/v1.47/info" });
  assert.equal(Buffer.from(response.body).toString("utf8"), body.toString("utf8"));
};
