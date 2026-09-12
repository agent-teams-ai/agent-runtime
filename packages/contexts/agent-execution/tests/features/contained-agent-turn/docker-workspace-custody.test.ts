import assert from "node:assert/strict";
import {test} from "node:test";
import {validateDockerWorkspaceMounts, capturePinnedDockerWorkspace} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-workspace-custody.js";
import {ResidueIoScope} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-docker-residue-io.js";
import {FixtureResidueIo} from "./support/linux-docker-residue-fixture.ts";

const workspace = Object.freeze({dev: 5n, ino: 10n, mountId: "20"});
const privateRoot = Object.freeze({dev: 5n, ino: 11n, mountId: "21"});
const table = "1 0 0:1 / / ro - overlay overlay ro\n" +
  "20 1 0:5 /owned/workspace /workspace ro - ext4 disk rw\n" +
  "21 1 0:5 /owned/private /agent-private rw - ext4 disk rw\n";

test("mounted IDs are namespace-local and write mode is exact", () => {
  assert.doesNotThrow(() => validateDockerWorkspaceMounts(table, workspace, privateRoot, false));
  assert.throws(() => validateDockerWorkspaceMounts(table, workspace, privateRoot, true));
  assert.throws(() => validateDockerWorkspaceMounts(table, {...workspace, mountId: "999"}, privateRoot, false));
});
for (const [name, text] of [
  ["nested mount", table + "22 20 0:7 / /workspace/escape rw - tmpfs tmpfs rw\n"],
  ["alias", table + "22 1 0:5 /owned/workspace /etc/hosts ro - ext4 disk rw\n"],
  ["ancestor alias", table + "22 1 0:5 /owned /etc/hosts ro - ext4 disk rw\n"],
  ["unselected mount", table + "22 1 0:8 / /host ro - ext4 disk rw\n"],
  ["duplicate mount", table + "22 1 0:8 / /workspace ro - ext4 disk rw\n"],
  ["propagation", table.replace("ro - ext4", "ro shared:2 - ext4")],
  ["writable image", table.replace("/ / ro", "/ / rw")],
  ["private read only", table.replace("/agent-private rw", "/agent-private ro")],
] as const) {
  test(`rejects ${name}`, () => assert.throws(() => validateDockerWorkspaceMounts(text, workspace, privateRoot, false)));
}

test("pinned capture retains roots and detects namespace replacement around readback", async () => {
  const io = new FixtureResidueIo();
  io.directory("/proc/999", undefined, 65532);
  io.file("/proc/999/mountinfo", table, 65532);
  io.directory("/mounted"); io.directory("/mounted/workspace"); io.directory("/mounted/agent-private");
  io.directory("/namespace");
  const acquire = async (path: string) => {
    const parent = await io.open("/");
    try {return await io.child(parent, path.slice(1), true);} finally {await io.close(parent);}
  };
  // Fixture child enforces components: root and namespace are each one component.
  let swapped = false;
  Object.assign(io, {
    async procObject(_process: object, name: string) {
      if (name === "ns/mnt" && swapped) {io.node("/namespace").facts = {...io.node("/namespace").facts, ino: 999n};}
      return acquire(name === "root" ? "/mounted" : "/namespace");
    },
    async mountId(file: {fd: number}) {
      const path = io.handles.get(file.fd)!.path;
      return path.endsWith("workspace") ? "20" : path.endsWith("agent-private") ? "21" : "1";
    },
  });
  const scope = new ResidueIoScope(io, {signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000});
  const proc = await scope.protect(await scope.acquire(() => io.open("/proc")), true);
  const pinned = await scope.child(proc, "999", true, 65532);
  const capture = await capturePinnedDockerWorkspace(scope, pinned, false);
  assert.equal(capture.workspace.ino, io.node("/mounted/workspace").facts.ino);
  assert.ok(scope.files.size > 3);
  io.before = async (operation, node) => {if (operation === "read" && node.path.endsWith("mountinfo")) {swapped = true;}};
  await assert.rejects(capturePinnedDockerWorkspace(scope, pinned, false));
  await scope.close();
  assert.equal(io.handles.size, 0);
});

// Docker masks this kernel file on the supported Linux host; its source must
// still be disjoint from either owned bind root.
test("Docker masked interrupts mount is allowed without admitting owned-root aliases", () => {
  const masked = table + "22 1 0:7 /null /proc/interrupts rw - tmpfs tmpfs rw\n";
  assert.doesNotThrow(() => validateDockerWorkspaceMounts(masked, workspace, privateRoot, false));
  assert.throws(() => validateDockerWorkspaceMounts(
    table + "22 1 0:5 /owned/workspace /proc/interrupts ro - ext4 disk rw\n", workspace, privateRoot, false));
});

// Accepted Docker 29.6.1 shape: per-mount ro is independent of superblock rw.
const initLine = "22 1 8:1 /usr/libexec/docker/docker-init /usr/sbin/docker-init ro,relatime master:1 - ext4 /dev/vda1 rw,errors=remount-ro\n";
test("selected Docker init accepts only absent propagation or one positive master", () => {
  for (const line of [initLine, initLine.replace(" master:1", "")]) {
    assert.doesNotThrow(() => validateDockerWorkspaceMounts(table + line, workspace, privateRoot, false));
  }
});
for (const [name, line] of [
  ["source", initLine.replace("/usr/libexec/docker/docker-init", "/other")],
  ["destination", initLine.replace("/usr/sbin/docker-init", "/usr/bin/docker-init")],
  ["system destination", initLine.replace("/usr/sbin/docker-init", "/etc/hosts")],
  ["writable", initLine.replace("ro,relatime", "rw,relatime")],
  ["contradictory", initLine.replace("ro,relatime", "ro,rw")],
  ["duplicate options", initLine.replace("ro,relatime", "ro,ro")],
  ...["shared:1", "propagate_from:1", "master:0", "master:-1", "master:01", "master:x", "master", "master:1 master:2",
    "master:1 shared:2", "master:1 propagate_from:2", "unbindable"].map(value => [value, initLine.replace("master:1", value)]),
  ["duplicate path", initLine + initLine.replace("22 1", "23 1")],
  ["duplicate id", initLine.replace("22 1", "20 1")],
] as const) {
  test(`rejects init ${name}`, () => assert.throws(() => validateDockerWorkspaceMounts(table + line, workspace, privateRoot, false)));
}
test("init remains in owned source overlap checks", () => {
  for (const path of ["/owned/workspace", "/owned/private"]) {
    assert.throws(() => validateDockerWorkspaceMounts(table.replace(path, "/usr/libexec/docker") +
      initLine.replace("8:1", "0:5"), workspace, privateRoot, false));
  }
});

const initFixture = async () => {
  const io = new FixtureResidueIo();
  io.directory("/proc/999", undefined, 65532); io.file("/proc/999/mountinfo", table + initLine, 65532);
  for (const path of ["/mounted", "/mounted/workspace", "/mounted/agent-private", "/mounted/usr", "/mounted/usr/sbin", "/namespace"]) {io.directory(path);}
  const binary = io.file("/mounted/usr/sbin/docker-init", "synthetic");
  binary.facts = {...binary.facts, mode: 0o755, dev: 8n}; binary.filesystem = 8n;
  let binaryMountId = "22";
  Object.assign(io, {
    async procObject(_process: object, name: string) {
      const parent = await io.open("/");
      try {return await io.child(parent, name === "root" ? "mounted" : "namespace", true);} finally {await io.close(parent);}
    },
    async mountId(file: {fd: number}) {
      const path = io.handles.get(file.fd)!.path;
      return path.endsWith("docker-init") ? binaryMountId : path.endsWith("workspace") ? "20" : path.endsWith("agent-private") ? "21" : "1";
    },
  });
  const scope = new ResidueIoScope(io, {signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000});
  const proc = await scope.protect(await scope.acquire(() => io.open("/proc")), true);
  const pinned = await scope.child(proc, "999", true, 65532);
  return {io, scope, pinned, binary, setMountId: (id: string) => {binaryMountId = id;}};
};
test("pinned init capture crosses bind filesystem and retains both descriptors", async () => {
  const {io, scope, pinned} = await initFixture();
  try {
    await capturePinnedDockerWorkspace(scope, pinned, false);
    assert.equal([...io.handles.values()].filter(node => node.path.endsWith("docker-init")).length, 2);
    assert.equal(io.events.filter(event => event === "open:/mounted/usr").length, 2);
  } finally {await scope.close();}
  assert.equal(io.handles.size, 0);
});
for (const fault of ["directory", "symlink", "parent symlink", "owner", "group", "group write", "other write", "setuid", "setgid", "sticky", "not executable", "unlinked", "mount id",
  "replacement", "device replacement", "metadata replacement", "unlink readback", "mount replacement", "namespace replacement", "root replacement", "process replacement", "table replacement"]) {
  test(`pinned init rejects ${fault}`, async () => {
    const f = await initFixture(); const {io, scope, pinned, binary} = f;
    const modes: Record<string, number> = {"group write": 0o775, "other write": 0o757, setuid: 0o4755, setgid: 0o2755, sticky: 0o1755, "not executable": 0o644};
    if (fault in modes) {binary.facts = {...binary.facts, mode: modes[fault]!};}
    if (fault === "directory") {binary.facts = {...binary.facts, directory: true, file: false};}
    if (fault === "symlink") {binary.link = true;}
    if (fault === "parent symlink") {io.node("/mounted/usr").link = true;}
    if (fault === "owner") {binary.facts = {...binary.facts, uid: 123};}
    if (fault === "group") {binary.facts = {...binary.facts, gid: 123};}
    if (fault === "unlinked") {binary.facts = {...binary.facts, nlink: 0n};}
    if (fault === "mount id") {f.setMountId("999");}
    let reads = 0;
    io.before = async (operation, node) => {
      if (operation !== "read" || !node.path.endsWith("mountinfo") || ++reads !== 2) {return;}
      if (fault === "replacement") {const next = io.file(binary.path, "replacement"); next.facts = {...binary.facts, ino: 999n}; next.filesystem = binary.filesystem;}
      if (fault === "device replacement") {binary.facts = {...binary.facts, dev: 999n};}
      if (fault === "metadata replacement") {binary.facts = {...binary.facts, mode: 0o555};}
      if (fault === "unlink readback") {binary.facts = {...binary.facts, nlink: 0n};}
      if (fault === "mount replacement") {f.setMountId("999");}
      if (fault === "process replacement") {io.node("/proc/999").facts = {...pinned.facts, ino: 999n};}
      if (fault === "table replacement") {node.contents += "\n";}
    };
    // Namespace/root reopen occurs before the second mount-table read.
    if (fault === "namespace replacement" || fault === "root replacement") {
      io.before = async (operation, node) => {
        if (operation === "open" && node.path === (fault === "root replacement" ? "/mounted" : "/namespace")) {
          if (++reads === 2) {node.facts = {...node.facts, ino: 999n};}
        }
      };
    }
    try {await assert.rejects(capturePinnedDockerWorkspace(scope, pinned, false));} finally {await scope.close();}
    assert.equal(io.handles.size, 0);
  });
}
