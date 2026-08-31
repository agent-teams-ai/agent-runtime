import { CODEX_ITEM_COMPLETED_SCHEMA } from "./generated-codex-item-schema.js";

type Schema = boolean | Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const schemaType = (value: unknown, type: string): boolean => {
  if (type === "null") {return value === null;}
  if (type === "array") {return Array.isArray(value);}
  if (type === "object") {return isRecord(value);}
  if (type === "integer") {return Number.isSafeInteger(value);}
  return typeof value === type;
};

const integerFormat = (value: unknown, format: unknown): boolean => {
  if (!Number.isSafeInteger(value)) {return false;}
  const number = Number(value);
  if (format === "uint" || format === "uint64") {return number >= 0;}
  if (format === "uint32") {return number >= 0 && number <= 4_294_967_295;}
  if (format === "int32") {return number >= -2_147_483_648 && number <= 2_147_483_647;}
  return format === undefined || format === "int64";
};

const resolveRef = (ref: string): Schema | undefined => {
  if (!ref.startsWith("#/definitions/")) {return undefined;}
  const name = ref.slice("#/definitions/".length);
  const definitions = CODEX_ITEM_COMPLETED_SCHEMA.definitions as Readonly<Record<string, Schema>>;
  return definitions[name];
};

const validateAlternatives = (
  value: unknown,
  alternatives: unknown,
  applyDefaults: boolean,
  exact: boolean,
): boolean | undefined => {
  if (!Array.isArray(alternatives)) {return undefined;}
  const matches = alternatives.filter(entry =>
    (typeof entry === "boolean" || isRecord(entry)) && validate(structuredClone(value), entry, false));
  if (exact ? matches.length !== 1 : matches.length === 0) {return false;}
  return !applyDefaults || validate(value, matches[0] as Schema, true);
};

const validateScalar = (value: unknown, schema: Readonly<Record<string, unknown>>): boolean => {
  const declaredTypes = typeof schema.type === "string" ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter(entry => typeof entry === "string") : [];
  if (declaredTypes.length > 0 && !declaredTypes.some(type => schemaType(value, type))) {return false;}
  if (typeof value === "string"
    && ((typeof schema.minLength === "number" && value.length < schema.minLength)
      || (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)))) {return false;}
  return !Number.isSafeInteger(value)
    || (integerFormat(value, schema.format)
      && !(typeof schema.minimum === "number" && Number(value) < schema.minimum));
};

const validateObject = (
  value: Record<string, unknown>,
  schema: Readonly<Record<string, unknown>>,
  applyDefaults: boolean,
): boolean => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.every(key => typeof key === "string" && Object.hasOwn(value, key))) {return false;}
  const additionalKeys = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
  if (schema.additionalProperties === false && additionalKeys.length > 0) {return false;}
  if ((typeof schema.additionalProperties === "boolean" || isRecord(schema.additionalProperties))
    && !additionalKeys.every(key => validate(value[key], schema.additionalProperties as Schema, applyDefaults))) {return false;}
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property !== "boolean" && !isRecord(property)) {return false;}
    if (!Object.hasOwn(value, key) && applyDefaults && isRecord(property) && Object.hasOwn(property, "default")) {
      value[key] = structuredClone(property.default);
    }
    if (Object.hasOwn(value, key) && !validate(value[key], property as Schema, applyDefaults)) {return false;}
  }
  return true;
};

const validate = (value: unknown, schema: Schema, applyDefaults: boolean): boolean => {
  if (typeof schema === "boolean") {return schema;}
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref);
    return resolved !== undefined && validate(value, resolved, applyDefaults);
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every(entry =>
    (typeof entry === "boolean" || isRecord(entry)) && validate(value, entry, applyDefaults))) {
    return false;
  }
  const anyOf = validateAlternatives(value, schema.anyOf, applyDefaults, false);
  if (anyOf !== undefined) {return anyOf;}
  const oneOf = validateAlternatives(value, schema.oneOf, applyDefaults, true);
  if (oneOf !== undefined) {return oneOf;}
  if (Array.isArray(schema.enum) && !schema.enum.some(entry => Object.is(entry, value))) {return false;}
  if (!validateScalar(value, schema)) {return false;}
  if (Array.isArray(value) && (typeof schema.items === "boolean" || isRecord(schema.items))
    && !value.every(entry => validate(entry, schema.items as Schema, applyDefaults))) {return false;}
  return !isRecord(value) || validateObject(value, schema, applyDefaults);
};

export const validateAndNormalizeCodexThreadItem = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) {return undefined;}
  const normalized = structuredClone(value);
  const threadItem = (CODEX_ITEM_COMPLETED_SCHEMA.definitions as unknown as Readonly<Record<string, Schema>>).ThreadItem;
  return threadItem !== undefined && validate(normalized, threadItem, true) ? normalized : undefined;
};
