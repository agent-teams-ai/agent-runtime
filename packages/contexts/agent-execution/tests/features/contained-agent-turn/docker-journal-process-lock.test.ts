import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  NodeDockerEgressJournalStorage,
  type DockerEgressTrustedRuntimeIdentity,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

const linuxTest = process.platform === "linux" ? test : test.skip;
const digest = (value: string): string => value.repeat(64).slice(0, 64);
const fence: DockerEgressTrustedRuntimeIdentity = Object.freeze({
  scopeSha256: digest("1"),
  hostSlotId: `host-slot:${digest("2")}`,
  hostInstanceId: `host-instance:${digest("3")}`,
  hostBootId: `host-boot:${digest("4")}`,
  executionGenerationId: `execution-generation:${digest("5")}`,
  daemonId: `daemon:${digest("6")}`,
  daemonGenerationId: `daemon-generation:${digest("7")}`,
  slotGenerationId: `slot-generation:${digest("8")}`,
});

const disposableRoots = async (): Promise<Readonly<{ root: string; v2: string; v3: string }>> => {
  const root = await mkdtemp(join(tmpdir(), "ar-egress-process-lock-"));
  const v2 = join(root, "v2");
  const v3 = join(root, "v3");
  await mkdir(v2, { mode: 0o700 });
  await mkdir(v3, { mode: 0o700 });
  return { root, v2, v3 };
};

const deferred = (): Readonly<{ promise: Promise<void>; resolve: () => void }> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
};

const waitForLocked = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child lock timeout: ${stderr}`)), 5_000);
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (stdout.includes("locked\n")) {
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before lock: ${String(code)}/${String(signal)} ${stderr}`));
    });
    child.stdout.on("data", onData);
  });
};

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

linuxTest("same storage instance rejects overlapping exclusives before the first await and stays open", async t => {
  const roots = await disposableRoots();
  const storage = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const entered = deferred();
  const release = deferred();
  const held = storage.exclusive(fence, async () => { entered.resolve(); await release.promise; return "held"; });
  t.after(async () => {
    release.resolve();
    await held.catch(() => {});
    await storage.close().catch(() => {});
    await rm(roots.root, { recursive: true, force: true });
  });
  await assert.rejects(storage.exclusive(fence, async () => "overlap"), { name: "DockerEgressJournalBusyError" });
  await entered.promise;
  await assert.rejects(storage.close(), { name: "DockerEgressJournalBusyError" });
  release.resolve();
  assert.equal(await held, "held");
});

linuxTest("independently opened storage instances contend in the kernel and a successor acquires", async t => {
  const roots = await disposableRoots();
  const owner = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const contender = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const entered = deferred();
  const release = deferred();
  const held = owner.exclusive(fence, async () => { entered.resolve(); await release.promise; });
  t.after(async () => {
    release.resolve();
    await held.catch(() => {});
    await Promise.all([owner.close().catch(() => {}), contender.close().catch(() => {})]);
    await rm(roots.root, { recursive: true, force: true });
  });
  await entered.promise;
  await assert.rejects(contender.exclusive(fence, async () => {}), { name: "DockerEgressJournalBusyError" });
  release.resolve();
  await held;
  assert.equal(await contender.exclusive(fence, async () => "successor"), "successor");
  assert.deepEqual(await readdir(roots.v3), []);
});

linuxTest("SIGKILL of the explicitly spawned holder releases its directory lock", async t => {
  const roots = await disposableRoots();
  const helper = join(import.meta.dirname, "docker-journal-process-lock-child.mjs");
  const encodedFence = Buffer.from(JSON.stringify(fence)).toString("base64url");
  const child = spawn(process.execPath, [helper, roots.v3, roots.v2, encodedFence], { stdio: ["pipe", "pipe", "pipe"] });
  const childExit = waitForExit(child);
  let successor: NodeDockerEgressJournalStorage | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); }
    await childExit.catch(() => {});
    await successor?.close().catch(() => {});
    await rm(roots.root, { recursive: true, force: true });
  });
  await waitForLocked(child);
  successor = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  await assert.rejects(successor.exclusive(fence, async () => {}), { name: "DockerEgressJournalBusyError" });
  assert.equal(child.kill("SIGKILL"), true);
  assert.deepEqual(await childExit, { code: null, signal: "SIGKILL" });
  assert.equal(await successor.exclusive(fence, async () => "after-crash"), "after-crash");
  await successor.close();
  successor = undefined;
});

linuxTest("two independently opened successors race to one winner while it remains held", { timeout: 5_000 }, async t => {
  const roots = await disposableRoots();
  const first = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const second = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const winnerEntered = deferred();
  const loserRejected = deferred();
  const releaseWinner = deferred();
  let race: readonly Promise<string>[] = [];
  t.after(async () => {
    releaseWinner.resolve();
    await Promise.allSettled(race);
    await Promise.all([first.close().catch(() => {}), second.close().catch(() => {})]);
    await rm(roots.root, { recursive: true, force: true });
  });
  let busy = 0;
  race = [first, second].map((storage, index) => storage.exclusive(fence, async () => {
    winnerEntered.resolve();
    await releaseWinner.promise;
    return `winner-${index}`;
  }).catch((error: unknown) => {
    assert.equal(error instanceof Error ? error.name : "", "DockerEgressJournalBusyError");
    busy += 1;
    loserRejected.resolve();
    return "busy";
  }));
  await winnerEntered.promise;
  await loserRejected.promise;
  assert.equal(busy, 1);
  releaseWinner.resolve();
  const results = await Promise.all(race);
  assert.equal(results.filter(result => result.startsWith("winner-")).length, 1);
  assert.equal(results.filter(result => result === "busy").length, 1);
});

linuxTest("callback exceptions release the process lock for a later instance", async t => {
  const roots = await disposableRoots();
  const first = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const successor = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  t.after(async () => {
    await Promise.all([first.close().catch(() => {}), successor.close().catch(() => {})]);
    await rm(roots.root, { recursive: true, force: true });
  });
  await assert.rejects(first.exclusive(fence, async () => { throw new Error(`sensitive path ${roots.v3}`); }), error => {
    assert.equal(error instanceof Error ? error.name : "", "DockerEgressJournalCorruptionError");
    assert.equal(error instanceof Error ? error.message.includes(roots.root) : true, false);
    return true;
  });
  assert.equal(await successor.exclusive(fence, async () => "released"), "released");
});

linuxTest("the legacy named-lock marker remains untouched inert residue", async t => {
  const roots = await disposableRoots();
  const marker = join(roots.v3, ".docker-egress-custody-v3.lock");
  await writeFile(marker, "legacy residue must remain\n", { mode: 0o600 });
  const storage = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  t.after(async () => { await storage.close().catch(() => {}); await rm(roots.root, { recursive: true, force: true }); });
  assert.equal(await storage.exclusive(fence, async () => "native-lock"), "native-lock");
  assert.deepEqual(await storage.scanV3(1), []);
  assert.equal(await readFile(marker, "utf8"), "legacy residue must remain\n");
});

linuxTest("root replacement during the acquired callback fails closed", async t => {
  const roots = await disposableRoots();
  const storage = await NodeDockerEgressJournalStorage.open(roots.v3, roots.v2);
  const moved = join(roots.root, "v3-moved");
  t.after(async () => { await storage.close().catch(() => {}); await rm(roots.root, { recursive: true, force: true }); });
  let callbackEntered = false;
  await assert.rejects(storage.exclusive(fence, async () => {
    callbackEntered = true;
    await rename(roots.v3, moved);
    await mkdir(roots.v3, { mode: 0o700 });
  }), { name: "DockerEgressJournalCorruptionError" });
  assert.equal(callbackEntered, true);
});
