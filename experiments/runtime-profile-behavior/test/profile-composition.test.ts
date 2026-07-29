import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeProfile } from "../src/features/profile-composition/compose-profile.ts";
import type {
  ProfileCompositionInput,
  ResolvedProfileManifest,
} from "../src/features/profile-composition/model.ts";
import { ProfileCompositionError } from "../src/features/profile-composition/model.ts";

interface CompositionFixture {
  readonly input: ProfileCompositionInput;
  readonly expected: {
    readonly modelPreference: string;
    readonly temperatureState: string;
    readonly sharedMcpHash: string;
    readonly sharedMcpState: string;
    readonly removedPluginState: string;
    readonly hookState: string;
    readonly hookReasons: readonly string[];
  };
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "profile-composition-cases.json",
);

const readFixture = async (): Promise<CompositionFixture> =>
  JSON.parse(await readFile(fixturePath, "utf8")) as CompositionFixture;

const resource = (
  manifest: ResolvedProfileManifest,
  kind: string,
  id: string,
) => {
  const result = manifest.resources.find(
    (item) => item.kind === kind && item.id === id,
  );
  assert.ok(result, `missing ${kind}:${id}`);
  return result;
};

test("ordered generic bindings resolve overrides and tombstones", async () => {
  const fixture = await readFixture();
  const manifest = composeProfile(fixture.input);

  assert.equal(
    manifest.settings.find((item) => item.key === "model.preference")?.value,
    fixture.expected.modelPreference,
  );
  assert.equal(
    manifest.settings.find((item) => item.key === "temperature")?.state,
    fixture.expected.temperatureState,
  );
  const sharedMcp = resource(manifest, "mcp", "shared");
  assert.equal(sharedMcp.definitionHash, fixture.expected.sharedMcpHash);
  assert.equal(sharedMcp.activation.state, fixture.expected.sharedMcpState);
  assert.equal(
    resource(manifest, "plugin", "ambient-plugin").activation.state,
    fixture.expected.removedPluginState,
  );
});

test("profile requests cannot grant executable capabilities", async () => {
  const fixture = await readFixture();
  const hook = resource(composeProfile(fixture.input), "hook", "session-start");

  assert.equal(hook.activation.state, fixture.expected.hookState);
  assert.deepEqual(hook.activation.reasons, fixture.expected.hookReasons);
});

test("entry order is canonical but layer precedence is semantic", async () => {
  const fixture = await readFixture();
  const baseline = composeProfile(fixture.input);
  const reorderedEntries = composeProfile({
    ...fixture.input,
    layers: fixture.input.layers.map((layer) => ({
      ...layer,
      entries: [...layer.entries].reverse(),
    })),
  });
  const reversedLayers = composeProfile({
    ...fixture.input,
    layers: [...fixture.input.layers].reverse(),
  });

  assert.equal(reorderedEntries.revisionDigest, baseline.revisionDigest);
  assert.notEqual(reversedLayers.revisionDigest, baseline.revisionDigest);
  assert.notEqual(
    resource(reversedLayers, "mcp", "shared").definitionHash,
    resource(baseline, "mcp", "shared").definitionHash,
  );
});

test("capability set order is not part of semantic identity", async () => {
  const fixture = await readFixture();
  const baseline = composeProfile(fixture.input);
  const reorderedCapabilities = composeProfile({
    ...fixture.input,
    layers: fixture.input.layers.map((layer) => ({
      ...layer,
      entries: layer.entries.map((entry) =>
        entry.target === "resource" && entry.operation === "upsert"
          ? {
              ...entry,
              requiredCapabilities: [...entry.requiredCapabilities].reverse(),
            }
          : entry,
      ),
    })),
  });

  assert.equal(reorderedCapabilities.revisionDigest, baseline.revisionDigest);
});

test("ambiguous duplicate IDs inside one source fail closed", async () => {
  const fixture = await readFixture();
  const firstLayer = fixture.input.layers[0];
  assert.ok(firstLayer);
  const duplicate = {
    ...firstLayer,
    entries: [...firstLayer.entries, firstLayer.entries[0]].filter(
      (item): item is NonNullable<typeof item> => item !== undefined,
    ),
  };

  assert.throws(
    () =>
      composeProfile({
        ...fixture.input,
        layers: [duplicate, ...fixture.input.layers.slice(1)],
      }),
    (error: unknown) =>
      error instanceof ProfileCompositionError &&
      error.code === "DUPLICATE_ENTRY_IN_LAYER",
  );
});

test("security revisions and grants participate in manifest identity", async () => {
  const fixture = await readFixture();
  const baseline = composeProfile(fixture.input);
  const elevated = composeProfile({
    ...fixture.input,
    security: {
      ...fixture.input.security,
      capabilityGrantRevisionRef: "grant:elevated-v4",
      grantedCapabilities: [
        ...fixture.input.security.grantedCapabilities,
        "filesystem.write",
        "hook.execute",
      ],
      trustedExecutableKinds: [
        ...fixture.input.security.trustedExecutableKinds,
        "hook",
      ],
    },
  });

  assert.notEqual(elevated.revisionDigest, baseline.revisionDigest);
  assert.equal(
    resource(elevated, "hook", "session-start").activation.state,
    "active",
  );
});

test("runtime policy can deny a separately granted capability", async () => {
  const fixture = await readFixture();
  const policyDenied = composeProfile({
    ...fixture.input,
    security: {
      ...fixture.input.security,
      capabilityGrantRevisionRef: "grant:hook-v4",
      runtimePolicyRevisionRef: "policy:no-hooks-v6",
      grantedCapabilities: [
        ...fixture.input.security.grantedCapabilities,
        "filesystem.write",
        "hook.execute",
      ],
      policyAllowedCapabilities:
        fixture.input.security.policyAllowedCapabilities.filter(
          (capability) => capability !== "hook.execute",
        ),
      trustedExecutableKinds: [
        ...fixture.input.security.trustedExecutableKinds,
        "hook",
      ],
    },
  });

  assert.deepEqual(
    resource(policyDenied, "hook", "session-start").activation,
    { state: "blocked", reasons: ["runtime-policy-denied"] },
  );
});
