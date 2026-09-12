import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { findRepoRoot } from "./helpers/repo-root.ts";
import { requireContainedTurnLiveCanaryAuthorities } from "@agent-teams/agent-execution/tests/features/contained-agent-turn/support/contained-turn-live-canary-lifecycle.mjs";
import {
  createHostCustodiedContainedTurn, ProviderRouteEnforcementUnsupportedError,
} from "../dist/composition/contained-turn-feature-composition.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const authoritySourceUrl = pathToFileURL(join(
  findRepoRoot(),
  "packages/contexts/agent-execution/tests/live/provider-candidate-evidence-envelope.mjs",
));
const {
  createProviderCandidateEvidenceEnvelope,
  resolveCanaryExecutionProvenance,
  revalidateCanaryExecutionProvenance,
} = await import(authoritySourceUrl.href);

type ExecutionAuthority = {
  createProviderCandidateEvidenceEnvelope: typeof createProviderCandidateEvidenceEnvelope;
  resolveCanaryExecutionProvenance: typeof resolveCanaryExecutionProvenance;
  revalidateCanaryExecutionProvenance: typeof revalidateCanaryExecutionProvenance;
};

const git = async (root: string, ...args: string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", [
    "-c", "core.excludesFile=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-C", root, ...args,
  ], {
    encoding: "utf8",
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    killSignal: "SIGKILL",
    timeout: 5_000,
  });
  return result.stdout.trim();
};

const sourceFixture = async (withGit = true) => {
  const root = await mkdtemp(join(tmpdir(), "route-canary-source-"));
  temporaryRoots.push(root);
  const liveRoot = join(root, "tests", "live");
  const buildRoot = join(root, "dist");
  const authorityPath = join(liveRoot, "provider-candidate-evidence-envelope.mjs");
  const canaryPath = join(liveRoot, "canary.mjs");
  await Promise.all([mkdir(liveRoot, { recursive: true }), mkdir(buildRoot, { recursive: true })]);
  await Promise.all([
    writeFile(authorityPath, await readFile(authoritySourceUrl)),
    writeFile(canaryPath, "export const canaryImplementation = true;\n"),
    writeFile(join(buildRoot, "runtime.mjs"), "export const freshBuild = 1;\n"),
    writeFile(join(root, ".gitignore"), "dist/\n"),
  ]);
  if (withGit) {
    await git(root, "init", "--quiet");
    await git(root, "config", "core.hooksPath", "/dev/null");
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Route Canary Test", "-c", "user.email=route-canary@example.invalid",
      "commit", "--quiet", "-m", "test: commit canary implementation");
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(root, "add", "README.md");
    await git(root, "-c", "user.name=Route Canary Test", "-c", "user.email=route-canary@example.invalid",
      "commit", "--quiet", "-m", "test: establish exact head");
  }
  const authority = await import(pathToFileURL(authorityPath).href) as ExecutionAuthority;
  return Object.freeze({ authority, authorityPath, buildRoot, canaryPath, root });
};

const resolveFixture = async (fixture: Awaited<ReturnType<typeof sourceFixture>>, overrides = {}) => {
  const sourceSha = await git(fixture.root, "rev-parse", "HEAD");
  return fixture.authority.resolveCanaryExecutionProvenance({
    buildRootUrl: pathToFileURL(fixture.buildRoot),
    canaryId: "codex-contained-turn-live-canary/v1",
    canarySourceUrl: pathToFileURL(fixture.canaryPath),
    claimedSourceSha: sourceSha,
    provider: "codex-app-server-current-kernel",
    ...overrides,
  });
};

after(async () => {
  await Promise.all(temporaryRoots.map(root => rm(root, { force: true, recursive: true })));
});

test("exact current provider candidates are absent from the qualification registry", async () => {
  const registry = JSON.parse(await readFile(new URL(
    "../../../../docs/architecture/qualification-registry.json", import.meta.url,
  ), "utf8")) as {entries: readonly unknown[]};
  const serialized = JSON.stringify(registry.entries);
  assert.doesNotMatch(serialized, /0\.150\.1/u);
  assert.doesNotMatch(serialized, /0\.3\.251/u);
  assert.doesNotMatch(serialized, /codex-app-server-current-kernel/u);
  assert.doesNotMatch(serialized, /claude-agent-sdk-current-kernel/u);
});

test("candidate evidence binds exact HEAD, dynamically loaded build, provider, and canary", async () => {
  const fixture = await sourceFixture();
  const executionProvenance = await resolveFixture(fixture);
  const executed = await import(pathToFileURL(join(fixture.buildRoot, "runtime.mjs")).href);
  assert.equal(executed.freshBuild, 1);
  const envelope = await fixture.authority.createProviderCandidateEvidenceEnvelope({
    binaryRevision: "@openai/codex:0.150.1+linux-x64",
    binarySha256: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
    canaryId: "codex-contained-turn-live-canary/v1",
    compositeContainment: "indeterminate",
    executionProvenance,
    observations: Object.freeze({
      networkRouteEnforcement: "qualified",
      outputDigest: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
      productionReady: true,
      providerRouteRef: "route:claimed-enforced-egress",
    }),
    packageIdentity: Object.freeze({
      nativeRevision: "@openai/codex-linux-x64@0.150.1",
      wrapperRevision: "@openai/codex@0.150.1",
    }),
    physicalContainment: "contained",
    platformTuple: Object.freeze({ architecture: "x64", platform: "linux" }),
    provider: "codex-app-server-current-kernel",
    status: "succeeded",
  });
  assert.equal(envelope.qualification, "implementation-evidence-only");
  assert.equal(envelope.networkRouteEnforcement, "unqualified");
  assert.match(envelope.buildIdentity.treeDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(envelope.canaryIdentity.tokenDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal("productionReady" in envelope, false);
  assert.equal("providerRouteRef" in envelope, false);

  await writeFile(join(fixture.buildRoot, "runtime.mjs"), "export const freshBuild = 2;\n");
  await assert.rejects(
    fixture.authority.createProviderCandidateEvidenceEnvelope({
      binaryRevision: "candidate",
      binarySha256: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
      canaryId: "codex-contained-turn-live-canary/v1",
      compositeContainment: "indeterminate", executionProvenance,
      observations: Object.freeze({}), packageIdentity: "candidate",
      physicalContainment: "indeterminate",
      platformTuple: Object.freeze({ architecture: "x64", platform: "linux" }),
      provider: "codex-app-server-current-kernel", status: "succeeded",
    }),
    /changed during execution/u,
  );
  const changedBuild = await resolveFixture(fixture);
  assert.notEqual(changedBuild.build.treeDigest, executionProvenance.build.treeDigest);
  assert.notEqual(changedBuild.tokenDigest, executionProvenance.tokenDigest);
});

test("evidence rejects a token replayed for another provider or canary", async () => {
  const fixture = await sourceFixture();
  const executionProvenance = await resolveFixture(fixture);
  const common = {
    binaryRevision: "candidate",
    binarySha256: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
    compositeContainment: "indeterminate", executionProvenance,
    observations: Object.freeze({}), packageIdentity: "candidate",
    physicalContainment: "indeterminate",
    platformTuple: Object.freeze({ architecture: "x64", platform: "linux" }),
    status: "failed",
  };
  await assert.rejects(fixture.authority.createProviderCandidateEvidenceEnvelope({
    ...common, canaryId: "other-canary/v1", provider: "codex-app-server-current-kernel",
  }), /does not match/u);
  await assert.rejects(fixture.authority.createProviderCandidateEvidenceEnvelope({
    ...common, canaryId: "codex-contained-turn-live-canary/v1", provider: "other-provider",
  }), /does not match/u);
  await assert.rejects(createProviderCandidateEvidenceEnvelope({
    ...common, canaryId: "codex-contained-turn-live-canary/v1", provider: "codex-app-server-current-kernel",
  }), /verified canary execution/u);
});

test("source authority rejects stale HEAD and dirty tracked or untracked checkout", async () => {
  const fixture = await sourceFixture();
  const parentSha = await git(fixture.root, "rev-parse", "HEAD^");
  await assert.rejects(resolveFixture(fixture, { claimedSourceSha: parentSha }), /does not match/u);
  const cleanCanary = await readFile(fixture.canaryPath);
  await writeFile(fixture.canaryPath, "export const dirty = true;\n");
  await assert.rejects(resolveFixture(fixture), /checkout is dirty/u);
  await writeFile(fixture.canaryPath, cleanCanary);
  const untracked = join(fixture.root, "untracked-source.ts");
  await writeFile(untracked, "export const dirty = true;\n");
  await assert.rejects(resolveFixture(fixture), /checkout is dirty/u);
  await rm(untracked);
});

test("source authority rejects absent Git, outside source, and symlinked build entries", async () => {
  const noGit = await sourceFixture(false);
  await assert.rejects(noGit.authority.resolveCanaryExecutionProvenance({
    buildRootUrl: pathToFileURL(noGit.buildRoot),
    canaryId: "codex-contained-turn-live-canary/v1",
    canarySourceUrl: pathToFileURL(noGit.canaryPath),
    claimedSourceSha: "0123456789abcdef0123456789abcdef01234567",
    provider: "codex-app-server-current-kernel",
  }), /provenance is unavailable/u);

  const fixture = await sourceFixture();
  const outsidePath = join(fixture.root, "..", "outside-canary.mjs");
  temporaryRoots.push(outsidePath);
  await writeFile(outsidePath, "export const outside = true;\n");
  await assert.rejects(resolveFixture(fixture, { canarySourceUrl: pathToFileURL(outsidePath) }),
    /absent from source commit/u);
  await symlink(fixture.canaryPath, join(fixture.buildRoot, "linked.js"));
  await assert.rejects(resolveFixture(fixture), /symbolic link/u);
});

test("native Darwin candidate evidence remains physically and compositely indeterminate", async () => {
  const fixture = await sourceFixture();
  const executionProvenance = await resolveFixture(fixture);
  const envelope = await fixture.authority.createProviderCandidateEvidenceEnvelope({
    binaryRevision: "@openai/codex:0.150.1+darwin-arm64",
    binarySha256: "a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b",
    canaryId: "codex-contained-turn-live-canary/v1",
    compositeContainment: "contained", executionProvenance,
    observations: Object.freeze({}), packageIdentity: "@openai/codex-darwin-arm64@0.150.1",
    physicalContainment: "contained",
    platformTuple: Object.freeze({ architecture: "arm64", platform: "darwin" }),
    provider: "codex-app-server-current-kernel", status: "succeeded",
  });
  assert.equal(envelope.physicalContainment, "indeterminate");
  assert.equal(envelope.compositeContainment, "indeterminate");
});

test("the provider route gate does not alter the exact seven composition ports", async () => {
  const composition = await readFile(new URL(
    "../src/composition/contained-turn-feature-composition.ts", import.meta.url,
  ), "utf8");
  const supplied = [...composition.matchAll(
    /^    (operationStore|security|providerAccess|workspace|artifacts|custody|provider)(?=:|,$)/gmu,
  )].map(match => match[1]);
  assert.deepEqual(supplied, [
    "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
  ]);
  const qualification = await readFile(new URL(
    "../src/composition/contained-turn-route-qualification.ts", import.meta.url,
  ), "utf8");
  for (const source of [composition, qualification]) {
    assert.doesNotMatch(source, /networkGateway|networkRoutePort/u);
  }
  const publicComposition = await readFile(new URL("../src/composition.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publicComposition,
    /composeCandidateHostCustodied|composeHostCustodiedContainedTurn|composeQualifiedHostCustodied/u);
});

test("the product entrypoint still refuses today, and refuses for a registry reason", async () => {
  // The gate is conditional, and this dependency set carries no authentic
  // route-enforcement capability, so the exact same construction refusal is
  // still the only product outcome for it.
  assert.throws(() => createHostCustodiedContainedTurn(Object.freeze({
    artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
    providerAccess: Object.freeze({}), routeEnforcement: Object.freeze({admission: Object.freeze({})}),
    security: Object.freeze({}), selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze({})}),
    workspace: Object.freeze({}),
  }) as never), (error: unknown) => error instanceof ProviderRouteEnforcementUnsupportedError &&
    error.reason === "route-enforcement-unqualified");
  const registry = JSON.parse(await readFile(new URL(
    "../../../../docs/architecture/qualification-registry.json", import.meta.url,
  ), "utf8")) as {entries: readonly {id: string; qualification: string;
    targets: readonly Readonly<Record<string, string>>[]}[]};
  // Promotion above `scoped` stays confined to the one enforced-network-route
  // target. Even for that target a registry row is only the second of the two
  // facts the gate requires, which is why the refusal above is unchanged.
  for (const promoted of registry.entries.filter(item => item.qualification !== "scoped")) {
    assert.equal(promoted.id, "docker-linux-codex-enforced-network-route");
    assert.equal(promoted.qualification, "implementation");
    assert.deepEqual(promoted.targets.map(target => target.provider), ["codex"]);
    assert.deepEqual(promoted.targets.map(target => target.platform), ["linux-x64"]);
  }
  const readiness = await readFile(new URL(
    "../../../../docs/architecture/readiness.md", import.meta.url,
  ), "utf8");
  assert.match(readiness, /route-enforcement-unqualified/u);
});

test("real canary route authority rejects caller-shaped grants before any provider construction", () => {
  let calls = 0;
  const caller = new Proxy({}, {get() {calls += 1; throw new Error("must never consult caller authority");}});
  assert.throws(() => Reflect.apply(requireContainedTurnLiveCanaryAuthorities, undefined, [caller]),
    (error: unknown) => error instanceof Error && error.message === "route-enforcement-unqualified");
  assert.equal(calls, 0);
});
