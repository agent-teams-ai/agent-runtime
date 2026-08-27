import { parse } from "smol-toml";

import type { CodexTomlParser } from "../../application/ports/outbound/codex-toml-parser.js";

const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

export const createSmolTomlParser = (): CodexTomlParser => ({
  parse(bytes) {
    if (hasUtf8Bom(bytes)) {
      return { kind: "bom" };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid-utf8" };
    }
    try {
      return {
        document: parse(text),
        kind: "parsed",
      };
    } catch {
      return { kind: "malformed" };
    }
  },
});
