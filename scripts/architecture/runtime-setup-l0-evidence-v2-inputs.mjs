// Development-only policy for new v2 captures. Historical L0/v1 inventories stay frozen.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, posix, resolve } from "node:path";
import { evidencePackages } from "./runtime-setup-l0-evidence-spec.mjs";

export const v2InputPolicy = Object.freeze({
  version: "runtime-setup-v2-inputs/1",
  // Whole package roots include future scripts, headers, assets and build recipes.
  roots: Object.freeze([...evidencePackages,
    "architecture/get-modular",
    "architecture/feature-module-standard", "architecture/consumer-module-standard",
    // The synchronous adoption prerequisite reads the live ADR catalog and
    // Foundation's configured source roots, including tooling and experiments.
    "docs/decisions", "experiments", "scripts/architecture", "scripts/ci",
    "scripts/docs", "scripts/foundation", "scripts/native-helper",
    "scripts/sdk-growth-source",
  ]),
  // Other capture, authority, and configuration inputs outside those roots.
  files: Object.freeze([
    ".github/workflows/node-26-compatibility.yml",
    ".github/workflows/runtime-current-adoption-capture.yml",
    "scripts/ci/audit-node-engine-compatibility.mjs",
    "scripts/ci/node-engine-compatibility.test.mjs",
    "scripts/ci/node-runtime-compatibility.test.mjs",
    "scripts/architecture/ar2-evidence-custody.mjs",
    "scripts/architecture/check-feature-modules.mjs",
    "scripts/architecture/check-get-modular-adoption.mjs",
    "scripts/architecture/check-get-modular-adoption.test.mjs",
    "scripts/architecture/check-ordinary-feature-scope.mjs",
    "scripts/architecture/check-ordinary-feature-scope.test.mjs",
    "scripts/architecture/feature-module-analysis.mjs",
    "scripts/architecture/feature-module-comment-references.mjs",
    "scripts/architecture/feature-module-config.mjs",
    "scripts/architecture/feature-module-edges.mjs",
    "scripts/architecture/feature-module-imports.mjs",
    "scripts/architecture/feature-module-limits.mjs",
    "scripts/architecture/feature-module-maintainability.mjs",
    "scripts/architecture/feature-module-paths.mjs",
    "scripts/architecture/feature-module-profile.mjs",
    "scripts/architecture/feature-module-readme.mjs",
    "scripts/architecture/feature-module-reviewed-features.mjs",
    "scripts/architecture/feature-module-root-gates.mjs",
    "scripts/architecture/feature-module-tests.mjs",
    "scripts/architecture/feature-module-workspace.mjs",
    "scripts/architecture/get-modular-source-census.mjs",
    "scripts/architecture/ordinary-composition-evidence.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-adoption.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-adoption.test.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-historical.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-inputs.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-inputs.test.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-platform-sites.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-spec.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-v2-capture.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-v2-inputs.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-v2.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-v2.test.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-validation.mjs",
    "scripts/architecture/runtime-setup-l0-evidence-validation.test.mjs",
    "scripts/architecture/runtime-setup-l0-evidence.mjs",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
    ".gitattributes", ".gitignore", ".node-version", "tsconfig.json",
    "tsconfig.synthetic-oracle.json", "architecture/foundation/scaffold-tsconfig.json",
    "architecture/foundation/source-dependencies.yaml", "foundation.config.yaml",
    "architecture/foundation/governance-architecture-decisions.yaml",
    "architecture/decisions/accepted-decisions.json",
    "docs/decisions/README.md",
    "docs/decisions/0015-passive-setup-static-assembly-adoption.md",
    "docs/decisions/0090-ordinary-user-session-codex-execution-profile.md",
    "docs/architecture/get-modular-adoption.md",
    "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md",
    "docs/decisions/0017-feature-module-production-scope-roles.md",
    "docs/architecture/feature-module-standard-v1-candidate.md",
    "docs/architecture/qualification-registry.json", "docs/architecture/readiness.md",
    "docs/spikes/linux-nonroot-containment-egress-results.md",
    "docs/spikes/runtime-setup-assembly-adoption-evidence.json",
    "docs/spikes/runtime-setup-l0-dogfooding-evidence.json",
  ]),
  // Required nested inputs cannot disappear even in a new capture revision.
  requiredRoots: Object.freeze([
    ...evidencePackages.flatMap(path => [`${path}/src`, `${path}/tests`]),
    "docs/decisions", "experiments", "scripts/architecture", "scripts/ci",
    "scripts/docs", "scripts/foundation", "scripts/native-helper",
    "scripts/sdk-growth-source",
    "packages/apps/embedded-runtime/scripts",
    "packages/contexts/agent-execution/scripts",
    "packages/platform/filesystem-custody/scripts", "packages/platform/filesystem-custody/native",
  ]),
  required: Object.freeze([
    ".github/workflows/runtime-current-adoption-capture.yml",
    "scripts/ci/node-engine-compatibility.test.mjs",
    ...evidencePackages.flatMap(path => [`${path}/package.json`, `${path}/tsconfig.json`]),
    "scripts/architecture/runtime-setup-l0-evidence-v2-inputs.mjs",
    "architecture/get-modular/consumer-profile.json", "architecture/get-modular/consumer-profile.schema.json",
    "architecture/get-modular/evidence/consumer-module-standard.md",
    "architecture/get-modular/evidence/get-modular-core-0.1.0.tgz",
    "architecture/get-modular/evidence/get-modular-assembly-0.1.0.tgz",
  ]),
});
// These slots are optional, but Foundation v3 observes their absence on every
// run. Bind a newly committed manifest at its own revision and reject it when
// a receipt still names an older revision where the slot was absent.
const observedManifestSlots = Object.freeze([
  "scripts/package.json", "packages/package.json",
  "packages/apps/package.json", "packages/contexts/package.json",
  "packages/platform/package.json",
]);
const pathspec = [...v2InputPolicy.roots, ...v2InputPolicy.files, ...observedManifestSlots]
  .map(path => `:(top,literal)${path}`);
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const workspacePatterns = ["experiments/*", "packages/apps/*", "packages/contexts/*", "packages/platform/*"];
const within = (path, parent) => path === parent || path.startsWith(`${parent}/`);
const metadata = (_, name) => name === ".git" || name === "node_modules";
function hasPackageAuthority(root, directory) {
  let stat;
  try {stat = lstatSync(resolve(root, directory, "package.json"));}
  catch (error) {if (error.code === "ENOENT") {return false;} throw error;}
  if (!stat.isFile()) {return false;}
  const value = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value),
    `package manifest must contain an object: ${directory}/package.json`);
  // Foundation 1.6.0 observes a lone valid type key as a module scope,
  // not as package authority for generated-output exclusion.
  return !(Object.keys(value).length === 1 &&
    (value.type === "module" || value.type === "commonjs"));
}
function assertManifestBound(root, manifest, selectedPaths, requireRegular = false) {
  let stat;
  try {stat = lstatSync(resolve(root, manifest));}
  catch (error) {if (error.code === "ENOENT") {return;} throw error;}
  assert.ok(!stat.isSymbolicLink(), `source discovery symlink: ${manifest}`);
  if (requireRegular) {assert.ok(stat.isFile(), `package manifest must be a regular file: ${manifest}`);}
  if (stat.isFile()) {assert.ok(selectedPaths.has(manifest),
    `discovered workspace manifest is not committed at SOURCE revision: ${manifest}`);}
}
function plainYamlList(root, path, key) {
  const lines = readFileSync(resolve(root, path), "utf8").split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => line === `${key}:` ? [index] : []);
  assert.equal(headings.length, 1, `SOURCE policy requires one plain ${key} list: ${path}`);
  const values = [];
  for (const line of lines.slice(headings[0] + 1)) {
    if (/^[A-Za-z][A-Za-z0-9-]*:/u.test(line)) {break;}
    if (line.trim() === "" || line.trimStart().startsWith("#")) {continue;}
    const match = /^\s*-\s+(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/u.exec(line);
    assert.ok(match, `SOURCE policy requires a plain ${key} list: ${path}`);
    values.push(match[1] ?? match[2] ?? match[3]);
  }
  assert.ok(values.length, `SOURCE policy requires a nonempty plain ${key} list: ${path}`);
  return values;
}

// Foundation's workspace reader traverses from repository root before it
// applies glob selection. Empty and ignored directories can change its result.
function assertWorkspaceDirectoryTopology(root) {
  const directoryIdentities = new Map();
  const pendingDirectories = ["."];
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    for (const entry of readdirSync(resolve(root, directory), {withFileTypes: true})) {
      assert.ok(entry.name && entry.name !== "." && entry.name !== ".." &&
        !entry.name.includes("/") && !entry.name.includes("\\"),
      `unsafe workspace entry: ${directory}/${entry.name}`);
      if (!entry.isDirectory() || metadata(directory, entry.name)) {continue;}
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      const identity = path.normalize("NFC").toLocaleLowerCase("en-US");
      const previous = directoryIdentities.get(identity);
      assert.ok(previous === undefined || previous === path,
        `workspace directory portable collision: ${previous} and ${path}`);
      directoryIdentities.set(identity, path);
      pendingDirectories.push(path);
    }
  }
}

function assertPortableSourceFile(path, identities, observesManifests) {
  if (!observesManifests || !sourceExtensions.has(extname(path))) {return;}
  const identity = path.normalize("NFC").toLocaleLowerCase("en-US");
  const previous = identities.get(identity);
  assert.ok(previous === undefined || previous === path,
    `source file portable collision: ${previous} and ${path}`);
  identities.set(identity, path);
}

// Foundation reads physical source trees and workspace manifests, including
// ignored paths. Git's pathspec inventory alone cannot observe those additions.
function assertLiveDiscoveryBound(root, selectedPaths) {
  const governedRoots = plainYamlList(root, "architecture/foundation/source-dependencies.yaml", "governedRoots");
  const packageRoots = plainYamlList(root, "architecture/foundation/source-dependencies.yaml", "packageRoots");
  assert.deepEqual(packageRoots, evidencePackages,
    "package roots require a reviewed SOURCE policy update");
  const discoveredPatterns = plainYamlList(root, "pnpm-workspace.yaml", "packages");
  assert.deepEqual(discoveredPatterns, workspacePatterns,
    "workspace discovery patterns require a reviewed SOURCE policy update");
  for (const governed of governedRoots) {
    assert.ok(v2InputPolicy.roots.some(inputRoot => within(governed, inputRoot)),
      `source discovery root outside SOURCE: ${governed}`);
  }
  assertWorkspaceDirectoryTopology(root);
  const sourceIdentities = new Map();
  const scan = (start, excluded, accept, observesManifests = false) => {
    const pending = [start];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(resolve(root, directory), {withFileTypes: true})) {
        const path = posix.join(directory, entry.name);
        if (excluded(directory, entry.name)) {
          if (entry.name === "dist" && entry.isSymbolicLink()) {assert.fail(`source discovery symlink: ${path}`);}
          continue;
        }
        if (observesManifests && entry.name === "package.json") {
          assert.ok(entry.isFile(), `package manifest must be a regular file: ${path}`);
        }
        if (entry.isSymbolicLink()) {assert.fail(`source discovery symlink: ${path}`);}
        if (entry.isDirectory()) {
          pending.push(path);
        }
        else if (entry.isFile() && accept(path)) {
          assertPortableSourceFile(path, sourceIdentities, observesManifests);
          assert.ok(selectedPaths.has(path), `discovered input is not committed at SOURCE revision: ${path}`);
        }
      }
    }
  };
  const sourceFile = path => sourceExtensions.has(extname(path));
  for (const governed of governedRoots) {
    scan(governed, metadata, path => sourceFile(path) || posix.basename(path) === "package.json", true);
  }
  for (const manifest of observedManifestSlots) {
    assertManifestBound(root, manifest, selectedPaths, true);
  }
  scan("docs/decisions", metadata, path => extname(path) === ".md");
  for (const packageRoot of evidencePackages) {
    const packageExcluded = (directory, name) => {
      if (metadata(directory, name)) {return true;}
      if (name !== "dist" && name !== "coverage") {return false;}
      const generated = `${directory}/${name}`;
      if (governedRoots.some(governed => within(governed, generated))) {return false;}
      // Foundation excludes generated directories only at a package root.
      if (directory === packageRoot) {return true;}
      if (posix.dirname(directory) !== packageRoot) {return false;}
      return hasPackageAuthority(root, directory);
    };
    scan(packageRoot, packageExcluded,
      path => sourceFile(path) || posix.basename(path) === "package.json", true);
  }
  for (const pattern of workspacePatterns) {
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(resolve(root, parent), {withFileTypes: true})) {
      if (entry.name === ".git" || entry.name === "node_modules") {continue;}
      const manifest = `${parent}/${entry.name}/package.json`;
      if (entry.isDirectory() && posix.matchesGlob(`${parent}/${entry.name}`, pattern)) {
        assertManifestBound(root, manifest, selectedPaths);
      }
    }
  }
}
const git = (root, ...args) => execFileSync("git", args, {cwd: root, encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"}});
function gitBlobBytes(root, objects) {
  const input = Buffer.from(objects.map(({object}) => `${object}\n`).join(""));
  const output = execFileSync("git", ["cat-file", "--batch"], {cwd: root, input,
    maxBuffer: 64 * 1024 * 1024, env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"}});
  let offset = 0; const blobs = new Map();
  for (const {object} of objects) {
    const end = output.indexOf(0x0a, offset); assert.ok(end >= 0, "truncated git cat-file response");
    const [actual, type, sizeText] = output.subarray(offset, end).toString().split(" ");
    assert.equal(actual, object, "git cat-file object mismatch"); assert.equal(type, "blob", "input is not a blob");
    const size = Number(sizeText); assert.ok(Number.isSafeInteger(size) && size >= 0, "invalid git blob size");
    const start = end + 1, finish = start + size; assert.ok(finish <= output.length, "truncated git blob");
    blobs.set(object, output.subarray(start, finish)); offset = finish + 1;
  }
  return blobs;
}

function checkedInputs(inputs) {
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const paths = new Set(inputs.map(({path}) => path));
  assert.equal(paths.size, inputs.length, "duplicate input");
  for (const path of [...v2InputPolicy.roots, ...v2InputPolicy.requiredRoots]) {
    assert.ok(inputs.some(input => input.path.startsWith(`${path}/`)), `missing required input: ${path}`);
  }
  for (const path of [...v2InputPolicy.files, ...v2InputPolicy.required]) {
    assert.ok(paths.has(path), `missing required input: ${path}`);
  }
  return {inputPolicy: v2InputPolicy.version, inputs};
}

function treeEntries(root, sourceRevision) {
  return git(root, "ls-tree", "-rz", sourceRevision, "--", ...pathspec).split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t"), path = entry.slice(tab + 1);
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    assert.ok(type === "blob" && ["100644", "100755"].includes(mode), `non-regular input: ${path}`);
    return {path, mode, object};
  });
}

export function v2InputsAtRevision(root, sourceRevision) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  const entries = treeEntries(root, sourceRevision), blobs = gitBlobBytes(root, entries);
  return checkedInputs(entries.map(({path, mode, object}) => ({path, mode,
    sha256: createHash("sha256").update(blobs.get(object)).digest("hex")})));
}

export function v2Inputs(root, sourceRevision) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.equal(git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspec), "",
    "capture inputs must be committed and clean");
  try {
    git(root, "diff", "--quiet", sourceRevision, "--", ...pathspec);
  } catch (error) {
    if (error.status !== 1) {throw error;}
    assert.fail("source/input mismatch");
  }
  const inputs = treeEntries(root, sourceRevision).map(({path, mode}) => {
    // Reject filesystem links too, including linked ancestors and core.symlinks=false.
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(resolve(root, ...parts.slice(0, i)));
      assert.ok(i === parts.length ? stat.isFile() : stat.isDirectory(), `non-regular input: ${path}`);
      if (i === parts.length) {assert.equal(Boolean(stat.mode & 0o111), mode === "100755", `input mode mismatch: ${path}`);}
    }
    return {path, mode, sha256: createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")};
  });
  const result = checkedInputs(inputs);
  assertLiveDiscoveryBound(root, new Set(result.inputs.map(input => input.path)));
  return result;
}
