import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import type {Socket} from "node:net";
import {PassThrough, Writable} from "node:stream";
import type {TestContext} from "node:test";
import {createDockerHostCustodyLifecycle} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {FakeDockerEngine} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {createDockerCustodyChannel} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-custody-channel.js";
import {DockerCustodyFrameDecoder, encodeDockerCustodyFrame, DOCKER_CUSTODY_INIT_PROTOCOL,
  type DockerCustodyProtocolMessage} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {MemoryStorage, createInput, disposable, engineCall, owner, policy} from "./docker-host-custody-lifecycle-fixture.ts";
import {initOptions, providerExec} from "./docker-claim-init-fixture.ts";

export {engineCall, initOptions, providerExec};
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
export const deferred = () => Promise.withResolvers<void>();
export const stdout = Buffer.from([0, 0xff, 0x0a, 0xc3, 0xa9]);
export const stderr = Buffer.from([0xfe, 0x00, 0x0d]);

/** Disposable fake Engine plus the actual Docker channel, over memory streams only. */
export const fixture = async (t: TestContext) => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const engine = new FakeDockerEngine(policy(root)); const storage = new MemoryStorage();
  const events: string[] = []; const wire: DockerCustodyProtocolMessage[] = [];
  const output = new PassThrough();
  const controls = {acknowledge: true, readers: 0, returns: 0, closes: 0, residue: "empty" as "empty" | "residue" | "unknown",
    beforeWrite: undefined as ((kind: DockerCustodyProtocolMessage["kind"]) => void | Promise<void>) | undefined,
    returnGate: undefined as Promise<void> | undefined, closeGate: undefined as Promise<void> | undefined,
    rejectClose: false, onStop: async () => {}, onStopped: () => {}, onRemove: async () => {}};
  const push = (...messages: DockerCustodyProtocolMessage[]) => {
    if (output.destroyed || output.writableEnded) {return;}
    const bytes = Buffer.concat(messages.map(message => Buffer.from(encodeDockerCustodyFrame(message))));
    const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.byteLength, 4);
    output.write(Buffer.concat([header, bytes]));
  };
  const input = new Writable({write(bytes, _encoding, callback) {
    for (const message of new DockerCustodyFrameDecoder().push(bytes)) {
      wire.push(message); events.push(`write:${message.kind}`);
      if (message.kind === "host-handshake") {
        push({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
          nonce: message.nonce, observedIdentity: message.expectedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL});
      }
      if (message.kind === "provider-exec" && controls.acknowledge) {
        push({kind: "provider-exec-ack", observation: "started", requestId: message.requestId});
      }
    }
    callback();
  }});
  let released: Promise<void> | undefined;
  const channel = createDockerCustodyChannel({input: input as Socket, output, close() {
    released ??= Promise.resolve().then(() => {output.destroy(); input.destroy(); return;});
    return released;
  }});
  t.after(() => channel.close());
  const attach = engine.attachCustody.bind(engine);
  engine.attachCustody = async (...args) => {
    const original = await attach(...args); events.push("attach");
    return {closeInput: channel.closeInput,
      async close() {
        controls.closes += 1; events.push("close");
        await controls.closeGate;
        await channel.close(); await original.close();
        if (controls.rejectClose) {throw new Error("synthetic close rejection");}
      },
      output: {[Symbol.asyncIterator]() {
        controls.readers += 1; assert.equal(controls.readers, 1);
        const iterator = channel.output[Symbol.asyncIterator]();
        return {next: () => iterator.next(), async return() {
          controls.returns += 1; await controls.returnGate; return iterator.return!();
        }};
      }},
      async write(bytes, beforeWrite) {
        const [message] = new DockerCustodyFrameDecoder().push(bytes); assert.ok(message);
        await controls.beforeWrite?.(message.kind);
        await channel.write(bytes, beforeWrite);
      },
    };
  };
  const stop = engine.stop.bind(engine); const remove = engine.remove.bind(engine);
  engine.stop = async (...args) => {events.push("stop"); await controls.onStop(); await stop(...args); events.push("stopped"); controls.onStopped();};
  engine.remove = async (...args) => {
    events.push("remove"); await controls.onRemove(); await remove(...args);
    // The actual Engine retires its hijack on remove; delaying Host cancel alone is insufficient.
    await channel.close();
  };
  const lifecycle = createDockerHostCustodyLifecycle({engine, journalStorage: storage,
    residue: {async proveEmpty() {events.push("residue"); return controls.residue;}}});
  const launch = () => lifecycle.launch({call: engineCall(), create: createInput(root), owner});
  const tail = () => {
    push({kind: "provider-output", requestId: providerExec.requestId, stream: "stdout", bytesBase64: stdout.toString("base64")},
      {kind: "provider-observation", requestId: providerExec.requestId, observation: "root-exited",
        exitCode: 17, signal: null, treeEmptyClaim: "not-claimed"},
      {kind: "provider-output", requestId: providerExec.requestId, stream: "stderr", bytesBase64: stderr.toString("base64")},
      {kind: "provider-drain-complete", requestId: providerExec.requestId, outerContainmentClaim: "unproven",
        rootExit: "observed", stdout: "eof", stderr: "eof"});
    output.end();
  };
  return {root, engine, storage, controls, events, wire, output, push, tail, lifecycle, launch};
};
