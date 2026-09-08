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
