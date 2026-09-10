import assert from "node:assert/strict";
import { openSync, closeSync, constants, lstatSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { initializeDarwinHostAcquisitionGuard, hasDarwinHostDescriptors,
  openNativeHostRoot, duplicateNativeHostDescriptor } from "../dist/index.js";
const loaded = { exports: {} };
process.dlopen(loaded, fileURLToPath(new URL("../dist/rename-no-replace.node", import.meta.url)));
const native = loaded.exports;
const [mode, root] = process.argv.slice(2);
assert.equal(process.platform, "darwin");
assert.equal(native.isDarwinHostAcquisitionGuardInstalled(), false);
assert.equal(hasDarwinHostDescriptors(), false);
assert.throws(() => openNativeHostRoot(), /unavailable/);
// Arbitrary JS properties and environment strings cannot issue native state.
process.env.HOST_ACQUISITION_GUARD_INSTALLED = "true";
native.installed = true;
for (const [name, args] of [["hostRoot", []], ["hostOpen", [{}, "x", 0]],
  ["hostOpen", [{}, "x", 1]], ["hostOpen", [{}, "x", 2]],
  ["hostDuplicate", [{}]], ["hostNames", [{}, 1]],
  ["hostQuarantine", [{}, "x", {}, "y"]]]) {
  assert.throws(() => native[name](...args), /guard is not installed/);
}
assert.throws(() => duplicateNativeHostDescriptor({ fd: 0 }), /not issued/);
if (mode === "guarded") {
  initializeDarwinHostAcquisitionGuard();
  initializeDarwinHostAcquisitionGuard();
  assert.equal(native.isDarwinHostAcquisitionGuardInstalled(), true);
  assert.equal(hasDarwinHostDescriptors(), true);
} else {assert.equal(mode, "control");}
// Raw Node fs opens exercise the kernel, bypassing native hostOpen prechecks.
// Darwin O_EVTONLY is 0x8000; it is not exported by all Node versions.
for (const flags of [constants.O_RDONLY, constants.O_WRONLY, constants.O_RDWR, 0x8000]) {
  if (mode === "guarded") {assert.throws(() => openSync("/dev/null", flags),
    error => error.code === "EPERM" && error.errno === -1);}
  else {closeSync(openSync("/dev/null", flags));}
  closeSync(openSync(`${root}/regular`, flags));
}
closeSync(openSync(root, constants.O_RDONLY | constants.O_DIRECTORY));
assert.equal(lstatSync(`${root}/link`).isSymbolicLink(), true);
assert.equal(readlinkSync(`${root}/link`), "regular");
assert.equal(lstatSync(`${root}/fifo`).isFIFO(), true);
assert.equal(lstatSync("/dev/null").isCharacterDevice(), true);
assert.equal(randomBytes(32).length, 32);
if (mode === "guarded") {
  assert.throws(() => native.hostOpen({}, "regular", 0), /invalid or closed/);
  const handle = openNativeHostRoot();
  await handle.close();
  // Includes no-follow FIFO/symlink quarantine with owned inode preservation,
  // BOM, errno, bounds, no-replace and descriptor provenance regressions.
  await import("./host-descriptors.test.mjs");
}
console.log(JSON.stringify({ mode, rawOpenControls: "pass", metadataCryptoStdout: "pass" }));
