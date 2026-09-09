import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decodeDarwinAttemptOwnerRequest, encodeDarwinAttemptOwnerRequest,
  DarwinAttemptOwnerFrameReader, darwinAttemptOwnerFrameBytes,
} from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.ts";
import { darwinAttemptOwnerAdmission } from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-bridge.ts";

const native = fileURLToPath(new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url));
const start = { command: "START_ONCE", sequence: 1, binding: "01".repeat(32), launch: "02".repeat(32), argument: 0 } as const;
const commands = ["START_ONCE", "CUTOFF", "READ_STATUS", "SETTLE_LAUNCH_ROUTE",
  "SETTLE_ARTIFACT_RESULT", "WORKSPACE_FREEZE", "WORKSPACE_CLEANUP", "WORKSPACE_CLOSE",
  "SETTLE_WORKSPACE", "SETTLE_PRIVATE", "READ_ARTIFACT_SLOT", "DISPOSE_ONCE", "READ_CLOSED_WORKSPACE"] as const;

test("all finite commands roundtrip exact owned source and caller values cannot activate", () => {
  for (const command of commands) {
    const input = { ...start, command };
    assert.deepEqual(decodeDarwinAttemptOwnerRequest(encodeDarwinAttemptOwnerRequest(input)), input);
  }
  assert.equal(darwinAttemptOwnerAdmission().status, "unavailable");
  assert.equal(darwinAttemptOwnerAdmission().missing.length, 6);
  const source = readFileSync(join(native, "darwin-attempt-owner-main.c"), "utf8");
  assert.match(source, /return 78/u);
});

test("shape validation rejects paths, PIDs, duplicate-equivalent extra fields and accessors", () => {
  for (const extra of [{ pid: 1 }, { path: "/tmp" }, { trusted: true }, { uid: 501 }]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, ...extra }));
  }
  let reads = 0;
  const accessor = { ...start, get sequence() { reads++; return 1; } };
  assert.throws(() => encodeDarwinAttemptOwnerRequest(accessor));
  assert.equal(reads, 0);
  for (const sequence of [0, -1, 0x1_0000_0000, NaN, 1.5]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, sequence }));
  }
  for (const binding of ["", "0".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, binding }));
  }
  assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, argument: 1 }));
  assert.throws(() => encodeDarwinAttemptOwnerRequest({ ...start, command: "READ_ARTIFACT_SLOT", argument: 2 }));
  assert.equal(decodeDarwinAttemptOwnerRequest(encodeDarwinAttemptOwnerRequest({ ...start, command: "READ_ARTIFACT_SLOT", argument: 1 })).argument, 1);
});

test("all truncations, reserved data, concatenated frames and channel loss reject", () => {
  const frame = encodeDarwinAttemptOwnerRequest(start);
  for (let length = 0; length < frame.length; length++) {
    assert.throws(() => decodeDarwinAttemptOwnerRequest(frame.subarray(0, length)));
    const reader = new DarwinAttemptOwnerFrameReader();
    if (length) {assert.equal(reader.push(frame.subarray(0, length)), undefined);}
    assert.throws(() => reader.end());
    assert.throws(() => reader.push(frame));
  }
  const tooMuch = new DarwinAttemptOwnerFrameReader();
  assert.throws(() => tooMuch.push(Buffer.concat([frame, frame])));
  assert.throws(() => tooMuch.push(frame));
  const reader = new DarwinAttemptOwnerFrameReader();
  assert.equal(reader.push(frame.subarray(0, 1)), undefined);
  assert.deepEqual(reader.push(frame.subarray(1)), start);
  reader.end();
  assert.throws(() => reader.push(frame));
  assert.equal(frame.length, darwinAttemptOwnerFrameBytes);
  const invalid = Buffer.from(frame); invalid[invalid.length - 1] = 1;
  assert.throws(() => decodeDarwinAttemptOwnerRequest(invalid));
});

test("portable C pure state/protocol harness uses the exact TS wire vectors", () => {
  const temporary = mkdtempSync(join(tmpdir(), "darwin-owner-protocol-"));
  try {
    const vectors = commands.map((command) => [...encodeDarwinAttemptOwnerRequest({ ...start, command })]);
    writeFileSync(join(temporary, "vectors.h"), `static const unsigned char vectors[][AE_FRAME_BYTES]={${vectors.map((v) => `{${v.join(",")}}`).join(",")}};\n`);
    const executable = join(temporary, "protocol-harness");
    const args = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-I", native, "-I", temporary,
      join(native, "darwin-attempt-owner-state.c"),
      fileURLToPath(new URL("./darwin-attempt-owner-protocol-harness.c", import.meta.url)), "-o", executable];
    const compile = spawnSync("cc", args, { encoding: "utf8" });
    console.log(JSON.stringify({ command: ["cc", ...args], stdout: compile.stdout, stderr: compile.stderr, exit: compile.status }));
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8" });
    console.log(JSON.stringify({ command: [executable], stdout: run.stdout, stderr: run.stderr, exit: run.status }));
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
