import { createHash } from "node:crypto";

export const CONTAINED_TURN_ARTIFACT_MANIFEST_SCHEMA_VERSION = 3 as const;
export const MAX_CONTAINED_TURN_ARTIFACT_MANIFEST_ENTRIES = 4_096;
export const MAX_CONTAINED_TURN_ARTIFACT_OUTPUT_RECORDS = 2_048;

const MAX_ENCODED_MANIFEST_BYTES = 32 * 1_024 * 1_024;
const MAX_OPERATION_ID_BYTES = 1_024;
const MAX_PORTABLE_COMPONENT_BYTES = 255;
const MAX_PORTABLE_PATH_BYTES = 4_096;
const SHA256_DIGEST = /^[a-f\d]{64}$/u;
const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = '<>:"\\|?*';
const OUTPUT_KINDS = new Set(["assistant", "diagnostic", "progress"]);

export type ContainedTurnArtifactOutputKind = "assistant" | "diagnostic" | "progress";

export interface ContainedTurnArtifactDirectoryEntry {
  readonly kind: "directory";
  readonly mode: number;
  readonly path: string;
}

export interface ContainedTurnArtifactFileEntry {
  readonly digest: string;
  readonly kind: "file";
  readonly mode: number;
  readonly path: string;
  readonly size: number;
}

export type ContainedTurnArtifactEntry =
  | ContainedTurnArtifactDirectoryEntry
  | ContainedTurnArtifactFileEntry;

export interface ContainedTurnArtifactOutputRecord {
  readonly cursor: number;
  readonly digest: string;
  readonly kind: ContainedTurnArtifactOutputKind;
  readonly size: number;
}

export interface ContainedTurnArtifactManifest {
  readonly entries: readonly ContainedTurnArtifactEntry[];
  readonly operationId: string;
  readonly output: readonly ContainedTurnArtifactOutputRecord[];
  readonly projectId: string;
  readonly schemaVersion: typeof CONTAINED_TURN_ARTIFACT_MANIFEST_SCHEMA_VERSION;
  readonly treeDigest: string;
  readonly tenantId: string;
}

export class ContainedTurnArtifactManifestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContainedTurnArtifactManifestError";
  }
}

const fail = (message: string): never => {
  throw new ContainedTurnArtifactManifestError(message);
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype) {return fail(`${label} must be a plain object`);}
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some(key => typeof key !== "string" || !expected.includes(key))
  ) {
    fail(`${label} has unexpected or missing keys`);
  }
};

const nonnegativeSafeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${label} must be a nonnegative safe integer`);
  }
  return value;
};

const portableMode = (value: unknown, label: string): number => {
  const mode = nonnegativeSafeInteger(value, label);
  if (mode > 0o777) {return fail(`${label} exceeds portable permission bits`);}
  return mode;
};

const digest = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    return fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const operationId = (value: unknown): string => {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > MAX_OPERATION_ID_BYTES
  ) {
    return fail("contained turn artifact operationId is invalid");
  }
  return value;
};

const scopeId = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\u0000") ||
    value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > MAX_OPERATION_ID_BYTES
  ) {
    return fail(`${label} is invalid`);
  }
  return value;
};

const portableRelativePath = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" || value.length === 0 || value.startsWith("/") ||
    value.endsWith("/") || value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > MAX_PORTABLE_PATH_BYTES
  ) {
    return fail(`${label} is not a portable relative path`);
  }
  const components = value.split("/");
  for (const component of components) {
    const containsForbiddenCharacter = [...component].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f ||
        WINDOWS_FORBIDDEN_CHARACTERS.includes(character);
    });
    if (
      component.length === 0 || component === "." || component === ".." ||
      component !== component.normalize("NFC") || /[ .]$/u.test(component) ||
      WINDOWS_RESERVED_NAME.test(component) || containsForbiddenCharacter ||
      Buffer.byteLength(component, "utf8") > MAX_PORTABLE_COMPONENT_BYTES
    ) {
      return fail(`${label} is not a portable relative path`);
    }
  }
  return value;
};

const portableCollisionKey = (name: string): string =>
  name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");

const parseEntry = (value: unknown, index: number): ContainedTurnArtifactEntry => {
  const label = `contained turn artifact entry ${index}`;
  const record = asRecord(value, label);
  const path = portableRelativePath(record.path, `${label} path`);
  const mode = portableMode(record.mode, `${label} mode`);
  if (record.kind === "directory") {
    assertExactKeys(record, ["kind", "path", "mode"], label);
    return Object.freeze({ kind: "directory", path, mode });
  }
  if (record.kind === "file") {
    assertExactKeys(record, ["kind", "path", "mode", "size", "digest"], label);
    return Object.freeze({
      kind: "file",
      path,
      mode,
      size: nonnegativeSafeInteger(record.size, `${label} size`),
      digest: digest(record.digest, `${label} digest`),
    });
  }
  return fail(`${label} has an invalid kind`);
};

const validateEntries = (value: unknown): readonly ContainedTurnArtifactEntry[] => {
  if (!Array.isArray(value)) {return fail("contained turn artifact entries must be an array");}
  if (value.length > MAX_CONTAINED_TURN_ARTIFACT_MANIFEST_ENTRIES) {
    return fail("contained turn artifact manifest has too many entries");
  }
  const entries = value.map(parseEntry);
  const byPath = new Map<string, ContainedTurnArtifactEntry>();
  const siblingKeys = new Map<string, Set<string>>();
  let previousPath: string | undefined;
  for (const entry of entries) {
    if (previousPath !== undefined && previousPath >= entry.path) {
      fail("contained turn artifact entries are not in canonical path order");
    }
    previousPath = entry.path;
    byPath.set(entry.path, entry);
    const separator = entry.path.lastIndexOf("/");
    const parent = separator === -1 ? "" : entry.path.slice(0, separator);
    const name = separator === -1 ? entry.path : entry.path.slice(separator + 1);
    const key = portableCollisionKey(name);
    const keys = siblingKeys.get(parent) ?? new Set<string>();
    if (keys.has(key)) {fail("contained turn artifact entries contain a case or Unicode collision");}
    keys.add(key);
    siblingKeys.set(parent, keys);
  }
  for (const entry of entries) {
    const separator = entry.path.lastIndexOf("/");
    if (separator === -1) {continue;}
    const parent = byPath.get(entry.path.slice(0, separator));
    if (parent?.kind !== "directory") {
      fail("contained turn artifact entry has no committed parent directory");
    }
  }
  return Object.freeze(entries);
};

const parseOutputRecord = (
  value: unknown,
  index: number,
): ContainedTurnArtifactOutputRecord => {
  const label = `contained turn artifact output ${index}`;
  const record = asRecord(value, label);
  assertExactKeys(record, ["cursor", "digest", "kind", "size"], label);
  const cursor = nonnegativeSafeInteger(record.cursor, `${label} cursor`);
  if (cursor !== index) {return fail("contained turn artifact output cursors are not contiguous");}
  if (typeof record.kind !== "string" || !OUTPUT_KINDS.has(record.kind)) {
    return fail(`${label} has an invalid kind`);
  }
  return Object.freeze({
    cursor,
    digest: digest(record.digest, `${label} digest`),
    kind: record.kind as ContainedTurnArtifactOutputKind,
    size: nonnegativeSafeInteger(record.size, `${label} size`),
  });
};

const validateOutput = (value: unknown): readonly ContainedTurnArtifactOutputRecord[] => {
  if (!Array.isArray(value)) {return fail("contained turn artifact output must be an array");}
  if (value.length > MAX_CONTAINED_TURN_ARTIFACT_OUTPUT_RECORDS) {
    return fail("contained turn artifact manifest has too many output records");
  }
  return Object.freeze(value.map(parseOutputRecord));
};

const treeIdentityBytes = (entries: readonly ContainedTurnArtifactEntry[]): Buffer => {
  const identity = entries.map(entry => entry.kind === "directory"
    ? [entry.kind, entry.path, entry.mode]
    : [entry.kind, entry.path, entry.mode, entry.size, entry.digest]);
  return Buffer.from(JSON.stringify(identity), "utf8");
};

export const encodeContainedTurnArtifactTreeIdentity = (
  entries: readonly ContainedTurnArtifactEntry[],
): Buffer => treeIdentityBytes(validateEntries(entries));

export const computeContainedTurnArtifactTreeDigest = (
  entries: readonly ContainedTurnArtifactEntry[],
): string => createHash("sha256").update(encodeContainedTurnArtifactTreeIdentity(entries)).digest("hex");

export const validateContainedTurnArtifactManifest = (
  value: unknown,
): ContainedTurnArtifactManifest => {
  const record = asRecord(value, "contained turn artifact manifest");
  assertExactKeys(
    record,
    ["schemaVersion", "operationId", "projectId", "tenantId", "entries", "output", "treeDigest"],
    "contained turn artifact manifest",
  );
  if (record.schemaVersion !== CONTAINED_TURN_ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    return fail("contained turn artifact manifest has an unsupported schemaVersion");
  }
  const entries = validateEntries(record.entries);
  const treeDigest = digest(record.treeDigest, "contained turn artifact treeDigest");
  const recomputedTreeDigest = createHash("sha256").update(treeIdentityBytes(entries)).digest("hex");
  if (treeDigest !== recomputedTreeDigest) {
    return fail("contained turn artifact treeDigest does not match its entries");
  }
  return Object.freeze({
    schemaVersion: CONTAINED_TURN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    operationId: operationId(record.operationId),
    projectId: scopeId(record.projectId, "contained turn artifact projectId"),
    entries,
    output: validateOutput(record.output),
    treeDigest,
    tenantId: scopeId(record.tenantId, "contained turn artifact tenantId"),
  });
};

const canonicalManifestBytes = (manifest: ContainedTurnArtifactManifest): Buffer => Buffer.from(JSON.stringify({
  schemaVersion: manifest.schemaVersion,
  operationId: manifest.operationId,
  projectId: manifest.projectId,
  tenantId: manifest.tenantId,
  entries: manifest.entries,
  output: manifest.output,
  treeDigest: manifest.treeDigest,
}), "utf8");

export const encodeContainedTurnArtifactManifest = (
  value: ContainedTurnArtifactManifest,
): Buffer => canonicalManifestBytes(validateContainedTurnArtifactManifest(value));

export const computeContainedTurnArtifactManifestDigest = (
  value: ContainedTurnArtifactManifest,
): string => createHash("sha256").update(encodeContainedTurnArtifactManifest(value)).digest("hex");

export const decodeContainedTurnArtifactManifest = (
  value: string | Uint8Array,
): ContainedTurnArtifactManifest => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (bytes.length > MAX_ENCODED_MANIFEST_BYTES) {
    return fail("contained turn artifact manifest exceeds its encoded byte limit");
  }
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("contained turn artifact manifest is not valid UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return fail("contained turn artifact manifest is not valid JSON");
  }
  const manifest = validateContainedTurnArtifactManifest(decoded);
  if (!canonicalManifestBytes(manifest).equals(bytes)) {
    return fail("contained turn artifact manifest is not canonically encoded");
  }
  return manifest;
};

const parseUrnDigest = (value: string, prefix: string, label: string): string => {
  if (!value.startsWith(prefix)) {return fail(`${label} has an invalid URN`);}
  const parsed = value.slice(prefix.length);
  if (!SHA256_DIGEST.test(parsed)) {return fail(`${label} has an invalid digest`);}
  return parsed;
};

export const parseContainedTurnArtifactManifestUrnDigest = (value: string): string =>
  parseUrnDigest(value, "urn:agent-runtime:artifact-manifest:", "contained turn artifact manifest reference");

export const parseContainedTurnResultUrnDigest = (value: string): string =>
  parseUrnDigest(value, "urn:agent-runtime:contained-turn-result:", "contained turn result reference");
