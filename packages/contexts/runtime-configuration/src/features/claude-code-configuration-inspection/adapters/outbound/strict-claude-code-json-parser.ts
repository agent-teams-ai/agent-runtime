import { parseTree, type Node, type ParseError } from "jsonc-parser";

import {
  CLAUDE_CODE_CONFIGURATION_BUDGETS,
  type ClaudeCodeConfigurationDiagnosticCode,
} from "../../contracts/claude-code-configuration-inspection.js";
import type {
  ClaudeCodeJsonParser,
  ParseClaudeCodeJsonResult,
} from "../../application/ports/outbound/claude-code-json-parser.js";

interface ParseBudgetState {
  arrayItems: number;
  nodes: number;
  objectKeys: number;
}

class DuplicateKeyError extends Error {}

const rejected = (
  diagnostic: ClaudeCodeConfigurationDiagnosticCode,
): ParseClaudeCodeJsonResult => ({ diagnostic, status: "rejected" });

const objectChildren = (node: Node): readonly Node[] => node.children ?? [];

const materialize = (node: Node, depth: number, state: ParseBudgetState): unknown => {
  state.nodes += 1;
  if (depth > CLAUDE_CODE_CONFIGURATION_BUDGETS.depth ||
      state.nodes > CLAUDE_CODE_CONFIGURATION_BUDGETS.nodes) {
    throw new RangeError("json budget exceeded");
  }
  if (node.type === "string") {
    if (typeof node.value !== "string" ||
        node.value.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.stringLength) {
      throw new RangeError("json string budget exceeded");
    }
    return node.value;
  }
  if (node.type === "number") {
    if (typeof node.value !== "number" || !Number.isFinite(node.value)) {
      throw new TypeError("invalid json number");
    }
    return node.value;
  }
  if (node.type === "boolean") {
    return node.value === true;
  }
  if (node.type === "null") {
    return null;
  }
  if (node.type === "array") {
    const children = objectChildren(node);
    state.arrayItems += children.length;
    if (state.arrayItems > CLAUDE_CODE_CONFIGURATION_BUDGETS.arrayItems) {
      throw new RangeError("json array budget exceeded");
    }
    return Object.freeze(children.map(child => materialize(child, depth + 1, state)));
  }
  if (node.type !== "object") {
    throw new TypeError("invalid json tree");
  }
  const properties = objectChildren(node);
  state.objectKeys += properties.length;
  if (state.objectKeys > CLAUDE_CODE_CONFIGURATION_BUDGETS.objectKeys) {
    throw new RangeError("json object budget exceeded");
  }
  const seen = new Set<string>();
  const output: Record<string, unknown> = Object.create(null);
  for (const property of properties) {
    const [keyNode, valueNode] = property.children ?? [];
    if (property.type !== "property" || keyNode?.type !== "string" ||
        typeof keyNode.value !== "string" || valueNode === undefined) {
      throw new TypeError("invalid json property");
    }
    const key = keyNode.value;
    if (key.length === 0 || key.length > CLAUDE_CODE_CONFIGURATION_BUDGETS.keyLength) {
      throw new RangeError("json key budget exceeded");
    }
    if (seen.has(key)) {
      throw new DuplicateKeyError("duplicate json key");
    }
    seen.add(key);
    output[key] = materialize(valueNode, depth + 1, state);
  }
  return Object.freeze(output);
};

const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

export const createStrictClaudeCodeJsonParser = (): ClaudeCodeJsonParser => ({
  parse(bytes) {
    if (bytes.byteLength > CLAUDE_CODE_CONFIGURATION_BUDGETS.bytesPerSource) {
      return rejected("config_too_large");
    }
    if (hasUtf8Bom(bytes)) {
      return rejected("config_parse_failed");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return rejected("config_invalid_utf8");
    }
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, {
      allowEmptyContent: false,
      allowTrailingComma: false,
      disallowComments: true,
    });
    if (tree === undefined || errors.length > 0 || tree.type !== "object") {
      return rejected("config_parse_failed");
    }
    try {
      const data = materialize(tree, 0, { arrayItems: 0, nodes: 0, objectKeys: 0 });
      return data !== null && typeof data === "object" && !Array.isArray(data)
        ? { data: data as Readonly<Record<string, unknown>>, status: "parsed" }
        : rejected("config_parse_failed");
    } catch (error) {
      return rejected(
        error instanceof DuplicateKeyError
          ? "config_duplicate_key"
          : "config_parse_failed",
      );
    }
  },
});
