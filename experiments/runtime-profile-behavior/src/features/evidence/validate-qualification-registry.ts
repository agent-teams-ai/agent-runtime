import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LEVELS = [
  "unqualified",
  "scoped",
  "implementation",
  "deployment",
] as const;

const DIMENSIONS = [
  "provider",
  "binaryClosure",
  "platform",
  "credentialRoute",
  "transport",
  "failureDomain",
] as const;

const FORBIDDEN_TOKENS = new Set(["*", "all", "any"]);
const SHA256 = /^[a-f0-9]{64}$/;
const ENTRY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRACE_ROW = /^\| `([^`]+)` \|/gm;

type JsonRecord = Record<string, unknown>;

type EvidenceRecord = {
  kind: "human-report" | "redacted-summary";
  path: string;
  sha256: string;
};

type RegistryEntry = {
  id: string;
  qualification: (typeof LEVELS)[number];
  dimensions: Record<(typeof DIMENSIONS)[number], readonly string[]>;
  evidence: readonly EvidenceRecord[];
  readinessSections: readonly string[];
  limitations: readonly string[];
};

export type QualificationTarget = Record<
  (typeof DIMENSIONS)[number],
  string
>;

export type QualificationRegistryValidation = {
  entryCount: number;
  evidenceArtifactCount: number;
  traceabilityRowCount: number;
};

const fail = (message: string): never => {
  throw new Error(`qualification registry: ${message}`);
};

const asRecord = (value: unknown, label: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as JsonRecord;
};

const exactKeys = (
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} keys differ: expected ${wanted.join(", ")}, got ${actual.join(", ")}`);
  }
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${label} must be a non-empty string`);
  }
  return value;
};

const asStringArray = (
  value: unknown,
  label: string,
  options: { exactTokens?: boolean } = {},
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(`${label} must be a non-empty array`);
  }
  const items = value.map((item, index) =>
    asString(item, `${label}[${index}]`),
  );
  if (new Set(items).size !== items.length) {
    fail(`${label} contains duplicates`);
  }
  if (
    options.exactTokens &&
    items.some((item) => FORBIDDEN_TOKENS.has(item.toLowerCase()))
  ) {
    fail(`${label} contains a forbidden wildcard token`);
  }
  return items;
};

const parseEntry = (value: unknown, index: number): RegistryEntry => {
  const label = `entries[${index}]`;
  const entry = asRecord(value, label);
  exactKeys(
    entry,
    [
      "id",
      "qualification",
      "dimensions",
      "evidence",
      "readinessSections",
      "limitations",
    ],
    label,
  );

  const id = asString(entry.id, `${label}.id`);
  if (!ENTRY_ID.test(id)) fail(`${label}.id is not canonical`);

  const qualification = asString(
    entry.qualification,
    `${label}.qualification`,
  );
  if (!LEVELS.includes(qualification as (typeof LEVELS)[number])) {
    fail(`${label}.qualification is unknown`);
  }

  const dimensionsValue = asRecord(entry.dimensions, `${label}.dimensions`);
  exactKeys(dimensionsValue, DIMENSIONS, `${label}.dimensions`);
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      asStringArray(
        dimensionsValue[dimension],
        `${label}.dimensions.${dimension}`,
        { exactTokens: true },
      ),
    ]),
  ) as RegistryEntry["dimensions"];

  const evidenceValue = entry.evidence;
  if (!Array.isArray(evidenceValue) || evidenceValue.length === 0) {
    fail(`${label}.evidence must be a non-empty array`);
  }
  const evidenceArray = evidenceValue as unknown[];
  const evidence: EvidenceRecord[] = evidenceArray.map(
    (item: unknown, evidenceIndex: number) => {
      const evidenceLabel = `${label}.evidence[${evidenceIndex}]`;
      const record = asRecord(item, evidenceLabel);
      exactKeys(record, ["kind", "path", "sha256"], evidenceLabel);
      const kindValue = asString(record.kind, `${evidenceLabel}.kind`);
      if (kindValue !== "human-report" && kindValue !== "redacted-summary") {
        fail(`${evidenceLabel}.kind is unknown`);
      }
      const kind = kindValue as EvidenceRecord["kind"];
      const path = asString(record.path, `${evidenceLabel}.path`);
      if (
        isAbsolute(path) ||
        path.split("/").includes("..") ||
        !(
          path.startsWith("docs/spikes/") ||
          path.startsWith("experiments/runtime-profile-behavior/fixtures/")
        )
      ) {
        fail(`${evidenceLabel}.path escapes the approved evidence roots`);
      }
      const sha256 = asString(record.sha256, `${evidenceLabel}.sha256`);
      if (!SHA256.test(sha256)) fail(`${evidenceLabel}.sha256 is invalid`);
      return { kind, path, sha256 };
    },
  );
  if (evidence.filter(({ kind }) => kind === "human-report").length !== 1) {
    fail(`${label} must contain exactly one human-report`);
  }

  return {
    id,
    qualification: qualification as RegistryEntry["qualification"],
    dimensions,
    evidence,
    readinessSections: asStringArray(
      entry.readinessSections,
      `${label}.readinessSections`,
    ),
    limitations: asStringArray(entry.limitations, `${label}.limitations`),
  };
};

export const validateQualificationRegistryShape = (
  value: unknown,
): readonly RegistryEntry[] => {
  const registry = asRecord(value, "root");
  exactKeys(
    registry,
    [
      "$schema",
      "schemaVersion",
      "generatedAt",
      "matchingPolicy",
      "qualificationLevels",
      "entries",
    ],
    "root",
  );
  if (registry.$schema !== "./qualification-registry.schema.json") {
    fail("$schema must reference the repository-local schema");
  }
  if (registry.schemaVersion !== 1) fail("schemaVersion must equal 1");
  if (
    typeof registry.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(registry.generatedAt)
  ) {
    fail("generatedAt must be an ISO date");
  }

  const policy = asRecord(registry.matchingPolicy, "matchingPolicy");
  exactKeys(
    policy,
    [
      "default",
      "dimensionRule",
      "entryValueRule",
      "wildcardsAllowed",
      "promotionRule",
    ],
    "matchingPolicy",
  );
  if (
    policy.default !== "unqualified" ||
    policy.dimensionRule !== "exact-match-all-dimensions" ||
    policy.entryValueRule !==
      "target-token-equals-one-observed-token-per-dimension" ||
    policy.wildcardsAllowed !== false ||
    policy.promotionRule !== "explicit-evidence-and-readiness-update"
  ) {
    fail("matchingPolicy weakens exact-match fail-closed behavior");
  }

  if (JSON.stringify(registry.qualificationLevels) !== JSON.stringify(LEVELS)) {
    fail("qualificationLevels differ from the canonical order");
  }
  const entriesValue = registry.entries;
  if (!Array.isArray(entriesValue) || entriesValue.length === 0) {
    fail("entries must be a non-empty array");
  }
  const entriesArray = entriesValue as unknown[];
  const entries: RegistryEntry[] = entriesArray.map(
    (entry: unknown, index: number) => parseEntry(entry, index),
  );
  const ids = entries.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) fail("entry IDs are not unique");
  return entries;
};

const parseTarget = (value: unknown): QualificationTarget => {
  const target = asRecord(value, "target");
  exactKeys(target, DIMENSIONS, "target");
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const token = asString(target[dimension], `target.${dimension}`);
      if (FORBIDDEN_TOKENS.has(token.toLowerCase())) {
        fail(`target.${dimension} contains a forbidden wildcard token`);
      }
      return [dimension, token];
    }),
  ) as QualificationTarget;
};

export const matchQualificationTarget = (
  value: unknown,
  targetValue: unknown,
): readonly { id: string; qualification: RegistryEntry["qualification"] }[] => {
  const entries = validateQualificationRegistryShape(value);
  const target = parseTarget(targetValue);
  return entries
    .filter((entry) =>
      DIMENSIONS.every((dimension) =>
        entry.dimensions[dimension].includes(target[dimension]),
      ),
    )
    .map(({ id, qualification }) => ({ id, qualification }));
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const sorted = (values: Iterable<string>): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

export const validateQualificationRegistry = async (
  repositoryRoot: string,
): Promise<QualificationRegistryValidation> => {
  const registryPath = resolve(
    repositoryRoot,
    "docs/architecture/qualification-registry.json",
  );
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
  const entries = validateQualificationRegistryShape(registry);

  const evidencePaths = new Set<string>();
  const reportPaths = new Set<string>();
  for (const entry of entries) {
    for (const evidence of entry.evidence) {
      if (evidencePaths.has(evidence.path)) {
        fail(`evidence path is registered more than once: ${evidence.path}`);
      }
      evidencePaths.add(evidence.path);
      if (evidence.kind === "human-report") reportPaths.add(evidence.path);

      const absolutePath = resolve(repositoryRoot, evidence.path);
      const relativePath = relative(repositoryRoot, absolutePath);
      if (
        relativePath.startsWith(`..${sep}`) ||
        relativePath === ".." ||
        isAbsolute(relativePath)
      ) {
        fail(`evidence path escapes repository root: ${evidence.path}`);
      }
      const actual = sha256(await readFile(absolutePath));
      if (actual !== evidence.sha256) {
        fail(
          `evidence digest mismatch for ${evidence.path}: expected ${evidence.sha256}, got ${actual}`,
        );
      }
    }
  }

  const traceability = await readFile(
    resolve(repositoryRoot, "docs/architecture/evidence-traceability.md"),
    "utf8",
  );
  const tracedReports = new Set(
    [...traceability.matchAll(TRACE_ROW)].map((match) => `docs/${match[1]}`),
  );
  if (JSON.stringify(sorted(reportPaths)) !== JSON.stringify(sorted(tracedReports))) {
    const missing = sorted(
      [...tracedReports].filter((path) => !reportPaths.has(path)),
    );
    const extra = sorted(
      [...reportPaths].filter((path) => !tracedReports.has(path)),
    );
    fail(
      `traceability coverage differs; missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }

  const readiness = await readFile(
    resolve(repositoryRoot, "docs/architecture/readiness.md"),
    "utf8",
  );
  const readinessHeadings = new Set(
    [...readiness.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
  );
  for (const entry of entries) {
    for (const section of entry.readinessSections) {
      if (!readinessHeadings.has(section)) {
        fail(`${entry.id} references missing readiness section: ${section}`);
      }
    }
  }

  if (
    readiness.includes("No current domain slice is `implementation qualified`") &&
    entries.some(({ qualification }) =>
      qualification === "implementation" || qualification === "deployment"
    )
  ) {
    fail("registry promotes a target above the readiness register");
  }

  return {
    entryCount: entries.length,
    evidenceArtifactCount: evidencePaths.size,
    traceabilityRowCount: tracedReports.size,
  };
};

const sourcePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === sourcePath) {
  const repositoryRoot = resolve(dirname(sourcePath), "../../../../..");
  validateQualificationRegistry(repositoryRoot)
    .then(async (result) => {
      process.stdout.write(
        `qualification registry: PASS (${result.entryCount} entries, ${result.evidenceArtifactCount} pinned artifacts, ${result.traceabilityRowCount} traceability rows)\n`,
      );
      const targetIndex = process.argv.indexOf("--target-json");
      if (targetIndex >= 0) {
        const targetJson = asString(
          process.argv[targetIndex + 1],
          "--target-json",
        );
        const registry = JSON.parse(
          await readFile(
            resolve(
              repositoryRoot,
              "docs/architecture/qualification-registry.json",
            ),
            "utf8",
          ),
        ) as unknown;
        const matches = matchQualificationTarget(
          registry,
          JSON.parse(targetJson) as unknown,
        );
        const highestQualification = matches.reduce<
          (typeof LEVELS)[number]
        >(
          (highest, match) =>
            LEVELS.indexOf(match.qualification) > LEVELS.indexOf(highest)
              ? match.qualification
              : highest,
          "unqualified",
        );
        process.stdout.write(
          `${JSON.stringify({
            qualification: highestQualification,
            matches,
          })}\n`,
        );
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
