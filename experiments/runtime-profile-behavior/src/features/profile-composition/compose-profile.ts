import { createHash } from "node:crypto";

import type {
  JsonValue,
  ProfileCompositionInput,
  ProfileEntry,
  ProfileLayer,
  ResolvedProfileManifest,
  ResolvedResource,
  ResourceActivationReason,
  ResourceEntry,
  ResourceKind,
  SettingEntry,
} from "./model.ts";
import { ProfileCompositionError } from "./model.ts";

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/;

const assertIdentifier = (value: string, field: string): void => {
  if (!IDENTIFIER.test(value)) {
    throw new ProfileCompositionError(
      "INVALID_IDENTIFIER",
      `${field} is not canonical: ${value}`,
    );
  }
};

const entryKey = (entry: ProfileEntry): string =>
  entry.target === "setting"
    ? `setting:${entry.key}`
    : `resource:${entry.kind}:${entry.id}`;

const validateLayer = (layer: ProfileLayer): void => {
  assertIdentifier(layer.bindingId, "bindingId");
  assertIdentifier(layer.sourceIdentity, "sourceIdentity");
  assertIdentifier(layer.revisionRef, "revisionRef");

  const seen = new Set<string>();
  for (const entry of layer.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) {
      throw new ProfileCompositionError(
        "DUPLICATE_ENTRY_IN_LAYER",
        `${layer.bindingId} contains an ambiguous ${key}`,
      );
    }
    seen.add(key);
    if (entry.target === "setting") {
      assertIdentifier(entry.key, "setting key");
    } else {
      assertIdentifier(entry.id, "resource id");
      if (entry.operation === "upsert") {
        assertIdentifier(entry.definitionHash, "definitionHash");
        for (const capability of entry.requiredCapabilities) {
          assertIdentifier(capability, "required capability");
        }
      }
    }
  }
};

const sortedUnique = <T extends string>(values: readonly T[]): readonly T[] =>
  [...new Set(values)].sort();

const activationFor = (
  entry: ResourceEntry,
  granted: ReadonlySet<string>,
  policyAllowed: ReadonlySet<string>,
  supported: ReadonlySet<string>,
  trustedKinds: ReadonlySet<ResourceKind>,
): ResolvedResource["activation"] => {
  if (entry.operation === "disable") {
    return { state: "disabled", reasons: [] };
  }
  if (entry.operation === "remove") {
    return { state: "removed", reasons: [] };
  }

  const reasons: ResourceActivationReason[] = [];
  if (entry.requiredCapabilities.some((item) => !granted.has(item))) {
    reasons.push("capability-not-granted");
  }
  if (entry.requiredCapabilities.some((item) => !policyAllowed.has(item))) {
    reasons.push("runtime-policy-denied");
  }
  if (entry.requiredCapabilities.some((item) => !supported.has(item))) {
    reasons.push("provider-unsupported");
  }
  if (entry.executable && !trustedKinds.has(entry.kind)) {
    reasons.push("workspace-untrusted");
  }
  return reasons.length === 0
    ? { state: "active", reasons }
    : { state: "blocked", reasons };
};

const stableValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const canonicalLayer = (layer: ProfileLayer): JsonValue => ({
  bindingId: layer.bindingId,
  sourceIdentity: layer.sourceIdentity,
  revisionRef: layer.revisionRef,
  entries: [...layer.entries]
    .sort((left, right) => entryKey(left).localeCompare(entryKey(right)))
    .map((entry) =>
      stableValue(
        (entry.target === "resource" && entry.operation === "upsert"
          ? {
              ...entry,
              requiredCapabilities: sortedUnique(entry.requiredCapabilities),
            }
          : entry) as unknown as JsonValue,
      ),
    ),
});

const digest = (value: JsonValue): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;

export const composeProfile = (
  input: ProfileCompositionInput,
): ResolvedProfileManifest => {
  const bindingIds = new Set<string>();
  for (const layer of input.layers) {
    if (bindingIds.has(layer.bindingId)) {
      throw new ProfileCompositionError(
        "DUPLICATE_BINDING_ID",
        `duplicate bindingId: ${layer.bindingId}`,
      );
    }
    bindingIds.add(layer.bindingId);
    validateLayer(layer);
  }

  const settings = new Map<string, SettingEntry & { bindingId: string }>();
  const resources = new Map<string, ResourceEntry & { bindingId: string }>();
  for (const layer of input.layers) {
    for (const entry of layer.entries) {
      if (entry.target === "setting") {
        settings.set(entry.key, { ...entry, bindingId: layer.bindingId });
      } else {
        resources.set(`${entry.kind}:${entry.id}`, {
          ...entry,
          bindingId: layer.bindingId,
        });
      }
    }
  }

  const granted = new Set(input.security.grantedCapabilities);
  const policyAllowed = new Set(input.security.policyAllowedCapabilities);
  const supported = new Set(input.security.providerSupportedCapabilities);
  const trustedKinds = new Set(input.security.trustedExecutableKinds);

  const resolvedSettings = [...settings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      entry.operation === "set"
        ? {
            key,
            state: "set" as const,
            winningBindingId: entry.bindingId,
            value: stableValue(entry.value),
          }
        : {
            key,
            state: "provider-default" as const,
            winningBindingId: entry.bindingId,
          },
    );

  const resolvedResources = [...resources.values()]
    .sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
    )
    .map((entry): ResolvedResource => {
      const common = {
        kind: entry.kind,
        id: entry.id,
        winningBindingId: entry.bindingId,
        winningOperation: entry.operation,
        activation: activationFor(
          entry,
          granted,
          policyAllowed,
          supported,
          trustedKinds,
        ),
      };
      return entry.operation === "upsert"
        ? {
            ...common,
            definitionHash: entry.definitionHash,
            executable: entry.executable,
            requiredCapabilities: sortedUnique(entry.requiredCapabilities),
          }
        : common;
    });

  const orderedLayers = input.layers.map((layer) => ({
    bindingId: layer.bindingId,
    sourceIdentity: layer.sourceIdentity,
    revisionRef: layer.revisionRef,
  }));
  const securityRevisions = {
    capabilityGrantRevisionRef: input.security.capabilityGrantRevisionRef,
    runtimePolicyRevisionRef: input.security.runtimePolicyRevisionRef,
    workspaceTrustRevisionRef: input.security.workspaceTrustRevisionRef,
    binaryRevisionRef: input.security.binaryRevisionRef,
  };
  const identity = {
    compositionVersion: input.compositionVersion,
    layers: input.layers.map(canonicalLayer),
    security: {
      ...securityRevisions,
      grantedCapabilities: sortedUnique(input.security.grantedCapabilities),
      policyAllowedCapabilities: sortedUnique(
        input.security.policyAllowedCapabilities,
      ),
      providerSupportedCapabilities: sortedUnique(
        input.security.providerSupportedCapabilities,
      ),
      trustedExecutableKinds: sortedUnique(
        input.security.trustedExecutableKinds,
      ),
    },
    settings: resolvedSettings,
    resources: resolvedResources,
  } as const;

  return {
    compositionVersion: 1,
    orderedLayers,
    securityRevisions,
    settings: resolvedSettings,
    resources: resolvedResources,
    revisionDigest: digest(identity as unknown as JsonValue),
  };
};
