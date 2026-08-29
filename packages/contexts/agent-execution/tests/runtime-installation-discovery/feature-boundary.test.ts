import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSync } from "oxc-parser";

import {
  createRuntimeInstallationDiscoveryFeature,
  type ExecutableFileObserver,
} from "../../dist/composition.js";
import { mapDiscoverClaudeCodeInstallations } from "../../dist/features/runtime-installation-discovery/adapters/inbound/public-runtime-installation-discovery.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const collectTypeScriptSources = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? collectTypeScriptSources(path)
        : Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

const moduleSpecifiers = (path: string, source: string): string[] => {
  const parsed = parseSync(path, source);
  assert.deepEqual(parsed.errors, [], `Oxc could not parse ${path}`);
  return [
    ...parsed.module.staticImports.map(entry => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap(entry =>
      entry.entries.flatMap(item =>
        item.moduleRequest === null ? [] : [item.moduleRequest.value],
      ),
    ),
  ];
};

const exportedNames = (path: string, source: string): string[] => {
  const parsed = parseSync(path, source);
  assert.deepEqual(parsed.errors, [], `Oxc could not parse ${path}`);
  return parsed.module.staticExports
    .flatMap(statement => statement.entries)
    .flatMap(entry =>
      entry.exportName.name === null ? [] : [entry.exportName.name])
    .toSorted();
};

const referenceCandidate = (
  name: string,
  authorizedFileIdentity: string,
) => ({
  absolutePath: `/authorized/${name}`,
  authorizedFileIdentity,
  candidateIdentity: `candidate:${name}`,
  canonicalPath: `/canonical/${name}`,
  custodyRoot: {
    absolutePath: "/authorized",
    canonicalPath: "/canonical",
  },
  displayPath: name,
  priorityRank: 1 as const,
  required: true,
  source: "explicit" as const,
});

test("Node digest adapter preserves exact installation and candidate refs", async () => {
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ authorizedFileIdentity }) {
        return authorizedFileIdentity === "found"
          ? { identity: "stable-identity", kind: "found" }
          : { kind: "invalid" };
      },
    },
  });
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [
      referenceCandidate("found", "found"),
      referenceCandidate("invalid", "invalid"),
    ],
    observationEpoch: "epoch-reference-digest",
  });

  assert.equal(
    result.installations[0]?.installationRef,
    `claude-code-installation:${createHash("sha256").update("stable-identity").digest("hex")}`,
  );
  assert.equal(
    result.diagnostics[0]?.candidateRef,
    `claude-code-candidate:${createHash("sha256").update("candidate:invalid").digest("hex")}`,
  );
  const codexResult = await feature.discoverCodexInstallations.execute({
    candidates: [{
      absolutePath: "/authorized/codex",
      authorizedFileIdentity: "found",
      canonicalPath: "/canonical/codex",
      custodyRoot: {
        absolutePath: "/authorized",
        canonicalPath: "/canonical",
      },
      displayPath: "codex",
      required: true,
      source: "explicit",
    }],
    observationEpoch: "epoch-codex-reference-digest",
  });
  assert.equal(
    codexResult.installations[0]?.installationRef,
    `codex-installation:${createHash("sha256").update("stable-identity").digest("hex")}`,
  );
});

test("observer boundary explicitly maps every result union variant", async () => {
  const outcomes = new Map<string, object>([
    ["found", { identity: "found-identity", kind: "found" }],
    ["missing", { kind: "missing" }],
    ["denied", { kind: "denied" }],
    ["invalid", { kind: "invalid" }],
    ["unstable", { kind: "unstable" }],
    ["unreadable", { kind: "unreadable" }],
  ]);
  const observedRequests: object[] = [];
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(request) {
        observedRequests.push(request);
        return {
          ...outcomes.get(request.authorizedFileIdentity ?? "missing"),
          observerUnknown: true,
        } as Awaited<ReturnType<ExecutableFileObserver["observe"]>>;
      },
    },
  });

  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [...outcomes.keys()].map(value => ({
      absolutePath: `/authorized/${value}`,
      authorizedFileIdentity: value,
      candidateIdentity: `candidate:explicit:${value}`,
      canonicalPath: `/canonical/${value}`,
      custodyRoot: {
        absolutePath: "/authorized",
        canonicalPath: "/canonical",
      },
      displayPath: value,
      priorityRank: 1,
      publicUnknown: true,
      required: true,
      source: "explicit",
    })),
    observationEpoch: "epoch-observer-boundary",
  });

  assert.ok(observedRequests.every(request =>
    !Object.hasOwn(request, "publicUnknown") &&
    Object.keys(request).every(key => [
      "absolutePath",
      "authorizedFileIdentity",
      "custodyBoundary",
      "expectedCanonicalPath",
    ].includes(key))));
  assert.equal(result.installations.length, 1);
  assert.deepEqual(
    result.diagnostics.map(diagnostic => diagnostic.code),
    [
      "candidate_denied",
      "candidate_invalid",
      "candidate_invalid",
      "candidate_unreadable",
      "candidate_unstable",
    ],
  );
  assert.equal(JSON.stringify(result).includes("observerUnknown"), false);
});

test("public boundary strips unknown request and result fields", async () => {
  const signal = new AbortController().signal;
  const discovery = mapDiscoverClaudeCodeInstallations({
    async execute(input, options) {
      assert.deepEqual(input, {
        candidates: [{
          absolutePath: "/authorized/public",
          authorizedFileIdentity: "authorized-public",
          candidateIdentity: "candidate:explicit:public",
          canonicalPath: "/canonical/public",
          custodyRoot: {
            absolutePath: "/authorized",
            canonicalPath: "/canonical",
          },
          displayPath: "public",
          priorityRank: 1,
          required: true,
          source: "explicit",
        }],
        observationEpoch: "epoch-boundary",
      });
      assert.deepEqual(options, { signal });
      return {
        diagnostics: [{
          candidateRef: "candidate-ref",
          code: "candidate_invalid" as const,
          internalDiagnostic: true,
        }],
        installations: [{
          aliases: [{
            displayPath: "public",
            internalAlias: true,
            source: "explicit" as const,
          }],
          installationRef: "installation-ref",
          internalInstallation: true,
          status: "found_unverified" as const,
        }],
        internalResult: true,
      };
    },
  });
  const publicCandidate = {
    absolutePath: "/authorized/public",
    authorizedFileIdentity: "authorized-public",
    candidateIdentity: "candidate:explicit:public",
    canonicalPath: "/canonical/public",
    custodyRoot: {
      absolutePath: "/authorized",
      canonicalPath: "/canonical",
      publicNestedUnknown: true,
    },
    displayPath: "public",
    priorityRank: 1 as const,
    publicCandidateUnknown: true,
    required: true,
    source: "explicit" as const,
  };
  const publicInput = {
    candidates: [publicCandidate],
    observationEpoch: "epoch-boundary",
    publicInputUnknown: true,
  };
  const publicOptions = { publicOptionsUnknown: true, signal };

  const result = await discovery.execute(publicInput, publicOptions);

  assert.deepEqual(result, {
    diagnostics: [{ candidateRef: "candidate-ref", code: "candidate_invalid" }],
    installations: [{
      aliases: [{ displayPath: "public", source: "explicit" }],
      installationRef: "installation-ref",
      status: "found_unverified",
    }],
  });
});

test("application imports and public declarations remain inward", async () => {
  const featureRoot = join(
    packageRoot,
    "src/features/runtime-installation-discovery",
  );
  const applicationRoot = join(featureRoot, "application");
  for (const path of await collectTypeScriptSources(applicationRoot)) {
    for (const specifier of moduleSpecifiers(path, await readFile(path, "utf8"))) {
      assert.equal(
        specifier.startsWith("."),
        true,
        `application imports an external module or package barrel: ${path} -> ${specifier}`,
      );
      const target = resolve(dirname(path), specifier);
      assert.equal(
        target.startsWith(`${applicationRoot}/`),
        true,
        `application imports across the inward boundary: ${path} -> ${specifier}`,
      );
      assert.doesNotMatch(
        specifier,
        /(?:^|\/)index\.js$/u,
        `application imports a barrel: ${path} -> ${specifier}`,
      );
    }
  }

  const declarationRoot = join(
    packageRoot,
    "dist/features/runtime-installation-discovery",
  );
  const featureEntrypoint = join(declarationRoot, "index.d.ts");
  assert.deepEqual(
    exportedNames(featureEntrypoint, await readFile(featureEntrypoint, "utf8")),
    [
      "ClaudeCodeInstallationCandidate",
      "ClaudeCodeInstallationCandidateSource",
      "ClaudeCodeInstallationDiagnostic",
      "ClaudeCodeInstallationObservation",
      "DiscoverClaudeCodeInstallations",
      "DiscoverClaudeCodeInstallationsInput",
      "DiscoverClaudeCodeInstallationsResult",
      "DiscoverCodexInstallations",
      "DiscoverCodexInstallationsInput",
      "DiscoverCodexInstallationsResult",
      "InstallationCandidate",
      "InstallationCandidateSource",
      "RuntimeInstallationDiagnostic",
      "RuntimeInstallationObservation",
    ].toSorted(),
  );
  const featureCompositionEntrypoint = join(declarationRoot, "internal.d.ts");
  assert.deepEqual(
    exportedNames(
      featureCompositionEntrypoint,
      await readFile(featureCompositionEntrypoint, "utf8"),
    ),
    [
      "ExecutableFileObservation",
      "ExecutableFileObservationRequest",
      "ExecutableFileObserver",
      "RuntimeInstallationDiscoveryDependencies",
      "createNodeExecutableFileObserver",
      "createRuntimeInstallationDiscoveryFeature",
    ].toSorted(),
  );
  const pending = [featureEntrypoint, featureCompositionEntrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    assert.ok(path !== undefined);
    if (visited.has(path)) {
      continue;
    }
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of moduleSpecifiers(path, source)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = resolve(
        dirname(path),
        specifier.replace(/\.js$/u, ".d.ts"),
      );
      assert.doesNotMatch(
        target,
        /\/(?:application|adapters|domain|composition)\//u,
        `public declaration leaks a feature internal: ${path} -> ${target}`,
      );
      pending.push(target);
    }
  }
  assert.ok([...visited].some(path =>
    path.endsWith("contracts/runtime-installation-observation.d.ts")));
  assert.ok([...visited].some(path =>
    path.endsWith("contracts/claude-code-installation-observation.d.ts")));

  const packageEntrypoint = join(packageRoot, "dist/index.d.ts");
  const compositionEntrypoint = join(packageRoot, "dist/composition.d.ts");
  assert.deepEqual(
    [...new Set(
      moduleSpecifiers(packageEntrypoint, await readFile(packageEntrypoint, "utf8"))
        .filter(specifier => specifier.includes("runtime-installation-discovery")),
    )],
    ["./features/runtime-installation-discovery/index.js"],
  );
  assert.deepEqual(
    [...new Set(
      moduleSpecifiers(
        compositionEntrypoint,
        await readFile(compositionEntrypoint, "utf8"),
      ).filter(specifier => specifier.includes("runtime-installation-discovery")),
    )],
    ["./features/runtime-installation-discovery/internal.js"],
  );
  for (const entrypoint of [packageEntrypoint, compositionEntrypoint]) {
    assert.equal(
      exportedNames(entrypoint, await readFile(entrypoint, "utf8"))
        .includes("RuntimeInstallationDiscoveryFeature"),
      false,
      `${entrypoint} exports the unauthorized feature composition type`,
    );
  }
});
