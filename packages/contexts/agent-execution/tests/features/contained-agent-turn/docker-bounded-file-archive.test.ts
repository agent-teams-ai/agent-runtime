import assert from "node:assert/strict";
import test from "node:test";
import { readDockerFileArchive, DOCKER_ARCHIVE_FILE_MAX_BYTES } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-bounded-file-archive.js";
import { archive, checksum, chunks, digest } from "../../fixtures/docker-image-init-fixture.ts";
import { call } from "../../fixtures/docker-engine-test-fixture.ts";

const PATH = "/ar-custody-init.mjs";
const BYTES = Buffer.from("independent selected bundle bytes");
const valid = (): Buffer => archive(PATH, BYTES, 0o444);
const parse = (bytes: Uint8Array, width = 317) => readDockerFileArchive(chunks(bytes, width), PATH, BYTES.length, call());
const mutateHeader = (change: (header: Buffer) => void): Buffer => {
  const bytes = valid(); change(bytes.subarray(0, 512)); checksum(bytes.subarray(0, 512)); return bytes;
};

test("canonical USTAR file is hashed across every header, payload, padding and terminator boundary", async () => {
  for (const width of [1, 7, 31, 511, 512, 513, 4096]) {
    assert.deepEqual(await parse(valid(), width), {path: PATH, size: BYTES.length, mode: 0o444, sha256: digest(BYTES)});
  }
  const large = Buffer.alloc(1_024 * 1_024 + 3, 42);
  assert.equal((await readDockerFileArchive(chunks(archive(PATH, large, 0o444), 65536), PATH, large.length, call())).sha256, digest(large));
  const deviceZeros = mutateHeader(h => {h.write("0000000\0", 329); h.write("0000000\0", 337);});
  assert.equal((await parse(deviceZeros)).sha256, digest(BYTES));
});

test("links, duplicate/unexpected files, traversal and unsupported archive representations refuse", async () => {
  const bad: Uint8Array[] = [];
  for (const kind of ["1", "2", "3", "4", "5", "6", "7", "x", "g", "L", "K", "S"]) {
    bad.push(mutateHeader(h => {h.write(kind, 156);}));
  }
  for (const path of ["../ar-custody-init.mjs", "./ar-custody-init.mjs", "/ar-custody-init.mjs", "foreign.mjs", "a//b", "a/../b"]) {
    bad.push(mutateHeader(h => {h.fill(0, 0, 100); h.write(path, 0);}));
  }
  bad.push(mutateHeader(h => {h.write("workspace", 345);}));
  bad.push(mutateHeader(h => {h.write("target", 157);}));
  bad.push(mutateHeader(h => {h.write("ustar  ", 257);}));
  bad.push(mutateHeader(h => {h[124] = 0x80;}));
  bad.push(mutateHeader(h => {h[100] = 0xff;}));
  bad.push(mutateHeader(h => {h.write("0004755\0", 100);}));
  bad.push(mutateHeader(h => {h.write("0000644\0", 100);}));
  bad.push(mutateHeader(h => {h.write("0000001\0", 108);}));
  bad.push(mutateHeader(h => {h.write("0000001\0", 116);}));
  bad.push(mutateHeader(h => {h.write("0000001\0", 329);}));
  bad.push(Buffer.concat([valid().subarray(0, 1024), valid()]));
  bad.push(Buffer.concat([valid(), valid()]));
  bad.push(Buffer.from([0x1f, 0x8b, 0x08, 0x00])); // gzip is not a tar representation.
  for (const [index, bytes] of bad.entries()) {
    await assert.rejects(parse(bytes), {code: "malformed-response"}, `bad archive ${index}`);
  }
});

test("truncation, bad checksum, dirty padding, oversize and invalid requested paths refuse", async () => {
  const full = valid();
  for (const length of [0, 1, 511, 512, 512 + BYTES.length - 1, 1023, 1024, 1536, full.length - 1]) {
    await assert.rejects(parse(full.subarray(0, length)), {code: "malformed-response"});
  }
  const dirty = valid(); dirty[512 + BYTES.length] = 1;
  await assert.rejects(parse(dirty), {code: "malformed-response"});
  const corrupt = valid(); corrupt[0] ^= 1;
  await assert.rejects(parse(corrupt), {code: "malformed-response"});
  await assert.rejects(parse(mutateHeader(h => {h.write("77777777777\0", 124);})), {code: "malformed-response"});
  await assert.rejects(parse(Buffer.concat([full, Buffer.alloc(11_000)])), {code: "response-too-large"});
  for (const path of ["/", "relative", "/opt/init.mjs", "/../file", "/a\0b", "/file/"]) {
    await assert.rejects(readDockerFileArchive(chunks(full), path, BYTES.length, call()), {code: "invalid-create-request"});
  }
  for (const bound of [0, -1, 1.5, Infinity, DOCKER_ARCHIVE_FILE_MAX_BYTES + 1]) {
    await assert.rejects(readDockerFileArchive(chunks(full), PATH, bound, call()), {code: "invalid-create-request"});
  }
});

test("stream errors, abort and deadline never become a file witness; rejection closes the source", async () => {
  let closed = false;
  async function* broken(): AsyncIterable<Uint8Array> {
    try {yield valid().subarray(0, 600); throw new Error("synthetic disconnect");} finally {closed = true;}
  }
  await assert.rejects(readDockerFileArchive(broken(), PATH, BYTES.length, call()), /synthetic disconnect/u);
  assert.equal(closed, true);
  const controller = new AbortController();
  async function* aborted(): AsyncIterable<Uint8Array> {
    yield valid().subarray(0, 600); controller.abort(); yield valid().subarray(600);
  }
  await assert.rejects(readDockerFileArchive(aborted(), PATH, BYTES.length,
    {...call(), signal: controller.signal}), {code: "aborted"});
  await assert.rejects(readDockerFileArchive(chunks(valid()), PATH, BYTES.length,
    {...call(), deadlineEpochMs: Date.now() - 1}), {code: "deadline-exceeded"});
  closed = false;
  async function* invalid(): AsyncIterable<Uint8Array> {
    try {yield Buffer.alloc(512, 1);} finally {closed = true;}
  }
  await assert.rejects(readDockerFileArchive(invalid(), PATH, BYTES.length, call()), {code: "malformed-response"});
  assert.equal(closed, true);
});
