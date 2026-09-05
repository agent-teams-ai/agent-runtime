import assert from "node:assert/strict";
import test from "node:test";
import { sourceFixture, evidenceInput } from "./support/provider-candidate-source-fixture.mjs";
import { DARWIN_LIMITATIONS } from "../../live/provider-candidate-observation.mjs";
import { safeTuple } from "../../live/provider-candidate-evidence-schema.mjs";

const freeze = Object.freeze;
const digest = "a".repeat(64);
const reversed = (value: Record<string, unknown>) => freeze(Object.fromEntries(Object.entries(value).reverse()));

// All rejection cases call the publishing boundary with a genuine locally
// minted provenance object; validation cannot pass merely by rejecting a fake.
test("bounded evidence rejects raw, executable, mutable and oversized inputs without evaluating them", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  const input = evidenceInput(fixture, execution);
  const publish = (value: unknown) => fixture.authority.createProviderCandidateEvidenceEnvelope(value);
  const reject = async (value: unknown) => assert.rejects(publish(value), TypeError);
  let calls = 0;
  const getter = {get() {calls += 1; throw new Error("must never evaluate");}, enumerable: true};
  const proxy = (target: object) => new Proxy(target, {
    get() {calls += 1; throw new Error("get");},
    getPrototypeOf() {calls += 1; throw new Error("prototype");},
    ownKeys() {calls += 1; throw new Error("keys");},
    isExtensible() {calls += 1; throw new Error("extensible");},
  });
  await reject({...input});
  await reject(proxy(input));
  const revoked = Proxy.revocable(input, {}); revoked.revoke(); await reject(revoked.proxy);
  await reject(freeze(Object.create(input)));
  await reject(freeze(Object.assign(Object.create(null), input)));
  await reject(freeze({...input, [Symbol("unknown")]: "secret"}));
  await reject(freeze(Object.defineProperty({...input}, "status", getter)));
  for (const field of ["observations", "platformTuple", "packageIdentity"]) {
    await reject(freeze({...input, [field]: {...input[field]}}));
    await reject(freeze({...input, [field]: proxy(input[field])}));
    await reject(freeze({...input, [field]: freeze({...input[field], payload: "secret"})}));
    const key = Object.keys(input[field])[0];
    await reject(freeze({...input, [field]: freeze(Object.defineProperty({...input[field]}, key, getter))}));
    await reject(freeze({...input, [field]: freeze({...input[field], [Symbol("unknown")]: true})}));
  }
  for (const field of ["workspacePath", "stdout", "providerPayload", "credentials", "toJSON"]) {
    await reject(freeze({...input, [field]: "/private/secret"}));
    await reject(freeze({...input, observations: freeze({...input.observations, [field]: "/private/secret"})}));
  }
  for (const value of ["/private/secret", "Bearer credential", "sk-secret", "https://private.invalid/a", "x".repeat(513)]) {
    await reject(freeze({...input, binaryRevision: value}));
    await reject(freeze({...input, observations: freeze({...input.observations, resultRef: value})}));
    await reject(freeze({...input, platformTuple: freeze({...input.platformTuple, adapterRevision: value})}));
    await reject(freeze({...input, packageIdentity: freeze({wrapperPackageRevision: value})}));
  }
  for (const value of [-1, 100_001, 0.5, NaN, Infinity, "1", 1n, {}]) {
    await reject(freeze({...input, observations: freeze({...input.observations, outputEvents: value})}));
  }
  for (const value of ["a".repeat(63), "a".repeat(65), "G".repeat(64), {toString() {calls += 1; return digest;}}]) {
    await reject(freeze({...input, binarySha256: value}));
  }
  const limits = [...DARWIN_LIMITATIONS];
  const accessorArray = freeze(Object.defineProperty([limits[0]], "0", getter));
  const symbolArray = freeze(Object.assign([...limits], {[Symbol("extra")]: true}));
  for (const value of [limits, proxy(freeze(limits)), accessorArray, symbolArray,
    freeze(new Array(2)), freeze([...limits, limits[0]]), freeze([limits[0], limits[0]]), freeze(["raw-secret"])]) {
    await reject(freeze({...input, observations: freeze({...input.observations, containmentLimitations: value})}));
  }
  await reject(freeze({...input, observations: freeze({})}));
  await reject(freeze({...input, observations: freeze({...input.observations, errorDigest: digest})}));
  await reject(freeze({...input, executionProvenance: freeze({...execution})}));
  await reject(freeze({...input, executionProvenance: proxy(execution)}));
  assert.equal(calls, 0);
});

test("canonical envelope retains bounded failure facts, detaches data and rejects contradictory Darwin success", async t => {
  const fixture = await sourceFixture(t);
  const execution = await fixture.resolve();
  const input = evidenceInput(fixture, execution, {
    binaryRevision: "@openai/codex:0.150.1+darwin-arm64",
    platformTuple: freeze({platform: "darwin", architecture: "arm64"}),
    observations: freeze({
      failureKind: "canary-failed", ownerDisposal: "failed", runtimeDisposal: "completed",
      terminalKind: "open", terminalStatus: "reconcile_required", reconciliation: "clear", closureRecovery: "required",
      providerOutcome: "succeeded", outputEvents: 100_000,
      operationIdentityDigest: digest, executionClosureProofDigest: digest, providerTerminalProofDigest: digest,
      outputDrainProofDigest: digest, artifactManifestProofDigest: digest, resultPublicationProofDigest: digest,
      artifactManifestRef: `urn:agent-runtime:artifact-manifest:${digest}`,
      resultRef: `urn:agent-runtime:contained-turn-result:${digest}`,
      closureStatus: "unproven", containmentProfile: "cooperative-darwin-posix-process-group",
      containmentLimitations: DARWIN_LIMITATIONS,
    }),
  });
  const publish = (value: unknown) => fixture.authority.createProviderCandidateEvidenceEnvelope(value);
  const first = await publish(input);
  const second = await publish(reversed({...input, platformTuple: reversed(input.platformTuple),
    packageIdentity: reversed(input.packageIdentity), observations: reversed({...input.observations,
      containmentLimitations: freeze([...DARWIN_LIMITATIONS].reverse())})}));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.observations.resultRef, input.observations.resultRef);
  assert.equal(first.observations.artifactManifestRef, input.observations.artifactManifestRef);
  assert.equal(first.observations.ownerDisposal, "failed");
  assert.equal(first.observations.terminalStatus, "reconcile_required");
  assert.equal(first.qualification, "implementation-evidence-only");
  assert.equal(first.networkRouteEnforcement, "unqualified");
  assert.equal(first.compositeContainment, "indeterminate");
  assert.ok(JSON.stringify(first).length < 8192);
  for (const key of ["observations", "packageIdentity", "platformTuple"]) {
    assert.notEqual(first[key], input[key]);
    assert.ok(Object.isFrozen(first[key]));
  }
  assert.ok(Object.isFrozen(first.observations.containmentLimitations));
  for (const observations of [
    {...input.observations, terminalKind: "final", terminalStatus: "succeeded", terminalProofDigest: digest},
    {...input.observations, containmentProofDigest: digest},
    {...input.observations, containmentProfile: "strict-linux-cgroup-v2"},
    {...input.observations, containmentLimitations: freeze([])},
  ]) {await assert.rejects(publish(freeze({...input, observations: freeze(observations)})), TypeError);}
  await assert.rejects(publish(freeze({...input, physicalContainment: "contained"})), TypeError);
  await assert.rejects(publish(freeze({...input, status: "provider-completed"})), TypeError);
});

test("safe tuple schema accepts the actual pinned provider tuples", async () => {
  const codex = await import("../../../src/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.ts");
  const claude = await import("../../../src/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.ts");
  for (const tuple of [codex.CODEX_APP_SERVER_LINUX_X64_TUPLE, codex.CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
    claude.CLAUDE_AGENT_SDK_LINUX_X64_TUPLE, claude.CLAUDE_AGENT_SDK_DARWIN_ARM64_TUPLE]) {
    const safe = safeTuple(tuple);
    assert.equal(safe.platform, tuple.platform);
    assert.equal(safe.containmentProfile, tuple.containmentProfile);
  }
});
