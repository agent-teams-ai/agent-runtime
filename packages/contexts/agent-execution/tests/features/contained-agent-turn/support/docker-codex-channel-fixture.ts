import {Socket} from "node:net";
import {callbackify} from "node:util";
import {createDockerCustodyChannel} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-custody-channel.js";
import type {MemoryInitChannel} from "./docker-provider-process-fixture.ts";
import {DockerCustodyFrameDecoder} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";

/** Real production write queue and Docker framing over an in-memory socket.
 * No connection is opened; MemoryInitChannel remains the one synthetic peer. */
export const codexChannelFixture = (peer: MemoryInitChannel, beforeProtocolWrite: () => void) => {
  const write = callbackify(async (bytes: Uint8Array) => {await peer.write(bytes);});
  const input = new Socket();
  Object.defineProperty(input, "_write", {
    value(bytes: Uint8Array, _encoding: BufferEncoding, done: (error?: Error | null) => void) {write(bytes, done);},
  });
  let closing: Promise<void> | undefined;
  const channel = createDockerCustodyChannel({input,
    output: {[Symbol.asyncIterator]: async function* () {
      for await (const bytes of peer.output) {
        const frame = Buffer.alloc(8 + bytes.byteLength); frame[0] = 1;
        frame.writeUInt32BE(bytes.byteLength, 4); frame.set(bytes, 8); yield frame;
      }
    }},
    close: () => closing ??= (async () => {input.destroy(); await peer.close();})(),
  });
  return Object.freeze({...channel, write: (bytes: Uint8Array, assertAdmission?: () => void) => {
    if (new DockerCustodyFrameDecoder().push(bytes).some(message => message.kind === "provider-input")) {beforeProtocolWrite();}
    return channel.write(bytes, assertAdmission);
  }});
};
