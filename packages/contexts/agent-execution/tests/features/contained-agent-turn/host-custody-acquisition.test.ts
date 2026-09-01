import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hostCustodyDescriptorLaunchTestSupport,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-descriptor-launch.js";
import {
  hostCustodyLaunchTestSupport,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";

const observation = (path: string, dev: bigint, ino: bigint) => Object.freeze({
  ctimeNs: 1n,
  dev,
  ino,
  mode: 0o40700n,
  path,
  uid: 1000n,
});

const executableObservation = Object.freeze({
  ctimeNs: 1n,
  dev: 1n,
  digest: "0".repeat(64),
  ino: 1n,
  mode: 0o100500n,
  mtimeNs: 1n,
  nlink: 1n,
  size: 0n,
});

test("private launch reservation rejects filesystem-object aliases", () => {
  const assertDistinct = hostCustodyLaunchTestSupport.assertDistinctPrivateFilesystemObjects;
  assert.throws(
    () => assertDistinct({ dev: 1n, ino: 10n }, { dev: 1n, ino: 10n }, {}),
    /distinct filesystem objects/u,
  );
  assert.throws(
    () => assertDistinct(
      { dev: 1n, ino: 10n },
      { dev: 1n, ino: 20n },
      { HOME: { dev: 1n, ino: 30n }, TMPDIR: { dev: 1n, ino: 30n } },
    ),
    /distinct filesystem objects/u,
  );
  assert.throws(
    () => assertDistinct(
      { dev: 1n, ino: 10n },
      { dev: 1n, ino: 20n },
      { HOME: { dev: 1n, ino: 10n } },
    ),
    /distinct filesystem objects/u,
  );
});

test("acquired private descriptors reject filesystem-object aliases", () => {
  const assertDistinct = hostCustodyDescriptorLaunchTestSupport.assertDistinctDescriptorObjects;
  assert.throws(
    () => assertDistinct([
      { dev: 1n, ino: 10n },
      { dev: 1n, ino: 20n },
      { dev: 1n, ino: 10n },
    ]),
    /distinct filesystem objects/u,
  );
  assert.doesNotThrow(() => assertDistinct([
    { dev: 1n, ino: 10n },
    { dev: 1n, ino: 20n },
    { dev: 1n, ino: 30n },
  ]));
});

test("second private descriptor acquisition failure closes only the first descriptor", () => {
  const failure = new Error("synthetic second acquisition failure");
  const closed: number[] = [];
  let opens = 0;
  const privatePaths = Object.freeze({
    byEnvironmentKey: Object.freeze({
      HOME: observation("/private/home", 1n, 30n),
      TMPDIR: observation("/private/tmp", 1n, 40n),
    }),
    environmentKeys: Object.freeze(["HOME", "TMPDIR"]),
    root: observation("/private", 1n, 20n),
  });

  assert.throws(() => hostCustodyDescriptorLaunchTestSupport.openPrivateDescriptors(privatePaths, {
    close(descriptor: number) {closed.push(descriptor);},
    open() {
      opens += 1;
      if (opens === 2) {throw failure;}
      return 71;
    },
  }), error => error === failure);
  assert.deepEqual(closed, [71]);
});

test("sealed executable collision preserves the pre-existing entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-custody-seal-collision-"));
  const sealedPath = join(root, "sealed");
  try {
    await writeFile(sealedPath, "foreign", { mode: 0o500 });
    assert.throws(
      () => hostCustodyDescriptorLaunchTestSupport.sealExecutableDescriptor(
        executableObservation,
        -1,
        sealedPath,
      ),
      error => error instanceof Error && "code" in error && error.code === "EEXIST",
    );
    assert.equal(await readFile(sealedPath, "utf8"), "foreign");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("sealed executable failure never removes a replacement foreign entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-custody-seal-replacement-"));
  const sourcePath = join(root, "source");
  const sealedPath = join(root, "sealed");
  const failure = new Error("synthetic copy failure after replacement");
  await writeFile(sourcePath, "source", { mode: 0o500 });
  const sourceDescriptor = openSync(sourcePath, constants.O_RDONLY);
  try {
    assert.throws(() => hostCustodyDescriptorLaunchTestSupport.sealExecutableDescriptor(
      executableObservation,
      sourceDescriptor,
      sealedPath,
      {
        chmod: fchmodSync,
        close: closeSync,
        fstat: descriptor => fstatSync(descriptor, { bigint: true }),
        lstat: path => lstatSync(path, { bigint: true }),
        open: openSync,
        read: descriptor => readFileSync(descriptor),
        sync: fsyncSync,
        unlink: unlinkSync,
        write() {
          unlinkSync(sealedPath);
          writeFileSync(sealedPath, "foreign", { mode: 0o500 });
          throw failure;
        },
      },
    ), error => error === failure);
    assert.equal(await readFile(sealedPath, "utf8"), "foreign");
  } finally {
    closeSync(sourceDescriptor);
    await rm(root, { force: true, recursive: true });
  }
});
