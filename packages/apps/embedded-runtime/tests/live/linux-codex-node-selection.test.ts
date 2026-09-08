import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {test} from "node:test";
import {createLinuxCodexNodeSelection, type LinuxCodexNodeSelectionPins} from "./linux-codex-node-selection.ts";

type Input = Parameters<ReturnType<typeof createLinuxCodexNodeSelection>>[0];
// Synthetic negative/contract tests only: no directories, credentials or owners opened.
const sha = () => createHash("sha256").update(randomUUID()).digest("hex");
const dir = (path: string, inode: number) => ({path, device: "1", inode: String(inode)});
const fixture = () => {
  const authority = `sha256:${sha()}`;
  const binding = {tenantId: randomUUID(), projectId: randomUUID(), scopeDigest: `sha256:${sha()}`,
    hostBootId: randomUUID(), hostInstanceId: randomUUID()};
  const kernel = {operationId: randomUUID(), attemptId: randomUUID(), custodyId: randomUUID(), effectId: randomUUID(),
    workspaceId: randomUUID(), preparationToken: randomUUID(), operationCutoffRevision: 1,
    authorityVectorDigest: authority, intentMode: "workspace-write",
    providerAccessSnapshot: {...binding, provider: "codex"}};
  const input = {kernel, record: {privateRootPath: "/disposable/private/attempt",
    boundary: {workspaceRef: "/disposable/workspace/attempt"}}} as unknown as Input;
  const subject = {...kernel, ...binding, scope: binding, provider: "codex", purpose: "contained_turn_provider_start_v1",
    executionGenerationId: randomUUID(), providerAccessExpectation: {acceptedAuthorityDigest: authority},
    runtimeSecurityExpectation: {acceptedAuthorityDigest: authority}};
  const directories = {custody: dir("/disposable/journals/custody", 1), resource: dir("/disposable/journals/resource", 2),
    consumption: dir("/disposable/journals/consumption", 3), privateRoot: dir(input.record.privateRootPath, 4),
    workspace: dir(input.record.boundary.workspaceRef, 5)};
  let control = 100; let wall = 100000; let mono = 10;
  const admission = new AbortController(); const observation = new AbortController();
  const pins = {binding, enginePolicy: {privateRootSourceRoot: "/disposable/private", workspaceSourceRoot: "/disposable/workspace",
    seccompProfileSha256: sha()}, tools: {nsenter: {path: "/pinned/nsenter", sha256: sha()}, nft: {path: "/pinned/nft", sha256: sha()}},
    imageInitLock: {os: "linux", imageReference: `sha256:${sha()}`, imageConfigId: `sha256:${sha()}`,
      loadingPolicy: "closed-bundle-node-builtins-only-v1", interpreter: {path: "/ar-custody-node", sha256: sha()},
      bootstrap: {path: "/ar-custody-init.mjs", sha256: sha()}},
    provider: {executablePath: "/usr/local/bin/provider-entrypoint", executableSha256: sha(), allowedEnvironmentNames: ["HOME"],
      maximumStdinBytes: 1024, maximumStdoutBytes: 1024, maximumStderrBytes: 1024,
      maximumProviderRuntimeMs: 1000, shutdownGraceMs: 100}, native: {catalogSource: Buffer.from("{}"), ownerUid: 1000, ownerGid: 1000},
    workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:synthetic:workspace-ownership"},
    observerSha256: sha(), expectedClock: {authorityId: "synthetic", epoch: "test"},
    clock: {read: () => ({authorityId: "synthetic", epoch: "test", controlTime: control}), within: async () => {throw Error("unused");}},
    monotonicNow: () => mono, wallNow: () => wall,
    lifetime: {signal: admission.signal, observationSignal: observation.signal, operationDeadline: 1100,
      closureDeadline: 1200, wallDeadlineEpochMs: 101000, observationWallDeadlineEpochMs: 101100, maximumLifetimeMs: 1000},
    deadlines: {engineIdentityMs: 100, allocationMs: 100, launchMs: 100, membershipMs: 100, cleanupMs: 100, routeMs: 100},
    initTimeouts: {readyTimeoutMs: 100, acknowledgementTimeoutMs: 100}, connection: {limits: {maxInboundHeaderBytes: 1024}},
    readAcknowledged: () => ({subject, acceptedAuthorityVectorDigest: authority}), readDirectories: () => directories,
  } as unknown as LinuxCodexNodeSelectionPins;
  return {pins, input, subject, directories, admission, observation,
    advance: () => {control += 1000; wall += 1000; mono += 1000;}, rewind: () => {mono -= 1;}};
};

test("constructs joined init/create values and distinct clock deadlines without observations", () => {
  const f = fixture(); const select = createLinuxCodexNodeSelection(f.pins); const s = select(f.input);
  const a = s.initOptions.authority;
  assert.equal(s.create.operationNonceSha256, createHash("sha256").update(a.operationNonce).digest("hex"));
  assert.equal(s.create.launchFingerprintSha256, a.launchFingerprintSha256);
  assert.deepEqual(JSON.parse(s.create.environment.AR_CUSTODY_INIT_CONFIGURATION!).observedIdentity, a.expectedIdentity);
  assert.equal(s.deadlines.routeLifetimeMs, 1000); assert.equal(s.connection.limits.deadline, 1100);
  assert.equal(s.initOptions.isCurrentGeneration(a.generation), true);
  assert.equal(s.initOptions.isCurrentGeneration(randomUUID()), false);
  assert.equal("readEnvelope" in s.consumption, false);
  assert.throws(() => select(f.input), /already selected/u);
  f.advance(); assert.equal(s.initOptions.isCurrentGeneration(a.generation), false);
});

test("rejects absent readbacks, independent binding conflicts and overlapping journals", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => ({...f.pins, readAcknowledged: (): undefined => {}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, binding: {...f.pins.binding, hostBootId: randomUUID()}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, binding: {...f.pins.binding, scopeDigest: `sha256:${"f".repeat(64)}`}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, binding: {...f.pins.binding, tenantId: randomUUID()}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, binding: {...f.pins.binding, projectId: randomUUID()}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, binding: {...f.pins.binding, hostInstanceId: randomUUID()}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, lifetime: {...f.pins.lifetime, operationDeadline: 99}}),
    (f: ReturnType<typeof fixture>) => ({...f.pins, readDirectories: (): undefined => {}}),
    (f: ReturnType<typeof fixture>) => {f.directories.resource = f.directories.custody; return f.pins;},
  ]) {const f = fixture(); assert.throws(() => createLinuxCodexNodeSelection(change(f))(f.input), /selection:/u);}
});

test("generation admission closes on cancellation, clock rollback and observation expiry", () => {
  for (const action of ["cancel", "rewind", "observation"] as const) {
    const f = fixture(); const s = createLinuxCodexNodeSelection(f.pins)(f.input);
    if (action === "cancel") {f.admission.abort(); assert.equal(s.initOptions.isObservationActive!(), true);}
    if (action === "rewind") {f.rewind();}
    if (action === "observation") {f.observation.abort();}
    assert.equal(s.initOptions.isCurrentGeneration(s.initOptions.authority.generation), false);
  }
});
