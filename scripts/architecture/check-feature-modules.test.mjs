import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkFeatureModules } from "./check-feature-modules.mjs";

const fixtureManifest = JSON.parse(await readFile(new URL("./fixtures/feature-module-cases.json", import.meta.url), "utf8"));
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
  "package.json": "{\"name\":\"@fixture/runtime\"}\n",
  "src/features/alpha/index.ts": "export {};\n",
  "src/features/alpha/internal.ts": "export { value } from './domain/value.js';\n",
  "src/features/alpha/domain/value.ts": "export const value = true;\n",
  "src/index.ts": "export { value } from './features/alpha/index.js';\n",
  "src/composition.ts": "export { value } from './features/alpha/internal.js';\n",
};

const secondFiles = {
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
        extensions: [], deviations: [], exceptions: fixture.exceptions ?? [],
        enforcement: { candidate: "pnpm architecture:feature-modules:candidate", active: "pnpm architecture:feature-modules:active", fixtures: "pnpm test:feature-modules" },
        activation: status === "active"
          ? { blockers: [], acceptance: ["zero diagnostics"], authority: { acceptedAdr: "ADR-0007", owner: "architecture" }, evidence: { fixtureCommand: "pnpm test:feature-modules", candidateCommand: "pnpm architecture:feature-modules:candidate", productionDiagnostics: 0 } }
          : { blockers: ["fix diagnostics"], acceptance: ["zero diagnostics"], authority: null, evidence: null },
        ...fixture.profileExtra,
      };
      if (fixture.activation) {profile.activation = fixture.activation;}
      const files = { ...baseFiles, ...(fixture.secondFeature ? secondFiles : {}), ...fixture.files, "profile.json": `${JSON.stringify(profile, null, 2)}\n` };
      for (const [path, content] of Object.entries(files)) {
        if (content === null) {continue;}
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
      const actual = (await checkFeatureModules({ root, profilePath: "profile.json", requiredStatus: fixture.requiredStatus })).map(({ code, path, line }) => ({ code, path, line }));
      assert.deepEqual(actual, fixture.expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
