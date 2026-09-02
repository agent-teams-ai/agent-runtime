import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { readAr2CoverageTestSource } from "./validate-ar2-contract-artifacts.mjs";

const makeFifo = path => new Promise((resolve, reject) => {
  const child = spawn("mkfifo", [path], { stdio: "ignore" });
  child.once("error", reject);
  child.once("close", status => status === 0
    ? resolve()
    : reject(new Error("synthetic FIFO creation failed")));
});

export const registerAr2EvidenceCustodyRaceTests = () => test(
  "AR-2 descriptor custody rejects deterministic substitution and drift",
  async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ar2-evidence-races-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const relativePath = "packages/contexts/example/tests/race.test.ts";
  const target = join(fixtureRoot, relativePath);
  await mkdir(join(fixtureRoot, "packages", "contexts", "example", "tests"), { recursive: true });
  const evidenceRoot = pathToFileURL(`${fixtureRoot}/`);
  const base = { lstat, open, readdir, realpath };

  await t.test("rejects replacement between validation and descriptor open without reading it", async () => {
    await writeFile(target, "accepted-original\n");
    const original = `${target}.original`;
    let reads = 0;
    await assert.rejects(readAr2CoverageTestSource(relativePath, {
      evidenceRoot,
      fileSystem: {
        ...base,
        open: async (path, flags) => {
          await rename(path, original);
          await writeFile(path, "substituted-secret-bytes\n");
          const descriptor = await open(path, flags);
          return {
            close: () => descriptor.close(),
            read: (...arguments_) => {reads += 1; return descriptor.read(...arguments_);},
            stat: options => descriptor.stat(options),
          };
        },
      },
    }), /changed before descriptor binding/u);
    assert.equal(reads, 0, "substituted bytes must not be read or accepted");
    await rm(original);

    await writeFile(target, "accepted-original\n");
    let openedWithNonBlocking = false;
    await assert.rejects(readAr2CoverageTestSource(relativePath, {
      evidenceRoot,
      fileSystem: {
        ...base,
        open: async (path, flags) => {
          await rm(path);
          await makeFifo(path);
          openedWithNonBlocking = (flags & constants.O_NONBLOCK) !== 0;
          return open(path, flags);
        },
      },
    }), /opened evidence descriptor is not a singly-linked regular file/u);
    assert.equal(openedWithNonBlocking, true, "FIFO replacement must use O_NONBLOCK");
    await rm(target);
  });

  await t.test("rejects an ancestor swap before descriptor open without reading it", async () => {
    await writeFile(target, "accepted-original\n");
    const tests = join(fixtureRoot, "packages", "contexts", "example", "tests");
    const displaced = `${tests}.displaced`;
    let reads = 0;
    await assert.rejects(readAr2CoverageTestSource(relativePath, {
      evidenceRoot,
      fileSystem: {
        ...base,
        open: async (path, flags) => {
          await rename(tests, displaced);
          await mkdir(tests);
          await writeFile(path, "ancestor-substitution-bytes\n");
          const descriptor = await open(path, flags);
          return {
            close: () => descriptor.close(),
            read: (...arguments_) => {reads += 1; return descriptor.read(...arguments_);},
            stat: options => descriptor.stat(options),
          };
        },
      },
    }), /changed before descriptor binding/u);
    assert.equal(reads, 0, "ancestor-substituted bytes must not be read or accepted");
    await rm(tests, { recursive: true });
    await rename(displaced, tests);
  });

  await t.test("rejects descriptor identity drift after the bounded read", async () => {
    await writeFile(target, "accepted-original\n");
    let mutated = false;
    await assert.rejects(readAr2CoverageTestSource(relativePath, {
      evidenceRoot,
      fileSystem: {
        ...base,
        open: async (path, flags) => {
          const descriptor = await open(path, flags);
          return {
            close: () => descriptor.close(),
            read: async (...arguments_) => {
              const result = await descriptor.read(...arguments_);
              if (!mutated && result.bytesRead > 0) {
                mutated = true;
                await writeFile(path, "post-read-substitution\n");
              }
              return result;
            },
            stat: options => descriptor.stat(options),
          };
        },
      },
    }), /descriptor identity drifted during read/u);
    assert.equal(mutated, true);

    await writeFile(target, "accepted-original\n");
    const displaced = `${target}.displaced`;
    let replaced = false;
    await assert.rejects(readAr2CoverageTestSource(relativePath, {
      evidenceRoot,
      fileSystem: {
        ...base,
        open: async (path, flags) => {
          const descriptor = await open(path, flags);
          return {
            close: () => descriptor.close(),
            read: async (...arguments_) => {
              const result = await descriptor.read(...arguments_);
              if (!replaced && result.bytesRead > 0) {
                replaced = true;
                await rename(path, displaced);
                await writeFile(path, "replacement-after-open\n");
              }
              return result;
            },
            stat: options => descriptor.stat(options),
          };
        },
      },
    }), /(?:descriptor identity drifted|evidence path or an ancestor changed) during read/u);
    assert.equal(replaced, true);
    await rm(displaced);
  });
  },
);
