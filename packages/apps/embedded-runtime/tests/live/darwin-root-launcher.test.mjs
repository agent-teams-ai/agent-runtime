import assert from "node:assert/strict";
import {chmod, mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createDarwinPacketDescriptors, prepareDarwinRootLaunch} from "./darwin-root-launcher.mjs";

const packet = () => ({hostUid: 501, hostGid: 20, uid: 50_000, gid: 50_000, termMs: 10_000, runMs: 300_000,
  bindings: Array.from({length: 8}, (_, index) => String(index + 1).repeat(64)),
  images: Array.from({length: 8}, (_, index) => ({path: `/private/root/image-${index}`, sha256: "a".repeat(64)})),
  argv: ["/private/root/image-2", "app-server"],
  grant: {uidFirst: 50_000, uidLast: 50_100, gidFirst: 50_000, gidLast: 50_100, isolationSha256: "f".repeat(64)}});

test("inert root preflight validates the adjacent activation and exact packet", async () => {
  const root = await mkdtemp(join(tmpdir(), "darwin-root-preflight-"));
  try {
    const canonicalRoot = await import("node:fs/promises").then(fs => fs.realpath(root));
    const owner = join(canonicalRoot, "owner"), activationPath = join(canonicalRoot, "activation.json");
    const dirs = [join(canonicalRoot, "namespace"), join(canonicalRoot, "leases"), join(canonicalRoot, "journal")];
    await Promise.all(dirs.map(path => mkdir(path)));
    await writeFile(owner, "owner", {mode: 0o500});
    const nativePacket = packet();
    const roles = ["native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-entrypoint", "host-peer-addon", "native-loader-7"];
    await writeFile(activationPath, JSON.stringify({version: 1, platform: "darwin-arm64", candidate: true, qualified: false,
      files: roles.map((role, index) => ({role, ...nativePacket.images[index]})),
      native: {ownerPath: owner, namespaceParent: dirs[0], leaseRegistry: dirs[1], journal: dirs[2], packet: nativePacket}}), {mode: 0o444});
    await chmod(activationPath, 0o444);
    const result = await prepareDarwinRootLaunch(activationPath, process.getuid(), false);
    assert.equal(result.packetInput.fds, undefined);
    assert.equal(result.native.ownerPath, owner);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("production root refuses before acquiring owners outside the admitted Darwin Host", async () => {
  const {createDarwinLiveRuntime} = await import("./darwin-live-production-root.mjs");
  await assert.rejects(createDarwinLiveRuntime({runtimeRootModulePath: "/does/not/exist"}), /PRODUCTION_ROOT_REFUSED/);
});

test("manifest descriptor identities are exactly FD5-7/9/10", () => {
  const stats = ["namespace", "leases", "journal", "fifo", "route"].map((name, index) =>
    ({name, dev: 10 + index, ino: 20 + index}));
  assert.deepEqual(createDarwinPacketDescriptors(stats), stats.map((value, index) =>
    ({dev: value.dev, ino: value.ino, right: index < 3 ? 1 : index === 3 ? 2 : 3})));
});
