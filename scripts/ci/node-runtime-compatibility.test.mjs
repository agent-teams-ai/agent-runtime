import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, rm, stat} from "node:fs/promises";
import {builtinModules} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {types} from "node:util";

const root = new URL("../../", import.meta.url);
const read = async path => (await import("node:fs/promises")).readFile(new URL(path, root), "utf8");

test("production default and pinned custody image remain Node 24", async () => {
  assert.equal((await read(".node-version")).trim(), "24.18.0");
  const manifest = JSON.parse(await read("package.json"));
  assert.equal(manifest.engines.node, ">=24.18.0 <25 || >=26.10.0 <27");
  const dockerfile = await read("packages/contexts/agent-execution/scripts/docker-custody-init/Dockerfile");
  assert.match(dockerfile, /^FROM node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base$/mu);
  const evidence = await read("docs/spikes/linux-nonroot-containment-egress-results.md");
  assert.match(evidence, /node:24\.18-bookworm-slim/u);
  assert.match(evidence, /sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d/u);
});

test("workspace artifacts expose the same bounded Node support policy", async () => {
  const manifests = [
    "packages/apps/embedded-runtime/package.json",
    "packages/contexts/agent-execution/package.json",
    "packages/contexts/provider-access/package.json",
    "packages/contexts/runtime-configuration/package.json",
    "packages/contexts/runtime-security/package.json",
    "packages/platform/filesystem-custody/package.json",
  ];
  for (const path of manifests) {
    const manifest = JSON.parse(await read(path));
    assert.equal(manifest.engines.node, ">=24.18.0 <25 || >=26.10.0 <27", path);
  }
});

test("Node APIs used by runtime adapters retain observable semantics", async () => {
  const target = {};
  const proxy = new Proxy(target, {});
  assert.equal(types.isProxy(proxy), true);
  assert.equal(types.isProxy(target), false);
  assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(createHash("sha256").update("agent-runtime").digest("hex").length, 64);
  const controller = new AbortController();
  controller.abort("qualified");
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, "qualified");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-runtime-node-compat-"));
  try {
    const facts = await stat(temporaryRoot);
    assert.equal(facts.isDirectory(), true);
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

test("native, module, and byte APIs used by runtime adapters remain observable", () => {
  assert.equal(typeof process.dlopen, "function");
  assert.equal(typeof process.umask, "function");
  assert.equal(types.isArrayBuffer(new ArrayBuffer(1)), true);
  assert.equal(types.isSharedArrayBuffer(new SharedArrayBuffer(1)), true);
  assert.equal(typeof import.meta.resolve("./node-runtime-compatibility.test.mjs"), "string");
  for (const name of ["assert", "buffer", "crypto", "fs", "fs/promises", "module", "process", "util", "worker_threads"]) {
    assert.ok(builtinModules.includes(name) || builtinModules.includes(`node:${name}`), name);
  }
  const previousUmask = process.umask(0o077);
  try {
    assert.equal(typeof previousUmask, "number");
  } finally {
    process.umask(previousUmask);
  }
});
