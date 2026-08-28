import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  CLAUDE_CODE_EFFORT_VALUES,
  CLAUDE_CODE_MODEL_ALIASES,
  type ClaudeCodeConfigurationDiagnosticCode,
  type ClaudeCodeEffort,
  type ClaudeCodeModelAlias,
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
]);
const parserDiagnosticCodes = new Set<ClaudeCodeConfigurationDiagnosticCode>([
  "config_duplicate_key", "config_invalid_utf8", "config_parse_failed", "config_too_large",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const dataDescriptors = (value: object): Readonly<Record<string, PropertyDescriptor>> | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every(descriptor =>
    descriptor.enumerable === true && "value" in descriptor &&
    descriptor.get === undefined && descriptor.set === undefined)
    ? descriptors
    : undefined;
};

const denseArray = (value: readonly unknown[]): readonly unknown[] | undefined => {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<Record<string, PropertyDescriptor>>;
  if (descriptors["length"]?.value !== value.length ||
      Object.keys(descriptors).length !== value.length + 1) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true ||
        !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
    output.push(descriptor.value);
  }
  return output;
};

const normalize = (value: unknown, depth: number, state: NormalizationState): unknown => {
  state.nodes += 1;
  if (depth > CLAUDE_CODE_CONFIGURATION_BUDGETS.depth ||
      state.nodes > CLAUDE_CODE_CONFIGURATION_BUDGETS.nodes) throw new TypeError("budget");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("number");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.stringLength) throw new TypeError("string");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("value");
  if (state.ancestors.has(value)) throw new TypeError("cycle");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = denseArray(value);
      if (items === undefined) throw new TypeError("array");
      state.arrayItems += items.length;
      if (state.arrayItems > CLAUDE_CODE_CONFIGURATION_BUDGETS.arrayItems) throw new TypeError("array budget");
      return Object.freeze(items.map(item => normalize(item, depth + 1, state)));
    }
    if (!isPlainRecord(value)) throw new TypeError("record");
    const descriptors = dataDescriptors(value);
    if (descriptors === undefined) throw new TypeError("properties");
    const keys = Object.keys(descriptors);
    state.objectKeys += keys.length;
    if (state.objectKeys > CLAUDE_CODE_CONFIGURATION_BUDGETS.objectKeys) throw new TypeError("key budget");
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (key.length === 0 || key.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.keyLength) throw new TypeError("key");
      output[key] = normalize(descriptors[key]?.value, depth + 1, state);
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(value);
  }
};

export const normalizeParsedClaudeCodeDocument = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    if (!isPlainRecord(value)) return undefined;
    const normalized = normalize(value, 0, {
      ancestors: new Set(), arrayItems: 0, nodes: 0, objectKeys: 0,
    });
    return isPlainRecord(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
};

const exactRecord = (value: unknown, keys: ReadonlySet<string>): Readonly<Record<string, unknown>> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const descriptors = dataDescriptors(value);
  if (descriptors === undefined || Object.keys(descriptors).some(key => !keys.has(key))) return undefined;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors)) output[key] = descriptors[key]?.value;
  return output;
};

export const validateClaudeCodeJsonParseResult = (
  value: unknown,
): ParseClaudeCodeJsonResult | undefined => {
  const record = exactRecord(value, new Set(["data", "diagnostic", "status"]));
  if (record === undefined || typeof record.status !== "string") return undefined;
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
  if (!Array.isArray(value)) throw new TypeError("keys");
  const items = denseArray(value);
  if (items === undefined || items.length > 2) throw new TypeError("keys");
  const keys = items.map(item => {
    if (typeof item !== "string" || !portableKeys.has(item as "model" | "effortLevel")) throw new TypeError("key");
    return item as "model" | "effortLevel";
  });
  if (new Set(keys).size !== keys.length) throw new TypeError("duplicate key");
  return Object.freeze(keys.toSorted());
};

const definitions = (value: unknown): readonly PortableClaudeCodeDefinition[] => {
  if (!Array.isArray(value)) throw new TypeError("definitions");
  const items = denseArray(value);
  if (items === undefined || items.length > 2) throw new TypeError("definitions");
  const output = items.map(item => {
    const record = exactRecord(item, new Set(["key", "value"]));
    if (record === undefined || typeof record.key !== "string" || typeof record.value !== "string") throw new TypeError("definition");
    if (record.key === "model" && modelAliases.has(record.value)) {
      return Object.freeze({ key: "model" as const, value: record.value as ClaudeCodeModelAlias });
    }
    if (record.key === "effortLevel" && effortValues.has(record.value)) {
      return Object.freeze({ key: "effortLevel" as const, value: record.value as ClaudeCodeEffort });
    }
    throw new TypeError("definition value");
  });
  if (new Set(output.map(item => item.key)).size !== output.length) throw new TypeError("duplicate definition");
  return Object.freeze(output.toSorted((left, right) => left.key < right.key ? -1 : 1));
};

const diagnostics = (value: unknown): ClassifyClaudeCodeConfigurationResult["diagnostics"] => {
  if (!Array.isArray(value)) throw new TypeError("diagnostics");
  const items = denseArray(value);
  if (items === undefined || items.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.diagnostics) throw new TypeError("diagnostics");
  const output = items.map(item => {
    const record = exactRecord(item, new Set(["code"]));
    if (record === undefined || typeof record.code !== "string" ||
        !diagnosticCodes.has(record.code as ClaudeCodeConfigurationDiagnosticCode)) throw new TypeError("diagnostic");
    return Object.freeze({ code: record.code as ClaudeCodeConfigurationDiagnosticCode });
  });
  if (new Set(output.map(item => item.code)).size !== output.length) throw new TypeError("duplicate diagnostic");
  return Object.freeze(output.toSorted((left, right) => left.code < right.code ? -1 : 1));
};

export const validateClaudeCodeSemanticClassification = (
  value: unknown,
): ClassifyClaudeCodeConfigurationResult => {
  try {
    const record = exactRecord(value, new Set([
      "definitions", "diagnostics", "definedPortableKeys", "taintedPortableKeys",
    ]));
    if (record === undefined || Object.keys(record).length !== 4) throw new TypeError("classification");
    const safeDefinitions = definitions(record.definitions);
    const safeDiagnostics = diagnostics(record.diagnostics);
    const defined = exactPortableKeys(record.definedPortableKeys);
    const tainted = exactPortableKeys(record.taintedPortableKeys);
    const definitionKeys = safeDefinitions.map(item => item.key);
    if (tainted.some(key => definitionKeys.includes(key)) ||
        [...new Set([...definitionKeys, ...tainted])].toSorted().join("\0") !== defined.join("\0")) {
      throw new TypeError("classification consistency");
    }
    return Object.freeze({
      definitions: safeDefinitions, diagnostics: safeDiagnostics,
      definedPortableKeys: defined, taintedPortableKeys: tainted,
    });
  } catch {
    throw new TypeError("semantic classifier returned an invalid result");
  }
};
