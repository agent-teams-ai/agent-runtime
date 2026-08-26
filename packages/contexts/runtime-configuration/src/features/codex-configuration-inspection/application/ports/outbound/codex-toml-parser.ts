export type CodexTomlParseResult =
  | { readonly document: Readonly<Record<string, unknown>>; readonly kind: "parsed" }
  | { readonly kind: "bom" | "invalid-utf8" | "malformed" };

export interface CodexTomlParser {
  parse(bytes: Uint8Array): CodexTomlParseResult;
}
