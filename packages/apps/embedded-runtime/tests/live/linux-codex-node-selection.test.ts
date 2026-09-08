import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {test} from "node:test";
import {join} from "node:path";
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
    runtimeSecurityExpectation: {acceptedAuthorityDigest: `sha256:${"e".repeat(64)}`}};
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
    readAcknowledged: () => ({subject, acceptedAuthorityVectorDigest: authority, securityDecisionDigest: `sha256:${"e".repeat(64)}`}), readDirectories: () => directories,
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

test("RS decision digest is independent of the whole authority vector and must match its own readback", () => {
  const f = fixture();
  assert.notEqual(f.subject.runtimeSecurityExpectation.acceptedAuthorityDigest, f.input.kernel.authorityVectorDigest);
  assert.doesNotThrow(() => createLinuxCodexNodeSelection(f.pins)(f.input));
  const wrong = fixture();
  const acknowledged = wrong.pins.readAcknowledged(wrong.input)!;
  assert.throws(() => createLinuxCodexNodeSelection({...wrong.pins,
    readAcknowledged: () => ({...acknowledged, securityDecisionDigest: wrong.input.kernel.authorityVectorDigest}),
  })(wrong.input), /binding mismatch/u);
});

test("selected resource handles pass the real V4 network recipe without normalization", async () => {
  const {dockerHttpOperationNetworkRecipe} = await import(
    "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js");
  const {subject} = await import("../../../../contexts/agent-execution/tests/fixtures/host-http-egress-v4-fixture.ts");
  const handles = new Set<string>();
  for (let index = 0; index < 2; index++) {
    const f = fixture(); const selected = createLinuxCodexNodeSelection(f.pins)(f.input);
    const actual = {...subject, ...selected.subjectFacts, imageDigest: selected.create.imageDigest,
      attempt: {...subject.attempt, launchFingerprintSha256: selected.create.launchFingerprintSha256,
        operationNonceSha256: selected.create.operationNonceSha256}};
    const recipe = dockerHttpOperationNetworkRecipe(actual);
    assert.equal(recipe.binding.networkHandleSha256, actual.networkHandle.slice(8));
    for (const kind of ["network", "listener", "route"] as const) {
      const key = `${kind}Handle` as const;
      assert.match(actual[key], new RegExp(`^${kind}:[a-f0-9]{64}$`, "u"));
      handles.add(actual[key].split(":")[1]!);
      assert.throws(() => dockerHttpOperationNetworkRecipe({...actual, [key]: randomUUID()}));
    }
  }
  assert.equal(handles.size, 6);
});

// Actual canary configuration plus synthetic acknowledged/readback facts only.
// Never call setup or any engine/lifecycle method.
const canarySelection = async () => {
  const {createLinuxCodexLiveCanaryConfiguration} = await import("./linux-codex-live-canary-config.ts");
  const {containedTurnScopeDigest} = await import(
    "../../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-authority.js");
  const {digestContainedTurnCanonicalValue} = await import(
    "../../../../contexts/agent-execution/dist/features/contained-agent-turn/domain/contained-turn-codecs.js");
  const {policy} = await import("../../../../contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts");
  const {SYNTHETIC_LOOPBACK_CA} = await import(
    "../../../../contexts/agent-execution/tests/fixtures/http-egress-tls/synthetic-loopback-certificates.ts");
  const parent = "/disposable";
  const enginePolicy = policy(parent);
  const approved = {
    approvedIntent: "write-one-marker-and-return-it/v1", testId: "engine-env",
    commandId: "command:engine-env", deploymentId: "deployment:synthetic",
    deploymentIncarnation: "incarnation:synthetic", markerFile: "marker.txt", marker: "synthetic",
    externalAuthorityDigest: digestContainedTurnCanonicalValue({authority: "synthetic"}),
    binding: {accessRef: "access:synthetic", availability: "available", bindingRevision: 1,
      credentialBindingDigest: digestContainedTurnCanonicalValue({credentialBinding: "synthetic"}),
      credentialBindingRef: "credential:synthetic",
      credentialGeneration: 1, projectId: "project:synthetic", provider: "codex",
      providerAccountRef: "account:synthetic", providerRouteRef: "route:synthetic", revocation: "active",
      scopeDigest: containedTurnScopeDigest({tenantId: "tenant:synthetic", projectId: "project:synthetic"}),
      tenantId: "tenant:synthetic"},
  } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[0];
  const pins = {
    sourceRevision: "f1b7a77f9267d188521cd202a628beae3413f9bc",
    hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
    testParent: parent, enginePolicy,
    tools: {nsenter: {path: join(parent, "nsenter"), sha256: "a".repeat(64)},
      nft: {path: join(parent, "nft"), sha256: "b".repeat(64)}},
    imageInitLock: {
      imageReference: "sha256:8db55f3551afd7c1032bb8dba936caefd4d5c8f2fb4b5f21af19da1fb7345979",
      imageConfigId: "sha256:8db55f3551afd7c1032bb8dba936caefd4d5c8f2fb4b5f21af19da1fb7345979", os: "linux", architecture: "amd64", variant: "",
      loadingPolicy: "closed-bundle-node-builtins-only-v1",
      interpreter: {path: "/ar-custody-node", mode: 0o555, size: 100,
        sha256: "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c"},
      bootstrap: {path: "/ar-custody-init.mjs", mode: 0o444, size: 85430,
        sha256: "e54bf7263a01b3ccc48a0b401a48eb14be60ce27520edd2bd865d04e3f04674c"},
    },
    native: {catalogSource: Buffer.from("{}"), ownerUid: 1000, ownerGid: 1000},
    observerSha256: "c".repeat(64), certificateAuthorities: [SYNTHETIC_LOOPBACK_CA],
  } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[1];

  const {configuration} = createLinuxCodexLiveCanaryConfiguration(approved, pins);
  const f = fixture();
  const binding = {...approved.binding, hostBootId: pins.hostBootId, hostInstanceId: pins.hostInstanceId};
  Object.assign(f.subject, binding, {scope: binding});
  Object.assign(f.input.kernel.providerAccessSnapshot, binding);
  const selected = createLinuxCodexNodeSelection({...f.pins, ...configuration.node, binding,
    enginePolicy: {...configuration.node.enginePolicy,
      privateRootSourceRoot: f.pins.enginePolicy.privateRootSourceRoot,
      workspaceSourceRoot: f.pins.enginePolicy.workspaceSourceRoot},
  })(f.input);
  return {selected, configuration, input: f.input};
};

test("actual canary selection satisfies network cleanup constructor while outer cleanup remains 30000",
  {skip: process.platform !== "linux" || process.arch !== "x64"}, async () => {
    const {DockerHttpNetworkResources, dockerHttpOperationNetworkRecipe} = await import(
      "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js");
    const {subject} = await import("../../../../contexts/agent-execution/tests/fixtures/host-http-egress-v4-fixture.ts");
    const {selected, configuration} = await canarySelection();
    const actual = {...subject, ...selected.subjectFacts, imageDigest: selected.create.imageDigest,
      attempt: {...subject.attempt, launchFingerprintSha256: selected.create.launchFingerprintSha256,
        operationNonceSha256: selected.create.operationNonceSha256}};
    let calls = 0;
    const noIO = () => {calls += 1; throw new Error("Unexpected engine I/O");};
    const engine = {policy: {...selected.node.enginePolicy,
      hostIdentitySha256: actual.attempt.hostIdentitySha256,
      allowedNetworkName: dockerHttpOperationNetworkRecipe(actual).name},
      client: {buffered: noIO, endpointIdentity: noIO, stream: noIO, hijack: noIO}};
    assert.equal(configuration.node.deadlines.cleanupMs, 30_000);
    assert.equal(selected.deadlines.cleanupMs, 30_000);
    assert.equal(selected.connection.limits.closureDeadline - selected.connection.limits.deadline, 30_000);
    assert.ok(new DockerHttpNetworkResources({subject: actual, engine,
      cleanupMilliseconds: selected.cleanupMilliseconds}) instanceof DockerHttpNetworkResources);
    assert.equal(selected.cleanupMilliseconds, 5_000);
    for (const cleanupMilliseconds of [5_001, selected.deadlines.cleanupMs]) {
      assert.throws(() => new DockerHttpNetworkResources({subject: actual, engine, cleanupMilliseconds}));
    }
    assert.equal(calls, 0);
  });

test("actual canary create encoder supplies reserved defaults and preserves provider environment",
  {skip: process.platform !== "linux" || process.arch !== "x64"}, async () => {
    const {encodeCreateRequest} = await import(
      "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-create-request.js");
    const {dockerHttpOperationNetworkRecipe} = await import(
      "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js");
    const {subject} = await import("../../../../contexts/agent-execution/tests/fixtures/host-http-egress-v4-fixture.ts");
    const {selected, configuration, input} = await canarySelection();
    const actual = {...subject, ...selected.subjectFacts, imageDigest: selected.create.imageDigest,
      attempt: {...subject.attempt, launchFingerprintSha256: selected.create.launchFingerprintSha256,
        operationNonceSha256: selected.create.operationNonceSha256}};
    const enginePolicy = {...selected.node.enginePolicy,
      allowedNetworkName: dockerHttpOperationNetworkRecipe(actual).name};
    const create = {...selected.create, ownerIdentitySha256: "f".repeat(64),
      privateRootSource: input.record.privateRootPath, workspaceSource: input.record.boundary.workspaceRef};
    const request = encodeCreateRequest(create, enginePolicy);
    assert.deepEqual(Object.keys(create.environment), ["AR_CUSTODY_INIT_CONFIGURATION"]);
    const encoded = create.environment.AR_CUSTODY_INIT_CONFIGURATION!;
    assert.deepEqual(JSON.parse(encoded).allowedEnvironmentNames, configuration.node.provider.allowedEnvironmentNames);
    for (const key of ["HOME", "PATH", "TMPDIR"]) {
      assert.ok(JSON.parse(encoded).allowedEnvironmentNames.includes(key));
      assert.throws(() => encodeCreateRequest({...create, environment: {...create.environment, [key]: "/reserved"}},
        enginePolicy), error => Reflect.get(error as object, "code") === "invalid-create-request");
    }
    assert.deepEqual(request.Env, ["HOME=/agent-private/home", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp",
      `AR_CUSTODY_INIT_CONFIGURATION=${encoded}`]);
  });
