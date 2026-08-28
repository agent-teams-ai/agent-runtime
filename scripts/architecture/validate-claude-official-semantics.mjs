import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const repositoryRoot = new URL("../../", import.meta.url);
const EVIDENCE_DIRECTORY = "docs/architecture/evidence/claude-code-settings-semantics-2026-08-28/";
const DOCUMENTS = Object.freeze([
  {
    id: "settings-scopes",
    requestUrl: "https://code.claude.com/docs/en/settings.md",
    finalUrl: "https://code.claude.com/docs/en/settings.md",
    contentType: "text/markdown; charset=utf-8",
    artifactPath: `${EVIDENCE_DIRECTORY}settings.md.gz`,
    sourceCoordinates: ["Settings files and who they affect", "Settings precedence"],
  },
  {
    id: "settings-keys-and-effort",
    requestUrl: "https://json.schemastore.org/claude-code-settings.json",
    finalUrl: "https://www.schemastore.org/claude-code-settings.json",
    contentType: "application/json; charset=utf-8",
    artifactPath: `${EVIDENCE_DIRECTORY}settings-schema.json.gz`,
    sourceCoordinates: ["/properties/model", "/properties/effortLevel/enum"],
  },
  {
    id: "model-aliases",
    requestUrl: "https://code.claude.com/docs/en/model-config.md",
    finalUrl: "https://code.claude.com/docs/en/model-config.md",
    contentType: "text/markdown; charset=utf-8",
    artifactPath: `${EVIDENCE_DIRECTORY}model-config.md.gz`,
    sourceCoordinates: ["Model aliases"],
  },
  {
    id: "managed-policy",
    requestUrl: "https://code.claude.com/docs/en/managed-settings.md",
    finalUrl: "https://code.claude.com/docs/en/managed-settings.md",
    contentType: "text/markdown; charset=utf-8",
    artifactPath: `${EVIDENCE_DIRECTORY}managed-settings.md.gz`,
    sourceCoordinates: ["Introduction"],
  },
  {
    id: "provider-route",
    requestUrl: "https://code.claude.com/docs/en/amazon-bedrock.md",
    finalUrl: "https://code.claude.com/docs/en/amazon-bedrock.md",
    contentType: "text/markdown; charset=utf-8",
    artifactPath: `${EVIDENCE_DIRECTORY}amazon-bedrock.md.gz`,
    sourceCoordinates: ["3. Configure Claude Code", "4. Pin model versions"],
  },
]);
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
const decodeUtf8 = (bytes, label) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    assert.fail(`${label} must be valid UTF-8: ${error.message}`);
  }
};
const boundedSection = (markdown, heading, nextHeading, maximumLength) => {
  const start = markdown.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `missing Markdown heading ${heading}`);
  const contentStart = start + heading.length + 1;
  const relativeEnd = markdown.slice(contentStart).search(nextHeading);
  const end = relativeEnd === -1 ? markdown.length : contentStart + relativeEnd;
  const section = markdown.slice(contentStart, end);
  assert.ok(section.length <= maximumLength, `${heading} exceeds bounded parser limit`);
  return section;
};

const deriveSettingsEvidence = markdown => {
  const files = boundedSection(markdown, "## Settings files and who they affect", /^## /mu, 20_000);
  const fileRows = [...files.matchAll(/^\|\s*(User|Shared project|Project local)\s*\|\s*`([^`]+)`\s*\|/gmu)]
    .map(match => [match[1], match[2]]);
  assert.deepEqual(fileRows.map(([scope]) => scope), ["User", "Shared project", "Project local"], "settings file rows");

  const precedence = boundedSection(markdown, "## Settings precedence", /^## /mu, 20_000);
  const precedenceRows = [...precedence.matchAll(
    /^[345]\. \*\*(Project local settings|Shared project settings|User settings)\*\* \(`([^`]+)`\):/gmu,
  )];
  assert.deepEqual(
    precedenceRows.map(match => [match[1], match[2]]),
    [
      ["Project local settings", ".claude/settings.local.json"],
      ["Shared project settings", ".claude/settings.json"],
      ["User settings", "~/.claude/settings.json"],
    ],
    "portable settings precedence rows",
  );
  const sourceKinds = new Map([
    ["Project local settings", "project-local"],
    ["Shared project settings", "shared-project"],
    ["User settings", "user"],
  ]);
  return [
    ...fileRows.map(row => row.join(" | ")),
    `Precedence, highest to lowest | ${precedenceRows.map(match => sourceKinds.get(match[1])).join(", ")}`,
  ].join("\n") + "\n";
};

const jsonPointer = (value, pointer) => pointer.split("/").slice(1).reduce((current, token) => {
  const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
  assert.ok(current !== null && typeof current === "object" && Object.hasOwn(current, key), `missing JSON pointer ${pointer}`);
  return current[key];
}, value);
const deriveSchemaEvidence = bytes => {
  const schema = JSON.parse(decodeUtf8(bytes, "settings schema response"));
  return ["/properties/model", "/properties/effortLevel/enum"]
    .map(pointer => JSON.stringify({ pointer, value: jsonPointer(schema, pointer) }))
    .join("\n") + "\n";
};

const deriveModelEvidence = markdown => {
  const section = boundedSection(markdown, "### Model aliases", /^### /mu, 20_000);
  const aliases = [...section.matchAll(/^\| \*\*`([^`]+)`\*\*\s*\|/gmu)].map(match => match[1]);
  assert.deepEqual(
    aliases,
    ["default", "best", "fable", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]", "opusplan"],
    "model alias rows",
  );
  return `${aliases.join(", ")}\n`;
};

const deriveManagedEvidence = markdown => {
  const introduction = markdown.slice(0, 4096);
  const match = /^Managed settings are the settings your organization deploys[^\n]+$/mu.exec(introduction);
  assert.ok(match, "managed settings introductory proposition");
  return `${match[0]}\n`;
};

const deriveProviderEvidence = markdown => {
  const configure = boundedSection(markdown, "### 3. Configure Claude Code", /^### /mu, 30_000);
  const models = boundedSection(markdown, "### 4. Pin model versions", /^(?:## |### )/mu, 30_000);
  const identifiers = [
    ["CLAUDE_CODE_USE_BEDROCK", configure],
    ["ANTHROPIC_MODEL", models],
    ["ANTHROPIC_DEFAULT_HAIKU_MODEL", models],
    ["ANTHROPIC_DEFAULT_SONNET_MODEL", models],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", models],
  ];
  for (const [identifier, section] of identifiers) {
    assert.match(section, new RegExp(`\\b${identifier}\\b`, "u"), `provider route identifier ${identifier}`);
  }
  return `${identifiers.map(([identifier]) => identifier).join("\n")}\n`;
};

const deriveEvidence = (id, responseBytes) => {
  if (id === "settings-keys-and-effort") {
    return deriveSchemaEvidence(responseBytes);
  }
  const markdown = decodeUtf8(responseBytes, `${id} response`);
  if (id === "settings-scopes") {
    return deriveSettingsEvidence(markdown);
  }
  if (id === "model-aliases") {
    return deriveModelEvidence(markdown);
  }
  if (id === "managed-policy") {
    return deriveManagedEvidence(markdown);
  }
  if (id === "provider-route") {
    return deriveProviderEvidence(markdown);
  }
  assert.fail(`unsupported official evidence document ${id}`);
};

const validateDocument = async (document, context) => {
  const { coordinates, expected, retainedEvidence, retrievalDate, root } = context;
  exactKeys(document, [
    "id", "requestUrl", "finalUrl", "retrievalDate", "contentType",
    "rawResponseByteLength", "rawResponseSha256", "gzipByteLength", "gzipSha256", "artifactPath",
    "sourceCoordinates", "normalization", "retainedBytesUtf8", "retainedByteLength", "retainedSha256",
  ], `official evidence ${document.id}`);
  for (const key of ["id", "requestUrl", "finalUrl", "contentType", "artifactPath"]) {
    assert.equal(document[key], expected[key], `${document.id} ${key}`);
  }
  assert.deepEqual(document.sourceCoordinates, expected.sourceCoordinates, `${document.id} source coordinates`);
  assert.equal(document.retrievalDate, retrievalDate, `${document.id} retrieval date`);
  assert.match(document.rawResponseSha256, /^[0-9a-f]{64}$/u);
  assert.match(document.gzipSha256, /^[0-9a-f]{64}$/u);
  assert.ok(document.normalization.length > 0, `${document.id} normalization`);
  assert.ok(document.rawResponseByteLength > 0 && document.rawResponseByteLength < 500_000, `${document.id} raw response size`);
  assert.ok(document.gzipByteLength > 0 && document.gzipByteLength < document.rawResponseByteLength, `${document.id} gzip size`);

  const gzipBytes = await readFile(new URL(document.artifactPath, root));
  assert.equal(gzipBytes.byteLength, document.gzipByteLength, `${document.id} deterministic gzip byte length`);
  assert.equal(sha256(gzipBytes), document.gzipSha256, `${document.id} deterministic gzip hash`);
  assert.equal(gzipBytes.readUInt32LE(4), 0, `${document.id} gzip -n timestamp`);
  assert.equal(gzipBytes[3] & 0x18, 0, `${document.id} gzip -n name/comment flags`);
  const responseBytes = gunzipSync(gzipBytes);
  assert.equal(responseBytes.byteLength, document.rawResponseByteLength, `${document.id} raw response byte length`);
  assert.equal(sha256(responseBytes), document.rawResponseSha256, `${document.id} raw response hash authority`);

  const retainedBytes = Buffer.from(document.retainedBytesUtf8, "utf8");
  assert.equal(retainedBytes.byteLength, document.retainedByteLength, `${document.id} retained byte length`);
  assert.equal(sha256(retainedBytes), document.retainedSha256, `${document.id} retained content hash`);
  assert.ok(retainedBytes.byteLength > 0 && retainedBytes.byteLength < 1024, `${document.id} compact evidence boundary`);
  assert.equal(deriveEvidence(document.id, responseBytes), document.retainedBytesUtf8, `${document.id} retained evidence derivation`);
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

const validateFacts = (frozenFacts, retainedEvidence) => {
  const settingsRecords = Object.fromEntries(
    retainedEvidence.get("settings-scopes").trimEnd().split("\n").map(line => line.split(" | ")),
  );
  assert.deepEqual(frozenFacts.portablePaths.value, [
    settingsRecords.User,
    `<workspace>/${settingsRecords["Shared project"]}`,
    `<workspace>/${settingsRecords["Project local"]}`,
  ], "portable paths must derive from retained settings evidence");
  assert.deepEqual(
    frozenFacts.portableSourcesLowToHigh.value,
    settingsRecords["Precedence, highest to lowest"].split(", ").toReversed(),
    "portable precedence must derive from retained settings evidence",
  );

  const schemaRecords = new Map(retainedEvidence.get("settings-keys-and-effort")
    .trimEnd().split("\n").map(line => {
      const record = JSON.parse(line);
      return [record.pointer, record.value];
    }));
  assert.deepEqual(
    frozenFacts.portableKeys.value,
    ["/properties/model", "/properties/effortLevel/enum"].map(pointer => pointer.split("/")[2]),
    "portable keys must derive from retained schema pointers",
  );
  assert.deepEqual(frozenFacts.effortValues.value, schemaRecords.get("/properties/effortLevel/enum"),
    "effort allowlist must derive from retained schema evidence");
  assert.deepEqual(frozenFacts.modelAliases.value, retainedEvidence.get("model-aliases").trimEnd().split(", "),
    "model allowlist must derive from retained model evidence");
  assert.equal(
    frozenFacts.managedPolicySeparateFromPortableIntent.value,
    retainedEvidence.get("managed-policy").includes("your organization deploys")
      && retainedEvidence.get("managed-policy").includes("above every other level")
      && retainedEvidence.get("managed-policy").includes("no user, project, local"),
    "managed-policy separation must derive from retained managed evidence",
  );
  const routeIdentifiers = new Set(retainedEvidence.get("provider-route").trimEnd().split("\n"));
  assert.equal(
    frozenFacts.providerRoutesSeparateFromPortableIntent.value,
    routeIdentifiers.has("CLAUDE_CODE_USE_BEDROCK")
      && routeIdentifiers.has("ANTHROPIC_MODEL")
      && [...routeIdentifiers].some(identifier => identifier.startsWith("ANTHROPIC_DEFAULT_"))
      && schemaRecords.has("/properties/model"),
    "provider-route separation must derive from retained route and schema evidence",
  );
};

export const validateOfficialSemantics = async (semanticArtifact, root = repositoryRoot) => {
  exactKeys(semanticArtifact,
    ["schemaVersion", "snapshotId", "retrieval", "historicalNonAuthority", "documents", "frozenFacts"],
    "official semantic artifact");
  exactKeys(semanticArtifact.retrieval, ["date", "method", "authority", "statement"], "official semantic artifact retrieval");
  exactKeys(semanticArtifact.historicalNonAuthority,
    ["snapshotId", "responseBodiesRetained", "documentCount", "statement"], "historical non-authority");
  assert.equal(semanticArtifact.schemaVersion, 3);
  assert.equal(semanticArtifact.snapshotId, "claude-code-settings-semantics@2026-08-28.r3");
  assert.equal(semanticArtifact.retrieval.date, "2026-08-28");
  assert.equal(semanticArtifact.retrieval.authority, "retained-exact-response-bytes");
  assert.match(semanticArtifact.retrieval.method, /deterministic gzip artifacts/u);
  assert.match(semanticArtifact.retrieval.statement, /Provider and executable qualification remain open/u);
  assert.equal(semanticArtifact.historicalNonAuthority.responseBodiesRetained, false);
  assert.equal(semanticArtifact.historicalNonAuthority.documentCount, 13);
  assert.match(semanticArtifact.historicalNonAuthority.statement, /no authority/u);
  assert.equal(semanticArtifact.documents.length, DOCUMENTS.length, "exactly five official response bodies retained");
  assert.deepEqual(semanticArtifact.documents.map(document => document.id), DOCUMENTS.map(document => document.id),
    "official evidence document order");
  unique(semanticArtifact.documents.map(document => document.artifactPath), "official evidence artifact paths");
  assert.ok(
    semanticArtifact.documents.reduce((total, document) => total + document.rawResponseByteLength, 0) < 500_000,
    "retained raw response total must stay below 500 KB",
  );
  assert.ok(
    semanticArtifact.documents.reduce((total, document) => total + document.gzipByteLength, 0) < 125_000,
    "retained deterministic gzip total must stay narrow",
  );

  const coordinates = new Set();
  const retainedEvidence = new Map();
  for (const [index, document] of semanticArtifact.documents.entries()) {
    await validateDocument(document, {
      coordinates,
      expected: DOCUMENTS[index],
      retainedEvidence,
      retrievalDate: semanticArtifact.retrieval.date,
      root,
    });
  }
  validateFactCoordinates(semanticArtifact.frozenFacts, coordinates);
  validateFacts(semanticArtifact.frozenFacts, retainedEvidence);
  return semanticArtifact.frozenFacts;
};
