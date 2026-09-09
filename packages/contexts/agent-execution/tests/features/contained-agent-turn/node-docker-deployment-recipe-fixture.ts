import assert from "node:assert/strict";
import {mkdtemp, mkdir, open, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {TestContext} from "node:test";
import {createNodeDockerDeploymentRecipe} from "../../../dist/features/contained-agent-turn/composition/node-docker-deployment-recipe.js";
import {NodeUnixSocketDockerEngine, NodeDockerCustodyJournalStorage, HostHttpEgressV4NodeStorage} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {MemoryV4Storage, SyntheticV4Owner, subject} from "../../fixtures/host-http-egress-v4-fixture.ts";
import {call, policy} from "../../fixtures/docker-engine-test-fixture.ts";
import {v4Hash} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import type {HostHttpEgressV4Intent, HostHttpEgressV4Observed} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";
import {pin as pinDirectory} from "./host-http-consumption-journal-fixture.mjs";

// Synthetic Engine identity and storage seams only: no socket, container, native
// process lock or provider launch. The production recipe and V4 validator run.
export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ar-recipe-retirement-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const consumptionPath = join(root, "consumption");
  await mkdir(consumptionPath, {mode: 0o700});
  const storage = new MemoryV4Storage();
  const closes: string[] = [];
  t.mock.method(NodeUnixSocketDockerEngine.prototype, "identity", async () => ({}));
  t.mock.method(NodeDockerCustodyJournalStorage, "open", async () => ({close: async () => {closes.push("custody");}}));
  for (const method of ["prepare", "assertOwned", "append"] as const) {
    t.mock.method(HostHttpEgressV4NodeStorage.prototype, method, storage[method].bind(storage));
  }
  const tombstonePath = join(root, "retained.tombstone");
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "tombstone", async (bytes: Uint8Array) => {
    await storage.tombstone(bytes);
    const file = await open(tombstonePath, "wx", 0o600);
    try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  });
  t.mock.method(HostHttpEgressV4NodeStorage.prototype, "close", async () => {closes.push("resource");});
  const pin = {path: "/synthetic/never-executed", sha256: "a".repeat(64)};
  const references = {selectedDockerAuthorityDigest: `sha256:${"a".repeat(64)}`,
    networkNamespaceIdentity: "network:test", cgroupIdentity: "cgroup:test", listenerIdentity: "listener:test", signerIdentity: "signer:test"};
  const recipe = createNodeDockerDeploymentRecipe({enginePolicy: policy(root), custodyJournalRoot: join(root, "custody"),
    resourceJournalRoot: join(root, "resource"), nsenter: pin, nft: pin,
    consumption: {directory: pinDirectory(consumptionPath),
      readEnvelope: refs => ({...refs, tenantId: "tenant:test", projectId: "project:test", operationId: "operation:test",
        scopeDigest: `sha256:${"b".repeat(64)}`, attemptId: "attempt:test", custodyId: "custody:test",
        hostInstanceId: "host-instance:test", hostBootId: "host-boot:test", executionGenerationId: "execution-generation:test"})}});
  await recipe.preparation.engineIdentity(call());
  recipe.preparation.openLifecycle(policy(root));
  const owner = new SyntheticV4Owner();
  const journal = await recipe.preparation.openResourceJournal({subject, observer: owner});
  let serial = 0;
  const command = () => `command:${v4Hash(++serial)}`;
  const intent = (kind: HostHttpEgressV4Intent) => journal.recordIntent(command(), {kind, targetSha256: journal.target(kind)});
  const observe = (kind: HostHttpEgressV4Observed) => journal.recordObservation(command(), owner.token({kind,
    subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: journal.target(kind),
    actualSha256: v4Hash([kind, serial]), evidenceSha256: v4Hash(["evidence", serial]), container: null, writeOutcome: null}));
  async function partial(missing?: HostHttpEgressV4Observed) {
    await intent("network_intent"); await observe("network_allocated"); await intent("listener_intent");
    await intent("cutoff");
    assert.equal(journal.evidence().reconcileRequired, true);
    // Later endpoint observations have prerequisites. Keep the valid prefix
    // when removing an earlier proof instead of inventing impossible evidence.
    if (missing === "cutoff_observed") {return;}
    await observe("cutoff_observed");
    if (missing === "container_absent") {return;}
    await observe("container_absent"); await intent("listener_release");
    if (missing === "listener_absent") {return;}
    await observe("listener_absent"); await intent("network_release");
    if (missing !== "network_absent") {await observe("network_absent");}
  }
  return {recipe, journal, storage, closes, partial, observe, references, tombstonePath, consumptionPath};
}

