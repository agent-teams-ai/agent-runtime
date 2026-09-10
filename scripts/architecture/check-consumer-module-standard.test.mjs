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

test("pending Consumer Module Standard profile matches the exact legacy boundary", async () => {
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

test("rejects missing governed paths and stale decision bytes", async () => {
  const missing = await fresh();
  missing.pathExistence.set(missing.profile.legacyBoundaries[0].factoryPath, false);
  assert.throws(() => validateConsumerModuleStandard(missing), /required adoption path is missing/u);

  const stale = await fresh();
  stale.decisionBytes = Buffer.concat([stale.decisionBytes, Buffer.from("\n")]);
  assert.throws(() => validateConsumerModuleStandard(stale), /exact path and bytes/u);
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
  assert.throws(() => validateConsumerModuleStandard(caller), /unknown or missing/u);

  const localAlias = await fresh();
  const entrypointPath = localAlias.profile.legacyBoundaries[0].materializedEntrypoint;
  localAlias.sources.set(entrypointPath, localAlias.sources.get(entrypointPath).replace(
    "return createContainedTurnFeature(Object.freeze({",
    "const buildContainedTurn = createContainedTurnFeature;\n  // createContainedTurnFeature(\n  return buildContainedTurn(Object.freeze({",
  ));
  assert.throws(() => validateConsumerModuleStandard(localAlias), /materialization call count drift/u);

  const exportAlias = await fresh();
  const publicCompositionPath = "packages/contexts/agent-execution/src/composition.ts";
  exportAlias.sources.set(publicCompositionPath, exportAlias.sources.get(publicCompositionPath)
    .replace("  createContainedTurnFeature,", "  createContainedTurnFeature /* comment */ as buildContainedTurn,"));
  exportAlias.sources.set(entrypointPath, exportAlias.sources.get(entrypointPath)
    .replace("  createContainedTurnFeature,", "  buildContainedTurn as createContainedTurnFeature,"));
  exportAlias.sources.set("packages/apps/embedded-runtime/src/composition/alias-consumer.ts",
    'import { buildContainedTurn } from "@agent-teams/agent-execution/composition";\nbuildContainedTurn({});\n');
  assert.throws(() => validateConsumerModuleStandard(exportAlias), /reference count drift|aliases are not classified/u);
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
