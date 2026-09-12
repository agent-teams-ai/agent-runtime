import fs from "node:fs";

import { createNodeHostHttpConsumptionJournal } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js";

export const digest = character => `sha256:${character.repeat(64)}`;
export const envelope = Object.freeze({
  tenantId: "tenant:one", projectId: "project:one", operationId: "operation:one",
  scopeDigest: digest("a"), attemptId: "attempt:one", custodyId: "custody:one",
  hostInstanceId: "host:one", hostBootId: "boot:one", executionGenerationId: "generation:one",
  selectedDockerAuthorityDigest: digest("b"), networkNamespaceIdentity: "netns:one",
  cgroupIdentity: "cgroup:one", listenerIdentity: "listener:one", signerIdentity: "signer:one",
});
export const key = (boundaryUseId = "boundary:one") => ({
  namespace: "provider-process-egress/v2", tenantId: envelope.tenantId,
  projectId: envelope.projectId, operationId: envelope.operationId, boundaryUseId,
});
export const pin = path => {
  const stats = fs.lstatSync(path, { bigint: true });
  return { path, device: String(stats.dev), inode: String(stats.ino) };
};

// This helper is executed only by the disposable filesystem tests. It has no
// provider/runtime command, network, credentials, or worker orchestration.
if (process.argv[2] === "--crash-fixture") {
  const directory = JSON.parse(process.argv[3]);
  const phase = process.argv[4];
  const write = fs.writeSync;
  const datasync = fs.fdatasyncSync;
  let writes = 0;
  let syncs = 0;
  const stop = () => {
    write(1, `stopped:${phase}\n`);
    process.kill(process.pid, "SIGSTOP");
    throw new Error("crash fixture must be killed, never resumed");
  };
  fs.writeSync = (fd, bytes, ...args) => {
    writes += 1;
    if ((phase === "partial-header" && writes === 1) || (phase === "partial-record" && writes === 2)) {
      write(fd, bytes, 0, 17, null);
      stop();
    }
    return write(fd, bytes, ...args);
  };
  fs.fdatasyncSync = fd => {
    datasync(fd);
    syncs += 1;
    if ((phase === "header-sync" && syncs === 1) || (phase === "record-sync" && syncs === 2)) { stop(); }
  };
  const prepared = await createNodeHostHttpConsumptionJournal({ directory, envelope }).prepare();
  if (prepared.kind !== "ready") { throw new Error(`fixture preparation: ${prepared.kind}`); }
  if (phase === "after-header") { stop(); }
  if (prepared.journal.consume(key(), digest("c")) !== "consumed") { throw new Error("fixture consume failed"); }
  stop();
}
