import assert from "node:assert/strict";
import test from "node:test";
import {encodeDarwinNativeRootPacket} from "./darwin-native-root-packet.mjs";

const packet = () => ({hostUid: 501, hostGid: 20, uid: 50_000, gid: 50_000, termMs: 10_000, runMs: 300_000,
  bindings: Array.from({length: 8}, (_, index) => String(index + 1).repeat(64)),
  images: Array.from({length: 8}, (_, index) => ({path: `/private/root/image-${index}`, sha256: "a".repeat(64)})),
  argv: ["/private/root/image-2", "app-server"],
  fds: Array.from({length: 5}, (_, index) => ({dev: 10 + index, ino: 20 + index, right: index < 3 ? 1 : index === 3 ? 2 : 3})),
  grant: {uidFirst: 50_000, uidLast: 50_100, gidFirst: 50_000, gidLast: 50_100, isolationSha256: "f".repeat(64)}});

test("encodes the exact native manifest and grant layout", () => {
  const result = encodeDarwinNativeRootPacket(packet());
  assert.equal(result.manifest.length, 8192); assert.equal(result.grant.length, 256);
  assert.equal(result.manifest.readUInt32BE(0), 1095060785); assert.equal(result.manifest.readUInt32BE(8), 8192);
  assert.equal(result.manifest.readUInt32BE(16), 501); assert.equal(result.manifest.readUInt32BE(24), 50_000);
  assert.equal(result.manifest.subarray(304, 304 + 21).toString(), "/private/root/image-0");
  assert.equal(result.manifest.readUInt32BE(6960 + 16), 1); assert.equal(result.manifest.readUInt32BE(6960 + 4 * 32 + 16), 3);
  assert.equal(result.grant.readUInt32BE(0), 1095067441); assert.equal(result.grant.subarray(32, 64).toString("hex"), result.manifestSha256);
  assert.deepEqual(result.grant.subarray(64, 96), result.manifest.subarray(48 + 6 * 32, 48 + 7 * 32));
});

test("rejects an out-of-range lease before producing root records", () => {
  const input = packet(); input.uid = 60_000;
  assert.throws(() => encodeDarwinNativeRootPacket(input), /outside the root grant/);
});

test("rejects packets the native decoder rejects", () => {
  const duplicatePath = packet(); duplicatePath.images[1].path = duplicatePath.images[0].path;
  assert.throws(() => encodeDarwinNativeRootPacket(duplicatePath), /duplicate native/);
  const duplicateFd = packet(); duplicateFd.fds[1] = {...duplicateFd.fds[0], right: 1};
  assert.throws(() => encodeDarwinNativeRootPacket(duplicateFd), /duplicate native/);
  const hostInGrant = packet(); hostInGrant.grant.uidFirst = 500; hostInGrant.grant.uidLast = 600;
  assert.throws(() => encodeDarwinNativeRootPacket(hostInGrant), /outside the root grant/);
  const badPath = packet(); badPath.images[0].path = "/private//image";
  assert.throws(() => encodeDarwinNativeRootPacket(badPath), /text slot/);
});
