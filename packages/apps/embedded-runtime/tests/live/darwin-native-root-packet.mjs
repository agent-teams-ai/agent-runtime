import {createHash} from "node:crypto";

export const DARWIN_ROOT_PACKET = Object.freeze({
  manifestBytes: 8192, grantBytes: 256, images: 16, imageBytes: 288,
  argvSlots: 8, stringBytes: 256, fdCount: 5, fdBytes: 32,
});
const hex = value => Buffer.from(value, "hex");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const u32 = (buffer, offset, value) => buffer.writeUInt32BE(value, offset);
const u64 = (buffer, offset, value) => buffer.writeBigUInt64BE(BigInt(value), offset);
const text = (buffer, offset, value, absolute) => {
  if (typeof value !== "string" || value.length === 0 || value.length >= 256 ||
      !/^[\x20-\x7e]+$/.test(value) || (absolute && (!value.startsWith("/") || value.endsWith("/") ||
        value.includes("//") || value.includes("/./") || value.includes("/../") || value.endsWith("/.") || value.endsWith("/..")))) {
    throw new TypeError("invalid native manifest text slot");
  }
  buffer.write(value, offset, "ascii");
};
const digest = value => {
  if (!/^[a-f0-9]{64}$/.test(value) || /^0+$/.test(value)) {throw new TypeError("invalid native manifest digest");}
  return hex(value);
};

// oxlint-disable-next-line complexity -- mirrors the native fail-closed decoder's complete fixed record validation
export function encodeDarwinNativeRootPacket(input) {
  if (!Number.isInteger(input.hostUid) || !Number.isInteger(input.hostGid) || !Number.isInteger(input.uid) || !Number.isInteger(input.gid) ||
      input.hostUid <= 0 || input.hostGid <= 0 || input.uid <= 0 || input.gid <= 0 || input.hostUid === input.uid || input.hostGid === input.gid ||
      !Number.isInteger(input.termMs) || input.termMs <= 0 || input.termMs > 10_000 ||
      !Number.isInteger(input.runMs) || input.runMs <= 0 || input.runMs > 300_000) {
    throw new TypeError("invalid native identity or deadline");
  }
  if (!Array.isArray(input.images) || input.images.length < 8 || input.images.length > 16 ||
      !Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > 8 || input.argv[0] !== input.images[2]?.path ||
      !Array.isArray(input.bindings) || input.bindings.length !== 8 || !Array.isArray(input.fds) || input.fds.length !== 5) {
    throw new TypeError("invalid native manifest cardinality");
  }
  if (new Set(input.images.map(image => image.path)).size !== input.images.length ||
      new Set(input.fds.map(fd => `${fd.dev}:${fd.ino}`)).size !== input.fds.length) {
    throw new TypeError("duplicate native image or descriptor identity");
  }
  const manifest = Buffer.alloc(8192);
  u32(manifest, 0, 1095060785); u32(manifest, 4, 1); u32(manifest, 8, 8192);
  [input.hostUid, input.hostGid, input.uid, input.gid, input.images.length, input.argv.length, input.termMs, input.runMs]
    .forEach((value, index) => u32(manifest, 16 + index * 4, value));
  input.bindings.forEach((value, index) => digest(value).copy(manifest, 48 + index * 32));
  input.images.forEach((image, index) => {
    text(manifest, 304 + index * 288, image.path, true);
    digest(image.sha256).copy(manifest, 304 + index * 288 + 256);
  });
  input.argv.forEach((value, index) => text(manifest, 4912 + index * 256, value, false));
  input.fds.forEach((fd, index) => {
    if (fd.right !== (index < 3 ? 1 : index === 3 ? 2 : 3) || BigInt(fd.ino) <= 0n) {throw new TypeError("invalid native descriptor identity or right");}
    const offset = 6960 + index * 32;
    u64(manifest, offset, fd.dev); u64(manifest, offset + 8, fd.ino); u32(manifest, offset + 16, fd.right);
  });
  const manifestSha256 = sha256(manifest);
  const qualification = digest(input.bindings[6]);
  if (!input.grant || input.uid < input.grant.uidFirst || input.uid > input.grant.uidLast ||
      input.gid < input.grant.gidFirst || input.gid > input.grant.gidLast ||
      input.grant.uidFirst <= 0 || input.grant.gidFirst <= 0 || input.grant.uidFirst > input.grant.uidLast || input.grant.gidFirst > input.grant.gidLast ||
      input.grant.uidLast - input.grant.uidFirst > 4095 || input.grant.gidLast - input.grant.gidFirst > 4095 ||
      input.hostUid >= input.grant.uidFirst && input.hostUid <= input.grant.uidLast ||
      input.hostGid >= input.grant.gidFirst && input.hostGid <= input.grant.gidLast) {
    throw new TypeError("native lease is outside the root grant");
  }
  const grant = Buffer.alloc(256);
  u32(grant, 0, 1095067441); u32(grant, 4, 1); u32(grant, 8, 256);
  [input.grant.uidFirst, input.grant.uidLast, input.grant.gidFirst, input.grant.gidLast]
    .forEach((value, index) => u32(grant, 16 + index * 4, value));
  manifestSha256.copy(grant, 32); qualification.copy(grant, 64); digest(input.grant.isolationSha256).copy(grant, 96);
  return Object.freeze({manifest, grant, manifestSha256: manifestSha256.toString("hex")});
}
