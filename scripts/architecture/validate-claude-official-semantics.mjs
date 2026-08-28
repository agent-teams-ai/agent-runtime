import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const OFFICIAL_SOURCE_ORIGINS = new Set(["https://code.claude.com", "https://json.schemastore.org"]);
const FACT_NAMES = Object.freeze([
  "portableSourcesLowToHigh",
  "portablePaths",
  "portableKeys",
  "modelAliases",
  "effortValues",
  "managedPolicySeparateFromPortableIntent",
  "providerRoutesSeparateFromPortableIntent",
]);

const exactKeys = (value, keys, label) => {
  assert.deepEqual(Object.keys(value).toSorted(), [...keys].toSorted(), `${label} keys`);
};
const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
};
const sha256 = value => createHash("sha256").update(value).digest("hex");

const validateDocument = (document, retrievalDate, coordinates, retainedEvidence) => {
  exactKeys(document, [
    "id", "requestUrl", "finalUrl", "retrievalDate", "contentType",
    "historicalResponseSha256", "responseDigestAuthority", "sourceCoordinates",
    "normalization", "retainedBytesUtf8", "retainedByteLength", "retainedSha256",
  ], `official evidence ${document.id}`);
  assert.ok(OFFICIAL_SOURCE_ORIGINS.has(new URL(document.requestUrl).origin), `${document.id} request origin`);
  assert.ok(OFFICIAL_SOURCE_ORIGINS.has(new URL(document.finalUrl).origin), `${document.id} final origin`);
  assert.match(document.contentType, /^(?:application\/json|text\/markdown); charset=utf-8$/u);
  assert.equal(document.retrievalDate, retrievalDate, `${document.id} retrieval date`);
  assert.match(document.historicalResponseSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    document.responseDigestAuthority,
    "non-authority-response-bytes-unretained",
    `${document.id} historical response digest authority`,
  );
  assert.ok(document.sourceCoordinates.length > 0, `${document.id} source coordinates`);
  unique(document.sourceCoordinates, `${document.id} source coordinates`);
  const retainedBytes = Buffer.from(document.retainedBytesUtf8, "utf8");
  assert.equal(retainedBytes.byteLength, document.retainedByteLength, `${document.id} retained byte length`);
  assert.equal(sha256(retainedBytes), document.retainedSha256, `${document.id} retained content hash`);
  assert.ok(retainedBytes.byteLength > 0 && retainedBytes.byteLength < 1024, `${document.id} compact evidence boundary`);
  retainedEvidence.set(document.id, document.retainedBytesUtf8);
  for (const coordinate of document.sourceCoordinates) {
    coordinates.add(`${document.id}#${coordinate}`);
  }
};

const validateFactCoordinates = (frozenFacts, coordinates) => {
  exactKeys(frozenFacts, FACT_NAMES, "official frozen facts");
  for (const name of FACT_NAMES) {
    const fact = frozenFacts[name];
    exactKeys(fact, ["value", "evidence"], `official frozen fact ${name}`);
    assert.ok(fact.evidence.length > 0, `${name} retained evidence`);
    unique(fact.evidence, `${name} evidence coordinates`);
    for (const coordinate of fact.evidence) {
      assert.ok(coordinates.has(coordinate), `${name} references retained coordinate ${coordinate}`);
    }
  }
};

const validateSettingsFacts = (frozenFacts, retainedEvidence) => {
  const settingsRecords = Object.fromEntries(
    retainedEvidence.get("settings-scopes").trimEnd().split("\n").map(line => line.split(" | ")),
  );
  assert.deepEqual(frozenFacts.portablePaths.value, [
    settingsRecords["User settings"],
    `<workspace>/${settingsRecords["Project settings"]}`,
    `<workspace>/${settingsRecords["Local settings"]}`,
  ], "portable paths must derive from retained settings evidence");
  const sourceKinds = new Map([
    ["local project", "project-local"],
    ["shared project", "shared-project"],
    ["user", "user"],
  ]);
  const sourceLabels = settingsRecords["Precedence, highest to lowest"].split(", ");
  assert.deepEqual(
    frozenFacts.portableSourcesLowToHigh.value,
    sourceLabels.map(label => sourceKinds.get(label)).toReversed(),
    "portable precedence must derive from retained settings evidence",
  );
};

const validatePortableFacts = (frozenFacts, retainedEvidence) => {
  const schemaRecords = new Map(retainedEvidence.get("settings-keys-and-effort")
    .trimEnd()
    .split("\n")
    .map(line => {
      const record = JSON.parse(line);
      return [record.pointer, record.value];
    }));
  assert.deepEqual(
    frozenFacts.portableKeys.value,
    ["/properties/model", "/properties/effortLevel/enum"].map(pointer => pointer.split("/")[2]),
    "portable keys must derive from retained schema pointers",
  );
  assert.deepEqual(
    frozenFacts.effortValues.value,
    schemaRecords.get("/properties/effortLevel/enum"),
    "effort allowlist must derive from retained schema evidence",
  );
  assert.deepEqual(
    frozenFacts.modelAliases.value,
    retainedEvidence.get("model-aliases").trimEnd().split(", "),
    "model allowlist must derive from retained model evidence",
  );
  assert.equal(
    frozenFacts.managedPolicySeparateFromPortableIntent.value,
    retainedEvidence.get("managed-policy").includes("organization-controlled policy")
      && retainedEvidence.get("managed-policy").includes("precedence over user and project settings"),
    "managed-policy separation must derive from retained managed evidence",
  );
  const routeIdentifiers = new Set(retainedEvidence.get("provider-route").trimEnd().split("\n"));
  assert.equal(
    frozenFacts.providerRoutesSeparateFromPortableIntent.value,
    routeIdentifiers.has("CLAUDE_CODE_USE_BEDROCK")
      && [...routeIdentifiers].some(identifier => identifier.startsWith("ANTHROPIC_DEFAULT_"))
      && schemaRecords.has("/properties/model"),
    "provider-route separation must derive from retained route and schema evidence",
  );
};

export const validateOfficialSemantics = semanticArtifact => {
  exactKeys(
    semanticArtifact,
    ["schemaVersion", "snapshotId", "retrieval", "historicalNonAuthority", "documents", "frozenFacts"],
    "official semantic artifact",
  );
  exactKeys(semanticArtifact.retrieval, ["date", "method", "authority", "statement"], "official semantic artifact retrieval");
  exactKeys(
    semanticArtifact.historicalNonAuthority,
    ["snapshotId", "responseBodiesRetained", "documentCount", "statement"],
    "historical non-authority",
  );
  assert.equal(semanticArtifact.schemaVersion, 2);
  assert.equal(semanticArtifact.snapshotId, "claude-code-settings-semantics@2026-08-28.r2");
  assert.equal(semanticArtifact.retrieval.date, "2026-08-28");
  assert.equal(semanticArtifact.retrieval.authority, "retained-normalized-evidence");
  assert.match(semanticArtifact.retrieval.method, /compact UTF-8 evidence records/u);
  assert.match(semanticArtifact.retrieval.statement, /Provider and executable qualification remain open/u);
  assert.equal(semanticArtifact.historicalNonAuthority.responseBodiesRetained, false);
  assert.equal(semanticArtifact.historicalNonAuthority.documentCount, 13);
  assert.match(semanticArtifact.historicalNonAuthority.statement, /intentionally omitted/u);

  unique(semanticArtifact.documents.map(document => document.id), "official evidence IDs");
  const coordinates = new Set();
  const retainedEvidence = new Map();
  for (const document of semanticArtifact.documents) {
    validateDocument(document, semanticArtifact.retrieval.date, coordinates, retainedEvidence);
  }
  validateFactCoordinates(semanticArtifact.frozenFacts, coordinates);
  validateSettingsFacts(semanticArtifact.frozenFacts, retainedEvidence);
  validatePortableFacts(semanticArtifact.frozenFacts, retainedEvidence);
  return semanticArtifact.frozenFacts;
};
