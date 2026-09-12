import { workspacePackageSourceHref } from "./support/workspace-package-source.mjs";
const { NodeDockerCustodyJournalStorage, HostHttpEgressV4Journal, HostHttpEgressV4NodeStorage } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js"));
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createNodeDockerDeploymentRecipe as curatedFactory,
  type NodeDockerDeploymentRecipeInput} from "@agent-teams/agent-execution/composition";
const createNodeDockerDeploymentRecipe = curatedFactory;
const { NodeUnixSocketDockerEngine } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/node-unix-socket-docker-engine.js"));
const { isConcreteLinuxDockerLifecycle } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/node-linux-docker-residue-custody.js"));
const { policy, call, HOST, HOST_BOOT, DAEMON_BOOT } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/docker-engine-test-fixture.ts"));
const { subject, MemoryV4Storage } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/host-http-egress-v4-fixture.ts"));

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
  assert.throws(() => owner.consumption.prepare({} as never), /order conflict/u);
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

for (const field of ["selectedDockerAuthorityDigest", "networkNamespaceIdentity", "cgroupIdentity", "listenerIdentity", "signerIdentity"] as const) {
  test(`Node recipe captures the reader receiver once and rejects changed ${field}`, async t => {
    t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", async () => identity);
    t.mock.method(NodeDockerCustodyJournalStorage, "open", async () => ({}));
    t.mock.method(HostHttpEgressV4Journal.prototype, "prepare", async () => ({kind: "fresh"}));
    const references = {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`, networkNamespaceIdentity: "netns:1:2",
      cgroupIdentity: "cgroup:3:4", listenerIdentity: "listener:ipv4:172.30.0.1:43129", signerIdentity: `sha256:${"b".repeat(64)}`};
    let reads = 0;
    const selected = options("/synthetic/consumption-reference-test");
    const consumption = {...selected.consumption, readEnvelope(actual: typeof references) {
      assert.equal(this, consumption); assert.deepEqual(actual, references); assert.ok(Object.isFrozen(actual)); reads++;
      return {...actual, [field]: "changed"} as never;
    }};
    const owner = createNodeDockerDeploymentRecipe({...selected, consumption});
    consumption.readEnvelope = () => {throw new Error("replaced reader");};
    await owner.preparation.engineIdentity(call());
    owner.preparation.openLifecycle({...selected.enginePolicy, allowedNetworkName: "ar-test-consumption"});
    await owner.preparation.openResourceJournal({subject, observer: {readObservation() {throw new Error("unexpected pre-open observation");}}});
    assert.throws(() => owner.consumption.prepare(references), /observation reference changed/u);
    assert.equal(reads, 1);
    assert.throws(() => owner.consumption.prepare(references), /order conflict/u);
    assert.equal(reads, 1);
  });
}

test("actual recipe opening command persists through the real V4 journal and codec", async t => {
  const {v4Decode} = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js"));
  // Replace only external identity/storage boundaries; prepare and record validation stay real.
  t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", async () => identity);
  t.mock.method(NodeDockerCustodyJournalStorage, "open", async () => ({}));
  const memory = new MemoryV4Storage();
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "prepare", memory.prepare.bind(memory));
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "assertOwned", memory.assertOwned.bind(memory));
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "append", memory.append.bind(memory));
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "tombstone", memory.tombstone.bind(memory));
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "close", memory.close.bind(memory));
  const commands = new Set<string>();
  for (let index = 0; index < 2; index++) {
    memory.journal = null; memory.marker = null;
    const selected = options(`/synthetic/fresh-opening-${index}`);
    const owner = createNodeDockerDeploymentRecipe(selected);
    await owner.preparation.engineIdentity(call());
    owner.preparation.openLifecycle({...selected.enginePolicy, allowedNetworkName: "ar-test-opening"});
    const journal = await owner.preparation.openResourceJournal({subject,
      observer: {readObservation() {throw new Error("unexpected opening observation");}}});
    const records = v4Decode(memory.journal!);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.event.kind, "opened");
    assert.match(records[0]!.commandId, /^command:[a-f0-9]{64}$/u);
    commands.add(records[0]!.commandId);
    assert.equal(memory.marker, null);
    assert.equal(journal.evidence().reconcileRequired, false);
    await journal.close();
  }
  assert.equal(commands.size, 2);
});
