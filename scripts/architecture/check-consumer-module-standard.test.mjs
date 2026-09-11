import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadConsumerModuleStandardInputs,
  validateConsumerModuleStandard,
} from "./check-consumer-module-standard.mjs";

const fresh = async () => {
  const inputs = await loadConsumerModuleStandardInputs();
  return {
    ...inputs,
    decisionBytes: Buffer.from(inputs.decisionBytes),
    decisionRegistry: structuredClone(inputs.decisionRegistry),
    packageManifest: structuredClone(inputs.packageManifest),
    pathExistence: new Map(inputs.pathExistence),
    profile: structuredClone(inputs.profile),
    sources: new Map(inputs.sources),
  };
};

test("pending contained-turn profile matches the exact legacy boundary", async () => {
  assert.deepEqual(validateConsumerModuleStandard(await fresh()), {
    legacyBoundaries: 1,
    status: "pending",
  });
});

test("rejects central pin drift and an unsupported active claim", async () => {
  const pin = await fresh();
  pin.profile.authority.consumerModuleStandard.gitCommit = "moving-main";
  assert.throws(() => validateConsumerModuleStandard(pin), /reviewed pending-adoption record/u);

  const active = await fresh();
  active.profile.status = "active";
  assert.throws(() => validateConsumerModuleStandard(active), /reviewed pending-adoption record/u);
});

test("rejects missing governed paths and proposed decision lifecycle drift", async () => {
  const missing = await fresh();
  missing.pathExistence.set(missing.profile.legacyBoundaries[0].factoryPath, false);
  assert.throws(() => validateConsumerModuleStandard(missing), /required adoption path is missing/u);

  const accepted = await fresh();
  accepted.decisionBytes = Buffer.from(accepted.decisionBytes.toString("utf8")
    .replaceAll("status: proposed", "status: accepted")
    .replaceAll("Status: proposed", "Status: accepted"));
  assert.throws(() => validateConsumerModuleStandard(accepted), /frontmatter must declare proposed/u);

  const contradictory = await fresh();
  contradictory.decisionBytes = Buffer.concat([
    contradictory.decisionBytes,
    Buffer.from("\nStatus: accepted\n"),
  ]);
  assert.throws(() => validateConsumerModuleStandard(contradictory), /body must declare proposed/u);

  const registered = await fresh();
  registered.decisionRegistry.decisions.push({id: "ADR-0016"});
  assert.throws(() => validateConsumerModuleStandard(registered), /cannot enter the immutable/u);
});

test("rejects removed, reordered, and no-op gate commands", async () => {
  const removed = await fresh();
  delete removed.packageManifest.scripts["test:consumer-modules"];
  assert.throws(() => validateConsumerModuleStandard(removed), /reviewed command/u);

  const reordered = await fresh();
  reordered.packageManifest.scripts.check = reordered.packageManifest.scripts.check.replace(
    "pnpm test:consumer-modules && pnpm architecture:consumer-modules",
    "pnpm architecture:consumer-modules && pnpm test:consumer-modules",
  );
  assert.throws(() => validateConsumerModuleStandard(reordered), /fixtures then the checker/u);

  const noOp = await fresh();
  noOp.packageManifest.scripts["architecture:consumer-modules"] = "true";
  assert.throws(() => validateConsumerModuleStandard(noOp), /reviewed command/u);

  const noTopology = await fresh();
  noTopology.packageManifest.scripts["check:fast"] = noTopology.packageManifest.scripts["check:fast"]
    .replace("pnpm foundation:check && ", "");
  assert.throws(() => validateConsumerModuleStandard(noTopology), /topology enforcement/u);

  const noOpTopology = await fresh();
  noOpTopology.packageManifest.scripts["foundation:check"] = "true";
  assert.throws(() => validateConsumerModuleStandard(noOpTopology), /reviewed command/u);
});

test("rejects slot drift and an unknown production factory caller", async () => {
  const slotDrift = await fresh();
  const declarationPath = slotDrift.profile.legacyBoundaries[0].declarationPath;
  slotDrift.sources.set(declarationPath,
    slotDrift.sources.get(declarationPath).replace('  "provider",', '  "scheduler",'));
  assert.throws(() => validateConsumerModuleStandard(slotDrift), /slot drift/u);

  const caller = await fresh();
  caller.sources.set("packages/apps/embedded-runtime/src/composition/second-root.ts",
    'import { createContainedTurnFeature as build } from "@agent-teams/agent-execution/composition";\nbuild({});\n');
  assert.throws(() => validateConsumerModuleStandard(caller), /unknown or missing|aliases are not classified/u);

  const localAlias = await fresh();
  const entrypointPath = localAlias.profile.legacyBoundaries[0].materializedEntrypoint;
  localAlias.sources.set(entrypointPath, localAlias.sources.get(entrypointPath).replace(
    "return createContainedTurnFeature(Object.freeze({",
    "const buildContainedTurn = createContainedTurnFeature;\n  // createContainedTurnFeature(\n  return buildContainedTurn(Object.freeze({",
  ));
  assert.throws(() => validateConsumerModuleStandard(localAlias),
    /materialization call count drift|aliases are not classified/u);

  const exportAlias = await fresh();
  const publicCompositionPath = "packages/contexts/agent-execution/src/composition.ts";
  exportAlias.sources.set(publicCompositionPath, exportAlias.sources.get(publicCompositionPath)
    .replace("  createContainedTurnFeature,", "  createContainedTurnFeature /* comment */ as buildContainedTurn,"));
  exportAlias.sources.set(entrypointPath, exportAlias.sources.get(entrypointPath)
    .replace("  createContainedTurnFeature,", "  buildContainedTurn as createContainedTurnFeature,"));
  exportAlias.sources.set("packages/apps/embedded-runtime/src/composition/alias-consumer.ts",
    'import { buildContainedTurn } from "@agent-teams/agent-execution/composition";\nbuildContainedTurn({});\n');
  assert.throws(() => validateConsumerModuleStandard(exportAlias), /reference count drift|aliases are not classified/u);

  const stringNamedAlias = await fresh();
  stringNamedAlias.sources.set("packages/apps/embedded-runtime/src/composition/string-alias-consumer.ts",
    'import { "createContainedTurnFeature" as build } from "@agent-teams/agent-execution/composition";\nbuild({});\n');
  assert.throws(() => validateConsumerModuleStandard(stringNamedAlias), /unknown or missing|aliases are not classified/u);

  const stringNamedReexport = await fresh();
  stringNamedReexport.sources.set("packages/apps/embedded-runtime/src/composition/string-alias-export.ts",
    'export { "createContainedTurnFeature" as build } from "@agent-teams/agent-execution/composition";\n');
  assert.throws(() => validateConsumerModuleStandard(stringNamedReexport), /unknown or missing|aliases are not classified/u);

  const computedMember = await fresh();
  computedMember.sources.set("packages/apps/embedded-runtime/src/composition/computed-member-consumer.ts",
    'import * as composition from "@agent-teams/agent-execution/composition";\ncomposition["createContainedTurnFeature"]({});\n');
  assert.throws(() => validateConsumerModuleStandard(computedMember),
    /unknown or missing|aliases are not classified/u);

  const destructuredMember = await fresh();
  destructuredMember.sources.set("packages/apps/embedded-runtime/src/composition/destructured-member-consumer.ts",
    'import * as composition from "@agent-teams/agent-execution/composition";\nconst {"createContainedTurnFeature": build} = composition;\nbuild({});\n');
  assert.throws(() => validateConsumerModuleStandard(destructuredMember),
    /unknown or missing|aliases are not classified/u);

  for (const [name, source] of [
    ["template-member", 'import * as composition from "@agent-teams/agent-execution/composition";\ncomposition[`createContainedTurnFeature`]({});\n'],
    ["composed-member", 'import * as composition from "@agent-teams/agent-execution/composition";\ncomposition["createContainedTurn" + "Feature"]({});\n'],
    ["namespace-alias", 'import * as composition from "@agent-teams/agent-execution/composition";\nconst local = composition;\nlocal["createContainedTurnFeature"]({});\n'],
    ["import-equals", 'import composition = require("@agent-teams/agent-execution/composition");\ncomposition["createContainedTurnFeature"]({});\n'],
    ["nested-destructure", 'import * as composition from "@agent-teams/agent-execution/composition";\nfunction make() { const {"createContainedTurnFeature": build} = composition; return build({}); }\n'],
    ["assigned-destructure", 'import * as composition from "@agent-teams/agent-execution/composition";\nlet build; ({"createContainedTurnFeature": build} = composition); build({});\n'],
    ["dynamic-member", 'import * as composition from "@agent-teams/agent-execution/composition";\nconst name = "createContainedTurnFeature";\ncomposition[name]({});\n'],
    ["dynamic-import", 'export async function make() { const composition = await import("@agent-teams/agent-execution/composition"); return composition.createContainedTurnFeature({}); }\n'],
    ["composed-dynamic-import", 'export async function make() { const composition = await import("@agent-teams/agent-execution/" + "composition"); return composition.createContainedTurnFeature({}); }\n'],
    ["template-dynamic-import", 'export async function make() { const composition = await import(`@agent-teams/agent-execution/composition`); return composition.createContainedTurnFeature({}); }\n'],
    ["require", 'const composition = require("@agent-teams/agent-execution/composition");\ncomposition["createContainedTurnFeature"]({});\n'],
    ["composed-require", 'const composition = require("@agent-teams/agent-execution/" + "composition");\ncomposition.createContainedTurnFeature({});\n'],
    ["template-require", 'const composition = require(`@agent-teams/agent-execution/composition`);\ncomposition.createContainedTurnFeature({});\n'],
    ["runtime-import", 'const moduleName = "@agent-teams/agent-execution/composition";\nexport async function make() { const composition = await import(moduleName); return composition.createContainedTurnFeature({}); }\n'],
    ["runtime-composed-import", 'const moduleName = "@agent-teams/agent-execution/composition";\nexport async function make() { const composition = await import(moduleName + ""); return composition.createContainedTurnFeature({}); }\n'],
    ["runtime-composed-require", 'const moduleName = "@agent-teams/agent-execution/composition";\nconst composition = require(moduleName + "");\ncomposition.createContainedTurnFeature({});\n'],
    ["star-export", 'export * from "@agent-teams/agent-execution/composition";\n'],
    ["namespace-export", 'export * as composition from "@agent-teams/agent-execution/composition";\n'],
  ]) {
    const bypass = await fresh();
    bypass.sources.set(`packages/apps/embedded-runtime/src/composition/${name}.ts`, source);
    assert.throws(() => validateConsumerModuleStandard(bypass),
      /unknown or missing|aliases are not classified|non-literal production import/u);
  }

  const shadowed = await fresh();
  shadowed.sources.set(entrypointPath, shadowed.sources.get(entrypointPath)
    .replace("  createContainedTurnFeature,\n", "")
    .replaceAll("return createContainedTurnFeature(",
      "const createContainedTurnFeature = (..._args: unknown[]) => ({}) as never;\n  return createContainedTurnFeature("));
  assert.throws(() => validateConsumerModuleStandard(shadowed), /binding is shadowed/u);
});

test("ignores same-named exports from unrelated modules", async () => {
  for (const [name, source] of [
    ["named", 'import { createContainedTurnFeature } from "./unrelated.js";\ncreateContainedTurnFeature({});\n'],
    ["namespace", 'import * as unrelated from "./unrelated.js";\nunrelated.createContainedTurnFeature({});\n'],
    ["local", 'const createContainedTurnFeature = () => 1;\ncreateContainedTurnFeature();\n'],
    ["parameter", 'export const use = (createContainedTurnFeature: () => number) => createContainedTurnFeature();\n'],
  ]) {
    const unrelated = await fresh();
    unrelated.sources.set(`packages/apps/embedded-runtime/src/composition/unrelated-${name}.ts`, source);
    assert.deepEqual(validateConsumerModuleStandard(unrelated), {legacyBoundaries: 1, status: "pending"});
  }
});

test("rejects stale legacy records, exceptions, and forbidden layer imports", async () => {
  const legacy = await fresh();
  legacy.profile.legacyBoundaries[0].materializationCallCount = 3;
  assert.throws(() => validateConsumerModuleStandard(legacy), /reviewed pending-adoption record/u);

  const exception = await fresh();
  exception.profile.exceptions.push({ id: "blanket" });
  assert.throws(() => validateConsumerModuleStandard(exception), /reviewed pending-adoption record/u);

  const layer = await fresh();
  layer.sources.set("packages/contexts/agent-execution/src/application/hidden-assembly.ts",
    'import { assemble } from "@get-modular/assembly";\n');
  assert.throws(() => validateConsumerModuleStandard(layer), /forbidden Get Modular layer import/u);

  const dynamicImport = await fresh();
  dynamicImport.sources.set("packages/contexts/agent-execution/src/application/dynamic-assembly.ts",
    'const assembly = import/* comment */("@get-modular/assembly/internal");\n');
  assert.throws(() => validateConsumerModuleStandard(dynamicImport), /forbidden Get Modular layer import/u);

  const subpath = await fresh();
  subpath.sources.set("packages/contexts/agent-execution/src/domain/assembly-subpath.ts",
    'import type { Plan } from "@get-modular/assembly/internal";\n');
  assert.throws(() => validateConsumerModuleStandard(subpath), /forbidden Get Modular layer import/u);

  const sideEffect = await fresh();
  sideEffect.sources.set("packages/contexts/agent-execution/src/application/side-effect-core.ts",
    'import/* comment */ "@get-modular/core";\n');
  assert.throws(() => validateConsumerModuleStandard(sideEffect), /forbidden Get Modular layer import/u);
});
