import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link as createHardlink, mkdtemp, mkdir, readFile, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkFeatureModules, formatIssues } from "./check-feature-modules.mjs";
import { CHECKER_LIMITS } from "./feature-module-limits.mjs";
import { STRUCTURAL_CODES } from "./feature-module-profile.mjs";

const fixtureManifest = JSON.parse(await readFile(new URL("./fixtures/feature-module-cases.json", import.meta.url), "utf8"));
const execFileAsync = promisify(execFile);
const authority = {
  id: "agent-teams.feature-module-standard",
  version: "v1",
  repository: "agent-teams-ai/.github",
  path: "docs/architecture/feature-module-standard/v1.md",
  gitBlob: "d0bfff2033faf544fe65268c1dcdfd524d093015",
  sha256: "851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa",
};

const feature = (id, roles = ["domain"]) => ({
  id,
  root: `src/features/${id}`,
  roles,
  entrypoints: { public: `src/features/${id}/index.ts`, internal: `src/features/${id}/internal.ts` },
});

const baseFiles = {
  "architecture/decisions/accepted-decisions.json": `${JSON.stringify({ decisions: [
    { id: "ADR-0007", path: "docs/decisions/0007-deterministic-documentation-governance.md" },
  ] })}\n`,
  "package.json": `${JSON.stringify({
    name: "@fixture/runtime",
    scripts: {
      check: "pnpm test:feature-modules && pnpm architecture:feature-modules:active && pnpm fixture:check",
      "check:fast": "pnpm test:feature-modules && pnpm architecture:feature-modules:active && pnpm fixture:fast",
    },
    agentTeamsArchitecture: { role: "bounded-context", ownerDocument: "ADR-0005" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./composition": { types: "./dist/composition.d.ts", import: "./dist/composition.js" },
    },
  })}\n`,
  "src/features/alpha/README.md": "---\ntype: feature\nstatus: accepted\nowner: \"@fixture/runtime\"\nowner_document: ADR-0005\n---\n\n# Alpha\n",
  "src/features/alpha/index.ts": "export {};\n",
  "src/features/alpha/internal.ts": "export { value } from './domain/value.js';\n",
  "src/features/alpha/domain/value.ts": "export const value = true;\n",
  "src/index.ts": "export { value } from './features/alpha/index.js';\n",
  "src/composition.ts": "export { value } from './features/alpha/internal.js';\n",
};

const secondFiles = {
  "src/features/beta/README.md": "---\ntype: feature\nstatus: accepted\nowner: \"@fixture/runtime\"\nowner_document: ADR-0005\n---\n\n# Beta\n",
  "src/features/beta/index.ts": "export {};\n",
  "src/features/beta/internal.ts": "export { beta } from './domain/value.js';\n",
  "src/features/beta/domain/value.ts": "export const beta = true;\n",
};

const makeFixtureRoot = async () => {
  try { return await mkdtemp(join(tmpdir(), "feature-module-check-")); }
  catch (error) {
    if (error?.code !== "EROFS") {throw error;}
    return mkdtemp(join(process.cwd(), ".feature-module-check-"));
  }
};

const disposableBases = await Promise.all([tmpdir(), process.cwd()].map(async (path) => ({
  lexical: resolve(path),
  canonical: await realpath(path),
})));
const disposableName = /^\.?feature-module-check-[A-Za-z0-9_-]+$/u;
const containedBy = (base, path) => {
  const suffix = relative(base, path);
  return suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const guardedDisposablePath = async (path) => {
  const lexical = resolve(path), lexicalBase = disposableBases.find(({ lexical: base }) => containedBy(base, lexical));
  assert.ok(lexicalBase, `refusing cleanup outside a disposable base: ${basename(lexical)}`);
  assert.match(relative(lexicalBase.lexical, lexical).split(sep)[0], disposableName);
  let canonical;
  try {canonical = await realpath(lexical);}
  catch (error) {if (error?.code === "ENOENT") {return;} throw error;}
  const canonicalBase = disposableBases.find(({ canonical: base }) => containedBy(base, canonical));
  assert.ok(canonicalBase, `refusing cleanup of an external identity: ${basename(lexical)}`);
  assert.match(relative(canonicalBase.canonical, canonical).split(sep)[0], disposableName);
  return lexical;
};
const cleanupDisposablePaths = async (paths) => {
  const guardedPaths = [];
  for (const path of new Set(paths)) {
    const guarded = await guardedDisposablePath(path);
    if (guarded) {guardedPaths.push(guarded);}
  }
  if (guardedPaths.length) {await execFileAsync("rm", ["-rf", "--", ...guardedPaths]);}
};
const scheduledCleanupPaths = [];
const scheduleDisposablePaths = (paths) => {scheduledCleanupPaths.push(...paths);};
after(async () => cleanupDisposablePaths(scheduledCleanupPaths));

const fixtureActivation = (status) => status === "active"
  ? { blockers: [], acceptance: ["zero diagnostics"], authority: { acceptedAdr: "ADR-0013", decisionPath: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md", owner: "architecture", governedRecords: [] }, evidence: { fixtureCommand: "pnpm test:feature-modules", candidateCommand: "pnpm architecture:feature-modules:candidate", productionDiagnostics: 0 } }
  : { blockers: ["fix diagnostics"], acceptance: ["zero diagnostics"], authority: null, evidence: null };

const applyFixtureProfileOverrides = (profile, fixture) => {
  if (fixture.secondFeature) {profile.features.push(feature("beta", fixture.secondRoles));}
  if (fixture.activation) {profile.activation = fixture.activation;}
  if (fixture.activeGovernedRecords) {profile.activation.authority.governedRecords = fixture.activeGovernedRecords;}
  if (fixture.omitActiveAdoption) {delete profile.adoption;}
  for (const path of fixture.activeAdoptionOmit ?? []) {omitNestedField(profile.adoption, path);}
  for (const [path, value] of Object.entries(fixture.activeAdoptionSet ?? {})) {setNestedField(profile.adoption, path, value);}
  for (const path of fixture.activeAdoptionReverse ?? []) {
    const segments = path.split("."), key = segments.pop();
    let parent = profile.adoption;
    for (const segment of segments) {parent = parent[segment];}
    parent[key].reverse();
  }
  if (fixture.omitSchemaMarker) {delete profile.$schema;}
};

const structuralFixtureCoverage = new Set();

const checkerPath = fileURLToPath(new URL("./check-feature-modules.mjs", import.meta.url));
const repositoryRoot = resolve(dirname(checkerPath), "../..");

const fixtureActiveAdoption = () => ({
  moduleRoots: ["."],
  applicationRoots: [],
  excludedRoots: ["excluded"],
  abstractLayout: {
    modules: [{
      moduleRoot: ".",
      sourceRoot: "src",
      featuresRoot: "src/features",
      moduleComposition: "src/composition.ts",
      publicEntrypoint: "src/index.ts",
      testRoot: "tests",
      featureTestsRoot: "tests/features",
      moduleTestsRoot: "tests/package",
    }],
    applications: [],
  },
  localExtensions: {
    language: { sourceExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] },
    packaging: { manifest: "package.json", curatedExports: [".", "./composition"] },
    transport: { publicContractRole: "contracts" },
    composition: {
      moduleFiles: ["index.ts", "composition.ts"],
      featureEntrypoints: ["index.ts", "internal.ts"],
      syntax: "imports-and-named-reexports-only",
    },
  },
  localOwnership: {
    architectureDocument: { path: "docs/architecture/feature-module-standard-v1-candidate.md", owner: "architecture" },
    decisionRecords: [{ id: "ADR-0013", path: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md", owner: "architecture" }],
  },
});

const omitNestedField = (object, path) => {
  const segments = path.split("."), key = segments.pop();
  let parent = object;
  for (const segment of segments) {parent = parent[segment];}
  delete parent[key];
};

const setNestedField = (object, path, value) => {
  const segments = path.split("."), key = segments.pop();
  let parent = object;
  for (const segment of segments) {parent = parent[segment];}
  parent[key] = value;
};

const fixtureProfile = (fixture) => {
  const status = fixture.status ?? "candidate";
  const profile = {
    $schema: fixture.schemaMarker ?? "./profile.schema.json",
    schemaVersion: 1,
    status,
    authority: { ...authority, id: fixture.authorityId ?? authority.id, ...fixture.authorityExtra },
    scope: { productionRoots: ["src"], outOfScope: ["everything else"] },
    moduleRoles: ["contracts", "domain", "application", "adapters", "composition"],
    features: [feature("alpha", fixture.alphaRoles)],
    assemblyFiles: ["src/index.ts", "src/composition.ts"],
    featureEdges: fixture.edges ?? [],
    extensions: fixture.extensions ?? [], deviations: fixture.deviations ?? [], exceptions: fixture.exceptions ?? [],
    enforcement: { candidate: "pnpm architecture:feature-modules:candidate", active: "pnpm architecture:feature-modules:active", fixtures: "pnpm test:feature-modules" },
    activation: fixtureActivation(status),
    adoption: status === "active" ? fixtureActiveAdoption() : undefined,
    ...fixture.profileExtra,
  };
  applyFixtureProfileOverrides(profile, fixture);
  return profile;
};

const fixtureDecisionFiles = (fixture) => fixture.acceptActivationAdr ? {
  "architecture/decisions/accepted-decisions.json": `${JSON.stringify({ decisions: [
    { id: "ADR-0007", path: "docs/decisions/0007-deterministic-documentation-governance.md" },
    { id: "ADR-0013", path: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md" },
  ] })}\n`,
} : {};

const applyFixtureRootScripts = (files, scripts) => {
  if (!scripts) {return;}
  const manifest = JSON.parse(files["package.json"]);
  manifest.scripts = scripts;
  files["package.json"] = `${JSON.stringify(manifest)}\n`;
};

const writeFixtureFiles = async (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      try {await unlink(join(root, path));}
      catch (error) {if (error?.code !== "ENOENT") {throw error;}}
      continue;
    }
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const applyFixtureSymlinks = async (root, links = [], externalRoot) => {
  for (const link of links) {
    const linkPath = join(root, link.path), targetPath = join(link.outsideRoot ? externalRoot : root, link.target);
    await mkdir(dirname(targetPath), { recursive: true });
    if (link.existingTarget) {await unlink(linkPath);}
    else {await rename(linkPath, targetPath);}
    const target = relative(dirname(linkPath), targetPath);
    const type = link.kind === "directory" ? process.platform === "win32" ? "junction" : "dir" : "file";
    await symlink(target, linkPath, type);
  }
};

const applyFixtureHardlinks = async (root, links = []) => {
  for (const hardlink of links) {
    const target = join(root, hardlink.path);
    await mkdir(dirname(target), { recursive: true });
    await createHardlink(join(root, hardlink.source), target);
  }
};

const fixtureRootIdentity = async (root, mode) => {
  if (!mode) {return { root, cleanup: [root] };}
  if (mode === "symlink") {
    const link = `${root}-root-link`;
    await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
    return { root: link, cleanup: [link, root] };
  }
  if (mode === "symlink-ancestor") {
    const container = `${root}-root-container`, link = `${root}-root-ancestor-link`;
    await mkdir(container);
    await rename(root, join(container, "fixture"));
    await symlink(container, link, process.platform === "win32" ? "junction" : "dir");
    return { root: join(link, "fixture"), cleanup: [link, container] };
  }
  throw new Error(`unsupported fixture root mode: ${mode}`);
};

const fixtureAcceptedDecisions = (fixture) => {
  const decisions = new Map([["ADR-0007", "docs/decisions/0007-deterministic-documentation-governance.md"]]);
  if (fixture.acceptActivationAdr) {decisions.set("ADR-0013", "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md");}
  return decisions;
};

const runCheckerCli = (root, profilePath, arguments_) => execFileAsync(process.execPath, [checkerPath, "--root", root, "--profile", profilePath, ...arguments_])
  .catch((error) => error);

const assertStructuralAllowance = async (fixture, root, profilePath, structuralCodes) => {
  if (!structuralCodes.size || structuralCodes.has("FM_PROFILE_STATUS")) {return;}
  const failure = await runCheckerCli(root, profilePath, ["--allow-diagnostics"]);
  assert.equal(failure.code, 1, `${fixture.name}: structural diagnostics must remain fatal under --allow-diagnostics`);
};

const assertRequireActive = async (fixture, root, profilePath) => {
  if (!fixture.cliRequireActive) {return;}
  const cliArguments = ["--require-active", ...(fixture.cliAllowDiagnostics ? ["--allow-diagnostics"] : [])];
  const failure = await runCheckerCli(root, profilePath, cliArguments);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /^profile\.json:1 FM_PROFILE_STATUS profile status must be active$/mu);
  assert.match(failure.stdout, /Feature Module Standard active: 1 diagnostic\(s\)\. No conformance claim\./u);
};

const assertAllowDiagnosticsFailure = async (fixture, root, profilePath) => {
  if (!fixture.cliAllowDiagnosticsFails) {return;}
  const failure = await runCheckerCli(root, profilePath, ["--allow-diagnostics"]);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /No conformance claim\./u);
};

const assertCliRuns = async (fixture, root, profilePath) => {
  for (const cli of fixture.cliRuns ?? []) {
    const result = await runCheckerCli(root, profilePath, cli.arguments ?? []);
    assert.equal(result.code ?? 0, cli.exit, `${fixture.name}: ${cli.arguments?.join(" ") ?? "default"}`);
    assert.match(result.stdout, new RegExp(cli.output, "u"));
    for (const forbidden of cli.notOutput ?? []) {assert.doesNotMatch(result.stdout, new RegExp(forbidden, "u"));}
  }
};

const runFixture = async (fixture, initialRoot, state) => {
  const profile = fixtureProfile(fixture);
  const profilePath = fixture.profilePath ?? "profile.json";
  let profileSource = fixture.profileSource ?? JSON.stringify(profile, null, 2);
  if (fixture.profileDuplicate) {
    const duplicate = `${JSON.stringify(fixture.profileDuplicate.key)}: ${JSON.stringify(fixture.profileDuplicate.value)},`;
    profileSource = profileSource.replace(/^\{/u, `{\n  ${duplicate}`);
  }
  const files = {
    ...baseFiles,
    ...fixtureDecisionFiles(fixture),
    ...(fixture.secondFeature ? secondFiles : {}),
    ...fixture.files,
    [profilePath]: profileSource.endsWith("\n") ? profileSource : `${profileSource}\n`,
  };
  applyFixtureRootScripts(files, fixture.rootScripts);
  if (fixture.generatedImports) {
    files[fixture.generatedImports.path] = Array.from(
      { length: fixture.generatedImports.count },
      (_, index) => `import * as value${index} from '${fixture.generatedImports.specifier}';`,
    ).join("\n");
  }
  for (let index = 0; index < (fixture.generatedFiles?.count ?? 0); index += 1) {
    const extension = fixture.generatedFiles.extension ?? ".ts";
    files[`${fixture.generatedFiles.directory}/file-${String(index).padStart(5, "0")}${extension}`] = extension === ".ts" ? `export const value${index} = true;\n` : "fixture\n";
  }
  if (fixture.generatedLargeFile) {files[fixture.generatedLargeFile.path] = " ".repeat(fixture.generatedLargeFile.bytes);}
  if (fixture.generatedSourceFile) {
    const separator = fixture.generatedSourceFile.separator ?? "\n";
    files[fixture.generatedSourceFile.path] = `${fixture.generatedSourceFile.prefix ?? ""}${`${fixture.generatedSourceFile.line ?? "export {};"}${separator}`.repeat(fixture.generatedSourceFile.lines)}${fixture.generatedSourceFile.suffix ?? ""}`;
  }
  await writeFixtureFiles(initialRoot, files);
  await applyFixtureHardlinks(initialRoot, fixture.hardlinks);
  const externalRoot = `${initialRoot}-symlink-targets`;
  if (fixture.symlinks?.some(({ outsideRoot }) => outsideRoot)) {state.cleanup.push(externalRoot);}
  await applyFixtureSymlinks(initialRoot, fixture.symlinks, externalRoot);
  const identity = await fixtureRootIdentity(initialRoot, fixture.rootMode);
  state.cleanup = [...identity.cleanup, ...state.cleanup.filter((path) => path !== initialRoot)];
  const decisionOptions = fixture.useDecisionRegistry ? {} : { acceptedDecisions: fixtureAcceptedDecisions(fixture) };
  const actual = (await checkFeatureModules({ root: identity.root, profilePath, requiredStatus: fixture.requiredStatus, ...decisionOptions }))
    .map(({ code, path, line }) => ({ code, path, line }));
  if (fixture.assertOverflow) {
    assert.equal(actual.filter(({ code }) => code === "FM_CHECKER_OVERFLOW").length, 1);
    assert.ok(actual.length <= CHECKER_LIMITS.diagnostics);
    assert.ok(Buffer.byteLength(formatIssues(await checkFeatureModules({ root: identity.root, profilePath, ...decisionOptions })), "utf8") <= CHECKER_LIMITS.renderedBytes);
  } else {assert.deepEqual(actual, fixture.expected);}
  if (fixture.doubleRun || fixture.assertOverflow) {
    const repeated = (await checkFeatureModules({ root: identity.root, profilePath, requiredStatus: fixture.requiredStatus, ...decisionOptions }))
      .map(({ code, path, line }) => ({ code, path, line }));
    assert.deepEqual(repeated, actual);
  }
  const structuralCodes = new Set(actual.map(({ code }) => code).filter((code) => STRUCTURAL_CODES.has(code)));
  for (const code of structuralCodes) {structuralFixtureCoverage.add(code);}
  await assertStructuralAllowance(fixture, identity.root, profilePath, structuralCodes);
  await assertRequireActive(fixture, identity.root, profilePath);
  await assertAllowDiagnosticsFailure(fixture, identity.root, profilePath);
  await assertCliRuns(fixture, identity.root, profilePath);
};

const expandedFixtures = fixtureManifest.cases.flatMap((fixture) => fixture.activeAdoptionOmitEach?.map((path) => ({
  ...fixture,
  activeAdoptionOmit: [path],
  name: `${fixture.name}-${path.replaceAll(".", "-")}`,
})) ?? [fixture]);

for (const fixture of expandedFixtures) {
  test(fixture.name, async () => {
    const root = await makeFixtureRoot();
    const state = { cleanup: [root] };
    try {await runFixture(fixture, root, state);}
    finally {scheduleDisposablePaths(state.cleanup);}
  });
}

test("CLI failures redact external profile locations and are location-independent", async () => {
  const roots = [await makeFixtureRoot(), await makeFixtureRoot()];
  try {
    const outputs = [];
    for (const root of roots) {
      const externalProfile = join(dirname(root), "private", "missing-profile.json");
      const failure = await execFileAsync(process.execPath, [checkerPath, "--root", root, "--profile", externalProfile]).catch((error) => error);
      assert.equal(failure.code, 1);
      assert.match(failure.stdout, /^<profile>:1 FM_FILESYSTEM_IDENTITY /mu);
      assert.doesNotMatch(failure.stdout, /Require stack:|\/private\/|feature-module-check-/u);
      outputs.push(failure.stdout);
    }
    assert.equal(outputs[0], outputs[1]);
  } finally {scheduleDisposablePaths(roots);}
});

test("candidate scope and output use canonical root identity through a symlink alias", async () => {
  const root = await makeFixtureRoot(), alias = join(root, "repository-link");
  try {
    await symlink(repositoryRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const options = { profilePath: "architecture/feature-module-standard/candidate-profile.json" };
    const canonical = await checkFeatureModules({ root: repositoryRoot, ...options });
    const throughAlias = await checkFeatureModules({ root: alias, ...options });
    assert.deepEqual(canonical, [], "active scoped tree must remain zero-diagnostic through canonical identity");
    assert.deepEqual(throughAlias, canonical);
  } finally {scheduleDisposablePaths([root]);}
});

test("root traversal, drive, UNC, and POSIX backslash spellings fail closed", async () => {
  const root = await makeFixtureRoot();
  try {
    for (const spelling of [`${root}${sep}..`, "C:\\private\\fixture", "\\\\server\\share\\fixture", "//server/share/fixture"]) {
      const actual = await checkFeatureModules({ root: spelling, profilePath: "profile.json" });
      assert.deepEqual(actual.map(({ code, path, line }) => ({ code, path, line })), [
        { code: "FM_FILESYSTEM_IDENTITY", path: "<root>", line: 1 },
      ]);
    }
    if (process.platform !== "win32") {
      const unsafeRoot = join(root, "literal\\segment");
      await mkdir(unsafeRoot);
      const actual = await checkFeatureModules({ root: unsafeRoot, profilePath: "profile.json" });
      assert.deepEqual(actual.map(({ code, path, line }) => ({ code, path, line })), [
        { code: "FM_FILESYSTEM_IDENTITY", path: "<root>", line: 1 },
      ]);
    }
  } finally {scheduleDisposablePaths([root]);}
});

test("CLI structural allowance matrix covers every fatal code", () => {
  assert.deepEqual([...structuralFixtureCoverage].toSorted(), [...STRUCTURAL_CODES].toSorted());
});
