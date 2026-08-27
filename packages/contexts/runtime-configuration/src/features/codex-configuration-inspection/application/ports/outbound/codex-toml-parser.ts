export type CodexTomlParseResult =
  | { readonly document: unknown; readonly kind: "parsed" }
  | { readonly kind: "bom" | "invalid-utf8" | "malformed" };

export interface CodexTomlParser {
  parse(bytes: Uint8Array): CodexTomlParseResult;
}
