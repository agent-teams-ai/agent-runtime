import { DockerEngineError } from "./docker-engine-error.js";
import {
  DOCKER_LOG_MAX_FRAME_BYTES,
  DOCKER_LOG_MAX_STREAM_BYTES,
  type DockerCustodyDuplexChannel,
} from "./docker-engine-port.js";
import { parseDockerMultiplexedStream } from "./docker-multiplexed-stream.js";
import type { UnixHijackChannel } from "./bounded-unix-hijack.js";

export const createDockerCustodyChannel = (hijack: UnixHijackChannel): DockerCustodyDuplexChannel => {
  let inputClosed = false;
  let channelClosed = false;
  let writes = Promise.resolve();
  const writeOnce = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
    if (channelClosed || inputClosed || hijack.input.destroyed) {reject(new DockerEngineError("daemon-disconnected")); return;}
    const detached = Uint8Array.from(bytes);
    hijack.input.write(detached, error => {
      if (error === null || error === undefined) {resolve();} else {reject(new DockerEngineError("daemon-disconnected"));}
    });
  });
  const output = async function* (): AsyncIterable<Uint8Array> {
    try {
      for await (const frame of parseDockerMultiplexedStream(
        hijack.output,
        DOCKER_LOG_MAX_FRAME_BYTES,
        DOCKER_LOG_MAX_STREAM_BYTES,
      )) {
        if (frame.stream !== "stdout") {throw new DockerEngineError("protocol-violation");}
        yield frame.bytes;
      }
    } finally {
      channelClosed = true;
      await hijack.close();
    }
  };
  return Object.freeze({
    close: async () => {channelClosed = true; await hijack.close();},
    closeInput: async () => {
      if (inputClosed || channelClosed) {return;}
      inputClosed = true;
      await writes;
      await new Promise<void>((resolve, reject) => {
        const failed = (): void => {reject(new DockerEngineError("daemon-disconnected"));};
        hijack.input.once("error", failed);
        hijack.input.end(() => {hijack.input.removeListener("error", failed); resolve();});
      });
    },
    output: output(),
    write: async (bytes: Uint8Array) => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {throw new DockerEngineError("protocol-violation");}
      const pending = writes.then(() => writeOnce(bytes));
      writes = pending.catch(() => {});
      await pending;
    },
  });
};
