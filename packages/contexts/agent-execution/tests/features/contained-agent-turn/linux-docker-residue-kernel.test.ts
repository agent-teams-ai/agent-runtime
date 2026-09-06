import assert from "node:assert/strict";
import {constants} from "node:fs";
import {mkdtemp, open, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {NodeLinuxDockerResidueIo, ResidueIoScope, CGROUP2_SUPER_MAGIC} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-docker-residue-io.js";
import {bootGeneration, checkResidueMounts, processCgroup, processPrivilege, processStart, recursivePopulation,
  residueParent} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/linux-docker-residue-parsers.js";
import {engineCall} from "./support/docker-host-custody-lifecycle-fixture.ts";
import {BOOT, privilegeText, statText} from "./support/linux-docker-residue-fixture.ts";

test("strict kernel records reject missing, duplicate, unknown, truncated and traversal facts", () => {
  assert.equal(recursivePopulation("populated 0\nfrozen 0\n"), "empty");
  assert.equal(recursivePopulation("populated 1\nfrozen 0\n"), "residue");
  for (const text of ["", "populated 0", "populated 0\n", "populated 2\nfrozen 0\n", "populated 0\nfrozen 0",
    "populated 0\npopulated 0\nfrozen 0\n", "populated 0\nfrozen 0\nunknown 1\n", "populated 0\nfrozen 0\n\n"]) {
    assert.throws(() => recursivePopulation(text));
  }
  assert.equal(processCgroup("0::/agent.slice/agent-runtime.slice/docker-abc.scope\n"),
    "/agent.slice/agent-runtime.slice/docker-abc.scope");
  for (const text of ["0::/\n", "0::/a/../b\n", "0::/a//b\n", "0::relative\n", "0::/a (deleted)\n",
    "0::/a\n1:cpu:/a\n", "0::/a\n0::/a\n", "0::/a", "0::/a/./b\n", "0::/a\\b\n"]) {
    assert.throws(() => processCgroup(text));
  }
  assert.equal(processStart(statText(500), 500), "12345");
  assert.equal(processStart(statText(500).replace("synthetic", "x)\n tricky"), 500), "12345");
  for (const text of [statText(501), statText(500).trim(), "500 (x) S 12345\n",
    statText(500).replace("12345", "NaN"), statText(500).replace("12345", "01"), statText(500, "18446744073709551616")]) {
    assert.throws(() => processStart(text, 500));
  }
  processPrivilege(privilegeText(), 65532, 65532);
  for (const text of [privilegeText().trim(), `${privilegeText()}Uid:\t65532\n`,
    privilegeText().replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"), privilegeText().replaceAll("65532", "0")]) {
    assert.throws(() => processPrivilege(text, 65532, 65532));
  }
  assert.equal(bootGeneration(`${BOOT}\n`).length, 64);
  assert.throws(() => bootGeneration(`${BOOT}\nignored`));
});

test("only exact supported driver topology and unoverlaid host kernel mounts are accepted", () => {
  assert.equal(residueParent("agent-runtime.slice", "systemd"), "/agent.slice/agent-runtime.slice");
  assert.equal(residueParent("operations/runtime", "cgroupfs"), "/operations/runtime");
  for (const parent of ["../runtime", "a/../runtime", "/absolute", "a//b", "a/./b", "a/", "a\\b"]) {
    assert.throws(() => residueParent(parent, "cgroupfs"));
  }
  for (const parent of ["system.slice/agent-runtime.slice", "-.slice", "invalid", "user@1000.slice"]) {
    assert.throws(() => residueParent(parent, "systemd"));
  }
  const valid = "1 0 0:1 / /proc rw - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
  checkResidueMounts(valid);
  for (const mounts of [valid.trim(), valid.replace("cgroup2", "cgroup"), valid.replace(" / /sys", " /delegated /sys"),
    valid + "3 0 0:1 / /proc/sys/kernel/random/boot_id ro - tmpfs tmpfs ro\n", valid + valid]) {
    assert.throws(() => checkResidueMounts(mounts));
  }
});

test("ordinary binfmt mounts and unrelated container churn preserve the retained kernel view", () => {
  const valid = "1 0 0:1 / /proc rw - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
  const signature = checkResidueMounts(valid);
  const ordinary = valid + "37 1 0:32 / /proc/sys/fs/binfmt_misc rw shared:13 - autofs systemd-1 rw\n" +
    "49 37 0:35 / /proc/sys/fs/binfmt_misc rw shared:46 - binfmt_misc binfmt_misc rw\n";
  assert.equal(checkResidueMounts(ordinary), signature);
  assert.equal(checkResidueMounts(ordinary + "77 0 0:77 / /var/lib/docker/rootfs/new rw - overlay overlay rw\n"), signature);
  assert.equal(checkResidueMounts(ordinary + "78 0 0:78 / /mnt/My\\040Volume-é rw - ext4 /dev/test rw\n"), signature);
  assert.notEqual(checkResidueMounts(valid.replace("1 0 0:1", "9 0 0:1")), signature);
  for (const target of ["/proc/sys", "/proc/sys/kernel", "/proc/sys/kernel/random/boot_id",
    "/proc/123/stat", "/proc/self/fd", "/sys/fs/cgroup/operation"]) {
    assert.throws(() => checkResidueMounts(valid + `99 1 0:9 / ${target} rw - tmpfs tmpfs rw\n`));
  }
});

test("actual Node FD backend rejects fixture symlinks, missing files and oversized/malformed UTF-8 reads",
  {skip: process.platform !== "linux"}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ar-residue-node-io-"));
  t.after(() => rm(directory, {force: true, recursive: true}));
  await writeFile(join(directory, "events"), "populated 0\nfrozen 0\n");
  await writeFile(join(directory, "large"), "x".repeat(129));
  await writeFile(join(directory, "binary"), Buffer.from([0, 255]));
  await symlink("events", join(directory, "alias"));
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  t.after(() => root.close());
  const io = new NodeLinuxDockerResidueIo();
  assert.notEqual(await io.filesystem(root), CGROUP2_SUPER_MAGIC, "ordinary fixtures never qualify as cgroup2");
  await assert.rejects(io.child(root, "alias", false));
  await assert.rejects(io.child(root, "missing", false), {code: "ENOENT"});
  await assert.rejects(io.child(root, "../events", false));
  await assert.rejects(io.directories(root), /unproven/u);
  for (const name of ["events", "large", "binary"]) {
    const file = await io.child(root, name, false);
    try {
      if (name === "events") {
        assert.equal(await io.read(file, 128), "populated 0\nfrozen 0\n");
        assert.equal(await io.read(file, 128), "populated 0\nfrozen 0\n", "each kernel read starts at offset zero");
      } else {await assert.rejects(io.read(file, 128));}
    } finally {await io.close(file);}
  }
});

test("FD budget is enforced before opening another descriptor", async () => {
  // A synthetic backend is unnecessary here: capacity rejection precedes I/O.
  const scope = new ResidueIoScope(new NodeLinuxDockerResidueIo(), engineCall());
  for (let fd = 0; fd < 256; fd += 1) {scope.files.add({fd});}
  let opened = false;
  await assert.rejects(scope.acquire(async () => {opened = true; return {fd: 300};}));
  assert.equal(opened, false);
});
