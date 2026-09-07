import assert from "node:assert/strict";
import {rm} from "node:fs/promises";
import test from "node:test";
import {DockerHostCustodyLifecycle} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {DockerCustodyJournal} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {dockerHostCustodyAttemptKey} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle-guards.js";
import {retainDockerImageInitOwner} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-image-init-owner.js";
import {imageInitFixture, INIT_HOST} from "../../fixtures/docker-image-init-fixture.ts";
import {call, disposable} from "../../fixtures/docker-engine-test-fixture.ts";
import {MemoryStorage, owner} from "./support/docker-host-custody-lifecycle-fixture.ts";

for (const fault of ["none", "image", "cancel", "deadline", "foreign-generation", "fake-owner", "copied-owner"] as const) {
  test(`created image verification precedes journal/start/attach and retains exact cleanup authority: ${fault}`, async t => {
    const root = await disposable(); t.after(() => rm(root, {recursive: true, force: true}));
    const f = await imageInitFixture(root);
    const journal = new DockerCustodyJournal(new MemoryStorage());
    const lifecycle = new DockerHostCustodyLifecycle(f.engine, journal, {async proveEmpty() {return "unknown";}});
    const controller = new AbortController();
    const invocation = {...call(), signal: controller.signal};
    const key = dockerHostCustodyAttemptKey(owner, f.input, await f.engine.identity(call()));
    let exact: typeof f.authority | undefined;
    const create = f.engine.create.bind(f.engine);
    t.mock.method(f.engine, "create", async (...args: Parameters<typeof create>) => {exact = await create(...args); return exact;});
    let forgedCalls = 0;
    const imageOwner = fault === "fake-owner" ? {
      async verifyCreated() {forgedCalls += 1; return {} as never;}, assertWitness() {forgedCalls += 1;},
    } : fault === "copied-owner" ? {...f.owner} : f.owner;
    if (fault === "image") {f.image.Id = `sha256:${"0".repeat(64)}`;}
    if (fault === "cancel") {f.state.afterArchive = () => controller.abort();}
    if (fault === "deadline") {
      f.state.afterArchive = () => {t.mock.method(Date, "now", () => invocation.deadlineEpochMs + 1);};
    }
    const imageInit = {owner: imageOwner, host: {...INIT_HOST,
      ...(fault === "foreign-generation" ? {hostLifecycleGenerationSha256: "9".repeat(64)} : {})}};
    if (fault === "none") {
      const launch = await lifecycle.launch({call: invocation, create: f.input, owner, imageInit});
      assert.strictEqual(launch.authority, exact);
      const witness = lifecycle.imageInitWitness(launch, INIT_HOST);
      f.owner.assertWitness(witness, exact!, INIT_HOST);
      assert.throws(() => f.owner.assertWitness({...witness}, exact!, INIT_HOST));
      assert.throws(() => lifecycle.imageInitWitness(launch, {...INIT_HOST, hostLifecycleGenerationSha256: "9".repeat(64)}));
      assert.ok(f.daemon.routes.findLastIndex(route => route.includes("/archive?")) <
        f.daemon.routes.findIndex(route => route.includes("/attach?")));
      assert.equal((await journal.lookup(key)).state, "init_ready");
      await lifecycle.contain({authority: launch.authority, key, call: call()});
    } else {
      await assert.rejects(lifecycle.launch({call: invocation, create: f.input, owner, imageInit}));
      t.mock.restoreAll();
      assert.equal((await journal.lookup(key)).state, "created");
      assert.equal(f.daemon.routes.some(route => /\/(?:start|attach)\?/u.test(route) || route.endsWith("/start")), false);
      assert.strictEqual(lifecycle.retainedAuthority(key), exact);
      // An unknown physical-empty observation keeps the exact container debt.
      const cleanup = await lifecycle.contain({authority: exact!, key, call: call()});
      assert.equal(cleanup.kind, "indeterminate");
      assert.equal(f.daemon.routes.some(route => route.startsWith("DELETE")), false);
    }
    assert.equal(forgedCalls, 0);
    assert.throws(() => retainDockerImageInitOwner(undefined as never));
    assert.throws(() => retainDockerImageInitOwner({...f.owner}));
  });
}
