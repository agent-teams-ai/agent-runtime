import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

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
    assert.equal(packedPaths.some(path => /^dist\/(?:production|testing)(?:\.|\/)/u.test(path)), false);
    assert.equal(packedPaths.some(path => path.includes("contained-agent-turn-fixture")), false);
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
    assert.deepEqual(packedManifest.exports, {
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./composition": {
        import: "./dist/composition.js",
        types: "./dist/composition.d.ts",
      },
    });
    for (const entrypoint of ["index", "composition"]) {
      await access(join(installedPackage, `dist/${entrypoint}.js`));
      await access(join(installedPackage, `dist/${entrypoint}.d.ts`));
    }

    const consumerPath = join(temporaryRoot, "consumer", "consume.mjs");
    await writeFile(consumerPath, [
      'import * as contracts from "@agent-teams/agent-execution";',
      'import * as composition from "@agent-teams/agent-execution/composition";',
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
      "CONTAINED_TURN_POSTGRES_MIGRATION_NAMESPACE",
      "CONTAINED_TURN_POSTGRES_MIGRATION_TIMEOUTS",
      "CONTAINED_TURN_POSTGRES_SCHEMA_VERSION",
      "CONTAINED_TURN_POSTGRES_TIMEOUT_DEFAULTS",
      "DarwinCooperativeProcessCustody",
      "NodeProviderProcessCustody",
      "PostgresContainedTurnOperationStore",
      "applyContainedTurnPostgresSchema",
      "createClaudeCurrentKernelOwner",
      "createCodexAppServerPermissionBoundary",
      "createCodexCurrentKernelOwner",
      "createContainedTurnFeature",
      "createContainedTurnProviderAccessPort",
      "createContainedTurnRuntimeSecurityPort",
      "createHostHttpEgressSession",
      "createNodeContainedTurnArtifacts",
      "createNodeContainedTurnWorkspace",
      "createNodeExecutableFileObserver",
      "createRuntimeInstallationDiscoveryFeature",
      "recoverContainedTurnCommittedGrantSettlements",
      "recoverContainedTurnDispatchPreparations",
      "rollbackContainedTurnPostgresSchemaV4",
    ]);
    assert.deepEqual(resolved.contractKeys, []);
    assert.deepEqual(resolved.rejected, ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
