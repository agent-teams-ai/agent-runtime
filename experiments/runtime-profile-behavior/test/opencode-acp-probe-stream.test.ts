import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ProbeEvidence } from "../src/features/acp-compatibility/opencode-acp-probe-evidence.ts";
import { createBoundedAgentStream, MAX_STDOUT_BYTES, MAX_STDOUT_LINE_BYTES } from "../src/features/acp-compatibility/opencode-acp-probe-stream.ts";

const consume = async (chunks: Uint8Array[], evidence: ProbeEvidence): Promise<number> => {
  const reader = createBoundedAgentStream({ stdout: Readable.from(chunks), evidence }).getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {return bytes;}
      bytes += next.value.byteLength;
    }
  } finally {reader.releaseLock();}
};

test("stdout accepts exactly the total byte cap and rejects the next byte across chunks", async () => {
  // Newlines avoid confounding the independent line limit.
  const chunks = [Buffer.alloc(MAX_STDOUT_BYTES - 1, 0x0a), Buffer.from("\n")];
  const exact = new ProbeEvidence();
  assert.equal(await consume(chunks, exact), MAX_STDOUT_BYTES);
  assert.deepEqual(exact.anomalies, []);
  const overflow = new ProbeEvidence();
  await assert.rejects(consume([...chunks, Buffer.from("\n")], overflow), /byte limit/);
  assert.deepEqual(overflow.anomalies, [{ code: "stdout_byte_limit_exceeded", field: "stdout" }]);
});

test("stdout counts line bytes across chunks, accepts the exact cap, and resets only at LF", async () => {
  // Multibyte text is bounded by UTF-8 bytes, including a split code point.
  const line = Buffer.from("é".repeat(MAX_STDOUT_LINE_BYTES / 2));
  const chunks = [line.subarray(0, 1), line.subarray(1)];
  const exact = new ProbeEvidence();
  assert.equal(await consume([...chunks, Buffer.from("\n"), ...chunks], exact), 2 * MAX_STDOUT_LINE_BYTES + 1);
  assert.deepEqual(exact.anomalies, []);
  for (const extra of ["x", "\r"]) {
    const overflow = new ProbeEvidence();
    await assert.rejects(consume([...chunks, Buffer.from(extra)], overflow), /line limit/);
    assert.deepEqual(overflow.anomalies, [{ code: "stdout_line_limit_exceeded", field: "stdout" }]);
  }
});
