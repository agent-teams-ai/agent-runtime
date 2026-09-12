import type {FakeDockerEngine} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import type {DockerCustodyInitHostOptions} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-host-session.js";
import {DOCKER_CUSTODY_INIT_PROTOCOL, DockerCustodyFrameDecoder, encodeDockerCustodyFrame,
  type DockerCustodyProtocolMessage} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {digest} from "./docker-host-custody-lifecycle-fixture.ts";

export const providerExec = Object.freeze({argv: ["provider-entrypoint"], environment: [], executableSha256: digest("provider"),
  gid: 1000, requestId: "request:synthetic", uid: 1000, wallDeadlineUnixMs: 9_999_999_999_999});
export const initOptions = (): Omit<DockerCustodyInitHostOptions, "channel"> => ({
  authority: {expectedIdentity: {containerImageSha256: digest("image"), initBinarySha256: digest("init"),
    privateRootIdentity: "private:synthetic", protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
    securityProfileIdentity: "security:synthetic", workspaceIdentity: "workspace:synthetic"},
  generation: "generation:synthetic", launchFingerprintSha256: digest("launch"), operationNonce: "operation"},
  acknowledgementTimeoutMs: 50, readyTimeoutMs: 50, maximumStderrBytes: 100, maximumStdoutBytes: 100,
  isCurrentGeneration: () => true,
});

/** Fake Docker still owns create/attach/start identity; this in-memory channel supplies only synthetic init frames. */
export const installSyntheticInit = (engine: FakeDockerEngine, events: string[] = [], acknowledge = true) => {
  const attach = engine.attachCustody.bind(engine);
  let pending: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  const values: Uint8Array[] = []; let closed = false; let attaches = 0; let closes = 0;
  const push = (message: DockerCustodyProtocolMessage) => {
    const bytes = encodeDockerCustodyFrame(message);
    if (pending === undefined) {values.push(bytes);} else {const done = pending; pending = undefined; done({done: false, value: bytes});}
  };
  engine.attachCustody = async (authority, call) => {
    attaches += 1; const original = await attach(authority, call); events.push("attach");
    return {
      async close() {closes += 1; closed = true; pending?.({done: true, value: undefined}); pending = undefined; await original.close();},
      closeInput: original.closeInput,
      output: {[Symbol.asyncIterator]() {events.push("init-reader"); return {
        next() {
          const value = values.shift();
          if (value !== undefined) {return Promise.resolve({done: false as const, value});}
          if (closed) {return Promise.resolve({done: true as const, value: undefined});}
          return new Promise<IteratorResult<Uint8Array>>(resolve => {pending = resolve;});
        },
        async return() {return {done: true as const, value: undefined};},
      };}},
      async write(bytes) {
        await original.write(bytes);
        for (const message of new DockerCustodyFrameDecoder().push(bytes)) {
          events.push(message.kind);
          if (message.kind === "host-handshake") {
            push({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
              nonce: message.nonce, observedIdentity: message.expectedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL});
          }
          if (message.kind === "provider-exec" && acknowledge) {
            push({kind: "provider-exec-ack", observation: "started", requestId: message.requestId});
          }
        }
      },
    };
  };
  return {get attaches() {return attaches;}, get closes() {return closes;}, push};
};
