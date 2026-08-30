import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const MAX_FRONTMATTER_BYTES = 16 * 1024;
const MAX_FRONTMATTER_LINES = 64;
const MAX_README_CODE_UNITS = 1024 * 1024;
const REQUIRED_FIELDS = ["owner", "owner_document", "status", "type"];

const requireFromHere = createRequire(import.meta.url);
const foundationManifest = requireFromHere.resolve("@agent-teams/engineering-foundation/package.json");
const yamlEntry = createRequire(foundationManifest).resolve("yaml");
const { isAlias, isMap, isNode, isPair, isScalar, parseDocument, visit } = await import(pathToFileURL(yamlEntry).href);

export class FeatureReadmeMetadataError extends Error {
  constructor() {super("feature README frontmatter is invalid"); this.name = "FeatureReadmeMetadataError";}
}

const invalid = () => {throw new FeatureReadmeMetadataError();};

const frontmatterSource = (readme) => {
  if (typeof readme !== "string"
    || readme.length > MAX_README_CODE_UNITS
    || readme.startsWith("\uFEFF")
    || readme.includes("\0")) {return invalid();}
  const normalized = readme.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {return invalid();}
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {return invalid();}
  const end = lines.indexOf("---", 1);
  if (end < 0 || end > MAX_FRONTMATTER_LINES) {return invalid();}
  const source = lines.slice(1, end).join("\n");
  if (!source || new TextEncoder().encode(source).byteLength > MAX_FRONTMATTER_BYTES) {return invalid();}
  return source;
};

const rejectUnsupportedYaml = (document) => {
  let unsupported = false;
  visit(document, (_key, node) => {
    unsupported = isAlias(node)
      || isNode(node) && (node.anchor !== undefined || node.tag !== undefined)
      || isPair(node) && isNode(node.key) && "value" in node.key && node.key.value === "<<";
    return unsupported ? visit.BREAK : undefined;
  });
  if (unsupported) {invalid();}
};

const metadataFromMap = (map) => {
  if (!isMap(map) || map.items.length !== REQUIRED_FIELDS.length) {return invalid();}
  const entries = [], keys = [];
  for (const pair of map.items) {
    if (!isPair(pair) || !isScalar(pair.key) || !isScalar(pair.value)) {return invalid();}
    const key = pair.key.value, value = pair.value.value;
    if (typeof key !== "string" || typeof value !== "string") {return invalid();}
    keys.push(key); entries.push([key, value]);
  }
  if (new Set(keys).size !== keys.length || keys.toSorted().some((key, index) => key !== REQUIRED_FIELDS[index])) {return invalid();}
  return Object.freeze(Object.fromEntries(entries));
};

export const parseFeatureReadmeMetadata = (readme) => {
  const document = parseDocument(frontmatterSource(readme), {
    customTags: [],
    merge: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length || document.warnings.length) {return invalid();}
  rejectUnsupportedYaml(document);
  return metadataFromMap(document.contents);
};
