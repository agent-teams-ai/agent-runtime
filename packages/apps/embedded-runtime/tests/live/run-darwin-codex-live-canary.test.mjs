import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {createHash} from "node:crypto";

import {createDarwinLiveActivationManifest} from "../package/live/darwin-live-activation-manifest.mjs";
import {consumeAttempt, loadAndVerifyActivation, main} from "./run-darwin-codex-live-canary.mjs";
import {executeOnePublicContainedTurn, verifyReleasedCleanup} from "./full-public-runtime.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "ar69-runner-"));
  const launcher = join(root, "launcher"), owner = join(root, "native-owner");
  const live = fileURLToPath(new URL(".", import.meta.url));
  const runtime = join(live, "full-public-runtime.mjs"), entrypoint = join(live, "host-child-entrypoint.mjs"), peer = join(root, "peer.node"), codex = join(root, "codex");
  await writeFile(launcher, "launcher", {mode: 0o700});
  await writeFile(owner, "owner", {mode: 0o700});
  await writeFile(peer, "peer"); await writeFile(codex, "codex", {mode: 0o700});
  const evidenceDirectory = join(root, "evidence");
  const activation = await createDarwinLiveActivationManifest({
    sourceRevision: "a".repeat(40), turn: {operationId: "operation:fixture", commandId: "command:fixture", effectId: "effect:fixture", attemptId: "attempt:fixture", executionGenerationId: "execution-generation:fixture", expectedMarker: "marker", frozenWorkspacePath: join(root, "frozen-workspace"), resultPath: join(root, "frozen-workspace", "result.txt"), sourceMessagePath: join(root, "input", "nested", "message.txt"), taskPath: join(root, "TASK.md"), scope: {tenantId: "tenant", projectId: "project"}, expectedResultSha256: "1".repeat(64), expectedTaskSha256: "2".repeat(64), maximumObservations: 4, observeTimeoutMs: 1000}, infrastructure: {identities: {operationId: "operation:fixture", attemptId: "attempt:fixture", effectId: "effect:fixture", executionGenerationId: "execution-generation:fixture", custodyId: "custody:fixture"}, database: {}, providerAccess: {}, runtimeSecurity: {}, filesystem: {}, host: {}, deployment: {}, verification: {}, native: {}}, closure: [
      {role: "runner", path: join(live, "run-darwin-codex-live-canary.mjs")}, {role: "host-entrypoint", path: entrypoint},
      {role: "full-public-runtime", path: runtime},
      {role: "root-packet-builder", path: join(live, "darwin-native-root-packet.mjs")},
      {role: "root-launcher", path: launcher},
      {role: "native-owner", path: owner},
      {role: "codex", path: codex}, {role: "host-peer-addon", path: peer},
    ], consumerStandardRevision: "b".repeat(40),
    codexPath: codex, codexSha256: sha("codex"), native: {rootLauncherPath: launcher, ownerPath: owner},
    database: {identitySha256: "d".repeat(64)}, source: {inventorySha256: "e".repeat(64)},
    evidenceDirectory,
  });
  const activationPath = join(root, "activation.json");
  await writeFile(activationPath, JSON.stringify(activation));
  return {root, activation, activationPath, evidenceDirectory};
};

test("preflight refuses while the exact production root is absent", async () => {
  const value = await fixture();
  try {
    await assert.rejects(loadAndVerifyActivation(value.activationPath), /closure role production-root is missing/);
    await assert.rejects(main(["--preflight", value.activationPath]), /closure role production-root is missing/);
    await assert.rejects(readFile(join(value.evidenceDirectory, "attempt-consumed.json")), {code: "ENOENT"});
  } finally {await rm(value.root, {recursive: true, force: true});}
});


test("CLI preflight passes the verified canonical activation to root packet validation", async () => {
  let prepared;
  await main(["--preflight", "/fixed/activation.json"], {
    loadActivation: async () => ({manifest: {sourceRevision: "a".repeat(40)}, manifestPath: "/canonical/activation.json"}),
    prepareRootLaunch: async path => {prepared = path;},
    withOperatorProviderAccess: async manifest => manifest,
    preflightInfrastructure: async () => ({hostEndpointReachable: true, databaseEmpty: true,
      sourceResultAbsent: true, providerAuthoritiesFresh: true, mutated: false}),
  });
  assert.equal(prepared, "/canonical/activation.json");
});

const inertReadback = () => ({hostEndpointReachable: true, databaseEmpty: true,
  sourceResultAbsent: true, providerAuthoritiesFresh: true, mutated: false});
const preflightDependencies = readback => ({
  loadActivation: async () => ({manifest: {sourceRevision: "a".repeat(40),
    routeInstalled: true, routeReadbackCurrent: true}, manifestPath: "/canonical/activation.json"}),
  prepareRootLaunch: async () => {},
  withOperatorProviderAccess: async manifest => manifest,
  preflightInfrastructure: async () => readback,
});

test("inert preflight permits an uninstalled per-operation route before claim", async () => {
  await main(["--preflight", "/fixed/activation.json"], preflightDependencies({
    ...inertReadback(), routeInstalled: false, routeReadbackCurrent: false,
  }));
});

for (const field of Object.keys(inertReadback())) {
  test(`inert preflight rejects missing or invalid ${field} despite activation assertions`, async () => {
    for (const invalid of [undefined, null, "true", field === "mutated"]) {
      await assert.rejects(main(["--preflight", "/fixed/activation.json"],
        preflightDependencies({...inertReadback(), [field]: invalid})), /inert infrastructure readback refused/);
    }
  });
}

test("inert preflight rejects missing readback", async () => {
  await assert.rejects(main(["--preflight", "/fixed/activation.json"],
    preflightDependencies()), /inert infrastructure readback refused/);
});

test("failed packet validation prevents infrastructure inspection", async () => {
  let inspected = false;
  await assert.rejects(main(["--preflight", "/fixed/activation.json"], {
    ...preflightDependencies(inertReadback()),
    prepareRootLaunch: async () => {throw new Error("packet rejected");},
    preflightInfrastructure: async () => {inspected = true; return inertReadback();},
  }), /packet rejected/);
  assert.equal(inspected, false);
});

test("attempt marker is exclusive and cannot be replayed", async () => {
  const value = await fixture();
  try {
    await mkdir(value.evidenceDirectory, {mode: 0o700});
    await consumeAttempt(value.activation, value.evidenceDirectory);
    await assert.rejects(consumeAttempt(value.activation, value.evidenceDirectory));
  } finally {await rm(value.root, {recursive: true, force: true});}
});

test("accepted observation failure persists the operation for reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar69-uncertain-"));
  let acceptedOperation;
  const host = {bindAccess: () => ({containedTurn: {
    submit: async () => ({status: "accepted", operationId: "op:uncertain"}),
    observe: async () => {throw new Error("channel lost");},
  }})};
  try {
    const result = await executeOnePublicContainedTurn({host, scope: {tenantId: "t", projectId: "p"}, evidenceDirectory: root,
      maximumObservations: 1, observeTimeoutMs: 1000, onAccepted: operationId => {acceptedOperation = operationId;}});
    assert.equal(acceptedOperation, "op:uncertain");
    assert.equal(result.uncertainty.operationId, "op:uncertain");
    assert.match(await readFile(join(root, "reconciliation-debt.json"), "utf8"), /op:uncertain/);
  } finally {await rm(root, {recursive: true, force: true});}
});

for (const [name, observation, expected] of [
  ["not found", {status: "not_found"}, "observation_not_found"],
  ["reconcile required", {status: "observed", turn: {status: "reconcile_required"}}, "reconcile_required"],
  ["exhausted running", {status: "observed", turn: {status: "running"}}, "observation_exhausted"],
]) {
  test(`accepted ${name} observation retains reconciliation debt`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ar69-observe-debt-"));
    const host = {bindAccess: () => ({containedTurn: {
      submit: async () => ({status: "accepted", operationId: "op:debt"}), observe: async () => observation,
    }})};
    try {
      const result = await executeOnePublicContainedTurn({host, scope: {}, evidenceDirectory: root, maximumObservations: 1, observeTimeoutMs: 1000});
      assert.equal(result.uncertainty.reason, expected);
    } finally {await rm(root, {recursive: true, force: true});}
  });
}

test("potential acceptance is never treated as a retryable refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar69-potential-"));
  const host = {bindAccess: () => ({containedTurn: {submit: async () => ({status: "potential_acceptance", candidateOperationId: "op:candidate"})}})};
  try {
    const result = await executeOnePublicContainedTurn({host, scope: {}, evidenceDirectory: root, maximumObservations: 1, observeTimeoutMs: 1000});
    assert.equal(result.uncertainty.reason, "potential_acceptance");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("unbounded observation is rejected before submit", async () => {
  let submits = 0;
  const host = {bindAccess: () => ({containedTurn: {submit: async () => {submits += 1;}}})};
  await assert.rejects(executeOnePublicContainedTurn({host, scope: {}, maximumObservations: Infinity, observeTimeoutMs: 1000}), /bounds are invalid/);
  await assert.rejects(executeOnePublicContainedTurn({host, scope: {}, maximumObservations: 1, observeTimeoutMs: 30_001}), /bounds are invalid/);
  assert.equal(submits, 0);
});

test("public handle submits once and observes serially to terminal truth", async () => {
  const root = await mkdtemp(join(tmpdir(), "ar69-public-"));
  let submits = 0, active = 0, maximumActive = 0, observations = 0;
  const turn = {status: "succeeded", provider: "codex", resultRef: "result:1", artifactManifestRef: "artifact:1", output: []};
  const host = {bindAccess: scope => {
    assert.deepEqual(scope, {containedTurn: {tenantId: "t", projectId: "p"}});
    return {containedTurn: {
      submit: async input => {submits += 1; assert.equal(input.intent.mode, "workspace-write"); assert.equal(input.expectedProvider, "codex"); return {status: "accepted", operationId: "op:1"};},
      observe: async (_id, {signal}) => {assert.equal(signal.aborted, false); active += 1; maximumActive = Math.max(maximumActive, active); observations += 1; active -= 1; return {status: "observed", turn};},
    }};
  }};
  try {
    const result = await executeOnePublicContainedTurn({host, scope: {tenantId: "t", projectId: "p"}, evidenceDirectory: root, maximumObservations: 2, observeTimeoutMs: 1000});
    assert.equal(result.terminal.turn.status, "succeeded");
    assert.deepEqual({submits, observations, maximumActive}, {submits: 1, observations: 1, maximumActive: 1});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("activation generator pins exact closure bytes", async () => {
  const value = await fixture();
  try {assert.equal(value.activation.files[0].sha256, sha(await readFile(value.activation.files[0].path)));}
  finally {await rm(value.root, {recursive: true, force: true});}
});

test("cleanup predicate requires only concrete final owner readbacks", () => {
  const released = {status: "released", persistence: {repositoryClosed: true, decisionsClosed: true}, pool: {closed: true},
    database: {kind: "observed", otherSessions: 0, preparedTransactions: 0, inspectorClosed: true},
    providerAccess: {disposed: true}, native: {closureAcknowledged: true}, output: {closed: true},
    custody: {identity: {status: "proved"}, sealed: true,
      closure: {profile: "native-darwin-attempt-owner", status: "closed"},
      stdout: {status: "complete"}, stderr: {status: "complete"}},
    http: {receipts: [], gaps: []}, verification: {artifactManifestVerified: true,
      sourceInventoryVerified: true, resultRehydrated: true}, gaps: [], failures: []};
  assert.doesNotThrow(() => verifyReleasedCleanup(released));
  assert.throws(() => verifyReleasedCleanup({...released,
    database: {...released.database, otherSessions: 1}}), /cleanup release/);
});
