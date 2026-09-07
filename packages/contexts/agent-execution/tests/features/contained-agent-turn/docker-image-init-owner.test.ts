import { v4Subject } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { subject as journalSubject } from "../../fixtures/host-http-egress-v4-fixture.ts";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  createDockerImageInitOwner, parseDockerImageReference, DOCKER_CUSTODY_INIT_ARGUMENTS,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import { call, disposable, IMAGE } from "../../fixtures/docker-engine-test-fixture.ts";
import { imageInitFixture, INIT_HOST, IMAGE_CONFIG, archive, NODE_BYTES, BOOTSTRAP_BYTES } from "../../fixtures/docker-image-init-fixture.ts";

test("independent repository selection binds actual config ID, fixed init bytes, platform and exact runtime witness before start", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const f = await imageInitFixture(root);
  const witness = await f.owner.verifyCreated(f.authority, call());
  assert.equal(witness.image.kind, "repository-digest");
  assert.equal(witness.image.reference, IMAGE);
  assert.equal(witness.imageConfigId, IMAGE_CONFIG);
  assert.equal(witness.init.bootstrap.sha256, f.lock.bootstrap.sha256);
  assert.equal(witness.host.hostLifecycleGenerationSha256, INIT_HOST.hostLifecycleGenerationSha256);
  f.owner.assertWitness(witness, f.authority, INIT_HOST);
  assert.ok(Object.isFrozen(witness) && Object.isFrozen(witness.init.bootstrap) && Object.isFrozen(witness.authority));
  assert.throws(() => f.owner.assertWitness({...witness}, f.authority, INIT_HOST), {code: "authority-conflict"});
  assert.throws(() => f.owner.assertWitness(witness, {...f.authority}, INIT_HOST), {code: "authority-conflict"});
  assert.throws(() => f.owner.assertWitness(witness, f.authority,
    {...INIT_HOST, hostLifecycleGenerationSha256: "9".repeat(64)}), {code: "authority-conflict"});
  const other = createDockerImageInitOwner({engine: f.engine, lock: f.lock, host: INIT_HOST});
  assert.throws(() => other.assertWitness(witness, f.authority, INIT_HOST), {code: "authority-conflict"});
  assert.equal(f.daemon.routes.some(route => route.includes("/start")), false);
  await f.engine.attachCustody(f.authority, call());
  await f.engine.start(f.authority, call());
  const start = f.daemon.routes.findIndex(route => route.includes("/start"));
  assert.ok(f.daemon.routes.filter(route => route.includes("/archive?")).length === 2);
  assert.ok(f.daemon.routes.findLastIndex(route => route.includes("/archive?")) < start);
  await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "authority-conflict"});
  // This remains a historical readback, not a lifetime assertion or start permit.
  f.owner.assertWitness(witness, f.authority, INIT_HOST);
});

test("native config IDs remain native through create and verification without inventing repository digests", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const f = await imageInitFixture(root, IMAGE_CONFIG);
  f.image.RepoDigests = null;
  assert.equal(v4Subject({...journalSubject, imageDigest: IMAGE_CONFIG}).imageDigest, IMAGE_CONFIG);
  const witness = await f.owner.verifyCreated(f.authority, call());
  assert.deepEqual(witness.image, {kind: "image-id", reference: IMAGE_CONFIG, sha256: "7".repeat(64)});
  assert.equal((f.daemon.bodies[0] as {Image: string}).Image, IMAGE_CONFIG);
  for (const invalid of ["latest", "sha256:abc", "sha256:" + "A".repeat(64), "repo@sha256:abc", null]) {
    assert.equal(parseDockerImageReference(invalid), undefined);
  }
});

test("mismatched selected image/config/platform and matching request text never authorize init start", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const mutations = [
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.image.Id = `sha256:${"0".repeat(64)}`;},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.image.RepoDigests = [];},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.image.Architecture = "arm64";},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.image.Os = "windows";},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.image.Variant = "v8";},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.state.transform = raw => {raw.Image = `sha256:${"0".repeat(64)}`;};},
    (f: Awaited<ReturnType<typeof imageInitFixture>>) => {f.state.transform = raw => {delete raw.Image;};},
  ];
  for (const mutate of mutations) {
    const f = await imageInitFixture(root); mutate(f);
    await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "authority-conflict"});
    assert.equal(f.daemon.routes.some(route => route.includes("/start")), false);
  }
});

test("actual interpreter or bundled closure byte substitution refuses despite independently matching configured identity strings", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  for (const field of ["interpreter", "bootstrap"] as const) {
    const f = await imageInitFixture(root);
    const expected = f.lock[field];
    const wrong = Buffer.from(field === "interpreter" ? NODE_BYTES : BOOTSTRAP_BYTES); wrong[0] ^= 1;
    f.archives.set(expected.path, archive(expected.path, wrong, expected.mode));
    await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "authority-conflict"});
    assert.equal(f.daemon.routes.some(route => route.includes("/start")), false);
  }
});

test("read-only root, exact entrypoint/args/environment and operation mount constraints are mandatory", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const transforms: Array<(raw: Record<string, unknown>) => void> = [
    raw => {(raw.HostConfig as Record<string, unknown>).ReadonlyRootfs = false;},
    raw => {raw.Path = "/workspace/node";},
    raw => {raw.Args = ["--require", "/tmp/preload.js", ...DOCKER_CUSTODY_INIT_ARGUMENTS];},
    raw => {(raw.Config as Record<string, unknown>).Entrypoint = ["/agent-private/node"];},
    raw => {(raw.Config as Record<string, unknown>).Cmd = ["/workspace/bootstrap.mjs"];},
    raw => {(raw.Config as Record<string, unknown>).Env = ["NODE_OPTIONS=--require=/tmp/a.js"];},
    raw => {(raw.Mounts as Array<Record<string, unknown>>)[0]!.Destination = "/ar-custody-init.mjs";},
  ];
  for (const transform of transforms) {
    const f = await imageInitFixture(root); f.state.transform = transform;
    await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "authority-conflict"});
    assert.equal(f.daemon.routes.some(route => route.includes("/start")), false);
  }
});

test("foreign Host boot, daemon drift during readback, and post-read container substitution refuse", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const f = await imageInitFixture(root);
  const foreign = createDockerImageInitOwner({engine: f.engine, lock: f.lock,
    host: {...INIT_HOST, hostBootGenerationSha256: "0".repeat(64)}});
  await assert.rejects(foreign.verifyCreated(f.authority, call()), {code: "authority-conflict"});
  f.state.afterArchive = () => {f.daemon.daemonBoot = "3".repeat(64);};
  await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "daemon-identity-changed"});
  const changed = await imageInitFixture(root);
  changed.state.afterArchive = () => {changed.state.transform = raw => {raw.Image = `sha256:${"0".repeat(64)}`;};};
  await assert.rejects(changed.owner.verifyCreated(changed.authority, call()), {code: "authority-conflict"});
});

test("selection snapshots reject writable code paths and hostile locks without invoking accessors", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const f = await imageInitFixture(root);
  for (const path of ["/workspace/init.mjs", "/tmp/init.mjs", "/agent-private/init.mjs", "/opt/init.mjs"]) {
    assert.throws(() => createDockerImageInitOwner({engine: f.engine, host: INIT_HOST,
      lock: {...f.lock, bootstrap: {...f.lock.bootstrap, path}}}), {code: "invalid-create-request"});
  }
  const lock = {...f.lock};
  Object.defineProperty(lock, "imageConfigId", {get: () => {throw new Error("accessor ran");}});
  assert.throws(() => createDockerImageInitOwner({engine: f.engine, lock, host: INIT_HOST}), {code: "invalid-create-request"});
  assert.throws(() => createDockerImageInitOwner({engine: f.engine, lock: new Proxy(f.lock, {}), host: INIT_HOST}), {code: "invalid-create-request"});
  // Mutating a supplied lock later cannot turn newly observed bytes into approval.
  (f.lock.bootstrap as {sha256: string}).sha256 = "0".repeat(64);
  const witness = await f.owner.verifyCreated(f.authority, call());
  assert.notEqual(witness.init.bootstrap.sha256, f.lock.bootstrap.sha256);
});

test("Engine archive truncation and unsupported media/status fail before init, and late identity drift cannot issue a witness", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  for (const fault of ["truncated", "media", "status", "image-drift", "aborted"] as const) {
    const f = await imageInitFixture(root);
    const controller = new AbortController();
    if (fault === "truncated") {f.archives.set(f.lock.bootstrap.path, f.archives.get(f.lock.bootstrap.path)!.subarray(0, 513));}
    if (fault === "media") {f.state.archiveType = "application/gzip";}
    if (fault === "status") {f.state.archiveStatus = 404;}
    if (fault === "image-drift") {f.state.afterArchive = () => {f.image.Id = `sha256:${"0".repeat(64)}`;};}
    if (fault === "aborted") {f.state.afterArchive = () => {controller.abort();};}
    await assert.rejects(f.owner.verifyCreated(f.authority, {...call(), signal: controller.signal}));
    assert.equal(f.daemon.routes.some(route => route.includes("/start")), false);
  }
});

test("tagged immutable reference preserves request identity while checking Engine's tag-free repository digest", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const tagged = IMAGE.replace("@", ":release@");
  const f = await imageInitFixture(root, tagged);
  const witness = await f.owner.verifyCreated(f.authority, call());
  assert.equal(witness.image.reference, tagged);
  assert.equal(witness.image.repositoryDigest, IMAGE);
  assert.equal(witness.image.kind, "repository-digest");
});

test("caller-authored Engine proof methods cannot replace concrete readback issuance", async t => {
  const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
  const f = await imageInitFixture(root);
  let invoked = false;
  const forged = createDockerImageInitOwner({host: INIT_HOST, lock: f.lock,
    engine: {verifyCreatedImageInit: async () => {invoked = true;}} as unknown as typeof f.engine});
  await assert.rejects(forged.verifyCreated(f.authority, call()));
  assert.equal(invoked, false);
  f.engine.verifyCreatedImageInit = async () => {invoked = true;};
  f.image.Id = `sha256:${"0".repeat(64)}`;
  await assert.rejects(f.owner.verifyCreated(f.authority, call()), {code: "authority-conflict"});
  assert.equal(invoked, false);
});
