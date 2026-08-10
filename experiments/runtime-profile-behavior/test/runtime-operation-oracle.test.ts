import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadRuntimeOperationOracleAuthority, parseAuthorityJson } from "../src/features/evidence/runtime-operation-oracle-authority.ts";
import { createOracleEvaluator } from "../src/features/evidence/runtime-operation-oracle-evaluator.ts";
import {
  createStateProductEvaluator,
  generatedStateIsValid,
} from "../src/features/evidence/runtime-operation-state-product.ts";
import {
  checkRuntimeOperationOracleGeneratedFiles,
  renderRuntimeOperationOracleGeneratedFiles,
} from "../src/features/evidence/generate-runtime-operation-oracle.ts";
import { validateRuntimeOperationOracle } from "../src/features/evidence/validate-runtime-operation-oracle.ts";
import type { Example } from "../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const specificationRelative = "experiments/runtime-profile-behavior/spec/runtime-operation-oracle";
const specificationRoot = join(repositoryRoot, specificationRelative);
const FOUNDATION_ADOPTION_BOUNDARY = "| `quality.executable-specifications` | enabled for synthetic architecture evidence | Cataloged JSON authority, independent evaluator, property/mutation checks, and XState path evidence support review of proposed ADR-0006; they do not bind or implement a production runtime or establish implementation/deployment qualification |";
const READINESS_BOUNDARY = "They do not bind or implement a production runtime, change ADR-0006 from `proposed`, authorize an Agent Execution slice, or establish implementation/deployment qualification.";
const FORBIDDEN_POSITIVE_EVIDENCE_CLAIMS = [
  { statement: "They bind a production runtime.", pattern: /\bthey bind (?:a |the )?production runtime(?=[\s.,;]|$)/iu },
  { statement: "They implement a production runtime.", pattern: /\bthey implement (?:a |the )?production runtime(?=[\s.,;]|$)/iu },
  { statement: "They bind or implement a production runtime.", pattern: /\bthey bind or implement (?:a |the )?production runtime(?=[\s.,;]|$)/iu },
  { statement: "They change ADR-0006 from `proposed`.", pattern: /\bthey change ADR-0006 from `proposed`(?=[\s.,;]|$)/iu },
  { statement: "They authorize an Agent Execution slice.", pattern: /\bthey authorize an Agent Execution slice(?=[\s.,;]|$)/iu },
  { statement: "They establish implementation qualification.", pattern: /\bthey establish implementation qualification(?=[\s.,;]|$)/iu },
  { statement: "They establish deployment qualification.", pattern: /\bthey establish deployment qualification(?=[\s.,;]|$)/iu },
  { statement: "They establish implementation/deployment qualification.", pattern: /\bthey establish implementation\/deployment qualification(?=[\s.,;]|$)/iu },
] as const;

const assertExecutableEvidenceBoundary = (adoption: string, readiness: string): void => {
  const normalizedAdoption = adoption.replaceAll(/\s+/g, " ");
  const normalizedReadiness = readiness.replaceAll(/\s+/g, " ");
  assert.ok(
    normalizedAdoption.includes(FOUNDATION_ADOPTION_BOUNDARY),
    "Foundation adoption must retain the complete synthetic-evidence boundary cell",
  );
  assert.ok(
    normalizedReadiness.includes(READINESS_BOUNDARY),
    "readiness must retain the complete negative production-qualification boundary",
  );
  for (const { pattern } of FORBIDDEN_POSITIVE_EVIDENCE_CLAIMS) {
    assert.doesNotMatch(
      normalizedAdoption,
      pattern,
      "Foundation documentation must not contain a positive production claim",
    );
    assert.doesNotMatch(
      normalizedReadiness,
      pattern,
      "Foundation documentation must not contain a positive production claim",
    );
  }
};

const withSpecificationCopy = async (
  mutate: (temporarySpecificationRoot: string) => Promise<void>,
  verify: (temporaryRepositoryRoot: string) => Promise<void>,
): Promise<void> => {
  const temporaryRepositoryRoot = await mkdtemp(join(tmpdir(), "agent-runtime-oracle-test-"));
  const temporarySpecificationRoot = join(temporaryRepositoryRoot, specificationRelative);
  try {
    await mkdir(join(temporarySpecificationRoot, ".."), { recursive: true });
    await cp(specificationRoot, temporarySpecificationRoot, { recursive: true });
    await mutate(temporarySpecificationRoot);
    await verify(temporaryRepositoryRoot);
  } finally {
    await rm(temporaryRepositoryRoot, { recursive: true, force: true });
  }
};

test("fragment authority preserves cutover parity and ten-axis validity counts", async () => {
  assert.deepEqual(await validateRuntimeOperationOracle(repositoryRoot), {
    caseCount: 28,
    exampleCount: 242,
    acceptedCount: 107,
    rejectedCount: 135,
    stateProduct: { total: 48_000, valid: 1_277, invalid: 46_723 },
  });
});

test("model oracle exhausts the deterministic ten-axis state product", async () => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  assert.deepEqual(createStateProductEvaluator(authority).evaluate(), {
    total: 48000,
    valid: 1277,
    invalid: 46723,
  });
});

test("generated model enforces coupled and terminal invariants", () => {
  const openState = {
    dispatch: "unclaimed",
    admission: "open",
    output: "open",
    execution: "not_started",
    containment: "not_requested",
    reconciliation: "clear",
    manifest: "open",
    satisfaction: "incomplete",
    effectResolution: "none",
    terminal: "open",
  } as const;
  assert.equal(generatedStateIsValid(openState), true);
  assert.equal(generatedStateIsValid({ ...openState, dispatch: "claimed" }), false);
  assert.equal(generatedStateIsValid({ ...openState, manifest: "sealed" }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    manifest: "sealed",
  }), false);
  assert.equal(generatedStateIsValid({ ...openState, satisfaction: "complete" }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    output: "fenced",
    manifest: "sealed",
    satisfaction: "complete",
    effectResolution: "unresolved",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    containment: "qualified_not_required",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "provider_accepted",
    admission: "fenced",
    output: "fenced",
    execution: "active",
    containment: "qualified_not_required",
  }), false);
  assert.equal(generatedStateIsValid({
    ...openState,
    admission: "fenced",
    output: "fenced",
    containment: "qualified_not_required",
  }), true);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "acceptance_unknown",
    admission: "fenced",
    output: "fenced",
    execution: "terminated",
    containment: "contained",
    reconciliation: "required",
  }), true);
  assert.equal(generatedStateIsValid({
    ...openState,
    dispatch: "acceptance_unknown",
    admission: "fenced",
    output: "fenced",
    execution: "terminated",
    containment: "contained",
    reconciliation: "clear",
  }), false);

  const finalState = {
    ...openState,
    admission: "fenced",
    output: "fenced",
    manifest: "sealed",
    satisfaction: "complete",
    terminal: "succeeded",
  } as const;
  assert.equal(generatedStateIsValid(finalState), true);
  assert.equal(generatedStateIsValid({ ...finalState, effectResolution: "unresolved" }), false);
  assert.equal(generatedStateIsValid({ ...finalState, execution: "active" }), false);
  assert.equal(generatedStateIsValid({
    ...finalState,
    effectResolution: "indeterminate",
    terminal: "outcome_indeterminate",
  }), true);
  assert.equal(generatedStateIsValid({
    ...finalState,
    dispatch: "acceptance_unknown",
    execution: "terminated",
    containment: "contained",
    effectResolution: "indeterminate",
    terminal: "outcome_indeterminate",
  }), true);
});

test("every authority example agrees with the independent handwritten evaluator", async () => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const { oracle } = authority;
  const evaluateOracleExample = createOracleEvaluator(authority);
  for (const example of oracle.cases.flatMap(({ examples }) => examples)) {
    assert.deepEqual(evaluateOracleExample(example), example.expected, example.id);
  }
});

test("binary revision semantic retention fails closed before work and GC", async () => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const oracle = authority.oracle;
  const evaluateOracleExample = createOracleEvaluator(authority);
  const retentionCase = oracle.cases.find(({ requirement }) => requirement === 28);
  assert.ok(retentionCase);
  const rootedWork = retentionCase.examples.find(
    ({ id }) => id === "root-before-provider-or-effect-work",
  );
  assert.ok(rootedWork);
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: ["provider_or_effect_work_requested"],
  } as Example), {
    decision: "reject",
    code: "semantic_root_required",
  });
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: rootedWork.facts.filter((fact) => fact !== "execution_authority_present"),
  } as Example), {
    decision: "reject",
    code: "root_not_execution_authority",
  });
  assert.deepEqual(evaluateOracleExample({
    ...rootedWork,
    facts: rootedWork.facts.filter((fact) => fact !== "operation_acceptance_committed"),
  } as Example), {
    decision: "reject",
    code: "operation_acceptance_required",
  });

  const gcWithRoot = retentionCase.examples.find(
    ({ id }) => id === "gc-with-retained-semantic-root",
  );
  assert.ok(gcWithRoot);
  assert.deepEqual(evaluateOracleExample(gcWithRoot), gcWithRoot.expected);

  const gcAllowed = retentionCase.examples.find(
    ({ id }) => id === "gc-with-zero-semantic-roots",
  );
  assert.ok(gcAllowed);
  assert.deepEqual(evaluateOracleExample({
    ...gcAllowed,
    facts: ["gc_requested", "zero_semantic_roots"],
  } as Example), {
    decision: "reject",
    code: "binary_revision_gc_blocked",
  });

  const safeRelease = retentionCase.examples.find(
    ({ id }) => id === "closed-operation-releases-root",
  );
  assert.ok(safeRelease);
  assert.deepEqual(evaluateOracleExample({
    ...safeRelease,
    facts: safeRelease.facts.filter((fact) => fact !== "binary_revision_root_established"),
  } as Example), {
    decision: "reject",
    code: "semantic_root_required",
  });

  const releaseReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-release-replay-is-idempotent",
  );
  assert.ok(releaseReplay);
  assert.equal(releaseReplay.facts.includes("binary_revision_root_established"), false);
  assert.deepEqual(evaluateOracleExample(releaseReplay), releaseReplay.expected);
  for (const invalidReleaseEvidence of [
    "release_manifest_stale",
    "release_manifest_wrong_scope",
    "release_manifest_unknown",
    "release_manifest_incomplete",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...releaseReplay,
      facts: [...releaseReplay.facts, invalidReleaseEvidence],
    }), {
      decision: "reject",
      code: "release_manifest_conflict",
    });
  }

  const abandonReplay = retentionCase.examples.find(
    ({ id }) => id === "exact-abandon-release-replay",
  );
  assert.ok(abandonReplay);
  for (const invalidAbortEvidence of [
    "operation_acceptance_aborted_receipt_stale",
    "operation_acceptance_aborted_receipt_wrong_scope",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...abandonReplay,
      facts: [...abandonReplay.facts, invalidAbortEvidence],
    }), {
      decision: "reject",
      code: "operation_acceptance_stale_current_receipt",
    });
  }

  const lostReceipt = retentionCase.examples.find(
    ({ id }) => id === "lost-root-receipt-ack-replays",
  );
  assert.ok(lostReceipt);
  assert.deepEqual(evaluateOracleExample({
    ...lostReceipt,
    facts: lostReceipt.facts.filter((fact) => fact !== "root_receipt_exact_replay_or_query"),
  } as Example), {
    decision: "reject",
    code: "retention_receipt_reconciliation_required",
  });

  const deletionReplay = retentionCase.examples.find(
    ({ id }) => id === "physical-deletion-exact-replay",
  );
  assert.ok(deletionReplay);
  for (const fact of ["durable_gc_deletion_intent_claim", "zero_semantic_roots"] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...deletionReplay,
      facts: deletionReplay.facts.filter((candidate) => candidate !== fact),
    } as Example), {
      decision: "reject",
      code: "deletion_integrity_contradiction",
    });
  }
  assert.deepEqual(evaluateOracleExample({
    ...deletionReplay,
    facts: [...deletionReplay.facts, "binary_revision_root_established"],
  }), {
    decision: "reject",
    code: "deletion_integrity_contradiction",
  });
  for (const contradictoryFact of [
    "root_cas_won",
    "contradictory_zero_and_retained_roots",
  ] as const) {
    assert.deepEqual(evaluateOracleExample({
      ...deletionReplay,
      facts: [...deletionReplay.facts, contradictoryFact],
    }), {
      decision: "reject",
      code: "deletion_integrity_contradiction",
    });
  }
});

test("manifest is the sole ordered case membership authority", async () => {
  const { manifest, oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  assert.equal(manifest.cases.length, 28);
  assert.deepEqual(
    manifest.cases.map(({ requirement }) => requirement),
    Array.from({ length: 28 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    oracle.cases.map(({ requirement }) => requirement),
    manifest.cases.map(({ requirement }) => requirement),
  );
});

test("Foundation catalog closes over the manifest and every referenced case part", async () => {
  const { manifest } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const shardedCase = JSON.parse(await readFile(
    join(specificationRoot, "cases/28-binary-revision-semantic-retention.json"),
    "utf8",
  )) as { exampleFragments: string[] };
  const foundationCatalog = JSON.parse(await readFile(
    join(repositoryRoot, "architecture/specifications/catalog.json"),
    "utf8",
  )) as { specifications: { documents: { path: string }[] }[] };
  const declared = foundationCatalog.specifications[0]!.documents
    .map(({ path }) => path.replace(`${specificationRelative}/`, ""))
    .toSorted();
  const expected = [
    "manifest.json",
    manifest.catalog,
    manifest.crossAxis,
    ...manifest.cases.map(({ path }) => path),
    ...shardedCase.exampleFragments,
  ].toSorted();
  assert.deepEqual(declared, expected);
});

test("Foundation documentation denies production runtime binding and qualification", async () => {
  const [foundationConfig, adoption, readiness] = await Promise.all([
    readFile(join(repositoryRoot, "foundation.config.yaml"), "utf8"),
    readFile(join(repositoryRoot, "docs/architecture/foundation-adoption.md"), "utf8"),
    readFile(join(repositoryRoot, "docs/architecture/readiness.md"), "utf8"),
  ]);

  assert.match(foundationConfig, /^  quality\.executable-specifications:$/m);
  assert.match(readiness, /Foundation `quality\.executable-specifications`/);
  assertExecutableEvidenceBoundary(adoption, readiness);
});

test("production qualification guard rejects every canonical positive inversion", () => {
  for (const { statement } of FORBIDDEN_POSITIVE_EVIDENCE_CLAIMS) {
    assert.throws(
      () => assertExecutableEvidenceBoundary(
        FOUNDATION_ADOPTION_BOUNDARY,
        `${READINESS_BOUNDARY} ${statement}`,
      ),
      /must not contain a positive production claim/,
      statement,
    );
  }
});

test("jsonc-parser defense rejects nested duplicate keys before Ajv", () => {
  assert.throws(
    () => parseAuthorityJson('{"outer":{"fact":"first","fact":"second"}}', "duplicate.json"),
    /duplicate property "fact"/,
  );
  assert.throws(
    () => parseAuthorityJson('{"outer":true,}', "trailing.json"),
    /not strict JSON/,
  );
  assert.throws(
    () => parseAuthorityJson('{/* comment */"outer":true}', "comment.json"),
    /not strict JSON/,
  );
});

test("strict Draft 2020-12 validation rejects an open case field", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "cases/01-output-terminal-order.json");
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.policyBag = { allow: true };
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /violates Draft 2020-12 schema/,
    );
  });
});

test("schema stays structural while catalog owns vocabulary", async () => {
  const schema = JSON.parse(await readFile(join(specificationRoot, "schema.json"), "utf8")) as {
    $defs: Record<string, {
      type?: string;
      enum?: unknown;
      properties?: Record<string, { enum?: unknown; propertyNames?: { enum?: unknown } }>;
    }>;
  };
  for (const definition of ["check", "fact", "resultCode"]) {
    assert.equal(schema.$defs[definition]?.type, "string");
    assert.equal(schema.$defs[definition]?.enum, undefined);
  }
  assert.equal(schema.$defs.crossAxisTarget?.properties?.axis?.enum, undefined);
  assert.equal(
    schema.$defs.crossAxisTransition?.properties?.requiredState?.propertyNames?.enum,
    undefined,
  );
});

test("generated vocabulary unions exactly project the loaded catalog", async () => {
  const { catalog } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const source = await readFile(
    join(repositoryRoot, "experiments/runtime-profile-behavior/fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts"),
    "utf8",
  );
  const members = (name: string): string[] => {
    const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source)?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  };
  assert.deepEqual(members("Check"), catalog.checks);
  assert.deepEqual(members("Fact"), catalog.facts);
  assert.deepEqual(members("ResultCode"), catalog.resultCodes);
});

test("temporary catalog vocabulary changes generated projection and freshness", async () => {
  const baseline = await renderRuntimeOperationOracleGeneratedFiles(repositoryRoot);
  await withSpecificationCopy(async (root) => {
    const path = join(root, "catalog.json");
    const value = JSON.parse(await readFile(path, "utf8")) as { resultCodes: string[] };
    value.resultCodes.push("temporary_projection_code");
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    const changed = await renderRuntimeOperationOracleGeneratedFiles(temporaryRepositoryRoot);
    const generatedName = "runtime-operation-oracle-types.generated.ts";
    assert.notEqual(changed.get(generatedName), baseline.get(generatedName));
    assert.match(changed.get(generatedName) ?? "", /"temporary_projection_code"/);
    await assert.rejects(
      checkRuntimeOperationOracleGeneratedFiles(temporaryRepositoryRoot),
      /runtime-operation-oracle-types.generated.ts/,
    );
  });
});

test("semantic linker rejects vocabulary drift that structural schema permits", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "cases/01-output-terminal-order.json");
    const value = JSON.parse(await readFile(path, "utf8")) as {
      examples: { facts: string[] }[];
    };
    value.examples[0]!.facts[0] = "catalog_drift_fact";
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /contains a fact outside output_terminal_order/,
    );
  });
});

test("temporary-root validation derives evaluator roles from temporary catalog", async () => {
  await withSpecificationCopy(async (root) => {
    const path = join(root, "catalog.json");
    const value = JSON.parse(await readFile(path, "utf8")) as {
      binaryRetentionFactRoles: Record<string, string>;
    };
    for (const fact of Object.keys(value.binaryRetentionFactRoles)) {
      if (value.binaryRetentionFactRoles[fact] === "command_intent") {
        value.binaryRetentionFactRoles[fact] = "evidence";
      }
    }
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      validateRuntimeOperationOracle(temporaryRepositoryRoot),
      /expected .*mixed_command_intent_forbidden/,
    );
  });
});

test("authority linker rejects orphan fragments", async () => {
  await withSpecificationCopy(async (root) => {
    await writeFile(join(root, "cases/29-orphan.json"), "{}\n");
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /manifest case-file membership/,
    );
  });
});

test("authority linker rejects an orphan root JSON file", async () => {
  await withSpecificationCopy(async (root) => {
    await writeFile(join(root, "unused.json"), "{}\n");
  }, async (temporaryRepositoryRoot) => {
    await assert.rejects(
      loadRuntimeOperationOracleAuthority(temporaryRepositoryRoot),
      /root authority-file membership/,
    );
  });
});
