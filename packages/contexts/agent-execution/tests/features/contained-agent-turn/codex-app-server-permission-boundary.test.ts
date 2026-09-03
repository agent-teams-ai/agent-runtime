import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexEffectivePermissionProfile, codexUserPermissionProfile } from "./codex-permission-profile-fixture.ts";

import {
  CODEX_APP_SERVER_BINDINGS_SHA256,
  CODEX_APP_SERVER_BINARY_SHA256,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  canonicalCodexJson,
  createCodexAppServerPermissionBoundary,
  validateCodexConfigEvidence,
  validateCodexInitializeEvidence,
  validateCodexPermissionProfileEvidence,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { createCodexAppServerLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import { CODEX_APP_SERVER_LINUX_X64_TUPLE } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import {
  diagnoseCodexWorkspaceEndpoint,
  observeCodexWorkspaceEndpoint,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-path-identity.js";
import {
  CODEX_COMMAND_DECODER_AUTHORITY,
  CODEX_THREAD_ITEM_DECODER_AUTHORITY,
  CODEX_THREAD_ITEM_UNION_TYPES,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-thread-item.js";

type GeneratedCommandAuthority = Readonly<{
  actions: Readonly<Record<string, Readonly<{
    allowedKeys: readonly string[];
    decoderAllowsAdditionalProperties: false;
    nullableKeys: readonly string[];
    optionalKeys: readonly string[];
    requiredKeys: readonly string[];
    schemaAllowsAdditionalProperties: boolean;
  }>>>;
  item: Readonly<{
    allowedKeys: readonly string[];
    decoderAllowsAdditionalProperties: false;
    integerFormats: Readonly<Record<string, string>>;
    nullableKeys: readonly string[];
    optionalKeys: readonly string[];
    requiredKeys: readonly string[];
    schemaAllowsAdditionalProperties: boolean;
    statuses: readonly string[];
  }>;
  sources: readonly string[];
}>;

interface SchemaDefinition {
  readonly $ref?: string;
  readonly additionalProperties?: boolean;
  readonly allOf?: readonly SchemaDefinition[];
  readonly anyOf?: readonly SchemaDefinition[];
  readonly enum?: readonly string[];
  readonly format?: string;
  readonly oneOf?: readonly SchemaDefinition[];
  readonly properties?: Readonly<Record<string, SchemaDefinition>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly title?: string;
  readonly type?: string | readonly string[];
}

interface ItemCompletedSchema extends SchemaDefinition {
  readonly definitions: Readonly<Record<string, SchemaDefinition>>;
}

const resolveSchema = (schema: ItemCompletedSchema, definition: SchemaDefinition): SchemaDefinition => {
  if (definition.$ref !== undefined) {
    const match = /^#\/definitions\/([^/]+)$/u.exec(definition.$ref);
    assert.ok(match !== null);
    const resolved = schema.definitions[match[1]!];
    assert.ok(resolved !== undefined);
    return resolveSchema(schema, resolved);
  }
  if (definition.allOf?.length === 1) {return resolveSchema(schema, definition.allOf[0]!);}
  return definition;
};

const nullable = (schema: ItemCompletedSchema, definition: SchemaDefinition): boolean => {
  const resolved = resolveSchema(schema, definition);
  if (Array.isArray(resolved.type) && resolved.type.includes("null")) {return true;}
  return resolved.anyOf?.some(member => resolveSchema(schema, member).type === "null") ?? false;
};

const shapeAuthority = (schema: ItemCompletedSchema, definition: SchemaDefinition) => {
  assert.ok(definition.properties !== undefined && definition.required !== undefined);
  const allowedKeys = Object.keys(definition.properties);
  const requiredKeys = [...definition.required];
  const optionalKeys = allowedKeys.filter(key => !requiredKeys.includes(key));
  const nullableKeys = allowedKeys.filter(key => nullable(schema, definition.properties![key]!));
  return Object.freeze({ allowedKeys: Object.freeze(allowedKeys), decoderAllowsAdditionalProperties: false as const,
    nullableKeys: Object.freeze(nullableKeys), optionalKeys: Object.freeze(optionalKeys),
    requiredKeys: Object.freeze(requiredKeys), schemaAllowsAdditionalProperties: definition.additionalProperties ?? true });
};

const deriveThreadItemAuthority = (schema: ItemCompletedSchema) => {
  const threadItem = schema.definitions.ThreadItem;
  assert.ok(threadItem?.oneOf !== undefined);
  return Object.freeze(Object.fromEntries(threadItem.oneOf.map(definition => {
    assert.ok(definition.properties !== undefined && definition.required !== undefined);
    const type = definition.properties.type?.enum?.[0];
    assert.equal(typeof type, "string");
    const allowedKeys = Object.keys(definition.properties).toSorted();
    const requiredKeys = [...definition.required].toSorted();
    const optionalKeys = allowedKeys.filter(key => !requiredKeys.includes(key));
    const defaults = Object.fromEntries(optionalKeys.flatMap(key => Object.hasOwn(definition.properties![key]!, "default")
      ? [[key, definition.properties![key]!.default]] : []));
    return [type, Object.freeze({
      allowedKeys: Object.freeze(allowedKeys),
      decoderAllowsAdditionalProperties: false as const,
      defaults: Object.freeze(defaults),
      optionalKeys: Object.freeze(optionalKeys),
      requiredKeys: Object.freeze(requiredKeys),
      schemaAllowsAdditionalProperties: definition.additionalProperties ?? true,
    })];
  })));
};

const deriveGeneratedCommandAuthority = (schema: ItemCompletedSchema): GeneratedCommandAuthority => {
  const commandAction = schema.definitions.CommandAction;
  const threadItem = schema.definitions.ThreadItem;
  assert.ok(commandAction?.oneOf !== undefined && threadItem?.oneOf !== undefined);
  const commandExecution = threadItem.oneOf.find(definition => definition.title === "CommandExecutionThreadItem");
  assert.ok(commandExecution?.properties !== undefined);
  const actions = Object.fromEntries(commandAction.oneOf.map(definition => {
    const actionType = definition.properties.type?.enum?.[0];
    assert.equal(typeof actionType, "string");
    return [actionType, shapeAuthority(schema, definition)];
  }));
  const status = resolveSchema(schema, commandExecution.properties.status!);
  const source = resolveSchema(schema, commandExecution.properties.source!);
  const integerFormats = Object.fromEntries(["durationMs", "exitCode"].map(key => {
    const property = resolveSchema(schema, commandExecution.properties![key]!);
    assert.equal(typeof property.format, "string");
    return [key, property.format];
  }));
  return Object.freeze({
    actions: Object.freeze(actions),
    item: Object.freeze({ ...shapeAuthority(schema, commandExecution), integerFormats: Object.freeze(integerFormats),
      statuses: Object.freeze([...(status.enum ?? [])]) }),
    sources: Object.freeze([...(source.enum ?? [])]),
  });
};

const assertGeneratedCommandEquivalence = (
  generated: GeneratedCommandAuthority,
  production: GeneratedCommandAuthority,
): void => {assert.deepEqual(production, generated);};

test("validates private roots, disjointness, and stable filesystem identity", async () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-root-validation-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const privateRoot = `${workspace}-host-private`;
    const home = join(privateRoot, "home");
    const temp = join(privateRoot, "temp");
    mkdirSync(workspace, { mode: 0o755 });
    mkdirSync(home, { mode: 0o700, recursive: true });
    mkdirSync(temp, { mode: 0o700 });
    const exactBoundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    const plan = createCodexAppServerLaunchPlan({
      boundary: exactBoundary,
      executablePath: "/opt/codex",
      intentMode: "analysis",
      platformTarget: {architecture: "x64", platform: "linux"},
      privateRootPath: privateRoot,
      tmpDir: temp,
    });
    assert.deepEqual(plan.arguments.slice(0, 5), [
      "app-server", "--stdio", "--strict-config", "-c",
      `default_permissions=${JSON.stringify(exactBoundary.permissionProfileId)}`,
    ]);
    assert.deepEqual(plan.environment, {
      CODEX_HOME: home, HOME: home, LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: temp,
    });
    assert.equal(plan.effectivePolicyDigest, exactBoundary.effectivePolicyDigest);

    chmodSync(home, 0o755);
    assert.throws(() => createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace }), /0700/u);
    chmodSync(home, 0o700);
    chmodSync(workspace, 0o777);
    assert.throws(() => createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace }), /writable/u);
    chmodSync(workspace, 0o755);

    const file = join(caseRoot, "file");
    writeFileSync(file, "not-a-directory");
    assert.throws(() => createCodexAppServerPermissionBoundary({ codexHome: file, intentMode: "analysis", workspaceRef: workspace }), /directory/u);
    const link = join(caseRoot, "home-link");
    symlinkSync(home, link);
    assert.throws(() => createCodexAppServerPermissionBoundary({ codexHome: link, intentMode: "analysis", workspaceRef: workspace }), /symlink/u);
    assert.throws(() => createCodexAppServerPermissionBoundary({ codexHome: "/", intentMode: "analysis", workspaceRef: workspace }), /root/u);

    const nestedTemp = join(workspace, "temp");
    mkdirSync(nestedTemp, { mode: 0o700 });
    assert.throws(() => createCodexAppServerLaunchPlan({
      boundary: exactBoundary,
      executablePath: "/opt/codex",
      intentMode: "analysis",
      platformTarget: {architecture: "x64", platform: "linux"},
      privateRootPath: privateRoot,
      tmpDir: nestedTemp,
    }), /privateRootPath|disjoint/u);

  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("observes provider endpoints with exact workspace identity and portable Unicode semantics", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-path-identity-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const other = join(caseRoot, "other");
    const home = join(caseRoot, "home");
    mkdirSync(workspace);
    mkdirSync(other);
    mkdirSync(home, { mode: 0o700 });
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    assert.throws(() => observeCodexWorkspaceEndpoint("safe.txt", { ...boundary, workspaceRef: other }), /identity/u);
    assert.throws(() => observeCodexWorkspaceEndpoint("safe.txt", {
      ...boundary,
      workspaceIdentity: { ...boundary.workspaceIdentity, device: boundary.workspaceIdentity.device + 1 },
    }), /identity/u);

    writeFileSync(join(workspace, "ς.txt"), "exact");
    writeFileSync(join(workspace, "1.txt"), "exact");
    assert.throws(() => observeCodexWorkspaceEndpoint("σ.txt", boundary), /ambiguity/u);
    assert.throws(() => observeCodexWorkspaceEndpoint("①.txt", boundary), /ambiguity/u);
    assert.throws(() => observeCodexWorkspaceEndpoint("nested／escape", boundary), /ambiguous/u);
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("fails closed on permanent hardlink, type, and missing/new endpoint substitutions", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-endpoint-substitution-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const home = join(caseRoot, "home");
    mkdirSync(workspace);
    mkdirSync(home, { mode: 0o700 });
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });

    const hardlinked = join(workspace, "hardlinked.txt");
    writeFileSync(hardlinked, "bounded");
    linkSync(hardlinked, join(workspace, "hardlinked-alias.txt"));
    assert.throws(() => observeCodexWorkspaceEndpoint(hardlinked, boundary), /hardlink/u);

    const typed = join(workspace, "typed");
    mkdirSync(typed);
    const typeObservation = observeCodexWorkspaceEndpoint(typed, boundary).endpointObservation;
    rmSync(typed, { recursive: true });
    writeFileSync(typed, "replacement-file");
    assert.throws(() => diagnoseCodexWorkspaceEndpoint(typeObservation, boundary), /changed/u);

    const missing = join(workspace, "missing-then-new.txt");
    const missingObservation = observeCodexWorkspaceEndpoint(missing, boundary).endpointObservation;
    writeFileSync(missing, "new");
    assert.throws(() => diagnoseCodexWorkspaceEndpoint(missingObservation, boundary), /missing\/new/u);
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("types restored endpoint substitutions as non-authoritative Node observations", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-endpoint-observation-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const home = join(caseRoot, "home");
    const endpoint = join(workspace, "observed.txt");
    const displaced = `${endpoint}.displaced`;
    mkdirSync(workspace);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(endpoint, "original");
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    const observation = observeCodexWorkspaceEndpoint(endpoint, boundary).endpointObservation;
    renameSync(endpoint, displaced);
    writeFileSync(endpoint, "transient-substitute");
    rmSync(endpoint);
    renameSync(displaced, endpoint);
    diagnoseCodexWorkspaceEndpoint(observation, boundary);
    assert.equal(observation.authority, "provider-observation-only");
    assert.equal("custodyReceiptRef" in observation, false);
    assert.equal("terminalSuccess" in observation, false);
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("canonical Codex JSON rejects undefined and other non-JSON values", () => {
  const absent: { readonly value?: unknown } = {};
  assert.throws(() => canonicalCodexJson(absent.value), /undefined/u);
  assert.throws(() => canonicalCodexJson({ value: undefined }), /undefined/u);
  assert.throws(() => canonicalCodexJson(Number.NaN), /non-finite/u);
  assert.throws(() => canonicalCodexJson(1n), /bigint/u);
});

test("decodes initialize as exact own enumerable plain 0.150.1 data", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-initialize-shape-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const home = join(caseRoot, "home");
    mkdirSync(workspace);
    mkdirSync(home, { mode: 0o700 });
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    const exact = { codexHome: boundary.codexHome, platformFamily: "unix", platformOs: "linux",
      userAgent: "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)" };
    validateCodexInitializeEvidence(exact, boundary, CODEX_APP_SERVER_LINUX_X64_TUPLE);
    const inherited = Object.assign(Object.create({ substituted: true }) as Record<string, unknown>, exact);
    const hidden = { ...exact };
    Object.defineProperty(hidden, "substituted", { enumerable: false, value: true });
    const symbol = { ...exact, [Symbol("substituted")]: true };
    const accessor = { ...exact };
    Object.defineProperty(accessor, "userAgent", { enumerable: true, get: () => "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)" });
    for (const malformed of [{ ...exact, substituted: true }, inherited, hidden, symbol, accessor]) {
      assert.throws(() => validateCodexInitializeEvidence(
        malformed, boundary, CODEX_APP_SERVER_LINUX_X64_TUPLE,
      ), /initialization/u);
    }
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("rejects unknown keys throughout config and profile evidence shapes", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-evidence-shape-")));
  try {
    const workspace = join(caseRoot, "workspace");
    const home = join(caseRoot, "home");
    mkdirSync(workspace, { mode: 0o755 });
    mkdirSync(home, { mode: 0o700 });
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    const layerNames = {
      system: { file: "/etc/codex/config.toml", type: "system" },
      session: { type: "sessionFlags" },
      user: { file: `${home}/config.toml`, profile: null, type: "user" },
    };
    const exactConfig = {
      config: { default_permissions: boundary.permissionProfileId, permissions: {
        [boundary.permissionProfileId]: codexEffectivePermissionProfile(home),
      } },
      layers: [
        { config: {}, disabledReason: null, name: layerNames.system, version: "1" },
        { config: { permissions: { [boundary.permissionProfileId]: codexUserPermissionProfile(home) } },
          disabledReason: null, name: layerNames.user, version: "2" },
        { config: { default_permissions: boundary.permissionProfileId }, disabledReason: null,
          name: layerNames.session, version: "3" },
      ],
      origins: {
        default_permissions: { name: layerNames.session, version: "3" },
        permissions: { name: layerNames.user, version: "2" },
      },
    };
    validateCodexConfigEvidence(exactConfig, boundary);
    const effective = codexEffectivePermissionProfile(home);
    const user = codexUserPermissionProfile(home);
    const invalidEffective: unknown[] = [
      undefined, null, boundary.permissionProfile, user,
      { ...effective, substituted: true },
      { ...effective, description: "unqualified" },
      { ...effective, workspace_roots: [workspace] },
      { ...effective, filesystem: { ...effective.filesystem, glob_scan_max_depth: 10 } },
      { ...effective, filesystem: { glob_scan_max_depth: null, [workspace]: "deny" } },
      { ...effective, filesystem: { ...effective.filesystem, [home]: "read" } },
      { ...effective, network: { ...effective.network, enabled: true } },
      { ...effective, network: { ...effective.network, allow_local_binding: true } },
      { ...effective, network: { enabled: false } },
    ];
    for (const profile of invalidEffective) {
      assert.throws(() => validateCodexConfigEvidence({ ...exactConfig,
        config: { ...exactConfig.config, permissions: { [boundary.permissionProfileId]: profile } },
      }, boundary), /rejected/u);
    }
    const invalidUsers: unknown[] = [
      undefined, null, boundary.permissionProfile, effective,
      { ...user, substituted: true },
      { ...user, filesystem: { [workspace]: "deny" } },
      { ...user, filesystem: { [home]: "read" } },
      { ...user, network: { enabled: true } },
      { ...user, network: { enabled: false, domains: ["unqualified.invalid"] } },
    ];
    for (const profile of invalidUsers) {
      assert.throws(() => validateCodexConfigEvidence({ ...exactConfig,
        layers: exactConfig.layers.map(layer => layer.name.type === "user"
          ? { ...layer, config: { permissions: { [boundary.permissionProfileId]: profile } } } : layer),
      }, boundary), /rejected/u);
    }

    const firstLayer = exactConfig.layers[0]!;
    for (const malformed of [
      { ...exactConfig, extra: true },
      { ...exactConfig, layers: [{ ...firstLayer, extra: true }, ...exactConfig.layers.slice(1)] },
      { ...exactConfig, layers: [{ ...firstLayer, name: { ...firstLayer.name, extra: true } }, ...exactConfig.layers.slice(1)] },
      { ...exactConfig, origins: { ...exactConfig.origins,
        default_permissions: { ...exactConfig.origins.default_permissions, extra: true } } },
    ]) {assert.throws(() => validateCodexConfigEvidence(malformed, boundary), /rejected/u);}

    const exactProfiles = { data: [{ allowed: true, description: null, id: boundary.permissionProfileId }], nextCursor: null };
    validateCodexPermissionProfileEvidence(exactProfiles, boundary);
    for (const malformed of [
      { ...exactProfiles, extra: true },
      { ...exactProfiles, data: [...exactProfiles.data, { allowed: true, description: null, extra: true, id: "other" }] },
    ]) {assert.throws(() => validateCodexPermissionProfileEvidence(malformed, boundary), /rejected/u);}
  } finally {
    rmSync(caseRoot, { force: true, recursive: true });
  }
});

test("requires the exact empty system baseline and rejects packaged or mixed layers", () => {
  const caseRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-layer-baseline-")));
  try {
    const workspace = join(caseRoot, "workspace"); const home = join(caseRoot, "home");
    mkdirSync(workspace); mkdirSync(home, { mode: 0o700 });
    const boundary = createCodexAppServerPermissionBoundary({ codexHome: home, intentMode: "analysis", workspaceRef: workspace });
    const exact = {
      config: { default_permissions: boundary.permissionProfileId, permissions: {
        [boundary.permissionProfileId]: codexEffectivePermissionProfile(home),
      }},
      layers: [
        { config: {}, name: { file: "/etc/codex/config.toml", type: "system" }, version: "1" },
        { config: { permissions: { [boundary.permissionProfileId]: codexUserPermissionProfile(home) } }, disabledReason: null,
          name: { file: `${home}/config.toml`, profile: null, type: "user" }, version: "2" },
        { config: { default_permissions: boundary.permissionProfileId }, disabledReason: null,
          name: { type: "sessionFlags" }, version: "3" },
      ],
      origins: {
        default_permissions: { name: { type: "sessionFlags" }, version: "3" },
        permissions: { name: { file: `${home}/config.toml`, profile: null, type: "user" }, version: "2" },
      },
    };
    validateCodexConfigEvidence(exact, boundary);
    for (const layers of [
      exact.layers.map((layer, index) => index === 0 ? { config: {}, name: { file: "/opt/defaults.toml", type: "packagedDefaults" }, version: "1" } : layer),
      [...exact.layers, { config: {}, name: { file: "/opt/defaults.toml", type: "packagedDefaults" }, version: "4" }],
      exact.layers.map((layer, index) => index === 0 ? { config: { unsafe: true }, name: { file: "/etc/codex/config.toml", type: "system" }, version: "1" } : layer),
    ]) {
      assert.throws(() => validateCodexConfigEvidence({ ...exact, layers }, boundary), /rejected/u);
    }
  } finally { rmSync(caseRoot, { force: true, recursive: true }); }
});

test("binds exact response assumptions to the generated Codex 0.150.1 contract", () => {
  const fixtureUrl = new URL(
    "../../fixtures/linux-codex-app-server-0.150.1-permission-contract.json",
    import.meta.url,
  );
  const fixtureBytes = readFileSync(fixtureUrl);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
    readonly schemaVersion: number;
    readonly generatedTypeFragments: readonly {
      readonly fragment: string; readonly fragmentPurpose?: string;
      readonly source: string; readonly sourceSha256: string;
    }[];
    readonly limitations: { readonly permissionProfileBody: string };
    readonly provenance: {
      readonly binarySha256: string;
      readonly experimentalFlagUsed: boolean;
      readonly installedPackage: string;
      readonly nativeTarget: string;
      readonly schemaCommand: string;
      readonly schemaTreeFileCount: number;
      readonly schemaTreeManifestSha256: string;
      readonly treeManifestAlgorithm: string;
      readonly typesCommand: string;
      readonly typesTreeFileCount: number;
      readonly typesTreeManifestSha256: string;
    };
  };
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"),
    "85486350f4b585f4b460d970f94cf7132eb070ef8d2cc3d8d8cee7931d3f3351");
  assert.equal(fixture.schemaVersion, 2);
  assert.equal(fixture.provenance.installedPackage, "@openai/codex@0.150.1-linux-x64");
  assert.equal(fixture.provenance.nativeTarget, "x86_64-unknown-linux-musl");
  assert.equal(fixture.provenance.binarySha256, CODEX_APP_SERVER_BINARY_SHA256);
  assert.equal(fixture.provenance.experimentalFlagUsed, true);
  assert.equal(fixture.provenance.schemaCommand,
    "codex app-server generate-json-schema --out <disposable-root>/schema-experimental --experimental");
  assert.equal(fixture.provenance.typesCommand,
    "codex app-server generate-ts --out <disposable-root>/generated-experimental --experimental");
  assert.equal(fixture.provenance.schemaTreeFileCount, 411);
  assert.equal(fixture.provenance.typesTreeFileCount, 812);
  assert.equal(fixture.provenance.schemaTreeManifestSha256, CODEX_APP_SERVER_SCHEMA_SHA256);
  assert.equal(fixture.provenance.typesTreeManifestSha256, CODEX_APP_SERVER_BINDINGS_SHA256);
  assert.equal(fixture.provenance.treeManifestAlgorithm,
    "sha256 of the byte stream emitted by sha256sum over all regular files sorted by relative path without a leading ./");
  assert.deepEqual(fixture.generatedTypeFragments.map(({ fragment, source, sourceSha256 }) =>
    ({ fragment, source, sourceSha256 })), [
    { source: "v2/ActivePermissionProfile.ts",
      sourceSha256: "9d137fa5e3cdbd3392e9a6d373b45e50f2f2643662a735ac90c6f1103e0f97a7",
      fragment: "id: string,\n/**\n * Parent profile identifier from the selected permissions profile's\n * `extends` setting, when present.\n */\nextends: string | null, };" },
    { source: "v2/Config.ts",
      sourceSha256: "7130dcb6ffeff35935b9b65a3698c6fca97d814bdbc961e2bd367c62e0474c98",
      fragment: "} & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });" },
    { source: "v2/ConfigLayer.ts",
      sourceSha256: "24d1d2c7e0c774e0df55d767bb6d1874f92776daa96f2856f184a296de203161",
      fragment: "export type ConfigLayer = { name: ConfigLayerSource, version: string, config: JsonValue, disabledReason: string | null, };" },
    { source: "v2/ConfigLayerMetadata.ts",
      sourceSha256: "bc6dac6f3c9ac7fa7d7a40c15abc4114cfe230f4777cabf8e0e130d70b78a515",
      fragment: "export type ConfigLayerMetadata = { name: ConfigLayerSource, version: string, };" },
    { source: "v2/ThreadStartResponse.ts",
      sourceSha256: "056e252e32c78761d250c7688cb102752ce8b6f445e509ae87766ba5588a8924",
      fragment: "activePermissionProfile: ActivePermissionProfile | null," },
    { source: "v2/ThreadStartParams.ts",
      sourceSha256: "7a3fddbb0cf0585c52edbf19e3a1f6e691681f18ab509f7abfa416da7f0ac824",
      fragment: "permissions?: string | null," },
    { source: "v2/TurnStartParams.ts",
      sourceSha256: "b876212f33e15754db8242ce9367318c6ee3a96686216663a37869c40a8b3d7f",
      fragment: "permissions?: string | null," },
    { source: "InitializeResponse.ts",
      sourceSha256: "4feabcb66d4bf01869d2780beaec1838d41b30213cdf57de175298aed01f5379",
      fragment: "export type InitializeResponse = { userAgent: string," },
    { source: "v2/ConfigReadResponse.ts",
      sourceSha256: "9efa2d02c6ccb42cf509010727c9d27b4ac3783ac8b47e41f92eb6556848cb15",
      fragment: "export type ConfigReadResponse = { config: Config, origins: { [key in string]?: ConfigLayerMetadata }, layers: Array<ConfigLayer> | null, };" },
    { source: "v2/PermissionProfileListResponse.ts",
      sourceSha256: "5ff6a99f0a0cc3956de6e980ad45d50c48e5319a9d421f11a85c7c96d3d92644",
      fragment: "export type PermissionProfileListResponse = { data: Array<PermissionProfileSummary>," },
    { source: "v2/PermissionProfileSummary.ts",
      sourceSha256: "1202513133554ed4a96b916b5117ff2a0e5bbded9d326f44d39d622a418944c7",
      fragment: "allowed: boolean, };" },
    { source: "v2/TurnInterruptResponse.ts",
      sourceSha256: "3994cb114b2c4a2e81ba3a349c3a7d1f13ce1b165776b2162b52c9a114c24bc4",
      fragment: "export type TurnInterruptResponse = Record<string, never>;" },
    { source: "v2/TurnCompletedNotification.ts",
      sourceSha256: "1f56d73cb06876533fb224cd285634d3e090b21b647009be0e7c622937e40d3e",
      fragment: "export type TurnCompletedNotification = { threadId: string, turn: Turn, };" },
    { source: "v2/AgentMessageDeltaNotification.ts",
      sourceSha256: "bb538862f093bd22278bea3b3343037525a9218fbddef534e37e048347c10805",
      fragment: "export type AgentMessageDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, };" },
    { source: "v2/TurnStatus.ts",
      sourceSha256: "c69049363f97e97844e9fc851f0cd4122da057ba1371de003a28c00ab7a6ef1a",
      fragment: "export type TurnStatus = \"completed\" | \"interrupted\" | \"failed\" | \"inProgress\";" },
  ]);
  assert.match(fixture.limitations.permissionProfileBody, /no PermissionProfile body type/u);
  assert.match(fixture.limitations.permissionProfileBody, /Config's open JSON intersection/u);
  for (const fragment of fixture.generatedTypeFragments) {
    assert.match(fragment.sourceSha256, /^[a-f0-9]{64}$/u);
  }
  const authorityUrl = new URL("../../fixtures/protocol/codex-app-server-0.150.1/ItemCompletedNotification.json",
    import.meta.url);
  const authorityBytes = readFileSync(authorityUrl);
  assert.equal(authorityBytes.length, 41_664);
  assert.equal(createHash("sha256").update(authorityBytes).digest("hex"),
    "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370");
  const authorityManifest = JSON.parse(readFileSync(new URL(
    "../../fixtures/protocol/codex-app-server-0.150.1/manifest.json", import.meta.url), "utf8")) as {
    readonly artifactBytes: number; readonly artifactSha256: string; readonly binarySha256: string;
    readonly experimentalFlagUsed: boolean;
    readonly generatorCommands: readonly string[]; readonly npmSri: Readonly<Record<string, string>>;
    readonly regenerationVerifier: { readonly executionBinding: string; readonly executionEvidenceField: string;
      readonly externalProof: boolean; readonly runsInStaticTests: boolean };
    readonly generatedRuntimeBinding: { readonly artifact: string; readonly generator: string;
      readonly sha256: string; readonly sourceExecutionBinding: string };
    readonly schemaTreeFileCount: number; readonly schemaTreeManifestSha256: string;
    readonly schemaVersion: number; readonly sourceSha256: string; readonly tarballSha256: string;
    readonly treeManifestAlgorithm: string; readonly typesTreeFileCount: number;
    readonly typesTreeManifestSha256: string;
  };
  assert.deepEqual(authorityManifest, { ...authorityManifest,
    artifactBytes: 41_664,
    artifactSha256: "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370",
    binarySha256: "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386",
    sourceSha256: "0f1d661f014aac04c3fc9c04b8ebe818494a6d22fc16fe564390d0969a900370",
    tarballSha256: "35a87cf024345cf2d9350e5220401c8d3967ff6feee04055a89c73524927c0a6",
  });
  assert.equal(authorityManifest.schemaVersion, 3);
  assert.equal(authorityManifest.experimentalFlagUsed, true);
  assert.equal(authorityManifest.schemaTreeFileCount, 411);
  assert.equal(authorityManifest.typesTreeFileCount, 812);
  assert.equal(authorityManifest.schemaTreeManifestSha256, CODEX_APP_SERVER_SCHEMA_SHA256);
  assert.equal(authorityManifest.typesTreeManifestSha256, CODEX_APP_SERVER_BINDINGS_SHA256);
  assert.equal(authorityManifest.treeManifestAlgorithm, fixture.provenance.treeManifestAlgorithm);
  assert.deepEqual(authorityManifest.generatorCommands, [
    "codex app-server generate-json-schema --out <marked-disposable-root>/schema-experimental --experimental",
    "codex app-server generate-ts --out <marked-disposable-root>/generated-experimental --experimental",
  ]);
  assert.match(authorityManifest.npmSri.wrapper ?? "", /^sha512-/u);
  assert.match(authorityManifest.npmSri.native ?? "", /^sha512-/u);
  assert.deepEqual(authorityManifest.regenerationVerifier, {
    ...authorityManifest.regenerationVerifier,
    executionBinding: "retained-verified-descriptor",
    executionEvidenceField: "executedBinarySha256",
    externalProof: true,
    runsInStaticTests: false,
  });
  assert.deepEqual(authorityManifest.generatedRuntimeBinding, {
    artifact: "src/features/contained-agent-turn/adapters/outbound/codex-app-server/generated-codex-item-schema.ts",
    generator: "protocol/codex-app-server-0.150.1/generate-runtime-item-schema.mjs",
    sha256: "b9bdb38db25eb5d49368bd6b7850d4d23b51f908de6fb8cfb5e2f7cfb218f8ef",
    sourceExecutionBinding: "retained-open-descriptor",
  });
  const packageManifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  assert.equal(packageManifest.scripts["verify:codex-schema-regeneration"],
    "node tests/fixtures/protocol/codex-app-server-0.150.1/verify-regeneration.mjs");
  assert.equal(packageManifest.scripts["verify:codex-schema-runtime"],
    "node tests/fixtures/protocol/codex-app-server-0.150.1/generate-runtime-item-schema.mjs --check");
  const generatedRuntimeBinding = readFileSync(new URL(`../../../${authorityManifest.generatedRuntimeBinding.artifact}`,
    import.meta.url));
  assert.equal(createHash("sha256").update(generatedRuntimeBinding).digest("hex"),
    authorityManifest.generatedRuntimeBinding.sha256);
  const runtimeGeneratorSource = readFileSync(new URL(
    `../../fixtures/${authorityManifest.generatedRuntimeBinding.generator}`, import.meta.url), "utf8");
  assert.match(runtimeGeneratorSource, /EXPECTED_SOURCE_SHA256/u);
  assert.match(runtimeGeneratorSource, /--check/u);
  assert.match(runtimeGeneratorSource, /handle\.readFile/u);
  const verifierSource = readFileSync(new URL(
    "../../fixtures/protocol/codex-app-server-0.150.1/verify-regeneration.mjs", import.meta.url), "utf8");
  assert.match(verifierSource, /skipped-not-external-proof/u);
  assert.match(verifierSource, /assert\.deepEqual\(regenerated, committed/u);
  assert.match(verifierSource, /spawnSync\("\/proc\/self\/fd\/3"/u);
  assert.match(verifierSource, /generated, "--experimental"/u);
  assert.match(verifierSource, /stdio: \["ignore", "pipe", "pipe", binaryHandle\.fd\]/u);
  assert.match(verifierSource, /executedBinarySha256/u);
  assert.doesNotMatch(verifierSource, /spawnSync\(binary,/u);
  const completeSchema = JSON.parse(authorityBytes.toString("utf8")) as ItemCompletedSchema;
  assert.deepEqual(completeSchema.required, ["completedAtMs", "item", "threadId", "turnId"]);
  assert.equal(completeSchema.properties?.item?.$ref, "#/definitions/ThreadItem");
  const generated = deriveGeneratedCommandAuthority(completeSchema);
  const productionAuthority: GeneratedCommandAuthority = CODEX_COMMAND_DECODER_AUTHORITY;
  assertGeneratedCommandEquivalence(generated, productionAuthority);
  const search = productionAuthority.actions.search!;
  for (const mutant of [
    { ...productionAuthority, sources: productionAuthority.sources.slice(0, 3) },
    { ...productionAuthority, item: { ...productionAuthority.item,
      optionalKeys: productionAuthority.item.optionalKeys.slice(0, 6) } },
    { ...productionAuthority, actions: { ...productionAuthority.actions,
      search: { ...search, optionalKeys: search.optionalKeys.slice(0, 1) } } },
    { ...productionAuthority, actions: { ...productionAuthority.actions,
      search: { ...search, nullableKeys: search.nullableKeys.slice(0, 1) } } },
  ]) {assert.throws(() => assertGeneratedCommandEquivalence(generated, mutant));}
  const generatedThreadItems = deriveThreadItemAuthority(completeSchema);
  assert.equal(Object.keys(generatedThreadItems).length, 18);
  assert.deepEqual(Object.keys(generatedThreadItems).toSorted(), [...CODEX_THREAD_ITEM_UNION_TYPES].toSorted());
  assert.deepEqual(CODEX_THREAD_ITEM_DECODER_AUTHORITY, generatedThreadItems);
  const agentMessageAuthority = CODEX_THREAD_ITEM_DECODER_AUTHORITY.agentMessage;
  assert.deepEqual(agentMessageAuthority.optionalKeys, ["delivery", "memoryCitation", "phase"]);
  assert.deepEqual(agentMessageAuthority.defaults, { delivery: null, memoryCitation: null, phase: null });
});
