import assert from "node:assert/strict";
import {once} from "node:events";
import fs, {chmodSync, closeSync, constants, openSync, readFileSync, writeSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {test} from "node:test";
import {holdDockerCustodyProviderExecutable} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import {fixedChild, linux, sandbox} from "./support/docker-native-identity-fixture.ts";

// Freeze the observed inode metadata at its held value while changing the real
// disposable file. Replaying the original bytes then proves the digest readback
// is the guard that rejects the changed bytes, independent of timestamp granularity.
test("equal observed metadata cannot authorize changed held executable bytes", linux, async t => {
  const slot = sandbox(t);
  const original = readFileSync(slot.executablePath);
  const offset = original.length - 1;
  chmodSync(slot.executablePath, 0o755);
  const writable = openSync(slot.executablePath, constants.O_RDWR);
  chmodSync(slot.executablePath, 0o555);
  const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
  try {
    const descriptor = Number(held.descriptorPath.split("/").at(-1));
    const originalFstat = fs.fstatSync;
    const originalRead = fs.readSync;
    const heldMetadata = originalFstat(descriptor, {bigint: true});
    try {assert.equal(writeSync(writable, Buffer.from([original[offset]! ^ 1]), 0, 1, offset), 1);} finally {closeSync(writable);}
    assert.equal(readFileSync(slot.executablePath)[offset], original[offset]! ^ 1);
    const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
    let metadataObservations = 0;
    let byteReads = 0;
    let replayOriginal = false;
    const mockedStat = t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      const actual = originalFstat(...args);
      if (typeof actual.dev === "bigint" && actual.dev === heldMetadata.dev && actual.ino === heldMetadata.ino) {
        metadataObservations += 1;
        return heldMetadata;
      }
      return actual;
    }) as typeof fs.fstatSync);
    const mockedRead = t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] !== descriptor) {return originalRead(...args);}
      byteReads += 1;
      if (!replayOriginal) {return originalRead(...args);}
      const [, buffer, bufferOffset, length, position] = args;
      assert.equal(typeof position, "number");
      buffer.set(original.subarray(position, position + length), bufferOffset);
      return length;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    try {
      assert.equal(held.observeMapping(child), undefined);
      assert.ok(metadataObservations > 0, "the changed inode must appear to retain held metadata");
      assert.ok(byteReads > 0, "the held descriptor must be read back");
      replayOriginal = true;
      assert.ok(held.observeMapping(child), "replaying original bytes must authorize the same observed metadata");
    } finally {
      mockedRead.mock.restore(); mockedStat.mock.restore(); syncBuiltinESMExports();
    }
  } finally {held.close();}
});

for (const fault of ["denied", "short-read", "eof", "changed-bytes"] as const) {
  test(`held digest spawn readback is unproven on ${fault}`, linux, async t => {
    const slot = sandbox(t);
    const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
    const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
    const descriptor = Number(held.descriptorPath.split("/").at(-1));
    const originalRead = fs.readSync;
    let intercepted = 0;
    const mocked = t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] !== descriptor) {return originalRead(...args);}
      intercepted += 1;
      if (fault === "denied") {throw Object.assign(new Error("synthetic denial"), {code: "EACCES"});}
      if (fault === "eof") {return 0;}
      const count = originalRead(...args);
      if (fault === "short-read") {return count - 1;}
      if (count > 0) {args[1][args[2]] = args[1][args[2]]! ^ 1;}
      return count;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    try {assert.equal(held.observeMapping(child), undefined);} finally {
      mocked.mock.restore(); syncBuiltinESMExports(); held.close();
    }
    assert.ok(intercepted > 0);
  });
}
