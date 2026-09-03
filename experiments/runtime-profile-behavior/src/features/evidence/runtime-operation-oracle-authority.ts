import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

import type {
  ADR0006RuntimeOperationOracle,
  Case,
  CaseFragment,
  Catalog,
  ContainedTurnV1Contract,
  ContainedTurnV1Disposition,
  CrossAxis,
  ExampleFragment,
  Fact,
  Manifest,
} from "../../../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";

import {
  validateContainedTurnV1Authority,
  type ContainedTurnV1Validation,
} from "./runtime-operation-contained-turn-v1.ts";

const SCHEMA_ID = "https://agent-teams.ai/schemas/adr-0006-runtime-operation-oracle.schema.json";
const SPEC_DIRECTORY = "experiments/runtime-profile-behavior/spec/runtime-operation-oracle";

const fail = (message: string): never => {
  throw new Error(`runtime-operation oracle authority: ${message}`);
};

const findDuplicateProperty = (node: JsonNode, label: string): void => {
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const name = String(property.children?.[0]?.value);
      if (names.has(name)) {
        fail(`${label} contains duplicate property ${JSON.stringify(name)}`);
      }
      names.add(name);
    }
  }
  for (const child of node.children ?? []) {
    findDuplicateProperty(child, label);
  }
};

export const parseAuthorityJson = (text: string, label: string): unknown => {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (root === undefined || errors.length > 0) {
    const detail = errors.map(({ error, offset }) => `${printParseErrorCode(error)}@${offset}`).join(", ");
    return fail(`${label} is not strict JSON: ${detail || "empty document"}`);
  }
  findDuplicateProperty(root, label);
  return JSON.parse(text) as unknown;
};

const formatAjvErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? []).map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "invalid"}`).join("; ");

const validate = <Value>(
  validator: ValidateFunction,
  value: unknown,
  label: string,
): Value => {
  if (!validator(value)) {
    fail(`${label} violates Draft 2020-12 schema: ${formatAjvErrors(validator.errors)}`);
  }
  return value as Value;
};

const exactArray = (actual: readonly unknown[], expected: readonly unknown[], label: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the schema vocabulary in exact order`);
  }
};

const readJson = async (path: string, label: string): Promise<unknown> =>
  parseAuthorityJson(await readFile(path, "utf8"), label);

const requireValidator = (ajv: Ajv2020, reference: string): ValidateFunction =>
  ajv.getSchema(`${SCHEMA_ID}#/$defs/${reference}`) ?? fail(`schema validator ${reference} is unavailable`);

const expandCase = async (
  specificationRoot: string,
  fragment: CaseFragment,
  exampleValidator: ValidateFunction,
  referencedParts: Set<string>,
): Promise<Case> => {
  if ("examples" in fragment) {
    return fragment;
  }
  const examples = [];
  for (const relativePath of fragment.exampleFragments) {
    if (!relativePath.startsWith(`case-parts/${String(fragment.requirement).padStart(2, "0")}-`)) {
      fail(`${relativePath} does not belong to requirement ${fragment.requirement}`);
    }
    referencedParts.add(relativePath.replace("case-parts/", ""));
    const value = await readJson(join(specificationRoot, relativePath), relativePath);
    const part = validate<ExampleFragment>(exampleValidator, value, relativePath);
    examples.push(...part);
  }
  return { id: fragment.id, requirement: fragment.requirement, examples } as Case;
};

const validateCatalog = (catalog: Catalog): void => {
  exactArray(Object.keys(catalog.allowedFactsByCheck), catalog.checks, "catalog.allowedFactsByCheck keys");
  const declaredFacts = new Set(catalog.facts);
  const allowedFacts = Object.values(catalog.allowedFactsByCheck).flat();
  if (allowedFacts.some((fact) => !declaredFacts.has(fact))) {
    fail("catalog.allowedFactsByCheck contains an undeclared fact");
  }
  exactArray(
    [...new Set(allowedFacts)].toSorted(),
    [...catalog.facts].toSorted(),
    "catalog fact membership",
  );
  exactArray(
    Object.keys(catalog.binaryRetentionFactRoles).toSorted(),
    [...(catalog.allowedFactsByCheck.binary_revision_retention ?? [])].toSorted(),
    "binary-retention fact-role coverage",
  );
  const accepted = new Set(catalog.acceptedResultCodes);
  if (catalog.acceptedResultCodes.some((code) => !(catalog.resultCodes as readonly string[]).includes(code)) ||
      accepted.size !== catalog.acceptedResultCodes.length) {
    fail("catalog.acceptedResultCodes must be a unique result-code subset");
  }
  const product = Object.values(catalog.stateProductAxes)
    .reduce((size, values) => size * values.length, 1);
  if (product !== 48_000) {
    fail(`catalog.stateProductAxes must describe the exact 48,000-state static product, got ${product}`);
  }
};

const validateCrossAxis = (crossAxis: CrossAxis, requirementCase: Case, catalog: Catalog): void => {
  const axes = crossAxis.axes as unknown as Record<string, string[]>;
  const declaredFacts = new Set(catalog.facts);
  const declaredStateAxes = new Set(Object.keys(catalog.stateProductAxes));
  exactArray(
    Object.keys(crossAxis.initial).toSorted(),
    Object.keys(axes).toSorted(),
    "cross-axis initial-axis membership",
  );
  for (const [axis, values] of Object.entries(axes)) {
    if (!declaredStateAxes.has(axis)) {
      fail(`cross-axis topology contains unknown catalog axis ${axis}`);
    }
    if (axis === "terminal") {
      exactArray(values, ["open", "final"], "cross-axis terminal topology");
    } else {
      exactArray(
        values,
        catalog.stateProductAxes[axis as keyof typeof catalog.stateProductAxes],
        `cross-axis ${axis} values`,
      );
    }
  }
  for (const [axis, initial] of Object.entries(crossAxis.initial)) {
    if (!(axes[axis] ?? []).includes(initial)) {
      fail(`cross-axis initial ${axis}.${initial} is not declared`);
    }
  }
  for (const transition of crossAxis.transitions) {
    const requiredFacts: readonly Fact[] = transition.requiredFacts ?? [];
    const forbiddenFacts: readonly Fact[] = transition.forbiddenFacts ?? [];
    if (!declaredFacts.has(transition.fact) ||
        [...requiredFacts, ...forbiddenFacts].some((fact) => !declaredFacts.has(fact))) {
      fail(`cross-axis transition ${transition.fact} contains a fact outside catalog.facts`);
    }
    if (forbiddenFacts.some((fact) => requiredFacts.includes(fact))) {
      fail(`cross-axis transition ${transition.fact} requires and forbids the same fact`);
    }
    const targetAxes = transition.targets.map(({ axis }) => axis);
    if (new Set(targetAxes).size !== targetAxes.length) {
      fail(`cross-axis transition ${transition.fact} targets one axis more than once`);
    }
    for (const { axis, from, to } of transition.targets) {
      const values = axes[axis] ?? [];
      if (!values.includes(from) || !values.includes(to) || from === to) {
        fail(`cross-axis transition ${transition.fact} has an invalid ${axis} target`);
      }
    }
    for (const [axis, values] of Object.entries(transition.requiredState ?? {})) {
      const declared = declaredStateAxes.has(axis) ? axes[axis] : undefined;
      if (declared === undefined || values.some((value) => !declared.includes(value))) {
        fail(`cross-axis transition ${transition.fact} has invalid required state on ${axis}`);
      }
    }
    const acceptedExamples = requirementCase.examples.filter((example) =>
      example.expected.decision === "accept" && example.facts.includes(transition.fact),
    );
    for (const example of acceptedExamples) {
      const missing = requiredFacts.filter((fact) => !example.facts.includes(fact));
      if (missing.length > 0) {
        fail(`cross-axis example ${example.id} omits required facts for ${transition.fact}: ${missing.join(", ")}`);
      }
      const forbidden = forbiddenFacts.filter((fact) => example.facts.includes(fact));
      if (forbidden.length > 0) {
        fail(`cross-axis example ${example.id} contains forbidden facts for ${transition.fact}: ${forbidden.join(", ")}`);
      }
    }
    const commonEvidenceFacts = acceptedExamples.length === 0
      ? []
      : acceptedExamples[0]!.facts.filter((fact) =>
        fact !== transition.fact && acceptedExamples.every((example) => example.facts.includes(fact)),
      ).toSorted();
    exactArray(
      [...requiredFacts].toSorted(),
      commonEvidenceFacts,
      `cross-axis required facts for ${transition.fact}`,
    );
  }
  if (crossAxis.forbiddenTransitionFacts.some((fact) => !declaredFacts.has(fact))) {
    fail("cross-axis forbidden transitions contain a fact outside catalog.facts");
  }
  const primaryTransitionFacts = (decision: "accept" | "reject"): string[] =>
    requirementCase.examples
      .filter((example) => example.expected.decision === decision)
      .flatMap((example) => example.facts.filter((fact) => fact.startsWith("transition_")))
      .filter((fact, index, facts) => facts.indexOf(fact) === index)
      .toSorted();
  const allowedFacts = crossAxis.transitions.map(({ fact }) => fact);
  if (allowedFacts.some((fact) => crossAxis.forbiddenTransitionFacts.includes(fact))) {
    fail("cross-axis allowed and forbidden transition facts must be disjoint");
  }
  exactArray(
    crossAxis.transitions.map(({ fact }) => fact).toSorted(),
    primaryTransitionFacts("accept"),
    "cross-axis allowed transition facts",
  );
  exactArray(
    [...crossAxis.forbiddenTransitionFacts].toSorted(),
    primaryTransitionFacts("reject").filter((fact) => !primaryTransitionFacts("accept").includes(fact)),
    "cross-axis forbidden transition facts",
  );
};

const validateOracleSemantics = (
  manifest: Manifest,
  catalog: Catalog,
  crossAxis: CrossAxis,
  cases: Case[],
): ADR0006RuntimeOperationOracle => {
  const expectedRequirements = Array.from({ length: 28 }, (_, index) => index + 1);
  exactArray(manifest.cases.map(({ requirement }) => requirement), expectedRequirements, "manifest case order");
  exactArray(cases.map(({ requirement }) => requirement), expectedRequirements, "case requirement order");
  const identifiers = [...cases.map(({ id }) => id), ...cases.flatMap(({ examples }) => examples.map(({ id }) => id))];
  if (new Set(identifiers).size !== identifiers.length) {
    fail("case and example IDs must be globally unique");
  }
  for (const oracleCase of cases) {
    if (oracleCase.examples.length < 2 ||
        !oracleCase.examples.some(({ expected }) => expected.decision === "accept") ||
        !oracleCase.examples.some(({ expected }) => expected.decision === "reject")) {
      fail(`requirement ${oracleCase.requirement} must include accept and reject examples`);
    }
    const expectedCheck = catalog.checks[oracleCase.requirement - 1];
    for (const example of oracleCase.examples) {
      if (example.check !== expectedCheck) {
        fail(`${example.id} uses ${example.check}, expected ${expectedCheck}`);
      }
      const allowedFacts = (catalog.allowedFactsByCheck[example.check] ?? []) as readonly string[];
      if (example.facts.some((fact) => !allowedFacts.includes(fact))) {
        fail(`${example.id} contains a fact outside ${example.check}`);
      }
      if (!catalog.resultCodes.includes(example.expected.code)) {
        fail(`${example.id} contains a result code outside catalog.resultCodes`);
      }
      const acceptedCode = catalog.acceptedResultCodes.includes(example.expected.code);
      if (acceptedCode !== (example.expected.decision === "accept")) {
        fail(`${example.id} decision disagrees with the catalog result-code class`);
      }
    }
  }
  const oracle = {
    $schema: "./schema.json",
    schemaVersion: 1,
    adr: "ADR-0006",
    cases,
  } as unknown as ADR0006RuntimeOperationOracle;
  const allExamples = cases.flatMap(({ examples: caseExamples }) => caseExamples);
  const actualCounts = {
    caseCount: cases.length,
    exampleCount: allExamples.length,
    acceptedCount: allExamples.filter(({ expected }) => expected.decision === "accept").length,
    rejectedCount: allExamples.filter(({ expected }) => expected.decision === "reject").length,
  };
  if (JSON.stringify(actualCounts) !== JSON.stringify(manifest.expected)) {
    fail(`fragment parity differs from the manifest: ${JSON.stringify(actualCounts)}`);
  }
  const transitionCase = cases[26] ?? fail("requirement 27 case is missing");
  validateCrossAxis(crossAxis, transitionCase, catalog);
  return oracle;
};

export type RuntimeOperationOracleAuthority = {
  manifest: Manifest;
  catalog: Catalog;
  crossAxis: CrossAxis;
  containedTurnV1Contract: ContainedTurnV1Contract;
  containedTurnV1Disposition: ContainedTurnV1Disposition;
  containedTurnV1Validation: ContainedTurnV1Validation;
  oracle: ADR0006RuntimeOperationOracle;
  schema: Record<string, unknown>;
};

export const loadRuntimeOperationOracleAuthority = async (
  repositoryRoot: string,
): Promise<RuntimeOperationOracleAuthority> => {
  const specificationRoot = join(repositoryRoot, SPEC_DIRECTORY);
  const schema = await readJson(join(specificationRoot, "schema.json"), "schema.json") as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: true });
  ajv.addSchema(schema);
  const manifest = validate<Manifest>(
    requireValidator(ajv, "manifest"),
    await readJson(join(specificationRoot, "manifest.json"), "manifest.json"),
    "manifest.json",
  );
  const catalog = validate<Catalog>(
    requireValidator(ajv, "catalog"),
    await readJson(join(specificationRoot, manifest.catalog), manifest.catalog),
    manifest.catalog,
  );
  const crossAxis = validate<CrossAxis>(
    requireValidator(ajv, "crossAxis"),
    await readJson(join(specificationRoot, manifest.crossAxis), manifest.crossAxis),
    manifest.crossAxis,
  );
  const containedTurnV1Disposition = validate<ContainedTurnV1Disposition>(
    requireValidator(ajv, "containedTurnV1Disposition"),
    await readJson(
      join(specificationRoot, manifest.containedTurnV1Disposition),
      manifest.containedTurnV1Disposition,
    ),
    manifest.containedTurnV1Disposition,
  );
  const containedTurnV1Contract = validate<ContainedTurnV1Contract>(
    requireValidator(ajv, "containedTurnV1Contract"),
    await readJson(
      join(specificationRoot, manifest.containedTurnV1Contract),
      manifest.containedTurnV1Contract,
    ),
    manifest.containedTurnV1Contract,
  );
  const actualRootJson = (await readdir(specificationRoot))
    .filter((path) => path.endsWith(".json")).toSorted();
  exactArray(
    actualRootJson,
    [
      "authority.schema.json",
      "schema.json",
      "manifest.json",
      manifest.catalog,
      manifest.crossAxis,
      manifest.containedTurnV1Disposition,
      manifest.containedTurnV1Contract,
    ].toSorted(),
    "root authority-file membership",
  );
  const caseValidator = requireValidator(ajv, "caseFragment");
  const exampleValidator = requireValidator(ajv, "exampleFragment");
  const actualCaseFiles = (await readdir(join(specificationRoot, "cases")))
    .filter((path) => path.endsWith(".json")).toSorted();
  exactArray(
    actualCaseFiles,
    manifest.cases.map(({ path }) => path.replace("cases/", "")).toSorted(),
    "manifest case-file membership",
  );
  const cases: Case[] = [];
  const referencedParts = new Set<string>();
  for (const entry of manifest.cases) {
    if (!entry.path.startsWith(`cases/${String(entry.requirement).padStart(2, "0")}-`)) {
      fail(`${entry.path} does not match requirement ${entry.requirement}`);
    }
    const fragment = validate<CaseFragment>(
      caseValidator,
      await readJson(join(specificationRoot, entry.path), entry.path),
      entry.path,
    );
    const expanded = await expandCase(specificationRoot, fragment, exampleValidator, referencedParts);
    if (expanded.requirement !== entry.requirement) {
      fail(`${entry.path} requirement does not match its manifest slot`);
    }
    cases.push(expanded);
  }
  const actualCaseParts = (await readdir(join(specificationRoot, "case-parts")))
    .filter((path) => path.endsWith(".json")).toSorted();
  exactArray(actualCaseParts, [...referencedParts].toSorted(), "case-part membership");
  validateCatalog(catalog);
  const oracle = validateOracleSemantics(manifest, catalog, crossAxis, cases);
  validate<ADR0006RuntimeOperationOracle>(
    ajv.getSchema(SCHEMA_ID) ?? fail("root schema validator is unavailable"),
    oracle,
    "assembled oracle",
  );
  const containedTurnV1Validation = await validateContainedTurnV1Authority({
    repositoryRoot,
    contract: containedTurnV1Contract,
    disposition: containedTurnV1Disposition,
    cases,
    catalog,
  });
  return {
    manifest,
    catalog,
    crossAxis,
    containedTurnV1Contract,
    containedTurnV1Disposition,
    containedTurnV1Validation,
    oracle,
    schema,
  };
};
