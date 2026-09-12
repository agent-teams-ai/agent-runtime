import assert from "node:assert/strict";
import {test} from "node:test";
import {
  Core, nodeFixture, liveFor, spawnCount, spawnObservation, duringSpawn, constructorOptions,
  createCodexCurrentKernelOwner, codexCredentialOutputInventory, syntheticCodexEffectCustody,
  executeInput, snapshot, committedDispatchProofFixture, issuer, file, stats, chunks, holdExecutableVerification,
} from "./native-launch-finalization-fixture.ts";

const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => {setImmediate(resolve);});
const startInput = (plan: any) => ({arguments: plan.arguments, command: plan.executablePath,
  cwd: "/proc/self/fd/4", environment: plan.environment, signal: signal()});
const commit = async () => {
  const f = await nodeFixture(); const stage = await f.stage();
  const http = f.bindSession(stage.finalizer, stage.lifetime);
  return {...f, ...stage, ...http, final: stage.finalizer.commit(stage.stage)};
};

test("actual current Codex owner uses acknowledged kernel preparation and one Host-owned final bundle", async () => {
  const f = await nodeFixture(); const before = spawnCount();
  let final: any; let files: any; let live: ReturnType<typeof liveFor>; let prepares = 0;
  const owner = createCodexCurrentKernelOwner({hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
    hostCustody: f.core, platformTarget: f.options.platformTarget, effectCustody: syntheticCodexEffectCustody(),
    launchRecords: {resolve: async input => ({...f.options, credentialOutputInventory: codexCredentialOutputInventory(input)})},
    workspaceOwner: {withLaunchAuthority: async (_input, consume) => consume(f.workspaceAuthority)},
    postClaimPreparation: {async prepareClaimed(handoff) {
      prepares += 1; live = liveFor(handoff.underlyingCustodyRef);
      assert.equal(Object.is(live.plan, live.privateReservationPlan), true);
      assert.throws(() => f.core.start(live.custodyRef, startInput(live.plan)));
      const original = live.launchBinding.reservation;
      const lifetime = f.preparation.acquire(handoff);
      const finalizer = f.preparation.finalize(lifetime);
      files = await f.install(); const staged = await finalizer.stage({recipe: f.recipe, files});
      assert.equal(live.launchBinding.reservation, original);
      assert.equal(Object.is(live.plan, original!.plan), true);
      assert.throws(() => Core.launchView(f.core, live.custodyRef)!.readFinal());
      f.bindSession(finalizer, lifetime); final = finalizer.commit(staged);
      assert.equal(Object.is(live.plan, final.plan), true); assert.equal(Object.is(live.fingerprint, final.fingerprint), true);
      assert.equal(Object.is(live.privatePaths, final.privatePaths), true); assert.equal(Object.is(live.workspace, final.workspace), true);
      assert.equal(Object.is(Core.launchView(f.core, live.custodyRef)!.readFinal(), final), true);
      assert.notEqual(final.fingerprint.fingerprintSha256, original!.fingerprint.fingerprintSha256);
      assert.notEqual(final.plan, original!.plan);
      return {kind: "prepared"};
    }},
  });
  duringSpawn(() => {
    assert.equal(Object.is(constructorOptions()!.nativeBrokerLaunchPlan, final.plan), true);
    const material = issuer.codexNativeBrokerLaunchInput(final.plan);
    assert.equal(material.recipe, f.recipe); assert.equal(material.files, files);
    assert.equal(constructorOptions()!.sensitiveOutputTokens!.includes(material.localCapability), true);
  });
  try {
    const opened = await owner.custody.open(f.kernelInput);
    assert.equal(spawnCount(), before); assert.equal(prepares, 0);
    const proof = committedDispatchProofFixture(f.kernelInput, opened);
    const input = {...f.identity, intentMode: "analysis" as const, committedDispatchProof: proof,
      execute: (start: any) => owner.provider.execute({...executeInput(f.identity, "codex", snapshot), start})};
    await assert.rejects(owner.custody.start({...input,
      committedDispatchProof: committedDispatchProofFixture(f.kernelInput, opened, {hostBootId: "host-boot:foreign" as never})}));
    assert.equal(prepares, 0);
    await owner.custody.start(input);
    assert.equal(prepares, 1); assert.equal(spawnCount(), before + 1);
    assert.equal(Object.is(spawnObservation().live.launchBinding.view.readFinal(), final), true);
    assert.equal(Object.is(spawnObservation().live.plan, final.plan), true);
    assert.deepEqual(spawnObservation().arguments, final.plan.arguments);
    assert.equal(JSON.stringify({...spawnObservation().environment}) === JSON.stringify(final.plan.environment), true);
    await assert.rejects(owner.custody.start(input)); assert.equal(prepares, 1);
    assert.equal(spawnCount(), before + 1);
  } finally {duringSpawn(); owner.dispose();}
});

test("the same retained staged ingress authenticates native hex and never appears in receipt or upstream input", async () => {
  const f = await commit();
  const capability = issuer.codexNativeBrokerLaunchInput(f.final.plan).localCapability;
  assert.match(capability, /^[a-f0-9]{64}$/u);
  assert.equal(f.session.nativeBearerToken() === capability, true);
  const wire = `POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\nAuthorization: Bearer ${capability}\r\n\r\n{}`;
  const receipt = await f.session.execute({...f.egress.operation, operationId: f.identity.operationId, attemptId: f.identity.attemptId,
    connection: {...f.egress.operation.connection, request: chunks([wire])}} as never);
  assert.equal(f.egress.observations.materializationInputs.length, 1); // Same issuer authenticated before independent PA/RS checks.
  assert.equal(JSON.stringify([receipt, f.core.evidence(f.custodyRef), f.egress.observations]).includes(capability), false);
  const upstream = new TextDecoder().decode(f.egress.observations.dispatchedRequests[0]);
  assert.equal(upstream.includes(capability), false);
  f.session.close();
  assert.throws(() => Core.startFinalized(f.core, f.custodyRef, f.final, signal()));
});

test("raw base start, copied final bundle and substituted delegated values never consume native start", async () => {
  const f = await commit(); const before = spawnCount(); const live = liveFor(f.custodyRef);
  assert.throws(() => f.core.start(f.custodyRef, startInput(f.plan)));
  assert.throws(() => f.core.start(f.custodyRef, startInput(f.final.plan)));
  for (const bundle of [{...f.final}, Object.freeze({...f.final}), new Proxy(f.final, {})]) {
    assert.throws(() => Core.startFinalized(f.core, f.custodyRef, bundle, signal()));
  }
  assert.equal(live.startIdentitySha256, undefined); assert.equal(spawnCount(), before);
  const process = Core.startFinalized(f.core, f.custodyRef, f.final, signal());
  // Native state can grow once started. Replay must return the same process.
  file(`${f.options.boundary.codexHome}/history.synthetic`, Buffer.from("post-start"));
  assert.equal(Object.is(Core.startFinalized(f.core, f.custodyRef, f.final, signal()), process), true);
  assert.equal(spawnCount(), before + 1);
  const original = live.sdkProcess; delete live.sdkProcess;
  assert.throws(() => Core.startFinalized(f.core, f.custodyRef, f.final, signal()));
  live.sdkProcess = original;
});

for (const variant of ["material-clone", "recipe-clone", "files-clone", "material-proxy", "recipe-proxy", "files-proxy", "accessor", "foreign-recipe"] as const) {
  test(`stage rejects ${variant} without traps, publication or spawn`, async () => {
    const f = await nodeFixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef)); const finalizer = f.preparation.finalize(lifetime);
    const files = await f.install(); let effects = 0;
    const trap = () => {effects += 1; throw new Error("never invoke");};
    const proxy = (value: object) => new Proxy(value, {get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap});
    let material: any = {recipe: f.recipe, files};
    if (variant === "material-clone") {material = {recipe: {...f.recipe}, files: {...files}};}
    if (variant === "recipe-clone") {material.recipe = {...f.recipe};}
    if (variant === "files-clone") {material.files = {...files};}
    if (variant === "material-proxy") {material = proxy(material);}
    if (variant === "recipe-proxy") {material.recipe = proxy(f.recipe);}
    if (variant === "files-proxy") {material.files = proxy(files);}
    if (variant === "accessor") {Object.defineProperty(material, "recipe", {get: trap});}
    if (variant === "foreign-recipe") {material.recipe = (await nodeFixture()).recipe;}
    const before = spawnCount(); await assert.rejects(finalizer.stage(material));
    assert.equal(effects, 0); assert.equal(spawnCount(), before);
    assert.throws(() => Core.launchView(f.core, custodyRef)!.readFinal());
    await assert.rejects(finalizer.stage({recipe: f.recipe, files}));
  });
}

test("only the same actual preparation and receivers enter once; proof copies grant no finalization", async () => {
  const f = await nodeFixture(); const {custodyRef} = await f.reserve();
  const handoff = f.handoff(custodyRef); const lifetime = f.preparation.acquire(handoff);
  const other = await nodeFixture(); let traps = 0;
  const proxy = new Proxy(lifetime, {get() {traps += 1; throw new Error("never read");}});
  for (const bad of [handoff, handoff.committedDispatchProof, {...lifetime}, proxy]) {
    assert.throws(() => f.preparation.finalize(bad as never));
  }
  assert.throws(() => other.preparation.finalize(lifetime));
  assert.throws(() => f.preparation.finalize.call({} as never, lifetime));
  assert.equal(traps, 0);
  const finalizer = f.preparation.finalize(lifetime);
  assert.throws(() => f.preparation.finalize(lifetime));
  const files = await f.install(); const material = {recipe: f.recipe, files};
  await assert.rejects(finalizer.stage.call({} as never, material));
  const staged = await finalizer.stage(material);
  await assert.rejects(finalizer.stage(material));
  f.bindSession(finalizer, lifetime);
  const final = finalizer.commit(staged);
  assert.equal(Object.is(Core.launchView(f.core, custodyRef)!.readFinal(), final), true);
  assert.throws(() => finalizer.commit(staged));
});

for (const replacement of ["home", "tmp", "workspace", "root", "executable"] as const) {
  test(`staging rejects replacement of retained ${replacement}`, async () => {
    const f = await nodeFixture(); const {custodyRef} = await f.reserve();
    const lifetime = f.preparation.acquire(f.handoff(custodyRef)); const finalizer = f.preparation.finalize(lifetime);
    const files = await f.install();
    const path = {home: f.boundary.codexHome, tmp: f.options.tmpDir, workspace: f.input.workspaceRef,
      root: f.options.privateRootPath, executable: f.options.executablePath}[replacement];
    f.mutate(path, {ino: Number(stats(path).ino) + 10_000});
    const before = spawnCount(); await assert.rejects(finalizer.stage({recipe: f.recipe, files}));
    assert.equal(spawnCount(), before); assert.throws(() => Core.launchView(f.core, custodyRef)!.readFinal());
  });
}

test("native file installation refreshes only home timestamps while all reserved objects remain retained", async () => {
  const f = await nodeFixture(); const {custodyRef} = await f.reserve();
  const original = liveFor(custodyRef).launchBinding.reservation!;
  const lifetime = f.preparation.acquire(f.handoff(custodyRef)); const finalizer = f.preparation.finalize(lifetime);
  const files = await f.install(); const staged = await finalizer.stage({recipe: f.recipe, files});
  f.bindSession(finalizer, lifetime); const final = finalizer.commit(staged);
  for (const key of original.privatePaths.environmentKeys) {
    const before = original.privatePaths.byEnvironmentKey[key]!; const after = final.privatePaths.byEnvironmentKey[key]!;
    assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
    if (key === "HOME" || key === "CODEX_HOME") {assert.notEqual(before.ctimeNs, after.ctimeNs);}
    else {assert.equal(before.ctimeNs, after.ctimeNs);}
  }
  assert.equal(original.workspace.ino, final.workspace.ino);
  assert.equal(original.privatePaths.root.ino, final.privatePaths.root.ino);
  assert.equal(Object.is(original.plan, f.plan), true);
});

test("pending one-use verification remains cleanup-owned across cutoff and cannot publish or spawn", async () => {
  const f = await nodeFixture(); const {custodyRef} = await f.reserve();
  const lifetime = f.preparation.acquire(f.handoff(custodyRef)); const finalizer = f.preparation.finalize(lifetime);
  const files = await f.install(); const gate = Promise.withResolvers<void>();
  holdExecutableVerification(gate.promise); const before = spawnCount();
  try {
    const pending = finalizer.stage({recipe: f.recipe, files});
    const rejected = assert.rejects(pending);
    await assert.rejects(finalizer.stage({recipe: f.recipe, files}));
    await tick(); f.controller.abort();
    const containment = f.core.requestContainment({...f.identity, custodyRef});
    await tick(); assert.equal(f.residueCloses(), 0); assert.equal(liveFor(custodyRef).evidenceSealed, false);
    assert.ok(liveFor(custodyRef).launchBinding.pending);
    assert.throws(() => f.core.start(custodyRef, startInput(f.plan)));
    gate.resolve(); await rejected; await containment;
    assert.equal(spawnCount(), before); assert.equal(liveFor(custodyRef).evidenceSealed, true);
    assert.throws(() => Core.launchView(f.core, custodyRef)!.readFinal());
  } finally {gate.resolve(); holdExecutableVerification();}
});

for (const failure of ["missing-session", "missing-owner", "changed-route", "changed-generation", "changed-config", "cutoff"] as const) {
  test(`no partial final publication after ${failure}`, async () => {
    const f = await nodeFixture(); const s = await f.stage(); const before = spawnCount();
    if (["missing-owner", "changed-route", "changed-generation"].includes(failure)) {
      const {createEgressFixture, access} = await import("./native-launch-finalization-fixture.ts");
      const ports = createEgressFixture().ports; const proof = s.lifetime.committedDispatchProof;
      const identity = {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
        hostBootId: proof.hostBootId, liveProcessSessionIdentity: s.lifetime.executionSessionIdentity};
      const binding = {...ports.providerAccessSnapshot, ...access("codex")};
      if (failure === "changed-route") {binding.providerRouteRef = "route:substituted";}
      if (failure === "changed-generation") {binding.credentialGeneration += 1;}
      assert.throws(() => s.finalizer.bindSession({...ports, identity, providerAccessSnapshot: binding,
        ...(failure === "missing-owner" ? {journal: undefined} : {})} as never));
    } else if (failure !== "missing-session") {f.bindSession(s.finalizer, s.lifetime);}
    if (failure === "changed-config") {f.mutate(`${f.boundary.codexHome}/config.toml`, {revision: 99});}
    if (failure === "cutoff") {f.controller.abort();}
    assert.throws(() => s.finalizer.commit(s.stage));
    assert.throws(() => Core.launchView(f.core, s.custodyRef)!.readFinal());
    assert.equal(spawnCount(), before);
  });
}

test("private replay uses original inputs through commit, cutoff, release and tombstone", async () => {
  const f = await nodeFixture(); const s = await f.stage(); f.bindSession(s.finalizer, s.lifetime);
  const final = s.finalizer.commit(s.stage); const count = f.descriptorCount();
  assert.equal((await f.reserve()).custodyRef, s.custodyRef); assert.equal(f.descriptorCount(), count);
  const changes = [{launchPlan: final.plan}, {launchPlan: {...f.plan}}, {intentMode: "workspace-write"},
    {launchPlan: {...f.plan, executablePath: "/substitute"}}, {providerBinding: {...f.input.providerBinding, providerRouteRef: "other"}}];
  for (const change of changes) {await assert.rejects(f.core.reserve({...f.input, ...change} as never));}
  const contained = await f.core.requestContainment({...f.identity, custodyRef: s.custodyRef});
  assert.equal(contained.kind, "contained");
  assert.equal((await f.core.release({...f.identity, custodyRef: s.custodyRef,
    receiptRef: (contained as {receiptRef: string}).receiptRef})).kind, "released");
  assert.equal((await f.reserve()).custodyRef, s.custodyRef);
  for (const change of changes) {await assert.rejects(f.core.reserve({...f.input, ...change} as never));}
  assert.throws(() => f.preparation.acquire(f.handoff(s.custodyRef)));
  assert.throws(() => f.preparation.finalize(s.lifetime));
  assert.throws(() => Core.startFinalized(f.core, s.custodyRef, final, signal()));
});

test("ordinary permission-only reservation still starts without native preparation", async () => {
  const f = await nodeFixture(false); const {custodyRef} = await f.reserve(); const before = spawnCount();
  f.core.start(custodyRef, startInput(f.plan)); assert.equal(spawnCount(), before + 1);
  assert.equal(f.plan.environment.AR_PRIVATE_BROKER_CAPABILITY, undefined);
});

test("a successful preparation callback without actual finalization cannot qualify or downgrade the current owner", async () => {
  const f = await nodeFixture(); const before = spawnCount();
  const owner = createCodexCurrentKernelOwner({hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
    hostCustody: f.core, platformTarget: f.options.platformTarget, effectCustody: syntheticCodexEffectCustody(),
    launchRecords: {resolve: async input => ({...f.options, credentialOutputInventory: codexCredentialOutputInventory(input)})},
    workspaceOwner: {withLaunchAuthority: async (_input, consume) => consume(f.workspaceAuthority)},
    postClaimPreparation: {prepareClaimed: async () => ({kind: "prepared"})},
  });
  const opened = await owner.custody.open(f.kernelInput);
  await owner.custody.start({...f.identity, intentMode: "analysis", committedDispatchProof: committedDispatchProofFixture(f.kernelInput, opened),
    execute: start => owner.provider.execute({...executeInput(f.identity, "codex", snapshot), start})});
  assert.equal(spawnCount(), before); owner.dispose();
});

for (const change of ["home", "executable", "config", "cutoff"] as const) {
  test(`first start rechecks ${change} after final publication`, async () => {
    const f = await commit(); const before = spawnCount();
    if (change === "cutoff") {f.controller.abort();}
    else {
      const path = change === "home" ? f.boundary.codexHome : change === "executable"
        ? f.options.executablePath : `${f.boundary.codexHome}/config.toml`;
      f.mutate(path, {revision: 50});
    }
    assert.throws(() => Core.startFinalized(f.core, f.custodyRef, f.final, signal()));
    assert.equal(spawnCount(), before);
  });
}

test("final cwd, argv and environment still pass the actual Host fingerprint validation", async () => {
  const f = await commit();
  const {readCustodyStartAdmission} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-start-admission.js");
  const live = liveFor(f.custodyRef); const exact = startInput(f.final.plan);
  for (const change of [{command: "/substituted"}, {cwd: f.input.workspaceRef}, {arguments: f.plan.arguments},
    {environment: f.plan.environment}, {environment: {...f.final.plan.environment, AR_PRIVATE_BROKER_CAPABILITY: "0".repeat(64)}}]) {
    assert.throws(() => readCustodyStartAdmission({...exact, ...change}, live));
  }
  assert.equal(live.startIdentitySha256, undefined);
  assert.ok(readCustodyStartAdmission(exact, live));
});

test("guardian pre-exec recheck retains opened roots across Host sealing and still rejects native drift", async () => {
  const f = await commit();
  const live = liveFor(f.custodyRef);
  assert.equal(live.launchBinding.executionPermitted(live), false);
  Core.startFinalized(f.core, f.custodyRef, f.final, signal());
  const {modules} = await import("./native-launch-finalization-fixture.ts");
  const fs = modules.get("node:fs") as any;
  const workspace = fs.openSync(f.input.workspaceRef);
  const root = fs.openSync(f.options.privateRootPath);
  live.launchAuthority = {...live.launchAuthority!, workspaceDescriptor: {parentDescriptor: workspace, childDescriptor: 4},
    privateRootDescriptor: {parentDescriptor: root, childDescriptor: 8}};
  try {
    f.mutate(f.options.privateRootPath, {revision: 2}); // Host creates/unlinks its sealed executable here.
    assert.equal(live.launchBinding.executionPermitted(live), true);
    f.mutate(`${f.boundary.codexHome}/config.toml`, {revision: 2});
    assert.equal(live.launchBinding.executionPermitted(live), false);
  } finally {fs.closeSync(workspace); fs.closeSync(root);}
});
