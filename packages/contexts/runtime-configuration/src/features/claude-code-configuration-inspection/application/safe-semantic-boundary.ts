import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  CLAUDE_CODE_MODEL_DEFAULT,
  type ClaudeCodeConfigurationDiagnosticCode,
  type ClaudeCodeEffort,
  type ClaudeCodeModelAlias, type ClaudeCodeModelSelection,
} from "../contracts/claude-code-configuration-inspection.js";
import type {
  ClassifyClaudeCodeConfigurationResult,
  PortableClaudeCodeDefinition,
} from "./ports/outbound/claude-code-configuration-semantic-classifier.js";
import type { ParseClaudeCodeJsonResult } from "./ports/outbound/claude-code-json-parser.js";

interface NormalizationState {
  readonly ancestors: Set<object>;
  arrayItems: number;
  nodes: number;
  objectKeys: number;
}

const portableKeys = new Set(["model", "effortLevel"] as const);
const modelAliases = new Set<string>(CLAUDE_CODE_MODEL_ALIASES);
const effortValues = new Set<string>(CLAUDE_CODE_EFFORT_VALUES);
const diagnosticCodes = new Set<ClaudeCodeConfigurationDiagnosticCode>([
  "configuration_dialect_unsupported", "config_duplicate_key", "config_invalid_utf8",
  "config_parse_failed", "config_too_large", "config_unreadable",
  "credential_material_rejected", "provider_route_deferred", "secret_setting_rejected",
  "setting_type_unsupported", "setting_value_unsupported", "source_epoch_stale",
  "source_untrusted",
  "source_inventory_overflow", "source_plan_invalid", "source_plan_unsupported",
  "source_total_too_large",
]);
const parserDiagnosticCodes = new Set<ClaudeCodeConfigurationDiagnosticCode>([
  "config_duplicate_key", "config_invalid_utf8", "config_parse_failed", "config_too_large",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return false;}
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const dataDescriptors = (value: object): Readonly<Record<string, PropertyDescriptor>> | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(descriptor =>
    descriptor.enumerable === true && "value" in descriptor &&
    descriptor.get === undefined && descriptor.set === undefined)
    ? descriptors
    : undefined;
};

const denseArray = (value: readonly unknown[]): readonly unknown[] | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) {return undefined;}
  const descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<Record<string, PropertyDescriptor>>;
  if (descriptors["length"]?.value !== value.length ||
      Object.keys(descriptors).length !== value.length + 1) {return undefined;}
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true ||
        !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {return undefined;}
    output.push(descriptor.value);
  }
  return output;
};

const normalizeScalar = (value: unknown): unknown => {
  if (value === null || typeof value === "boolean") {return value;}
  if (typeof value === "number" && Number.isFinite(value)) {return value;}
  if (typeof value === "string" &&
      value.length <= CLAUDE_CODE_CONFIGURATION_BUDGETS.stringLength) {return value;}
  throw new TypeError("scalar");
};

const normalizeArray = (
  value: readonly unknown[],
  depth: number,
  state: NormalizationState,
): readonly unknown[] => {
  const items = denseArray(value);
  if (items === undefined) {throw new TypeError("array");}
  state.arrayItems += items.length;
  if (state.arrayItems > CLAUDE_CODE_CONFIGURATION_BUDGETS.arrayItems) {
    throw new TypeError("array budget");
  }
  return Object.freeze(items.map(item => normalize(item, depth + 1, state)));
};

const normalizeRecord = (
  value: object,
  depth: number,
  state: NormalizationState,
): Readonly<Record<string, unknown>> => {
  if (!isPlainRecord(value)) {throw new TypeError("record");}
  const descriptors = dataDescriptors(value);
  if (descriptors === undefined) {throw new TypeError("properties");}
  const keys = Object.keys(descriptors);
  state.objectKeys += keys.length;
  if (state.objectKeys > CLAUDE_CODE_CONFIGURATION_BUDGETS.objectKeys) {
    throw new TypeError("key budget");
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (key.length === 0 || key.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.keyLength) {
      throw new TypeError("key");
    }
    output[key] = normalize(descriptors[key]?.value, depth + 1, state);
  }
  return Object.freeze(output);
};

const normalizeContainer = (
  value: object,
  depth: number,
  state: NormalizationState,
): unknown => {
  if (state.ancestors.has(value)) {throw new TypeError("cycle");}
  state.ancestors.add(value);
  try {
    return Array.isArray(value)
      ? normalizeArray(value, depth, state)
      : normalizeRecord(value, depth, state);
  } finally {
    state.ancestors.delete(value);
  }
};

function normalize(value: unknown, depth: number, state: NormalizationState): unknown {
  state.nodes += 1;
  if (depth > CLAUDE_CODE_CONFIGURATION_BUDGETS.depth ||
      state.nodes > CLAUDE_CODE_CONFIGURATION_BUDGETS.nodes) {
    throw new TypeError("budget");
  }
  if (typeof value === "object" && value !== null) {
    return normalizeContainer(value, depth, state);
  }
  return normalizeScalar(value);
}

export const normalizeParsedClaudeCodeDocument = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (!isPlainRecord(value)) {return undefined;}
    const normalized = normalize(value, 0, {
      ancestors: new Set(), arrayItems: 0, nodes: 0, objectKeys: 0,
    });
    return isPlainRecord(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const exactRecord = (value: unknown, keys: ReadonlySet<string>): Readonly<Record<string, unknown>> | undefined => {
  if (!isPlainRecord(value)) {return undefined;}
  const descriptors = dataDescriptors(value);
  if (descriptors === undefined || Object.keys(descriptors).some(key => !keys.has(key))) {return undefined;}
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors)) {output[key] = descriptors[key]?.value;}
  return output;
};

export const validateClaudeCodeJsonParseResult = (
  value: unknown,
): ParseClaudeCodeJsonResult | undefined => {
  const record = exactRecord(value, new Set(["data", "diagnostic", "status"]));
  if (record === undefined || typeof record.status !== "string") {return undefined;}
  if (record.status === "parsed" && Object.keys(record).length === 2 && "data" in record) {
    return { data: record.data as Readonly<Record<string, unknown>>, status: "parsed" };
  }
  if (record.status === "rejected" && Object.keys(record).length === 2 &&
      typeof record.diagnostic === "string" &&
      parserDiagnosticCodes.has(record.diagnostic as ClaudeCodeConfigurationDiagnosticCode)) {
    return {
      diagnostic: record.diagnostic as Extract<
        ParseClaudeCodeJsonResult,
        { readonly status: "rejected" }
      >["diagnostic"],
      status: "rejected",
    };
  }
  return undefined;
};

const exactPortableKeys = (value: unknown): readonly ("model" | "effortLevel")[] => {
  if (!Array.isArray(value)) {throw new TypeError("keys");}
  const items = denseArray(value);
  if (items === undefined || items.length > 2) {throw new TypeError("keys");}
  const keys = items.map(item => {
    if (typeof item !== "string" || !portableKeys.has(item as "model" | "effortLevel")) {throw new TypeError("key");}
    return item as "model" | "effortLevel";
  });
  if (new Set(keys).size !== keys.length) {throw new TypeError("duplicate key");}
  return Object.freeze(keys.toSorted());
};

const modelSelection = (value: unknown): ClaudeCodeModelSelection => {
  const record = exactRecord(value, new Set(["kind", "value"]));
  if (record === undefined || typeof record.kind !== "string") {throw new TypeError("selection");}
  if (record.kind === "provider-default" && Object.keys(record).length === 1) {
    return Object.freeze({ kind: "provider-default" });
  }
  if (record.kind === "alias" && Object.keys(record).length === 2 &&
      typeof record.value === "string" && modelAliases.has(record.value) &&
      record.value !== CLAUDE_CODE_MODEL_DEFAULT) {
    return Object.freeze({ kind: "alias", value: record.value as ClaudeCodeModelAlias });
  }
  if (record.kind === "exact-name" && Object.keys(record).length === 2 &&
      typeof record.value === "string" &&
      /^claude-[a-z0-9]+(?:-[a-z0-9]+)*(?:\[1m\])?$/u.test(record.value)) {
    return Object.freeze({ kind: "exact-name", value: record.value });
  }
  throw new TypeError("selection");
};

const definitions = (value: unknown): readonly PortableClaudeCodeDefinition[] => {
  if (!Array.isArray(value)) {throw new TypeError("definitions");}
  const items = denseArray(value);
  if (items === undefined || items.length > 2) {throw new TypeError("definitions");}
  const output = items.map(item => {
    const record = exactRecord(item, new Set(["key", "selection", "value"]));
    if (record === undefined || typeof record.key !== "string") {throw new TypeError("definition");}
    if (record.key === "model" && Object.keys(record).length === 2 && "selection" in record) {
      return Object.freeze({ key: "model" as const, selection: modelSelection(record.selection) });
    }
    if (record.key === "effortLevel" && Object.keys(record).length === 2 &&
        typeof record.value === "string" && effortValues.has(record.value)) {
      return Object.freeze({ key: "effortLevel" as const, value: record.value as ClaudeCodeEffort });
    }
    throw new TypeError("definition value");
  });
  if (new Set(output.map(item => item.key)).size !== output.length) {throw new TypeError("duplicate definition");}
  return Object.freeze(output.toSorted((left, right) => left.key < right.key ? -1 : 1));
};

const deferredObservations = (value: unknown): ClassifyClaudeCodeConfigurationResult["deferredObservations"] => {
  if (!Array.isArray(value)) {throw new TypeError("deferred observations");}
  const items = denseArray(value);
  if (items === undefined || items.length > 1) {throw new TypeError("deferred observations");}
  return Object.freeze(items.map(item => {
    const record = exactRecord(item, new Set(["form", "key", "status"]));
    if (record === undefined || Object.keys(record).length !== 3 || record.key !== "model" ||
        record.status !== "deferred" ||
        (record.form !== "provider-deployment" && record.form !== "unclassified-selector")) {
      throw new TypeError("deferred observation");
    }
    return Object.freeze({ form: record.form, key: "model" as const, status: "deferred" as const });
  }));
};

const diagnostics = (value: unknown): ClassifyClaudeCodeConfigurationResult["diagnostics"] => {
  if (!Array.isArray(value)) {throw new TypeError("diagnostics");}
  const items = denseArray(value);
  if (items === undefined || items.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.diagnostics) {throw new TypeError("diagnostics");}
  const output = items.map(item => {
    const record = exactRecord(item, new Set(["code"]));
    if (record === undefined || typeof record.code !== "string" ||
        !diagnosticCodes.has(record.code as ClaudeCodeConfigurationDiagnosticCode)) {throw new TypeError("diagnostic");}
    return Object.freeze({ code: record.code as ClaudeCodeConfigurationDiagnosticCode });
  });
  if (new Set(output.map(item => item.code)).size !== output.length) {throw new TypeError("duplicate diagnostic");}
  return Object.freeze(output.toSorted((left, right) => left.code < right.code ? -1 : 1));
};

export const validateClaudeCodeSemanticClassification = (
  value: unknown,
): ClassifyClaudeCodeConfigurationResult => {
  try {
    const record = exactRecord(value, new Set([
      "definitions", "deferredObservations", "diagnostics", "definedPortableKeys", "taintedPortableKeys",
    ]));
    if (record === undefined || Object.keys(record).length !== 5) {throw new TypeError("classification");}
    const safeDefinitions = definitions(record.definitions);
    const safeDeferred = deferredObservations(record.deferredObservations);
    const safeDiagnostics = diagnostics(record.diagnostics);
    const defined = exactPortableKeys(record.definedPortableKeys);
    const tainted = exactPortableKeys(record.taintedPortableKeys);
    const definitionKeys = safeDefinitions.map(item => item.key);
    const deferredKeys = safeDeferred.map(item => item.key);
    if (new Set(definitionKeys).size !== definitionKeys.length ||
        new Set(deferredKeys).size !== deferredKeys.length ||
        definitionKeys.some(key => key === "model" && deferredKeys.includes(key)) ||
        tainted.some(key => definitionKeys.includes(key) || (key === "model" && deferredKeys.includes(key))) ||
        [...new Set([...definitionKeys, ...deferredKeys, ...tainted])].toSorted().join("\0") !== defined.join("\0")) {
      throw new TypeError("classification consistency");
    }
    return Object.freeze({
      definitions: safeDefinitions, deferredObservations: safeDeferred, diagnostics: safeDiagnostics,
      definedPortableKeys: defined, taintedPortableKeys: tainted,
    });
  } catch {
    throw new TypeError("semantic classifier returned an invalid result");
  }
};
