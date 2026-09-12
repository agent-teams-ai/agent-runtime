import { workspacePackageSourceHref } from "../support/workspace-package-source.mjs";
const unused = async () => Object.freeze({kind: "not_found" as const});
import {strict as assert} from "node:assert";
import {test} from "node:test";
import {createLinuxCodexLiveCredentialInventory, assertLinuxCodexLiveAdminIdentity, LinuxCodexLiveAdminSetupError, setupLinuxCodexLiveAdmin, snapshotLinuxCodexLiveAdminRoute} from "./linux-codex-live-admin.ts";

// Invalid administration never reaches a Pool or runtime owner. These are
// malformed-input tests, not mocked PA/RS/custody authority or live tests.
test("invalid approval erases transferred bytes and retains a retryable cleanup handle", async () => {
  const material = {token: new Uint8Array([65, 66]), accountId: new Uint8Array([67, 68])};
  let failure: LinuxCodexLiveAdminSetupError | undefined;
  try {
    await setupLinuxCodexLiveAdmin(undefined as never, undefined as never, undefined as never, material);
    assert.fail("malformed approval must fail before administrative I/O");
  } catch (error) {
    assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
    failure = error;
  }
  assert.deepEqual([...material.token, ...material.accountId], [0, 0, 0, 0]);
  assert.ok(failure);
  assert.equal(failure.directory, undefined);
  assert.equal(Object.hasOwn(failure, "cause"), false);
  // There is no owner to observe on this path, hence no fabricated deadline.
  assert.equal(await failure.cleanup(undefined as never), "released");
  assert.equal(await failure.cleanup(undefined as never), "released");
});

test("concurrent early-failure cleanup shares the retained flight", async () => {
  const material = {token: new Uint8Array([1]), accountId: new Uint8Array([2])};
  try {
    await setupLinuxCodexLiveAdmin(undefined as never, undefined as never, undefined as never, material);
    assert.fail("expected administrative setup failure");
  } catch (error) {
    assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
    const first = error.cleanup(undefined as never);
    const second = error.cleanup(undefined as never);
    assert.equal(first, second);
    assert.equal(await first, "released");
  }
});

test("approval snapshot failure erases transferred arrays despite producer slot replacement", async () => {
  const token = new Uint8Array([65, 66]);
  const accountId = new Uint8Array([67, 68]);
  const replacement = new Uint8Array([69]);
  const material = {token, accountId};
  const approval = {get binding() {
    material.token = replacement;
    material.accountId = replacement;
    throw new Error("snapshot failed");
  }};
  await assert.rejects(
    setupLinuxCodexLiveAdmin(undefined as never, approval as never, undefined as never, material),
    error => {
      assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
      assert.equal(error.directory, undefined);
      return true;
    },
  );
  assert.deepEqual([...token, ...accountId], [0, 0, 0, 0]);
  assert.deepEqual([...replacement], [69]);
});

test("route snapshot preserves native cancellation while isolating mutable data", () => {
  const controller = new AbortController();
  const data = {operationAbortSignal: controller.signal, descriptor: {recipeRevision: "before"}};
  const captured = snapshotLinuxCodexLiveAdminRoute(data as never);
  data.descriptor.recipeRevision = "after";
  assert.equal(captured.operationAbortSignal, controller.signal);
  assert.equal((captured.descriptor as unknown as {recipeRevision: string}).recipeRevision, "before");
  let cancelled = false;
  captured.operationAbortSignal.addEventListener("abort", () => {cancelled = true;}, {once: true});
  controller.abort();
  assert.equal(cancelled, true);
  assert.equal(captured.operationAbortSignal.aborted, true);
});


test("deployment requires positive matching container, native and real/effective process identities", t => {
  const processIdentity = {getuid: 1000, geteuid: 1000, getgid: 1000, getegid: 1000};
  for (const name of ["getuid", "geteuid", "getgid", "getegid"] as const) {
    // Install each mock once so restoration cannot retain an earlier UID mock.
    t.mock.method(process, name, () => processIdentity[name]);
  }
  const node = {enginePolicy: {user: "1000:1000"}, native: {ownerUid: 1000, ownerGid: 1000}};
  assert.doesNotThrow(() => assertLinuxCodexLiveAdminIdentity(node as never));
  for (const user of ["0:0", "1001:1000", "1000:1001", "01000:1000"]) {
    assert.throws(() => assertLinuxCodexLiveAdminIdentity({...node, enginePolicy: {user}} as never));
  }
  for (const native of [{ownerUid: 0, ownerGid: 1000}, {ownerUid: 1000, ownerGid: 0}]) {
    assert.throws(() => assertLinuxCodexLiveAdminIdentity({...node, native} as never));
  }
  for (const name of ["getuid", "geteuid", "getgid", "getegid"] as const) {
    processIdentity[name] = 0;
    assert.throws(() => assertLinuxCodexLiveAdminIdentity(node as never));
    processIdentity[name] = 1000;
  }
});

test("root Host rejects before configuration I/O or allocation and erases material", async t => {
  t.mock.method(process, "getuid", () => 0);
  const material = {token: new Uint8Array([1]), accountId: new Uint8Array([2])};
  let configurationRead = false;
  const config = {node: {}, get issuance() {configurationRead = true; throw new Error("unexpected configuration read");}};
  await assert.rejects(setupLinuxCodexLiveAdmin(undefined as never, {} as never, config as never, material), error => {
    assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
    assert.equal(error.directory, undefined);
    return true;
  });
  assert.equal(configurationRead, false);
  assert.deepEqual([...material.token, ...material.accountId], [0, 0]);
});

// Synthetic failures only: no database, filesystem owner or provider is started.
import {createLinuxCodexLiveLaunchRecords, LinuxCodexLiveSetupError, setupLinuxCodexLiveBootstrap} from "./linux-codex-live-bootstrap.ts";
test("bootstrap schema failure retains cleanup and excludes the original error", {skip: process.platform !== "linux"}, async () => {
  const secret = "malicious-password-/private/path";
  const pool = {async query() {throw new Error(secret);}};
  const pins = {sourceRevision: "a".repeat(40), platformTarget: {platform: "linux"},
    deployment: {currentPolicy() {}}};
  await assert.rejects(setupLinuxCodexLiveBootstrap(pool as never, pins as never), asyncError => {
    assert.ok(asyncError instanceof LinuxCodexLiveSetupError);
    assert.equal(asyncError.setupStage, "schema");
    assert.equal(Object.hasOwn(asyncError, "cause"), false);
    assert.ok(!JSON.stringify(asyncError).includes(secret));
    assert.ok(!String(asyncError.stack).includes(secret));
    return true;
  });
});

test("admin preserves every bootstrap stage and its retained cleanup without cause text", async () => {
  for (const stage of ["configuration", "schema", "pa", "rs", "operation-store", "workspace", "artifacts",
    "node-recipe", "host-composition"] as const) {
    let cleanupCalls = 0;
    const original = new LinuxCodexLiveSetupError(async () => {cleanupCalls++; return "pending";}, stage);
    original.message = "malicious-credential-/private/path";
    const approval = {get binding() {throw original;}};
    const material = {token: new Uint8Array([1]), accountId: new Uint8Array([2])};
    try {
      await setupLinuxCodexLiveAdmin(undefined as never, approval as never, undefined as never, material);
      assert.fail("expected setup failure");
    } catch (error) {
      assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
      assert.equal(error.setupStage, stage);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.ok(!JSON.stringify(error).includes(original.message));
      assert.ok(!String(error.stack).includes(original.message));
      assert.equal(cleanupCalls, 0);
      assert.deepEqual([...material.token, ...material.accountId], [1, 2]);
      assert.equal(await error.cleanup(undefined as never), "pending");
      assert.equal(cleanupCalls, 1);
    }
  }
});

// Synthetic caller regression: actual ACL, admin producer, bootstrap resolver and
// current owner; fake custody/process only, with no provider or runtime launch.
import {createContainedTurnProviderAccessPort} from
  "@agent-teams/agent-execution/composition";
import { createHash } from "node:crypto";
import {statSync} from "node:fs";
import {getuid} from "node:process";
import { createCodexCurrentKernelOwner } from "@agent-teams/agent-execution/composition";
const { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js"));
const { access, executeInput, FakeHost, ids, openInput, syntheticCodexEffectCustody, workspaceOwner } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/features/contained-agent-turn/support/current-provider-owner-fixture.ts"));
const { boundary: codexFixtureBoundary, FakeCodexProcess, standardHandshake, syntheticPrivateRoot: codexFixturePrivateRoot, syntheticTmp: codexFixtureTmp } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/codex-app-server-contained-turn-provider-fixture.ts"));
const { emitAgentCompleted, emitAgentStarted, emitTurnStarted, generatedTurn } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/codex-app-server-test-messages.mjs"));

test("admin inventory and real bootstrap resolver carry accepted ACL identity into the owner plan and redact output", async () => {
  const workspaceRef = codexFixtureBoundary.workspaceRef;
  const privateRootPath = codexFixturePrivateRoot;
  const codexHome = codexFixtureBoundary.codexHome;
  // The disposable fixture is owned by this user on both Linux and macOS;
  // a root-owned synthetic stat would bypass the regression on root Linux CI.
  assert.equal(statSync(codexHome).uid, getuid!());
  assert.equal(statSync(codexHome).mode & 0o777, 0o700);
  const tmpDir = codexFixtureTmp;
  const oauthToken = "test-fixture-literal";
  const tokenDigest = createHash("sha256").update(oauthToken).digest("hex");
  const reviewToken = "ARBITRARY_REVIEW_TOKEN_93e77fe_exact_inventory";
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({id: message.id, result: {turn: generatedTurn("turn:sensitive", "inProgress")}});
      emitTurnStarted(target, "turn:sensitive");
      emitAgentStarted(target, "turn:sensitive", "item:sensitive");
      target.emit({method: "item/agentMessage/delta", params: {
        delta: `unlabeled ${oauthToken} ${tokenDigest} ${reviewToken}`, itemId: "item:sensitive",
        threadId: "thread:test", turnId: "turn:sensitive",
      }});
      emitAgentCompleted(target, "turn:sensitive", "item:sensitive", `unlabeled ${oauthToken} ${tokenDigest} ${reviewToken}`);
      target.emit({method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:sensitive", "completed"),
      }});
    }
  });
  class CredentialHost extends FakeHost {
    override async reserve(input: any) {
      this.reserves += 1;
      this.refs.set(input.attemptId, process.custodyRef);
      this.plans.push(input.launchPlan);
      return Object.freeze({custodyRef: process.custodyRef});
    }
    override get(custodyRef: string) {return custodyRef === process.custodyRef ? process : null;}
  }
  const host = new CredentialHost();
  const identity = ids("codex", "sensitive-output");
  const mutableTokens = [oauthToken, tokenDigest, reviewToken];
  const {ownerAuthorityDigest: _owner, ...baseBinding} = access("codex");
  const binding = Object.freeze({...baseBinding, credentialBindingDigest: "owner:raw:synthetic"});
  const port = createContainedTurnProviderAccessPort(Object.freeze({
    dispatchConsumptionV1: Object.freeze({consumeForDispatch: unused,
      observeDispatchConsumption: unused, settleDispatchConsumption: unused}),
    resolve: Object.freeze({async execute() {return Object.freeze({kind: "resolved" as const, binding,
      evidence: Object.freeze({authorityDigest: "authority:synthetic", bindingAuthorityDigest: binding.credentialBindingDigest,
        proofRef: "proof:synthetic", purpose: "acceptance" as const})});}}),
    revalidate: Object.freeze({async execute() {throw new Error("unused");}}),
  }));
  const accepted = await port.resolveForAcceptance({operationId: identity.operationId,
    intent: {mode: "analysis", prompt: "Synthetic inspection"}, provider: "codex",
    scope: {tenantId: binding.tenantId, projectId: binding.projectId}});
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") {throw new Error("Expected accepted snapshot");}
  const mutableInventory = createLinuxCodexLiveCredentialInventory(binding, mutableTokens);
  assert.equal(mutableInventory.credentialBindingDigest, accepted.snapshot.credentialBindingDigest);
  assert.equal(accepted.snapshot.ownerAuthorityDigest, binding.credentialBindingDigest);
  assert.notEqual(mutableInventory.credentialBindingDigest, binding.credentialBindingDigest);
  let pathCalls = 0;
  const launchRecords = createLinuxCodexLiveLaunchRecords({
    credentials: {inventory: mutableInventory, takeOwnedMaterial() {throw new Error("unused");}},
    async launchPaths() {pathCalls++; return {codexHome, executablePath: "/synthetic/codex", privateRootPath, tmpDir};},
  }, () => false);
  // These are rejected before any path read, including an equal-generation raw digest.
  for (const expected of [binding, {...accepted.snapshot, credentialGeneration: 2}]) {
    assert.equal(await launchRecords.resolve(expected as never), undefined);
  }
  assert.equal(pathCalls, 0);
  const owner = createCodexCurrentKernelOwner({
    effectCustody: syntheticCodexEffectCustody(), hostBootId: "host-boot:sensitive-output",
    hostCustody: host as any, hostInstanceId: "host-instance:sensitive-output",
    launchRecords,
    platformTarget: {architecture: "x64", platform: "linux"},
    workspaceOwner: workspaceOwner(identity, workspaceRef),
  });
  await owner.custody.open({...openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT),
    providerAccessSnapshot: accepted.snapshot});
  assert.equal(pathCalls, 1);
  assert.equal(host.plans.length, 1);
  assert.equal(JSON.stringify(host.plans).includes(oauthToken), false);
  mutableTokens.splice(0, mutableTokens.length, "later-substituted-token");
  const output: unknown[] = [];
  const outcome = await owner.provider.execute({...executeInput(
    identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
  ), providerAccessSnapshot: accepted.snapshot, emit: async chunk => {output.push(chunk);}});
  const publicEvidence = JSON.stringify({outcome, output});
  assert.equal(outcome.kind, "indeterminate");
  assert.deepEqual(output, []);
  assert.equal(publicEvidence.includes(oauthToken), false);
  assert.equal(publicEvidence.includes(tokenDigest), false);
  assert.equal(publicEvidence.includes(reviewToken), false);
  assert.equal(JSON.stringify(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT))
    .includes(oauthToken), false);
  owner.dispose();
});
