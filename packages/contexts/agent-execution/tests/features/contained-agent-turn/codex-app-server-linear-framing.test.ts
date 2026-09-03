import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoundedCodexJsonLineReader,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-jsonl.js";
import {
  CodexAppServerTextSegments,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-text-segments.js";

const deadline = (): number => performance.now() + 10_000;

const source = async function* (chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
};

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");

test("JSONL framing is invariant at every byte split, including inside UTF-8", async () => {
  const framed = bytes('{"text":"café"}\n');
  for (let split = 0; split <= framed.length; split += 1) {
    const reader = new BoundedCodexJsonLineReader(
      source([framed.subarray(0, split), framed.subarray(split)]),
      framed.length - 1,
    );
    assert.deepEqual(await reader.read(deadline()), { text: "café" }, `byte split ${split}`);
    assert.equal(await reader.read(deadline()), undefined, `EOF at byte split ${split}`);
  }
});

test("JSONL framing retains many one-byte fragments and joins one completed line", async () => {
  const framed = bytes(`${JSON.stringify({ text: "x".repeat(4_096) })}\n`);
  const reader = new BoundedCodexJsonLineReader(
    source([...framed].map(value => Uint8Array.of(value))),
    framed.length - 1,
  );
  assert.deepEqual(await reader.read(deadline()), { text: "x".repeat(4_096) });
  assert.equal(await reader.read(deadline()), undefined);
});

test("an oversized aggregate chunk is accepted when each delimited line is bounded", async () => {
  const records = Array.from({ length: 64 }, (_, index) => ({ index }));
  const lines = records.map(record => JSON.stringify(record));
  const maximumLineBytes = Math.max(...lines.map(line => bytes(line).length));
  const aggregate = bytes(`${lines.join("\n")}\n`);
  assert.ok(aggregate.length > maximumLineBytes);
  const reader = new BoundedCodexJsonLineReader(source([aggregate]), maximumLineBytes);
  for (const record of records) {assert.deepEqual(await reader.read(deadline()), record);}
  assert.equal(await reader.read(deadline()), undefined);
});

test("CRLF, blank lines, and final fragments have deterministic framing", async () => {
  const record = '{"ok":true}';
  const reader = new BoundedCodexJsonLineReader(source([bytes(`\r\n${record}\r\n\n`)]), bytes(`${record}\r`).length);
  assert.deepEqual(await reader.read(deadline()), { ok: true });
  assert.equal(await reader.read(deadline()), undefined);

  const unterminated = new BoundedCodexJsonLineReader(source([bytes(record)]), bytes(record).length);
  await assert.rejects(unterminated.read(deadline()), /unterminated message/u);

  const overlong = new BoundedCodexJsonLineReader(source([bytes(`${record}x`)]), bytes(record).length);
  await assert.rejects(overlong.read(deadline()), /line exceeds the configured bound/u);

  const completedThenFinal = new BoundedCodexJsonLineReader(
    source([bytes(`${record}\n${record}`)]), bytes(record).length,
  );
  assert.deepEqual(await completedThenFinal.read(deadline()), { ok: true });
  await assert.rejects(completedThenFinal.read(deadline()), /unterminated message/u);
});

test("JSONL rejects duplicate decoded property names before object decoding", async () => {
  for (const line of [
    '{"id":"request:1","id":"request:2","result":{}}\n',
    '{"id":"request:1","\\u0069d":"request:2","result":{}}\n',
    '{"id":"request:1","result":{"turn":{},"t\\u0075rn":{}}}\n',
  ]) {
    const reader = new BoundedCodexJsonLineReader(source([bytes(line)]), bytes(line).length - 1);
    await assert.rejects(reader.read(deadline()), /malformed JSON/u);
  }
});

test("bounded text segments expose one copy pass for high fragment counts", () => {
  const fragments = 16_384;
  const segments = new CodexAppServerTextSegments(fragments, fragments);
  for (let index = 0; index < fragments; index += 1) {segments.append("x");}
  assert.equal(segments.byteLength, fragments);
  assert.equal(segments.chunkCount, fragments);
  assert.equal(segments.materializationCount, 0);
  assert.equal(segments.materialize(), "x".repeat(fragments));
  assert.equal(segments.materializationCount, 1);
  assert.throws(() => segments.materialize(), /materialized more than once/u);
});
