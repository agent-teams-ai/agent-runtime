import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

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

test("ships ./testing as built ESM and declarations to an isolated packed consumer", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-execution-testing-pack-"));
  try {
    const packOutput = run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, "."],
      packageRoot,
    );
    const packResult = JSON.parse(packOutput) as readonly [{ readonly filename: string }];
    assert.equal(packResult.length, 1);
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
    assert.deepEqual(packedManifest.exports["./testing"], {
      import: "./dist/testing/index.js",
      types: "./dist/testing/index.d.ts",
    });
    await access(join(installedPackage, "dist/testing/index.js"));
    await access(join(installedPackage, "dist/testing/index.d.ts"));
    assert.doesNotMatch(await readFile(join(installedPackage, "dist/index.js"), "utf8"), /createDependencies/u);
    assert.doesNotMatch(await readFile(join(installedPackage, "dist/production.js"), "utf8"), /createDependencies/u);

    const consumerPath = join(temporaryRoot, "consumer", "consume.mjs");
    await writeFile(consumerPath, [
      'import { createDependencies } from "@agent-teams/agent-execution/testing";',
      "const fixture = createDependencies();",
      "const manifest = fixture.dependencies.provider.manifest;",
      "process.stdout.write(JSON.stringify({ manifestKeys: Object.keys(manifest).sort(), provider: manifest.provider }));",
    ].join("\n"));
    const consumerOutput = run(process.execPath, [consumerPath], dirname(consumerPath));
    assert.deepEqual(JSON.parse(consumerOutput), {
      manifestKeys: [
        "effectCardinality",
        "effectClass",
        "manifestRevision",
        "manifestVersion",
        "provider",
        "providerAttemptCardinality",
        "requiredProofKinds",
        "resourceScopeRevision",
        "supportedModes",
        "unknownCapabilityPolicy",
      ],
      provider: "codex",
    });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
