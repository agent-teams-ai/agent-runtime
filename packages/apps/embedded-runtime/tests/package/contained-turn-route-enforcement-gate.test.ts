import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { darwinRouteFixture } from "../support/external/agent-execution/features/contained-agent-turn/support/darwin-route-capability-fixture.ts";

import { bindDarwinCodexRouteEnforcement, createContainedTurnRouteEnforcement } from "@agent-teams/agent-execution/composition";
import {
  composeQualifiedHostCustodiedContainedTurn,
  createHostCustodiedContainedTurn,
  ProviderRouteEnforcementUnsupportedError,
} from "../../dist/composition/contained-turn-feature-composition.js";
import {
  PRODUCT_QUALIFICATION_REGISTRY, registryQualifiesRouteTarget,
} from "../../dist/composition/contained-turn-route-qualification.js";

type Target = Readonly<Record<string, string>>;

const capability = Object.freeze({
  cancel: Object.freeze({execute: async () => Object.freeze({status: "not_found" as const})}),
  observe: Object.freeze({execute: async () => Object.freeze({status: "not_found" as const})}),
  submit: Object.freeze({execute: async () => Object.freeze({status: "denied" as const})}),
});
const providerAccess = Object.freeze({
  dispatchConsumptionV1: Object.freeze({
    async consumeForDispatch() {return Object.freeze({kind: "indeterminate" as const});},
    async observeDispatchConsumption() {return Object.freeze({kind: "indeterminate" as const});},
    async settleDispatchConsumption() {return Object.freeze({kind: "indeterminate" as const});},
  }),
  resolve: Object.freeze({async execute() {throw new Error("unused Provider Access resolve");}}),
  revalidate: Object.freeze({async execute() {throw new Error("unused Provider Access revalidate");}}),
});
const selectedProvider = Object.freeze({kind: "codex" as const, owner: Object.freeze({})});
const dependencies = (routeEnforcement?: unknown) => Object.freeze({
  artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
  providerAccess, routeEnforcement, security: Object.freeze({}), selectedProvider,
  workspace: Object.freeze({}),
});
const harness = () => {
  const calls = {dispose: 0, feature: 0, owner: 0};
  const owner = Object.freeze({
    custody: Object.freeze({}), sealAdmission() {}, dispose() {calls.dispose += 1;}, provider: Object.freeze({}),
  });
  return {
    calls,
    factories: Object.freeze({
      claude: (() => {throw new Error("Claude owner must not be built here");}) as never,
      codex: (() => {calls.owner += 1; return owner;}) as never,
    }),
    featureFactory: ((input: object) => {
      calls.feature += 1;
      // The gate admits the operation; it never widens the exact seven ports.
      assert.deepEqual(Reflect.ownKeys(input).toSorted(),
        ["artifacts", "custody", "operationStore", "provider", "providerAccess", "security", "workspace"]);
      return capability;
    }) as never,
  };
};

/** The Linux exclusive route owner's pinned Codex tuple. Adapter and binary
 * revisions are bound to the promoted tuple by the capability factory. */
const bindingFor = (target: Target) => Object.freeze({
  tenantId: "tenant:gate", projectId: "project:gate", scopeDigest: "scope:gate", operationId: "operation:gate",
  attemptId: "attempt:gate", custodyId: "custody:gate", sourceRevision: "f80683e31aa329c4a1eb3347efa45eb93b452f32",
  binaryRevision: target.binaryClosure, hostBootId: "boot:gate", executionGenerationId: "generation:gate",
  adapterRevision: target.providerAdapter, capabilityManifestRevision: "manifest:gate",
  authorityVectorDigest: "authority:gate", providerAccountRef: "account:gate", accessRef: "access:gate",
  bindingRevision: 3, credentialBindingRef: "credential:gate", providerRouteRef: "route:gate",
  routeRevision: "revision:1", credentialBindingDigest: "pa-opaque-binding:gate", credentialGeneration: 7,
});
const pin = Object.freeze({path: "/usr/sbin/nft-that-does-not-exist", sha256: "a".repeat(64)});
const engine = Object.freeze({inspect: async () => {throw new Error("no route is opened by this gate");}});
const mintLinux = (target: Target) => createContainedTurnRouteEnforcement({
  binding: bindingFor(target) as never, engine: engine as never, nsenter: pin, nft: pin,
  qualificationTarget: target as never,
});

/** Keep the genuine issuer and its complete owner/Host together. No ambient
 * owner lookup or preparation substitute: the production binder checks these. */
const mint = (target: Target) => {
  if (target.platform === "darwin-arm64") {
    const fixture = darwinRouteFixture();
    assert.deepEqual(target, fixture.input.qualificationTarget);
    const route = fixture.mint();
    const {hostCustody, ...owner} = fixture.input.owner;
    return {route, dependencies: (candidate: unknown = route) => Object.freeze({
      ...dependencies(candidate), hostCustody,
      selectedProvider: Object.freeze({kind: "codex" as const, owner}),
    })};
  }
  const route = mintLinux(target);
  return {route, dependencies: (candidate: unknown = route) => dependencies(candidate)};
};

const readRegistry = async () => JSON.parse(await readFile(PRODUCT_QUALIFICATION_REGISTRY, "utf8")) as {
  readonly matchingPolicy: unknown;
  readonly entries: readonly {readonly qualification: string; readonly targets: readonly Target[]}[];
};
/** An existing registry entry supplies the dimension vocabulary; this suite
 * never adds a promotion the repository has not made. */
const shippedScopedTarget = async (): Promise<Target> => {
  const registry = await readRegistry();
  const entry = registry.entries.find(item => item.qualification === "scoped");
  assert.ok(entry !== undefined);
  return Object.freeze({...entry.targets[0]});
};
const hostTarget = async (): Promise<Target> => Object.freeze({
  ...(process.platform === "darwin" ? darwinRouteFixture().input.qualificationTarget : await shippedScopedTarget()), platform: `${process.platform}-${process.arch}`,
});

const withFixtureRegistry = async (
  qualification: string, target: Target, run: (url: URL) => void,
): Promise<void> => {
  const registry = await readRegistry();
  const root = await mkdtemp(join(tmpdir(), "embedded-route-gate-"));
  try {
    const path = join(root, "qualification-registry.json");
    await writeFile(path, JSON.stringify({
      matchingPolicy: registry.matchingPolicy,
      entries: [{
        id: "fixture-route-promotion", qualification, targets: [target],
        evidence: [{kind: "human-report", path: "docs/spikes/fixture.md", sha256: "a".repeat(64)}],
        readinessSections: ["Fixture"], limitations: ["Fixture registry, not a repository promotion."],
      }],
    }));
    run(pathToFileURL(path));
  } finally {await rm(root, {recursive: true, force: true});}
};

const assertRefused = (operation: () => unknown): void => {
  let published: unknown;
  assert.throws(() => {published = operation();}, error =>
    error instanceof ProviderRouteEnforcementUnsupportedError &&
    error.reason === "route-enforcement-unqualified" &&
    error.message === "route-enforcement-unqualified" && Object.isFrozen(error));
  assert.equal(published, undefined);
};

test("the product entrypoint refuses a dependency set that carries no route enforcement", () => {
  for (const absent of [undefined, null, {}, Object.freeze({admission: Object.freeze({})})]) {
    assertRefused(() => createHostCustodiedContainedTurn(dependencies(absent) as never));
  }
  assertRefused(() => createHostCustodiedContainedTurn(Object.freeze({
    artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
    providerAccess, security: Object.freeze({}), selectedProvider, workspace: Object.freeze({}),
  }) as never));
});

test("a structural twin or proxied capability is refused before any property is read", async () => {
  const probe = harness();
  const target = await hostTarget();
  const fixture = mint(target);
  const authentic = fixture.route;
  const admission = "admission" in authentic ? authentic.admission : authentic.postClaimPreparation;
  let reads = 0;
  const trap = {
    get() {reads += 1; throw new Error("gate consulted the candidate capability");},
    getOwnPropertyDescriptor() {reads += 1; throw new Error("gate inspected the candidate capability");},
    ownKeys() {reads += 1; throw new Error("gate enumerated the candidate capability");},
  };
  const impostors = [
    Object.freeze({admission}),
    Object.freeze({...authentic}),
    new Proxy(authentic, trap),
    new Proxy({admission: Object.freeze({})}, trap),
    admission,
  ];
  await withFixtureRegistry("implementation", target, url => {
    for (const impostor of impostors) {
      assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
        fixture.dependencies(impostor) as never, probe.factories, probe.featureFactory, url,
      ));
    }
  });
  assert.equal(reads, 0);
  assert.deepEqual(probe.calls, {dispose: 0, feature: 0, owner: 0});
});

test("an authentic capability outside the registry, or only scoped in it, is refused", async () => {
  const probe = harness();
  const target = await hostTarget();
  // The repository's own registry: this exact tuple is not in it at all.
  assert.equal(registryQualifiesRouteTarget(PRODUCT_QUALIFICATION_REGISTRY, target as never), false);
  assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
    mint(target).dependencies() as never, probe.factories, probe.featureFactory,
    PRODUCT_QUALIFICATION_REGISTRY,
  ));
  // The shipped tuple this one is derived from is present, and is only scoped.
  const shipped = await shippedScopedTarget();
  assert.equal(registryQualifiesRouteTarget(PRODUCT_QUALIFICATION_REGISTRY, shipped as never), false);
  for (const qualification of ["unqualified", "scoped"]) {
    await withFixtureRegistry(qualification, target, url => {
      assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
        mint(target).dependencies() as never, probe.factories, probe.featureFactory, url,
      ));
    });
  }
  assert.deepEqual(probe.calls, {dispose: 0, feature: 0, owner: 0});
});

test("a promotion for another platform does not qualify this Host", async () => {
  const probe = harness();
  const shipped = await shippedScopedTarget();
  assert.notEqual(shipped.platform, `${process.platform}-${process.arch}`);
  await withFixtureRegistry("implementation", shipped, url => {
    assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
      mint(shipped).dependencies() as never, probe.factories, probe.featureFactory, url,
    ));
  });
  assert.deepEqual(probe.calls, {dispose: 0, feature: 0, owner: 0});
});

test("only an authentic capability whose exact tuple is promoted admits the composition", async () => {
  const target = await hostTarget();
  await withFixtureRegistry("implementation", target, url => {
    const probe = harness();
    const product = composeQualifiedHostCustodiedContainedTurn(
      mint(target).dependencies() as never, probe.factories, probe.featureFactory, url,
    );
    assert.equal(product.feature, capability);
    assert.deepEqual(probe.calls, {dispose: 0, feature: 1, owner: 1});
    product.dispose();
    assert.equal(probe.calls.dispose, 1);
  });
  // The same promoted entry admits nothing once any single dimension drifts.
  for (const dimension of Object.keys(target)) {
    const drifted = Object.freeze({...target, [dimension]: `${target[dimension]}-drifted`});
    await withFixtureRegistry("implementation", drifted, url => {
      const probe = harness();
      assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
        mint(target).dependencies() as never, probe.factories, probe.featureFactory, url,
      ));
      assert.deepEqual(probe.calls, {dispose: 0, feature: 0, owner: 0});
    });
  }
});

test("deployment promotion also admits, and the registry is re-read on every attempt", async () => {
  const target = await hostTarget();
  await withFixtureRegistry("deployment", target, url => {
    const probe = harness();
    assert.equal(composeQualifiedHostCustodiedContainedTurn(
      mint(target).dependencies() as never, probe.factories, probe.featureFactory, url,
    ).feature, capability);
  });
  const probe = harness();
  const held = mint(target);
  // A capability that was admitted against a fixture registry is not admitted
  // against the repository's registry: no verdict is cached on the capability.
  assertRefused(() => composeQualifiedHostCustodiedContainedTurn(
    held.dependencies() as never, probe.factories, probe.featureFactory, PRODUCT_QUALIFICATION_REGISTRY,
  ));
});

// Explicit synthetic Darwin observation and fixture registry only; never Mac evidence.
test("Darwin nominal route binds the existing owner and seven ports; product registry still refuses", async t => {
  // Exercise the shared Darwin mint branch inertly even on Linux, before the
  // existing explicit composition observation below changes platform descriptors.
  const minted = mint(darwinRouteFixture().input.qualificationTarget);
  const retained = minted.dependencies();
  const bound = bindDarwinCodexRouteEnforcement(minted.route, {
    ...retained.selectedProvider.owner, hostCustody: retained.hostCustody,
  } as never);
  assert.equal(bound.hostCustody, retained.hostCustody);
  assert.equal(bound.postClaimPreparation, "postClaimPreparation" in minted.route ? minted.route.postClaimPreparation : undefined);
  assert.throws(() => bindDarwinCodexRouteEnforcement(minted.route, {
    ...retained.selectedProvider.owner, hostCustody: {},
  } as never), TypeError);
  const f = darwinRouteFixture(); const route = f.mint();
  const {hostCustody, ...owner} = f.input.owner;
  const deps = {...dependencies(route), hostCustody, selectedProvider: {kind: "codex", owner}};
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", {...platform, value: "darwin"});
  Object.defineProperty(process, "arch", {...arch, value: "arm64"});
  t.after(() => {Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch);});
  const probe = harness();
  assert.equal(registryQualifiesRouteTarget(PRODUCT_QUALIFICATION_REGISTRY, f.input.qualificationTarget), false);
  assertRefused(() => createHostCustodiedContainedTurn(deps as never));
  assertRefused(() => composeQualifiedHostCustodiedContainedTurn(deps as never, probe.factories, probe.featureFactory, PRODUCT_QUALIFICATION_REGISTRY));
  assert.equal(probe.calls.owner, 0);
  await withFixtureRegistry("implementation", f.input.qualificationTarget, url => {
    const factories = {...probe.factories, codex: ((options: typeof f.input.owner & {postClaimPreparation: unknown}) => {
      assert.equal(options.hostCustody, hostCustody);
      assert.equal(options.postClaimPreparation, route.postClaimPreparation);
      assert.deepEqual(options.platformTarget, {platform: "darwin", architecture: "arm64"});
      return probe.factories.codex(options);
    }) as never};
    const result = composeQualifiedHostCustodiedContainedTurn(deps as never, factories, probe.featureFactory, url);
    assert.equal(result.feature, capability); result.dispose();
    assert.deepEqual(probe.calls, {owner: 1, feature: 1, dispose: 1});
    for (const change of [{hostCustody: {}}, {selectedProvider: {kind: "codex", owner: {...owner, hostBootId: "other"}}},
      {selectedProvider: {kind: "codex", owner: {...owner, hostInstanceId: "other"}}},
      {selectedProvider: {kind: "codex", owner: {...owner, platformTarget: {platform: "linux", architecture: "x64"}}}},
      {selectedProvider: {kind: "codex", owner: {...owner, launchRecords: {resolve: async () => {}}}}},
      {selectedProvider: {kind: "codex", owner: {...owner, postClaimPreparation: {prepareClaimed: async () => ({kind: "prepared"})}}}},
      {selectedProvider: {kind: "codex", owner: {...owner, postClaimPreparation: {...route.postClaimPreparation}}}},
      {selectedProvider: {kind: "codex", owner: new Proxy(owner, {})}}]) {
      assert.throws(() => composeQualifiedHostCustodiedContainedTurn({...deps, ...change} as never, factories, probe.featureFactory, url), TypeError);
    }
    let reads = 0;
    const getter = () => {reads++; throw new Error("getter invoked");};
    for (const malformed of [{...deps, get hostCustody() {return getter();}},
      {...deps, selectedProvider: {kind: "codex", owner: {...owner, get postClaimPreparation() {return getter();}}}}]) {
      assert.throws(() => composeQualifiedHostCustodiedContainedTurn(malformed as never, factories, probe.featureFactory, url), TypeError);
    }
    assert.equal(reads, 0); assert.equal(probe.calls.owner, 1);
    assert.throws(() => composeQualifiedHostCustodiedContainedTurn({...deps, selectedProvider: {kind: "claude", owner}} as never,
      factories, probe.featureFactory, url), error => error instanceof ProviderRouteEnforcementUnsupportedError &&
        error.message === "route-enforcement-unqualified: claude-broker-seam-absent");
  });
  assert.equal(f.resolves(), 0); assert.equal(f.egress.observations.opens, 0);
});
