import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const protocolHeaderPath = "dist/features/contained-agent-turn/adapters/outbound/host-custody/native/darwin-attempt-owner-protocol.h";
const protocolModulePath = "dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-attempt-owner-protocol.js";

const run = (command: string, args: readonly string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
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
    assert.deepEqual(resolved.compositionKeys, [
      "CGROUP2_SUPER_MAGIC",
      "CODEX_APP_SERVER_ADAPTER_REVISION",
      "CODEX_APP_SERVER_BINARY_REVISION",
      "CODEX_APP_SERVER_BINARY_SHA256",
      "CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT",
      "CODEX_APP_SERVER_CURRENT_KERNEL_MANIFEST",
      "CODEX_APP_SERVER_DARWIN_ARM64_TUPLE",
      "CODEX_CAPABILITY_MANIFEST_REVISION",
      "CODEX_LOCAL_BROKER_CAPABILITY_ENV",
      "CONTAINED_TURN_DEPENDENCY_NAMES",
      "CONTAINED_TURN_POSTGRES_MIGRATIONS",
      "CONTAINED_TURN_POSTGRES_MIGRATION_DIGEST",
      "CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE",
      "CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS",
      "CONTAINED_TURN_POSTGRES_SCHEMA_VERSION",
      "CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS",
      "CONTAINED_TURN_PREPARATION_CLOSURE_LIMIT",
      "CONTAINED_TURN_REQUIRED_PROOF_KINDS",
      "CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS",
      "CodexAppServerContainedTurnProvider",
      "ContainedTurnKernelCustodyAdapter",
      "DOCKER_CUSTODY_BOOTSTRAP_PATH",
      "DOCKER_CUSTODY_INIT_ARGUMENTS",
      "DOCKER_CUSTODY_INIT_PROTOCOL",
      "DOCKER_CUSTODY_NODE_PATH",
      "DarwinCooperativeProcessCustody",
      "DockerConsumptionObservations",
      "DockerCustodyFrameDecoder",
      "DockerCustodyJournal",
      "DockerCustodyJournalConflictError",
      "DockerEngineError",
      "DockerHostCustodyLifecycle",
      "DockerHttpNetworkResources",
      "DockerOperationNetwork",
      "FakeDockerEngine",
      "HTTP_EVIDENCE_FENCE",
      "HostHttpEgressV4Journal",
      "HostHttpEgressV4NodeStorage",
      "NodeDockerCustodyJournalStorage",
      "NodeHttpEgressBoundaryIds",
      "NodeHttpEgressTrustedResolver",
      "NodeProviderProcessCustody",
      "NodeProviderProcessCustodyCore",
      "NodeTlsHttpEgressError",
      "NodeTlsHttpEgressTransport",
      "NodeUnixSocketDockerEngine",
      "PROC_SUPER_MAGIC",
      "PostgresContainedTurnOperationStore",
      "PostgresHttpEgressEvidence",
      "acceptedProviderPreparation",
      "appendContainedTurnOutputForOwnerStore",
      "applyContainedTurnPostgresSchema",
      "asContainedTurnCommandFingerprint",
      "assertNetworkContainer",
      "assertNetworkEngine",
      "bindContainedTurnPreparationGrantRequests",
      "bindContainedTurnRouteEnforcement",
      "bindDarwinCodexRouteEnforcement",
      "captureRootDarwinAttemptWorkspace",
      "claimContainedTurnDispatchPreparation",
      "codexTurnSandboxPolicy",
      "committedDispatchProofV1",
      "composeLinuxDockerResidueCustody",
      "computeContainedTurnArtifactTreeDigest",
      "containedTurnAcceptanceConstraintsDigestV1",
      "containedTurnAcceptanceIntentDigestV1",
      "containedTurnAuthorityVectorDigest",
      "containedTurnCommandFingerprint",
      "containedTurnDispatchClaimBindingDigest",
      "containedTurnIdentity",
      "containedTurnOperationCutoffRevision",
      "containedTurnPreparationClosureBinding",
      "containedTurnPreparationToken",
      "containedTurnPreventionDigest",
      "containedTurnProviderAccessSnapshotDigest",
      "containedTurnSatisfactionDigest",
      "containedTurnScopeDigest",
      "createClaudeCurrentKernelOwner",
      "createCodexAppServerPermissionBoundary",
      "createCodexCurrentKernelOwner",
      "createCodexNativeBrokerFileInstaller",
      "createCodexNativeBrokerRecipe",
      "createContainedTurnEngine",
      "createContainedTurnFeature",
      "createContainedTurnOperation",
      "createContainedTurnOperationProviderAccessPort",
      "createContainedTurnProviderAccessPort",
      "createContainedTurnRouteEnforcement",
      "createContainedTurnRuntimeSecurityPort",
      "createContainedTurnSecurityAcceptancePort",
      "createDarwinCodexEffectCustodyOwner",
      "createDarwinCodexHostPostClaimPreparation",
      "createDarwinCodexRouteEnforcement",
      "createDeferredCodexNativeBrokerFiles",
      "createDockerCodexHostKernelOwner",
      "createDockerCodexNativeBrokerFinalizer",
      "createDockerImageInitOwner",
      "createDockerLinuxExclusiveRouteAdmission",
      "createDockerLinuxPostClaimPreparation",
      "createDockerOperationNetworkOwner",
      "createHostHttpAdmissionGuard",
      "createHostHttpEgressSession",
      "createNativeHttpEgressRoute",
      "createNodeContainedTurnArtifacts",
      "createNodeContainedTurnWorkspace",
      "createNodeContainedTurnWorkspaceOwner",
      "createNodeDockerDeploymentRecipe",
      "createNodeExecutableFileObserver",
      "createNodeHostHttpConnection",
      "createNodeHostHttpListener",
      "createPreparedHttpRequestV1",
      "createRuntimeInstallationDiscoveryFeature",
      "createSpecificationSha256",
      "createStrictHttpEgressBroker",
      "createWorkspaceCapabilityRetention",
      "decodeCodexResponseEnvelope",
      "decodeContainedTurnArtifactManifest",
      "decodeEngineIdentity",
      "decodeInspection",
      "decodeOperationNetwork",
      "digestContainedTurnCanonicalValue",
      "dockerCustodyOwnerIdentitySha256",
      "dockerHttpOperationNetworkRecipe",
      "encodeContainedTurnArtifactManifest",
      "encodeCreateRequest",
      "encodeDockerCustodyFrame",
      "hostHttpAbortOperations",
      "initialHttpEgressState",
      "initializePostgresHttpEgressEvidence",
      "inspectDarwinRouteRequestInventory",
      "installLinuxExclusiveRoute",
      "isConcreteLinuxDockerLifecycle",
      "linuxExclusiveRouteSeccomp",
      "materializationAuthorizationRequest",
      "mutateContainedTurnOperation",
      // Embedded Runtime consumes this value; NativeHttpRequestProfileId is type-only.
      "nativeHttpRequestProfile",
      "networkBinding",
      "networkDigest",
      "operationNetworkLabels",
      "operationNetworkName",
      "parseResultPublicationRecord",
      "parseWorkspaceSealRecord",
      "prepareCodexNativeBrokerFiles",
      "prepareDarwinCodexNativeLaunchInput",
      "projectPreparedRequest",
      "readContainedTurnRouteEnforcementTarget",
      "readContainedTurnSelectedRouteAdmission",
      "readNodeContainedTurnNativeWorkspaceClosure",
      "readNodeContainedTurnNativeWorkspaceReceipts",
      "recordContainedTurnPreparationCleanup",
      "recoverContainedTurnCommittedGrantSettlements",
      "recoverContainedTurnDispatchPreparations",
      "renderCodexNativeBrokerConfig",
      "residueLeaf",
      "residueParent",
      "retireContainedTurnDispatchPreparation",
      "rollbackContainedTurnPostgresSchemaV4",
      "snapshotDockerEnginePolicy",
      "snapshotDockerImageInitLock",
      "v4Decode",
      "v4Hash",
      "v4Replay",
      "validateContainedTurnConsumedGrantReceipts",
      "validateContainedTurnOperation",
    ]);
    assert.deepEqual(resolved.contractKeys, []);
    assert.deepEqual(resolved.rejected, ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
