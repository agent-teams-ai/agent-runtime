import assert from "node:assert/strict";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}

export function directoryLinkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

export function pnpmLauncher({
  nodeExecutable = process.execPath,
  pnpmEntrypoint = process.env.npm_execpath
} = {}) {
  assert.ok(pnpmEntrypoint, "SDK_PNPM_ENTRYPOINT_MISSING: run qualification through the pinned pnpm script");
  return { command: nodeExecutable, prefixArgs: [pnpmEntrypoint] };
}

export function assertPackedSdkArchive(archive, expected, cwd) {
  const files = run("tar", ["tzf", archive], cwd).trim().split("\n").toSorted();
  const packed = JSON.parse(run("tar", ["xOf", archive, "package/package.json"], cwd));
  assert.equal(packed.name, expected.name, "SDK_PACKED_PACKAGE_MISMATCH");
  // Condition order is resolution behavior, even when keys and values match.
  assert.equal(JSON.stringify(packed.exports), JSON.stringify(expected.exports), "SDK_PACKED_EXPORT_MISMATCH");
  for (const target of Object.values(packed.exports).flatMap(branch => typeof branch === "string" ? [branch] : Object.values(branch))) {
    assert.ok(files.includes(`package/${target.slice(2)}`), `SDK_PACKED_TARGET_MISSING: ${packed.name} ${target}`);
  }
  assert.ok(!files.some(path => path.startsWith("package/src/")), "SDK_SOURCE_ONLY_ENTRY_LEAK");
  return files;
}

export function assertPublicImports(consumer, specifiers) {
  const source = `await Promise.all(${JSON.stringify(specifiers)}.map(specifier => import(specifier)));`;
  run(process.execPath, ["--input-type=module", "--eval", source], consumer);
  return specifiers;
}

// Qualification of actual package membership and public importability. EF's
// observer and authority route own SDK semantics; this grants no SDK admission.
export function qualifySdkPackages(repository = root) {
  const profile = parse(readFileSync(join(repository, "architecture/sdk-growth/profile.yaml"), "utf8"));
  const pnpm = pnpmLauncher();
  const linkType = directoryLinkType();
  const sandbox = mkdtempSync(join(tmpdir(), "ar-sdk-packed-"));
  for (const path of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc"]) {
    cpSync(join(repository, path), join(sandbox, path));
  }
  for (const pkg of profile.packages) {
    const manifest = JSON.parse(readFileSync(join(repository, pkg.manifestPath), "utf8"));
    mkdirSync(join(sandbox, pkg.packageRoot), { recursive: true });
    cpSync(join(repository, pkg.manifestPath), join(sandbox, pkg.manifestPath));
    for (const path of manifest.files) {
      mkdirSync(dirname(join(sandbox, pkg.packageRoot, path)), { recursive: true });
      cpSync(join(repository, pkg.packageRoot, path), join(sandbox, pkg.packageRoot, path), { recursive: true });
    }
  }
  // Packing built files only needs workspace manifests to resolve workspace:
  // versions. Installing the entire development graph adds no membership evidence.
  for (const pkg of profile.packages) {
    const manifest = JSON.parse(readFileSync(join(sandbox, pkg.manifestPath), "utf8"));
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!version.startsWith("workspace:")) { continue; }
      const dependency = profile.packages.find(entry => entry.packageName === name);
      assert.ok(dependency, `SDK_WORKSPACE_DEPENDENCY_MISSING: ${name}`);
      const link = join(sandbox, pkg.packageRoot, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(sandbox, dependency.packageRoot), link, linkType);
    }
    // Materialize workspace versions before packing so pnpm does not derive a
    // dependency-key order from filesystem link discovery. Stable manifest
    // bytes make the retained archive SHA-256 reproducible across fresh packs.
    for (const section of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, version] of Object.entries(section ?? {})) {
        if (!version.startsWith("workspace:")) { continue; }
        const dependency = profile.packages.find(entry => entry.packageName === name);
        section[name] = JSON.parse(readFileSync(join(sandbox, dependency.manifestPath), "utf8")).version;
      }
    }
    writeFileSync(join(sandbox, pkg.manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const packages = [];
  for (const pkg of profile.packages) {
    const output = join(sandbox, "archives", pkg.packageName.split("/").at(-1));
    mkdirSync(output, { recursive: true });
    run(pnpm.command, [...pnpm.prefixArgs, "pack", "--config.ignore-scripts=true", "--pack-destination", output], join(sandbox, pkg.packageRoot));
    const archives = readdirSync(output).filter(name => name.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    const archive = join(output, archives[0]);
    const expected = JSON.parse(readFileSync(join(repository, pkg.manifestPath), "utf8"));
    const files = assertPackedSdkArchive(archive, expected, sandbox);
    packages.push({ packageName: pkg.packageName, archive, archiveSha256: digest(readFileSync(archive)), members: files.length });
  }
  const consumer = join(sandbox, "consumer");
  const installed = new Map();
  for (const pkg of profile.packages) {
    const location = join(consumer, "node_modules", ...pkg.packageName.split("/"));
    mkdirSync(location, { recursive: true });
    const archive = packages.find(entry => entry.packageName === pkg.packageName).archive;
    run("tar", ["xzf", archive, "--strip-components=1", "-C", location], sandbox);
    installed.set(pkg.packageName, location);
  }
  for (const pkg of profile.packages) {
    const location = installed.get(pkg.packageName);
    const manifest = JSON.parse(readFileSync(join(location, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = installed.get(name)
        ?? realpathSync(join(repository, pkg.packageRoot, "node_modules", name));
      const link = join(location, "node_modules", ...name.split("/"));
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(dependency, link, linkType);
    }
  }
  const publicImports = profile.packages.flatMap(pkg => {
    const manifest = JSON.parse(readFileSync(join(installed.get(pkg.packageName), "package.json"), "utf8"));
    return Object.keys(manifest.exports).map(exportPath => `${pkg.packageName}${exportPath === "." ? "" : exportPath.slice(1)}`);
  });
  assertPublicImports(consumer, publicImports);
  const receipt = { schemaVersion: 1, qualification: "package-membership-and-public-imports", releaseEligible: false, sandbox, platform: process.platform, node: process.version, packages, publicImports };
  writeFileSync(join(sandbox, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(qualifySdkPackages(process.argv[2] === undefined ? root : resolve(process.argv[2])), null, 2));
}
