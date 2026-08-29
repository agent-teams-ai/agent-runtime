import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkFeatureModules } from "./check-feature-modules.mjs";
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
    agentTeamsArchitecture: { role: "bounded-context", ownerDocument: "ADR-0005" },
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./composition": { types: "./dist/composition.d.ts", import: "./dist/composition.js" },
    },
  })}\n`,
  "src/features/alpha/README.md": "---\ntype: feature\nstatus: accepted\nowner: @fixture/runtime\nowner_document: ADR-0005\n---\n\n# Alpha\n",
  "src/features/alpha/index.ts": "export {};\n",
  "src/features/alpha/internal.ts": "export { value } from './domain/value.js';\n",
  "src/features/alpha/domain/value.ts": "export const value = true;\n",
  "src/index.ts": "export { value } from './features/alpha/index.js';\n",
  "src/composition.ts": "export { value } from './features/alpha/internal.js';\n",
};

const secondFiles = {
  "src/features/beta/README.md": "---\ntype: feature\nstatus: accepted\nowner: @fixture/runtime\nowner_document: ADR-0005\n---\n\n# Beta\n",
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

const structuralFixtureCoverage = new Set();

for (const fixture of fixtureManifest.cases) {
  test(fixture.name, async () => {
    const root = await makeFixtureRoot();
    try {
      const features = [feature("alpha", fixture.alphaRoles)];
      if (fixture.secondFeature) {features.push(feature("beta", fixture.secondRoles));}
      const status = fixture.status ?? "candidate";
      const profile = {
        schemaVersion: 1,
        status,
        authority: { ...authority, id: fixture.authorityId ?? authority.id, ...fixture.authorityExtra },
        scope: { productionRoots: ["src"], outOfScope: ["everything else"] },
        moduleRoles: ["contracts", "domain", "application", "adapters", "composition"],
        features,
        assemblyFiles: ["src/index.ts", "src/composition.ts"],
        featureEdges: fixture.edges ?? [],
        extensions: fixture.extensions ?? [], deviations: fixture.deviations ?? [], exceptions: fixture.exceptions ?? [],
        enforcement: { candidate: "pnpm architecture:feature-modules:candidate", active: "pnpm architecture:feature-modules:active", fixtures: "pnpm test:feature-modules" },
        activation: status === "active"
          ? { blockers: [], acceptance: ["zero diagnostics"], authority: { acceptedAdr: "ADR-0013", decisionPath: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md", owner: "architecture", governedRecords: [] }, evidence: { fixtureCommand: "pnpm test:feature-modules", candidateCommand: "pnpm architecture:feature-modules:candidate", productionDiagnostics: 0 } }
          : { blockers: ["fix diagnostics"], acceptance: ["zero diagnostics"], authority: null, evidence: null },
        ...fixture.profileExtra,
      };
      if (fixture.activation) {profile.activation = fixture.activation;}
      const decisionFiles = fixture.acceptActivationAdr ? {
        "architecture/decisions/accepted-decisions.json": `${JSON.stringify({ decisions: [
          { id: "ADR-0007", path: "docs/decisions/0007-deterministic-documentation-governance.md" },
          { id: "ADR-0013", path: "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md" },
        ] })}\n`,
      } : {};
      const files = { ...baseFiles, ...decisionFiles, ...(fixture.secondFeature ? secondFiles : {}), ...fixture.files, "profile.json": `${JSON.stringify(profile, null, 2)}\n` };
      for (const [path, content] of Object.entries(files)) {
        if (content === null) {continue;}
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
      const acceptedDecisions = new Map([["ADR-0007", "docs/decisions/0007-deterministic-documentation-governance.md"]]);
      if (fixture.acceptActivationAdr) {acceptedDecisions.set("ADR-0013", "docs/decisions/0013-feature-module-standard-v1-candidate-adoption.md");}
      const decisionOptions = fixture.useDecisionRegistry ? {} : { acceptedDecisions };
      const actual = (await checkFeatureModules({ root, profilePath: "profile.json", requiredStatus: fixture.requiredStatus, ...decisionOptions })).map(({ code, path, line }) => ({ code, path, line }));
      assert.deepEqual(actual, fixture.expected);
      const structuralCodes = new Set(fixture.expected.map(({ code }) => code).filter((code) => STRUCTURAL_CODES.has(code)));
      for (const code of structuralCodes) {structuralFixtureCoverage.add(code);}
      if (structuralCodes.size && !structuralCodes.has("FM_PROFILE_STATUS")) {
        const failure = await execFileAsync(process.execPath, [fileURLToPath(new URL("./check-feature-modules.mjs", import.meta.url)), "--root", root, "--profile", "profile.json", "--allow-diagnostics"]).catch((error) => error);
        assert.equal(failure.code, 1, `${fixture.name}: structural diagnostics must remain fatal under --allow-diagnostics`);
      }
      if (fixture.cliRequireActive) {
        const args = [fileURLToPath(new URL("./check-feature-modules.mjs", import.meta.url)), "--root", root, "--profile", "profile.json", "--require-active"];
        if (fixture.cliAllowDiagnostics) {args.push("--allow-diagnostics");}
        const failure = await execFileAsync(process.execPath, args).catch((error) => error);
        assert.equal(failure.code, 1);
        assert.match(failure.stdout, /^profile\.json:1 FM_PROFILE_STATUS profile status must be active$/mu);
        assert.match(failure.stdout, /Feature Module Standard active: 1 diagnostic\(s\)\. No conformance claim\./u);
      }
      if (fixture.cliAllowDiagnosticsFails) {
        const failure = await execFileAsync(process.execPath, [fileURLToPath(new URL("./check-feature-modules.mjs", import.meta.url)), "--root", root, "--profile", "profile.json", "--allow-diagnostics"]).catch((error) => error);
        assert.equal(failure.code, 1);
        assert.match(failure.stdout, /No conformance claim\./u);
      }
      for (const cli of fixture.cliRuns ?? []) {
        const result = await execFileAsync(process.execPath, [fileURLToPath(new URL("./check-feature-modules.mjs", import.meta.url)), "--root", root, "--profile", "profile.json", ...(cli.arguments ?? [])]).catch((error) => error);
        assert.equal(result.code ?? 0, cli.exit, `${fixture.name}: ${cli.arguments?.join(" ") ?? "default"}`);
        assert.match(result.stdout, new RegExp(cli.output, "u"));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("CLI structural allowance matrix covers every fatal code", () => {
  assert.deepEqual([...structuralFixtureCoverage].toSorted(), [...STRUCTURAL_CODES].toSorted());
});
