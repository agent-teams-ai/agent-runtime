import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNodeDockerDeploymentRecipe, type NodeDockerDeploymentRecipeInput}
  from "../../../contexts/agent-execution/dist/features/contained-agent-turn/composition/node-docker-deployment-recipe.js";
import {createNodeDockerDeploymentRecipe as curatedFactory} from "@agent-teams/agent-execution/composition";
import {NodeUnixSocketDockerEngine}
  from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/node-unix-socket-docker-engine.js";
import {isConcreteLinuxDockerLifecycle}
  from "../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-docker-residue-custody.js";
import {policy, call, HOST, HOST_BOOT, DAEMON_BOOT}
  from "../../../contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts";
import {subject} from "../../../contexts/agent-execution/tests/fixtures/host-http-egress-v4-fixture.ts";

const options = (root: string): NodeDockerDeploymentRecipeInput => {
  const {allowedNetworkName: _network, ...enginePolicy} = policy(root);
  return {enginePolicy, custodyJournalRoot: join(root, "custody"), resourceJournalRoot: join(root, "resource"),
    nsenter: {path: "/synthetic/nsenter", sha256: "a".repeat(64)}, nft: {path: "/synthetic/nft", sha256: "b".repeat(64)},
    consumption: {directory: {path: join(root, "consumption"), device: "1", inode: "1"},
      readEnvelope() {throw new Error("No actual consumption envelope in this test");}}};
};
const identity = {cgroupDriver: "systemd", cgroupVersion: "2" as const, daemonIdentitySha256: "d".repeat(64),
  daemonBootGenerationSha256: DAEMON_BOOT, hostIdentitySha256: HOST, hostBootGenerationSha256: HOST_BOOT,
  storageDriver: "overlay2", engineVersion: "29.6.1"};

test("construction is inert; lifecycle, V4 and consumption cannot run out of order", async () => {
  assert.equal(curatedFactory, createNodeDockerDeploymentRecipe);
  const selected = options("/synthetic/does-not-exist");
  const owner = createNodeDockerDeploymentRecipe(selected);
  assert.throws(() => owner.preparation.openLifecycle(policy("/synthetic/does-not-exist")), /order conflict/u);
  assert.throws(() => owner.preparation.openResourceJournal({subject, observer: {readObservation() {throw new Error("Unexpected observation before journal open");}}}), /order conflict/u);
  assert.throws(() => owner.consumption.prepare(), /order conflict/u);
  assert.throws(() => owner.route.engine.inspect({} as never, call()), /selected lifecycle/u);
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
  assert.throws(() => owner.preparation.engineIdentity(call()), /admission closed/u);
});

test("journal roots must be disjoint and outside the selected provider mounts", () => {
  const selected = options("/synthetic");
  for (const root of [selected.custodyJournalRoot, `${selected.custodyJournalRoot}/nested`,
    "/synthetic/private/ledger", "/synthetic/workspaces/ledger", "relative", "/synthetic/../ledger"]) {
    assert.throws(() => createNodeDockerDeploymentRecipe({...selected, resourceJournalRoot: root}), /journal roots/u);
  }
  assert.throws(() => createNodeDockerDeploymentRecipe({...selected,
    consumption: {...selected.consumption, directory: {...selected.consumption.directory, path: "/synthetic/private/consumption"}}}), /journal roots/u);
});

test("real custody storage and Linux residue lifecycle retain the network policy; failed V4 open closes locally", {skip: process.platform !== "linux", timeout: 30000}, async t => {
  const root = await mkdtemp(join(tmpdir(), "linux-codex-node-recipe-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const selected = options(root);
  await mkdir(selected.custodyJournalRoot, {mode: 0o700});
  // One narrow observation seam: no Engine socket or Docker effect is invoked.
  const observed = t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", async () => identity);
  const owner = createNodeDockerDeploymentRecipe(selected);
  assert.equal(await owner.preparation.engineIdentity(call()), identity);
  assert.equal(observed.mock.callCount(), 1);
  assert.throws(() => owner.preparation.engineIdentity(call()), /one-use/u);
  const boundPolicy = {...selected.enginePolicy, allowedNetworkName: "ar-operation-observed-network"};
  assert.throws(() => owner.preparation.openLifecycle({...boundPolicy, user: "1:1"}), /policy changed/u);
  assert.equal(isConcreteLinuxDockerLifecycle(owner.preparation.openLifecycle(boundPolicy)), true);
  assert.throws(() => owner.preparation.openLifecycle(boundPolicy), /order conflict/u);
  // No V4 directory exists. This exercises actual failed storage preparation,
  // followed by its descriptor cleanup, without native locks or network effects.
  await assert.rejects(owner.preparation.openResourceJournal({subject, observer: {readObservation() {throw new Error("Unexpected observation before journal open");}}}));
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
  assert.equal(await owner.releaseAfterHostCleanup(call()), "released");
});

test("cleanup timeout retains its flight and fences late identity publication", async t => {
  const gate = Promise.withResolvers<typeof identity>();
  t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", () => gate.promise);
  const owner = createNodeDockerDeploymentRecipe(options("/synthetic/unopened"));
  const read = owner.preparation.engineIdentity(call());
  const rejected = assert.rejects(read, /admission closed/u);
  assert.equal(await owner.releaseAfterHostCleanup(call(5)), "pending");
  gate.resolve(identity);
  await rejected;
  // The first observation may still join the old flight, whose original budget
  // expired. Retry only after that flight reports its settled pending result.
  const joined = await owner.releaseAfterHostCleanup(call());
  if (joined === "pending") {assert.equal(await owner.releaseAfterHostCleanup(call()), "released");}
  else {assert.equal(joined, "released");}
  assert.throws(() => owner.preparation.openLifecycle(policy("/synthetic/unopened")), /admission closed/u);
});
