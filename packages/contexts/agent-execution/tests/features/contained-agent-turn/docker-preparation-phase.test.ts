import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
import {compileFunction} from "node:vm";
import test from "node:test";
import * as diagnostic from "../../../dist/features/contained-agent-turn/composition/docker-native-start-diagnostic.js";
import {ContainedTurnKernelCustodyAdapter} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js";
import {adapterSnapshot, attemptId, authorityDigest, commandId, custodyId, effectId, hostBootId, hostInstanceId,
  operationId, preparationToken, providerAccessSnapshot, workspaceId} from "../../contained-turn-kernel-fixtures.ts";
import {containedTurnOperationCutoffRevision} from "../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";

// Source-only callsite tests. Strip types and substitute imports, never the function body.
// Only these two composition modules are evaluated; no filesystem runtime fixture is used.
function sourceFactory(name: string, exported: string, bindings: Record<string, unknown>) {
  const url = new URL(`../../../src/features/contained-agent-turn/composition/${name}.ts`, import.meta.url);
  const source = stripTypeScriptTypes(readFileSync(url, "utf8"))
    .replace(/^import\s[\s\S]*?from\s*"[^"]+";\s*/gm, "")
    .replace(/^export /gm, "");
  return compileFunction(`${source}\nreturn ${exported};`, Object.keys(bindings), {filename: url.pathname})(...Object.values(bindings));
}
const openInput = {adapterSnapshot, attemptId, authorityVectorDigest: authorityDigest, commandId, custodyId, effectId,
  intentMode: "analysis" as const, operationId, operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationRevision: 1, preparationToken, providerAccessSnapshot, workspaceId};
const unused = () => {throw new Error("unexpected synthetic boundary call");};

function fixture(fault: string, failure: unknown, cleanupFailure?: unknown) {
  const events: string[] = [];
  let original: unknown;
  const atCutoff: unknown[] = [];
  const files = {bindRoot: unused, install: unused, quiesce: unused, snapshot: unused,
    cutoff() {assert.equal(this, files); events.push("cutoff"); atCutoff.push(diagnostic.nativeStartDiagnostic(files)); recorder.cutoff();
      if (cleanupFailure !== undefined) {throw cleanupFailure;}}};
  const recorder = diagnostic.retainNativeStartDiagnostic(files);
  const failAt = (point: string) => {events.push(point); if (fault === point) {throw failure;}};
  let settle!: (value: {kind: string}) => void;
  let rejectFlight!: (reason: unknown) => void;
  const flight = new Promise<{kind: string}>((resolve, reject) => {settle = resolve; rejectFlight = reject;});
  const plan = {arguments: [], binaryRevision: adapterSnapshot.binaryRevision, containmentProfile: "strict-linux-cgroup-v2",
    environment: {}, executablePath: "/synthetic/provider", executableSha256: "a".repeat(64), intentMode: "analysis",
    privateRootPath: "/synthetic/private", provider: "codex", spawnMode: "sdk-delegated"};
  let reservation: unknown;
  const raw = {
    async reserve(input: unknown) {reservation = input; return {custodyRef: "host:retained"};},
    open: unused, evidence: () => {},
    async requestContainment() {events.push("contain"); return {kind: "contained", receiptRef: "receipt:synthetic"};},
    release: unused, dispose() {},
    reservation() {return {input: reservation, evidence: {trackPreparation(value: unknown) {assert.equal(value, flight); events.push("track");}}};},
    installCleanup() {failAt("install-cleanup");}, installPrivateRoot() {failAt("install-root");},
  };
  const reservationFactory = sourceFactory("docker-host-reservation-owners", "createDockerHostReservationOwners", {});
  const factory = sourceFactory("docker-codex-host-kernel-owner", "createDockerCodexHostKernelOwner", {
    ...diagnostic,
    custodyDataRecord: (value: unknown) => value,
    isHostCustodyDataCallback: (value: unknown) => typeof value === "function",
    sameHostCustodyBinding: () => true,
    snapshotDockerImageInitLock: (value: unknown) => value,
    createHostPrivateRootOwnerFactory: () => ({create() {failAt("root-create"); return {};}}),
    DockerKernelHostCustody: function SyntheticCustody() {return raw;},
    CodexAppServerCurrentKernelAdapter: class {adapterSnapshot = adapterSnapshot; manifest = {};},
    ContainedTurnKernelCustodyAdapter: class extends ContainedTurnKernelCustodyAdapter {
      constructor(host: never, options: never) {
        // Real outer containment/admission; observe identity before its deliberate bare catch.
        const selected = options as {postClaimPreparation: {prepareClaimed(input: unknown): Promise<unknown>}};
        super(host, {...selected, postClaimPreparation: {async prepareClaimed(input: unknown) {
          try {return await selected.postClaimPreparation.prepareClaimed(input);} catch (error) {original = error; throw error;}
        }}} as never);
      }
    },
    createCodexAppServerFinalizableLaunchPlan: () => plan,
    hostHttpAbortOperations: {subscribe() {failAt("subscribe"); return {};}, remove() {events.push("unsubscribe");}, aborted: () => false},
    createDockerHostReservationOwners(input: unknown) {failAt("reservation-constructor"); return reservationFactory(input);},
    createDockerLinuxPostClaimOwner() {failAt("postclaim-constructor"); return {
      preparation: {prepareClaimed() {events.push("inner-prepare"); return flight;}}, cutoff() {events.push("owner-cutoff");},
    };},
    createDockerCodexCurrentKernelOwner: unused,
  });
  const owner = factory({cleanupMilliseconds: 100, hostBootId, hostInstanceId, platformTarget: {platform: "linux", architecture: "x64"},
    imageInitLock: {}, finishClaimed: unused,
    launchRecords: {async resolve() {return {boundary: {workspaceRef: "/synthetic/disposable"}};}},
    workspaceOwner: {async withLaunchAuthority(_input: unknown, consume: (value: unknown) => unknown) {
      return consume({canonicalPath: "/synthetic/disposable", descriptorPath: "/synthetic/descriptor", identity: {dev: 1n, ino: 2n, mountId: "mount:synthetic"}});
    }},
    preparation() {failAt("selection"); return {get nativeFiles() {if (fault === "files-identity") {throw failure;} return files;},
      workspaceBackingTreeOwnership: {kind: "exclusive-host-owned-disposable-tree", evidenceRef: "urn:test:owned-tree"},
      deadlines: {routeLifetimeMs: 100}};},
  });
  return {owner, files, recorder, events, settle, reject: rejectFlight, atCutoff, original: () => original};
}

function hostileValues() {
  let inspections = 0;
  const armed = () => {inspections++; throw new Error("payload must remain opaque");};
  const getters = Object.create(null);
  for (const key of ["code", "message", "stack", "cause", "toString", "toJSON"]) {Object.defineProperty(getters, key, {get: armed});}
  const proxy = new Proxy({}, {get: armed, has: armed, getPrototypeOf: armed, ownKeys: armed, getOwnPropertyDescriptor: armed});
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  return {values: [undefined, null, false, 1, "opaque", Symbol("opaque"), getters, proxy, revoked.proxy], reads: () => inspections};
}
for (const fault of ["selection", "files-identity", "subscribe", "reservation-constructor", "postclaim-constructor", "root-create", "install-cleanup", "install-root"]) {
  test(`source-only composed Host failure: ${fault}; real outer containment and zero payload inspection`, async () => {
    const hostile = hostileValues();
    for (const failure of hostile.values) {
      const f = fixture(fault, failure);
      const unassociated = ["selection", "files-identity"].includes(fault);
      const opened = await f.owner.custody.open(openInput);
      const start = {attemptId, custodyId, operationId, workspaceId, intentMode: "analysis",
        committedDispatchProof: committedDispatchProofFixture(openInput, opened),
        async execute(input: {createProcess(action: () => void): void}) {f.events.push("execute"); input.createProcess(() => {f.events.push("creator");}); return {kind: "completed", outcome: "succeeded"};}};
      assert.equal((await f.owner.custody.start(start)).kind, "indeterminate");
      assert.equal(f.original() === failure, true);
      assert.equal(f.events.filter(event => event === "contain").length, 1);
      assert.equal(f.events.includes("execute"), false); assert.equal(f.events.includes("creator"), false);
      assert.equal(f.events.includes("inner-prepare"), false);
      assert.equal(f.events.includes("cutoff"), !unassociated);
      assert.equal(f.events.includes("unsubscribe"), !["selection", "files-identity", "subscribe"].includes(fault));
      const first = diagnostic.nativeStartDiagnostic(f.files)!;
      const attach = ["root-create", "install-cleanup", "install-root"].includes(fault);
      assert.deepEqual(first, {phase: unassociated ? "preflight" : attach ? "host-attach" : "preparation-construction",
        failingPhase: unassociated ? null : attach ? "host-attach" : "preparation-construction",
        lastCompleted: attach ? "preparation-construction" : null, cutoff: !unassociated, errorCode: unassociated ? null : "unknown"});
      if (!unassociated) {assert.deepEqual(f.atCutoff, [{...first, cutoff: false}]);}
      await assert.rejects(f.owner.custody.start(start));
      assert.equal(f.events.filter(event => event === "selection").length, 1);
      if (!unassociated) {
        diagnostic.nativeStartStep(f.files, "bridge-open", () => {}); f.recorder.begin("return"); f.recorder.fail(); f.recorder.cutoff();
        assert.deepEqual(diagnostic.nativeStartDiagnostic(f.files), first);
      }
      assert.equal(hostile.reads(), 0);
    }
  });
}

test("source-only composed success completes synchronous attach while inner preparation remains pending", async () => {
  const f = fixture("none", null);
  const opened = await f.owner.custody.open(openInput);
  const pending = f.owner.custody.start({attemptId, custodyId, operationId, workspaceId, intentMode: "analysis",
    committedDispatchProof: committedDispatchProofFixture(openInput, opened),
    async execute(input: {createProcess(action: () => void): void}) {f.events.push("execute"); input.createProcess(() => {f.events.push("creator");}); return {kind: "completed", outcome: "succeeded"};}});
  await new Promise(resolve => {setImmediate(resolve);});
  assert.deepEqual(f.events, ["selection", "subscribe", "reservation-constructor", "postclaim-constructor", "root-create", "install-cleanup", "install-root", "inner-prepare", "track"]);
  assert.deepEqual(diagnostic.nativeStartDiagnostic(f.files), {phase: "host-attach", lastCompleted: "host-attach", failingPhase: null, cutoff: false, errorCode: null});
  f.settle({kind: "prepared"});
  assert.equal((await pending).kind, "indeterminate"); // Synthetic creator provides no process-start evidence.
  assert.equal(f.events.filter(event => event === "execute").length, 1);
  assert.equal(f.events.filter(event => event === "creator").length, 1);
  diagnostic.nativeStartStep(f.files, "native-plan-recognition", () => {});
  assert.equal(diagnostic.nativeStartDiagnostic(f.files)!.lastCompleted, "native-plan-recognition");
});

for (const mode of ["async-rejection", "cleanup-throw"]) {
  test(`source-only ${mode} preserves the existing outer failure behavior`, async () => {
    const hostile = hostileValues(); const failure = hostile.values.at(-1);
    const cleanupFailure = hostile.values.at(-2);
    const f = fixture(mode === "cleanup-throw" ? "root-create" : "none", failure,
      mode === "cleanup-throw" ? cleanupFailure : undefined);
    const opened = await f.owner.custody.open(openInput);
    const pending = f.owner.custody.start({attemptId, custodyId, operationId, workspaceId, intentMode: "analysis",
      committedDispatchProof: committedDispatchProofFixture(openInput, opened), execute: unused});
    if (mode === "async-rejection") {f.reject(failure);}
    assert.equal((await pending).kind, "indeterminate");
    assert.equal(f.original() === (mode === "cleanup-throw" ? cleanupFailure : failure), true);
    const observed = diagnostic.nativeStartDiagnostic(f.files)!;
    assert.equal(observed.failingPhase, mode === "cleanup-throw" ? "host-attach" : null);
    assert.equal(observed.lastCompleted, mode === "cleanup-throw" ? "preparation-construction" : "host-attach");
    assert.equal(observed.cutoff, true);
    assert.equal(f.events.filter(event => event === "unsubscribe").length, 1);
    assert.equal(f.events.filter(event => event === "contain").length, 1);
    assert.equal(hostile.reads(), 0);
  });
}
