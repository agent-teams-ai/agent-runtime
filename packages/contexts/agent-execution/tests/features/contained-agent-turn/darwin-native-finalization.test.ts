import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  fixture, issuer, recipes, filesIssuer, tuple, linuxTuple, boundaries, captures, retainedBytes,
  launch, validation, material, darwin, host, sessionDependencies, observedPaths, materialPreimages,
  mutate, file, directory, holdRead, providerOptions, legacyCapture, guarded, lastSpawnRequest,
} from "./darwin-native-finalization-fixture.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const finalized = async (mode: "analysis" | "workspace-write" = "analysis") => {
  const f = fixture(mode); const reservation = await f.reserve(); const finalizer = reservation.bind();
  const files = await f.install(); const stage = await finalizer.stage({recipe: f.recipe, files});
  const dependencies = sessionDependencies(reservation); const session = finalizer.bindSession(dependencies);
  const final = finalizer.commit(stage);
  return {...f, ...reservation, finalizer, files, stage, dependencies, session, final};
};

test("Darwin native factory uses the exact 0.153.4 captures for both admitted intents", async () => {
  for (const mode of ["analysis", "workspace-write"] as const) {
    const f = fixture(mode); const files = await f.install();
    const raw = captures.capture(mode);
    assert.equal(raw.binarySha256, tuple.binarySha256);
    assert.equal(raw.platform, "darwin-arm64");
    assert.equal(raw.providerTurnRequested, false);
    const provenance = JSON.parse(retainedBytes("provenance.json").toString());
    assert.equal(hash(retainedBytes(`capture.darwin-${mode}.json`)), provenance.files[`capture.darwin-${mode}.json`]);
    const plan = issuer.createCodexAppServerLaunchPlan({...f.options,
      nativeBroker: {recipe: f.recipe, files, localCapability: "a".repeat(64)}});
    assert.equal(plan.binaryRevision, "@openai/codex:0.153.4+darwin-arm64");
    assert.equal(plan.executableSha256, raw.binarySha256);
    assert.equal(plan.containmentProfile, tuple.containmentProfile);
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(plan), true);
    assert.equal(issuer.codexNativeBrokerLaunchInput(plan).files, files);
    assert.deepEqual(plan.arguments, ["app-server", "--stdio", "--strict-config", "-c",
      'default_permissions="agent-runtime-contained-v1"',
      ...recipes.CODEX_NATIVE_BROKER_DISABLED_FEATURES.flatMap(feature => ["--disable", feature])]);
    issuer.validateCodexAppServerLaunchPlanRoots(plan);
    boundaries.validateCodexConfigEvidence(captures.nativeBrokerConfig(f.boundary.codexHome, mode), f.boundary, f.recipe);
    if (mode === "analysis") {
      assert.equal(recipes.renderCodexNativeBrokerConfig(f.recipe), retainedBytes("input-config.analysis.toml").toString()
        .replaceAll(`${raw.project}/private-home`, f.boundary.codexHome));
    }
    for (const platformTarget of [{platform: "darwin", architecture: "x64"}, {platform: "linux", architecture: "arm64"}]) {
      assert.throws(() => issuer.createCodexAppServerLaunchPlan({...f.options, platformTarget} as never));
    }
  }
});

test("same reservation publishes one issued Darwin final plan with actual canonical execution material", async t => {
  const f = fixture(); const r = await f.reserve(); t.after(r.close);
  const original = r.live.launchBinding.reservation!;
  assert.equal(original.plan, f.plan); assert.equal(r.live.privateReservationPlan, f.plan);
  const originalFingerprint = original.fingerprint;
  assert.throws(() => r.live.launchBinding.firstStart(r.live));
  const finalizer = r.bind(); const files = await f.install();
  const stage = await finalizer.stage({recipe: f.recipe, files});
  assert.equal(r.live.plan, f.plan); assert.throws(() => r.live.launchBinding.view.readFinal());
  finalizer.bindSession(sessionDependencies(r)); const final = finalizer.commit(stage);
  assert.equal(r.live.launchBinding.view.readFinal(), final);
  assert.equal(r.live.launchBinding.reservation, original);
  assert.equal(original.fingerprint, originalFingerprint);
  assert.equal(r.live.privateReservationPlan, original.plan);
  assert.notEqual(final.plan, original.plan);
  assert.notEqual(final.fingerprint.fingerprintSha256, originalFingerprint.fingerprintSha256);
  assert.equal(r.live.plan, final.plan); assert.equal(r.live.workspace, final.workspace);
  assert.equal(r.live.privatePaths, final.privatePaths); assert.equal(r.live.fingerprint, final.fingerprint);
  assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(final.plan), true);
  const native = issuer.codexNativeBrokerLaunchInput(final.plan);
  assert.equal(native.recipe, f.recipe); assert.equal(native.files, files);
  assert.match(native.localCapability, /^[a-f0-9]{64}$/u);
  const preimage = materialPreimages.at(-1)!;
  assert.equal(hash(preimage), final.materialSha256);
  assert.doesNotMatch(preimage, /\/proc\/self\/fd|\/dev\/fd/u);
  assert.equal(preimage.includes(native.localCapability), false);
  const projection = JSON.parse(preimage)[1];
  assert.equal(projection.execution, "canonical-paths");
  assert.equal(projection.profile, tuple.containmentProfile);
  assert.deepEqual(projection.limitations, host.DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS);
  assert.equal(projection.executable[0], f.options.executablePath);
  assert.equal(projection.executable[3], tuple.binarySha256);
  assert.equal(projection.workspace[0], f.input.workspaceRef);
  assert.equal(projection.privateRoot[0], f.options.privateRootPath);
  assert.deepEqual(projection.environment.map(([key, value]: [string, string[]]) => [key, value[0]]),
    ["CODEX_HOME", "HOME", "TMPDIR"].map(key => [key, final.plan.environment[key]]));
  assert.equal(observedPaths.some(path => path.startsWith("/proc/")), false);
});

test("Darwin first-start validation and retained descriptors keep canonical names and cooperative limitations", async t => {
  const f = await finalized("workspace-write"); t.after(f.close);
  f.live.launchBinding.assertStart(f.final);
  for (const bundle of [undefined, {...f.final}, Object.freeze({...f.final})]) {
    assert.throws(() => f.live.launchBinding.assertStart(bundle));
  }
  const input = {arguments: f.final.plan.arguments, command: f.options.executablePath,
    cwd: f.input.workspaceRef, environment: f.final.plan.environment};
  launch.assertDelegatedStartFingerprint(input, f.final.plan, f.input.workspaceRef);
  assert.throws(() => launch.assertDelegatedStartFingerprint({...input, cwd: "/proc/self/fd/4"}, f.final.plan, f.input.workspaceRef));
  f.live.launchBinding.firstStart(f.live);
  const authority = darwin.acquireDarwinLaunchAuthority(f.final.plan, f.final.executable, f.input.workspaceRef, {
    observation: f.final.workspace, retainedDescriptorPath: f.live.retainedWorkspaceAuthority!.descriptorPath,
  }, f.final.privatePaths);
  f.live.launchAuthority = authority;
  f.live.retainedWorkspaceAuthority!.assertLaunchDescriptor(authority.workspaceDescriptor.parentDescriptor);
  assert.equal(f.live.launchBinding.executionPermitted(f.live), true);
  assert.throws(() => f.live.launchBinding.firstStart(f.live));
  assert.equal(f.final.plan.environment.CODEX_HOME, f.boundary.codexHome);
  assert.equal(f.live.closureEvidence.status, "unproven");
  assert.deepEqual(f.live.closureEvidence.limitations, host.DARWIN_COOPERATIVE_CUSTODY_LIMITATIONS);
  // Darwin creates no Linux executable seal. Its root timestamp may not drift.
  mutate(f.options.privateRootPath, {revision: 2});
  assert.equal(f.live.launchBinding.executionPermitted(f.live), false);
});

test("copied native plans, recipes, files and altered platform selections never recover issuance", async t => {
  const f = await finalized(); t.after(f.close);
  let traps = 0; const trap = () => {traps += 1; throw new Error("must not run");};
  for (const plan of [{...f.final.plan}, Object.freeze({...f.final.plan}), new Proxy(f.final.plan, {get: trap, ownKeys: trap})]) {
    assert.equal(issuer.isIssuedCodexAppServerLaunchPlan(plan), false);
    assert.throws(() => issuer.codexNativeBrokerLaunchInput(plan));
    assert.throws(() => issuer.validateCodexAppServerLaunchPlanRoots(plan));
  }
  for (const bad of [{...f.recipe}, {...f.recipe, profile: "codex-api"}, new Proxy(f.recipe, {get: trap})]) {
    assert.throws(() => issuer.createCodexAppServerLaunchPlan({...f.options,
      nativeBroker: {recipe: bad, files: f.files, localCapability: "b".repeat(64)}} as never));
  }
  assert.throws(() => filesIssuer.validateCodexNativeBrokerFiles({...f.files}, f.recipe));
  const copied = await f.reserve({...f.plan}); t.after(copied.close);
  assert.throws(() => copied.bind());
  assert.equal(traps, 0);
});

test("actual guarded native Darwin launch reaches only mocked Node spawn with cooperative descriptor observations", async t => {
  const f = await finalized(); t.after(f.close);
  f.live.launchBinding.firstStart(f.live);
  const before = lastSpawnRequest();
  assert.throws(() => guarded.launchGuardedProvider({live: f.live,
    arguments: f.final.plan.arguments, environment: f.final.plan.environment,
    workspaceDescriptorPath: f.live.retainedWorkspaceAuthority!.descriptorPath,
    maxDiagnosticBytes: 256, maxStderrBytes: 1024, maxStdinBytes: 1024, maxStdoutBytes: 1024,
    stdoutHighWaterBytes: 256, monotonicNow: () => 0, writeAfterMs: 100, spawnAcknowledgementAfterMs: 100,
    onAbort() {assert.fail("no process started");}, onOverflow() {assert.fail("no streams opened");},
  }), {name: "Error"});
  const observed = lastSpawnRequest()!;
  assert.notEqual(observed, before);
  assert.equal(observed.command, process.execPath);
  assert.deepEqual(observed.options.env, {LANG: "C.UTF-8"});
  assert.deepEqual(observed.options.stdio.slice(0, 4), ["pipe", "pipe", "pipe", "ipc"]);
  assert.equal(observedPaths.some(path => path.startsWith("/proc/")), false);
  assert.equal(f.live.spawnStatus, "never-started");
});

test("Host finalization rejects changed executable path, binary tuple and containment profile", async t => {
  const f = await finalized(); t.after(f.close);
  for (const change of [{executablePath: `${f.options.executablePath}-copy`}, {executableSha256: "0".repeat(64)},
    {binaryRevision: linuxTuple.binaryRevision}, {containmentProfile: linuxTuple.containmentProfile}]) {
    await assert.rejects(validation.validateFinalHostLaunch(f.live, {...f.final.plan, ...change}, "d".repeat(64)));
  }
  // Identity changes are rejected even where the pathname spelling survives.
  mutate(f.options.executablePath, {ino: 999_001});
  assert.throws(() => f.live.launchBinding.firstStart(f.live));
});

test("provider validation retains the issued Darwin plan, matching binary manifest and captured config", async t => {
  const f = await finalized(); t.after(f.close);
  const options = {boundary: f.boundary, nativeBrokerLaunchPlan: f.final.plan,
    manifest: {effectClass: "contained_unmediated_effect" as const, providerBinding: f.input.providerBinding,
      supportedModes: ["analysis", "workspace-write"] as const},
    privateRootPath: f.options.privateRootPath, tmpDir: f.options.tmpDir, processes: {get: () => {}}};
  const selected = providerOptions.detachCodexProviderOptions(options);
  assert.equal(selected.nativeBrokerLaunchPlan, f.final.plan);
  assert.equal(selected.sensitiveOutputTokens!.includes(issuer.codexNativeBrokerLaunchInput(f.final.plan).localCapability), true);
  for (const change of [{nativeBrokerLaunchPlan: {...f.final.plan}}, {tmpDir: `${f.options.tmpDir}-other`},
    {boundary: {...f.boundary}}, {manifest: {...options.manifest,
      providerBinding: {...f.input.providerBinding, binaryRevision: linuxTuple.binaryRevision}}}]) {
    assert.throws(() => providerOptions.detachCodexProviderOptions({...options, ...change}));
  }
  const captured = captures.nativeBrokerConfig(f.boundary.codexHome);
  boundaries.validateCodexConfigEvidence(captured, f.boundary, f.recipe);
  (captured.config.features as Record<string, unknown>).enable_request_compression = true;
  assert.throws(() => boundaries.validateCodexConfigEvidence(captured, f.boundary, f.recipe));
});

test("Darwin executable bytes are verified by the real verifier and changed bytes cannot stage", async t => {
  const f = fixture(); const r = await f.reserve(); t.after(r.close); const finalizer = r.bind();
  const files = await f.install(); mutate(f.options.executablePath, {bytes: Buffer.from("wrong binary bytes")});
  await assert.rejects(launch.verifyExecutable(f.plan), /digest mismatch/u);
  await assert.rejects(finalizer.stage({recipe: f.recipe, files}));
  assert.throws(() => r.live.launchBinding.view.readFinal());
});

test("Darwin material binds path, sampled identities, binary, limitations and provider material independently", async t => {
  const f = await finalized(); t.after(f.close);
  const preimage = materialPreimages.at(-1)!; const providerMaterial = JSON.parse(preimage)[0];
  assert.equal(material.finalHostExecutionMaterialSha256(f.final, f.final.executable, providerMaterial), f.final.materialSha256);
  for (const candidate of [
    {...f.final, canonicalWorkspace: `${f.input.workspaceRef}-other`},
    {...f.final, workspace: {...f.final.workspace, ino: f.final.workspace.ino + 1n}},
    {...f.final, plan: {...f.final.plan, executablePath: `${f.options.executablePath}-other`}},
    {...f.final, privatePaths: {...f.final.privatePaths, root: {...f.final.privatePaths.root, ino: 999n}}},
    {...f.final, privatePaths: {...f.final.privatePaths, byEnvironmentKey: {...f.final.privatePaths.byEnvironmentKey,
      HOME: {...f.final.privatePaths.byEnvironmentKey.HOME!, path: `${f.boundary.codexHome}-other`}}}},
  ]) {
    assert.notEqual(material.finalHostExecutionMaterialSha256(candidate, f.final.executable, providerMaterial), f.final.materialSha256);
    assert.throws(() => f.live.launchBinding.assertStart(candidate));
  }
  assert.notEqual(material.finalHostExecutionMaterialSha256(f.final, {...f.final.executable, digest: "0".repeat(64)}, providerMaterial), f.final.materialSha256);
  assert.notEqual(material.finalHostExecutionMaterialSha256(f.final, f.final.executable, "0".repeat(64)), f.final.materialSha256);
  assert.throws(() => f.live.launchBinding.assertStart({...f.final, materialSha256: "0".repeat(64)}));
  assert.throws(() => material.finalHostExecutionMaterialSha256({...f.final,
    plan: {...f.final.plan, containmentProfile: "unknown" as never}}, f.final.executable, providerMaterial));
});

test("Linux descriptor material retains the exact existing preimage and intentional HOME alias", async t => {
  const f = await finalized(); t.after(f.close); const providerMaterial = "b".repeat(64);
  const candidate = {...f.final, plan: {...f.final.plan, containmentProfile: linuxTuple.containmentProfile}};
  const expected = [providerMaterial, "/proc/self/fd/4", "/proc/self/fd/5", "/proc/self/fd/8", [
    ["CODEX_HOME", f.boundary.codexHome, "/proc/self/fd/6"],
    ["HOME", f.boundary.codexHome, "/proc/self/fd/6"], ["TMPDIR", f.options.tmpDir, "/proc/self/fd/7"],
  ]];
  assert.equal(material.finalHostExecutionMaterialSha256(candidate, f.final.executable, providerMaterial), hash(JSON.stringify(expected)));
});

test("staging remains pending across executable IO and cutoff rejects late completion", async t => {
  const f = fixture(); const r = await f.reserve(); t.after(r.close); const finalizer = r.bind();
  const files = await f.install(); const held = holdRead(f.options.executablePath); t.after(held.release);
  const staging = finalizer.stage({recipe: f.recipe, files});
  const rejected = assert.rejects(staging);
  assert.ok(r.live.launchBinding.pending);
  let settled = false; void r.live.launchBinding.pending.then(() => {settled = true; return;});
  await held.entered; assert.equal(settled, false);
  r.controller.abort(); assert.equal(settled, false);
  assert.throws(() => r.live.httpReservation.assertActive());
  held.release(); await rejected; await r.live.launchBinding.pending;
  assert.equal(settled, true); assert.throws(() => r.live.launchBinding.view.readFinal());
});

test("finalizer receiver, exact staged material and actual session identity remain mandatory", async t => {
  for (const attack of ["receiver", "staged-copy", "missing-session", "session-copy", "pa-generation", "rs-owner"] as const) {
    const f = fixture(); const r = await f.reserve(); t.after(r.close); const finalizer = r.bind(); const files = await f.install();
    if (attack === "receiver") {
      await assert.rejects(finalizer.stage.call({...finalizer}, {recipe: f.recipe, files}));
      assert.equal(r.live.launchBinding.pending, undefined); continue;
    }
    const stage = await finalizer.stage({recipe: f.recipe, files});
    const dependencies = sessionDependencies(r);
    if (attack === "missing-session") {assert.throws(() => finalizer.commit(stage));}
    if (attack === "staged-copy") {finalizer.bindSession(dependencies); assert.throws(() => finalizer.commit({...stage}));}
    if (attack === "session-copy") {
      assert.throws(() => finalizer.bindSession({...dependencies, identity: {...dependencies.identity,
        liveProcessSessionIdentity: {...r.lifetime.executionSessionIdentity}}}));
    }
    if (attack === "pa-generation") {assert.throws(() => finalizer.bindSession({...dependencies,
      providerAccessSnapshot: {...dependencies.providerAccessSnapshot, credentialGeneration: 2}}));}
    if (attack === "rs-owner") {
      assert.throws(() => finalizer.bindSession({...dependencies, runtimeSecurity: {}} as never));
    }
    assert.throws(() => r.live.launchBinding.view.readFinal());
  }
});

test("changed private files, foreign issued material and path identities close Darwin staging or first start", async t => {
  for (const change of ["config", "catalog", "workspace", "home", "foreign-material"] as const) {
    const f = fixture(); const r = await f.reserve(); t.after(r.close); const finalizer = r.bind(); const files = await f.install();
    if (change === "foreign-material") {
      const other = fixture(); const foreignFiles = await other.install();
      await assert.rejects(finalizer.stage({recipe: other.recipe, files: foreignFiles})); continue;
    }
    const stage = await finalizer.stage({recipe: f.recipe, files});
    finalizer.bindSession(sessionDependencies(r)); const final = finalizer.commit(stage);
    const path = change === "config" ? `${f.boundary.codexHome}/config.toml` : change === "catalog" ? f.recipe.catalogPath
      : change === "workspace" ? f.input.workspaceRef : f.boundary.codexHome;
    mutate(path, {ino: 991_234});
    assert.throws(() => r.live.launchBinding.firstStart(r.live));
    assert.equal(r.live.launchBinding.view.readFinal(), final);
  }
});

test("cutoff before first start and between first-start validation and execution remains closed", async t => {
  for (const phase of ["before-start", "before-exec"] as const) {
    const f = await finalized(); t.after(f.close);
    if (phase === "before-exec") {f.live.launchBinding.firstStart(f.live);}
    f.controller.abort();
    assert.throws(() => f.live.launchBinding.firstStart(f.live));
    assert.equal(f.live.launchBinding.executionPermitted(f.live), false);
  }
});

test("ordinary Darwin Codex and Claude retain canonical cooperative validation without native authority", async t => {
  const f = fixture(); const ordinary = issuer.createCodexAppServerLaunchPlan(f.options);
  assert.equal(Object.hasOwn(ordinary.environment, "AR_PRIVATE_BROKER_CAPABILITY"), false);
  assert.equal(ordinary.arguments.includes("unbounded_connection_retries"), false);
  issuer.validateCodexAppServerLaunchPlanRoots(ordinary);
  boundaries.validateCodexConfigEvidence(legacyCapture.nativeConfigResult(f.boundary.codexHome), f.boundary);
  const r = await f.reserve(ordinary); t.after(r.close);
  assert.throws(() => r.bind());
  assert.throws(() => issuer.codexNativeBrokerLaunchInput(ordinary));
  directory(`${f.options.privateRootPath}/claude-home`);
  const claude = host.createImmutableHostCustodyLaunchPlan({...ordinary, provider: "claude", binaryRevision: "synthetic:claude",
    environment: {CLAUDE_CONFIG_DIR: f.boundary.codexHome, HOME: `${f.options.privateRootPath}/claude-home`,
      TMPDIR: f.options.tmpDir, LANG: "C.UTF-8", PATH: "/usr/bin:/bin"}});
  file(f.options.executablePath, Buffer.from("synthetic claude"), 0o100700);
  const plan = host.createImmutableHostCustodyLaunchPlan({...claude, executableSha256: hash("synthetic claude")});
  const candidate = await launch.validateSelectedLaunchCandidate(plan, {...f.input,
    providerBinding: {...f.input.providerBinding, provider: "claude", binaryRevision: "synthetic:claude"}});
  const executable = await launch.verifyExecutable(plan);
  const authority = darwin.acquireDarwinLaunchAuthority(plan, executable, f.input.workspaceRef, candidate.workspace, candidate.privatePaths);
  t.after(() => authority.close());
  launch.assertDelegatedStartFingerprint({arguments: plan.arguments, command: plan.executablePath,
    cwd: f.input.workspaceRef, environment: plan.environment}, plan, f.input.workspaceRef);
  assert.equal(plan.containmentProfile, "cooperative-darwin-posix-process-group");
  assert.equal(observedPaths.some(path => path.startsWith("/proc/")), false);
});
