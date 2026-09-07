import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  PRODUCT_QUALIFICATION_REGISTRY, registryQualifiesRouteTarget,
} from "../dist/composition/contained-turn-route-qualification.js";

const target = Object.freeze({
  provider: "fixture-provider", providerAdapter: "fixture-adapter", binaryClosure: "fixture-closure",
  platform: "fixture-platform", credentialRoute: "fixture-credential-route",
  storageTopology: "fixture-storage", transportTopology: "fixture-transport", failureDomain: "fixture-domain",
});
const matchingPolicy = Object.freeze({
  default: "unqualified", dimensionRule: "exact-match-whole-target-tuple",
  entryValueRule: "each-target-is-one-complete-observed-scalar-tuple",
  wildcardsAllowed: false, promotionRule: "explicit-evidence-and-readiness-update",
});
const entry = (qualification: string, ...targets: readonly unknown[]) => ({
  id: "fixture-entry", qualification, targets,
  evidence: [{kind: "human-report", path: "docs/spikes/fixture.md", sha256: "a".repeat(64)}],
  readinessSections: ["Fixture"], limitations: ["Fixture registry."],
});
const withRegistry = async (
  registry: unknown, run: (url: URL) => void | Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "embedded-route-registry-"));
  try {
    const path = join(root, "qualification-registry.json");
    await writeFile(path, JSON.stringify(registry));
    await run(pathToFileURL(path));
  } finally {await rm(root, {recursive: true, force: true});}
};

test("the promoted exact tuple qualifies only at implementation or deployment", async () => {
  for (const [qualification, expected] of [["unqualified", false], ["scoped", false],
    ["implementation", true], ["deployment", true]] as const) {
    await withRegistry({matchingPolicy, entries: [entry(qualification, {...target})]}, url => {
      assert.equal(registryQualifiesRouteTarget(url, target), expected, qualification);
    });
  }
});

test("a tuple that differs in any single dimension is not the promoted target", async () => {
  for (const dimension of Object.keys(target)) {
    const drifted = {...target, [dimension]: "other"};
    await withRegistry({matchingPolicy, entries: [entry("implementation", drifted)]}, url => {
      assert.equal(registryQualifiesRouteTarget(url, target), false, dimension);
    });
  }
  const partial: Record<string, unknown> = {...target};
  delete partial.failureDomain;
  for (const candidate of [partial, {...target, extra: "dimension"}, null, "target", []]) {
    await withRegistry({matchingPolicy, entries: [entry("implementation", candidate)]}, url => {
      assert.equal(registryQualifiesRouteTarget(url, target), false, JSON.stringify(candidate));
    });
  }
});

test("a registry that relaxed its own matching policy or evidence qualifies nothing", async () => {
  for (const override of [{wildcardsAllowed: true}, {default: "scoped"},
    {dimensionRule: "nearest-match"}, {promotionRule: "self-service"},
    {entryValueRule: "partial-tuple"}]) {
    await withRegistry({matchingPolicy: {...matchingPolicy, ...override},
      entries: [entry("implementation", {...target})]}, url => {
      assert.equal(registryQualifiesRouteTarget(url, target), false, JSON.stringify(override));
    });
  }
  await withRegistry({entries: [entry("implementation", {...target})]}, url => {
    assert.equal(registryQualifiesRouteTarget(url, target), false);
  });
  await withRegistry({matchingPolicy, entries: [{...entry("implementation", {...target}), evidence: []}]}, url => {
    assert.equal(registryQualifiesRouteTarget(url, target), false);
  });
  await withRegistry({matchingPolicy, entries: "all"}, url => {
    assert.equal(registryQualifiesRouteTarget(url, target), false);
  });
});

test("an unreadable registry throws rather than qualifying the target", async () => {
  await withRegistry({matchingPolicy, entries: []}, url => {
    assert.throws(() => registryQualifiesRouteTarget(new URL("./absent.json", url), target));
  });
});

test("today's shipped registry promotes no enforced route target at all", async () => {
  const registry = JSON.parse(await (await import("node:fs/promises"))
    .readFile(PRODUCT_QUALIFICATION_REGISTRY, "utf8")) as {entries: readonly {qualification: string}[]};
  assert.equal(registry.entries.length > 0, true);
  assert.deepEqual([...new Set(registry.entries.map(item => item.qualification))], ["scoped"]);
});
