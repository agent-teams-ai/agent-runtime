import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { v2InputPolicy, v2Inputs, v2InputsAtRevision } from "./runtime-setup-l0-evidence-v2-inputs.mjs";
import { sha256 } from "./runtime-setup-l0-evidence-v2.mjs";
import { v2ReportPath } from "./runtime-setup-l0-evidence-v2-capture.mjs";

export function registerBoundedInventoryTests({ callerIdentity, gitWithEnv, fixture }) {
  test("bounded inventory rejects missing inputs, links and gitlinks and preserves Git errors", t => {
    const root = mkdtempSync(resolve(tmpdir(), "v2-input-policy-"));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const identity = callerIdentity(process.cwd());
    const runGit = gitWithEnv({...process.env, ...identity});
    runGit(root, "init", "--quiet");
    const sourceConfig = parseYaml(readFileSync(new URL("../../architecture/foundation/source-dependencies.yaml", import.meta.url), "utf8"));
    const directories = new Set([...v2InputPolicy.roots, ...v2InputPolicy.requiredRoots, ...sourceConfig.governedRoots]);
    for (const path of directories) {
      fs.mkdirSync(resolve(root, path), {recursive: true});
      writeFileSync(resolve(root, path, "fixture.txt"), "fixture");
    }
    for (const path of [...v2InputPolicy.files, ...v2InputPolicy.required]) {
      fs.mkdirSync(resolve(root, path, ".."), {recursive: true}); writeFileSync(resolve(root, path), "fixture");
    }
    for (const path of ["pnpm-workspace.yaml", "architecture/foundation/source-dependencies.yaml", ".gitignore"]) {
      writeFileSync(resolve(root, path), readFileSync(new URL(`../../${path}`, import.meta.url)));
    }
    const workflowPath = ".github/workflows/runtime-current-adoption-capture.yml";
    writeFileSync(resolve(root, workflowPath), readFileSync(new URL(`../../${workflowPath}`, import.meta.url)));
    const decisionIndex = "docs/decisions/README.md";
    writeFileSync(resolve(root, decisionIndex), readFileSync(new URL(`../../${decisionIndex}`, import.meta.url)));
    const commit = () => {runGit(root, "add", "-A"); runGit(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic policy"); return runGit(root, "rev-parse", "HEAD");};
    const revision = commit(), baseline = v2Inputs(root, revision);
    assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
    assert.equal(baseline.inputPolicy, v2InputPolicy.version);
    const ignoredSource = "scripts/ci/.cache/r147-probe.ts";
    fs.mkdirSync(resolve(root, ignoredSource, ".."), {recursive: true});
    writeFileSync(resolve(root, ignoredSource), "export const broken = ;\n");
    assert.equal(runGit(root, "check-ignore", ignoredSource), ignoredSource);
    assert.throws(() => v2Inputs(root, revision), /discovered input is not committed at SOURCE revision/);
    assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
    rmSync(resolve(root, ignoredSource), {force: true});
    const siblingManifest = "packages/apps/r147-disposable/package.json";
    fs.mkdirSync(resolve(root, siblingManifest, ".."), {recursive: true});
    writeFileSync(resolve(root, siblingManifest), JSON.stringify({name: "@review/r147-disposable", version: "0.0.0", private: true, type: "module"}));
    assert.throws(() => v2Inputs(root, revision), /discovered workspace manifest is not committed at SOURCE revision/);
    assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
    rmSync(resolve(root, siblingManifest, ".."), {recursive: true});
    const originalWorkflow = baseline.inputs.find(input => input.path === workflowPath);
    assert.ok(originalWorkflow, "capture workflow is a protected input");
    const originalDecisionIndex = baseline.inputs.find(input => input.path === decisionIndex);
    assert.ok(originalDecisionIndex, "live governance catalog is a protected input");
    const decisionIndexBytes = readFileSync(resolve(root, decisionIndex), "utf8");
    assert.match(decisionIndexBytes, /## Accepted/u);
    writeFileSync(resolve(root, decisionIndex), decisionIndexBytes.replace("## Accepted", "## Wrong heading"));
    assert.throws(() => v2Inputs(root, revision), /committed and clean/);
    const changedDecisionRevision = commit();
    assert.notEqual(v2Inputs(root, changedDecisionRevision).inputs.find(input => input.path === decisionIndex).sha256,
      originalDecisionIndex.sha256, "indirect prerequisite mutation must change receipt identity");
    assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/);
    runGit(root, "reset", "--hard", revision);
    const workflowBytes = readFileSync(resolve(root, workflowPath), "utf8");
    assert.match(workflowBytes, /pnpm install --frozen-lockfile --engine-strict --strict-peer-dependencies/u);
    writeFileSync(resolve(root, workflowPath), workflowBytes.replace(
      "pnpm install --frozen-lockfile --engine-strict --strict-peer-dependencies",
      "pnpm install --frozen-lockfile --engine-strict --strict-peer-dependencies --reporter=append-only"));
    assert.throws(() => v2Inputs(root, revision), /committed and clean/);
    const changedWorkflowRevision = commit();
    assert.notEqual(v2Inputs(root, changedWorkflowRevision).inputs.find(input => input.path === workflowPath).sha256,
      originalWorkflow.sha256, "capture install mutation must change input digest");
    assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/);
    runGit(root, "reset", "--hard", revision);
    assert.deepEqual(baseline.inputs.map(i => i.path), baseline.inputs.map(i => i.path).toSorted());
    for (const path of [...v2InputPolicy.roots, ...v2InputPolicy.requiredRoots, ...v2InputPolicy.files, ...v2InputPolicy.required]) {
      rmSync(resolve(root, path), {recursive: true, force: true});
      const removed = commit();
      assert.throws(() => v2Inputs(root, removed), /missing required input/);
      runGit(root, "reset", "--hard", revision);
    }
    // Exercise all input classes without depending on historical clone availability.
    for (const {path} of baseline.inputs) {
      fs.appendFileSync(resolve(root, path), "changed");
      assert.throws(() => v2Inputs(root, revision), /committed and clean/);
      commit();
      assert.deepEqual(v2InputsAtRevision(root, revision), baseline);
      assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/);
      runGit(root, "reset", "--hard", revision);
    }
    writeFileSync(resolve(root, "README.md"), "unrelated");
    fs.mkdirSync(resolve(root, "docs/spikes"), {recursive: true});
    writeFileSync(resolve(root, v2ReportPath), "report");
    assert.deepEqual(v2Inputs(root, revision), baseline);
    commit();
    assert.deepEqual(v2Inputs(root, revision), baseline);
    runGit(root, "reset", "--hard", revision);
    for (const mutate of [
      () => fs.renameSync(resolve(root, "package.json"), resolve(root, "renamed.json")),
      () => {runGit(root, "config", "core.fileMode", "true"); fs.chmodSync(resolve(root, "package.json"), 0o755);},
    ]) {
      mutate(); commit();
      assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/);
      runGit(root, "reset", "--hard", revision);
    }
    runGit(root, "config", "core.fileMode", "false");
    fs.chmodSync(resolve(root, "package.json"), 0o755);
    assert.throws(() => v2Inputs(root, revision), /input mode mismatch/);
    fs.chmodSync(resolve(root, "package.json"), 0o644);
    runGit(root, "config", "core.fileMode", "true");
    for (const mutate of [
      id => {delete id.inputPolicy;},
      id => {id.inputPolicy = "runtime-setup-v2-inputs/0";},
      id => {id.inputs.pop();},
      id => {id.inputs.push({path: "README.md", mode: "100644", sha256: "a".repeat(64)});},
    ]) {
      const f = fixture(); Object.assign(f.identity, structuredClone(baseline));
      f.validate();
      f.receipt.identity = structuredClone(f.identity); mutate(f.receipt.identity);
      assert.throws(f.validate, /identity mismatch/);
    }
    const odd = "packages/apps/embedded-runtime/tab\tnewline\n[lit]*.txt";
    writeFileSync(resolve(root, odd), "literal");
    assert.throws(() => v2Inputs(root, revision), /committed and clean/);
    const added = commit();
    assert.ok(v2Inputs(root, added).inputs.some(input => input.path === odd && input.sha256 === sha256("literal")));
    assert.throws(() => v2Inputs(root, revision), /source\/input mismatch/);
    runGit(root, "reset", "--hard", revision);
    fs.symlinkSync("fixture.txt", resolve(root, "packages/apps/embedded-runtime/link"));
    const linked = commit();
    assert.throws(() => v2Inputs(root, linked), /non-regular input/);
    runGit(root, "reset", "--hard", revision);
    fs.mkdirSync(resolve(root, "packages/apps/embedded-runtime/submodule"));
    runGit(root, "update-index", "--add", "--cacheinfo", `160000,${revision},packages/apps/embedded-runtime/submodule`);
    runGit(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic gitlink");
    assert.throws(() => v2Inputs(root, runGit(root, "rev-parse", "HEAD")), /non-regular input/);
    runGit(root, "reset", "--hard", revision);
    assert.throws(() => v2Inputs(root, "0".repeat(40)), error => error.status === 128 && !/source\/input mismatch/u.test(error.message));
    const outside = mkdtempSync(resolve(tmpdir(), "v2-no-git-"));
    t.after(() => rmSync(outside, {recursive: true, force: true}));
    assert.throws(() => v2Inputs(outside, revision), error => error.status === 128);
  });
}
