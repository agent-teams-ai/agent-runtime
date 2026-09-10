import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const nativeArtifact = "dist/rename-no-replace.node";
// The qualified artifact is only built on the two supported hosts, and `npm` is
// not directly executable on win32, so the packed surface is qualified there.
const unsupportedHost = !["darwin", "linux"].includes(process.platform)
  && "the qualified native artifact is only built on linux and darwin";

const run = (command: string, args: readonly string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", npm_config_offline: "true", npm_config_update_notifier: "false" },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
};

test("packs both curated assembly entries and the qualified native artifact", { skip: unsupportedHost }, async () => {
  const temporaryParent = join(packageRoot, ".cache");
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(temporaryParent, "custody-pack-"));
  try {
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryRoot, "."], packageRoot)) as readonly [{
      readonly filename: string;
      readonly files: readonly { readonly path: string }[];
    }];
    assert.equal(packed.length, 1);
    const paths = packed[0]?.files.map(file => file.path) ?? [];
    for (const required of ["dist/index.js", "dist/index.d.ts", "dist/composition.js", "dist/composition.d.ts", nativeArtifact]) {
      assert.ok(paths.includes(required), `missing packed path: ${required}`);
    }
    // The feature layout must ship behind the two curated entries, never as a
    // second published surface, and no test-only artifact may reach consumers.
    assert.ok(paths.some(path => path.startsWith("dist/features/stable-filesystem-custody/adapters/")));
    assert.equal(paths.some(path => /(?:test-support|-worker|\.(?:test|spec)\.)/u.test(path)), false);
    assert.equal(paths.some(path => path.endsWith(".c") || path.endsWith(".h")), false);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("the public entry exposes only portable contracts while composition carries the runtime", { skip: unsupportedHost }, async () => {
  await access(join(packageRoot, nativeArtifact));
  const publicEntry = await import("../../dist/index.js") as Record<string, unknown>;
  assert.deepEqual(Object.keys(publicEntry), []);

  const composition = await import("../../dist/composition.js") as Record<string, unknown>;
  for (const name of [
    "PathCustodyError",
    "capturePathLineage",
    "hasDarwinHostDescriptors",
    "openStablePath",
    "pathLineagesEqual",
    "publishStableDirectoryNoReplace",
    "resolveStableDirectoryMutationCapability",
    "stableDirectoryMutationCapability",
    "withStableDirectoryProcessLock",
  ]) {
    assert.equal(typeof composition[name] === "function", true, `composition must export ${name}`);
  }
});
