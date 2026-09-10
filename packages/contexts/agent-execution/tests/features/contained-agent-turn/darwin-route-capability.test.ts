import assert from "node:assert/strict";
import test from "node:test";
import { createDarwinCodexRouteEnforcement, bindDarwinCodexRouteEnforcement, readContainedTurnRouteEnforcementTarget }
  from "../../../dist/composition.js";
import { darwinRouteFixture } from "./support/darwin-route-capability-fixture.ts";

test("Darwin producer is nominal, captured and inert; real preparation retains one-use refusal", async () => {
  const f = darwinRouteFixture(); const capability = f.mint();
  const options = bindDarwinCodexRouteEnforcement(capability, f.input.owner);
  assert.deepEqual(readContainedTurnRouteEnforcementTarget(capability), f.input.qualificationTarget);
  assert.notEqual(readContainedTurnRouteEnforcementTarget(capability), f.input.qualificationTarget);
  assert.equal(options.postClaimPreparation, capability.postClaimPreparation);
  assert.equal(f.resolves(), 0); assert.equal(f.acquisitions(), 0); assert.equal(f.egress.observations.opens, 0);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Synthetic non-Darwin observation guarantees no native path can execute.
  Object.defineProperty(process, "platform", {...platform, value: "linux"});
  try {
    const claimed = {signal: new AbortController().signal, underlyingCustodyRef: "synthetic",
      committedDispatchProof: {provider: "codex", hostBootId: f.input.owner.hostBootId, hostInstanceId: f.input.owner.hostInstanceId}};
    assert.deepEqual(await capability.postClaimPreparation.prepareClaimed(claimed as never), {kind: "quarantined"});
    assert.deepEqual(await capability.postClaimPreparation.prepareClaimed(claimed as never), {kind: "quarantined"});
  } finally {Object.defineProperty(process, "platform", platform);}
  assert.equal(f.egress.observations.opens, 0);
});

test("copies, proxies and accessor brands cannot carry Darwin authority or trigger reads", () => {
  const f = darwinRouteFixture(); const capability = f.mint(); let reads = 0;
  const trap = () => {reads++; throw new Error("must not read");};
  for (const fake of [{...capability}, Object.create(capability), new Proxy(capability, {get: trap, ownKeys: trap}),
    {get postClaimPreparation() {return trap();}}, {}, null, undefined]) {
    assert.equal(readContainedTurnRouteEnforcementTarget(fake), undefined);
    assert.throws(() => bindDarwinCodexRouteEnforcement(fake, f.input.owner), TypeError);
  }
  assert.equal(reads, 0);
});

test("wrong provider, adapter, binary, platform and Host cannot mint or bind", () => {
  const f = darwinRouteFixture(); const cap = f.mint();
  for (const key of ["provider", "providerAdapter", "binaryClosure", "platform"] as const) {
    assert.throws(() => createDarwinCodexRouteEnforcement({...f.input,
      qualificationTarget: {...f.input.qualificationTarget, [key]: "wrong"}}), TypeError);
  }
  assert.throws(() => createDarwinCodexRouteEnforcement({...f.input, preparation: {...f.input.preparation, hostCustody: {}}}), TypeError);
  assert.throws(() => createDarwinCodexRouteEnforcement({...f.input, preparation: {...f.input.preparation,
    executable: {...f.input.preparation.executable, sha256: "a".repeat(64)}}}), TypeError);
  for (const change of [{hostCustody: {}}, {hostBootId: "foreign"}, {hostInstanceId: "foreign"},
    {platformTarget: {platform: "linux", architecture: "x64"}}, {launchRecords: {resolve: async () => undefined}},
    {effectCustody: {}}, {workspaceOwner: {}}, {postClaimPreparation: {prepareClaimed: async () => ({kind: "prepared"})}},
    {postClaimPreparation: {...cap.postClaimPreparation}}]) {
    assert.throws(() => bindDarwinCodexRouteEnforcement(cap, {...f.input.owner, ...change} as never), TypeError);
  }
  assert.equal(bindDarwinCodexRouteEnforcement(cap, {...f.input.owner, postClaimPreparation: cap.postClaimPreparation}).postClaimPreparation,
    cap.postClaimPreparation);
});

test("accessors and proxies on input, owner, platform and pins are rejected without invocation", () => {
  const f = darwinRouteFixture(); const cap = f.mint(); let reads = 0;
  const trap = () => {reads++; throw new Error("must not read");};
  for (const input of [new Proxy(f.input, {ownKeys: trap}),
    {...f.input, sessionOwner: new Proxy(f.input.sessionOwner, {ownKeys: trap})},
    {...f.input, sessionOwner: {get acquire() {return trap();}}},
    {...f.input, preparation: {...f.input.preparation, catalogSource: new Proxy(Buffer.alloc(0), {get: trap})}}, {...f.input, get preparation() {return trap();}},
    {...f.input, owner: new Proxy(f.input.owner, {ownKeys: trap})},
    {...f.input, owner: {...f.input.owner, platformTarget: {get platform() {return trap();}, architecture: "arm64"}}},
    {...f.input, preparation: {...f.input.preparation, executable: {get path() {return trap();}, sha256: f.tuple.binarySha256}}}]) {
    assert.throws(() => createDarwinCodexRouteEnforcement(input as never), TypeError);
  }
  assert.throws(() => bindDarwinCodexRouteEnforcement(cap, {...f.input.owner, get postClaimPreparation() {return trap();}}), TypeError);
  assert.equal(reads, 0);
});

test("captured resolver enforces exact operation closure and cannot be replaced after mint", async () => {
  const f = darwinRouteFixture(); const cap = f.mint(); const options = bindDarwinCodexRouteEnforcement(cap, f.input.owner);
  const binding = {provider: "codex", adapterRevision: f.tuple.adapterRevision, binaryRevision: f.tuple.binaryRevision,
    capabilityManifestRevision: f.tuple.protocolRevision};
  for (const key of Object.keys(binding)) {
    await assert.rejects(options.launchRecords.resolve({providerBinding: {...binding, [key]: "foreign"}} as never), TypeError);
  }
  assert.equal(f.resolves(), 0);
  f.input.owner.launchRecords.resolve = async () => {throw new Error("replacement resolver");};
  assert.equal(await options.launchRecords.resolve({providerBinding: binding} as never), undefined);
  assert.equal(f.resolves(), 1);
  assert.equal(f.egress.observations.opens, 0);
});
