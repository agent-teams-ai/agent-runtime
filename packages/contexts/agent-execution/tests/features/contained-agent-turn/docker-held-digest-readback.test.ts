import assert from "node:assert/strict";
import {once} from "node:events";
import fs, {chmodSync, closeSync, constants, fstatSync, openSync, readFileSync, statSync, writeSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {test} from "node:test";
import {holdDockerCustodyProviderExecutable} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/node-docker-custody-init-driver.js";
import {fixedChild, linux, sandbox} from "./support/docker-native-identity-fixture.ts";

// The writable descriptor is opened only on this disposable copy, before its
// mode is sealed. It permits an in-place change without replacing the inode.
test("natural metadata collision cannot authorize changed held executable bytes", linux, async t => {
  const slot = sandbox(t);
  const original = readFileSync(slot.executablePath);
  const offset = original.length - 1;
  let collision = false;
  for (let attempt = 0; attempt < 256 && !collision; attempt += 1) {
    chmodSync(slot.executablePath, 0o755);
    const writable = openSync(slot.executablePath, constants.O_RDWR);
    let writableOpen = true;
    try {
      chmodSync(slot.executablePath, 0o555);
      const held = holdDockerCustodyProviderExecutable(slot.executablePath, slot.executableSha256);
      try {
        const before = statSync(slot.executablePath, {bigint: true});
        const changed = Buffer.from([original[offset]! ^ 1]);
        assert.equal(writeSync(writable, changed, 0, 1, offset), 1);
        const after = fstatSync(writable, {bigint: true});
        closeSync(writable); writableOpen = false;
        collision = before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
          before.nlink === after.nlink && before.size === after.size && before.uid === after.uid &&
          before.gid === after.gid && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
        if (collision) {
          const child = fixedChild(t, held.descriptorPath); await once(child, "spawn");
          assert.equal(held.observeMapping(child), undefined);
        }
      } finally {
        held.close();
        if (!collision) {
          chmodSync(slot.executablePath, 0o755);
          const restore = openSync(slot.executablePath, constants.O_WRONLY);
          try {assert.equal(writeSync(restore, original, offset, 1, offset), 1);} finally {closeSync(restore);}
          chmodSync(slot.executablePath, 0o555);
        }
      }
    } finally {if (writableOpen) {closeSync(writable);}}
  }
  if (!collision) {t.diagnostic("No natural nanosecond metadata collision in 256 disposable trials; fault-IO tests remain deterministic.");}
  assert.equal(collision, true, "fixture must exercise an actual metadata collision");
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
