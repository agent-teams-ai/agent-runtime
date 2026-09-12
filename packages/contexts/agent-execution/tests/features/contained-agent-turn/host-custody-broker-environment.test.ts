import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { HostCustodyLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import {
  assertDelegatedStartFingerprint,
  createFingerprint,
  verifyPrivateLaunchPaths,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";

// Synthetic local capability bytes, never an upstream provider credential.
const capability = "ab".repeat(32);
const changedCapability = "cd".repeat(32);
let root: string;
let workspace: string;
let base: HostCustodyLaunchPlan;
before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "ar69-broker-env-test-"));
  workspace = join(root, "workspace");
  const privateRoot = `${workspace}-host-private`;
  const home = join(privateRoot, "home");
  const temporary = join(privateRoot, "tmp");
  for (const path of [workspace, privateRoot, home, temporary]) {await mkdir(path, { mode: 0o700 });}
  base = Object.freeze({
    arguments: Object.freeze(["app-server", "--stdio", "--strict-config"]),
    binaryRevision: "sha256:" + "e".repeat(64),
    containmentProfile: "strict-linux-cgroup-v2",
    environment: Object.freeze({ CODEX_HOME: home, HOME: home, LANG: "C.UTF-8", PATH: "/usr/bin:/bin", TMPDIR: temporary }),
    executablePath: "/synthetic/codex",
    executableSha256: "e".repeat(64),
    intentMode: "analysis",
    privateRootPath: privateRoot,
    provider: "codex",
    spawnMode: "sdk-delegated",
  });
});
after(async () => {if (root !== undefined) {await rm(root, { force: true, recursive: true });}});
const withEnvironment = (extra: Readonly<Record<string, string>>): HostCustodyLaunchPlan =>
  Object.freeze({ ...base, environment: Object.freeze({ ...base.environment, ...extra }) });
const checkPaths = async (plan: HostCustodyLaunchPlan) =>
  verifyPrivateLaunchPaths(plan, workspace, await lstat(workspace, { bigint: true }));

test("Codex native env_key capability is a value, never a private directory", async () => {
  const plan = withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability });
  const observation = await checkPaths(plan);
  assert.deepEqual(observation.environmentKeys, ["CODEX_HOME", "HOME", "TMPDIR"]);
  assert.equal(Object.hasOwn(observation.byEnvironmentKey, "AR_PRIVATE_BROKER_CAPABILITY"), false);
  assert.equal(observation.byEnvironmentKey.CODEX_HOME?.path, base.environment.CODEX_HOME);
});

test("an existing plan without a broker capability keeps its private path contract", async () => {
  assert.deepEqual((await checkPaths(base)).environmentKeys, ["CODEX_HOME", "HOME", "TMPDIR"]);
});

for (const [label, value] of [
  ["empty", ""], ["short", "a".repeat(63)], ["long", "a".repeat(65)],
  ["uppercase", "A".repeat(64)], ["nonhex", "g".repeat(64)],
  ["newline", capability + "\n"], ["nul", "a".repeat(63) + "\0"],
  ["unicode", "é".repeat(64)], ["path", "/private/" + "a".repeat(55)],
  ["bearer", "Bearer " + capability],
] as const) {
  test(`local capability rejects ${label} without disclosing its value`, async () => {
    await assert.rejects(checkPaths(withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: value })), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(capability), false);
      assert.equal(error.message.includes(workspace), false);
      return true;
    });
  });
}

for (const key of ["AR_PRIVATE_BROKER_CAPABILITY", "LANG", "PATH"] as const) {
  test(`a value key cannot become a retained path: ${key}`, async () => {
    await assert.rejects(checkPaths({
      ...withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability }),
      privatePathEnvironmentKeys: [key],
    }), /private environment key is not a path/u);
  });
}

test("known path declarations remain supported and duplicate declarations remain rejected", async () => {
  const plan = withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability });
  assert.deepEqual((await checkPaths({ ...plan, privatePathEnvironmentKeys: ["HOME", "CODEX_HOME", "TMPDIR"] })).environmentKeys,
    ["CODEX_HOME", "HOME", "TMPDIR"]);
  await assert.rejects(checkPaths({ ...plan, privatePathEnvironmentKeys: ["HOME", "HOME"] }), /must be unique/u);
});

for (const key of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "SSL_CERT_FILE", "AR_PRIVATE_BROKER_CAPABILITY_EXTRA"]) {
  test(`Codex broker support does not admit ambient key ${key}`, async () => {
    await assert.rejects(checkPaths(withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability, [key]: "synthetic" })),
      /unclassified key/u);
  });
}

test("the Codex capability key is rejected for Claude and unknown providers", async () => {
  for (const provider of ["claude", "unknown"]) {
    await assert.rejects(checkPaths({ ...withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability }), provider }),
      /unclassified key/u);
  }
});

test("capability rotation changes the private launch fingerprint without returning capability bytes", () => {
  const input = {
    attemptId: "attempt:synthetic",
    intentMode: "analysis" as const,
    operationId: "operation:synthetic",
    providerBinding: {
      adapterRevision: "adapter:synthetic", binaryRevision: base.binaryRevision,
      capabilityManifestRevision: "manifest:synthetic", credentialBindingDigest: "binding:synthetic",
      provider: "codex", providerRouteRef: "route:synthetic",
    },
    workspaceRef: workspace,
  };
  const firstPlan = withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability });
  const secondPlan = withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: changedCapability });
  const first = createFingerprint(input, firstPlan, workspace, firstPlan.arguments);
  const second = createFingerprint(input, secondPlan, workspace, secondPlan.arguments);
  assert.notEqual(first.fingerprintSha256, second.fingerprintSha256);
  assert.equal(first.argumentsSha256, second.argumentsSha256);
  assert.ok(first.environmentKeys.includes("AR_PRIVATE_BROKER_CAPABILITY"));
  assert.equal(JSON.stringify(first).includes(capability), false);
  assert.equal(JSON.stringify(second).includes(changedCapability), false);
});

test("delegated SDK start must present the exact retained capability", () => {
  const plan = withEnvironment({ AR_PRIVATE_BROKER_CAPABILITY: capability });
  const start = { arguments: plan.arguments, command: plan.executablePath, cwd: "/proc/self/fd/4", environment: plan.environment };
  assert.equal(assertDelegatedStartFingerprint(start, plan), plan.environment);
  assert.throws(() => assertDelegatedStartFingerprint({ ...start, environment: { ...plan.environment, AR_PRIVATE_BROKER_CAPABILITY: changedCapability } }, plan),
    { name: "HostCustodyFingerprintConflictError" });
  const { AR_PRIVATE_BROKER_CAPABILITY: omitted, ...withoutCapability } = plan.environment;
  assert.equal(omitted, capability);
  assert.throws(() => assertDelegatedStartFingerprint({ ...start, environment: withoutCapability }, plan),
    { name: "HostCustodyFingerprintConflictError" });
});
