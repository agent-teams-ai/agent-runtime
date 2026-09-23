import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const protocolHeaderPath = "dist/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h";
const protocolModulePath = "dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.js";
const BASE_COMPOSITION_RUNTIME_EXPORTS = [
  "CGROUP2_SUPER_MAGIC", "CODEX_APP_SERVER_ADAPTER_REVISION", "CODEX_APP_SERVER_BINARY_REVISION",
  "CODEX_APP_SERVER_BINARY_SHA256", "CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT",
  "CODEX_APP_SERVER_CURRENT_KERNEL_MANIFEST", "CODEX_APP_SERVER_DARWIN_ARM64_TUPLE",
  "CODEX_CAPABILITY_MANIFEST_REVISION", "CODEX_LOCAL_BROKER_CAPABILITY_ENV", "CONTAINED_TURN_DEPENDENCY_NAMES",
  "CONTAINED_TURN_POSTGRES_MIGRATIONS", "CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST",
  "CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE", "CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS",
  "CONTAINED_TURN_POSTGRES_SCHEMA_VERSION", "CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS",
  "CONTAINED_TURN_PREPARATION_CLOSURE_LIMIT", "CONTAINED_TURN_REQUIRED_PROOF_KINDS",
  "CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS", "CodexAppServerContainedTurnProvider",
  "ContainedTurnKernelCustodyAdapter", "DOCKER_CUSTODY_BOOTSTRAP_PATH", "DOCKER_CUSTODY_INIT_ARGUMENTS",
  "DOCKER_CUSTODY_INIT_PROTOCOL", "DOCKER_CUSTODY_NODE_PATH", "DarwinCooperativeProcessCustody",
  "DockerConsumptionObservations", "DockerCustodyFrameDecoder", "DockerCustodyJournal",
  "DockerCustodyJournalConflictError", "DockerEngineError", "DockerHostCustodyLifecycle",
  "DockerHttpNetworkResources", "DockerOperationNetwork", "HTTP_EVIDENCE_FENCE", "HostHttpEgressV4Journal",
  "HostHttpEgressV4NodeStorage", "NodeDockerCustodyJournalStorage", "NodeHttpEgressBoundaryIds",
  "NodeHttpEgressTrustedResolver", "NodeProviderProcessCustody", "NodeProviderProcessCustodyCore",
  "NodeTlsHttpEgressError", "NodeTlsHttpEgressTransport", "NodeUnixSocketDockerEngine", "ORDINARY_PROFILE",
  "PROC_SUPER_MAGIC", "PostgresContainedTurnOperationStore", "PostgresHttpEgressEvidence",
  "PostgresOrdinaryOperationStore", "acceptedProviderPreparation", "appendContainedTurnOutputForOwnerStore",
  "applyContainedTurnPostgresSchema", "applyOrdinaryPostgresSchema", "asContainedTurnCommandFingerprint",
  "assertNetworkContainer", "assertNetworkEngine", "bindContainedTurnPreparationGrantRequests",
  "bindContainedTurnRouteEnforcement", "bindDarwinCodexRouteEnforcement", "captureRootDarwinAttemptWorkspace",
  "claimContainedTurnDispatchPreparation", "codexTurnSandboxPolicy", "committedDispatchProofV1",
  "composeLinuxDockerResidueCustody", "computeContainedTurnArtifactTreeDigest",
  "containedTurnAcceptanceConstraintsDigestV1", "containedTurnAcceptanceIntentDigestV1",
  "containedTurnAuthorityVectorDigest", "containedTurnCommandFingerprint", "containedTurnDispatchClaimBindingDigest",
  "containedTurnIdentity", "containedTurnOperationCutoffRevision", "containedTurnPreparationClosureBinding",
  "containedTurnPreparationToken", "containedTurnPreventionDigest", "containedTurnProviderAccessSnapshotDigest",
  "containedTurnSatisfactionDigest", "containedTurnScopeDigest", "createClaudeCurrentKernelOwner",
  "createCodexAppServerPermissionBoundary", "createCodexCurrentKernelOwner", "createCodexNativeBrokerFileInstaller",
  "createCodexNativeBrokerRecipe", "createContainedTurnEngine", "createContainedTurnFeature",
  "createContainedTurnOperation", "createContainedTurnOperationProviderAccessPort", "createContainedTurnProviderAccessPort",
  "createContainedTurnRouteEnforcement", "createContainedTurnRuntimeSecurityPort",
  "createContainedTurnSecurityAcceptancePort", "createDarwinCodexEffectCustodyOwner",
  "createDarwinCodexHostPostClaimPreparation", "createDarwinCodexRouteEnforcement",
  "createDeferredCodexNativeBrokerFiles", "createDockerCodexHostKernelOwner",
  "createDockerCodexNativeBrokerFinalizer", "createDockerImageInitOwner", "createDockerLinuxExclusiveRouteAdmission",
  "createDockerLinuxPostClaimPreparation", "createDockerOperationNetworkOwner", "createHostHttpAdmissionGuard",
  "createHostHttpEgressSession", "createNativeHttpEgressRoute", "createNodeContainedTurnArtifacts",
  "createNodeContainedTurnWorkspace", "createNodeContainedTurnWorkspaceOwner", "createNodeDockerDeploymentRecipe",
  "createNodeExecutableFileObserver", "createNodeHostHttpConnection", "createNodeHostHttpListener",
  "createNodeOrdinaryArtifacts", "createNodeOrdinaryProcess", "createNodeOrdinaryWorkspace",
  "createOrdinaryCodexAdapter", "createOrdinaryTurnFeature", "createPreparedHttpRequestV1",
  "createRuntimeInstallationDiscoveryFeature", "createSpecificationSha256", "createStrictHttpEgressBroker",
  "createWorkspaceCapabilityRetention", "decodeCodexResponseEnvelope", "decodeContainedTurnArtifactManifest",
  "decodeEngineIdentity", "decodeInspection", "decodeOperationNetwork", "digestContainedTurnCanonicalValue",
  "dockerCustodyOwnerIdentitySha256", "dockerHttpOperationNetworkRecipe", "encodeContainedTurnArtifactManifest",
  "encodeCreateRequest", "encodeDockerCustodyFrame", "hostHttpAbortOperations", "initialHttpEgressState",
  "initializePostgresHttpEgressEvidence", "inspectDarwinRouteRequestInventory", "installLinuxExclusiveRoute",
  "isConcreteLinuxDockerLifecycle", "linuxExclusiveRouteSeccomp", "materializationAuthorizationRequest",
  "mutateContainedTurnOperation", "nativeHttpRequestProfile", "networkBinding", "networkDigest",
  "operationNetworkLabels", "operationNetworkName", "parseResultPublicationRecord", "parseWorkspaceSealRecord",
  "prepareCodexNativeBrokerFiles", "prepareDarwinCodexNativeLaunchInput", "projectPreparedRequest",
  "readContainedTurnRouteEnforcementTarget", "readContainedTurnSelectedRouteAdmission",
  "readNodeContainedTurnNativeWorkspaceClosure", "readNodeContainedTurnNativeWorkspaceReceipts",
  "readNodeOrdinaryArtifact", "recordContainedTurnPreparationCleanup", "recoverContainedTurnCommittedGrantSettlements",
  "recoverContainedTurnDispatchPreparations", "renderCodexNativeBrokerConfig", "residueLeaf", "residueParent",
  "retireContainedTurnDispatchPreparation", "rollbackContainedTurnPostgresSchemaV4", "snapshotDockerEnginePolicy",
  "snapshotDockerImageInitLock", "v4Decode", "v4Hash", "v4Replay", "validateContainedTurnConsumedGrantReceipts",
  "validateContainedTurnOperation",
] as const;

const run = (command: string, args: readonly string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: join(packageRoot, ".cache", "npm-cache"),
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

const runFailure = (command: string, args: readonly string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: join(packageRoot, ".cache", "npm-cache"),
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly succeeded`);
  return `${result.stdout}\n${result.stderr}`;
};

test("qualifies the two packed curated package assembly entrypoints", async () => {
  const temporaryParent = join(packageRoot, ".cache");
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(temporaryParent, "assembly-pack-"));
  try {
    const packOutput = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, "."],
      packageRoot,
    );
    const packResult = JSON.parse(packOutput) as readonly [{
      readonly filename: string;
      readonly files: readonly { readonly path: string }[];
    }];
    assert.equal(packResult.length, 1);
    const packedPaths = packResult[0]?.files.map(file => file.path) ?? [];
    assert.ok(packedPaths.includes("dist/index.js"));
    assert.ok(packedPaths.includes("dist/index.d.ts"));
    assert.ok(packedPaths.includes("dist/composition.js"));
    assert.ok(packedPaths.includes("dist/composition.d.ts"));
    assert.ok(packedPaths.includes(protocolHeaderPath));
    assert.equal(packedPaths.some(path => /^dist\/(?:production|testing)(?:\.|\/)/u.test(path)), false);
    assert.equal(packedPaths.some(path => /(?:^|[-./_])test-support|-fixtures?\.|\.(?:test|spec)\./u.test(path)), false);
    assert.equal(packedPaths.some(path => /(?:^|\/)tests?\//u.test(path)), false);
    assert.equal(packedPaths.some(path => /fake-docker-(?:engine|engine-state|attach-custody)(?:\.|\/)/u.test(path)), false,
      "Docker fault injection must not ship in any production artifact");
    const archive = join(temporaryRoot, packResult[0]?.filename ?? "missing.tgz");
    run("tar", ["-xzf", archive, "-C", temporaryRoot], packageRoot);

    const installedPackage = join(
      temporaryRoot,
      "consumer",
      "node_modules",
      "@agent-teams",
      "agent-execution",
    );
    await mkdir(dirname(installedPackage), { recursive: true });
    await rename(join(temporaryRoot, "package"), installedPackage);

    const packedManifest = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    ) as {
      readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
    };
    assert.deepEqual(packedManifest.exports["."], {
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    assert.deepEqual(packedManifest.exports["./composition"], {
      import: "./dist/composition.js",
      types: "./dist/composition.d.ts",
    });
    const extraExports = Object.keys(packedManifest.exports).filter(
      key => key !== "." && key !== "./composition",
    );
    assert.equal(
      extraExports.some(key => key.startsWith("./production") || key.startsWith("./testing")),
      false,
    );
    for (const key of extraExports) {
      assert.ok(
        key.startsWith("./dist/") || key.startsWith("./tests/") || key.startsWith("./scripts/"),
        key,
      );
    }
    for (const entrypoint of ["index", "composition"]) {
      await access(join(installedPackage, `dist/${entrypoint}.js`));
      await access(join(installedPackage, `dist/${entrypoint}.d.ts`));
    }
    assert.deepEqual(
      await readFile(join(installedPackage, protocolHeaderPath)),
      await readFile(join(packageRoot, "src/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h")),
    );
    const protocolInspectionPath = join(installedPackage, "inspect-protocol.mjs");
    await writeFile(protocolInspectionPath, [
      `import { darwinAttemptOwnerFrameBytes } from "./${protocolModulePath}";`,
      "process.stdout.write(String(darwinAttemptOwnerFrameBytes));",
    ].join("\n"));
    assert.ok(Number(run(process.execPath, [protocolInspectionPath], installedPackage)) > 0);

    const consumerPath = join(temporaryRoot, "consumer", "consume.mjs");
    await writeFile(consumerPath, [
      'import assert from "node:assert/strict";',
      'import * as contracts from "@agent-teams/agent-execution";',
      'import * as composition from "@agent-teams/agent-execution/composition";',
      'assert.throws(() => composition.readNodeContainedTurnNativeWorkspaceClosure({}, {}), /not issued/u);',
      'const privateValidationTables = ["DARWIN_ATTEMPT_OWNER_COMMAND_NAMES", "DARWIN_ATTEMPT_OWNER_EVENT_NAMES", "DOCKER_HTTP_LISTENER_ATTEMPT_KEYS", "DOCKER_HTTP_NETWORK_IDENTITY_KEYS", "DOCKER_OPERATION_NETWORK_BINDING_KEYS"];',
      'for (const name of privateValidationTables) {',
      '  assert.equal(Object.hasOwn(composition, name), false, `${name} must stay private`);',
      '  try { composition[name].length = 0; } catch {}',
      '}',
      'assert.throws(() => composition.networkBinding({}), error => error?.code === "invalid-authority");',
      "const rejected = [];",
      'for (const subpath of ["production", "testing"]) {',
      "  try { await import(`@agent-teams/agent-execution/${subpath}`); }",
      "  catch (error) { rejected.push(error?.code); }",
      "}",
      "process.stdout.write(JSON.stringify({ compositionKeys: Object.keys(composition).sort(), contractKeys: Object.keys(contracts), rejected }));",
    ].join("\n"));
    const consumerOutput = run(process.execPath, [consumerPath], dirname(consumerPath));
    const resolved = JSON.parse(consumerOutput) as {
      readonly compositionKeys: readonly string[];
      readonly contractKeys: readonly string[];
      readonly rejected: readonly string[];
    };
    // The immutable base census is an independent compatibility oracle. Local
    // parity alone cannot detect a named export removed from both fresh builds.
    assert.deepEqual(resolved.compositionKeys, BASE_COMPOSITION_RUNTIME_EXPORTS);
    const localComposition = await import("../../dist/composition.js");
    assert.deepEqual(resolved.compositionKeys, Object.keys(localComposition).toSorted());
    assert.equal(resolved.compositionKeys.includes("FakeDockerEngine"), false,
      "local/packed export parity cannot authorize a test-only public capability");
    assert.deepEqual(resolved.contractKeys, []);
    assert.deepEqual(resolved.rejected, ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);

    const compiler = fileURLToPath(new URL("../../../../../node_modules/.bin/tsc", import.meta.url));
    const typeProject = join(temporaryRoot, "consumer", "tsconfig.json");
    const positiveConsumer = join(temporaryRoot, "consumer", "positive-consumer.ts");
    await writeFile(positiveConsumer, [
      'import { CODEX_APP_SERVER_DARWIN_ARM64_TUPLE as tuple, createNodeExecutableFileObserver, createRuntimeInstallationDiscoveryFeature } from "@agent-teams/agent-execution/composition";',
      'import type { ContainedTurnKernelDependencies, ExecutableFileObservationRequest, ExecutableFileObserver, HttpEgressBrokerPorts, OrdinaryInput, RuntimeInstallationDiscoveryDependencies } from "@agent-teams/agent-execution/composition";',
      "const observer: ExecutableFileObserver = createNodeExecutableFileObserver();",
      "const identityObserver: ExecutableFileObserver = createNodeExecutableFileObserver({ effectiveIdentity: { uid: 1000, gid: 1000, groups: [1000] } });",
      "const suppliedIdentityObserver: ExecutableFileObserver = createNodeExecutableFileObserver({ effectiveIdentitySupplier: () => ({ uid: 1000, gid: 1000, groups: [1000] }) });",
      "const binaryDigest: string = tuple.binarySha256;",
      "const adapterRevision: string = tuple.adapterRevision;",
      'const architecture: "arm64" | "x64" = tuple.architecture;',
      "const binaryRevision: string = tuple.binaryRevision;",
      'const clientName: "agent-runtime" = tuple.clientName;',
      "const containmentProfile: string = tuple.containmentProfile;",
      "const nativeDependencyAliasRevision: string = tuple.nativeDependencyAliasRevision;",
      'const packageRevision: "@openai/codex@0.153.4" = tuple.packageRevision;',
      'const platform: "darwin" | "linux" = tuple.platform;',
      'const platformFamily: "unix" = tuple.platformFamily;',
      'const platformOs: "linux" | "macos" = tuple.platformOs;',
      'const protocolRevision: "contained-turn:v1:codex-app-server:0.153.4:schema-60c1b926bc9720e7695c23bcc6f8cb1dd7dcfa92601dd3e9d7b9267804f28c87:bindings-6884b9a77fe389ca3f0ed5c327115d5fa9398307390a2b080e6402c66c1e406b:agent-runtime-contained-v1:native-permission-config-v2" = tuple.protocolRevision;',
      "const resolvedNativePackageRevision: string = tuple.resolvedNativePackageRevision;",
      'const userAgentArchitecture: "arm64" | "x86_64" = tuple.userAgentArchitecture;',
      'const userAgentOsName: "Mac OS" | "Ubuntu" = tuple.userAgentOsName;',
      'const version: "0.153.4" = tuple.version;',
      "const dependencies: RuntimeInstallationDiscoveryDependencies = { executableFileObserver: observer };",
      "const discovery = createRuntimeInstallationDiscoveryFeature(dependencies);",
      "declare const request: ExecutableFileObservationRequest;",
      "declare const kernelDependencies: ContainedTurnKernelDependencies;",
      "declare const httpEgress: HttpEgressBrokerPorts;",
      'const ordinaryInput: OrdinaryInput = { commandId: "command", expectedProvider: "codex", intent: { mode: "analysis", prompt: "prompt" }, scope: { projectId: "project", tenantId: "tenant" } };',
      "const observation = observer.observe(request);",
      "void discovery; void observation; void identityObserver; void suppliedIdentityObserver; void binaryDigest; void adapterRevision; void architecture; void binaryRevision; void clientName; void containmentProfile; void nativeDependencyAliasRevision; void packageRevision; void platform; void platformFamily; void platformOs; void protocolRevision; void resolvedNativePackageRevision; void userAgentArchitecture; void userAgentOsName; void version; void kernelDependencies; void httpEgress; void ordinaryInput;",
    ].join("\n"));
    await writeFile(typeProject, JSON.stringify({
      compilerOptions: {
        lib: ["ES2024", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2024",
        types: ["node"],
      },
      files: ["positive-consumer.ts"],
    }));
    run(compiler, ["--project", typeProject, "--pretty", "false"], dirname(typeProject));

    const privateConsumer = join(temporaryRoot, "consumer", "private-consumer.ts");
    await writeFile(privateConsumer, [
      'import type { ApplyContainedTurnPostgresSchemaOptions, CodexAppServerPlatformTuple, CodexDirectoryIdentity, CodexDirectoryIdentitySnapshot, ContainedTurnOutputValidatedOperation, DarwinSeatbeltRouteOwner, DockerCustodyHttpReservation, EffectiveIdentity, HostLaunchBinding, LiveCustody, NodeCustodyHttpResources, NodeExecutableFileObserverDependencies, NodeHostHttpConnectionConfig, NodeHostHttpConnectionOptions, NodeProviderProcessCustodyHttpReservation, NodeStableIdentityHasher, StableIdentityHasher, StableProcessGroupGuardian, OpenedStablePath, prepareAuthenticatedHostHttpEgressSession } from "@agent-teams/agent-execution/composition";',
      "declare const postgresSchema: ApplyContainedTurnPostgresSchemaOptions;",
      "declare const platformTuple: CodexAppServerPlatformTuple;",
      "declare const directoryIdentity: CodexDirectoryIdentity;",
      "declare const validatedOperation: ContainedTurnOutputValidatedOperation;",
      "declare const identity: EffectiveIdentity;",
      "declare const connectionConfig: NodeHostHttpConnectionConfig;",
      "declare const observerDependencies: NodeExecutableFileObserverDependencies;",
      "declare const nodeHasher: NodeStableIdentityHasher;",
      "declare const hasher: StableIdentityHasher;",
      "declare const opened: OpenedStablePath;",
      "void postgresSchema; void platformTuple; void directoryIdentity; void validatedOperation; void identity; void connectionConfig; void observerDependencies; void nodeHasher; void hasher; void opened;",
    ].join("\n"));
    await writeFile(typeProject, JSON.stringify({
      compilerOptions: {
        lib: ["ES2024", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2024",
        types: ["node"],
      },
      files: ["private-consumer.ts"],
    }));
    const privacyDiagnostics = runFailure(
      compiler,
      ["--project", typeProject, "--pretty", "false"],
      dirname(typeProject),
    );
    for (const privateName of [
      "EffectiveIdentity",
      "ApplyContainedTurnPostgresSchemaOptions",
      "CodexAppServerPlatformTuple",
      "CodexDirectoryIdentity",
      "CodexDirectoryIdentitySnapshot",
      "ContainedTurnOutputValidatedOperation",
      "DarwinSeatbeltRouteOwner",
      "DockerCustodyHttpReservation",
      "NodeExecutableFileObserverDependencies",
      "NodeHostHttpConnectionConfig",
      "NodeHostHttpConnectionOptions",
      "HostLaunchBinding",
      "LiveCustody",
      "NodeCustodyHttpResources",
      "NodeProviderProcessCustodyHttpReservation",
      "NodeStableIdentityHasher",
      "StableIdentityHasher",
      "StableProcessGroupGuardian",
      "prepareAuthenticatedHostHttpEgressSession",
      "OpenedStablePath",
    ]) {
      assert.match(privacyDiagnostics, new RegExp(`no exported member(?: named)? '${privateName}'`, "u"));
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
