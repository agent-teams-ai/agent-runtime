import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sourceFixture, commit, git, evidenceInput } from "./support/provider-candidate-source-fixture.mjs";
import { sha256 } from "../../live/provider-candidate-build-tree.mjs";
import { execFileAsync, buildEnvironment } from "../../live/provider-candidate-source.mjs";

test("stale dist copier compiler is rejected against independent qualification before execution", async t => {
  const fixture = await sourceFixture(t);
  const first = await fixture.resolve();
  const stale = await readFile(fixture.buildPath);
  const marker = join(fixture.root, "node_modules/copier-executed");
  const compiler = join(fixture.root, "node_modules/typescript/bin/tsc");
  const copier = `import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const pkg = dirname(process.argv[process.argv.indexOf('--project') + 1]);
await writeFile(${JSON.stringify(marker)}, 'executed');
await mkdir(join(pkg, 'dist'), {recursive: true});
await cp(join(${JSON.stringify(fixture.root)}, pkg, 'dist'), join(pkg, 'dist'), {recursive: true});
`;
  await writeFile(compiler, copier);
  await writeFile(fixture.sourcePath, "export const freshBuild: number = 2;\n");
  await commit(fixture.root);
  assert.notEqual(await git(fixture.root, "rev-parse", "HEAD"), first.sourceSha);
  assert.equal(await git(fixture.root, "status", "--porcelain"), "");

  // Execute only this disposable attack specimen to establish it really copies
  // old output into an empty build directory. No TypeScript/provider/native run.
  const demonstration = await mkdtemp(join(tmpdir(), "ar-stale-copier-example-"));
  t.after(() => rm(demonstration, {recursive: true, force: true}));
  await execFileAsync(process.execPath, [compiler, "--project", "packages/contexts/agent-execution/tsconfig.json"], {
    cwd: demonstration, env: buildEnvironment, timeout: 10_000,
  });
  assert.deepEqual(await readFile(join(demonstration, "packages/contexts/agent-execution/dist/runtime.js")), stale);
  assert.equal(await readFile(marker, "utf8"), "executed");
  await rm(marker);

  await assert.rejects(fixture.resolve(), /does not match separately trusted qualification/u);
  await assert.rejects(readFile(marker), {code: "ENOENT"});
  assert.deepEqual(await readFile(fixture.buildPath), stale);
  assert.equal(await readFile(compiler, "utf8"), copier);
  await assert.rejects(fixture.authority.revalidateCanaryExecutionProvenance(first), /changed during execution/u);
});

test("unchanged compiler entrypoint cannot hide substituted dependency modules", async t => {
  const fixture = await sourceFixture(t);
  const compiler = join(fixture.root, "node_modules/typescript/bin/tsc");
  const before = await readFile(compiler);
  await mkdir(join(fixture.root, "node_modules/typescript/lib"));
  await writeFile(join(fixture.root, "node_modules/typescript/lib/injected.mjs"), "throw new Error('substituted');\n");
  assert.equal(sha256(await readFile(compiler)), fixture.qualification.compilerDigest);
  await assert.rejects(fixture.resolve(), /does not match separately trusted qualification/u);
  assert.deepEqual(await readFile(compiler), before);
});

test("missing or malformed outer qualification cannot authorize workspace tools", async t => {
  const fixture = await sourceFixture(t);
  const input = Object.freeze({provider: fixture.providerId, canaryId: fixture.canaryId,
    claimedSourceSha: await git(fixture.root, "rev-parse", "HEAD"),
    canarySourceUrl: pathToFileURL(fixture.canaryPath).href,
    buildRootUrl: pathToFileURL(join(fixture.root, "packages/contexts/agent-execution/dist")).href});
  const resolve = fixture.authority.resolveCanaryExecutionProvenance;
  await assert.rejects(resolve(input), /separately trusted exact build-toolchain qualification required/u);
  await assert.rejects(resolve(Object.freeze({...input, trustedBuildQualification: fixture.qualification})), TypeError);
  let calls = 0;
  const getter = {get() {calls += 1; throw new Error("must never evaluate");}, enumerable: true};
  for (const value of [null, {...fixture.qualification},
    new Proxy(fixture.qualification, {get() {calls += 1; throw new Error("proxy");}}),
    Object.freeze(Object.defineProperty({...fixture.qualification}, "compilerDigest", getter)),
    Object.freeze({...fixture.qualification, rawPath: "/private/untrusted"}),
    Object.freeze({...fixture.qualification, compilerDigest: "a".repeat(65)}),
  ]) {await assert.rejects(resolve(input, value), TypeError);}
  assert.equal(calls, 0);
  for (const key of ["compilerDigest", "nodeDigest", "dependenciesDigest", "nativeHelperDigest", "packageClosureDigest"]) {
    await assert.rejects(fixture.resolve({}, Object.freeze({...fixture.qualification, [key]: "0".repeat(64)})),
      /does not match separately trusted qualification/u);
  }
  for (const patch of [{profile: "ambient-toolchain"}, {nodeVersion: "v0.0.0"},
    {platform: "unknown"}, {architecture: "unknown"}]) {
    await assert.rejects(fixture.resolve({}, Object.freeze({...fixture.qualification, ...patch})), TypeError);
  }
});

test("independently pinned fixture tools produce deterministic receipt and canonical toolchain identity", async t => {
  const fixture = await sourceFixture(t);
  const qualification = fixture.qualification;
  const canonical = Object.fromEntries(Object.entries(qualification).sort(([a], [b]) => a.localeCompare(b, "en")));
  const execution = await fixture.resolve();
  assert.equal(execution.build.compilerDigest, qualification.compilerDigest);
  assert.equal(execution.build.toolchainQualificationDigest, sha256(JSON.stringify(canonical)));
  const reversed = Object.freeze(Object.fromEntries(Object.entries(qualification).reverse()));
  assert.deepEqual(await fixture.resolve({}, reversed), execution);
  const envelope = await fixture.authority.createProviderCandidateEvidenceEnvelope(evidenceInput(fixture, execution));
  assert.equal(envelope.buildIdentity.compilerDigest, `sha256:${qualification.compilerDigest}`);
  assert.equal(envelope.buildIdentity.toolchainQualificationDigest, `sha256:${execution.build.toolchainQualificationDigest}`);
  assert.doesNotMatch(JSON.stringify(envelope), /\/tmp\/|node_modules|bin\/tsc|node-only/u);
});

test("Node qualification cannot authorize the unqualified native compiler and headers", {skip: process.platform !== "linux"}, async t => {
  const fixture = await sourceFixture(t);
  const native = join(fixture.root, "packages/platform/filesystem-custody/native");
  await mkdir(native);
  await writeFile(join(native, "rename-no-replace.c"), "/* native toolchain required */\n");
  await commit(fixture.root);
  await assert.rejects(fixture.resolve(), /native compiler\/header toolchain qualification is unavailable/u);
});
