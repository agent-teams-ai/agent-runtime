import type {
  CodexConfigurationDiagnostic,
  PortableCodexSettingKey,
} from "../contracts/codex-configuration-inspection.js";
import type { CodexConfigurationSemanticClassification } from "./ports/outbound/codex-configuration-semantic-classifier.js";

const maximumDepth = 16;
const maximumNodes = 4_096;
const maximumArrayItems = 1_024;
const maximumObjectKeys = 1_024;
const maximumKeyLength = 256;
const maximumStringLength = 16_384;
const maximumClassifierSettings = 256;
const maximumClassifierDiagnostics = maximumObjectKeys;
const maximumClassifierStringLength = 256;

const portableSettingKeys = new Set<PortableCodexSettingKey>([
  "model",
  "model_reasoning_effort",
  "personality",
]);
const classifierDiagnosticCodes = new Set<CodexConfigurationDiagnostic["code"]>([
  "executable_setting_deferred",
  "provider_access_setting_deferred",
  "secret_setting_ignored",
  "security_setting_deferred",
  "setting_type_unsupported",
  "setting_value_unsupported",
  "unknown_setting_ignored",
]);
const dangerousObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const safeSettingName = /^[A-Za-z0-9_.-]{1,128}$/u;
const secretNameShape = /(api[_-]?key|credential|oauth|password|secret|token)/iu;
const secretValueShape =
  /(?:api[_-]?key|credential|oauth|password|secret|token|\bBearer\s+\S+|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:github_pat_|gh[pousr]_|glpat-|npm_|sk-|xox[baprs]-)[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9_]{32,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;

interface NormalizationState {
  readonly ancestors: Set<object>;
  nodes: number;
}

type NormalizedScalar =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly value: unknown };

const opaqueScalar = (kind: "non-finite-number" | "toml-bigint" | "toml-date"): object =>
  Object.freeze(Object.assign(Object.create(null) as object, { kind }));

const nonFiniteNumber = opaqueScalar("non-finite-number");
const tomlBigint = opaqueScalar("toml-bigint");
const tomlDate = opaqueScalar("toml-date");

export const isSecretShapedValue = (value: string): boolean =>
  secretValueShape.test(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const dataDescriptors = (
  value: Record<string, unknown>,
): Readonly<Record<string, PropertyDescriptor>> | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(descriptor =>
      descriptor.enumerable === true &&
      "value" in descriptor &&
      descriptor.get === undefined &&
      descriptor.set === undefined
    )
    ? descriptors
    : undefined;
};

const denseArrayValues = (value: readonly unknown[]): readonly unknown[] | undefined => {
  if (value.length > maximumArrayItems || Object.getOwnPropertySymbols(value).length > 0) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
    Record<string, PropertyDescriptor>
  >;
  const keys = Object.keys(descriptors);
  if (
    keys.length !== value.length + 1 ||
    descriptors["length"]?.value !== value.length
  ) {
    return undefined;
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return undefined;
    }
    items.push(descriptor.value);
  }
  return items;
};

const normalizeScalar = (input: unknown): NormalizedScalar => {
  if (typeof input === "boolean") {
    return { accepted: true, value: input };
  }
  if (typeof input === "number") {
    return { accepted: true, value: Number.isFinite(input) ? input : nonFiniteNumber };
  }
  if (typeof input === "bigint") {
    return { accepted: true, value: tomlBigint };
  }
  if (typeof input === "string" && input.length <= maximumStringLength) {
    return { accepted: true, value: input };
  }
  return { accepted: false };
};

const isDateScalar = (input: object): boolean => {
  try {
    Date.prototype.getTime.call(input);
    return true;
  } catch {
    return false;
  }
};

const normalizeDocumentArray = (
  input: readonly unknown[],
  depth: number,
  state: NormalizationState,
): readonly unknown[] => {
  const values = denseArrayValues(input);
  if (values === undefined) {
    throw new TypeError("unsafe array");
  }
  return Object.freeze(
    values.map(item => normalizeDocumentValue(item, depth + 1, state)),
  );
};

const normalizeDocumentRecord = (
  input: object,
  depth: number,
  state: NormalizationState,
): Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(input)) {
    throw new TypeError("unsafe object");
  }
  const descriptors = dataDescriptors(input);
  const keys = descriptors === undefined ? [] : Object.keys(descriptors);
  if (descriptors === undefined || keys.length > maximumObjectKeys) {
    throw new TypeError("unsafe object properties");
  }
  const normalized: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (
      key.length === 0 ||
      key.length > maximumKeyLength ||
      key.includes("\0") ||
      dangerousObjectKeys.has(key)
    ) {
      throw new TypeError("unsafe object key");
    }
    normalized[key] = normalizeDocumentValue(descriptors[key]?.value, depth + 1, state);
  }
  return Object.freeze(normalized);
};

const normalizeDocumentValue = (
  input: unknown,
  depth: number,
  state: NormalizationState,
): unknown => {
  state.nodes += 1;
  if (state.nodes > maximumNodes || depth > maximumDepth) {
    throw new TypeError("document budget exceeded");
  }
  const scalar = normalizeScalar(input);
  if (scalar.accepted) {
    return scalar.value;
  }
  if (typeof input !== "object" || input === null) {
    throw new TypeError("unsupported document value");
  }
  if (isDateScalar(input)) {
    return tomlDate;
  }
  if (state.ancestors.has(input)) {
    throw new TypeError("cyclic document");
  }
  state.ancestors.add(input);
  try {
    return Array.isArray(input)
      ? normalizeDocumentArray(input, depth, state)
      : normalizeDocumentRecord(input, depth, state);
  } finally {
    state.ancestors.delete(input);
  }
};

export const normalizeParsedCodexDocument = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (!isPlainRecord(value)) {
      return undefined;
    }
    const normalized = normalizeDocumentValue(value, 0, {
      ancestors: new Set(),
      nodes: 0,
    });
    return isPlainRecord(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const exactDataRecord = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const descriptors = dataDescriptors(value);
  if (descriptors === undefined) {
    return undefined;
  }
  const keys = Object.keys(descriptors);
  if (keys.some(key => !allowedKeys.has(key))) {
    return undefined;
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    record[key] = descriptors[key]?.value;
  }
  return record;
};

const classificationArray = (
  value: unknown,
  maximumItems: number,
): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return undefined;
  }
  return denseArrayValues(value);
};

const invalidClassification = (): never => {
  throw new TypeError("semantic classifier returned an invalid result");
};

const safeDiagnosticSetting = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= maximumClassifierStringLength &&
  safeSettingName.test(value) &&
  !secretNameShape.test(value);

const validateDiagnostic = (
  raw: unknown,
): CodexConfigurationSemanticClassification["diagnostics"][number] => {
  const diagnostic = exactDataRecord(raw, new Set(["code", "setting"]));
  if (diagnostic === undefined) {
    return invalidClassification();
  }
  const code = diagnostic.code;
  if (
    typeof code !== "string" ||
    !classifierDiagnosticCodes.has(code as CodexConfigurationDiagnostic["code"])
  ) {
    return invalidClassification();
  }
  const setting = diagnostic.setting;
  if (setting !== undefined && !safeDiagnosticSetting(setting)) {
    return invalidClassification();
  }
  return {
    code: code as CodexConfigurationDiagnostic["code"],
    ...(setting === undefined ? {} : { setting }),
  };
};

const containsControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
};

const validateSetting = (
  raw: unknown,
): CodexConfigurationSemanticClassification["settings"][number] => {
  const setting = exactDataRecord(raw, new Set(["key", "value"]));
  if (setting === undefined) {
    return invalidClassification();
  }
  const key = setting.key;
  const settingValue = setting.value;
  if (
    typeof key !== "string" ||
    !portableSettingKeys.has(key as PortableCodexSettingKey) ||
    typeof settingValue !== "string" ||
    settingValue.length === 0 ||
    settingValue.length > maximumClassifierStringLength ||
    containsControlCharacter(settingValue) ||
    isSecretShapedValue(settingValue)
  ) {
    return invalidClassification();
  }
  return { key: key as PortableCodexSettingKey, value: settingValue };
};

const validateDiagnostics = (
  rawDiagnostics: readonly unknown[],
): CodexConfigurationSemanticClassification["diagnostics"] => {
  const diagnostics: CodexConfigurationSemanticClassification["diagnostics"][number][] = [];
  for (const raw of rawDiagnostics) {
    const diagnostic = validateDiagnostic(raw);
    diagnostics.push(Object.freeze(diagnostic));
  }
  return Object.freeze(diagnostics);
};

const validateSettings = (
  rawSettings: readonly unknown[],
): CodexConfigurationSemanticClassification["settings"] => {
  const settings: CodexConfigurationSemanticClassification["settings"][number][] = [];
  const keys = new Set<PortableCodexSettingKey>();
  for (const raw of rawSettings) {
    const setting = validateSetting(raw);
    if (keys.has(setting.key)) {
      return invalidClassification();
    }
    keys.add(setting.key);
    settings.push(Object.freeze(setting));
  }
  return Object.freeze(settings);
};

export const validateSemanticClassification = (
  value: unknown,
): CodexConfigurationSemanticClassification => {
  try {
    const root = exactDataRecord(value, new Set(["diagnostics", "settings"]));
    if (root === undefined || !("diagnostics" in root) || !("settings" in root)) {
      return invalidClassification();
    }
    const rawDiagnostics = classificationArray(
      root.diagnostics,
      maximumClassifierDiagnostics,
    );
    const rawSettings = classificationArray(root.settings, maximumClassifierSettings);
    if (rawDiagnostics === undefined || rawSettings === undefined) {
      return invalidClassification();
    }
    return Object.freeze({
      diagnostics: validateDiagnostics(rawDiagnostics),
      settings: validateSettings(rawSettings),
    });
  } catch {
    throw new TypeError("semantic classifier returned an invalid result");
  }
};
