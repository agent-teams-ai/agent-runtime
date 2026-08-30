import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerLogFrame } from "./docker-engine-port.js";

const HEADER_BYTES = 8;

const lengthFromHeader = (header: Uint8Array): number => (
  ((header[4] ?? 0) * 0x1000000) +
  ((header[5] ?? 0) * 0x10000) +
  ((header[6] ?? 0) * 0x100) +
  (header[7] ?? 0)
);

export async function* parseDockerMultiplexedStream(
  source: AsyncIterable<Uint8Array>,
  maxFrameBytes: number,
  maxStreamBytes: number,
): AsyncIterable<DockerLogFrame> {
  const header = new Uint8Array(HEADER_BYTES);
  let headerBytes = 0;
  let payload: Uint8Array | undefined;
  let payloadBytes = 0;
  let stream: "stderr" | "stdout" | undefined;
  let streamBytes = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (payload === undefined) {
        const copied = Math.min(HEADER_BYTES - headerBytes, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + copied), headerBytes);
        headerBytes += copied;
        offset += copied;
        if (headerBytes < HEADER_BYTES) {continue;}
        if (header[1] !== 0 || header[2] !== 0 || header[3] !== 0 ||
            (header[0] !== 1 && header[0] !== 2)) {
          throw new DockerEngineError("protocol-violation");
        }
        const frameBytes = lengthFromHeader(header);
        if (frameBytes > maxFrameBytes) {throw new DockerEngineError("stream-frame-too-large");}
        streamBytes += frameBytes;
        if (streamBytes > maxStreamBytes) {throw new DockerEngineError("stream-too-large");}
        stream = header[0] === 1 ? "stdout" : "stderr";
        payload = new Uint8Array(frameBytes);
        payloadBytes = 0;
        headerBytes = 0;
      }
      const copied = Math.min(payload.byteLength - payloadBytes, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + copied), payloadBytes);
      payloadBytes += copied;
      offset += copied;
      if (payloadBytes === payload.byteLength) {
        yield { bytes: payload, stream: stream ?? "stdout" };
        payload = undefined;
        stream = undefined;
      }
    }
  }
  if (headerBytes !== 0 || payload !== undefined) {throw new DockerEngineError("stream-truncated");}
}
