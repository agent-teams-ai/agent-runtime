import { Readable } from "node:stream";

import { ProbeEvidence } from "./opencode-acp-probe-evidence.ts";

export const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const MAX_STDOUT_LINE_BYTES = 256 * 1024;

export const createBoundedAgentStream = (input: {
  readonly stdout: Readable;
  readonly evidence: ProbeEvidence;
}): ReadableStream<Uint8Array> => {
  let stdoutBytes = 0;
  let lineBytes = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        input.evidence.anomaly("stdout_byte_limit_exceeded", "stdout");
        throw new Error("Bounded ACP stdout byte limit exceeded");
      }
      for (const byte of chunk) {
        if (byte === 0x0a) {
          lineBytes = 0;
        } else if (++lineBytes > MAX_STDOUT_LINE_BYTES) {
          input.evidence.anomaly("stdout_line_limit_exceeded", "stdout");
          throw new Error("Bounded ACP stdout line limit exceeded");
        }
      }
      controller.enqueue(chunk);
    },
  });
  return (Readable.toWeb(input.stdout) as ReadableStream<Uint8Array>).pipeThrough(
    bounded,
  );
};
