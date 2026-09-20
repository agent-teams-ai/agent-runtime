// Development-only policy for new v2 captures. Historical L0/v1 inventories stay frozen.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evidencePackages } from "./runtime-setup-l0-evidence-spec.mjs";

export const v2InputPolicy = Object.freeze({
  version: "runtime-setup-v2-inputs/1",
  // Whole package roots include future scripts, headers, assets and build recipes.
  roots: Object.freeze([...evidencePackages,
    "architecture/get-modular",
    "architecture/feature-module-standard", "architecture/consumer-module-standard",
  ]),
  // Explicit evidence/checker import closure; unrelated architecture tools are excluded.
  files: Object.freeze([
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
    "docs/decisions/0015-passive-setup-static-assembly-adoption.md",
    "docs/decisions/0090-ordinary-user-session-codex-execution-profile.md",
    "docs/architecture/get-modular-adoption.md",
    "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md",
    "docs/decisions/0017-feature-module-production-scope-roles.md",
    "docs/architecture/feature-module-standard-v1-candidate.md",
    "docs/architecture/qualification-registry.json", "docs/architecture/readiness.md",
    "docs/spikes/runtime-setup-assembly-adoption-evidence.json",
    "docs/spikes/runtime-setup-l0-dogfooding-evidence.json",
  ]),
  // Required nested inputs cannot disappear even in a new capture revision.
  requiredRoots: Object.freeze([
    ...evidencePackages.flatMap(path => [`${path}/src`, `${path}/tests`]),
    "packages/apps/embedded-runtime/scripts",
    "packages/contexts/agent-execution/scripts",
    "packages/platform/filesystem-custody/scripts", "packages/platform/filesystem-custody/native",
  ]),
  required: Object.freeze([
    ...evidencePackages.flatMap(path => [`${path}/package.json`, `${path}/tsconfig.json`]),
    "scripts/architecture/runtime-setup-l0-evidence-v2-inputs.mjs",
    "architecture/get-modular/consumer-profile.json", "architecture/get-modular/consumer-profile.schema.json",
    "architecture/get-modular/evidence/consumer-module-standard.md",
    "architecture/get-modular/evidence/get-modular-core-0.1.0.tgz",
    "architecture/get-modular/evidence/get-modular-assembly-0.1.0.tgz",
  ]),
});
const pathspec = [...v2InputPolicy.roots, ...v2InputPolicy.files].map(path => `:(top,literal)${path}`);
const git = (root, ...args) => execFileSync("git", args, {cwd: root, encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"}});
function gitBlobBytes(root, objects) {
  const input = Buffer.from(objects.map(({object}) => `${object}\n`).join());
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
  return checkedInputs(inputs);
}
