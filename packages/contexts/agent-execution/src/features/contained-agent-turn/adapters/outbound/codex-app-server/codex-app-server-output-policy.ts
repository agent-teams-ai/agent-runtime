import { CodexAppServerProtocolError } from "./codex-app-server-jsonl.js";

const CREDENTIAL_MARKERS = Object.freeze([
  "CREDENTIAL_MARKER<",
  "API_KEY_MARKER<",
  "ACCESS_TOKEN_MARKER<",
  "REFRESH_TOKEN_MARKER<",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
]);

const CREDENTIAL_SHAPES = Object.freeze([
  Object.freeze({ leader: "sk-", minimumBodyLength: 20, requiresBoundary: true }),
  Object.freeze({ leader: "OPENAI_API_KEY=", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "CODEX_API_KEY=", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "Authorization: Bearer ", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"access_token\":\"", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"access_token\": \"", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"refresh_token\":\"", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"refresh_token\": \"", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"id_token\":\"", minimumBodyLength: 16, requiresBoundary: false }),
  Object.freeze({ leader: "\"id_token\": \"", minimumBodyLength: 16, requiresBoundary: false }),
]);

const credentialBodyCharacter = (value: string): boolean =>
  /^[A-Za-z0-9._~+/=-]$/u.test(value);

const hasShapeBoundary = (text: string, index: number, required: boolean): boolean => {
  if (!required || index === 0) {return true;}
  return !/[A-Za-z0-9_]/u.test(text[index - 1] ?? "");
};

const containsCredentialShape = (text: string): boolean => {
  for (const shape of CREDENTIAL_SHAPES) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(shape.leader, offset);
      if (index < 0) {break;}
      offset = index + 1;
      if (!hasShapeBoundary(text, index, shape.requiresBoundary)) {continue;}
      const bodyStart = index + shape.leader.length;
      let bodyLength = 0;
      while (bodyLength < shape.minimumBodyLength
        && credentialBodyCharacter(text[bodyStart + bodyLength] ?? "")) {
        bodyLength += 1;
      }
      if (bodyLength === shape.minimumBodyLength) {return true;}
    }
  }
  return false;
};

/** Enumerated marker/shape detection only; unknown secrets still require an exact owner-supplied token. */
export const assertCodexCanonicalOutputAllowed = (
  text: string,
  sensitiveOutputTokens: readonly string[],
): void => {
  if (sensitiveOutputTokens.some(token => text.includes(token))
    || CREDENTIAL_MARKERS.some(marker => text.includes(marker))
    || containsCredentialShape(text)) {
    throw new CodexAppServerProtocolError("Codex output matched the bounded private-output policy", true);
  }
};

const longestLiteralPrefixSuffix = (text: string, literals: readonly string[]): number => {
  let retainedLength = 0;
  for (const literal of literals) {
    const maximum = Math.min(text.length, literal.length - 1);
    for (let length = maximum; length > retainedLength; length -= 1) {
      if (text.endsWith(literal.slice(0, length))) {retainedLength = length; break;}
    }
  }
  return retainedLength;
};

const credentialShapePrefixSuffixLength = (text: string): number => {
  let retainedLength = longestLiteralPrefixSuffix(text, CREDENTIAL_SHAPES.map(shape => shape.leader));
  for (const shape of CREDENTIAL_SHAPES) {
    const index = text.lastIndexOf(shape.leader);
    if (index < 0 || !hasShapeBoundary(text, index, shape.requiresBoundary)) {continue;}
    const body = text.slice(index + shape.leader.length);
    if (body.length < shape.minimumBodyLength && [...body].every(credentialBodyCharacter)) {
      retainedLength = Math.max(retainedLength, text.length - index);
    }
  }
  return retainedLength;
};

export interface CodexCanonicalOutputRetention {
  readonly builtInPolicyLength: number;
  readonly exactTokenLength: number;
}

export const codexCanonicalOutputRetention = (
  text: string,
  sensitiveOutputTokens: readonly string[],
): CodexCanonicalOutputRetention => Object.freeze({
  builtInPolicyLength: Math.max(
    longestLiteralPrefixSuffix(text, CREDENTIAL_MARKERS),
    credentialShapePrefixSuffixLength(text),
  ),
  exactTokenLength: longestLiteralPrefixSuffix(text, sensitiveOutputTokens),
});
