import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { darwinRouteFixture } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/darwin-route-capability-fixture.ts";

import { createContainedTurnRouteEnforcement } from "@agent-teams/agent-execution/composition";
import {
  CLAUDE_ROUTE_ENFORCEMENT_UNSUPPORTED_DETAIL,
  composeQualifiedHostCustodiedContainedTurn,
  createHostCustodiedContainedTurn,
  ProviderRouteEnforcementUnsupportedError,
} from "../dist/composition/contained-turn-feature-composition.js";
import {
  PRODUCT_QUALIFICATION_REGISTRY, registryQualifiesRouteTarget,
} from "../dist/composition/contained-turn-route-qualification.js";

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
const dependencies = (kind: "claude" | "codex", routeEnforcement?: unknown) => Object.freeze({
  artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
  providerAccess, routeEnforcement, security: Object.freeze({}),
  selectedProvider: Object.freeze({kind, owner: Object.freeze({})}), workspace: Object.freeze({}),
});
/** Neither provider owner may be constructed on a refused path. */
const harness = () => {
  const calls = {claude: 0, codex: 0, dispose: 0, feature: 0};
  const owner = Object.freeze({
    custody: Object.freeze({}), sealAdmission() {}, dispose() {calls.dispose += 1;}, provider: Object.freeze({}),
  });
  return {
    calls,
    factories: Object.freeze({
      claude: (() => {calls.claude += 1; return owner;}) as never,
      codex: (() => {calls.codex += 1; return owner;}) as never,
    }),
    featureFactory: ((): unknown => {calls.feature += 1; return capability;}) as never,
  };
};

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
const engine = Object.freeze({inspect: async () => {throw new Error("no route is opened by this suite");}});
const mint = (target: Target) => createContainedTurnRouteEnforcement({
  binding: bindingFor(target) as never, engine: engine as never, nsenter: pin, nft: pin,
  qualificationTarget: target as never,
});

const readRegistry = async () => JSON.parse(await readFile(PRODUCT_QUALIFICATION_REGISTRY, "utf8")) as {
  readonly matchingPolicy: unknown;
  readonly entries: readonly {readonly qualification: string; readonly targets: readonly Target[]}[];
};
/** An existing registry entry supplies the dimension vocabulary. */
const shippedScopedTarget = async (): Promise<Target> => {
  const registry = await readRegistry();
  const entry = registry.entries.find(item => item.qualification === "scoped");
  assert.ok(entry !== undefined);
  return Object.freeze({...entry.targets[0]});
};
const codexHostTarget = async (): Promise<Target> => Object.freeze({
  ...(process.platform === "darwin" ? darwinRouteFixture().input.qualificationTarget : await shippedScopedTarget()),
  platform: `${process.platform}-${process.arch}`,
});
/**
 * A Claude target the repository has not promoted and does not describe: its
 * adapter and closure tokens are openly synthetic, because no Claude enforced
 * route exists to name. It exists only to hold the gate's two facts true at
 * once for a Claude candidate, which is the case this suite is about.
 */
const hypotheticalClaudeTarget = async (): Promise<Target> => Object.freeze({
  ...await codexHostTarget(), provider: "claude",
  providerAdapter: "fixture-claude-adapter:hypothetical",
  binaryClosure: "fixture-claude-closure:hypothetical",
});

const withFixtureRegistry = async (
  qualification: string, target: Target, run: (url: URL) => void,
): Promise<void> => {
  const registry = await readRegistry();
  const root = await mkdtemp(join(tmpdir(), "embedded-claude-route-"));
  try {
    const path = join(root, "qualification-registry.json");
    await writeFile(path, JSON.stringify({
      matchingPolicy: registry.matchingPolicy,
      entries: [{
        id: "fixture-hypothetical-claude-promotion", qualification, targets: [target],
        evidence: [{kind: "human-report", path: "docs/spikes/fixture.md", sha256: "a".repeat(64)}],
        readinessSections: ["Fixture"], limitations: ["Fixture registry, not a repository promotion."],
      }],
    }));
    run(pathToFileURL(path));
  } finally {await rm(root, {recursive: true, force: true});}
};

const assertClaudeRefusal = (operation: () => unknown): void => {
  let published: unknown;
  assert.throws(() => {published = operation();}, error =>
    error instanceof ProviderRouteEnforcementUnsupportedError &&
    // The reason token stays exactly what readiness.md and the canaries pin.
    error.reason === "route-enforcement-unqualified" &&
    error.detail === CLAUDE_ROUTE_ENFORCEMENT_UNSUPPORTED_DETAIL &&
    error.message === "route-enforcement-unqualified: claude-broker-seam-absent" &&
    Object.isFrozen(error));
  assert.equal(published, undefined);
};

test("the Claude refusal is its own typed statement, distinguishable from the registry one", () => {
  assertClaudeRefusal(() => createHostCustodiedContainedTurn(dependencies("claude") as never));
  // The identical Codex dependency set is refused by the registry-level facts,
  // and carries no provider-level detail: the two refusals stay distinct.
  let published: unknown;
  assert.throws(() => {published = createHostCustodiedContainedTurn(dependencies("codex") as never);},
    error => error instanceof ProviderRouteEnforcementUnsupportedError &&
      error.reason === "route-enforcement-unqualified" && error.detail === undefined &&
      error.message === "route-enforcement-unqualified");
  assert.equal(published, undefined);
});

test("Claude stays refused even when both route-enforcement facts hold for it", async () => {
  const target = await hypotheticalClaudeTarget();
  // The repository promotes no Claude target, so the hypothesis needs a fixture.
  assert.equal(registryQualifiesRouteTarget(PRODUCT_QUALIFICATION_REGISTRY, target as never), false);
  await withFixtureRegistry("implementation", target, url => {
    const probe = harness();
    // Fact one: an authentic capability, minted by the route owner factory.
    const authentic = mint(target);
    // Fact two: a registry that promotes this exact whole tuple.
    assert.equal(registryQualifiesRouteTarget(url, target as never), true);
    assertClaudeRefusal(() => composeQualifiedHostCustodiedContainedTurn(
      dependencies("claude", authentic) as never, probe.factories, probe.featureFactory, url,
    ));
    assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
    // The same fixture registry admits the Codex path for its own host tuple,
    // so the refusal above is the provider check and not a broken fixture.
  });
  const codexTarget = await codexHostTarget();
  await withFixtureRegistry("implementation", codexTarget, url => {
    const probe = harness();
    const fixture = process.platform === "darwin" ? darwinRouteFixture() : undefined;
    const route = fixture?.mint() ?? mint(codexTarget);
    const routeDependencies = fixture === undefined ? dependencies("codex", route) : (() => {
      const {hostCustody, ...owner} = fixture.input.owner;
      return Object.freeze({
        ...dependencies("codex", route), hostCustody,
        selectedProvider: Object.freeze({kind: "codex" as const, owner}),
      });
    })();
    assert.equal(composeQualifiedHostCustodiedContainedTurn(
      routeDependencies as never, probe.factories, probe.featureFactory, url,
    ).feature, capability);
    assert.deepEqual(probe.calls, {claude: 0, codex: 1, dispose: 0, feature: 1});
  });
});

test("no capability or registry logic is consulted at all on the Claude path", async () => {
  let capabilityReads = 0;
  let registryReads = 0;
  const capabilityTrap = {
    get() {capabilityReads += 1; throw new Error("gate consulted the candidate capability");},
    getOwnPropertyDescriptor() {capabilityReads += 1; throw new Error("gate inspected the candidate capability");},
    ownKeys() {capabilityReads += 1; throw new Error("gate enumerated the candidate capability");},
  };
  const registryLocator = new Proxy({}, {
    get() {registryReads += 1; throw new Error("gate resolved the registry locator");},
    getOwnPropertyDescriptor() {registryReads += 1; throw new Error("gate inspected the registry locator");},
    ownKeys() {registryReads += 1; throw new Error("gate enumerated the registry locator");},
  });
  const probe = harness();
  const authenticClaude = mint(await hypotheticalClaudeTarget());
  for (const routeEnforcement of [undefined, new Proxy({admission: Object.freeze({})}, capabilityTrap),
    new Proxy(authenticClaude, capabilityTrap)]) {
    assertClaudeRefusal(() => composeQualifiedHostCustodiedContainedTurn(
      dependencies("claude", routeEnforcement) as never, probe.factories, probe.featureFactory,
      registryLocator as never,
    ));
  }
  assert.equal(capabilityReads, 0);
  assert.equal(registryReads, 0);
  assert.deepEqual(probe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});

  // The counter is not vacuous: the Codex path with an authentic capability
  // does reach the registry locator, and fails closed without a detail there.
  const codexProbe = harness();
  const authenticCodex = mint(await codexHostTarget());
  let published: unknown;
  assert.throws(() => {published = composeQualifiedHostCustodiedContainedTurn(
    dependencies("codex", authenticCodex) as never,
    codexProbe.factories, codexProbe.featureFactory, registryLocator as never,
  );}, error => error instanceof ProviderRouteEnforcementUnsupportedError && error.detail === undefined);
  assert.equal(published, undefined);
  assert.equal(registryReads > 0, true);
  assert.deepEqual(codexProbe.calls, {claude: 0, codex: 0, dispose: 0, feature: 0});
});

test("a dependency set the gate may not observe is left to the two facts, unread", () => {
  // A hostile Claude-shaped Proxy is refused without the provider check reading
  // it: naming the provider would require observing it, and the two facts below
  // already refuse it. The published refusal therefore carries no detail.
  for (const kind of ["claude", "codex"] as const) {
    let reads = 0;
    const input = new Proxy({selectedProvider: Object.freeze({kind, owner: Object.freeze({})})}, {
      get() {reads += 1; throw new Error("gate read candidate dependencies");},
      getOwnPropertyDescriptor() {reads += 1; throw new Error("gate inspected candidate dependencies");},
      ownKeys() {reads += 1; throw new Error("gate enumerated candidate dependencies");},
    });
    let published: unknown;
    assert.throws(() => {published = createHostCustodiedContainedTurn(input as never);}, error =>
      error instanceof ProviderRouteEnforcementUnsupportedError && error.detail === undefined &&
      error.reason === "route-enforcement-unqualified" &&
      error.message === "route-enforcement-unqualified" && Object.isFrozen(error));
    assert.equal(published, undefined);
    assert.equal(reads, 0);
  }
});
