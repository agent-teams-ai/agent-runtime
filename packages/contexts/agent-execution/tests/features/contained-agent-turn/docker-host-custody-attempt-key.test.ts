import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
  dockerHostCustodyAttemptKey,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {
  createDockerHostCustodyLifecycle,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import { FakeDockerEngine } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {
  dockerCustodyAttemptLocator,
  dockerCustodyOwnerIdentitySha256,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

import {MemoryStorage, engineCall, policy, createInput, owner, disposable} from "./support/docker-host-custody-lifecycle-fixture.ts";

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

/** Outer composition must be able to derive the operation network name before
 * `launch()` exists. That is only sound while the exported derivation reproduces
 * the key `launch()` binds internally, byte for byte, from the same three inputs. */
test("exported attempt key derivation reproduces the key launch binds internally", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const enginePolicy = policy(root);
  const engine = new FakeDockerEngine(enginePolicy);
  const lifecycle = createDockerHostCustodyLifecycle({
    engine, journalStorage: new MemoryStorage(), residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const create = createInput(root);

  const identity = await engine.identity(engineCall());
  const derived = dockerHostCustodyAttemptKey(owner, create, identity);
  const launched = await lifecycle.launch({ call: engineCall(), create, owner });

  assert.deepStrictEqual(derived, launched.key);
  assert.deepEqual(Reflect.ownKeys(derived), Reflect.ownKeys(launched.key));
  assert.ok(bytes(derived).equals(bytes(launched.key)), "canonical encodings differ");
  // The canonical journal digests are the actual bytes the owners bind against.
  assert.equal(dockerCustodyOwnerIdentitySha256(derived), dockerCustodyOwnerIdentitySha256(launched.key));
  assert.equal(dockerCustodyAttemptLocator(derived), dockerCustodyAttemptLocator(launched.key));
  await lifecycle.contain({ authority: launched.authority, call: engineCall(), key: launched.key });
});

/** R3: the key must stay independent of the Engine policy, or deriving the
 * network name from it before `launch()` would close a hash cycle through
 * `NetworkMode = policy.allowedNetworkName`. */
test("attempt key derivation ignores the allowed network name it will later select", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const create = createInput(root);
  const base = policy(root);
  const identity = await new FakeDockerEngine(base).identity(engineCall());
  const other = await new FakeDockerEngine({...base, allowedNetworkName: `ar-http-${"0".repeat(64)}`}).identity(engineCall());

  assert.deepStrictEqual(identity, other);
  assert.ok(bytes(dockerHostCustodyAttemptKey(owner, create, identity))
    .equals(bytes(dockerHostCustodyAttemptKey(owner, create, other))));
});

test("exported attempt key derivation rejects launch facts that are not canonical digests", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const create = createInput(root);
  const identity = await new FakeDockerEngine(policy(root)).identity(engineCall());
  for (const patch of [{launchFingerprintSha256: "latest"}, {operationNonceSha256: "latest"}]) {
    assert.throws(() => dockerHostCustodyAttemptKey(owner, {...create, ...patch}, identity));
  }
  assert.throws(() => dockerHostCustodyAttemptKey({...owner, tenantId: ""}, create, identity));
});
